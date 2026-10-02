"""
JARDA — Database layer
Provides get_db() as a context manager so connections always close,
even when an exception is raised mid-request.
"""
import os
import logging
from contextlib import contextmanager

import psycopg
import psycopg.rows

logger = logging.getLogger(__name__)


def _build_dsn() -> str:
    """Return the connection string, normalising the postgres:// scheme."""
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        raise RuntimeError("DATABASE_URL environment variable is not set.")
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)
    return url


@contextmanager
def get_db():
    """
    Yields a psycopg v3 connection with dict rows.
    Usage:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(...)
        # connection is automatically committed and closed here
    On exception the connection is rolled back then closed.
    """
    conn = psycopg.connect(
        _build_dsn(),
        row_factory=psycopg.rows.dict_row,
        sslmode="require",
    )
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    """Create all tables if they don't exist (idempotent)."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS farmers (
                    id               TEXT PRIMARY KEY,
                    name             TEXT NOT NULL,
                    password         TEXT NOT NULL,
                    phone            TEXT,
                    lga              TEXT,
                    ward             TEXT,
                    polling_unit     TEXT,
                    farm_size        REAL,
                    passport_photo   TEXT,
                    coop_evidence    TEXT,
                    coop_name        TEXT,
                    total_bags_received INTEGER DEFAULT 0,
                    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Safety net for databases created before these columns existed
            cur.execute("""
                ALTER TABLE farmers
                    ADD COLUMN IF NOT EXISTS passport_photo TEXT,
                    ADD COLUMN IF NOT EXISTS coop_evidence   TEXT,
                    ADD COLUMN IF NOT EXISTS coop_name       TEXT
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS admins (
                    id         TEXT PRIMARY KEY,
                    name       TEXT NOT NULL,
                    password   TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS store_officers (
                    id         TEXT PRIMARY KEY,
                    name       TEXT NOT NULL,
                    password   TEXT NOT NULL,
                    location   TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS seasons (
                    id              SERIAL PRIMARY KEY,
                    name            TEXT NOT NULL,
                    fertilizer_type TEXT NOT NULL,
                    total_bags      INTEGER NOT NULL,
                    start_time      TIMESTAMP NOT NULL,
                    end_time        TIMESTAMP NOT NULL,
                    status          TEXT DEFAULT 'pending',
                    created_by      TEXT,
                    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS farmer_requests (
                    id               SERIAL PRIMARY KEY,
                    farmer_id        TEXT NOT NULL REFERENCES farmers(id),
                    season_id        INTEGER NOT NULL REFERENCES seasons(id),
                    requested_bags   INTEGER NOT NULL,
                    allocated_bags   INTEGER DEFAULT 0,
                    status           TEXT DEFAULT 'pending',
                    qr_code          TEXT,
                    blockchain_hash  TEXT,
                    distributed_by   TEXT,
                    distributed_at   TIMESTAMP,
                    acknowledged     BOOLEAN DEFAULT FALSE,
                    acknowledged_at  TIMESTAMP,
                    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS inventory (
                    id              SERIAL PRIMARY KEY,
                    fertilizer_type TEXT NOT NULL,
                    quantity        INTEGER NOT NULL,
                    unit            TEXT DEFAULT 'bags',
                    location        TEXT,
                    last_updated    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS lgas (
                    id   SERIAL PRIMARY KEY,
                    name TEXT UNIQUE NOT NULL
                )
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS wards (
                    id     SERIAL PRIMARY KEY,
                    name   TEXT NOT NULL,
                    lga_id INTEGER NOT NULL REFERENCES lgas(id)
                )
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS polling_units (
                    id      SERIAL PRIMARY KEY,
                    name    TEXT NOT NULL,
                    ward_id INTEGER NOT NULL REFERENCES wards(id)
                )
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS audit_logs (
                    id         SERIAL PRIMARY KEY,
                    actor_id   TEXT NOT NULL,
                    actor_type TEXT NOT NULL,
                    action     TEXT NOT NULL,
                    details    TEXT,
                    timestamp  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS blockchain (
                    id            SERIAL PRIMARY KEY,
                    chain_name    TEXT NOT NULL,
                    block_index   INTEGER NOT NULL,
                    timestamp     TEXT NOT NULL,
                    transactions  JSONB NOT NULL,
                    previous_hash TEXT NOT NULL,
                    hash          TEXT NOT NULL
                )
            """)

    logger.info("PostgreSQL database initialised successfully.")
