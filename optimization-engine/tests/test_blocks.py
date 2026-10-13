"""Parallella block: requirements the school runs at the same times.

Språkval åk 7 is Tyska for Ty7 and Franska for Fr7, two teaching groups cut
across class 7A. 7A shares pupils with both, so each language keeps 7A out of
whatever slot it takes; as a block the two take one slot of 7A's week per
lesson. The gateway sends the block as a blockId on each member.

A FIVE-HOUR DAY on the default five-day week, as in the distribution tests:
short enough that each case is arithmetic, long enough that a lesson always
has somewhere to go unless the case says otherwise.
"""

from __future__ import annotations

import sys
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from ortools.sat.python import cp_model

from app.config import Settings
from app.exceptions import InvalidScheduleInputError
from app.messages import render
from app.schemas.schedule import (
    ConflictAnalysis,
    ConflictDetail,
    OptimizeScheduleRequest,
    PreviousLesson,
    ScheduledLesson,
)
from app.solver import scheduler_solver
from app.solver.scheduler_solver import SchedulerSolver, _blocks_of

#: 08:00-13:00, Monday to Friday.
SHORT_WEEK = {"SCHEDULE_DAY_END_MINUTES": 780}

BLOCK = str(uuid4())
CLASS_7A = str(uuid4())
TY7 = str(uuid4())
FR7 = str(uuid4())
TYSKA = str(uuid4())
FRANSKA = str(uuid4())
SVENSKA = str(uuid4())
TEACHER_TY = str(uuid4())
TEACHER_FR = str(uuid4())
TEACHER_SV = str(uuid4())


def _settings(**overrides: object) -> Settings:
    return Settings(SOLVER_MAX_TIME_SECONDS=10.0, **{**SHORT_WEEK, **overrides})  # type: ignore[arg-type]


def _member(
    requirement_id: str, group: str, teacher: str, **values: object,
) -> dict[str, object]:
    row: dict[str, object] = {
        "id": requirement_id,
        "subjectId": str(uuid4()),
        "studentGroupId": group,
        "teacherId": teacher,
        "lessonsPerWeek": 2,
        "minutesPerLesson": 60,
        "studentGroupSize": 20,
        "blockId": BLOCK,
    }
    row.update(values)
    return row


def _payload(
    *,
    tyska: dict[str, object] | None = None,
    franska: dict[str, object] | None = None,
    svenska: dict[str, object] | None = None,
    conflicts: list[list[str]] | None = None,
    **extra: object,
) -> dict[str, object]:
    """7A with svenska; Ty7 and Fr7 in one block; both cut from 7A."""
    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": [
            {
                "id": SVENSKA,
                "subjectId": str(uuid4()),
                "studentGroupId": CLASS_7A,
                "teacherId": TEACHER_SV,
                "lessonsPerWeek": 3,
                "minutesPerLesson": 60,
                "studentGroupSize": 25,
                **(svenska or {}),
            },
            _member(TYSKA, TY7, TEACHER_TY, **(tyska or {})),
            _member(FRANSKA, FR7, TEACHER_FR, **(franska or {})),
        ],
        "groups": [{"id": CLASS_7A, "lunchHeadcount": 25}],
        "rooms": [{"id": str(uuid4()), "capacity": 30} for _ in range(3)],
        "groupConflicts": conflicts if conflicts is not None else [[CLASS_7A, TY7], [CLASS_7A, FR7]],
        **extra,
    }


def _request(payload: dict[str, object]) -> OptimizeScheduleRequest:
    return OptimizeScheduleRequest.model_validate(payload)


def _refusal(payload: dict[str, object], **settings: object) -> InvalidScheduleInputError | None:
    try:
        SchedulerSolver(_settings(**settings))._validate_request(_request(payload))
    except InvalidScheduleInputError as error:
        return error
    return None


def _shape(payload: dict[str, object]) -> tuple[list[str], int]:
    solver = SchedulerSolver(_settings())
    model, *_ = solver._build_model(_request(payload), use_assumptions=False, include_objective=True)
    proto = model.Proto()
    return [variable.name for variable in proto.variables], len(proto.constraints)


