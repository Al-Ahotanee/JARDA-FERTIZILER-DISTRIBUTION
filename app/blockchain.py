"""
JARDA — Blockchain layer
PostgreSQL-backed append-only chains for distribution and inventory events.
"""
import hashlib
import json
import logging
from datetime import datetime

from .database import get_db

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Core hash function
# ---------------------------------------------------------------------------

def calculate_hash(index: int, timestamp: str, transactions: list, previous_hash: str) -> str:
    value = str(index) + str(timestamp) + json.dumps(transactions, sort_keys=True) + str(previous_hash)
    return hashlib.sha256(value.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Initialisation
# ---------------------------------------------------------------------------

def init_blockchain() -> None:
    """Insert genesis blocks for both chains if they don't already exist."""
    with get_db() as conn:
        with conn.cursor() as cur:
            for chain_name in ("distribution", "inventory"):
                cur.execute(
                    "SELECT COUNT(*) AS count FROM blockchain WHERE chain_name = %s",
                    (chain_name,),
                )
                if cur.fetchone()["count"] == 0:
                    ts = datetime.now().isoformat()
                    genesis_hash = calculate_hash(0, ts, [], "0")
                    cur.execute(
                        """
                        INSERT INTO blockchain
                            (chain_name, block_index, timestamp, transactions, previous_hash, hash)
                        VALUES (%s, %s, %s, %s, %s, %s)
                        """,
                        (chain_name, 0, ts, json.dumps([]), "0", genesis_hash),
                    )
                    logger.info("%s blockchain genesis block created.", chain_name.capitalize())


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _load_chain(chain_name: str) -> list:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT * FROM blockchain WHERE chain_name = %s ORDER BY block_index ASC",
                (chain_name,),
            )
            return [dict(r) for r in cur.fetchall()]


def _append_block(chain_name: str, transaction: dict) -> str:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT * FROM blockchain WHERE chain_name = %s ORDER BY block_index DESC LIMIT 1",
                (chain_name,),
            )
            prev = dict(cur.fetchone())
            ts = datetime.now().isoformat()
            transactions = [transaction]
            new_index = prev["block_index"] + 1
            new_hash = calculate_hash(new_index, ts, transactions, prev["hash"])
            cur.execute(
                """
                INSERT INTO blockchain
                    (chain_name, block_index, timestamp, transactions, previous_hash, hash)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (chain_name, new_index, ts, json.dumps(transactions), prev["hash"], new_hash),
            )
    return new_hash


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def add_distribution_block(transaction: dict) -> str:
    """Append a block to the distribution chain and return the new hash."""
    return _append_block("distribution", transaction)


def add_inventory_block(transaction: dict) -> str:
    """Append a block to the inventory chain and return the new hash."""
    return _append_block("inventory", transaction)


def load_distribution_chain() -> list:
    return _load_chain("distribution")


def verify_distribution_chain() -> bool:
    """Return True if the distribution chain is intact and untampered."""
    chain = _load_chain("distribution")
    for i in range(1, len(chain)):
        curr, prev = chain[i], chain[i - 1]
        if curr["previous_hash"] != prev["hash"]:
            return False
        txns = (
            curr["transactions"]
            if isinstance(curr["transactions"], list)
            else json.loads(curr["transactions"])
        )
        if curr["hash"] != calculate_hash(
            curr["block_index"], curr["timestamp"], txns, curr["previous_hash"]
        ):
            return False
    return True
