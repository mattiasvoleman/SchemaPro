"""Every sentence the engine sends a school, written once and named by a code.

WHY A CODE AT ALL. The engine's refusals reach a Swedish school through a
Swedish screen, and they were English: a rektor whose week was refused read
"The dining hall's 115 seats cannot seat the 11 classes named" in a page that
says everything else in Swedish. Translating in the engine is the wrong place
— the engine has no idea who is reading, and the same API serves the web, the
app and the logs. So each sentence gets a stable CODE and a flat dict of
PARAMS, and the reader renders it: web/messages/sv.json holds the Swedish, and
this module holds the English that any client without a translation falls back
to, the logs included.

WHY THE ENGLISH LIVES HERE rather than at the call sites it used to: the
message and the code must not drift. A call site that passes a code and writes
its own sentence would, sooner or later, pass one code and say another thing —
and the school would read the Swedish for the first and the English for the
second. Rendering the message FROM the code makes that impossible.

THE TEMPLATE SYNTAX IS A STRICT SUBSET OF ICU, which is what next-intl renders
on the other side. So the Swedish entry and the English entry below are the
same shape, a reviewer can read them side by side, and a parity test can
compare their arguments. Supported:

    {name}                                     a value, substituted
    {name, plural, one {…} other {…}}          a branch on a count
    #                                          inside a branch: the count
    {name, select, a {…} b {…} other {…}}      a branch on a value

`select` earns its place twice over: a weekday arrives as the ISO number and
Swedish wants "tisdag", and a year span that may be unknown wants "åk 4–6" or
"alla årskurser" from one code. Without it each of those needs two codes and
two call-site branches, which is how a sentence and its translation drift.

Deliberately no more. Selectordinal, dates, numbers with skeletons and nested
plurals are ICU features nothing here needs, and a renderer that pretends to
support them would be a lie the tests could not check. A template that needs
one of them is a template to rewrite.

WHY NOT A LIBRARY. Babel would render full ICU and weigh 30 MB in a runtime
image built for a solver; the hundred lines below cover what all forty-nine
sentences use. If one ever needs real ICU, take the dependency then.
"""
from __future__ import annotations

import re
from collections.abc import Mapping

#: The arguments a template takes, at the TOP level only. A plural's branches
#: are written in braces too, so a naive scan reads `{other {klasser}}` as an
#: argument; only a brace that opens at depth zero introduces one. The web's
#: own parity test scans the Swedish the same way, for the same reason.
_ARGUMENT = re.compile(r"^\w+")


def arguments_of(template: str) -> set[str]:
    """The names a template substitutes, plural and select branches excluded."""
    names: set[str] = set()
    depth = 0
    for index, char in enumerate(template):
        if char == "}":
            depth -= 1
            continue
        if char != "{":
            continue
        depth += 1
        if depth != 1:
            continue
        match = _ARGUMENT.match(template[index + 1 :])
        if match is not None:
            names.add(match.group(0))
    return names


class MessageError(Exception):
    """A template and its params disagree — a bug here, never bad input."""


def render(code: str, params: Mapping[str, str | int | float] | None = None) -> str:
    """The English for `code`, with `params` substituted.

    Raises rather than papering over: an unknown code or a missing param is a
    call site that was edited without its message, and a sentence with a hole
    in it reaching a school is worse than a 500 reaching a log.
    """
    template = MESSAGES.get(code)
    if template is None:
        msg = f"No message for code {code}."
        raise MessageError(msg)
    return render_template(template, params or {})


def render_template(template: str, params: Mapping[str, str | int | float]) -> str:
    """Render one template. Split out so tests can exercise the syntax."""
    out: list[str] = []
    index = 0
    while index < len(template):
        char = template[index]
        if char != "{":
            out.append(char)
            index += 1
            continue
        name, kind, branches, index = _read_argument(template, index)
        if name not in params:
            msg = f"Missing param {name} for template {template!r}."
            raise MessageError(msg)
        value = params[name]
        if not kind:
            out.append(str(value))
        elif kind == "plural":
            out.append(_render_plural(branches, value, params, template))
        else:
            out.append(_render_select(branches, value, params, template))
    return "".join(out)