def _validate(payload: dict[str, object], lessons: list[ScheduledLesson]) -> list[str]:
    benchmarks = Path(__file__).resolve().parents[1] / "benchmarks"
    if str(benchmarks) not in sys.path:
        sys.path.insert(0, str(benchmarks))
    from validate_schedule import validate

    return validate(SchedulerSolver(_settings())._grid, _request(payload), lessons)


def _times(lessons: list[ScheduledLesson], requirement_id: str) -> list[tuple[int, str, str]]:
    return sorted(
        (lesson.day_of_week, lesson.start_time, lesson.end_time)
        for lesson in lessons
        if lesson.requirement_id == UUID(requirement_id)
    )


def _closure(teacher: str, day_of_week: int) -> dict[str, object]:
    """The teacher away the whole of a weekday."""
    return {
        "id": str(uuid4()),
        "resourceKind": "TEACHER",
        "resourceId": teacher,
        "dayOfWeek": day_of_week,
        "date": None,
        "startTime": "08:00:00",
        "endTime": "13:00:00",
        "kind": "UNAVAILABLE",
    }


def _solve_pinned(
    payload: dict[str, object], pins: dict[tuple[str, int], int], *, literal: int | None,
) -> str:
    """Pin the start of chosen lessons, the block's literal to `literal`, and solve once."""
    solver = SchedulerSolver(_settings())
    model, registry, decisions, _plan, _lunches = solver._build_model(
        _request(payload), use_assumptions=True, include_objective=False,
    )
    model.ClearAssumptions()
    for record in registry._records:
        value = 1 if record.code != "BLOCK_CANNOT_BE_PLACED" or literal is None else literal
        model.Add(record.literal == value)
    for decision in decisions:
        key = (str(decision.lesson.requirement.id), decision.lesson.lesson_index)
        if key in pins:
            model.Add(decision.start == pins[key])
    cp = cp_model.CpSolver()
    cp.parameters.num_workers = 1
    cp.parameters.max_time_in_seconds = 10.0
    status = cp.StatusName(cp.Solve(model))
    assert status in {"OPTIMAL", "FEASIBLE", "INFEASIBLE"}, status
    return "INFEASIBLE" if status == "INFEASIBLE" else "FEASIBLE"


class TestTheField:
    def test_absent_means_no_block(self) -> None:
        payload = _payload()
        for row in payload["requirements"]:  # type: ignore[union-attr]
            row.pop("blockId", None)
        request = _request(payload)

        assert all(requirement.block_id is None for requirement in request.requirements)
        assert _blocks_of(request.requirements) == {}

    def test_a_payload_without_blocks_builds_the_model_it_always_built(self) -> None:
        bare = _payload()
        for row in bare["requirements"]:  # type: ignore[union-attr]
            row.pop("blockId", None)
        explicit = _payload(tyska={"blockId": None}, franska={"blockId": None})

        assert _shape(explicit) == _shape(bare)

    def test_a_block_of_one_is_no_block_and_builds_nothing(self) -> None:
        bare = _payload()
        for row in bare["requirements"]:  # type: ignore[union-attr]
            row.pop("blockId", None)
        alone = _payload(franska={"blockId": None})

        assert _blocks_of(_request(alone).requirements) == {}
        assert _shape(alone) == _shape(bare)
        assert _refusal(_payload(franska={"blockId": None, "teacherId": TEACHER_TY})) is None

    def test_a_block_adds_one_literal_and_no_other_variable(self) -> None:
        bare = _payload()
        for row in bare["requirements"]:  # type: ignore[union-attr]
            row.pop("blockId", None)
        names, _constraints = _shape(_payload())
        bare_names, _ = _shape(bare)

        assert [name for name in names if name not in bare_names] == [f"block_{BLOCK}"]


