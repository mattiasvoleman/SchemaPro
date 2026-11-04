import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("API_KEY", "test-api-key-000000000000000000000000")
os.environ.setdefault("ALLOWED_ORIGINS", "http://testserver")
os.environ.setdefault("SCHEDULE_DAYS", "1,2,3,4,5")


def pytest_configure(config):
    config.addinivalue_line("markers", "slow: a long smoke fuzz; run it with `pytest -m slow`")


def pytest_collection_modifyitems(config, items):
    """Tests marked slow run only when -m names them; the ordinary run skips them."""
    if "slow" in (config.getoption("-m") or ""):
        return
    import pytest

    skip = pytest.mark.skip(reason="slow: run with `pytest -m slow`")
    for item in items:
        if "slow" in item.keywords:
            item.add_marker(skip)
