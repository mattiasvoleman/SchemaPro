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
    # SchedulerSolver._teacher_hours_verdict: a teacher's lessons against the
    # time their own starts reach, which no rule narrows. `teachers` counts
    # the lines below it, one per teacher, and never names one: the gateway
    # has no name for a teacher to give, so each line names the teacher's
    # requirements in resourceIds instead.
    "DEMAND_TEACHER_HOURS_SHORT": (
        "Too many lessons for {teachers, plural, one {one teacher's hours} other {the hours of # "
        "teachers}}: a teacher gives one lesson at a time, and the lessons named here need more "
        "of the week than the school day, the frame times, the rasts, the margins around the "
        "lessons and the teacher's locked lessons leave them. No rule has to give way; the "
        "hours do. Widen the frame times, shorten the margins, unlock a lesson, or give some "
        "of the lessons to another teacher."
    ),
    # One teacher's requirements, in requirementIds and resourceIds. `days` is
    # how many of the week's `weekDays` their lessons can fall on at all. The
    # margins are the pupils' minutes before and after a lesson and the
    # frame's changeover, which the starts keep inside the school day.
    "DEMAND_TEACHER_LESSONS_EXCEED_ROOM": (
        "One teacher gives the lessons of {requirements, plural, one {# requirement} other {# "
        "requirements}}, and they need {demandMinutes} minutes a week. They can fall on {days, "
        "plural, one {# day} other {# days}} of the week's {weekDays}, and there the school day, "
        "the frame times, the rasts, the margins around the lessons and the teacher's locked "
        "lessons leave them at most {capacityMinutes}."
    ),
    # SchedulerSolver._lesson_gaps_verdict: lessons are taught whole, one in a
    # gap at a time, and the gaps a teacher, a student group or a set of rooms
    # is left with do not take them. `resources` counts the lines below it.
    "DEMAND_LESSONS_EXCEED_GAPS": (
        "Too many lessons for the gaps: a lesson is taught whole, in one stretch, and for "
        "{resources, plural, one {one teacher, student group or set of rooms} other {# "
        "teachers, student groups or sets of rooms}} the gaps that the school day, the frame "
        "times, the rasts, the margins around the lessons, the locked lessons and the lunch "
        "with its sittings leave cannot take the lessons named here. Widen the frame times, "
        "shorten the margins, unlock a lesson, widen the lunch window or a stage's sitting, "
        "or shorten, move or share out some of the lessons."
    ),
    # The lines under it, one per student group, teacher or set of rooms. The
    # lessons counted are those of `shortestMinutes` or more that can fall
    # only on `days` of the week's `weekDays`. `shortOf` says what gave out:
    # "nowhere" when they fit no gap at all (`days` is 0), "lessons" when
    # there are more of them than the gaps take (`fitLessons`), else "minutes",
    # when whole lessons fill at most `capacityMinutes` of them.
    "DEMAND_GROUP_LESSONS_EXCEED_GAPS": (
        "Student group {group} has {lessons, plural, one {# lesson} other {# lessons}} of "
        "{shortestMinutes} minutes or more in {requirements, plural, one {# requirement} "
        "other {# requirements}}, {demandMinutes} minutes in all. {shortOf, select, nowhere "
        "{No gap that the school day, the frame times, the rasts, the margins around the "
        "lessons, the locked lessons and the pupils' lunch leave on the week's {weekDays} "
        "days takes {lessons, plural, one {it} other {any of them}} whole.} lessons {On "
        "{days, plural, one {the one day} other {the # days}} of the week's {weekDays} they "
        "can fall on, the school day, the frame times, the rasts, the margins around the "
        "lessons, the locked lessons and the pupils' lunch leave gaps that take at most "
        "{fitLessons} of them.} other {On {days, plural, one {the one day} other {the # "
        "days}} of the week's {weekDays} they can fall on, the school day, the frame times, "
        "the rasts, the margins around the lessons, the locked lessons and the pupils' lunch "
        "leave gaps that take at most {capacityMinutes} of those minutes in whole lessons.}}"
    ),
    # One teacher's requirements, in requirementIds and resourceIds, and never
    # the teacher: see DEMAND_TEACHER_HOURS_SHORT.
    "DEMAND_TEACHER_LESSONS_EXCEED_GAPS": (
        "One teacher gives {lessons, plural, one {# lesson} other {# lessons}} of "
        "{shortestMinutes} minutes or more in {requirements, plural, one {# requirement} "
        "other {# requirements}}, {demandMinutes} minutes in all. {shortOf, select, nowhere "
        "{No gap that the school day, the frame times, the rasts, the margins around the "
        "lessons, the locked lessons and the pupils' lunch leave on the week's {weekDays} "
        "days takes {lessons, plural, one {it} other {any of them}} whole.} lessons {On "
        "{days, plural, one {the one day} other {the # days}} of the week's {weekDays} they "
        "can fall on, the school day, the frame times, the rasts, the margins around the "
        "lessons, the locked lessons and the pupils' lunch leave gaps that take at most "
        "{fitLessons} of them.} other {On {days, plural, one {the one day} other {the # "
        "days}} of the week's {weekDays} they can fall on, the school day, the frame times, "
        "the rasts, the margins around the lessons, the locked lessons and the pupils' lunch "
        "leave gaps that take at most {capacityMinutes} of those minutes in whole lessons.}}"
    ),
    # The rooms in roomIds: every room the lessons counted may use, each taking
    # one lesson at a time. Their requirements are in requirementIds and in
    # resourceIds, which the page names, as the teacher's line does.
    "DEMAND_ROOM_LESSONS_EXCEED_GAPS": (
        "{rooms, plural, one {The one room these lessons may use takes} other {The # rooms "
        "these lessons may use take}} one lesson at a time, and {lessons, plural, one {there "
        "is # lesson} other {there are # lessons}} of {shortestMinutes} minutes or more to "
        "place in {requirements, plural, one {# requirement} other {# requirements}}, "
        "{demandMinutes} minutes in all. {shortOf, select, nowhere {No gap that the school "
        "day, the frame times, the rasts, the margins around the lessons, the locked lessons "
        "and the pupils' lunch leave on the week's {weekDays} days takes {lessons, plural, "
        "one {it} other {any of them}} whole.} lessons {On {days, plural, one {the one day} "
        "other {the # days}} of the week's {weekDays} they can fall on, the school day, the "
        "frame times, the rasts, the margins around the lessons, the locked lessons and the "
        "pupils' lunch leave gaps that take at most {fitLessons} of them.} other {On {days, "
        "plural, one {the one day} other {the # days}} of the week's {weekDays} they can "
        "fall on, the school day, the frame times, the rasts, the margins around the "
        "lessons, the locked lessons and the pupils' lunch leave gaps that take at most "
        "{capacityMinutes} of those minutes in whole lessons.}}"
    ),
    # The school rules' "Max lessons per day", which applies to every class and
    # teaching group on its own. One line for every group the core holds, the
    # groups in resourceIds, which the gateway names and the page lists.
    # `measured` is what SchedulerSolver._daily_maximum_verdict established:
    # 1, solving the week without the maximum found a timetable, and the groups
    # are the ones it gives more than the maximum on some day; 2, the week is
    # impossible without the maximum too, and the groups named fit their own
    # days without the maximum and not with it; 3, the lunch stage's count
    # (_cliques_short_at_the_maximum): with no meal at all, each class named and
    # the groups that may never overlap with it fit the time the frames and the
    # locks leave them without the maximum and not with it — a count, no week
    # solved either way; 0, nothing could be measured.
    "GROUP_DAILY_MAXIMUM_CANNOT_BE_KEPT": (
        "The school rules allow at most {maxPerDay, plural, one {# lesson} other {# lessons}} a "
        "day for each class and teaching group. {measured, select, 1 {That maximum is what "
        "makes the week impossible: without it, a timetable exists that keeps every other rule, "
        "and in it the groups named here have more lessons than that on some day.} 2 {That "
        "maximum makes the week impossible on its own: even with the other rules set aside, the "
        "groups named here cannot fit their lessons into the days open to them at that maximum. "
        "The week has other causes too: it stays impossible without the maximum.} 3 {That "
        "maximum makes the week impossible on its own: at that maximum the lessons of each "
        "class named here, together with those of groups that may never overlap with it, do "
        "not fit into the time the frame times and the locked lessons leave them, even with "
        "every other rule set aside. Counted without the maximum they fit; that is a count "
        "and not a timetable.} other {That "
        "maximum is one of the rules that cannot all hold at once for the groups named here; "
        "whether it alone is the difference could not be measured.}} Raise Max lessons per day "
        "under School rules, or free more days for those groups' lessons."
    ),
    # Restid i generatorn (app/solver/travel.py): the walk between two
    # skolområden, which the school's Skolregler ask the generator to keep.
    # One line per party, the teachers or the pupils, naming every teacher, or
    # every group and pair of groups, the core holds, in resourceIds, which
    # the gateway names and the page lists. `stepMinutes` is the timetable's
    # start step: the generator rounds each walk up to whole steps, and a
    # school that wrote ten minutes deserves to be told it was asked for
    # thirty. `measured` is what SchedulerSolver._travel_verdict established,
    # the daily maximum's three answers: 1, the week has a timetable without
    # the walk, and in it these leave less time between two sites than the
    # walk — dropping the walk for them is enough, which is all that timetable
    # proves, so the sentence never says they cannot keep it; 2, the week is
    # impossible without the walk too, and these cannot keep it even with
    # every other rule set aside; 0, nothing settled it either way. The lead
    # sentence states the rule, as the maximum's does, and claims nothing of
    # anyone named.
    "TEACHER_TRAVEL_CANNOT_BE_KEPT": (
        "The school rules ask the generator to keep the travel time between the school's sites "
        "for every teacher with lessons on two sites on one day, rounded up to whole start "
        "steps of {stepMinutes} min. {measured, select, 1 {That travel time is what makes the "
        "week impossible: without it, a timetable exists that keeps every other rule, and in it "
        "the teachers named here have less time than the travel time between two lessons on "
        "different sites.} 2 {That travel time makes the week impossible on its own: even with "
        "the other rules set aside, the lessons of the teachers named here cannot be placed so "
        "that it fits. The week has other causes too: it stays impossible without the travel "
        "time.} other {That travel time is one of the rules that cannot all hold at once for the "
        "teachers named here; whether it alone is the difference could not be measured.}} Let "
        "these teachers' lessons use rooms on one site, shorten the travel time under Rooms, "
        "Sites, or turn it off under School rules."
    ),
    "PUPILS_TRAVEL_CANNOT_BE_KEPT": (
        "The school rules ask the generator to keep the travel time between the school's sites "
        "for pupils with lessons on two sites on one day, after their time to change, rounded "
        "up to whole start steps of {stepMinutes} min. {measured, select, 1 {That travel time "
        "is what makes the week impossible: without it, a timetable exists that keeps every "
        "other rule, and in it the pupils of the groups named here have less time than the "
        "travel time between two lessons on different sites.} 2 {That travel time makes the "
        "week impossible on its own: even with the other rules set aside, the lessons of the "
        "groups named here cannot be placed so that it fits. The week has other causes too: it "
        "stays impossible without the travel time.} other {That travel time is one of the rules "
        "that cannot all hold at once for the groups named here; whether it alone is the "
        "difference could not be measured.}} Let these groups' lessons use rooms on one site, "
        "shorten the travel time under Rooms, Sites, or turn it off under School rules."
    ),
    "LUNCH_BREAK_IS_THE_DIFFERENCE": (
        "Counted without the {lunchMinutes}-minute lunch break, the time these lessons can "
        "take has room for {freeMinutes} minutes of them, enough to hold them, so the lunch "
        "is part of what this count finds short. It is a count and not a timetable, and does "
        "not say the week would fit without the lunch."
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

    # ---- The teachers' own time -----------------------------------------
    #
    # EVERY ONE OF THESE NAMES THE RULE AND NONE OF THEM NAMES THE TEACHER.
    # The gateway keeps a map for the rule's id and turns it back; the teacher
    # map is discarded on purpose, so a sentence naming a teacher would reach
    # the school as a uuid that resolves to nobody — and a person's name may
    # not enter a stored conflict at all. The rule is also the thing to go and
    # change, which is what a refusal is for.
    "TEACHER_LUNCH_WINDOW_TOO_NARROW": (
        "The teacher working-time rule {rule} guarantees a {minutes}-minute lunch inside "
        "{windowStart}-{windowEnd}, and that window holds "
        "{remaining, plural, one {# minute} other {# minutes}} of the school day. Widen the "
        "window, shorten the lunch, or move it inside the hours the school teaches in."
    ),
    "TEACHER_LUNCH_LEAVES_NO_START": (
        "{causes, select, locked {Locked lessons} closed {Reservations on the teacher} "
        "locked_closed {Locked lessons and reservations on the teacher} other {These rules}} "
        "leave the teacher working-time rule {rule} no {minutes}-minute lunch inside "
        "{windowStart}-{windowEnd} on {day, select, 1 {Monday} 2 {Tuesday} 3 {Wednesday} "
        "4 {Thursday} 5 {Friday} 6 {Saturday} 7 {Sunday} other {day {day}}}. Move a locked "
        "lesson, shorten the reservation, or widen the window."
    ),
    "TEACHER_REST_LONGER_THAN_THE_NIGHT": (
        "The teacher working-time rule {rule} asks for {restMinutes} minutes between the last "
        "lesson of one day and the first of the next, and the longest night this week can give "
        "is {nightMinutes} minutes: the teacher's {lessons, plural, one {# lesson} "
        "other {# lessons}} "
        "cannot all be placed on days that are not next to each other. Shorten the rest, "
        "lengthen the school day, or give this teacher fewer lessons."
    ),
    "TEACHER_LUNCH_HAS_NOWHERE_TO_GO": (
        "The {minutes}-minute lunch the teacher working-time rule {rule} guarantees inside "
        "{windowStart}-{windowEnd} on {day, select, 1 {Monday} 2 {Tuesday} 3 {Wednesday} "
        "4 {Thursday} 5 {Friday} 6 {Saturday} 7 {Sunday} other {day {day}}} is one of the rules "
        "that cannot all hold at once: the teacher's lessons, the locked lessons and the "
        "reservations leave nowhere to put it. Widen the window, shorten the lunch, or free "
        "the middle of that day."
    ),
    "TEACHER_REST_CANNOT_BE_KEPT": (
        "The rest of {restMinutes} minutes that the teacher working-time rule {rule} asks for "
        "after {day, select, 1 {Monday} 2 {Tuesday} 3 {Wednesday} 4 {Thursday} 5 {Friday} "
        "6 {Saturday} 7 {Sunday} other {day {day}}} is one of the rules that cannot all hold at "
        "once. Shorten the rest, or free the end of that day or the start of the next one."
    ),
    # Lärarens dag: the most minutes of teaching on one day, on the same row as
    # the lunch and the rest and named by it. Every lesson the teacher is on
    # counts, lead or co-teacher, generated or locked, in its own minutes.
    "TEACHER_LESSON_LONGER_THAN_DAILY_CAP": (
        "The teacher working-time rule {rule} allows at most {minutes} minutes of teaching a "
        "day, and one of the teacher's lessons still to place is {lessonMinutes} minutes long on "
        "its own. Raise the cap, or shorten or split the lesson."
    ),
    "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK": (
        "The teacher working-time rule {rule} allows at most {minutes} minutes of teaching a "
        "day, and the teacher has {weekMinutes} minutes of lessons still to place: more than "
        "the {days, plural, one {# school day} other {# school days}} of the week hold at that "
        "cap, once the lessons already locked are counted. Raise the cap, or give this teacher "
        "fewer lessons."
    ),
    "TEACHER_DAILY_CAP_CANNOT_BE_KEPT": (
        "The cap of {minutes} minutes of teaching a day that the teacher working-time rule "
        "{rule} sets is one of the rules that cannot all hold at once on {day, select, "
        "1 {Monday} 2 {Tuesday} 3 {Wednesday} 4 {Thursday} 5 {Friday} 6 {Saturday} 7 {Sunday} "
        "other {day {day}}}. Raise the cap, or free that day for the teacher's lessons."
    ),
    # Deltid in days, on the POST and not on the work rule: HR data. `limit` is
    # the post's anonymous id, which the gateway keeps a map for. Every code
    # here contains WORK_DAYS, and that is load-bearing: the gateway masks
    # every such sentence on read for a reader without HR read access (its
    # DAYS_BEARING list, and a spec that reads this catalogue's fixture), and
    # stores none of them with the figure in.
    "TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK": (
        "The teacher's post {limit} allows teaching on at most {days, plural, one {# day} "
        "other {# days}} a week, and the teacher has {weekMinutes} minutes of lessons still to "
        "place: more than that many days can hold, with the hours the school teaches in, the "
        "lessons already locked and any cap on the day. Allow more days on the post, or give "
        "this teacher fewer lessons."
    ),
    "TEACHER_WORK_DAYS_CANNOT_BE_KEPT": (
        "The teacher's post {limit} allows teaching on at most {days, plural, one {# day} "
        "other {# days}} a week, and that limit is one of the rules that cannot all hold at "
        "once. Allow more days on the post, or give this teacher fewer lessons."
    ),
    # Never sent by this engine: the GATEWAY's form of any WORK_DAYS sentence
    # for a reader without HR read access, and the English it stores in place
    # of one, so that no stored run carries the figure. Here because this is
    # the one catalogue the web renders from. The precedent is
    # STAFF_TEACHER_OVER_TARGET_HIDDEN below: the verdict and nothing that
    # gives the post back.
    "TEACHER_WORK_DAYS_HIDDEN": (
        "A teacher's limit on how many days a week they teach is one of the reasons the "
        "timetable could not be made. The limit is shown to the principal, a full administrator "
        "and anyone with HR read access."
    ),
    # Sent by the GATEWAY after a run that worked: a wish the timetable did not
    # keep, which is a note beside a result and never a refusal of one.
    #
    # THE DAY AND NOTHING ELSE. Whose wish it was is the teacher's name, which
    # the gateway puts in the note's resourceNames when the run is read — the
    # way the days sentence is named, and for every reader, since the wish is
    # staff-readable and not HR — and the web draws under the line as it does
    # a conflict's. The work rule's id was a param here once, and no screen
    # resolves one to a person: the line said which wish broke and not whose.
    "TEACHER_FREE_DAY_WISH_NOT_KEPT": (
        "A teacher wishes {day, select, 1 {Mondays} 2 {Tuesdays} 3 {Wednesdays} "
        "4 {Thursdays} 5 {Fridays} 6 {Saturdays} 7 {Sundays} other {day {day}}} free, and "
        "the new timetable gives them lessons that day. A wish is weighed against the rest of "
        "the week and gives way where keeping it would cost more."
    ),
    # Sent by the GATEWAY beside a hand edit of the grundschema that breaks the
    # cap or the days (master-lessons.service.ts): warnings, never refusals.
    # `role` is the edited lesson's lead or its co-teacher, never a name, and
    # `requirement` the edited lesson's own name as the distribution warnings
    # carry it ("Idrott för 7A") — on a block card the member the teacher is
    # on, which is what tells two of the card's teachers apart.
    "TEACHER_DAY_TOO_LONG": (
        "{role, select, CO_TEACHER {The co-teacher} other {The teacher}} of {requirement} "
        "now teaches {minutes} minutes on {day, select, 1 {Monday} 2 {Tuesday} 3 {Wednesday} "
        "4 {Thursday} 5 {Friday} 6 {Saturday} 7 {Sunday} other {day {day}}}, more than the "
        "{cap} minutes a day their working-time rule allows."
    ),
    "TEACHER_WEEK_TOO_MANY_DAYS": (
        "{role, select, CO_TEACHER {The co-teacher} other {The teacher}} of {requirement} "
        "now teaches on {days} days a week, more than the {max} their post allows."
    ),
    "TEACHER_WEEK_TOO_MANY_DAYS_HIDDEN": (
        "{role, select, CO_TEACHER {The co-teacher} other {The teacher}} of {requirement} "
        "now teaches on more days a week than their post allows. The days are shown to the "
        "principal, a full administrator and anyone with HR read access."
    ),

    # ---- Ämnesfördelning: how a requirement's lessons spread ------------
    #
    # `requirement` is the anonymous id the gateway names "Idrott för 7A", as
    # every sentence about a timplanspost is named. The rule is the subject's
    # or the requirement's own, and the sentences say "the rule" because the
    # engine cannot tell which and the school fixes either in the same dialog.
    "SUBJECT_DISTRIBUTION_WEEK_TOO_SHORT": (
        "{requirement}: {lessons, plural, one {# lesson does} other {# lessons do}} not fit on "
        "the {days, plural, one {# day} other {# days}} it can be taught, with at most "
        "{maxPerDay} a day{minDaysBetween, select, 0 {} 2 { and none on consecutive days} "
        "other { and lesson days at least {minDaysBetween} days apart}}{locked, select, 0 {} "
        "other { ({locked} of them locked)}}. Allow more a day or closer days, or reduce the "
        "lessons per week."
    ),
    "SUBJECT_DISTRIBUTION_PER_DAY": (
        "{requirement} may have at most {maxPerDay, plural, one {# lesson} other {# lessons}} "
        "a day, and that rule is one of those that cannot all hold at once. Allow more a day, "
        "or free a day it can be taught on."
    ),
    "SUBJECT_DISTRIBUTION_DAYS_APART": (
        "{requirement} may not have lessons {minDaysBetween, select, 2 {on consecutive days} "
        "other {on days less than {minDaysBetween} days apart}}, and that rule is one of those "
        "that cannot all hold at once. Allow closer days, or free days it can be taught on."
    ),
    # Sent by the GATEWAY when a hand edit breaks the rule — a warning beside
    # the saved lesson, never a refusal (master-lessons.service.ts). Here for
    # the reason the STAFF_* codes below are: this is the one catalogue the web
    # renders a school's sentences from. `requirement` is already a name there.
    "DISTRIBUTION_TOO_MANY_ON_DAY": (
        "{requirement} now has {count} lessons on {day, select, 1 {Monday} 2 {Tuesday} 3 {Wednesday} 4 {Thursday} 5 {Friday} 6 {Saturday} 7 {Sunday} other {day {day}}}, and its distribution rule allows "
        "at most {maxPerDay} a day."
    ),
    "DISTRIBUTION_DAYS_TOO_CLOSE": (
        "{requirement} now has lessons on {firstDay, select, 1 {Monday} 2 {Tuesday} 3 {Wednesday} 4 {Thursday} 5 {Friday} 6 {Saturday} 7 {Sunday} other {day {firstDay}}} and {secondDay, select, 1 {Monday} 2 {Tuesday} 3 {Wednesday} 4 {Thursday} 5 {Friday} 6 {Saturday} 7 {Sunday} other {day {secondDay}}}, and its distribution rule "
        "{minDaysBetween, select, 2 {allows no consecutive days} other {wants lesson days at "
        "least {minDaysBetween} days apart}}."
    ),
    # Sent by the GATEWAY beside a hand edit of a shared post's lesson (delade
    # lektioner, share-warnings.ts): a warning, never a refusal, here for the
    # reason DISTRIBUTION_* is. `role` says which of the edited lesson's two
    # teachers it is about — the one on it now, or the one a teacher change
    # took it from; never a name, as Lärarens dag's role.
    "SHARE_LESSONS_DIFFER": (
        "{requirement} splits its lessons between teachers, and {role, select, PREVIOUS "
        "{the lesson's previous teacher} other {the lesson's teacher}} now has {lessons} of them "
        "in the timetable where the split gives {share}. Change the lesson's teacher, or the "
        "split in the entry's dialog."
    ),

    # ---- Parallella block: requirements run at the same times -----------
    #
    # `block` is the anonymous id the gateway turns into the block's name
    # ("Språkval åk 7"); `requirement` and `other` are two of its members,
    # named as every timplanspost is ("Tyska för Ty7"). Never a person: a
    # teacher two members share is said to be shared, and nobody is named.
    "BLOCK_MEMBERS_DIFFER": (
        "{block}: {requirement} does not have the same lessons as {other}, and the lessons of a "
        "block are placed at the same times. Give every entry in the block the same lessons per "
        "week and the same lengths."
    ),
    "BLOCK_MEMBERS_SHARE_TEACHER": (
        "{block}: {requirement} and {other} have the same teacher, who cannot teach both at the "
        "same time. Give one of them another teacher, or take it out of the block."
    ),
    "BLOCK_MEMBERS_SHARE_PUPILS": (
        "{block}: {requirement} and {other} share pupils, who cannot be in both at the same "
        "time. Take one of them out of the block, or let each pupil be in only one group of it."
    ),
    "BLOCK_NO_COMMON_START": (
        "{block}: its groups have no time in common at which a {minutes}-minute lesson can "
        "start, with the frame times, breaks and margins of their years. Widen the frame times, "
        "or take an entry out of the block."
    ),
    "BLOCK_CANNOT_BE_PLACED": (
        "{block} cannot have all its lessons at the same times, and that rule is one of those "
        "that cannot all hold at once. Check when its groups, teachers and rooms are free, or "
        "take an entry out of the block."
    ),
    # A proved INFEASIBLE the assumption solve could not explain, measured
    # instead: the same week without its blocks, given the probe's budget.
    # Removing every block made the week solve, so the blocks are what make
    # it impossible — together, which is all this establishes about each one.
    # Restid i generatorn: a proved refusal the explanation named nothing in,
    # solved again without the walk (SchedulerSolver._travel_without_core).
    "TRAVEL_PROBE_SUMMARY": (
        "No timetable satisfies every rule, and the solver could not name which of them collide. "
        "With the travel time between the school's sites dropped a timetable was found in "
        "{seconds} s, so it is the travel time below that makes the week impossible."
    ),
    "BLOCK_PROBE_SUMMARY": (
        "No timetable satisfies every rule, and the solver could not name which of them collide. "
        "With the blocks dropped a timetable was found in {seconds} s, so it is the blocks listed "
        "below that cannot all have their lessons at the same times."
    ),
    # Sent by the GATEWAY before the engine is called (the generate pre-flight
    # in optimization-proxy.service.ts): only it knows which locked lesson
    # belongs to which entry, since a locked lesson reaches this engine as a
    # fixed lesson with no requirement id. Here because this is the one
    # catalogue the web renders a school's sentences from.
    "BLOCK_PARTLY_LOCKED_SUMMARY": (
        "{count, plural, one {# block has} other {# blocks have}} lessons locked or placed by "
        "hand while the rest of the block is still to be placed, and a block's lessons are "
        "placed together."
    ),
    "BLOCK_PARTLY_LOCKED": (
        "{block} has {locked, plural, one {# lesson} other {# lessons}} locked or placed by hand "
        "while the rest of it is still to be placed. Unlock the block's lessons and move any moved "
        "by hand back with the block, or lock all of them."
    ),
    # Sent by the GATEWAY too, about a block on another block's times
    # (TeachingBlocks.sameTimesAsBlockId, a term split's spring on its
    # autumn): this engine is sent only the block whose times are taken, and
    # the gateway writes the other's lessons at its times. `block` is the
    # block placed by hand, `other` the one still to place; both are names.
    "BLOCK_SAME_TIMES_PARTLY_LOCKED": (
        "{block} has {locked, plural, one {# lesson} other {# lessons}} locked or placed by hand, "
        "while {other}, which takes the same times in other weeks, still has all of its lessons "
        "to place. Lock the two blocks together, or unlock {block}."
    ),
    # Refused by the gateway before this engine is called, as a 400 like the
    # block sentences above. `block` takes the times of `other`.
    "BLOCK_SAME_TIMES_DIFFER": (
        "{block} takes the times of {other}, and the two no longer fit together: they need the "
        "same subjects for the same groups, with the same lessons, in weeks that never meet. Make "
        "them match again, or delete {block} to place its lessons at times of their own."
    ),
    "BLOCK_SAME_TIMES_TEACHERS": (
        "{block} takes the times of {other}, and has more teachers that {other} does not than the "
        "entries of {other} have room for beside their own. Give the entries of {block} the "
        "teachers of {other}, or take a co-teacher off {other}."
    ),
    # Refused by the gateway (optimization-proxy.service.ts, delade lektioner):
    # two members of one block each split between teachers. The k-th lessons
    # of a block start together, which ties one teacher's lesson to one
    # particular other's; `requirement` and `other` are the two entries.
    "BLOCK_MEMBERS_SPLIT": (
        "{block}: {requirement} and {other} both have their lessons split between teachers, and "
        "the lessons of a block are placed together one by one. Give one of them one teacher "
        "again, or take it out of the block."
    ),
    # Refused by the gateway too (same-times.ts, delade lektioner): an entry of
    # either block whose lessons are split between teachers. A leader entry
    # holds one teacher for all its lessons, and the follower's lessons each
    # have their own. `requirement` is the entry's name.
    "BLOCK_SAME_TIMES_SPLIT_LESSONS": (
        "{block} takes the times of {other}, and {requirement} has its lessons split between "
        "teachers. A block on another block's times holds one teacher per entry for all its "
        "lessons, so give the entry one teacher again, or delete {block} to place its lessons at "
        "times of their own."
    ),
    # Sent by the GATEWAY beside a hand edit that moved one member of a block
    # away from the others (master-lessons.service.ts, block-lessons.ts): a
    # warning, never a refusal. The lesson is the school's from then on, which
    # is why the next generation refuses the block above.
    "BLOCK_SPLIT": (
        "{block} is split: this lesson has left the rest of the block and now counts as placed by "
        "hand. Unless every lesson of the block is locked, the next generation refuses the block "
        "as partly locked. Move it back with the block, or lock all of the block's lessons."
    ),
    # Sent by the GATEWAY beside a hand edit that leaves a teacher, or the pupils
    # of a lesson, less time between two lessons at different skolområden than
    # the walk between them (master-lessons.service.ts, travel-warnings.ts): a
    # warning, never a refusal. Here for the reason DISTRIBUTION_* is. The
    # generator's own refusal is TEACHER_TRAVEL_CANNOT_BE_KEPT and its pupils'
    # twin above, and a timetable it made never draws this warning: it holds
    # every pair, not only neighbours, and the walk rounded up to its step.
    "TRAVEL_TIME_SHORT": (
        "{party, select, TEACHER {{name}} other {The pupils in {name}}} cannot make it from {from} "
        "to {to}: {gap} min between the lessons, and the walk takes {minutes} min ({other} "
        "{time})."
    ),

    # ---- The timeout probe ----------------------------------------------
    "PROBE_NOTHING_HELPED": (
        "No timetable was found within {budget} s, and none of the {rules, plural, "
        "one {# rule} other {# rules}} probed made one appear inside {slice} s each. The week may "
        "simply be large; try a longer budget."
    ),
    # Restid i generatorn: the same, where the school keeps the walk. No time
    # per rule, because the walk's probe goes first with the whole probe
    # budget and the other rules get what it leaves; its line gives its own.
    "PROBE_NOTHING_HELPED_WITH_TRAVEL": (
        "No timetable was found within {budget} s, and none of the {rules, plural, "
        "one {# rule} other {# rules}} probed made one appear. The travel time was probed first, "
        "and the other rules only had the time it left. The week may simply be large; try a "
        "longer budget."
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
    # Restid i generatorn. The walk is one switch in the Skolregler and its
    # figures one card under Rooms, so a single probe: it says the walk is
    # what the budget ran out on, and both places a school can act on it.
    "PROBE_SOLVED_WITHOUT_TRAVEL": (
        "With the travel time between the school's sites dropped, a timetable was found in "
        "{seconds} s."
    ),
    # Restid i generatorn, a timeout with the walk on whose own probe found
    # nothing either. Only what the probe measured: the rule is on, and a
    # search without it found nothing in its time. Not that the walk is the
    # cause — the review's 2,000-pupil week runs out of time with it off too —
    # and the way to measure that (a run with it off).
    "PROBE_TRAVEL_UNMEASURED": (
        "The travel time between the school's sites is turned on. Searching without it for "
        "{seconds} s did not find a timetable either, so whether it is the difference was not "
        "measured. A run with it turned off under School rules shows that."
    ),
    "PROBE_SOLVED_WITHOUT_DISTRIBUTION": (
        "With the subjects' distribution rules dropped — at most a number of lessons a day, "
        "no consecutive days — a timetable was found in {seconds} s."
    ),
    "PROBE_SOLVED_WITHOUT_BLOCKS": (
        "With the blocks dropped, so that the lessons of a block could take different times, a "
        "timetable was found in {seconds} s."
    ),
    # TWO PROBES AND NEVER ONE "teachers' working time", for the reason the
    # lunch above is three: a school cannot switch its teachers' working time
    # off, and being told it could is true and useless. A guaranteed lunch is
    # widened or shortened on one screen; a night's rest is a different number
    # on the same row, and which of the two it is decides what a rektor does
    # next.
    "PROBE_SOLVED_WITHOUT_TEACHER_LUNCH": (
        "With the teachers' own guaranteed lunch switched off, a timetable was found in "
        "{seconds} s."
    ),
    "PROBE_SOLVED_WITHOUT_TEACHER_REST": (
        "With the teachers' own minimum rest between two teaching days switched off, a "
        "timetable was found in {seconds} s."
    ),
    # Two more, and two for the reason above: a cap is a number on the work
    # rule and the days are a number on the post, two screens and two people.
    # The days' probe names no teacher and no figure, so it says that SOME
    # post limits its days, which every reader may know; it is not WORK_DAYS.
    "PROBE_SOLVED_WITHOUT_TEACHER_DAILY_CAP": (
        "With the teachers' cap on minutes of teaching a day switched off, a timetable was "
        "found in {seconds} s."
    ),
    "PROBE_SOLVED_WITHOUT_TEACHER_DAY_LIMITS": (
        "With the posts' limits on how many days a week a teacher teaches switched off, a "
        "timetable was found in {seconds} s."
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
    # SchedulerSolver._validate_request: every reader of the week keys a
    # requirement by its id, so two rows sharing one are refused rather than
    # read two ways. The gateway never sends one.
    "INPUT_DUPLICATE_REQUIREMENT_ID": (
        "Requirement {requirement} appears more than once in the week sent. Every requirement "
        "needs an id of its own."
    ),
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
    # Its own code, NOT a second reading of the one above. The frame may be
    # perfectly good and the margin the thing that does not fit: a window exactly
    # as wide as the lesson offers every minute the lesson needs, and the sentence
    # above would tell a school its frame times leave no room for minutes they do
    # offer — sending it to the wrong screen to change the wrong number.
    "MARGIN_NO_WINDOW_FOR_REQUIREMENT": (
        "The time around the lessons of requirement {requirement} "
        "({grades, select, any {years unknown} other {years {grades}}}) leaves them no day to "
        "run on: its {minutes}-minute lessons take {before} minutes before and {after} minutes "
        "after for the pupils, {changeover, select, 0 {with no changeover between lessons} "
        "other {plus {changeover} minutes of changeover between lessons}}, and the widest any "
        "day then leaves for the lesson itself is {remaining} minutes. Shorten the lessons, "
        "shorten those margins, or widen the window they all have to fit inside."
    ),
    # The frame time only where a frame narrows the stage's days (`framed`), for
    # the reason the margins' sentence below gives: without one the rasts cut
    # the configured day, and the frame screen has nothing on it to widen.
    # `framed` arrived after the sentence did, so a refusal stored before it is
    # shown in its own English (web/lib/engine-message.ts), not as a hole.
    "RAST_NO_STRETCH_FOR_REQUIREMENT": (
        "The rasts leave no room for requirement {requirement} "
        "({grades, select, any {years unknown} other {years {grades}}}): its {minutes}-minute "
        "lessons need an unbroken stretch, and the longest any day still offers is {remaining} "
        "minutes. {framed, select, 0 {Shorten a rast, or split the lesson.} "
        "other {Shorten a rast, widen the frame time, or split the lesson.}}"
    ),
    # Its own code for the reason the margins' is: neither sentence above is true
    # of the week. Its window holds the lesson and its margins, and its rasts
    # leave a stretch longer than the lesson; it is the stretch at the day's edge,
    # less the margin that may not run past it, that is too short. Told only of
    # its rasts, a school measures 125 minutes where the sentence says 110.
    #
    # The frame time is offered only where a frame narrows the stage's days
    # (`framed`): the edge the margin meets is the configured day's, which no
    # school row moves, and a school with no frame would be sent to a screen
    # with nothing on it to widen.
    "RAST_MARGIN_NO_STRETCH_FOR_REQUIREMENT": (
        "The rasts and the time around the lessons of requirement {requirement} "
        "({grades, select, any {years unknown} other {years {grades}}}) together leave them no "
        "stretch to run in: its {minutes}-minute lessons take {before} minutes before and "
        "{after} minutes after for the pupils, {changeover, select, 0 {with no changeover "
        "between lessons} other {plus {changeover} minutes of changeover between lessons}}, "
        "none of which may run past the start or end of the day, and the longest stretch the "
        "rasts then leave any day for the lesson itself is {remaining} minutes. "
        "{framed, select, 0 {Shorten the lessons, or shorten those margins or a rast.} "
        "other {Shorten the lessons, shorten those margins or a rast, or widen the frame time.}}"
    ),
    # The builder's backstop (_start_domains), for a domain emptied by a
    # composition no refusal above names. Generic because it has to be: it is
    # only ever said when the specific sentence is missing.
    "LESSON_NO_START_FOR_REQUIREMENT": (
        "The {minutes}-minute lessons of requirement {requirement} "
        "({grades, select, any {years unknown} other {years {grades}}}) have no start left on "
        "any day: the frame times, the rasts and the time around the lessons for the pupils "
        "leave them nowhere to begin. Shorten the lessons, or widen what they have to fit inside."
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

    # ---- Tjänstefördelning: sent by the GATEWAY, not by this engine ---------
    # The staffing policy's refusals and warnings (src/staffing/staffing-checks.ts
    # and the generate pre-flight in optimization-proxy.service.ts). They live
    # here anyway because this is THE catalogue: the web renders every sentence
    # a school is refused with from web/messages/*.json under engineMessages, and
    # the parity fixture generated from this dict is what keeps that file whole.
    # A second catalogue for three gateway codes would be two sources for one
    # screen. The staffing proposal's own STAFF_* codes follow below.
    # `role` is the row's lead, its co-teacher or a vikarie, never a name;
    # `grades` is "7", "7–9" or "any", as _grade_span_text writes a span.
    "STAFF_TEACHER_NOT_QUALIFIED": (
        "{role, select, CO_TEACHER {The co-teacher} SUBSTITUTE {The substitute} "
        "other {The teacher}} has no qualification in {subject}"
        "{grades, select, any {} other { for years {grades}}}."
    ),
    "STAFF_TEACHER_OVER_TARGET": (
        "{role, select, CO_TEACHER {The co-teacher} SUBSTITUTE {The substitute} "
        "other {The teacher}} would carry {minutes} minutes a week against a target of "
        "{target} (the limit is {limit} with the {tolerance} % tolerance)."
    ),
    # The same, for a post that changes during the year (gateway migration
    # 20261022120000): judged in the stretch of the year the write takes past
    # its limit, `from` and `to` its dates as yyyy-mm-dd.
    "STAFF_TEACHER_OVER_TARGET_IN_PERIOD": (
        "{role, select, CO_TEACHER {The co-teacher} SUBSTITUTE {The substitute} "
        "other {The teacher}} would carry {minutes} minutes a week against a target of "
        "{target} from {from} to {to} (the limit is {limit} with the {tolerance} % tolerance)."
    ),
    # The same verdict for a reader who may not see how the post changes
    # (Roller i skolan, without HR read access): the stretch's minutes, target
    # and dates would give back the post's level in it, so only the verdict
    # and the school's tolerance go out.
    "STAFF_TEACHER_OVER_TARGET_HIDDEN": (
        "{role, select, CO_TEACHER {The co-teacher} SUBSTITUTE {The substitute} "
        "other {The teacher}} would carry more than the limit, the target with the "
        "{tolerance} % tolerance. The minutes are shown to the principal, a full "
        "administrator and anyone with HR read access."
    ),
    # Refused by the GATEWAY before the engine is woken
    # (optimization-proxy.service.ts groupConflictsRefusal): a week whose
    # groupConflicts pass the request's max_length. Here because this is the
    # one catalogue the web renders a school's sentences from.
    "GROUP_CONFLICTS_OVER_ENGINE_LIMIT": (
        "The groups that share pupils make {pairs} pairs, more than the {limit} the timetable "
        "engine takes in one run, so the week was not sent. Fewer groups that share pupils, or "
        "fewer replacing groups, bring the number down."
    ),
    # "Curriculum entry", the English the web's nav uses for a timplanspost.
    "STAFF_UNSTAFFED_REQUIREMENTS": (
        "{count, plural, one {# curriculum entry has} other {# curriculum entries have}} no "
        "teacher, and the school's staffing policy refuses to generate a timetable until every "
        "entry has one. Staff the entries named here, or allow generation without a teacher in "
        "the staffing settings."
    ),

    # ---- The staffing proposal (POST /api/v1/staff) -----------------------
    # Sent by THIS engine, from app/solver/staffing_solver.py. None of them
    # names a person: `subject` is an opaque id the gateway realises to the
    # subject's name, and a teacher reaches the page only as an id in the
    # conflict's own teacherIds, which the page names from its staff list.
    # Minutes are whole minutes, converted from the wire's tenths.
    "STAFF_NO_QUALIFIED_TEACHER_FOR_REQUIREMENT": (
        "{count, plural, one {# curriculum entry} other {# curriculum entries}} in {subject}"
        "{grades, select, any {} other { for years {grades}}} cannot be staffed: no active "
        "teacher holds a qualification that covers {count, plural, one {it} other {them}}. "
        "Record a qualification, or propose without respecting qualifications."
    ),
    # The Fach-Engpass, computed before the model: a lower bound on what stays
    # unstaffed, whatever the search finds.
    "STAFF_CAPACITY_EXHAUSTED_FOR_SUBJECT": (
        "{subject} needs {demandedMinutes, plural, one {# minute} other {# minutes}} a week "
        "across {count, plural, one {# curriculum entry} other {# curriculum entries}}, and the "
        "teachers who may take them have at most "
        "{availableMinutes, plural, one {# minute} other {# minutes}} left below their limits, "
        "so at least {shortMinutes, plural, one {# minute} other {# minutes}} will stay "
        "unstaffed. Raise a target or the tolerance, record more qualifications, or reduce the "
        "subject's time."
    ),
    # The page puts the teacher's name in front of this sentence.
    "STAFF_TEACHER_CAPACITY_ZERO": (
        "Already carries {fixedMinutes, plural, one {# minute} other {# minutes}} a week "
        "against a limit of {limitMinutes}, so no further curriculum entry fits."
    ),
    "STAFF_MODEL_TOO_LARGE": (
        "There are too many possible teacher assignments to weigh in one go: about "
        "{variables} model variables against a limit of {limit}. Keep the entries that are "
        "settled as they are, or record qualifications so that fewer teachers are candidates "
        "for each entry, and try again."
    ),
}