def _read_argument(template: str, start: int) -> tuple[str, str, str, int]:
    """Read the argument at `start` -> (name, kind, branches, next index).

    `kind` is "" for a plain `{name}`, else "plural" or "select".
    """
    depth = 0
    for index in range(start, len(template)):
        if template[index] == "{":
            depth += 1
        elif template[index] == "}":
            depth -= 1
            if depth == 0:
                inside = template[start + 1 : index]
                head, _, body = inside.partition(",")
                name = head.strip()
                if not body:
                    return name, "", "", index + 1
                kind, _, branches = body.partition(",")
                if kind.strip() not in ("plural", "select"):
                    msg = f"Unsupported argument type {kind.strip()!r} in {template!r}."
                    raise MessageError(msg)
                return name, kind.strip(), branches, index + 1
    msg = f"Unclosed argument in template {template!r}."
    raise MessageError(msg)


_BRANCH = re.compile(r"(\w+)\s*\{")


def _render_select(
    branches: str,
    value: str | int | float,
    params: Mapping[str, str | int | float],
    template: str,
) -> str:
    """Pick the branch whose key equals the value, else `other`."""
    chosen = _branches_of(branches)
    body = chosen.get(str(value), chosen.get("other"))
    if body is None:
        msg = f"No matching branch and no `other` for {value!r} in {template!r}."
        raise MessageError(msg)
    return render_template(body, params)


def _branches_of(branches: str) -> dict[str, str]:
    """`one {a} other {b}` -> {"one": "a", "other": "b"}."""
    chosen: dict[str, str] = {}
    index = 0
    while (match := _BRANCH.search(branches, index)) is not None:
        depth = 1
        cursor = match.end()
        while cursor < len(branches) and depth:
            depth += (branches[cursor] == "{") - (branches[cursor] == "}")
            cursor += 1
        chosen[match.group(1)] = branches[match.end() : cursor - 1]
        index = cursor
    return chosen


def _render_plural(
    branches: str,
    value: str | int | float,
    params: Mapping[str, str | int | float],
    template: str,
) -> str:
    """Pick `one` when the count is exactly 1, else `other`, and expand `#`."""
    if not isinstance(value, int):
        msg = f"Plural argument is not a number in {template!r}."
        raise MessageError(msg)
    chosen = _branches_of(branches)
    body = chosen.get("one" if value == 1 else "other", chosen.get("other"))
    if body is None:
        msg = f"Plural without an `other` branch in {template!r}."
        raise MessageError(msg)
    return render_template(body.replace("#", str(value)), params)


