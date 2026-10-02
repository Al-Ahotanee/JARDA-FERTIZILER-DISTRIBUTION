"""
JARDA — Shared utilities
  - Password hashing (werkzeug pbkdf2) with transparent SHA-256 migration
  - Input sanitisation
  - QR code generation
  - Audit logging
"""
import hashlib
import io
import base64
import logging

import bleach
import qrcode
from werkzeug.security import generate_password_hash, check_password_hash

from .database import get_db

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Password helpers
# ---------------------------------------------------------------------------

def hash_password(password: str) -> str:
    """Hash a password with werkzeug's pbkdf2_sha256 (salted)."""
    return generate_password_hash(password)


def verify_password(stored_hash: str, provided_password: str) -> bool:
    """
    Verify a password against a stored hash.
    Supports both new werkzeug hashes and legacy bare SHA-256 hashes
    so existing users are not locked out.
    """
    # New-style werkzeug hash (starts with 'pbkdf2:' or 'scrypt:')
    if stored_hash.startswith("pbkdf2:") or stored_hash.startswith("scrypt:"):
        return check_password_hash(stored_hash, provided_password)

    # Legacy SHA-256 (64 hex chars) — used before the refactor
    legacy = hashlib.sha256(provided_password.encode()).hexdigest()
    return stored_hash == legacy


def needs_rehash(stored_hash: str) -> bool:
    """Return True if the stored hash is a legacy SHA-256 that should be upgraded."""
    return not (stored_hash.startswith("pbkdf2:") or stored_hash.startswith("scrypt:"))


# ---------------------------------------------------------------------------
# Input sanitisation
# ---------------------------------------------------------------------------

def sanitize(text) -> str:
    """Strip HTML/JS from user-supplied strings."""
    return bleach.clean(str(text))


# ---------------------------------------------------------------------------
# QR code generation
# ---------------------------------------------------------------------------

def generate_qr_code(data: dict) -> str:
    """Return a base64-encoded PNG data URL for the given payload."""
    import json
    qr = qrcode.QRCode(version=1, box_size=10, border=5)
    qr.add_data(json.dumps(data))
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


# ---------------------------------------------------------------------------
# Audit logging
# ---------------------------------------------------------------------------

def log_audit(actor_id: str, actor_type: str, action: str, details: str = "") -> None:
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO audit_logs (actor_id, actor_type, action, details) VALUES (%s, %s, %s, %s)",
                    (actor_id, actor_type, action, details),
                )
    except Exception as exc:
        logger.error("Audit log failed: %s", exc)
