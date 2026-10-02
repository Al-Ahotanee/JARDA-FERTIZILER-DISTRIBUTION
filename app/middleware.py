"""
JARDA — Auth middleware
Signed token auth using itsdangerous (ships with Flask — no extra dep).

Login endpoint returns:  { "token": "<signed_token>", ... }
Protected routes expect: Authorization: Bearer <signed_token>
"""
import logging
from functools import wraps

from flask import request, jsonify, current_app
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

logger = logging.getLogger(__name__)

_SALT = "jarda-auth-token"


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(current_app.config["SECRET_KEY"])


# ---------------------------------------------------------------------------
# Token creation / validation
# ---------------------------------------------------------------------------

def create_token(user_id: str, user_type: str) -> str:
    """Create a signed token embedding user identity and role."""
    return _serializer().dumps({"user_id": user_id, "user_type": user_type}, salt=_SALT)


def decode_token(token: str, max_age: int | None = None) -> dict | None:
    """
    Decode and verify a signed token.
    Returns the payload dict on success, None on failure.
    """
    try:
        ttl = max_age or current_app.config.get("TOKEN_TTL", 28800)
        return _serializer().loads(token, salt=_SALT, max_age=ttl)
    except SignatureExpired:
        logger.debug("Token expired")
        return None
    except BadSignature:
        logger.debug("Invalid token signature")
        return None


# ---------------------------------------------------------------------------
# Decorator
# ---------------------------------------------------------------------------

def require_auth(*allowed_roles: str):
    """
    Decorator that enforces authentication and optional role check.

    Usage:
        @require_auth()                        # any authenticated user
        @require_auth("admin")                 # admin only
        @require_auth("admin", "store_officer") # either role

    The decoded token payload is injected as `token_data` kwarg.
    """
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            auth_header = request.headers.get("Authorization", "")
            if not auth_header.startswith("Bearer "):
                return jsonify({"success": False, "message": "Authentication required"}), 401

            token = auth_header[len("Bearer "):]
            payload = decode_token(token)
            if payload is None:
                return jsonify({"success": False, "message": "Invalid or expired token"}), 401

            if allowed_roles and payload.get("user_type") not in allowed_roles:
                return jsonify({"success": False, "message": "Insufficient permissions"}), 403

            kwargs["token_data"] = payload
            return fn(*args, **kwargs)
        return wrapper
    return decorator
