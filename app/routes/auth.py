"""
JARDA — Authentication routes
POST /api/register/farmer
POST /api/register/admin
POST /api/register/officer
POST /api/login
"""
import logging
import psycopg.errors

from flask import Blueprint, request, jsonify

from ..database import get_db
from ..utils import hash_password, verify_password, needs_rehash, sanitize, log_audit
from ..middleware import create_token

bp = Blueprint("auth", __name__, url_prefix="/api")
logger = logging.getLogger(__name__)


@bp.route("/register/farmer", methods=["POST"])
def register_farmer():
    try:
        data         = request.json or {}
        farmer_id    = sanitize(data["farmer_id"])
        name         = sanitize(data["name"])
        password     = hash_password(data["password"])
        phone        = sanitize(data.get("phone", ""))
        lga          = sanitize(data.get("lga", ""))
        ward         = sanitize(data.get("ward", ""))
        polling_unit = sanitize(data.get("polling_unit", ""))
        farm_size    = float(data.get("farm_size", 0))
        coop_name    = sanitize(data.get("coop_name", ""))

        # Base64 images — not passed through bleach (would corrupt payload)
        passport_photo = data.get("passport_photo", "") or ""
        coop_evidence  = data.get("coop_evidence",  "") or ""
        if passport_photo and not passport_photo.startswith("data:"):
            return jsonify({"success": False, "message": "Invalid passport photo format"}), 400
        if coop_evidence and not coop_evidence.startswith("data:"):
            return jsonify({"success": False, "message": "Invalid cooperative evidence format"}), 400

        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO farmers
                       (id, name, password, phone, lga, ward, polling_unit, farm_size,
                        passport_photo, coop_evidence, coop_name)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (farmer_id, name, password, phone, lga, ward, polling_unit, farm_size,
                     passport_photo, coop_evidence, coop_name),
                )
        log_audit(farmer_id, "farmer", "register", f"Farmer {name} registered")
        return jsonify({"success": True, "message": "Farmer registered successfully"})
    except psycopg.errors.UniqueViolation:
        return jsonify({"success": False, "message": "Farmer ID already exists"}), 400
    except Exception as e:
        logger.exception("register_farmer failed")
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("/register/admin", methods=["POST"])
def register_admin():
    try:
        data     = request.json or {}
        admin_id = sanitize(data["admin_id"])
        name     = sanitize(data["name"])
        password = hash_password(data["password"])
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO admins (id, name, password) VALUES (%s,%s,%s)",
                    (admin_id, name, password),
                )
        log_audit(admin_id, "admin", "register", f"Admin {name} registered")
        return jsonify({"success": True, "message": "Admin registered successfully"})
    except psycopg.errors.UniqueViolation:
        return jsonify({"success": False, "message": "Admin ID already exists"}), 400
    except Exception as e:
        logger.exception("register_admin failed")
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("/register/officer", methods=["POST"])
def register_officer():
    try:
        data       = request.json or {}
        officer_id = sanitize(data["officer_id"])
        name       = sanitize(data["name"])
        password   = hash_password(data["password"])
        location   = sanitize(data.get("location", ""))
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO store_officers (id, name, password, location) VALUES (%s,%s,%s,%s)",
                    (officer_id, name, password, location),
                )
        log_audit(officer_id, "store_officer", "register", f"Store Officer {name} registered")
        return jsonify({"success": True, "message": "Store Officer registered successfully"})
    except psycopg.errors.UniqueViolation:
        return jsonify({"success": False, "message": "Officer ID already exists"}), 400
    except Exception as e:
        logger.exception("register_officer failed")
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("/login", methods=["POST"])
def login():
    try:
        data     = request.json or {}
        user_id  = sanitize(data["user_id"])
        provided = data["password"]

        # Determine table from ID prefix
        prefix_map = {
            "F": ("farmers",       "farmer"),
            "A": ("admins",        "admin"),
            "S": ("store_officers","store_officer"),
        }
        prefix = user_id[0].upper() if user_id else ""
        if prefix not in prefix_map:
            return jsonify({"success": False, "message": "Invalid user ID format"}), 400

        table, user_type = prefix_map[prefix]

        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(f"SELECT * FROM {table} WHERE id = %s", (user_id,))
                user = cur.fetchone()

                if not user or not verify_password(user["password"], provided):
                    return jsonify({"success": False, "message": "Invalid credentials"}), 401

                # Transparent password migration: re-hash with werkzeug if still SHA-256
                if needs_rehash(user["password"]):
                    cur.execute(
                        f"UPDATE {table} SET password = %s WHERE id = %s",
                        (hash_password(provided), user_id),
                    )
                    logger.info("Migrated password hash for %s", user_id)

        token = create_token(user_id, user_type)
        log_audit(user_id, user_type, "login", "User logged in")
        return jsonify({
            "success":   True,
            "user_type": user_type,
            "user_id":   user_id,
            "name":      user["name"],
            "token":     token,
        })
    except Exception as e:
        logger.exception("login failed")
        return jsonify({"success": False, "message": str(e)}), 500
