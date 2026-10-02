"""
JARDA Fertilizer Distribution System — Centralised Configuration
All environment variables and app settings live here.
"""
import os


class Config:
    # Flask
    SECRET_KEY: str = os.environ.get("SECRET_KEY", "change-this-in-production")

    # PostgreSQL
    DATABASE_URL: str = os.environ.get("DATABASE_URL", "")

    # Token expiry (seconds) — 8 hours
    TOKEN_TTL: int = int(os.environ.get("TOKEN_TTL", 8 * 3600))

    # Logging
    LOG_LEVEL: str = os.environ.get("LOG_LEVEL", "INFO")
