"""JARDA — Blockchain inspection routes."""
import logging
from flask import Blueprint, jsonify
from ..blockchain import load_distribution_chain, verify_distribution_chain
from ..middleware import require_auth

bp = Blueprint("blockchain", __name__, url_prefix="/api/blockchain")
logger = logging.getLogger(__name__)


@bp.route("", methods=["GET"])
@require_auth("admin")
def get_blockchain(token_data):
    try:
        return jsonify({"success": True, "data": load_distribution_chain()})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@bp.route("/verify", methods=["GET"])
def verify_blockchain_endpoint():
    try:
        valid = verify_distribution_chain()
        return jsonify({
            "success": True,
            "valid":   valid,
            "message": "Blockchain is valid" if valid else "Blockchain has been tampered with",
        })
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500
