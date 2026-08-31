"""Random frame sets, run through the ENGINE's day_windows, dumped as JSON.

The web has its own implementation of the same rule in TypeScript. Two
implementations of one sentence in two languages is exactly where drift hides,
and neither test suite can see the other, so the cases are generated once here
and replayed there.
"""
import json, random, sys
sys.path.insert(0, 'optimization-engine')
from app.schemas.schedule import AnonymousRequirement, FrameTime
from app.solver.frames import day_windows
from app.solver.time_grid import TimeGrid

random.seed(20260831)
GRID = TimeGrid(day_start_minutes=480, day_end_minutes=1080, slot_minutes=15,
                schedule_days=(1, 2, 3, 4, 5))

def clock(m): return f"{m // 60:02d}:{m % 60:02d}:00"

cases = []
for _ in range(400):
    frames = []
    for _ in range(random.randint(0, 4)):
        lo = random.randint(0, 9); hi = lo + random.randint(0, 3)
        start = random.randrange(8 * 60, 17 * 60, 1)
        end = start + random.randrange(5, 300, 1)
        frames.append({
            "minGradeLevel": lo, "maxGradeLevel": min(hi, 12),
            "dayOfWeek": random.choice([None, 1, 2, 3, 4, 5]),
            "startTime": clock(start), "endTime": clock(min(end, 23 * 60)),
        })
    lo = random.randint(0, 9); hi = lo + random.randint(0, 2)
    req = AnonymousRequirement.model_validate({
        "id": "11111111-1111-4111-8111-111111111111",
        "subjectId": "22222222-2222-4222-8222-222222222222",
        "studentGroupId": "33333333-3333-4333-8333-333333333333",
        "teacherId": None, "lessonsPerWeek": 1, "minutesPerLesson": 60,
        "studentGroupSize": 20, "minGradeLevel": lo, "maxGradeLevel": min(hi, 12),
    })
    models = [FrameTime.model_validate(f) for f in frames]
    windows = day_windows(models, req, GRID)
    # As wall-clock minutes, the unit the web works in.
    out = {}
    for day_index, (open_slot, close_slot) in windows.items():
        day = GRID.schedule_days[day_index]
        out[str(day)] = [
            480 + open_slot * GRID.slot_minutes,
            480 + close_slot * GRID.slot_minutes,
        ]
    cases.append({"frames": frames, "span": {"min": lo, "max": min(hi, 12)}, "windows": out})

# The grid goes in the file. The web's assertions are stated in slots, and a
# fixture regenerated on a different grid without saying so would quietly change
# what those assertions mean.
print(json.dumps({
    "slotMinutes": GRID.slot_minutes,
    "dayStartMinutes": GRID.day_start_minutes,
    "dayEndMinutes": GRID.day_end_minutes,
    "cases": cases,
}))
