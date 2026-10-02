"""JARDA — Location management routes."""
import logging
import psycopg.errors
from flask import Blueprint, request, jsonify
from ..database import get_db
from ..utils import sanitize
from ..middleware import require_auth

bp = Blueprint("locations", __name__, url_prefix="/api/locations")
logger = logging.getLogger(__name__)


@bp.route("/lga", methods=["POST"])
@require_auth("admin")
def add_lga(token_data):
    try:
        name = sanitize(request.json["name"])
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("INSERT INTO lgas (name) VALUES (%s)", (name,))
        return jsonify({"success": True, "message": "LGA added successfully"})
    except psycopg.errors.UniqueViolation:
        return jsonify({"success": False, "message": "LGA already exists"}), 400
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("/lga", methods=["GET"])
def get_lgas():
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM lgas ORDER BY name")
                return jsonify({"success": True, "data": [dict(r) for r in cur.fetchall()]})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("/ward", methods=["POST"])
@require_auth("admin")
def add_ward(token_data):
    try:
        data = request.json or {}
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO wards (name, lga_id) VALUES (%s, %s)",
                    (sanitize(data["name"]), int(data["lga_id"])),
                )
        return jsonify({"success": True, "message": "Ward added successfully"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("/ward/<int:lga_id>", methods=["GET"])
def get_wards(lga_id):
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM wards WHERE lga_id = %s ORDER BY name", (lga_id,))
                return jsonify({"success": True, "data": [dict(r) for r in cur.fetchall()]})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("/polling_unit", methods=["POST"])
@require_auth("admin")
def add_polling_unit(token_data):
    try:
        data = request.json or {}
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO polling_units (name, ward_id) VALUES (%s, %s)",
                    (sanitize(data["name"]), int(data["ward_id"])),
                )
        return jsonify({"success": True, "message": "Polling unit added successfully"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("/polling_unit/<int:ward_id>", methods=["GET"])
def get_polling_units(ward_id):
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM polling_units WHERE ward_id = %s ORDER BY name", (ward_id,))
                return jsonify({"success": True, "data": [dict(r) for r in cur.fetchall()]})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500
