"""JARDA — Season management routes."""
import logging
from flask import Blueprint, request, jsonify
from ..database import get_db
from ..utils import sanitize, log_audit
from ..middleware import require_auth

bp = Blueprint("seasons", __name__, url_prefix="/api/seasons")
logger = logging.getLogger(__name__)


@bp.route("", methods=["POST"])
@require_auth("admin")
def create_season(token_data):
    try:
        data            = request.json or {}
        name            = sanitize(data["name"])
        fertilizer_type = sanitize(data["fertilizer_type"])
        total_bags      = int(data["total_bags"])
        start_time      = data["start_time"]
        end_time        = data["end_time"]
        created_by      = sanitize(data["created_by"])

        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COALESCE(SUM(quantity), 0) AS total FROM inventory WHERE fertilizer_type = %s",
                    (fertilizer_type,),
                )
                available = cur.fetchone()["total"]
                if available < total_bags:
                    return jsonify({
                        "success": False,
                        "message": f"Insufficient inventory. Available: {available} bags",
                    }), 400

                cur.execute(
                    """INSERT INTO seasons
                       (name, fertilizer_type, total_bags, start_time, end_time, created_by, status)
                       VALUES (%s,%s,%s,%s,%s,%s,'active') RETURNING id""",
                    (name, fertilizer_type, total_bags, start_time, end_time, created_by),
                )
                season_id = cur.fetchone()["id"]

        log_audit(created_by, "admin", "create_season", f"Season {name} created with {total_bags} bags")
        return jsonify({"success": True, "message": "Season created successfully", "season_id": season_id})
    except Exception as e:
        logger.exception("create_season failed")
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("", methods=["GET"])
def get_seasons():
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM seasons ORDER BY created_at DESC")
                return jsonify({"success": True, "data": [dict(r) for r in cur.fetchall()]})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("/active", methods=["GET"])
def get_active_seasons():
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT * FROM seasons WHERE status = 'active' AND end_time > NOW() ORDER BY created_at DESC"
                )
                return jsonify({"success": True, "data": [dict(r) for r in cur.fetchall()]})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500