#: code -> English template. Codes name the FACT, never the wording, so a
#: reworded sentence keeps its code and its translation keeps its meaning.
#: The Swedish for every one of these lives in web/messages/sv.json under
#: `engineMessages`, and web/i18n/engine-messages.test.ts fails when a code
#: here has no entry there.
MESSAGES: dict[str, str] = {
    # ---- The dining hall, before any solve ------------------------------
    "LUNCH_HALL_CANNOT_FEED_THE_SCHOOL": (
        "The dining hall cannot feed the school on {day, select, 1 {Monday} 2 {Tuesday} "
        "3 {Wednesday} 4 {Thursday} 5 {Friday} 6 {Saturday} 7 {Sunday} other {day {day}}}: "
        "{students, plural, one {# student} other {# students}} eating {minutes} minutes each "
        "need {needed} student-minutes, and {seats} seats over {windowStart}-{windowEnd} offer "
        "{offered}. Add seats, widen the lunch window, or shorten the meal."
    ),
    "LUNCH_PLACED_BY_HAND": (
        "The lunch placed by hand for student group {group} on {day, select, 1 {Monday} 2 {Tuesday} 3 {Wednesday} 4 {Thursday} 5 {Friday} 6 {Saturday} 7 {Sunday} other {day {day}}} at {start} is one "
        "of the rules that cannot all hold at once. Move it, or remove it and let the solver "
        "place the meal."
    ),
    "LUNCH_PLACEMENT_COLLIDES": (
        "The lunch placed by hand for student group {group} on {day, select, 1 {Monday} 2 {Tuesday} 3 {Wednesday} 4 {Thursday} 5 {Friday} 6 {Saturday} 7 {Sunday} other {day {day}}} at {start} lands on "
        "{what, select, locked {a locked lesson} closed {time reserved for the class} "
        "day {a day the class is not at school} other {time the class cannot give up}}. "
        "Move the lunch, or change what it lands on."
    ),
    "LUNCH_PLACEMENT_OFF_GRID": (
        "The lunch placed by hand for student group {group} on {day, select, 1 {Monday} 2 {Tuesday} 3 {Wednesday} 4 {Thursday} 5 {Friday} 6 {Saturday} 7 {Sunday} other {day {day}}} starts at {start}, "
        "which does not fit the {slotMinutes}-minute scheduling grid or the school day. "
        "Move it to a time the day holds."
    ),
    "LUNCH_SEATS_CANNOT_STAGGER": (
        "Lunch cannot be staggered within the dining hall's {seats} seats."
    ),
    "LUNCH_GROUP_LARGER_THAN_HALL": (
        "Student group {group} brings {students, plural, one {# student} other {# students}} to "
        "lunch, more than the dining hall's {seats} seats."
    ),

    # ---- Hours against hours -------------------------------------------
    "DEMAND_CLIQUE_HOURS_SHORT": (
        "Too many lessons for the hours: student group {group} and the {sharingGroups, plural, "
        "one {# teaching group} other {# teaching groups}} sharing its pupils may never overlap, "
        "and between them need {demandMinutes} minutes of lessons a week, but the frame times, "
        "the locked lessons and the lunch leave at most {capacityMinutes}. Widen the frame, "
        "unlock a lesson in the middle of the day, or move the lunch window."
    ),
    "DEMAND_REQUIREMENTS_EXCEED_WEEK": (
        "Lessons of {requirements, plural, one {# requirement} other {# requirements}} need "
        "{demandMinutes} minutes a week and the week offers {capacityMinutes}."
    ),
    "LUNCH_BREAK_IS_THE_DIFFERENCE": (
        "The {lunchMinutes}-minute lunch break is what leaves no room: without it the week would "
        "hold these lessons ({freeMinutes} minutes free)."
    ),

    # ---- The lunch stage: the refusal and the causes it needs -----------
    "LUNCH_HALL_CANNOT_SEAT_CLASSES": (
        "The dining hall's {seats} seats cannot seat the {classes, plural, one {# class} "
        "other {# classes}} named ({students, plural, one {# student} other {# students}}) at the "
        "lunch starts their days leave them, in {lunchMinutes}-minute sittings between "
        "{windowStart} and {windowEnd}. Add seats, widen the lunch window or the sittings, or "
        "free the starts a frame, a lock or a constraint takes away."
    ),
    "LUNCH_NO_PLACEMENT_FOR_CLASSES": (
        "No placement of the lunch breaks works for the {classes, plural, one {# class} "
        "other {# classes}} named: their lessons, sittings, frame times, locked lessons and "
        "constraints leave no day that holds both the lessons and the break. Widen the frame or "
        "the lunch window, or unlock a lesson in the middle of the day."
    ),
    "LUNCH_NO_PLACEMENT_SEATS_UNDECIDED": (
        "No placement of the lunch breaks satisfies the lunch window, the sittings, the frame "
        "times, the locked lessons and the dining hall's {seats} seats together for the "
        "{classes, plural, one {# class} other {# classes}} named. The solver ran out of time "
        "before it could say whether the seats are the difference."
    ),
    "LUNCH_SEATS_CAP": "The dining hall's {seats} seats are all it holds at one time.",
    "LUNCH_CLASSES_EAT_DAILY": (
        "The classes named here take a lunch break every school day."
    ),
    "LUNCH_CLASSES_FILL_THE_HALL_DAILY": (
        "The classes named here bring their students to the hall every school day."
    ),
    "LUNCH_LESSONS_FILL_THE_DAY": (
        "The lessons of the classes named here fill the day so completely around the break that "
        "few lunch starts are left for it."
    ),
    "LUNCH_LESSONS_FILL_THE_FRAMED_DAY": (
        "The lessons of the classes named here fill their frame time {window} so completely "
        "around the break that few lunch starts are left for it."
    ),
    "LUNCH_STARTS_NARROWED_BY_SITTING_OR_FRAME": (
        "A lunch sitting or a frame time narrows when the classes named here may eat."
    ),
    "LUNCH_STARTS_PLACED_BY_HAND": (
        "The classes named here have a lunch the school placed by hand, and the other "
        "lunches have to fit around it."
    ),
    "LUNCH_STARTS_TAKEN_BY_LOCKED_LESSONS": (
        "Locked lessons take lunch starts away from the classes named here."
    ),
    "LUNCH_STARTS_TAKEN_BY_RESERVATION": (
        "An availability constraint takes lunch starts away from the classes named here."
    ),

    # ---- A lunch a rule leaves nowhere to go ----------------------------
    "LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK": (
        "Locked lessons leave student group {group} no {minutes}-minute lunch break inside "
        "{windowStart}-{windowEnd} on {day, select, 1 {Monday} 2 {Tuesday} 3 {Wednesday} "
        "4 {Thursday} 5 {Friday} 6 {Saturday} 7 {Sunday} other {day {day}}}."
    ),
    "LUNCH_AVAILABILITY_LEAVES_NO_BREAK": (
        "An availability constraint leaves student group {group} no {minutes}-minute lunch break inside "
        "{windowStart}-{windowEnd} on {day, select, 1 {Monday} 2 {Tuesday} 3 {Wednesday} "
        "4 {Thursday} 5 {Friday} 6 {Saturday} 7 {Sunday} other {day {day}}}. Shorten the "
        "constraint, widen the lunch window, or shorten the break."
    ),
    "LUNCH_CAUSES_LEAVE_NO_BREAK": (
        "Together, {causes, select, locked {locked lessons} closed {availability constraints} "
        "declared {the declared lunch sittings} locked_closed {locked lessons and availability constraints} "
        "locked_declared {locked lessons and the declared lunch sittings} "
        "closed_declared {availability constraints and the declared lunch sittings} "
        "locked_closed_declared {locked lessons, availability constraints and the declared lunch sittings} "
        "other {these rules}} leave student group {group} no {minutes}-minute lunch break inside "
        "{windowStart}-{windowEnd} on {day, select, 1 {Monday} 2 {Tuesday} 3 {Wednesday} "
        "4 {Thursday} 5 {Friday} 6 {Saturday} 7 {Sunday} other {day {day}}}."
    ),
    "LUNCH_NO_SERVING_FOR_GROUP": (
        "No lunch sitting leaves student group {group} room for a {minutes}-minute meal on "
        "{day, select, 1 {Monday} 2 {Tuesday} 3 {Wednesday} 4 {Thursday} 5 {Friday} "
        "6 {Saturday} 7 {Sunday} other {day {day}}}. Widen the sitting, shorten the break, or "
        "check the stage's frame times."
    ),
    "LUNCH_SERVING_CANNOT_FEED_STAGE": (
        "The {servingStart}-{servingEnd} sitting for years {grades} cannot feed "
        "{students, plural, one {# student} other {# students}} {minutes} minutes each with "
        "{seats} seats. Widen the sitting, add seats, or split the stage across two sittings."
    ),
    "LUNCH_WINDOW_SHORTER_THAN_BREAK": (
        "The lunch window {windowStart}-{windowEnd} is shorter than the {minutes}-minute lunch "
        "break it has to hold."
    ),
    "LUNCH_WINDOW_OFF_GRID": (
        "The lunch window {windowStart}-{windowEnd} and its {minutes}-minute break do not fit "
        "the {slotMinutes}-minute scheduling grid. Use whole multiples of {slotMinutes} minutes."
    ),

    # ---- The timeout probe ----------------------------------------------
    "PROBE_NOTHING_HELPED": (
        "No timetable was found within {budget} s, and none of the {rules, plural, "
        "one {# rule} other {# rules}} probed made one appear inside {slice} s each. The week may "
        "simply be large; try a longer budget."
    ),
    "PROBE_ONE_RULE_HELPED": (
        "No timetable was found within {budget} s, but relaxing a single rule made the same week "
        "solve. {rules, plural, one {The rule is listed below} other {The # rules are listed "
        "below}} — a measurement, not a proof."
    ),
    "PROBE_SOLVED_WITHOUT_CHANGEOVER": (
        "With the margin between lessons set to 0, a timetable was found in {seconds} s."
    ),
    "PROBE_SOLVED_WITHOUT_PUPIL_BUFFERS": (
        "With the extra time the pupils need before and after their lessons set to 0, a "
        "timetable was found in {seconds} s."
    ),
    "PROBE_SOLVED_WITHOUT_LESSON_BEFORE_RAST": (
        "With the requirement of a lesson before a break dropped, a timetable was found in "
        "{seconds} s. The breaks themselves were left in place."
    ),
    "PROBE_SOLVED_WITHOUT_RASTS": (
        "With the rasts removed, a timetable was found in {seconds} s."
    ),
    "PROBE_SOLVED_WITHOUT_SERVINGS": (
        "With the lunch sittings per stage removed, so that the whole window was open to every "
        "stage, a timetable was found in {seconds} s."
    ),
    "PROBE_SOLVED_WITHOUT_DINING_SEATS": (
        "With the dining hall's seat limit removed, a timetable was found in {seconds} s."
    ),
    "PROBE_SOLVED_WITHOUT_LUNCH": (
        "With the guaranteed lunch break switched off, a timetable was found in {seconds} s."
    ),

    # ---- What CP-SAT itself blames --------------------------------------
    "CONFLICT_CORE_SUMMARY": (
        "No timetable satisfies every rule. Start with the causes listed below: together they are "
        "enough to make the week impossible, but the solver reports a sufficient set rather than "
        "the smallest one, so some of them may carry no blame."
    ),
    "CONFLICT_NO_CORE": (
        "No timetable satisfies every rule, and the solver could not name which of them collide."
    ),
    "CONFLICT_NO_CORE_GUESS": (
        "Total teaching demand likely exceeds available room or teacher time. Review lessons per "
        "week, unavailable windows, and room capacity."
    ),
    "ROOM_NO_ROOM_FOR_REQUIREMENT": (
        "Requirement {requirement} needs a room that holds {groupSize, plural, one {# student} "
        "other {# students}}."
    ),
    "ROOM_NO_ROOM_OF_TYPE_FOR_REQUIREMENT": (
        "Requirement {requirement} needs a room of type {roomType} that holds "
        "{groupSize, plural, one {# student} other {# students}}."
    ),
    "AVAIL_CONSTRAINT_BLOCKS_LESSONS": (
        "A constraint on {kind, select, TEACHER {a teacher} ROOM {room {resource}} "
        "STUDENT_GROUP {class {resource}} other {years {grades}}} "
        "{day, select, 0 {on {date}} 1 {on Mondays} 2 {on Tuesdays} 3 {on Wednesdays} "
        "4 {on Thursdays} 5 {on Fridays} 6 {on Saturdays} 7 {on Sundays} other {on day {day}}} "
        "{start}-{end} blocks lessons that have to be placed."
    ),

    # ---- The payload the engine will not take ----------------------------
    "INPUT_NO_REQUIREMENTS": (
        "The timplan is empty: there is nothing to place. Add at least one row."
    ),
    "INPUT_NO_ROOMS": "No rooms are registered, so no lesson can be given one.",
    "INPUT_TOO_MANY_LESSONS": (
        "The week holds {lessons} lessons, more than the {limit} this engine will place in one "
        "run. Split the run, or reduce lessons per week."
    ),
    "INPUT_MODEL_TOO_LARGE": (
        "This week is too large to build: about {variables} model variables against a limit of "
        "{limit}. The usual causes are rooms with many different capacities, constraints that "
        "each touch many lessons, and very high per-teacher lesson loads."
    ),
    "ROOM_MODEL_TOO_LARGE": (
        "There are too many rooms to re-deal in one go: about {variables} model variables "
        "against a limit of {limit}. The model grows with how many lessons may move and how "
        "many rooms each may use. Lock the lessons whose room is settled (a locked lesson "
        "keeps both its time and its room), or give subjects room rules that narrow where "
        "they may go, and try again."
    ),
    "INPUT_LESSON_LENGTH_OFF_GRID": (
        "Requirement {requirement} asks for {minutes}-minute lessons, which do not fit the "
        "{slotMinutes}-minute scheduling grid. Use a whole multiple of {slotMinutes} minutes."
    ),
    "INPUT_LESSON_LONGER_THAN_DAY": (
        "Requirement {requirement} asks for {minutes}-minute lessons, which are longer than the "
        "school day."
    ),
    "INPUT_CONSTRAINT_TIME_OFF_GRID": (
        "The constraint on {kind, select, TEACHER {a teacher} ROOM {room {resource}} "
        "STUDENT_GROUP {class {resource}} other {years {grades}}} runs {start}-{end}, which does "
        "not fit the {slotMinutes}-minute scheduling grid or falls outside the school day."
    ),
    "FRAME_NO_WINDOW_FOR_REQUIREMENT": (
        "The frame times leave no room for requirement {requirement} "
        "({grades, select, any {years unknown} other {years {grades}}}): its {minutes}-minute "
        "lessons need a window, and the widest any day still offers is {remaining} minutes."
    ),
    "RAST_NO_STRETCH_FOR_REQUIREMENT": (
        "The rasts leave no room for requirement {requirement} "
        "({grades, select, any {years unknown} other {years {grades}}}): its {minutes}-minute "
        "lessons need an unbroken stretch, and the longest any day still offers is {remaining} "
        "minutes. Shorten a rast, widen the frame time, or split the lesson."
    ),
    "RAST_DEMANDS_A_LESSON_THAT_CANNOT_FIT": (
        "The break at {rast} on {day, select, 1 {Monday} 2 {Tuesday} 3 {Wednesday} "
        "4 {Thursday} 5 {Friday} 6 {Saturday} 7 {Sunday} other {day {day}}} asks for a lesson "
        "before it, and none can fit: {grades, select, any {classes with unknown years} "
        "other {years {grades}}} have {remaining, plural, one {# minute} other {# minutes}} "
        "between {opens} — {bound, select, lunch {the earliest their lunch can end} "
        "closed {what a reservation leaves of it} other {where the stretch opens}} — and that "
        "break, and their shortest lesson is "
        "{minutes} minutes. They can therefore never be at school after that break, and the "
        "days that are left hold {capacityMinutes} minutes against the {demandMinutes} their "
        "lessons need. Move the break, shorten the meal or widen its window, free the minutes "
        "a reservation holds, or turn the requirement off for that break."
    ),
    "RAST_NO_LESSON_FITS_BEFORE_IT": (
        "The classes named here require a lesson before a break, and their week leaves nowhere "
        "to put one: between the start of their day — or their previous break or lunch — and "
        "that break, no lesson of theirs fits. Move the break, shorten a lesson, or turn the "
        "requirement off for that break."
    ),
    "ROOM_NONE_ELIGIBLE_FOR_REQUIREMENT": (
        "No room fits requirement {requirement} "
        "({grades, select, any {years unknown} other {years {grades}}}): it needs room for "
        "{groupSize, plural, one {# student} other {# students}} and a room of type "
        "{roomType, select, any {any type} other {{roomType}}}."
    ),
    "ROOM_LOCK_LEAVES_NO_ROOM": (
        "A room lock leaves requirement {requirement} "
        "({grades, select, any {years unknown} other {years {grades}}}) nowhere to go: the rooms "
        "it names are too small, of the wrong type, or reserved for other years. Widen the lock, "
        "name another room, or change the room."
    ),
    "ROOM_LOCK_WEEK_TOO_SMALL": (
        "Room locks put {requirements, plural, one {# requirement} other {# requirements}} into "
        "{rooms, plural, one {# room} other {# rooms}} that cannot hold them: they need "
        "{neededMinutes} minutes a week and those rooms offer {offeredMinutes}. Name another "
        "room, or narrow which years the lock applies to."
    ),
}
