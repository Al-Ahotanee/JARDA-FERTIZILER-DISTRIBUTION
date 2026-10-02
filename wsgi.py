"""
JARDA — WSGI entry point for Gunicorn.
Gunicorn start command: gunicorn wsgi:app ...
"""
from app import create_app

app = create_app()
