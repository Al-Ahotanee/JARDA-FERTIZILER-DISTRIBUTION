"""
JARDA — Legacy compatibility shim.
Render Blueprint and Procfile reference `app:app`.
This file keeps that working while the real logic lives in the app/ package.
"""
from wsgi import app  # noqa: F401

if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 5000))
    app.run(debug=False, host="0.0.0.0", port=port)
