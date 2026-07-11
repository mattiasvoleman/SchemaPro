import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("API_KEY", "test-api-key-000000000000000000000000")
os.environ.setdefault("ALLOWED_ORIGINS", "http://testserver")
os.environ.setdefault("SCHEDULE_DAYS", "1,2,3,4,5")
