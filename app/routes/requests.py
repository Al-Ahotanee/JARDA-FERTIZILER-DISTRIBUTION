"""JARDA — Farmer requests and allocation routes."""
import logging
from datetime import datetime
from flask import Blueprint, request, jsonify
from ..database import get_db
from ..utils import sanitize, generate_qr_code, log_audit
from ..middleware import require_auth
from ..blockchain import add_distribution_block

bp = Blueprint("requests", __name__, url_prefix="/api")
logger = logging.getLogger(__name__)


@bp.route("/requests", methods=["POST"])
@require_auth("farmer")
def submit_request(token_data):
    try:
        data           = request.json or {}
        farmer_id      = sanitize(data["farmer_id"])
        season_id      = int(data["season_id"])
        requested_bags = int(data["requested_bags"])

        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM seasons WHERE id = %s AND status = 'active'", (season_id,))
                if not cur.fetchone():
                    return jsonify({"success": False, "message": "Season not found or inactive"}), 400

                cur.execute(
                    "SELECT id FROM farmer_requests WHERE farmer_id = %s AND season_id = %s",
                    (farmer_id, season_id),
                )
                if cur.fetchone():
                    return jsonify({"success": False, "message": "You already submitted a request for this season"}), 400

                cur.execute(
                    "INSERT INTO farmer_requests (farmer_id, season_id, requested_bags, status) VALUES (%s,%s,%s,'pending')",
                    (farmer_id, season_id, requested_bags),
                )

        log_audit(farmer_id, "farmer", "submit_request", f"Requested {requested_bags} bags for season {season_id}")
        return jsonify({"success": True, "message": "Request submitted successfully"})
    except Exception as e:
        logger.exception("submit_request failed")
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("/requests/farmer/<farmer_id>", methods=["GET"])
@require_auth("farmer", "admin")
def get_farmer_requests(farmer_id, token_data):
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT r.*, s.name AS season_name, s.fertilizer_type
                       FROM farmer_requests r JOIN seasons s ON r.season_id = s.id
                       WHERE r.farmer_id = %s ORDER BY r.created_at DESC""",
                    (farmer_id,),
                )
                return jsonify({"success": True, "data": [dict(r) for r in cur.fetchall()]})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("/requests/season/<int:season_id>", methods=["GET"])
@require_auth("admin")
def get_season_requests(season_id, token_data):
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT r.*, f.name AS farmer_name, f.farm_size, f.lga, f.ward
                       FROM farmer_requests r JOIN farmers f ON r.farmer_id = f.id
                       WHERE r.season_id = %s ORDER BY r.created_at ASC""",
                    (season_id,),
                )
                return jsonify({"success": True, "data": [dict(r) for r in cur.fetchall()]})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("/allocate/<int:season_id>", methods=["POST"])
@require_auth("admin")
def allocate_fertilizer(season_id, token_data):
    try:
        admin_id = sanitize(request.json["admin_id"])

        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM seasons WHERE id = %s", (season_id,))
                season = cur.fetchone()
                if not season:
                    return jsonify({"success": False, "message": "Season not found"}), 404

                cur.execute(
                    """SELECT r.*, f.farm_size, f.total_bags_received
                       FROM farmer_requests r JOIN farmers f ON r.farmer_id = f.id
                       WHERE r.season_id = %s AND r.status = 'pending' ORDER BY r.created_at ASC""",
                    (season_id,),
                )
                requests_list = [dict(r) for r in cur.fetchall()]

                if not requests_list:
                    return jsonify({"success": False, "message": "No pending requests for this season"}), 400

                total_bags     = season["total_bags"]
                remaining_bags = total_bags
                allocations    = []

                for req in requests_list:
                    if remaining_bags <= 0:
                        break
                    if req["requested_bags"] <= remaining_bags:
                        allocated = req["requested_bags"]
                    else:
                        weight       = req["farm_size"] / (req["total_bags_received"] + 1)
                        total_weight = sum(r["farm_size"] / (r["total_bags_received"] + 1) for r in requests_list)
                        allocated    = int((weight / total_weight) * total_bags)
                        allocated    = min(allocated, req["requested_bags"], remaining_bags)

                    remaining_bags -= allocated

                    qr_data = {
                        "request_id": req["id"], "farmer_id": req["farmer_id"],
                        "season_id": season_id, "allocated_bags": allocated,
                    }
                    blockchain_hash = add_distribution_block({
                        "type": "allocation", "request_id": req["id"],
                        "farmer_id": req["farmer_id"], "season_id": season_id,
                        "allocated_bags": allocated, "timestamp": datetime.now().isoformat(),
                    })
                    qr_data["blockchain_hash"] = blockchain_hash
                    qr_code = generate_qr_code(qr_data)

                    cur.execute(
                        "UPDATE farmer_requests SET allocated_bags=%s, status='approved', qr_code=%s, blockchain_hash=%s WHERE id=%s",
                        (allocated, qr_code, blockchain_hash, req["id"]),
                    )
                    allocations.append({"request_id": req["id"], "farmer_id": req["farmer_id"], "allocated": allocated})

                cur.execute("UPDATE seasons SET status = 'completed' WHERE id = %s", (season_id,))
                cur.execute(
                    "UPDATE inventory SET quantity = quantity - %s WHERE fertilizer_type = %s",
                    (total_bags - remaining_bags, season["fertilizer_type"]),
                )

        log_audit(admin_id, "admin", "allocate", f"Allocated fertilizer for season {season_id}")
        return jsonify({
            "success": True,
            "message": f"Allocated successfully. {len(allocations)} farmers approved.",
            "allocations": allocations,
        })
    except Exception as e:
        logger.exception("allocate_fertilizer failed")
        return jsonify({"success": False, "message": str(e)}), 500