class TestTheModel:
    def test_the_members_land_at_the_same_times_and_validate(self) -> None:
        payload = _payload()
        response = SchedulerSolver(_settings()).solve(_request(payload))

        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert len(_times(response.lessons, TYSKA)) == 2
        assert _times(response.lessons, TYSKA) == _times(response.lessons, FRANSKA)
        assert _validate(payload, response.lessons) == []

    def test_the_block_takes_one_slot_of_the_class_per_lesson(self) -> None:
        response = SchedulerSolver(_settings()).solve(_request(_payload()))
        slots = {
            (lesson.day_of_week, lesson.start_time)
            for lesson in response.lessons
            if lesson.requirement_id in {UUID(TYSKA), UUID(FRANSKA)}
        }

        assert len(slots) == 2

    def test_the_equality_hangs_on_the_block_s_literal_and_on_nothing_else(self) -> None:
        apart = {(TYSKA, 0): 0, (FRANSKA, 0): 12}  # Monday 08:00 and 09:00

        assert _solve_pinned(_payload(), apart, literal=1) == "INFEASIBLE"
        assert _solve_pinned(_payload(), apart, literal=0) == "FEASIBLE"

    def test_the_k_th_lesson_is_held_to_the_k_th(self) -> None:
        crossed = {(TYSKA, 0): 0, (TYSKA, 1): 60, (FRANSKA, 0): 60, (FRANSKA, 1): 0}

        assert _solve_pinned(_payload(), crossed, literal=1) == "INFEASIBLE"
        assert _solve_pinned(
            _payload(), {(TYSKA, 0): 0, (TYSKA, 1): 60, (FRANSKA, 0): 0, (FRANSKA, 1): 60},
            literal=1,
        ) == "FEASIBLE"

    def test_every_member_starts_on_the_block_s_common_starts(self) -> None:
        """Frames per year: åk 7 08:00-11:00, åk 8 09:00-13:00. A member of each
        may start only where both may, which is 09:00-10:00 for an hour."""
        payload = _payload(
            tyska={"minGradeLevel": 7, "maxGradeLevel": 7},
            franska={"minGradeLevel": 8, "maxGradeLevel": 8},
            frameTimes=[
                *({"minGradeLevel": 7, "maxGradeLevel": 7, "dayOfWeek": day,
                   "startTime": "08:00:00", "endTime": "11:00:00"} for day in range(1, 6)),
                *({"minGradeLevel": 8, "maxGradeLevel": 8, "dayOfWeek": day,
                   "startTime": "09:00:00", "endTime": "13:00:00"} for day in range(1, 6)),
            ],
        )
        solver = SchedulerSolver(_settings())
        request = _request(payload)
        model, _registry, decisions, _plan, _lunches = solver._build_model(
            request, use_assumptions=False, include_objective=False,
        )
        spd = solver._grid.slots_per_day
        variables = model.Proto().variables
        built = {
            str(decision.lesson.requirement.id): list(variables[decision.start.Index()].domain)
            for decision in decisions
        }
        lattice = scheduler_solver._start_lattice(
            scheduler_solver._start_step(request, solver._grid), solver._grid.horizon,
        )
        own = {
            str(requirement.id): solver._start_domains(
                requirement, request.frame_times, request.rasts, lattice,
            )[12]
            for requirement in request.requirements
            if requirement.block_id is not None
        }
        common = own[TYSKA].intersection_with(own[FRANSKA])

        assert built[TYSKA] == built[FRANSKA] == common.flattened_intervals()
        assert own[TYSKA].flattened_intervals() != common.flattened_intervals()
        assert own[FRANSKA].flattened_intervals() != common.flattened_intervals()
        # 09:00 to 10:00 on every day, whatever the step keeps of it.
        assert all(
            12 <= value % spd <= 24 for value in common.flattened_intervals()
        )

    def test_split_lengths_start_together_length_by_length(self) -> None:
        payload = _payload(
            tyska={"minutesPerLesson": 80, "lessonLengths": [80, 40]},
            franska={"minutesPerLesson": 80, "lessonLengths": [40, 80]},
        )
        response = SchedulerSolver(_settings()).solve(_request(payload))

        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert _times(response.lessons, TYSKA) == _times(response.lessons, FRANSKA)
        assert _validate(payload, response.lessons) == []


