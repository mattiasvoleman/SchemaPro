"""Lärarval: POST /api/v1/week-bounds and SchedulerSolver.week_bounds.

WHY THERE IS A ROUTE FOR THIS AT ALL. A search for the choice of teachers that
eases the week ranks weeks, and /check-week cannot rank two weeks that are both
over the supply (test_week_check_choice: it stops at the first period it refuses,
so an over figure is "the first refused period's", and relieving the autumn makes
the answer RISE from the autumn's 107 % to the spring's 144 %). This route counts
every real week of the year to the end and says, for each figure, whether it is
exact.

WHAT THESE TESTS HOLD:

* THE TWO FIGURES /check-week CANNOT GIVE: the autumn and the spring of a week
  that is over the supply in both, each its own, and the autumn's relief changing
  the autumn's figure and not the spring's;
* A FIGURE SAYS WHETHER IT IS EXACT: a pricing step CP-SAT did not finish proving
  makes it `converged: false`; a cutoff stops a count and says so; the seconds
  stop it and say so; and a threshold count (what /check-week and Generera ask)
  is what it always was;
* NOTHING IS REFUSED BUT BY THE QUICK COUNTS: a week over the supply is a figure,
  and a week a count refuses has `refusal` and no figures;
* THE ROUTE: key, validation, the gate (429), the ceiling (503), the exact names,
  and that the OpenAPI document gains one route and its schemas and changes nothing else.
"""

from __future__ import annotations

import asyncio
import copy
import time
from typing import Any

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient
from ortools.sat.python import cp_model

from app.main import create_app
from app.schemas.schedule import OptimizeScheduleRequest
from app.schemas.week_bounds import WeekBoundsResponse
from app.solver import week_load
from app.solver.scheduler_solver import SchedulerSolver
from tests import test_optimize as to
from tests import test_week_check as wc
from tests import test_week_check_choice as wcc
from tests import test_week_load as wl

HEADERS = {"X-API-Key": to.API_KEY}
URL = "/api/v1/week-bounds"

RESPONSE_KEYS = {"requestId", "weeksTotal", "weeksCounted", "rows", "refusal", "deadlineHit", "elapsedMs"}
ROW_KEYS = {"year", "period", "parity", "demandMinutes", "capacityMinutes", "over", "converged", "cutoff"}
REQUEST_EXTRA_KEYS = {"years", "cutoffs", "seconds"}


@pytest.fixture(scope="module")
def cases() -> dict[str, Any]:
    import json

    return json.loads(wcc.FIXTURE.read_text())


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(to._settings()))


def _bounds(client: TestClient, payload: dict[str, Any], **extra: Any) -> dict[str, Any]:
    response = client.post(URL, json={**payload, **extra}, headers=HEADERS)
    assert response.status_code == 200, response.text
    return response.json()


def _figure(answer: dict[str, Any], year: int, period: int | None) -> dict[str, Any]:
    (row,) = [r for r in answer["rows"] if r["year"] == year and r["period"] == period]
    return row


def _solver(**overrides: object) -> SchedulerSolver:
    return SchedulerSolver(wl._settings(**overrides))


def _request(payload: dict[str, Any]) -> OptimizeScheduleRequest:
    return OptimizeScheduleRequest.model_validate(payload)


# ---------------------------------------------------------------------------
# What /check-week cannot give
# ---------------------------------------------------------------------------


def test_a_week_over_the_supply_in_both_periods_gives_each_periods_own_figure(
    client: TestClient, cases: dict[str, Any],
) -> None:
    """107 % in the autumn and 144 % in the spring: /check-week says the first, this says both, each exact."""
    today = wcc._autumn_over_and_spring_more(cases)

    answer = _bounds(client, today)

    autumn = _figure(answer, 9, 0)
    spring = _figure(answer, 9, 1)
    assert (autumn["demandMinutes"], autumn["capacityMinutes"], autumn["over"]) == (2370, 2200, True)
    assert (spring["demandMinutes"], spring["capacityMinutes"], spring["over"]) == (3180, 2200, True)
    assert autumn["converged"] and spring["converged"]
    assert not autumn["cutoff"] and not spring["cutoff"]
    assert answer["refusal"] is None
    assert answer["weeksTotal"] == answer["weeksCounted"] == 2
    assert answer["deadlineHit"] is False


