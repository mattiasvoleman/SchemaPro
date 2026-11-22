"""The corpus of benchmarks/school_corpus.py is the same bytes everywhere, and says when it is not (M5).

The nightly gate compares one corpus against two engines, and a stored result names the week by
`CORPUS_VERSION` and its name. That holds only if (a) a shape builds the same request in every
process, whatever PYTHONHASHSEED says about the order of a set, and on every Python, and (b)
whoever changes what a shape builds is told to bump CORPUS_VERSION. test_school_corpus.py builds
a shape twice in ONE process, which can show neither: a set walked in hash order gives the same
bytes twice in a row.

THE DIGESTS BELOW ARE THE CONTRACT. A test that fails here means a shape now builds another
week: change CORPUS_VERSION (it is in every requestId) and write the new digests in the same
commit, with the reason. If only the digest of one shape moved and you did not mean it, the
generator is not deterministic.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import school_corpus as corpus  # noqa: E402

#: sha256 of the request, as canonical JSON (sorted keys), for CORPUS_VERSION 1.
GOLDEN = {
    "n12-g3-m0-s1": "139f71f2e5379dcb14d687c4ef3ffa9a2f8805fbca9930fb429a18ac3a824d9d",
    "n12-g3-m0-s2": "16795d8ff51a8935610af99eb548972fd925b1b1c00d18a95ca00f0e3b3caf5c",
    "n9-g10-m0-s1-t5-h": "82ba5a69e09f61e81c7bea54f6edb11cfed790c578835a4a04292fd423e6cc9a",
    "n12-g6-m3-s3-t3-b-h-k": "cb3f9bd1abf35680d0412c8ce8a4086f348b72ad20ed68d456657c0ac9835b04",
    "n6-g0-m0-s1": "52aefabd43681d404b6ff0d1b74e44915496958b28c2760ac048489f0cbe26a2",
}
GOLDEN_VERSION = 1


def shapes() -> list[corpus.SchoolShape]:
    return [
        corpus.with_classes(corpus.BASE, 12, seed=1),
        corpus.with_classes(corpus.BASE, 12, seed=2),
        corpus.with_classes(corpus.PRODUCTION, 9, seed=1),
        replace(
            corpus.BASE, classes_per_year=4, group_subjects=6, half_groups=True, language_block=True,
            block_subjects=True, term_subjects=3, shared_teachers=3, seed=3,
        ),
        replace(corpus.BASE, classes_per_year=2, group_subjects=0, languages=0, seed=1),
    ]


def digests() -> dict[str, str]:
    out = {}
    for shape in shapes():
        request = corpus.build_week(shape).request
        blob = json.dumps(
            request.model_dump(mode="json", by_alias=True, exclude_none=True),
            sort_keys=True, separators=(",", ":"),
        )
        out[shape.name()] = hashlib.sha256(blob.encode()).hexdigest()
    return out


def test_a_shape_builds_the_week_it_built_when_the_version_was_set() -> None:
    assert corpus.CORPUS_VERSION == GOLDEN_VERSION, (
        "CORPUS_VERSION moved: write the digests of this version into GOLDEN, with the reason"
    )
    assert digests() == GOLDEN, "a shape builds another week: bump CORPUS_VERSION and rewrite GOLDEN"


def test_the_week_is_the_same_in_another_process_whatever_the_hash_seed_says() -> None:
    """A set of strings is walked in another order in every process unless PYTHONHASHSEED is set."""
    code = (
        "import importlib.util, json, sys;"
        f"spec = importlib.util.spec_from_file_location('pins', {str(Path(__file__).resolve())!r});"
        "module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module);"
        "print(json.dumps(module.digests()))"
    )
    seen = []
    for seed in ("1", "2", "31337"):
        done = subprocess.run(
            [sys.executable, "-c", code], capture_output=True, text=True, check=True,
            env={**__import__("os").environ, "PYTHONHASHSEED": seed},
        )
        seen.append(json.loads(done.stdout.strip().splitlines()[-1]))
    assert seen[0] == seen[1] == seen[2] == GOLDEN


def test_the_request_id_names_the_shape_and_the_version() -> None:
    shape = corpus.with_classes(corpus.BASE, 6, seed=4)
    request_id = corpus.build_week(shape).request.request_id
    assert str(request_id) == corpus._uid(f"request-{shape.name()}-v{corpus.CORPUS_VERSION}")
    assert str(request_id) != corpus._uid(f"request-{shape.name()}")
