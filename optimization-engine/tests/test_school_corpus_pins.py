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

#: sha256 of the request, as canonical JSON (sorted keys), for CORPUS_VERSION 2. Version 1's are in git history
#: (`139f71f2…`, `16795d8f…`, `82ba5a69…`, `cb3f9bd1…`, `52aefabd…`): ONLY THE REQUEST ID MOVED. The next test holds that.
GOLDEN = {
    "n12-g3-m0-s1": "a9cd73be052b49fb7824bde1fa43e119b26e379af5f9976aad9715e84f164750",
    "n12-g3-m0-s2": "813ee056585f0e8d6233280d03a14c4f916988f4fa7e6a3a3c6929d1d5b9c531",
    "n9-g10-m0-s1-t5-h": "279f6ee8f22cf8a7568ed0980414fb12c8a85be8ef5ebb7488a9fd9b64399e3a",
    "n12-g6-m3-s3-t3-b-h-k": "bc5ccecc9daa3e75a528c7d6c0231e56f058554f38ff662aa8da230a80ea40fd",
    "n6-g0-m0-s1": "16bf11bb99526fb63252da92dd3c08f25dabc4cc541ba1d7cadde6ba39e900ec",
}
GOLDEN_VERSION = 2

#: The content of every sweep week as version 1 built it, requestId left out: tests/data/school_corpus_v1_content.json.
V1_CONTENT = Path(__file__).resolve().parent / "data" / "school_corpus_v1_content.json"


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


def _content_digest(week: corpus.CorpusWeek) -> str:
    request = week.request.model_dump(mode="json", by_alias=True, exclude_none=True)
    request.pop("requestId")
    return hashlib.sha256(json.dumps(request, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def test_version_two_moved_only_the_request_id_of_every_week_of_version_one() -> None:
    """THE GATE'S ROWS HAVE NOT CHANGED MEANING (M8, PR 3). The version is in every requestId, so bumping it renames
    every week; this holds that nothing else of the 82 sweep weeks moved, the nightly gate's thirteen among them."""
    held = json.loads(V1_CONTENT.read_text())["sweep"]
    shapes = {shape.name(): shape for shape in corpus.sweep_shapes()}
    assert set(held) == set(shapes), "the sweep has other weeks than version 1 had: name the new ones in the cliff weeks, not here"
    moved = [name for name, digest in held.items() if _content_digest(corpus.build_week(shapes[name])) != digest]
    assert moved == [], f"these weeks build another week than they did in version 1: {moved}"
    gate = {shape.name() for shape in corpus.gate_shapes()}
    cliff = {shape.name() for shape in corpus.cliff_shapes()}
    # The gate's weeks are the sweep's (held) or a cliff week the years' road lays (M8 PR 7): none is another week.
    assert gate <= set(held) | cliff
    assert gate & set(held), "most of the gate is the sweep's own weeks, whose digests are held above"


def test_a_day_that_ends_otherwise_than_at_sixteen_is_another_week_with_another_name() -> None:
    shape = corpus.with_classes(corpus.BASE, 9, group_subjects=6, seed=1)
    later = replace(shape, day=(shape.day[0], "16:30:00", shape.day[2]))
    assert shape.name() == "n9-g6-m0-s1"
    assert later.name() == "n9-g6-m0-s1-e1630"
    assert corpus.build_week(shape).request.request_id != corpus.build_week(later).request.request_id
    other = corpus.build_week(later).request
    assert {str(frame.end_time) for frame in other.frame_times} == {"16:30:00"}