def test_relieving_the_autumn_changes_the_autumn_and_not_the_spring(
    client: TestClient, cases: dict[str, Any],
) -> None:
    """The case /check-week answers with a RISE (107 % -> 144 %): here the autumn falls and the spring stays."""
    today = wcc._autumn_over_and_spring_more(cases)
    relieved = wcc._teacher_of_their_own(today, [True, False])

    before = _bounds(client, today)
    after = _bounds(client, relieved)

    assert _figure(after, 9, 0)["demandMinutes"] < _figure(before, 9, 0)["demandMinutes"]
    assert _figure(after, 9, 1) == _figure(before, 9, 1)
    assert all(row["converged"] for row in after["rows"])


def test_a_week_the_weeks_load_would_refuse_is_a_figure_here(client: TestClient) -> None:
    """29 x 55 + 540 + 75 = 2,210 > 2,200: refused by /check-week, a number (over) here, and no refusal."""
    answer = _bounds(client, wl._year(class_lessons=29))

    (row,) = answer["rows"]
    assert (row["year"], row["demandMinutes"], row["capacityMinutes"], row["over"]) == (8, 2210, wl.WEEK, True)
    assert row["converged"] is True
    assert answer["refusal"] is None


def test_the_figure_of_a_week_under_the_supply_is_the_value_the_decision_count_stops_short_of(
    client: TestClient,
) -> None:
    """The decision count stops once a year is decided; the exact count is the value, and is not below it."""
    payload = wl._year(class_lessons=27)

    exact = _figure(_bounds(client, payload), 8, None)
    (decided,) = _solver().check_week(_request(payload)).years

    assert exact["converged"]
    assert exact["demandMinutes"] >= decided.demand_minutes
    assert exact["demandMinutes"] <= exact["capacityMinutes"]


# ---------------------------------------------------------------------------
# What is asked, and what a figure says of itself
# ---------------------------------------------------------------------------


def test_only_the_years_asked_for_are_counted(client: TestClient, cases: dict[str, Any]) -> None:
    today = wcc._autumn_over_and_spring_more(cases)

    assert [r["year"] for r in _bounds(client, today, years=[9])["rows"]] == [9, 9]
    assert _bounds(client, today, years=[7])["rows"] == []


def test_a_cutoff_stops_a_year_and_says_the_figure_is_only_above_it(
    client: TestClient, cases: dict[str, Any],
) -> None:
    """A bound already above the cutoff is "worse than that": it rejects a candidate and ranks nobody."""
    today = wcc._autumn_over_and_spring_more(cases)

    stopped = _bounds(client, today, cutoffs=[{"year": 9, "demandMinutes": 1500, "capacityMinutes": 2200}])
    roomy = _bounds(client, today, cutoffs=[{"year": 9, "demandMinutes": 100_000, "capacityMinutes": 2200}])

    for row in stopped["rows"]:
        assert row["cutoff"] is True and row["converged"] is False
        # Above the share it was given, whatever the bound it stopped at.
        assert row["demandMinutes"] * 2200 > 1500 * row["capacityMinutes"]
    for row, exact in zip(roomy["rows"], _bounds(client, today)["rows"], strict=True):
        assert row["cutoff"] is False and row["converged"] is True
        assert row == exact


def test_a_cutoff_of_another_year_changes_nothing(client: TestClient, cases: dict[str, Any]) -> None:
    today = wcc._autumn_over_and_spring_more(cases)

    other = [{"year": 3, "demandMinutes": 10, "capacityMinutes": 2200}]
    assert _bounds(client, today, cutoffs=other)["rows"] == _bounds(client, today)["rows"]


def test_a_cutoff_is_a_share_of_the_weeks_supply_not_a_number_of_minutes(client: TestClient, cases: dict[str, Any]) -> None:
    """The autumn is 2,370 of 2,200 (107.7 %) and the spring 3,180 of 2,200: a cutoff at exactly the autumn's share
    leaves the autumn's figure (it is not above it) and stops the spring's."""
    today = wcc._autumn_over_and_spring_more(cases)

    answer = _bounds(client, today, cutoffs=[{"year": 9, "demandMinutes": 2370, "capacityMinutes": 2200}])

    autumn, spring = _figure(answer, 9, 0), _figure(answer, 9, 1)
    assert (autumn["cutoff"], autumn["converged"], autumn["demandMinutes"]) == (False, True, 2370)
    assert (spring["cutoff"], spring["converged"]) == (True, False)


