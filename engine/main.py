"""Vercel entrypoint: exposes the FastAPI app as `app` (src layout is added to the import path)."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "src"))

from replen_engine.api import create_app  # noqa: E402

app = create_app()