class TestTheRefusalsBeforeTheModel:
    @pytest.mark.parametrize(
        "franska",
        [
            {"lessonsPerWeek": 3},
            {"minutesPerLesson": 45},
            {"minutesPerLesson": 80, "lessonLengths": [80, 40]},
        ],
    )
    def test_members_with_other_lessons_are_refused(self, franska: dict[str, object]) -> None:
        error = _refusal(_payload(franska=franska))

        assert error is not None
        assert error.code == "BLOCK_MEMBERS_DIFFER"
        assert error.params == {"block": BLOCK, "requirement": FRANSKA, "other": TYSKA}

    @pytest.mark.parametrize(
        "franska",
        [{"teacherId": TEACHER_TY}, {"coTeacherId": TEACHER_TY}],
    )
    def test_a_teacher_in_two_members_is_refused(self, franska: dict[str, object]) -> None:
        error = _refusal(_payload(franska=franska))

        assert error is not None
        assert error.code == "BLOCK_MEMBERS_SHARE_TEACHER"
        assert error.params == {"block": BLOCK, "requirement": TYSKA, "other": FRANSKA}

    def test_a_co_teacher_in_one_and_a_lead_in_the_other_is_the_same_body(self) -> None:
        error = _refusal(_payload(tyska={"coTeacherId": TEACHER_FR}))

        assert error is not None and error.code == "BLOCK_MEMBERS_SHARE_TEACHER"

    def test_members_whose_groups_share_a_pupil_are_refused(self) -> None:
        """SvA beside class svenska, until Ersättande grupper decides."""
        error = _refusal(_payload(
            conflicts=[[CLASS_7A, TY7], [CLASS_7A, FR7], [FR7, TY7]],
        ))

        assert error is not None
        assert error.code == "BLOCK_MEMBERS_SHARE_PUPILS"
        assert error.params == {"block": BLOCK, "requirement": TYSKA, "other": FRANSKA}

    def test_two_members_on_one_group_share_every_pupil(self) -> None:
        error = _refusal(_payload(franska={"studentGroupId": TY7}))

        assert error is not None and error.code == "BLOCK_MEMBERS_SHARE_PUPILS"

    def test_groups_that_only_share_the_class_are_a_block(self) -> None:
        assert _refusal(_payload()) is None

    def test_frames_that_never_meet_are_refused_with_the_length(self) -> None:
        payload = _payload(
            tyska={"minGradeLevel": 7, "maxGradeLevel": 7},
            franska={"minGradeLevel": 8, "maxGradeLevel": 8},
            frameTimes=[
                *({"minGradeLevel": 7, "maxGradeLevel": 7, "dayOfWeek": day,
                   "startTime": "08:00:00", "endTime": "10:00:00"} for day in range(1, 6)),
                *({"minGradeLevel": 8, "maxGradeLevel": 8, "dayOfWeek": day,
                   "startTime": "10:00:00", "endTime": "13:00:00"} for day in range(1, 6)),
            ],
        )
        error = _refusal(payload)

        assert error is not None
        assert error.code == "BLOCK_NO_COMMON_START"
        assert error.params == {"block": BLOCK, "minutes": 60}

    def test_frames_that_meet_for_exactly_one_lesson_are_not_refused(self) -> None:
        payload = _payload(
            tyska={"minGradeLevel": 7, "maxGradeLevel": 7},
            franska={"minGradeLevel": 8, "maxGradeLevel": 8},
            frameTimes=[
                *({"minGradeLevel": 7, "maxGradeLevel": 7, "dayOfWeek": day,
                   "startTime": "08:00:00", "endTime": "11:00:00"} for day in range(1, 6)),
                *({"minGradeLevel": 8, "maxGradeLevel": 8, "dayOfWeek": day,
                   "startTime": "10:00:00", "endTime": "13:00:00"} for day in range(1, 6)),
            ],
        )

        assert _refusal(payload) is None

    def test_a_member_s_own_refusal_is_named_before_the_block_s(self) -> None:
        payload = _payload(franska={"minutesPerLesson": 65, "teacherId": TEACHER_TY})
        error = _refusal(payload, SLOT_MINUTES=15)

        assert error is not None and error.code == "INPUT_LESSON_LENGTH_OFF_GRID"

    def test_the_sentences_are_in_the_catalogue(self) -> None:
        for code in (
            "BLOCK_MEMBERS_DIFFER",
            "BLOCK_MEMBERS_SHARE_TEACHER",
            "BLOCK_MEMBERS_SHARE_PUPILS",
        ):
            assert "Ty7" in render(code, {"block": "Språkval", "requirement": "Ty7", "other": "Fr7"})
        assert "60" in render("BLOCK_NO_COMMON_START", {"block": "Språkval", "minutes": 60})


