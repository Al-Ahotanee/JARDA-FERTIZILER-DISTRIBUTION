"""JARDA — Distribution routes (verify QR, distribute, acknowledge, slip)."""
import json
import logging
from datetime import datetime
from flask import Blueprint, request, jsonify
from ..database import get_db
from ..utils import sanitize, log_audit
from ..middleware import require_auth
from ..blockchain import add_distribution_block

bp = Blueprint("distribution", __name__, url_prefix="/api")
logger = logging.getLogger(__name__)


@bp.route("/verify_qr", methods=["POST"])
@require_auth("store_officer", "admin")
def verify_qr(token_data):
    try:
        qr_data_str = request.json.get("qr_data", "")
        try:
            qr_data = json.loads(qr_data_str)
        except json.JSONDecodeError:
            return jsonify({"success": False, "message": "Invalid QR code format"}), 400

        request_id      = qr_data.get("request_id")
        blockchain_hash = qr_data.get("blockchain_hash")
        if not request_id or not blockchain_hash:
            return jsonify({"success": False, "message": "QR code missing required fields"}), 400

        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT r.*, f.name AS farmer_name, s.fertilizer_type, s.name AS season_name
                       FROM farmer_requests r
                       JOIN farmers f ON r.farmer_id = f.id
                       JOIN seasons  s ON r.season_id  = s.id
                       WHERE r.id = %s""",
                    (request_id,),
                )
                req = cur.fetchone()

        if not req:
            return jsonify({"success": False, "message": "Request not found in system"}), 404
        if req["blockchain_hash"] != blockchain_hash:
            return jsonify({"success": False, "message": "Blockchain verification failed — possible fake QR!"}), 400
        if req["status"] == "distributed":
            return jsonify({"success": False, "message": "Already distributed"}), 400
        if req["status"] == "completed":
            return jsonify({"success": False, "message": "Transaction already completed"}), 400
        if req["status"] != "approved":
            return jsonify({"success": False, "message": f"Status is '{req['status']}', not approved"}), 400

        return jsonify({"success": True, "data": dict(req)})
    except Exception as e:
        logger.exception("verify_qr failed")
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("/distribute", methods=["POST"])
@require_auth("store_officer", "admin")
def distribute_fertilizer(token_data):
    try:
        data       = request.json or {}
        request_id = int(data["request_id"])
        officer_id = sanitize(data["officer_id"])

        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM farmer_requests WHERE id = %s", (request_id,))
                req = cur.fetchone()
                if not req:
                    return jsonify({"success": False, "message": "Request not found"}), 404
                if req["status"] != "approved":
                    return jsonify({"success": False, "message": "Not approved for distribution"}), 400
                cur.execute(
                    "UPDATE farmer_requests SET status='distributed', distributed_by=%s, distributed_at=CURRENT_TIMESTAMP WHERE id=%s",
                    (officer_id, request_id),
                )

        add_distribution_block({
            "type": "distribution", "request_id": request_id,
            "farmer_id": req["farmer_id"], "distributed_by": officer_id,
            "allocated_bags": req["allocated_bags"],
            "timestamp": datetime.now().isoformat(),
        })
        log_audit(officer_id, "store_officer", "distribute", f"Distributed to farmer {req['farmer_id']}")
        return jsonify({"success": True, "message": "Fertilizer distributed successfully"})
    except Exception as e:
        logger.exception("distribute_fertilizer failed")
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("/acknowledge", methods=["POST"])
@require_auth("farmer")
def acknowledge_receipt(token_data):
    try:
        data       = request.json or {}
        request_id = int(data["request_id"])
        farmer_id  = sanitize(data["farmer_id"])

        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT * FROM farmer_requests WHERE id = %s AND farmer_id = %s",
                    (request_id, farmer_id),
                )
                req = cur.fetchone()
                if not req:
                    return jsonify({"success": False, "message": "Request not found"}), 404
                if req["status"] != "distributed":
                    return jsonify({"success": False, "message": "Fertilizer not yet distributed"}), 400

                cur.execute(
                    "UPDATE farmer_requests SET acknowledged=TRUE, acknowledged_at=CURRENT_TIMESTAMP, status='completed' WHERE id=%s",
                    (request_id,),
                )
                cur.execute(
                    "UPDATE farmers SET total_bags_received = total_bags_received + %s WHERE id = %s",
                    (req["allocated_bags"], farmer_id),
                )

        add_distribution_block({
            "type": "acknowledgement", "request_id": request_id,
            "farmer_id": farmer_id, "bags_received": req["allocated_bags"],
            "timestamp": datetime.now().isoformat(),
        })
        log_audit(farmer_id, "farmer", "acknowledge", f"Acknowledged {req['allocated_bags']} bags")
        return jsonify({"success": True, "message": "Receipt acknowledged successfully"})
    except Exception as e:
        logger.exception("acknowledge_receipt failed")
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("/acknowledgement_slip/<int:request_id>", methods=["GET"])
@require_auth("farmer", "admin", "store_officer")
def get_acknowledgement_slip(request_id, token_data):
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT r.id AS request_id, r.allocated_bags, r.status, r.acknowledged,
                              r.acknowledged_at, r.distributed_at, r.blockchain_hash,
                              f.id AS farmer_id, f.name AS farmer_name, f.phone, f.lga, f.ward,
                              f.polling_unit, f.passport_photo, f.coop_name,
                              s.name AS season_name, s.fertilizer_type
                       FROM farmer_requests r
                       JOIN farmers f ON r.farmer_id = f.id
                       JOIN seasons  s ON r.season_id  = s.id
                       WHERE r.id = %s""",
                    (request_id,),
                )
                slip = cur.fetchone()

        if not slip:
            return jsonify({"success": False, "message": "Request not found"}), 404
        if not slip["acknowledged"]:
            return jsonify({"success": False, "message": "Not yet acknowledged"}), 400
        return jsonify({"success": True, "data": dict(slip)})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500
