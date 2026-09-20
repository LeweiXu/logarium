import io
import json
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from db import get_db
from models import User
from config import get_settings as get_app_settings
from schemas import (
    BackupStatus,
    BatchUpdateRequest, BatchDeleteRequest, BatchResult, DuplicateGroup,
    CustomListRead, CustomListRename,
    EntryCountsResponse, EntryCreate, EntryListResponse, EntryRead, EntryUpdate,
    ImportConfirmRequest, ImportConfirmResponse, ImportPreviewResponse,
    SearchResult, ShareLink, ShareSession, StatsResponse,
    UserCreate, UserRead, Token, DemoToken, ChangePassword,
    UserSettings, UserSettingsUpdate,
    DuplicateCheckRequest, DuplicateCheckResponse,
    DashboardBootstrapResponse, LibraryBootstrapResponse, LibraryRevisionResponse,
    ExploreCacheWriteRequest, ExploreResponse,
    deep_merge, deep_merge_ui,
)
from services import entry_service
from services.bootstrap_service import get_dashboard_bootstrap, get_library_bootstrap
from services.entry_service import delete_all_entries
from services import auth_service
from services import share_service
from services.search_service import search_media, lookup_chapter_count
from services.search_providers.imdb import fetch_imdb_detail
from services.url_import_service import fetch_from_url
from services.stats_service import get_stats
from services.export_service import export_entries_csv
from services.import_service import preview_import, confirm_import, auto_import_rows
from services.import_mal_service import import_mal_rows, confirm_mal_import
from services.explore_service import (
    reroll_medium, read_medium, read_all, clear_failed, write_external_success,
    ALL_MEDIUMS,
)
from services.backup_service import run_backup_for_user
from services.email_service import SMTPNotConfigured
from services.cover_cache_service import (
    CoverCacheError, MAX_SOURCE_BYTES, SIZES, cache_one_cover, cache_uncached_covers,
    cover_cache_key, ensure_covers_cached, sized_cover_path,
    store_cover_bytes,
)

router = APIRouter()

# ── Cover cache ───────────────────────────────────────────────────────────────

@router.post("/covers/upload", status_code=status.HTTP_204_NO_CONTENT)
async def upload_cover(
    cover_url: str = Form(..., min_length=1, max_length=1000),
    image: UploadFile = File(...),
    current_user: User = Depends(auth_service.get_current_user),
):
    """Store cover bytes uploaded by the browser extension.

    The extension fetches the image first-party (so Cloudflare-protected covers
    succeed) and POSTs the bytes here keyed by the original cover URL. We only
    store; serving the cached file back is a separate concern.
    """
    raw = await image.read()
    if len(raw) > MAX_SOURCE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Cover image is too large",
        )
    try:
        store_cover_bytes(cover_url, raw)
    except CoverCacheError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


