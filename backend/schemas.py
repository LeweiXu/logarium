# --- Entry Schemas ---
from __future__ import annotations
from datetime import datetime
from typing import Any, Optional
from pydantic import BaseModel, Field, field_validator

from constants import (
    VALID_STATUSES, VALID_MEDIUMS, VALID_ORIGINS,
    normalise_medium, normalise_origin,
)

CUSTOM_LIST_MAX_LENGTH = 60


class EntryBase(BaseModel):
    title:       str             = Field(..., min_length=1, max_length=500)
    medium:      Optional[str]   = Field(None, max_length=100)
    origin:      Optional[str]   = Field(None, max_length=100)
    year:        Optional[int]   = Field(None, ge=1800, le=2100)
    cover_url:   Optional[str]   = Field(None, max_length=1000)
    notes:       Optional[str]   = None
    status:      str             = Field("planned", max_length=50)
    rating:      Optional[float] = Field(None, ge=0, le=10)
    progress:    Optional[int]   = Field(None, ge=0)
    total:       Optional[int]   = Field(None, ge=0)
    external_id:     Optional[str]   = Field(None, max_length=200)
    source:          Optional[str]   = Field(None, max_length=100)
    external_url:    Optional[str]   = Field(None, max_length=1000)
    genres:          Optional[str]   = Field(None, max_length=500)
    external_rating: Optional[float] = Field(None, ge=0, le=100)
    custom_list:     Optional[str]   = Field(None, max_length=CUSTOM_LIST_MAX_LENGTH)

    @field_validator("status")
    @classmethod
    def validate_status(cls, v: str) -> str:
        if v not in VALID_STATUSES:
            raise ValueError(f"status must be one of {sorted(VALID_STATUSES)}")
        return v

    @field_validator("medium")
    @classmethod
    def validate_medium(cls, v: str | None) -> str | None:
        if v is None:
            return v
        normalised = normalise_medium(v)
        if normalised not in VALID_MEDIUMS:
            raise ValueError(f"medium must be one of {sorted(VALID_MEDIUMS)}")
        return normalised

    @field_validator("origin")
    @classmethod
    def validate_origin(cls, v: str | None) -> str | None:
        if v is None:
            return v
        normalised = normalise_origin(v)
        if normalised not in VALID_ORIGINS:
            raise ValueError(f"origin must be one of {sorted(VALID_ORIGINS)}")
        return normalised

    @field_validator("custom_list", mode="before")
    @classmethod
    def normalise_custom_list(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if not isinstance(v, str):
            return v
        stripped = v.strip()
        return stripped or None


class EntryCreate(EntryBase):
    completed_at: Optional[datetime] = None

class EntryUpdate(BaseModel):
    title:        Optional[str]      = Field(None, min_length=1, max_length=500)
    medium:       Optional[str]      = Field(None, max_length=100)
    origin:       Optional[str]      = Field(None, max_length=100)
    year:         Optional[int]      = Field(None, ge=1800, le=2100)
    cover_url:    Optional[str]      = Field(None, max_length=1000)
    notes:        Optional[str]      = None
    status:       Optional[str]      = Field(None, max_length=50)
    rating:       Optional[float]    = Field(None, ge=0, le=10)
    progress:     Optional[int]      = Field(None, ge=0)
    total:        Optional[int]      = Field(None, ge=0)
    external_id:     Optional[str]      = Field(None, max_length=200)
    source:          Optional[str]      = Field(None, max_length=100)
    external_url:    Optional[str]      = Field(None, max_length=1000)
    genres:          Optional[str]      = Field(None, max_length=500)
    external_rating: Optional[float]    = Field(None, ge=0, le=100)
    custom_list:     Optional[str]      = Field(None, max_length=CUSTOM_LIST_MAX_LENGTH)
    completed_at:    Optional[datetime] = None

    @field_validator("status")
    @classmethod
    def validate_status(cls, v: str | None) -> str | None:
        if v is not None and v not in VALID_STATUSES:
            raise ValueError(f"status must be one of {sorted(VALID_STATUSES)}")
        return v

    @field_validator("medium")
    @classmethod
    def validate_medium(cls, v: str | None) -> str | None:
        if v is None:
            return v
        normalised = normalise_medium(v)
        if normalised not in VALID_MEDIUMS:
            raise ValueError(f"medium must be one of {sorted(VALID_MEDIUMS)}")
        return normalised

    @field_validator("origin")
    @classmethod
    def validate_origin(cls, v: str | None) -> str | None:
        if v is None:
            return v
        normalised = normalise_origin(v)
        if normalised not in VALID_ORIGINS:
            raise ValueError(f"origin must be one of {sorted(VALID_ORIGINS)}")
        return normalised

    @field_validator("custom_list", mode="before")
    @classmethod
    def normalise_custom_list(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if not isinstance(v, str):
            return v
        stripped = v.strip()
        return stripped or None

class EntryRead(EntryBase):
    id:           int
    username:     str
    created_at:   datetime
    updated_at:   datetime
    completed_at: Optional[datetime] = None
    cover_key:     Optional[str] = None
    model_config = {"from_attributes": True}

class EntryEventRead(BaseModel):
    id: int
    entry_id: int
    action: str
    at: datetime
    recorded_at: datetime
    from_value: str | None = None
    to_value: str | None = None
    detail: dict[str, Any] | None = None
    model_config = {"from_attributes": True}


class ActivityRead(EntryEventRead):
    title: str
    cover_url: str | None = None
    cover_key: str | None = None
    medium: str | None = None
    count: int = 1


class EntryListResponse(BaseModel):
    items: list[EntryRead]
    total: int
    limit: int
    offset: int

class EntryCountsResponse(BaseModel):
    total: int = 0
    unlisted: int = 0
    statuses: dict[str, int] = Field(default_factory=dict)
    mediums: dict[str, int] = Field(default_factory=dict)
    origins: dict[str, int] = Field(default_factory=dict)

# --- Batch / Dedup Schemas ---

class BatchUpdateRequest(BaseModel):
    ids:   list[int] = Field(..., min_length=1)
    patch: EntryUpdate

class BatchDeleteRequest(BaseModel):
    ids: list[int] = Field(..., min_length=1)

class BatchResult(BaseModel):
    affected: int

class DuplicateGroup(BaseModel):
    key:     str
    entries: list[EntryRead]

# --- Custom List Schemas ---

class CustomListRead(BaseModel):
    name: str
    count: int
    updated_at: datetime

class CustomListRename(BaseModel):
    new_name: str = Field(..., min_length=1, max_length=CUSTOM_LIST_MAX_LENGTH)

    @field_validator("new_name")
    @classmethod
    def normalise_new_name(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("new_name cannot be empty")
        return stripped

# --- User Schemas ---

class UserCreate(BaseModel):
    username: str = Field(..., min_length=1, max_length=100)
    email:    str = Field(..., max_length=320)
    password: str = Field(..., min_length=6)

class UserRead(BaseModel):
    username: str
    email:    str
    model_config = {"from_attributes": True}

class Token(BaseModel):
    access_token: str
    token_type:   str = "bearer"

class DemoToken(Token):
    """Response for /auth/demo: a normal session, plus who it belongs to."""
    username: str

class ChangePassword(BaseModel):
    current_password: str
    new_password:     str = Field(..., min_length=6)

# --- User Settings ---

_VALID_BACKUP_FREQ = {"never", "daily", "weekly", "monthly"}
# Mirrors entry_service.SORTABLE_COLUMNS keys.
_VALID_DEFAULT_SORT = {
    "title", "medium", "origin", "year", "status", "rating",
    "created_at", "updated_at", "completed_at",
}
# Canonical defaults for the single UI-preferences document. The frontend reads
# a complete document (defaults deep-merged with the user's stored overrides).
DEFAULT_UI: dict[str, Any] = {
    "display": {
        "theme": "dark",
        "accent": "blue",
    },
    # Granularity for rating entry/editing across the app: the up/down step size
    # and the grid ratings snap to on save. One of 0.1, 0.5, 1.0.
    "rating_step": 1.0,
    # What each rating means *to this user* — free text, purely a reference
    # (shown in Console, and on a shared profile). Keys are the rating value as
    # a string so half-step text survives a granularity change and back. Rows
    # rendered follow `rating_step`, except 0.1 which uses the 0.5 grid.
    "rating_definitions": {
        "10": "Perfect. Nothing I would change, and long enough to earn it. A lifetime favourite.",
        "9":  "Outstanding. A couple of trivial nitpicks at most. Recommend without reservation.",
        "8":  "Very good. Clearly flawed somewhere (pacing, an arc, the length) but the highs are high.",
        "7":  "Good. Enjoyed it. Worth recommending to people who like the genre, not to everyone.",
        "6":  "Decent. More good than bad. Worth the time if the premise appeals.",
        "5":  "Mixed. The good and the bad cancel out. Finished it without regret or enthusiasm.",
        "4":  "Weak. A few redeeming parts, but I would not tell anyone to bother.",
        "3":  "Bad. Occasional flashes of something, mostly a slog.",
        "2":  "Very bad. Finished out of stubbornness or morbid curiosity.",
        "1":  "Worthless. No redeeming qualities.",
    },
    "mediums": {
        # Visibility setting. Hidden mediums remain in the database but are
        # omitted from frontend lists, filters, selectors, and Explore. The
        # /stats response also respects this list before aggregating.
        "visible": [
            "Film", "TV Show", "Anime", "Book", "Manga",
            "Light Novel", "Web Novel", "Comic", "Game", "Visual Novel",
        ],
    },
    "library": {
        "default_mode": "view",          # "view" | "manage"
        "default_sort": "completed_at",
        "entries_per_page": 40,
        "fix_title": True,
        "quick_actions": False,
        "sidebars": {
            "left": False,
            "right": False,
        },
        # Library table columns: two ordered groups the user assigns by dragging.
        # `standard` shows by default, `additional` is off by default; `shown` is
        # which columns actually render (standard group first, then additional).
        "columns": {
            "standard":   ["medium", "status", "rating", "completed"],
            "additional": ["year", "progress", "custom_list", "updated"],
            "shown":      ["medium", "status", "rating", "completed"],
        },
    },
    "dashboard": {
        "current_rows": 5,
        "planned_rows": 5,
        "completed_rows": 20,
        "sidebars": {
            "left": False,
            "right": False,
        },
        "split": 60,                      # % width of the "currently consuming" column vs "planned" (manual mode only)
        # When False (default) the split is computed adaptively on the client to
        # even out whitespace after the longest title; when True, `split` is used.
        "manual_split": False,
        "fixed_tables": {
            "current": True,
            "planned": True,
            "completed": True,
        },
        "columns": {
            "current":   ["progress", "status", "rating"],
            "planned":   ["medium", "status"],
            "completed": ["medium", "completed", "rating"],
        },
    },
    "statistics": {
        "consumed_range": 12,
        "added_range": 5,
        "sections": {
            "summary": True,
            "consumed": True,
            "added": False,
            "by_medium": True,
            "completion": True,
            "backlog": True,
            "rating_distribution": True,
            "rating_comparison": True,
            "by_status": True,
            "by_origin": True,
            "release_years": True,
        },
    },
    "explore": {
        "default_medium": None,
        "sidebars": {
            "left": False,
            "right": False,
        },
        # Personalisation only orders results now: per-medium views are biased
        # by genre/origin; the aggregate "All" view adds a medium-consumption
        # bias so the user's most-consumed mediums float up. Off = neutral.
        "personalize": True,
        "hide_in_library": True,
    },
}


def deep_merge(base: dict, over: Optional[dict]) -> dict[str, Any]:
    """Recursively merge ``over`` into ``base`` (returns a new dict)."""
    out = dict(base)
    for key, value in (over or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def deep_merge_ui(overrides: Optional[dict]) -> dict[str, Any]:
    """Deep-merge a stored (partial) UI document over DEFAULT_UI."""
    return deep_merge(DEFAULT_UI, overrides)


class UserSettings(BaseModel):
    """Read & write shape for /auth/me/settings.

    Only ``backup_freq`` remains a real column (a backend concern). Everything
    else lives inside the single ``ui`` document (see DEFAULT_UI).
    """
    backup_freq:              str = "never"
    # Single document of all customizable UI preferences (see DEFAULT_UI).
    ui:                       dict[str, Any] = Field(default_factory=dict)
    model_config = {"from_attributes": True}

    @field_validator("backup_freq")
    @classmethod
    def _v_backup(cls, v: str) -> str:
        if v not in _VALID_BACKUP_FREQ:
            raise ValueError(f"backup_freq must be one of {sorted(_VALID_BACKUP_FREQ)}")
        return v

class UserSettingsUpdate(BaseModel):
    """Partial update — every field optional."""
    backup_freq:              Optional[str]  = None
    # Partial UI document — deep-merged into the stored ui_preferences on save.
    ui:                       Optional[dict[str, Any]] = None

    @field_validator("backup_freq")
    @classmethod
    def _v_backup(cls, v: str | None) -> str | None:
        if v is not None and v not in _VALID_BACKUP_FREQ:
            raise ValueError(f"backup_freq must be one of {sorted(_VALID_BACKUP_FREQ)}")
        return v

# --- Share Schemas ---

class ShareLink(BaseModel):
    """Owner's view of their share link. `token` is None when sharing is off."""
    enabled: bool
    token:   Optional[str] = None

class ShareSession(BaseModel):
    """What a share link resolves to, for the viewing client."""
    username:  str
    read_only: bool

# --- Backup Schemas ---

class BackupStatus(BaseModel):
    """Reported by GET /backup/status — drives the Settings UI gating."""
    # True iff SMTP_HOST/USER/PASSWORD are all set on the server.
    configured:     bool
    backup_freq:    str
    last_backup_at: Optional[datetime] = None
    # The address backups will be sent to (the user's account email).
    email:          str

# --- Search Schemas ---
from pydantic import BaseModel
class SearchResult(BaseModel):
    title:           str
    medium:          Optional[str]   = None
    origin:          Optional[str]   = None
    year:            Optional[int]   = None
    cover_url:       Optional[str]   = None
    total:           Optional[int]   = None
    external_id:     Optional[str]   = None
    source:          str             = ""
    description:     Optional[str]   = None
    external_url:    Optional[str]   = None
    genres:          Optional[str]   = None
    external_rating: Optional[float] = None

# --- Import Schemas ---
from typing import Any

class ImportPreviewResponse(BaseModel):
    error: Optional[str] = None
    to_import: list[dict[str, Any]] = []
    exact_duplicates: list[dict[str, Any]] = []
    conflicts: list[dict[str, Any]] = []

class ImportUpdateItem(BaseModel):
    db_id: int
    csv_row: dict[str, Any]

class ImportConfirmRequest(BaseModel):
    to_create: list[dict[str, Any]] = []
    to_update: list[ImportUpdateItem] = []

class ImportConfirmResponse(BaseModel):
    created: int
    updated: int
    skipped: int

# --- Duplicate Check Schemas ---
class DuplicateCheckItem(BaseModel):
    title:  str
    year:   Optional[int] = None
    medium: Optional[str] = None

class DuplicateCheckRequest(BaseModel):
    items: list[DuplicateCheckItem]

class DuplicateCheckResponse(BaseModel):
    exists: list[bool]

# --- Explore Schemas ---

class ExploreItem(BaseModel):
    """A single explore result — a SearchResult plus personalisation metadata."""
    title:           str
    medium:          Optional[str]   = None
    origin:          Optional[str]   = None
    year:            Optional[int]   = None
    cover_url:       Optional[str]   = None
    cover_key:       Optional[str]   = None
    total:           Optional[int]   = None
    external_id:     Optional[str]   = None
    source:          str             = ""
    description:     Optional[str]   = None
    external_url:    Optional[str]   = None
    genres:          Optional[str]   = None
    external_rating: Optional[float] = None
    # True when the medium-sized server cache file is ready for direct serving.
    cover_cached:    bool            = False
    # Personalisation
    in_library:      bool            = False
    bias_matched:    bool            = False
    # Mixed list of overlaps with the user's most-consumed genres / origins /
    # mediums. Empty when no overlap. Used by the UI for the "matches: …" hint.
    matches:         list[str]       = []

    @field_validator("year", "total", mode="before")
    @classmethod
    def empty_int_to_none(cls, v: Any) -> Any:
        return None if v == "" else v

    @field_validator("external_rating", mode="before")
    @classmethod
    def empty_float_to_none(cls, v: Any) -> Any:
        return None if v == "" else v

class AffinitySnapshot(BaseModel):
    """Compact summary of what the explore engine learned from the user."""
    sample_size:     int = 0          # number of rated entries used
    top_genres:      list[str] = []   # ranked, up to 5
    top_origins:     list[str] = []   # ranked, up to 3
    top_mediums:     list[str] = []   # ranked, up to 3

class ExploreResponse(BaseModel):
    items:    list[ExploreItem]
    affinity: AffinitySnapshot
    total:    int = 0
    offset:   int = 0
    limit:    int = 30
    # 'true' iff personalisation was applied to ranking
    personalised: bool
    # Per-medium reroll outcome (always cleared for the aggregate "All" view).
    reroll_failed: bool = False
    reroll_error:  Optional[str] = None

class ExploreCacheWriteRequest(BaseModel):
    medium: str
    items: list[ExploreItem]

# --- Stats Schemas ---
class MediumCount(BaseModel):
    medium: str
    count:  int


class OriginCount(BaseModel):
    origin: str
    count:  int


class MonthCount(BaseModel):
    key:   str
    label: str
    count: int


class MonthActivity(BaseModel):
    key:       str
    label:     str
    added:     int
    completed: int


class RatingBucket(BaseModel):
    rating: float
    count:  int


class MediumCompletion(BaseModel):
    medium:    str
    total:     int
    completed: int
    rate:      float


class BacklogBucket(BaseModel):
    key:   str
    label: str
    count: int


class MediumRatingComparison(BaseModel):
    medium:      str
    personal:    float
    external:    float
    difference:  float
    matched:     int


class ReleaseYearStat(BaseModel):
    year:       int
    count:      int
    avg_rating: Optional[float] = None


class StatsResponse(BaseModel):
    total:     int
    current:   int
    planned:   int
    completed: int
    on_hold:   int
    dropped:   int
    avg_rating:     Optional[float] = None
    avg_rating_all: Optional[float] = None
    by_medium: list[MediumCount]
    by_origin: list[OriginCount]
    entries_per_month: list[MonthCount]
    completion_rate: float
    rating_coverage: float
    average_active_progress: Optional[float] = None
    oldest_planned_title: Optional[str] = None
    oldest_planned_days: Optional[int] = None
    current_completion_streak: int
    longest_completion_streak: int
    rating_distribution: list[RatingBucket]
    activity_per_month: list[MonthActivity]
    completion_by_medium: list[MediumCompletion]
    backlog_age: list[BacklogBucket]
    rating_comparison_by_medium: list[MediumRatingComparison]
    release_years: list[ReleaseYearStat]


class DashboardStatsResponse(BaseModel):
    total:     int
    current:   int
    planned:   int
    completed: int
    on_hold:   int
    dropped:   int
    avg_rating: Optional[float] = None
    by_medium: list[MediumCount]
    by_origin: list[OriginCount]
    entries_per_month: list[MonthCount]


class DashboardBootstrapResponse(BaseModel):
    activity: list[ActivityRead] = Field(default_factory=list)
    stats: DashboardStatsResponse
    current: EntryListResponse
    completed: EntryListResponse
    on_hold: EntryListResponse
    dropped: EntryListResponse
    planned: EntryListResponse
    revision: int = 0


class LibraryRevisionResponse(BaseModel):
    revision: int = 0


class LibraryBootstrapResponse(BaseModel):
    entries: EntryListResponse
    counts: EntryCountsResponse
    custom_lists: list[CustomListRead]
    revision: int = 0
