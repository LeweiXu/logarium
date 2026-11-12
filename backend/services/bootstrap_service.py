from sqlalchemy.orm import Session

from models import User
from schemas import DashboardBootstrapResponse, LibraryBootstrapResponse
from services import entry_service, history_service
from services.stats_service import get_dashboard_stats


def get_dashboard_bootstrap(
    db: Session,
    username: str,
    visible_mediums: set[str] | None,
    rated_statuses: list[str] | None = None,
) -> DashboardBootstrapResponse:
    """Build the complete Dashboard payload in one authenticated request."""
    shared = {
        "db": db,
        "username": username,
        "visible_mediums": visible_mediums,
        "include_total": False,
    }
    return DashboardBootstrapResponse(
        # The Dashboard log: the latest status move per entry, ten of them.
        activity=history_service.activity(
            db, username, limit=10, per_entry=True, visible_mediums=visible_mediums,
        ),
        stats=get_dashboard_stats(db, username, visible_mediums),
        current=entry_service.get_entries(
            **shared, status="current", limit=20,
        ),
        rated=entry_service.get_recently_rated(
            db, username=username, visible_mediums=visible_mediums,
            statuses=rated_statuses, limit=20,
        ),
        on_hold=entry_service.get_entries(
            **shared, status="on_hold", limit=6,
            sort="updated_at", order="desc",
        ),
        dropped=entry_service.get_entries(
            **shared, status="dropped", limit=6,
            sort="updated_at", order="desc",
        ),
        planned=entry_service.get_entries(
            **shared, status="planned", limit=20,
            sort="updated_at", order="desc",
        ),
        revision=db.get(User, username).library_revision,
    )


def get_library_bootstrap(
    db: Session,
    username: str,
    visible_mediums: set[str] | None,
    **entry_params,
) -> LibraryBootstrapResponse:
    """Build the first Library view in one authenticated request."""
    # The sidebar counts are faceted against the same filters the entry query
    # uses, so they match the table on first paint (sort/paging don't affect them).
    count_filters = {
        key: entry_params[key]
        for key in ("status", "medium", "origin", "title", "custom_list", "custom_list_empty")
        if key in entry_params
    }
    return LibraryBootstrapResponse(
        entries=entry_service.get_entries(
            db,
            username=username,
            visible_mediums=visible_mediums,
            **entry_params,
        ),
        counts=entry_service.get_entry_counts(
            db, username, visible_mediums, **count_filters
        ),
        custom_lists=entry_service.get_custom_lists(db, username, visible_mediums),
        revision=db.get(User, username).library_revision,
    )