def _five_cycle() -> week_load._Graph:
    """Five nodes in a ring, weight one: the clique bound is 2, a greedy cover costs 3, the value is 5/2."""
    adjacency = [(1 << ((node + 1) % 5)) | (1 << ((node - 1) % 5)) for node in range(5)]
    return week_load._Graph(
        ids=list(range(5)), weights=[1] * 5, adjacency=adjacency, cliques=week_load._clique_cover(adjacency),
    )


def _cover(proof: week_load._Proof) -> week_load._Bound:
    return week_load._fractional_cover(
        _five_cycle(), stop_at_or_below=-1.0, stop_above=float("inf"), deadline=time.monotonic() + 30,
        pricing_seconds=5.0, proof=proof,
    )


def test_a_pricing_step_cp_sat_finishes_proving_leaves_the_count_exact() -> None:
    proof = week_load._Proof()

    bound = _cover(proof)

    assert bound.converged and proof.unproven == 0
    assert abs(float(bound.lower) - 2.5) < 1e-3


def test_a_pricing_step_cp_sat_did_not_finish_proving_is_counted(monkeypatch: pytest.MonkeyPatch) -> None:
    """Under load CP-SAT runs out of its seconds: the heaviest set is then an upper bound, not the maximum.

    The decision count does not notice (a bound it holds is a bound whatever its pricing was, and it
    decides nothing else); an exact count, which ranks, must say so.
    """
    class Unproving(cp_model.CpSolver):  # type: ignore[misc]
        def Solve(self, model: Any, *args: Any) -> Any:  # noqa: N802
            super().Solve(model, *args)
            return cp_model.FEASIBLE

    monkeypatch.setattr(week_load.cp_model, "CpSolver", Unproving)
    proof = week_load._Proof()

    _cover(proof)

    assert proof.unproven > 0


def test_a_year_whose_pricing_was_not_proved_is_not_exact_and_one_that_was_is(monkeypatch: pytest.MonkeyPatch) -> None:
    """The count of one year carries the proof counter up to the figure the caller reads."""
    request = _request(wl._year(class_lessons=27))
    real = week_load._stage_bound

    def unproven(*args: Any, **kwargs: Any) -> Any:
        kwargs["proof"].unproven += 1
        return real(*args, **kwargs)

    exact = _solver().week_bounds(request, years=None, cutoffs={}, seconds=20.0)
    decided = _solver()._week_loads(request)
    monkeypatch.setattr(week_load, "_stage_bound", unproven)
    inexact = _solver().week_bounds(request, years=None, cutoffs={}, seconds=20.0)

    assert [row.converged for row in exact.rows] == [True]
    assert [row.converged for row in inexact.rows] == [False]
    # The figure is the same: what changes is what it may be used for.
    assert [row.demand_minutes for row in inexact.rows] == [row.demand_minutes for row in exact.rows]
    # The decision count passes no proof, so nothing in it can say it.
    assert [load.converged for load in decided] == [True]


def test_the_deadline_leaves_a_year_without_a_row_and_says_so() -> None:
    request = _request(wl._year(class_lessons=27))

    answer = _solver().week_bounds(request, years=None, cutoffs={}, seconds=1e-9)

    assert answer.rows == []
    assert answer.deadline_hit is True


def test_more_weeks_than_the_cap_are_counted_to_the_cap_and_say_so(
    monkeypatch: pytest.MonkeyPatch, cases: dict[str, Any],
) -> None:
    """A figure of fewer weeks than exist ranks nothing: the caller compares the two numbers."""
    monkeypatch.setattr(SchedulerSolver, "MAX_BOUNDS_WEEKS", 1)

    answer = _solver().week_bounds(_request(wcc._autumn_over_and_spring_more(cases)), years=None, cutoffs={}, seconds=20.0)

    assert (answer.weeks_total, answer.weeks_counted) == (2, 1)
    assert len(answer.rows) == 1


