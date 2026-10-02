from flask import Blueprint

from .pages import bp as pages_bp
from .auth import bp as auth_bp
from .locations import bp as locations_bp
from .inventory import bp as inventory_bp
from .seasons import bp as seasons_bp
from .requests import bp as requests_bp
from .distribution import bp as distribution_bp
from .blockchain_routes import bp as blockchain_bp
from .dashboard import bp as dashboard_bp

__all__ = [
    "pages_bp", "auth_bp", "locations_bp", "inventory_bp",
    "seasons_bp", "requests_bp", "distribution_bp",
    "blockchain_bp", "dashboard_bp",
]
