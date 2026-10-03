"""
JARDA — Pages + PWA asset routes
Serves HTML pages, manifest.json, sw.js, icons, and health check.
"""
import io
import os
import logging

from flask import Blueprint, Response, jsonify, send_file
from datetime import datetime

from ..database import get_db

bp = Blueprint("pages", __name__)
logger = logging.getLogger(__name__)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _resolve(filename: str) -> str | None:
    for directory in [BASE_DIR, os.getcwd(), "/opt/render/project/src"]:
        path = os.path.join(directory, filename)
        if os.path.isfile(path):
            return path
    return None


# ── HTML pages ──────────────────────────────────────────────────────────────

@bp.route("/")
def landing():
    path = _resolve("main.html") or _resolve("landing.html")
    if path:
        return send_file(path)
    return jsonify({"error": "Landing page not found"}), 404


@bp.route("/app")
def app_main():
    path = _resolve("index.html")
    if path:
        return send_file(path)
    return jsonify({"error": "index.html not found"}), 404


# ── Static JS / PWA files ────────────────────────────────────────────────────

@bp.route("/static/js/<path:filename>")
def serve_static_js(filename):
    """Serve files from the static/js/ directory."""
    path = _resolve(os.path.join("static", "js", filename))
    if path:
        resp = send_file(path, mimetype="application/javascript")
        resp.headers["Cache-Control"] = "public, max-age=3600"
        return resp
    return jsonify({"error": "Not found"}), 404


@bp.route("/sw.js")
def service_worker():
    """Serve the service worker from repo root with correct MIME type and no-cache headers."""
    path = _resolve("sw.js")
    if path:
        resp = send_file(path, mimetype="application/javascript")
        # SW must not be cached by the browser (it self-manages its version)
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        resp.headers["Service-Worker-Allowed"] = "/"
        return resp
    return jsonify({"error": "Service worker not found"}), 404


@bp.route("/manifest.json")
def manifest():
    path = _resolve("manifest.json")
    if path:
        resp = send_file(path, mimetype="application/manifest+json")
        resp.headers["Cache-Control"] = "public, max-age=86400"
        return resp
    return jsonify({"error": "manifest.json not found"}), 404


@bp.route("/static/icons/<filename>")
def serve_icon(filename):
    """Generate PWA icons on-the-fly using Pillow (already a dependency)."""
    SIZE_MAP = {
        "icon-72.png":  72,
        "icon-96.png":  96,
        "icon-128.png": 128,
        "icon-192.png": 192,
        "icon-512.png": 512,
    }
    size = SIZE_MAP.get(filename)
    if not size:
        return jsonify({"error": "Unknown icon"}), 404

    # Serve from disk if pre-generated
    icon_path = _resolve(os.path.join("static", "icons", filename))
    if icon_path:
        resp = send_file(icon_path, mimetype="image/png")
        resp.headers["Cache-Control"] = "public, max-age=604800"
        return resp

    # Generate dynamically with Pillow
    try:
        from PIL import Image, ImageDraw, ImageFont
        img  = Image.new("RGB", (size, size), color=(22, 163, 74))   # JARDA green
        draw = ImageDraw.Draw(img)

        # Draw rounded rect mask (approximation)
        padding = size // 8
        draw.rounded_rectangle(
            [padding, padding, size - padding, size - padding],
            radius=size // 6,
            fill=(255, 255, 255),
        )

        # Draw "J" letter centred
        font_size = size // 3
        try:
            font = ImageFont.truetype("arial.ttf", font_size)
        except Exception:
            font = ImageFont.load_default()
        text  = "J"
        bbox  = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        draw.text(
            ((size - tw) // 2, (size - th) // 2),
            text,
            fill=(22, 163, 74),
            font=font,
        )

        buf = io.BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        resp = Response(buf.getvalue(), mimetype="image/png")
        resp.headers["Cache-Control"] = "public, max-age=604800"
        return resp
    except Exception as e:
        logger.error("Icon generation failed: %s", e)
        return jsonify({"error": "Icon generation failed"}), 500


# ── System ───────────────────────────────────────────────────────────────────

@bp.route("/favicon.ico")
def favicon():
    path = _resolve("favicon.ico") or _resolve(os.path.join("static", "icons", "favicon.ico"))
    if path:
        resp = send_file(path, mimetype="image/x-icon")
        resp.headers["Cache-Control"] = "public, max-age=604800"
        return resp
    return Response(status=204)


@bp.route("/health")
def health():
    try:
        with get_db() as conn:
            pass
        db_status = "connected"
    except Exception as e:
        db_status = f"error: {e}"
    return jsonify({
        "status":    "ok",
        "database":  db_status,
        "timestamp": datetime.now().isoformat(),
    })
