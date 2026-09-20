from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Database
    DATABASE_URL: str = "postgresql://postgres:postgres@localhost:5432/mediatracker"

    # CORS
    CORS_ORIGINS: str = "http://localhost:3000,https://logarium.vercel.app"

    # Server
    HOST: str = "0.0.0.0"
    PORT: int = 6443

    # Cover image cache (filesystem). Each source cover is cached at 3 fixed
    # sizes tuned to our display boxes (thumb=tables, medium=Explore cards,
    # full=detail modal), hashed by source URL; see cover_cache_service.py.
    COVER_CACHE_DIR: str = "~/LOG_cache"
    COVER_THUMB_W: int = 56
    COVER_THUMB_H: int = 80
    COVER_MEDIUM_W: int = 184
    COVER_MEDIUM_H: int = 264
    COVER_FULL_W: int = 500
    COVER_FULL_H: int = 750

    # Auth
    SECRET_KEY: str = "changeme-replace-with-a-strong-random-secret"
    JWT_ALGORITHM: str = "HS256"

    # Public demo account. /auth/demo hands out a normal session for this user
    # to anyone who asks, which is what makes the site's /demo link work. The
    # account is public by design (credentials are in the README) and is wiped
    # and re-seeded every 24h by scripts/demo_script.py. Set to "" to turn the
    # endpoint off entirely.
    DEMO_USERNAME: str = "demo_user"

    # External API keys (all optional)
    # MyAnimeList's official API. Every endpoint needs the client ID, even the
    # public ones; register an app at https://myanimelist.net/apiconfig. The
    # secret is only needed for user-login (OAuth) calls, which we never make.
    MAL_CLIENT_ID: str = ""
    MAL_CLIENT_SECRET: str = ""
    TMDB_API_KEY: str = ""
    IGDB_CLIENT_ID: str = ""
    IGDB_CLIENT_SECRET: str = ""
    GOOGLE_BOOKS_API_KEY: str = ""
    RAWG_API_KEY: str = ""
    COMICVINE_API_KEY: str = ""

    # ── Email backup (all optional — feature is disabled if any are missing) ──
    # See backend/BACKUP.md for setup instructions (Gmail app password etc.).
    SMTP_HOST:     str = ""
    SMTP_PORT:     int = 587
    SMTP_USER:     str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM:     str = ""    # falls back to SMTP_USER if blank
    # Frequency the scheduler ticks at — independent of per-user backup_freq.
    BACKUP_TICK_SECONDS: int = 3600

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def smtp_configured(self) -> bool:
        return bool(self.SMTP_HOST and self.SMTP_USER and self.SMTP_PASSWORD)

    @property
    def smtp_from_address(self) -> str:
        return self.SMTP_FROM or self.SMTP_USER


@lru_cache
def get_settings() -> Settings:
    return Settings()