def _serve_sized_cover(url: str, size: str) -> FileResponse:
    if size not in SIZES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown cover size")
    path = sized_cover_path(url, size)
    if not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cover not cached")
    return FileResponse(
        path,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.get("/covers/img")
async def get_cached_cover(
    url: str = Query(..., min_length=1, max_length=2000),
    size: str = Query("full"),
):
    """Serve one cached sized cover, or 404 if we don't have it.

    Used directly as an <img src> by the detail modal (size=full). Public (no
    auth): covers aren't sensitive and <img> tags can't send an Authorization
    header. We never fetch server-side here — the cache is filled by the extension
    upload, the cache-all sweep, or the on-create background task.
    """
    return _serve_sized_cover(url, size)


@router.post("/covers/cache-all")
async def cache_all_covers(
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    """Server-side cache every not-yet-cached cover for the current user.

    SSE stream of progress events. Ordinary CDNs are downloaded directly;
    Cloudflare-gated covers (NovelUpdates) fail here and are reported so the
    user knows to fall back to the browser extension for those.
    """
    async def event_stream():
        async for event in cache_uncached_covers(db, current_user.username):
            if await request.is_disconnected():
                break
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

# ── Auth routes ───────────────────────────────────────────────────────────────

@router.post("/auth/register", response_model=UserRead, status_code=status.HTTP_201_CREATED)
def register(payload: UserCreate, db: Session = Depends(get_db)):
    if auth_service.get_user_by_username(db, payload.username):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Username already taken")
    if auth_service.get_user_by_email(db, payload.email):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email already registered")
    user = User(
        username=payload.username,
        email=payload.email,
        hashed_password=auth_service.hash_password(payload.password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user

@router.post("/auth/login", response_model=Token)
def login(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = auth_service.get_user_by_username(db, form.username)
    if not user or not auth_service.verify_password(form.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return Token(access_token=auth_service.create_token(user.username))

@router.post("/auth/demo", response_model=DemoToken)
def demo_login(db: Session = Depends(get_db)):
    """Hand out a session for the public demo account, no credentials needed.

    The demo user is public on purpose (its credentials are printed on the
    landing page) and everything in it is wiped and re-seeded from the
    maintainer's library every 24h, so minting sessions for it freely costs
    nothing. Only the single account named by DEMO_USERNAME is ever reachable
    this way; blank that setting to switch the endpoint off.
    """
    username = (get_app_settings().DEMO_USERNAME or "").strip()
    if not username:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No demo account is configured on this server.",
        )
    user = auth_service.get_user_by_username(db, username)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="The demo account has not been set up on this server.",
        )
    return DemoToken(
        access_token=auth_service.create_token(user.username),
        username=user.username,
    )

@router.post("/auth/change-password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    payload: ChangePassword,
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    if not auth_service.verify_password(payload.current_password, current_user.hashed_password):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect")
    current_user.hashed_password = auth_service.hash_password(payload.new_password)
    db.commit()

# ── Settings routes ───────────────────────────────────────────────────────────

def _settings_payload(user: User) -> UserSettings:
    out = UserSettings.model_validate(user)
    # `ui` maps to the ui_preferences column; serve a complete (default-merged) doc.
    out.ui = deep_merge_ui(user.ui_preferences)
    return out


def _visible_mediums(user: User) -> set[str] | None:
    ui = deep_merge_ui(user.ui_preferences)
    visible = ui.get("mediums", {}).get("visible")
    return set(visible) if isinstance(visible, list) else None


@router.get("/bootstrap/dashboard", response_model=DashboardBootstrapResponse)
def dashboard_bootstrap(
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    return get_dashboard_bootstrap(
        db,
        current_user.username,
        _visible_mediums(current_user),
    )


@router.get("/bootstrap/library", response_model=LibraryBootstrapResponse)
def library_bootstrap(
    status_filter: str = Query(None, alias="status"),
    medium: str = Query(None),
    origin: str = Query(None),
    title: str = Query(None),
    custom_list: str = Query(None),
    custom_list_empty: bool = Query(False),
    sort: str = Query("updated_at"),
    order: str = Query("desc"),
    limit: int = Query(40, ge=1, le=2000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    return get_library_bootstrap(
        db,
        current_user.username,
        _visible_mediums(current_user),
        status=status_filter,
        medium=medium,
        origin=origin,
        title=title,
        custom_list=custom_list,
        custom_list_empty=custom_list_empty,
        sort=sort,
        order=order,
        limit=limit,
        offset=offset,
    )


@router.get("/library/revision", response_model=LibraryRevisionResponse)
def library_revision(current_user: User = Depends(auth_service.get_current_user)):
    return LibraryRevisionResponse(revision=current_user.library_revision)

@router.get("/auth/me/settings", response_model=UserSettings)
def get_settings(
    current_user: User = Depends(auth_service.get_current_user),
):
    return _settings_payload(current_user)

@router.put("/auth/me/settings", response_model=UserSettings)
def update_settings(
    payload: UserSettingsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    data = payload.model_dump(exclude_unset=True)
    ui_patch = data.pop("ui", None)
    # Scalar settings → authoritative columns (server consumers read these).
    for field, value in data.items():
        setattr(current_user, field, value)
    # UI document → deep-merge the partial patch into the stored (full) JSON doc.
    if ui_patch is not None:
        current_user.ui_preferences = deep_merge(
            deep_merge_ui(current_user.ui_preferences), ui_patch
        )
    db.commit()
    db.refresh(current_user)
    return _settings_payload(current_user)

# ── Share routes ──────────────────────────────────────────────────────────────
# /share/link is owner-only (the guard in main.py blocks it for share tokens);
# /share/session is what a viewer's client calls to resolve a link.

@router.get("/share/session", response_model=ShareSession)
def share_session(
    token: str = Depends(auth_service.oauth2_scheme),
    current_user: User = Depends(auth_service.get_current_user),
):
    """Who this session belongs to, and whether it can write."""
    return ShareSession(
        username=current_user.username,
        read_only=share_service.is_share_token(token),
    )


@router.get("/share/link", response_model=ShareLink)
def get_share_link(
    current_user: User = Depends(auth_service.get_current_user),
):
    token = share_service.get_token(current_user)
    return ShareLink(enabled=token is not None, token=token)


@router.post("/share/link", response_model=ShareLink)
def enable_share_link(
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    """Turn sharing on, keeping the current token if there already is one."""
    return ShareLink(enabled=True, token=share_service.enable(db, current_user))


@router.post("/share/link/regenerate", response_model=ShareLink)
def regenerate_share_link(
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    """Issue a new link. The previous one stops working immediately."""
    return ShareLink(enabled=True, token=share_service.regenerate(db, current_user))


@router.delete("/share/link", response_model=ShareLink)
def disable_share_link(
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    """Turn sharing off. Any existing link stops working immediately."""
    share_service.disable(db, current_user)
    return ShareLink(enabled=False, token=None)


# ── Entries endpoints ─────────────────────────────────────────────────────────

@router.get("/entries/export")
def export_entries(
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    csv_content = export_entries_csv(db, current_user.username)
    filename = f"library_{current_user.username}.csv"
    return StreamingResponse(
        io.StringIO(csv_content),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

@router.post("/entries/import/preview", response_model=ImportPreviewResponse)
async def import_preview(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    content = await file.read()
    return preview_import(db, content.decode("utf-8-sig"), current_user.username)

@router.post("/entries/import/confirm", response_model=ImportConfirmResponse)
def import_confirm(
    payload: ImportConfirmRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    to_update = [{"db_id": item.db_id, "csv_row": item.csv_row} for item in payload.to_update]
    return confirm_import(db, payload.to_create, to_update, current_user.username)

@router.post("/entries/import/auto")
async def import_auto(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    content = (await file.read()).decode("utf-8-sig")

    async def event_stream():
        async for event in auto_import_rows(content, db, current_user.username):
            if await request.is_disconnected():
                break
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/entries/import/mal")
async def import_mal(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    content = (await file.read()).decode("utf-8-sig")

    async def event_stream():
        async for event in import_mal_rows(content, db, current_user.username):
            if await request.is_disconnected():
                break
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/entries/import/mal/confirm")
def import_mal_confirm(
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    entries = payload.get("entries", [])
    return confirm_mal_import(db, entries, current_user.username)


@router.get("/entries", response_model=EntryListResponse)
def list_entries(
    status: str = Query(None, description="Filter by status"),
    medium: str = Query(None, description="Filter by medium"),
    origin: str = Query(None, description="Filter by origin"),
    title:  str = Query(None, description="Search by title (case-insensitive)"),
    custom_list: str = Query(None, description="Filter by custom list"),
    custom_list_empty: bool = Query(False, description="Only entries with no custom list"),
    external_url: str = Query(None, description="Exact-match filter by source/external URL"),
    sort:   str = Query("updated_at", description="Column to sort by"),
    order:  str = Query("desc",       description="asc or desc"),
    limit:  int = Query(40,  ge=1, le=2000, description="Max results to return"),
    offset: int = Query(0,   ge=0,          description="Number of results to skip"),
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    return entry_service.get_entries(
        db,
        username=current_user.username,
        status=status,
        medium=medium,
        origin=origin,
        title=title,
        custom_list=custom_list,
        custom_list_empty=custom_list_empty,
        external_url=external_url,
        sort=sort,
        order=order,
        limit=limit,
        offset=offset,
        visible_mediums=_visible_mediums(current_user),
    )

@router.get("/entries/counts", response_model=EntryCountsResponse)
def entry_counts(
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    return entry_service.get_entry_counts(
        db,
        current_user.username,
        visible_mediums=_visible_mediums(current_user),
    )

@router.get("/entries/duplicates", response_model=list[DuplicateGroup])
def list_duplicate_entries(
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    return entry_service.find_duplicate_groups(db, current_user.username)

@router.get("/entries/{entry_id}", response_model=EntryRead)
def get_entry(
    entry_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    entry = entry_service.get_entry_by_id(db, entry_id)
    if not entry or entry.username != current_user.username:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Entry not found")
    return entry_service.entry_read(entry)

def _cache_cover_background(cover_url: str | None) -> None:
    """Best-effort: warm the 3-size cache for a cover after an entry is saved.

    Swallows errors — Cloudflare/NU covers can't be fetched server-side and arrive
    via the extension upload instead.
    """
    if not cover_url:
        return
    try:
        cache_one_cover(cover_url)
    except CoverCacheError:
        pass


@router.post("/entries", response_model=EntryRead, status_code=status.HTTP_201_CREATED)
def create_entry(
    payload: EntryCreate,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    entry = entry_service.create_entry(db, payload, username=current_user.username)
    background.add_task(_cache_cover_background, entry.cover_url)
    return entry_service.entry_read(entry)

@router.put("/entries/{entry_id}", response_model=EntryRead)
def update_entry(
    entry_id: int,
    payload: EntryUpdate,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    entry = entry_service.get_entry_by_id(db, entry_id)
    if not entry or entry.username != current_user.username:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Entry not found")
    updated = entry_service.update_entry(db, entry, payload)
    background.add_task(_cache_cover_background, updated.cover_url)
    return entry_service.entry_read(updated)

@router.post("/entries/check-duplicates", response_model=DuplicateCheckResponse)
def check_duplicates(
    payload: DuplicateCheckRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    exists = entry_service.check_duplicates(db, current_user.username, payload.items)
    return DuplicateCheckResponse(exists=exists)

@router.post("/entries/batch", response_model=BatchResult)
def batch_update_entries(
    payload: BatchUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    affected = entry_service.batch_update_entries(
        db, current_user.username, payload.ids, payload.patch
    )
    return BatchResult(affected=affected)

@router.post("/entries/batch-delete", response_model=BatchResult)
def batch_delete_entries(
    payload: BatchDeleteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    affected = entry_service.batch_delete_entries(db, current_user.username, payload.ids)
    return BatchResult(affected=affected)

@router.delete("/entries", status_code=status.HTTP_204_NO_CONTENT)
def delete_all_user_entries(
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    delete_all_entries(db, current_user.username)

@router.delete("/entries/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_entry(
    entry_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    entry = entry_service.get_entry_by_id(db, entry_id)
    if not entry or entry.username != current_user.username:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Entry not found")
    entry_service.delete_entry(db, entry)

# ── Custom list endpoints ────────────────────────────────────────────────────

@router.get("/custom-lists", response_model=list[CustomListRead])
def list_custom_lists(
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    return entry_service.get_custom_lists(db, current_user.username, _visible_mediums(current_user))


@router.put("/custom-lists/{name:path}", response_model=list[CustomListRead])
def rename_custom_list(
    name: str,
    payload: CustomListRename,
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    entry_service.rename_custom_list(
        db,
        username=current_user.username,
        old_name=name,
        new_name=payload.new_name,
    )
    return entry_service.get_custom_lists(db, current_user.username, _visible_mediums(current_user))


@router.delete("/custom-lists/{name:path}", response_model=list[CustomListRead])
def clear_custom_list(
    name: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    entry_service.clear_custom_list(db, current_user.username, name)
    return entry_service.get_custom_lists(db, current_user.username, _visible_mediums(current_user))

# ── Search endpoint ───────────────────────────────────────────────────────────

@router.get("/search", response_model=list[SearchResult])
async def search(
    title:  str = Query(..., min_length=1, description="Title to search for"),
    source: str = Query("", description="Optional source to search (e.g. tmdb, anilist, igdb)"),
    limit:  int = Query(10, ge=1, le=50, description="Max results to return"),
    current_user: User = Depends(auth_service.get_current_user),
):
    return await search_media(title=title, source=source, limit=limit)


@router.get("/search/from-url", response_model=list[SearchResult])
async def search_from_url(
    url: str = Query(..., min_length=1, description="Media-page URL to scrape (NovelUpdates, jjwxc, qidian, imdb, Goodreads)"),
    current_user: User = Depends(auth_service.get_current_user),
):
    """Scrape a supported media page into a result list.

    Usually one item, but some pages resolve to many (a Goodreads series page →
    one result per book). Returns an empty list for unsupported domains or any
    scrape failure, so the client degrades gracefully to manual entry.
    """
    return await fetch_from_url(url)


@router.get("/search/chapter-count")
async def chapter_count(
    title: str = Query(..., min_length=1, description="Title to look up a chapter total for"),
    current_user: User = Depends(auth_service.get_current_user),
):
    """On-demand MangaUpdates chapter-count lookup for a single title.

    Called when adding an ongoing MAL manga whose chapter total is blank.
    """
    return {"total": await lookup_chapter_count(title)}


@router.get("/search/imdb-detail", response_model=SearchResult)
async def imdb_detail(
    id: str = Query(..., min_length=1, description="IMDb title id (ttXXXXXXX)"),
    current_user: User = Depends(auth_service.get_current_user),
):
    """On-demand IMDb detail (rating, episode count, year, cover, genres).

    Called when adding an IMDb-sourced Film/TV entry whose rating/total are blank
    (the suggestion-based search leaves them unset). Returns 404 if IMDb can't be
    resolved so the client keeps whatever it already had.
    """
    result = await fetch_imdb_detail(id)
    if result is None:
        raise HTTPException(status_code=404, detail="IMDb title not found")
    return result

# ── Explore endpoint ──────────────────────────────────────────────────────────

def _explore_personalize(current_user: User) -> bool:
    explore_cfg = deep_merge_ui(current_user.ui_preferences)["explore"]
    return explore_cfg.get("personalize", True) is not False


@router.get("/explore", response_model=ExploreResponse)
async def explore(
    background: BackgroundTasks,
    medium:  str  = Query("", description="Medium filter; empty = aggregate 'All' view"),
    limit:   int  = Query(40, ge=1, le=200),
    offset:  int  = Query(0, ge=0),
    seed:    int  = Query(0,  ge=0, description="Shuffle seed; only consulted on a reroll"),
    refresh: bool = Query(False, description="Reroll: fetch fresh recommendations for the medium"),
    sources: str  = Query("", description="Comma-separated available sources to draw from"),
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    source_set = {s for s in (sources or "").split(",") if s} or None
    personalize = _explore_personalize(current_user)
    visible_mediums = set(_visible_mediums(current_user))

    # Empty medium = the aggregate "All" view (read-only, never rerolls).
    if not medium:
        result = read_all(
            db, username=current_user.username,
            sources=source_set, personalize=personalize, limit=limit, offset=offset,
            visible_mediums=visible_mediums,
        )
    else:
        if medium not in ALL_MEDIUMS:
            raise HTTPException(status_code=400, detail="Unknown medium")
        if refresh:
            result = await reroll_medium(
                db, username=current_user.username, medium=medium,
                sources=source_set, personalize=personalize, limit=limit, seed=seed or None,
                offset=offset, visible_mediums=visible_mediums,
            )
        else:
            result = read_medium(
                db, username=current_user.username, medium=medium,
                sources=source_set, personalize=personalize, limit=limit, offset=offset,
                visible_mediums=visible_mediums,
            )

    # Explore items aren't library entries, so this is where we first see their
    # covers — cache the 3 sizes in the background so the serve path (bundle /img)
    # can hand them out directly instead of the frontend hotlinking external URLs.
    missing_covers: list[str] = []
    for item in result.items or []:
        if not item.cover_url:
            continue
        item.cover_key = cover_cache_key(item.cover_url)
        item.cover_cached = sized_cover_path(item.cover_url, "medium").exists()
        if not item.cover_cached:
            missing_covers.append(item.cover_url)
    if missing_covers:
        background.add_task(ensure_covers_cached, missing_covers)
    return result


@router.post("/explore/restore", response_model=ExploreResponse)
def explore_restore(
    medium:  str = Query(..., description="Medium whose previous results to restore"),
    sources: str = Query("", description="Comma-separated available sources to draw from"),
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    """Clear a medium's failed-reroll state and return its previous cached set."""
    if medium not in ALL_MEDIUMS:
        raise HTTPException(status_code=400, detail="Unknown medium")
    source_set = {s for s in (sources or "").split(",") if s} or None
    return clear_failed(
        db, username=current_user.username, medium=medium,
        sources=source_set, personalize=_explore_personalize(current_user),
    )


@router.post("/explore/cache", response_model=ExploreResponse)
def explore_cache_write(
    payload: ExploreCacheWriteRequest,
    sources: str = Query("", description="Comma-separated available sources to draw from"),
    limit:   int = Query(120, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    """Persist successful client/extension fallback results for a medium."""
    if payload.medium not in ALL_MEDIUMS:
        raise HTTPException(status_code=400, detail="Unknown medium")
    source_set = {s for s in (sources or "").split(",") if s} or None
    return write_external_success(
        db,
        username=current_user.username,
        medium=payload.medium,
        items=payload.items,
        sources=source_set,
        personalize=_explore_personalize(current_user),
        limit=limit,
    )

# ── Backup endpoints ──────────────────────────────────────────────────────────

@router.get("/backup/status", response_model=BackupStatus)
def backup_status(
    current_user: User = Depends(auth_service.get_current_user),
):
    """Report whether SMTP is configured and when this user last backed up.

    The frontend uses ``configured`` to decide whether to enable the
    frequency selector and "Back up now" button.
    """
    return BackupStatus(
        configured     = get_app_settings().smtp_configured,
        backup_freq    = current_user.backup_freq or "never",
        last_backup_at = current_user.last_backup_at,
        email          = current_user.email,
    )


@router.post("/backup/run", response_model=BackupStatus)
def backup_run(
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    """Manually trigger a backup right now (independent of the schedule)."""
    if not get_app_settings().smtp_configured:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Email backup is not configured on this server.",
        )
    try:
        run_backup_for_user(db, current_user)
    except SMTPNotConfigured:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Email backup is not configured on this server.",
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to send backup email: {exc}",
        )
    return BackupStatus(
        configured     = True,
        backup_freq    = current_user.backup_freq or "never",
        last_backup_at = current_user.last_backup_at,
        email          = current_user.email,
    )

# ── Stats endpoint ────────────────────────────────────────────────────────────

@router.get("/stats", response_model=StatsResponse)
def stats(
    db: Session = Depends(get_db),
    current_user: User = Depends(auth_service.get_current_user),
):
    return get_stats(db, username=current_user.username, visible_mediums=_visible_mediums(current_user))
