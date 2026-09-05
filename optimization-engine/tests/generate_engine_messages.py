"""Dump the engine's message catalogue for the web's parity test.

    optimization-engine/.venv/bin/python \
      optimization-engine/tests/generate_engine_messages.py \
      > web/i18n/__fixtures__/engine-messages.json

The web cannot read Python, and a test that parsed it would be a second
implementation of the catalogue. The fixture is the contract instead, and
test_the_message_fixture_is_current fails the engine's own suite when this
file and the fixture disagree — so a new sentence cannot ship untranslated
without a red test on both sides.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.messages import MESSAGES  # noqa: E402

if __name__ == "__main__":
    json.dump(dict(sorted(MESSAGES.items())), sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