def test_a_week_the_quick_counts_refuse_has_no_figures_and_names_the_count() -> None:
    payload, settings = wc._full_hall()
    request = _request(payload)
    config = to._settings(**settings)

    answer = SchedulerSolver(config).week_bounds(request, years=None, cutoffs={}, seconds=20.0)
    refused = SchedulerSolver(config).check_week(request)

    assert answer.rows == []
    assert answer.refusal is not None
    assert refused.conflicts is not None
    assert answer.refusal.code == refused.conflicts.summary_code
    assert answer.refusal.params == refused.conflicts.summary_params


def test_nothing_is_solved_and_no_model_is_built(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("the scheduling model must not be built")

    monkeypatch.setattr(SchedulerSolver, "_build_model", forbidden)
    monkeypatch.setattr(SchedulerSolver, "_solve_guarded", forbidden, raising=False)

    answer = _solver().week_bounds(_request(wl._year(class_lessons=27)), years=None, cutoffs={}, seconds=20.0)

    assert answer.rows


def test_two_counts_of_one_payload_give_one_answer(client: TestClient, cases: dict[str, Any]) -> None:
    """The figures a search compares are not noise."""
    today = wcc._autumn_over_and_spring_more(cases)

    first = _bounds(client, copy.deepcopy(today))
    second = _bounds(client, copy.deepcopy(today))

    assert first["rows"] == second["rows"]


# ---------------------------------------------------------------------------
# The threshold count is what it was
# ---------------------------------------------------------------------------


def test_the_threshold_count_gives_the_rows_it_always_gave() -> None:
    """Generera's and /check-week's own count: no `exact`, so nothing in it reads the new keyword."""
    request = _request(wl._year(class_lessons=27))

    loads = _solver()._week_loads(request)

    assert [(load.year, load.over, load.converged, load.cutoff) for load in loads] == [(8, False, True, False)]


# ---------------------------------------------------------------------------
# The route
# ---------------------------------------------------------------------------


def test_the_route_answers_with_exactly_the_published_names(client: TestClient) -> None:
    body = _bounds(client, wl._year(class_lessons=27))

    assert set(body) == RESPONSE_KEYS
    assert set(body["rows"][0]) == ROW_KEYS
    assert body["elapsedMs"] >= 0


def test_the_route_wants_the_service_key(client: TestClient) -> None:
    payload = wl._year(class_lessons=20, shared=False)

    assert client.post(URL, json=payload).status_code == 401
    assert client.post(URL, json=payload, headers={"X-API-Key": "wrong"}).status_code == 401


def test_the_route_refuses_a_field_it_does_not_know_and_a_bad_second_count(client: TestClient) -> None:
    payload = wl._year(class_lessons=20, shared=False)

    assert client.post(URL, json={**payload, "somethingNew": 1}, headers=HEADERS).status_code == 422
    assert client.post(URL, json={**payload, "seconds": 0}, headers=HEADERS).status_code == 422
    assert client.post(URL, json={**payload, "seconds": 31}, headers=HEADERS).status_code == 422
    assert client.post(URL, json={**payload, "cutoffs": [{"year": 9}]}, headers=HEADERS).status_code == 422
    assert client.post(URL, json={**payload, "cutoffs": [{"year": 9, "demandMinutes": 1, "capacityMinutes": 0}]}, headers=HEADERS).status_code == 422


def test_a_refusal_of_the_payload_is_the_400_generera_gives(client: TestClient) -> None:
    payload = to._dining_payload([30])
    payload["rules"] = to._lunch_rules(diningSeats=20)

    bounds = client.post(URL, json=payload, headers=HEADERS)
    run = client.post("/api/v1/optimize", json=payload, headers=HEADERS)

    assert bounds.status_code == run.status_code == 400
    assert bounds.json() == run.json()


def test_a_second_count_while_the_gate_is_held_is_answered_429(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """A search asks for hundreds: beyond the gate the caller backs off instead of queueing a connection."""
    app = client.app
    app.state.week_bounds_gate = asyncio.Semaphore(1)

    async def hold() -> None:
        await app.state.week_bounds_gate.acquire()

    asyncio.new_event_loop().run_until_complete(hold())
    response = client.post(URL, json=wl._year(class_lessons=20, shared=False), headers=HEADERS)

    assert response.status_code == 429
    assert "busy" in response.json()["message"]


def test_counts_one_after_the_other_all_get_through(client: TestClient) -> None:
    payload = wl._year(class_lessons=20, shared=False)

    # The gate is released when a count ends.
    assert client.post(URL, json=payload, headers=HEADERS).status_code == 200
    assert client.post(URL, json=payload, headers=HEADERS).status_code == 200


def test_the_route_never_runs_more_than_one_count_at_once_whatever_the_deployment_says(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """THE ENGINE IS SHARED BY EVERY SCHOOL, AND PRODUCTION HAS ONE REPLICA. A search asks for hundreds of counts; the route
    takes one worker at a time however many callers ask and whatever an environment variable of an older deployment says
    (WEEK_BOUNDS_CONCURRENCY, which is no longer a setting): the others are answered 429 at once, never queued, so a Generera
    run or a week check is never behind them."""
    import httpx

    monkeypatch.setenv("WEEK_BOUNDS_CONCURRENCY", "8")
    running = 0
    most = 0

    def slow(self: SchedulerSolver, request: Any, **kwargs: Any) -> Any:
        nonlocal running, most
        running += 1
        most = max(most, running)
        time.sleep(0.3)
        running -= 1
        return WeekBoundsResponse(
            requestId=request.request_id, weeksTotal=0, weeksCounted=0, rows=[], refusal=None, deadlineHit=False, elapsedMs=0,
        )

    monkeypatch.setattr(SchedulerSolver, "week_bounds", slow)
    payload = wl._year(class_lessons=20, shared=False)

    async def ask() -> list[int]:
        transport = httpx.ASGITransport(app=create_app(to._settings()))
        async with httpx.AsyncClient(transport=transport, base_url="http://engine") as http:
            answers = await asyncio.gather(*[http.post(URL, json=payload, headers=HEADERS) for _ in range(4)])
        return sorted(answer.status_code for answer in answers)

    statuses = asyncio.run(ask())

    assert most == 1
    assert statuses == [200, 429, 429, 429]


def test_a_count_that_is_not_done_by_the_ceiling_is_answered_503(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.api.v1 import week_bounds

    monkeypatch.setattr(week_bounds, "_BUILD_HEADROOM_SECONDS", 0.05)
    monkeypatch.setattr(SchedulerSolver, "week_bounds", lambda self, request, **kwargs: time.sleep(0.5))

    response = client.post(URL, json={**wl._year(class_lessons=20, shared=False), "seconds": 0.05}, headers=HEADERS)

    assert response.status_code == 503
    assert response.json()["message"] == "Week count timed out."


def test_a_request_id_is_echoed(client: TestClient) -> None:
    payload = wl._year(class_lessons=20, shared=False)

    assert _bounds(client, payload)["requestId"] == payload["requestId"]


def test_the_openapi_document_gains_a_route_and_schemas_and_changes_nothing_else(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Deployed with the API from one merge, so an older gateway reads every other route and schema as before.

    The baseline is an app with this router swapped for an empty one. A class named like one that exists would
    rename BOTH in the document (`app__schemas__rooms__PlacedLesson`), which is why every key of the baseline
    must be equal, not merely present.
    """
    from app import main as main_module

    with_route = create_app(to._settings()).openapi()
    monkeypatch.setattr(main_module, "week_bounds_router", APIRouter())
    without = create_app(to._settings()).openapi()

    assert set(with_route["paths"]) == set(without["paths"]) | {URL}
    for path, item in without["paths"].items():
        assert with_route["paths"][path] == item, path
    assert set(with_route["paths"][URL]) == {"post"}
    for name, schema in without["components"]["schemas"].items():
        assert with_route["components"]["schemas"][name] == schema, name
    added = set(with_route["components"]["schemas"]) - set(without["components"]["schemas"])
    assert added == {
        "WeekBoundsRequest", "WeekBoundsResponse", "WeekBoundsRow", "WeekBoundsCutoff", "WeekBoundsRefusal",
    }, added
    assert not [name for name in with_route["components"]["schemas"] if "__" in name]

    schemas = with_route["components"]["schemas"]
    assert set(schemas["WeekBoundsResponse"]["properties"]) == RESPONSE_KEYS
    assert set(schemas["WeekBoundsRow"]["properties"]) == ROW_KEYS
    base = set(schemas["OptimizeScheduleRequest"]["properties"])
    assert set(schemas["WeekBoundsRequest"]["properties"]) == base | REQUEST_EXTRA_KEYS
    assert with_route["paths"][URL]["post"]["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/WeekBoundsRequest",
    }
