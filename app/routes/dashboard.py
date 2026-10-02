"""JARDA — Dashboard / statistics / reporting routes."""
import logging
from flask import Blueprint, jsonify
from ..database import get_db
from ..middleware import require_auth
from ..utils import sanitize

bp = Blueprint("dashboard", __name__, url_prefix="/api")
logger = logging.getLogger(__name__)


@bp.route("/stats/admin", methods=["GET"])
@require_auth("admin")
def get_admin_stats(token_data):
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                def scalar(q, p=()):
                    cur.execute(q, p)
                    return list(cur.fetchone().values())[0] or 0

                stats = {
                    "total_farmers":     scalar("SELECT COUNT(*) FROM farmers"),
                    "total_admins":      scalar("SELECT COUNT(*) FROM admins"),
                    "total_officers":    scalar("SELECT COUNT(*) FROM store_officers"),
                    "total_seasons":     scalar("SELECT COUNT(*) FROM seasons"),
                    "total_allocated":   scalar("SELECT COALESCE(SUM(allocated_bags),0) FROM farmer_requests WHERE status != 'pending'"),
                    "total_distributed": scalar("SELECT COALESCE(SUM(allocated_bags),0) FROM farmer_requests WHERE status IN ('distributed','completed')"),
                }
                cur.execute("SELECT status, COUNT(*) AS count FROM farmer_requests GROUP BY status")
                stats["request_status"] = [dict(r) for r in cur.fetchall()]
                cur.execute("SELECT status, COUNT(*) AS count FROM seasons GROUP BY status")
                stats["season_status"] = [dict(r) for r in cur.fetchall()]

        return jsonify({"success": True, "data": stats})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("/farmers", methods=["GET"])
@require_auth("admin")
def get_all_farmers(token_data):
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT id, name, phone, lga, ward, polling_unit, farm_size, coop_name,
                           (passport_photo IS NOT NULL AND passport_photo != '') AS has_passport_photo,
                           (coop_evidence  IS NOT NULL AND coop_evidence  != '') AS has_coop_evidence,
                           total_bags_received, created_at
                    FROM farmers ORDER BY name
                """)
                return jsonify({"success": True, "data": [dict(r) for r in cur.fetchall()]})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("/farmers/<farmer_id>", methods=["GET"])
@require_auth("admin", "farmer")
def get_farmer_detail(farmer_id, token_data):
    try:
        farmer_id = sanitize(farmer_id)
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT id, name, phone, lga, ward, polling_unit, farm_size, coop_name,
                           passport_photo, coop_evidence, total_bags_received, created_at
                    FROM farmers WHERE id = %s
                """, (farmer_id,))
                farmer = cur.fetchone()
        if not farmer:
            return jsonify({"success": False, "message": "Farmer not found"}), 404
        return jsonify({"success": True, "data": dict(farmer)})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("/officers", methods=["GET"])
@require_auth("admin")
def get_all_officers(token_data):
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id, name, location, created_at FROM store_officers ORDER BY name")
                return jsonify({"success": True, "data": [dict(r) for r in cur.fetchall()]})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("/audit_logs", methods=["GET"])
@require_auth("admin")
def get_audit_logs(token_data):
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 100")
                return jsonify({"success": True, "data": [dict(r) for r in cur.fetchall()]})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("/distributions/pending", methods=["GET"])
@require_auth("store_officer", "admin")
def get_pending_distributions(token_data):
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT r.*, f.name AS farmer_name, s.fertilizer_type, s.name AS season_name
                    FROM farmer_requests r
                    JOIN farmers f ON r.farmer_id = f.id
                    JOIN seasons  s ON r.season_id  = s.id
                    WHERE r.status = 'approved' ORDER BY r.created_at ASC
                """)
                return jsonify({"success": True, "data": [dict(r) for r in cur.fetchall()]})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("/distributions/officer/<officer_id>", methods=["GET"])
@require_auth("store_officer", "admin")
def get_officer_distributions(officer_id, token_data):
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT r.*, f.name AS farmer_name, s.fertilizer_type, s.name AS season_name
                    FROM farmer_requests r
                    JOIN farmers f ON r.farmer_id = f.id
                    JOIN seasons  s ON r.season_id  = s.id
                    WHERE r.distributed_by = %s ORDER BY r.distributed_at DESC
                """, (officer_id,))
                return jsonify({"success": True, "data": [dict(r) for r in cur.fetchall()]})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500