class TestWhatReachesTheSchool:
    @staticmethod
    def _apart() -> dict[str, object]:
        """Tyska's teacher is away Monday to Wednesday, Franska's Thursday and
        Friday: each member has days, the block has none."""
        return _payload(constraints=[
            *(_closure(TEACHER_TY, day) for day in (1, 2, 3)),
            *(_closure(TEACHER_FR, day) for day in (4, 5)),
        ])

    def test_a_block_with_no_common_hour_is_named_in_the_core(self) -> None:
        response = SchedulerSolver(_settings()).solve(_request(self._apart()))

        assert response.status == "INFEASIBLE"
        assert response.conflicts is not None
        # The core's own analysis, not the probe's: a core that names the
        # block is an explanation, and measuring again would only cost time.
        assert response.conflicts.summary_code == "CONFLICT_CORE_SUMMARY"
        blamed = [d for d in response.conflicts.conflicts if d.code == "BLOCK_CANNOT_BE_PLACED"]
        assert len(blamed) == 1
        assert blamed[0].category == "TEACHING_BLOCK"
        assert blamed[0].params == {"block": BLOCK}
        assert blamed[0].resource_ids == [UUID(BLOCK)]
        assert set(blamed[0].requirement_ids) == {UUID(TYSKA), UUID(FRANSKA)}

    def test_the_same_week_without_the_block_solves(self) -> None:
        payload = self._apart()
        for row in payload["requirements"]:  # type: ignore[union-attr]
            row.pop("blockId", None)

        assert SchedulerSolver(_settings()).solve(_request(payload)).status in {"OPTIMAL", "FEASIBLE"}

    def test_an_unexplained_refusal_with_blocks_is_measured_by_name(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(
            scheduler_solver, "build_conflict_analysis",
            lambda _solver, _registry: ConflictAnalysis(
                summary_code="CONFLICT_NO_CORE",
                conflicts=[ConflictDetail(category="INSUFFICIENT_RESOURCES", code="CONFLICT_NO_CORE_GUESS")],
            ),
        )
        response = SchedulerSolver(_settings(SOLVER_PROBE_SECONDS=5.0)).solve(_request(self._apart()))

        assert response.status == "INFEASIBLE"
        assert response.conflicts is not None
        assert response.conflicts.summary_code == "BLOCK_PROBE_SUMMARY"
        assert [(d.code, d.params) for d in response.conflicts.conflicts] == [
            ("BLOCK_CANNOT_BE_PLACED", {"block": BLOCK}),
        ]

    def test_without_a_probe_budget_the_unexplained_verdict_stands(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(
            scheduler_solver, "build_conflict_analysis",
            lambda _solver, _registry: ConflictAnalysis(summary_code="CONFLICT_NO_CORE", conflicts=[]),
        )
        response = SchedulerSolver(_settings(SOLVER_PROBE_SECONDS=0.0)).solve(_request(self._apart()))

        assert response.conflicts is not None
        assert response.conflicts.summary_code == "CONFLICT_NO_CORE"

    def test_a_week_impossible_without_its_blocks_is_not_blamed_on_them(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Svenska's teacher is away all week: the blocks are not why."""
        payload = _payload(constraints=[_closure(TEACHER_SV, day) for day in range(1, 6)])
        monkeypatch.setattr(
            scheduler_solver, "build_conflict_analysis",
            lambda _solver, _registry: ConflictAnalysis(summary_code="CONFLICT_NO_CORE", conflicts=[]),
        )
        response = SchedulerSolver(_settings(SOLVER_PROBE_SECONDS=5.0)).solve(_request(payload))

        assert response.status == "INFEASIBLE"
        assert response.conflicts is not None
        assert response.conflicts.summary_code == "CONFLICT_NO_CORE"


class TestTheWarmStart:
    @staticmethod
    def _previous(requirement_id: str, day_of_week: int, start: str) -> PreviousLesson:
        return PreviousLesson.model_validate({
            "requirementId": requirement_id, "dayOfWeek": day_of_week, "startTime": start,
        })

    def _hints(self, previous: list[PreviousLesson]) -> dict[tuple[str, int], int]:
        solver = SchedulerSolver(_settings())
        request = _request(_payload())
        _model, _registry, decisions, _plan, _lunches = solver._build_model(
            request, use_assumptions=False, include_objective=False,
        )
        return {
            (str(decision.lesson.requirement.id), decision.lesson.lesson_index): slot
            for decision, slot in solver._previous_hints(decisions, previous)
        }

    def test_a_block_is_hinted_from_one_list(self) -> None:
        hints = self._hints([
            self._previous(TYSKA, 3, "08:00:00"),
            self._previous(FRANSKA, 2, "09:00:00"),
            self._previous(TYSKA, 1, "08:00:00"),
        ])
        spd = SchedulerSolver(_settings())._grid.slots_per_day

        # Tyska had the most slots; Monday before Wednesday.
        assert hints[(TYSKA, 0)] == hints[(FRANSKA, 0)] == 0
        assert hints[(TYSKA, 1)] == hints[(FRANSKA, 1)] == 2 * spd

    def test_a_member_with_no_previous_lesson_takes_the_block_s(self) -> None:
        hints = self._hints([self._previous(TYSKA, 2, "10:00:00")])

        assert hints[(TYSKA, 0)] == hints[(FRANSKA, 0)]
        assert (TYSKA, 1) not in hints and (FRANSKA, 1) not in hints

    def test_a_requirement_in_no_block_is_paired_as_it_always_was(self) -> None:
        previous = [
            self._previous(SVENSKA, 5, "11:00:00"),
            self._previous(SVENSKA, 1, "09:00:00"),
            self._previous(SVENSKA, 3, "08:07:00"),  # off the grid: skipped
            self._previous(SVENSKA, 2, "08:00:00"),
            self._previous(SVENSKA, 4, "08:00:00"),  # a fourth: no instance left
        ]
        solver = SchedulerSolver(_settings())
        grid = solver._grid
        hints = self._hints(previous)

        assert [hints[(SVENSKA, index)] for index in range(3)] == [
            grid.absolute_start(5, grid.parse_hhmmss("11:00:00")),
            grid.absolute_start(1, grid.parse_hhmmss("09:00:00")),
            grid.absolute_start(2, grid.parse_hhmmss("08:00:00")),
        ]

    def test_both_builds_are_hinted_alike(self) -> None:
        previous = [
            self._previous(TYSKA, 3, "08:00:00"),
            self._previous(FRANSKA, 2, "09:00:00"),
            self._previous(SVENSKA, 1, "10:00:00"),
        ]
        payload = _payload(
            previousLessons=[p.model_dump(by_alias=True) for p in previous],
            weights={"disruption": 5},
        )
        solver = SchedulerSolver(_settings())
        full, *_ = solver._build_model(_request(payload), use_assumptions=False)
        feas, _registry, decisions, _plan, _lunches = solver._build_model(
            _request(payload), use_assumptions=False, include_objective=False,
        )
        solver._hint_previous_lessons(feas, decisions, _request(payload).previous_lessons)

        def named(model: cp_model.CpModel) -> list[tuple[str, int]]:
            proto = model.Proto()
            return [
                (proto.variables[var].name, value)
                for var, value in zip(proto.solution_hint.vars, proto.solution_hint.values)
            ]

        assert named(full) == named(feas)


class TestTheTimeoutProbe:
    def test_the_blocks_are_probed_and_the_requirements_stay(self) -> None:
        request = _request(_payload())
        relaxations = dict(SchedulerSolver(_settings())._timeout_relaxations(request))

        assert "PROBE_SOLVED_WITHOUT_BLOCKS" in relaxations
        relaxed = relaxations["PROBE_SOLVED_WITHOUT_BLOCKS"]
        assert [r.block_id for r in relaxed.requirements] == [None, None, None]
        assert [r.model_copy(update={"block_id": None}) for r in request.requirements] == list(
            relaxed.requirements,
        )

    def test_a_week_without_a_block_is_not_probed_for_one(self) -> None:
        codes = [
            code for code, _relaxed in SchedulerSolver(_settings())._timeout_relaxations(
                _request(_payload(franska={"blockId": None})),
            )
        ]

        assert "PROBE_SOLVED_WITHOUT_BLOCKS" not in codes

    def test_the_diagnosis_counts_the_blocks(self) -> None:
        solver = SchedulerSolver(_settings())

        assert "blocks=1," in solver._timeout_diagnosis(_request(_payload()), "test")
        assert "blocks=0," in solver._timeout_diagnosis(
            _request(_payload(franska={"blockId": None})), "test",
        )


def test_the_estimate_still_bounds_the_model_it_predicts() -> None:
    solver = SchedulerSolver(_settings())
    for payload in (
        _payload(),
        _payload(
            tyska={"minutesPerLesson": 80, "lessonLengths": [80, 40]},
            franska={"minutesPerLesson": 80, "lessonLengths": [80, 40]},
        ),
    ):
        request = _request(payload)
        model, *_ = solver._build_model(request, use_assumptions=False)
        assert solver._estimate_model_size(request) >= len(model.Proto().variables)


class TestTheIndependentCheck:
    @staticmethod
    def _lesson(requirement_id: str, day_of_week: int, start: str, end: str) -> ScheduledLesson:
        return ScheduledLesson.model_validate({
            "requirementId": requirement_id, "roomId": None,
            "dayOfWeek": day_of_week, "startTime": start, "endTime": end,
        })

    def _week(self, franska_second: tuple[int, str, str]) -> list[ScheduledLesson]:
        return [
            self._lesson(SVENSKA, 1, "10:00:00", "11:00:00"),
            self._lesson(SVENSKA, 2, "10:00:00", "11:00:00"),
            self._lesson(SVENSKA, 3, "10:00:00", "11:00:00"),
            self._lesson(TYSKA, 1, "08:00:00", "09:00:00"),
            self._lesson(TYSKA, 4, "08:00:00", "09:00:00"),
            self._lesson(FRANSKA, 1, "08:00:00", "09:00:00"),
            self._lesson(FRANSKA, *franska_second),
        ]

    def test_a_block_split_across_two_times_is_caught(self) -> None:
        problems = _validate(_payload(), self._week((5, "08:00:00", "09:00:00")))

        assert len(problems) == 1
        assert problems[0].startswith(f"block {BLOCK}:")

    def test_the_starts_are_compared_and_not_only_the_ends(self) -> None:
        """A request the engine would refuse, read by the checker anyway: two
        members of different lengths that end together and start apart."""
        payload = _payload(franska={"minutesPerLesson": 45, "lessonsPerWeek": 1}, tyska={"lessonsPerWeek": 1})
        problems = _validate(payload, [
            self._lesson(SVENSKA, 1, "10:00:00", "11:00:00"),
            self._lesson(SVENSKA, 2, "10:00:00", "11:00:00"),
            self._lesson(SVENSKA, 3, "10:00:00", "11:00:00"),
            self._lesson(TYSKA, 1, "08:00:00", "09:00:00"),
            self._lesson(FRANSKA, 1, "08:15:00", "09:00:00"),
        ])

        assert any(problem.startswith(f"block {BLOCK}:") for problem in problems)

    def test_a_block_at_one_time_passes(self) -> None:
        assert _validate(_payload(), self._week((4, "08:00:00", "09:00:00"))) == []


def test_the_hogstadium_school_is_a_week_of_blocks_the_engine_accepts() -> None:
    benchmarks = Path(__file__).resolve().parents[1] / "benchmarks"
    if str(benchmarks) not in sys.path:
        sys.path.insert(0, str(benchmarks))
    from hogstadium import build_request

    request = build_request()
    blocks = _blocks_of(request.requirements)
    SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=10.0))._validate_request(request)  # type: ignore[call-arg]

    assert sorted(len(members) for members in blocks.values()) == [5] * 6
    assert sum(r.lessons_per_week for r in request.requirements) == 423
    assert _blocks_of(build_request(blocks=False).requirements) == {}
