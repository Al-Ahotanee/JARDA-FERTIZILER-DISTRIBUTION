"""JARDA — Inventory management routes."""
import logging
from datetime import datetime
from flask import Blueprint, request, jsonify
from ..database import get_db
from ..utils import sanitize
from ..middleware import require_auth
from ..blockchain import add_inventory_block

bp = Blueprint("inventory", __name__, url_prefix="/api/inventory")
logger = logging.getLogger(__name__)


@bp.route("", methods=["POST"])
@require_auth("admin")
def add_inventory(token_data):
    try:
        data            = request.json or {}
        fertilizer_type = sanitize(data["fertilizer_type"])
        quantity        = int(data["quantity"])
        location        = sanitize(data.get("location", ""))

        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id FROM inventory WHERE fertilizer_type = %s AND location = %s",
                    (fertilizer_type, location),
                )
                if cur.fetchone():
                    cur.execute(
                        """UPDATE inventory
                           SET quantity = quantity + %s, last_updated = CURRENT_TIMESTAMP
                           WHERE fertilizer_type = %s AND location = %s""",
                        (quantity, fertilizer_type, location),
                    )
                else:
                    cur.execute(
                        "INSERT INTO inventory (fertilizer_type, quantity, location) VALUES (%s,%s,%s)",
                        (fertilizer_type, quantity, location),
                    )

        add_inventory_block({
            "type": "add_inventory", "fertilizer_type": fertilizer_type,
            "quantity": quantity, "location": location,
            "timestamp": datetime.now().isoformat(),
        })
        return jsonify({"success": True, "message": "Inventory added successfully"})
    except Exception as e:
        logger.exception("add_inventory failed")
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("", methods=["GET"])
def get_inventory():
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM inventory ORDER BY fertilizer_type")
                return jsonify({"success": True, "data": [dict(r) for r in cur.fetchall()]})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500
