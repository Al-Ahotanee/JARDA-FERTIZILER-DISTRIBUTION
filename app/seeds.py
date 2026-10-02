"""
JARDA — Seed default credentials on first boot.
Safe to call on every startup — uses UPSERT so it is fully idempotent.

Default credentials:
  Admin:         A001 / Admin1
  Store Officer: S001 / Officer1
  Farmer:        F001 / Farmer1
"""
import logging

from .database import get_db
from .utils import hash_password

logger = logging.getLogger(__name__)


def seed_defaults() -> None:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO admins (id, name, password)
                VALUES (%s, %s, %s)
                ON CONFLICT (id) DO UPDATE
                    SET name = EXCLUDED.name
                """,
                ("A001", "Admin", hash_password("Admin1")),
            )
            logger.info("Upserted Admin A001")

            cur.execute(
                """
                INSERT INTO store_officers (id, name, password, location)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE
                    SET name = EXCLUDED.name
                """,
                ("S001", "Store Officer", hash_password("Officer1"), "HQ"),
            )
            logger.info("Upserted Store Officer S001")

            cur.execute(
                """
                INSERT INTO farmers (id, name, password, phone, lga, ward, polling_unit, farm_size)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE
                    SET name = EXCLUDED.name
                """,
                ("F001", "Demo Farmer", hash_password("Farmer1"),
                 "08000000000", "Katsina", "Central", "Unit 1", 2.5),
            )
            logger.info("Upserted Farmer F001")
