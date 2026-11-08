"""Förlagda poster: the week with the school's förläggningar released.

A förläggning is a lesson of a timplanspost that the school placed before
Generera, because it can go nowhere else. It reaches this engine as a
FixedLesson, and its post as a requirement with that lesson taken off its
demand: the model is built from exactly what a lesson locked in the grundschema
has always been, and nothing in this module is read by a model builder.

What this module is for is the REFUSAL. A lock's windows are posted bare, so an
INFEASIBLE core never holds one, and a week made impossible by a förläggning
was refused with a sentence about something else. `release_placements` is the
same week with every förläggning released: the locks it stands for taken out,
and each post given back every lesson to place (`Placements.requirements`, the
gateway's own form of the post with nothing förlagt). That is a relaxation of
the week — the same lessons, free to move where they were pinned — so:

- a released week that has a timetable says the förläggningar are what makes
  the week impossible (scheduler_solver._placements_verdict names each), and
- a released week that refuses refuses the week with them too, and the
  original refusal stands as it was.

A förläggning never gives way. Releasing it is a question the explanation asks,
never an answer handed to a school: no timetable of a released week is ever
returned, in the strict mode or in Bästa möjliga schema.
"""

from __future__ import annotations

from app.schemas.schedule import OptimizeScheduleRequest


def release_placements(request: OptimizeScheduleRequest) -> OptimizeScheduleRequest:
    """The same week with its förläggningar released, or the request itself.

    The requirements keep the request's order, each förlagd post in its own
    place replaced by its released form; a post every lesson of which was
    förlagd, and so absent from the request, is added after them. The locks the
    förläggningar stand for leave `fixed_lessons`, and the pupils' day forgets
    them (`pupil_gaps`: cohorts and margins by lock id). Everything else — the
    rooms, the groups, the locks the school made in the grundschema, the rules —
    is the week as it was, so what differs is exactly what was pinned.
    """
    placements = request.placements
    if placements is None:
        return request
    placed = {lesson.fixed_lesson_id for lesson in placements.lessons}
    released = {requirement.id: requirement for requirement in placements.requirements}
    requirements = [released.get(requirement.id, requirement) for requirement in request.requirements]
    present = {requirement.id for requirement in request.requirements}
    requirements.extend(
        requirement for requirement in placements.requirements if requirement.id not in present
    )
    pupil_gaps = request.pupil_gaps
    if pupil_gaps is not None:
        pupil_gaps = pupil_gaps.model_copy(update={
            "cohorts": [
                cohort.model_copy(update={
                    "fixed_lesson_ids": [
                        lesson_id for lesson_id in cohort.fixed_lesson_ids if lesson_id not in placed
                    ],
                })
                for cohort in pupil_gaps.cohorts
            ],
            "fixed_margins": [
                margin for margin in pupil_gaps.fixed_margins if margin.fixed_lesson_id not in placed
            ],
        })
    return request.model_copy(update={
        "requirements": requirements,
        "fixed_lessons": [fixed for fixed in request.fixed_lessons if fixed.id not in placed],
        "pupil_gaps": pupil_gaps,
        "placements": None,
    })
