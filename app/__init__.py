"""
JARDA — Flask application factory
"""
import logging
import os
from flask import Flask

from .config import Config


def create_app(config_class=Config) -> Flask:
    app = Flask(__name__, static_folder=None)  # we serve static files ourselves
    app.config.from_object(config_class)

    # ── Logging ─────────────────────────────────────────────────────────────
    logging.basicConfig(
        level=getattr(logging, app.config.get("LOG_LEVEL", "INFO")),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    logger = logging.getLogger(__name__)

    # ── Register blueprints ──────────────────────────────────────────────────
    from .routes import (
        pages_bp, auth_bp, locations_bp, inventory_bp,
        seasons_bp, requests_bp, distribution_bp,
        blockchain_bp, dashboard_bp,
    )
    for bp in [pages_bp, auth_bp, locations_bp, inventory_bp,
               seasons_bp, requests_bp, distribution_bp,
               blockchain_bp, dashboard_bp]:
        app.register_blueprint(bp)

    # ── Bootstrap DB + blockchain + seeds (once per process) ────────────────
    with app.app_context():
        try:
            from .database  import init_db
            from .blockchain import init_blockchain
            from .seeds      import seed_defaults
            init_db()
            init_blockchain()
            seed_defaults()
            logger.info("Bootstrap complete.")
        except Exception as exc:
            logger.error("Bootstrap failed (DATABASE_URL may not be set): %s", exc)

    # ── Flask CLI command ────────────────────────────────────────────────────
    @app.cli.command("init-db")
    def init_db_command():
        """flask init-db — initialise DB, blockchain, and seed defaults."""
        from .database  import init_db
        from .blockchain import init_blockchain
        from .seeds      import seed_defaults
        init_db()
        init_blockchain()
        seed_defaults()
        print("Database, blockchain, and default credentials initialised.")

    return app


# ── Module-level app instance ────────────────────────────────────────────────
# Gunicorn resolves `app:app` by importing this package and reading the `app`
# attribute. Without this line Python finds the app/ directory (package) but
# can't find an `app` attribute inside it → AppImportError.
app = create_app()
