import type { IntakeArea, IntakeGap, IntakeLevel, IntakeView } from "../../../lib/intake";
import { route, type GatewayContext, type GatewayRoute } from "../gateway-routes";
import { YEAR } from "./world";

/**
 * Vad kom in as the gateway answers it (src/intake/): every area with what it found and every gap it has, in the gateway's own
 * order, a gap with count 0 when it is not there. Two schools, because the page reads differently on each:
 *
 *   the stub's own school (the default): a school nearly ready, with no gap that stops Generera and a few that give a worse
 *   timetable or only another step reads, so the page shows its common state: a neutral summary, cards with a gap and cards
 *   with none;
 *   `intake-empty`, asked for with x-stub-scenario: a school with nothing in it, which is every hard gap and the year;
 *   `intake-demo`: the gateway's real answer for the seeded demo school (below).
 *
 * The shapes are the gateway's (lib/intake.ts), and web/lib/intake.test.ts holds the codes and the order to src/intake/intake.ts.
 */

const gap = (code: string, level: IntakeLevel, count = 0, items: string[] = [], more = 0): IntakeGap => ({ code, level, count, items, more });
const presence = (code: string, level: IntakeLevel, missing: boolean): IntakeGap => gap(code, level, missing ? 1 : 0);

interface School {
  years: number;
  year: IntakeView["year"];
  subjects: number;
  rooms: number;
  roomTypes: number;
  frameTimes: number;
  rasts: number;
  /** The year's lov, the school's lunch serving rows, its rastvakt areas and the year's passes, and how many of the four switches are on. */
  breaks: number;
  lunchServings: number;
  supervisionAreas: number;
  supervisionShifts: number;
  switchesOn: number;
  classes: number;
  teachingGroups: number;
  teachers: number;
  students: number;
  gradesWithTimplan: number;
  requirements: number;
  posts: number;
}

function view(school: School, gaps: Record<string, IntakeGap>): IntakeView {
  const g = (code: string, level: IntakeLevel): IntakeGap => gaps[code] ?? gap(code, level);
  const waits = school.year === null;
  const areas: IntakeArea[] = [
    { area: "YEAR", found: { years: school.years }, waitsForYear: false, gaps: [presence("NO_YEAR", "HARD", school.year === null)] },
    {
      area: "SUBJECTS",
      waitsForYear: false,
      found: { subjects: school.subjects },
      gaps: [presence("NO_SUBJECTS", "HARD", school.subjects === 0), g("SUBJECTS_WITHOUT_POSTS", "INFO"), g("ROOM_TYPE_WITHOUT_ROOM", "HARD")],
    },
    {
      area: "ROOMS",
      found: { rooms: school.rooms, roomTypes: school.roomTypes },
      waitsForYear: false,
      gaps: [presence("NO_ROOMS", "HARD", school.rooms === 0), presence("NO_ROOM_TYPES", "INFO", school.roomTypes === 0)],
    },
    { area: "FRAME_TIMES", found: { frameTimes: school.frameTimes }, waitsForYear: false, gaps: [g("FRAME_TIMES_MISSING", "SOFT")] },
    { area: "RASTS", found: { rasts: school.rasts }, waitsForYear: false, gaps: [presence("NO_RASTS", "INFO", school.rasts === 0)] },
    { area: "BREAKS", found: { breaks: school.year === null ? 0 : school.breaks }, waitsForYear: waits, gaps: [presence("NO_BREAKS", "INFO", school.year !== null && school.breaks === 0)] },
    // Lunch is the school's (a row of LunchSettings, none meaning off): the gap is its own count, 1 when it is off, and the gateway's `lunchOn` is not
    // a count of the area, so a school with serving rows and no lunch rule says both.
    { area: "LUNCH", found: { lunchServings: school.lunchServings }, waitsForYear: false, gaps: [g("LUNCH_OFF", "INFO")] },
    {
      area: "SUPERVISION",
      found: { supervisionAreas: school.supervisionAreas, supervisionShifts: school.year === null ? 0 : school.supervisionShifts },
      waitsForYear: waits,
      gaps: [presence("NO_SUPERVISION", "INFO", school.year !== null && school.supervisionShifts === 0)],
    },
    {
      area: "CLASSES",
      waitsForYear: waits,
      found: { classes: school.classes },
      gaps: [presence("NO_CLASSES", "SOFT", school.year !== null && school.classes === 0), g("CLASSES_WITHOUT_GRADE", "SOFT"), g("CLASSES_WITHOUT_POSTS", "SOFT")],
    },
    { area: "TEACHING_GROUPS", found: { teachingGroups: school.teachingGroups }, waitsForYear: waits, gaps: [g("TEACHING_GROUPS_WITHOUT_MEMBERS", "SOFT")] },
    {
      area: "PEOPLE",
      waitsForYear: false,
      found: { teachers: school.teachers, students: school.students },
      gaps: [presence("NO_TEACHERS", "HARD", school.teachers === 0), presence("NO_STUDENTS", "SOFT", school.students === 0), g("STUDENTS_WITHOUT_CLASS", "INFO")],
    },
    { area: "TIMPLAN", found: { gradesWithTimplan: school.gradesWithTimplan }, waitsForYear: waits, gaps: [g("TIMPLAN_MISSING", "INFO"), g("TIMPLAN_NOT_DECIDED", "INFO")] },
    {
      area: "REQUIREMENTS",
      waitsForYear: waits,
      found: { requirements: school.requirements },
      gaps: [presence("NO_REQUIREMENTS", "HARD", school.year !== null && school.requirements === 0)],
    },
    { area: "STAFFING", found: { posts: school.posts }, waitsForYear: waits, gaps: [g("UNSTAFFED_POSTS", "SOFT"), g("TEACHERS_WITHOUT_POST", "INFO"), g("POSTS_WITHOUT_SIGNATURE", "INFO")] },
    {
      area: "SWITCHES",
      found: { switchesOn: school.switchesOn },
      waitsForYear: false,
      gaps: [g("ABSENCE_WATCH_OFF", "INFO"), g("ACK_OFF", "INFO"), g("VIEWER_OFF", "INFO"), g("SICK_REPORT_OFF", "INFO")],
    },
  ];
  const there = areas.flatMap((area) => area.gaps).filter((entry) => entry.count > 0);
  return {
    year: school.year,
    areas,
    hard: there.filter((entry) => entry.level === "HARD").length,
    soft: there.filter((entry) => entry.level === "SOFT").length,
    info: there.filter((entry) => entry.level === "INFO").length,
  };
}

const NEARLY_READY = view(
  {
    years: 1,
    year: { id: YEAR.id, name: YEAR.name, isActive: true },
    subjects: 8,
    rooms: 7,
    roomTypes: 3,
    frameTimes: 2,
    rasts: 3,
    breaks: 6,
    lunchServings: 2,
    supervisionAreas: 2,
    supervisionShifts: 14,
    // Bevakning and kvittens are off, Schemavisaren and sjukanmälan are on.
    switchesOn: 2,
    classes: 4,
    teachingGroups: 2,
    teachers: 8,
    students: 80,
    gradesWithTimplan: 2,
    requirements: 33,
    posts: 8,
  },
  {
    FRAME_TIMES_MISSING: gap("FRAME_TIMES_MISSING", "SOFT", 1, ["9"]),
    CLASSES_WITHOUT_POSTS: gap("CLASSES_WITHOUT_POSTS", "SOFT", 1, ["8B"]),
    SUBJECTS_WITHOUT_POSTS: gap("SUBJECTS_WITHOUT_POSTS", "INFO", 1, ["Teknik"]),
    TIMPLAN_NOT_DECIDED: gap("TIMPLAN_NOT_DECIDED", "INFO", 1, ["8"]),
    POSTS_WITHOUT_SIGNATURE: gap("POSTS_WITHOUT_SIGNATURE", "INFO", 3),
    ABSENCE_WATCH_OFF: gap("ABSENCE_WATCH_OFF", "INFO", 1),
    ACK_OFF: gap("ACK_OFF", "INFO", 1),
  },
);

const EMPTY = view(
  {
    years: 0,
    year: null,
    subjects: 0,
    rooms: 0,
    roomTypes: 0,
    frameTimes: 0,
    rasts: 0,
    breaks: 0,
    lunchServings: 0,
    supervisionAreas: 0,
    supervisionShifts: 0,
    switchesOn: 0,
    classes: 0,
    teachingGroups: 0,
    teachers: 0,
    students: 0,
    gradesWithTimplan: 0,
    requirements: 0,
    posts: 0,
  },
  {
    LUNCH_OFF: gap("LUNCH_OFF", "INFO", 1),
    ABSENCE_WATCH_OFF: gap("ABSENCE_WATCH_OFF", "INFO", 1),
    ACK_OFF: gap("ACK_OFF", "INFO", 1),
    VIEWER_OFF: gap("VIEWER_OFF", "INFO", 1),
    SICK_REPORT_OFF: gap("SICK_REPORT_OFF", "INFO", 1),
  },
);

/**
 * The gateway's own answer for the demo school (prisma/seed.ts), as src/intake/intake.service.ts gave it over a database seeded
 * with `npm run db:seed` (2026-11-22): not made up. The seed has no frame time, no rast, no lokal timplan and no post of a teacher,
 * and nothing in it stops Generera. Asked for with x-stub-scenario: intake-demo.
 */
const DEMO_SCHOOL: IntakeView = {
  year: {
    id: YEAR.id,
    name: "2026/2027",
    isActive: true
  },
  areas: [
    {
      area: "YEAR",
      found: {
        years: 1
      },
      waitsForYear: false,
      gaps: [
        {
          code: "NO_YEAR",
          level: "HARD",
          count: 0,
          items: [],
          more: 0
        }
      ]
    },
    {
      area: "SUBJECTS",
      found: {
        subjects: 8
      },
      waitsForYear: false,
      gaps: [
        {
          code: "NO_SUBJECTS",
          level: "HARD",
          count: 0,
          items: [],
          more: 0
        },
        {
          code: "SUBJECTS_WITHOUT_POSTS",
          level: "INFO",
          count: 0,
          items: [],
          more: 0
        },
        {
          code: "ROOM_TYPE_WITHOUT_ROOM",
          level: "HARD",
          count: 0,
          items: [],
          more: 0
        }
      ]
    },
    {
      area: "ROOMS",
      found: {
        rooms: 7,
        roomTypes: 10
      },
      waitsForYear: false,
      gaps: [
        {
          code: "NO_ROOMS",
          level: "HARD",
          count: 0,
          items: [],
          more: 0
        },
        {
          code: "NO_ROOM_TYPES",
          level: "INFO",
          count: 0,
          items: [],
          more: 0
        }
      ]
    },
    {
      area: "FRAME_TIMES",
      found: {
        frameTimes: 0
      },
      waitsForYear: false,
      gaps: [
        {
          code: "FRAME_TIMES_MISSING",
          level: "SOFT",
          count: 2,
          items: [
            "7",
            "8"
          ],
          more: 0
        }
      ]
    },
    {
      area: "RASTS",
      found: {
        rasts: 0
      },
      waitsForYear: false,
      gaps: [
        {
          code: "NO_RASTS",
          level: "INFO",
          count: 1,
          items: [],
          more: 0
        }
      ]
    },
    {
      area: "BREAKS",
      found: {
        breaks: 0
      },
      waitsForYear: false,
      gaps: [
        {
          code: "NO_BREAKS",
          level: "INFO",
          count: 1,
          items: [],
          more: 0
        }
      ]
    },
    {
      area: "LUNCH",
      found: {
        lunchServings: 0
      },
      waitsForYear: false,
      gaps: [
        {
          code: "LUNCH_OFF",
          level: "INFO",
          count: 0,
          items: [],
          more: 0
        }
      ]
    },
    {
      area: "SUPERVISION",
      found: {
        supervisionAreas: 0,
        supervisionShifts: 0
      },
      waitsForYear: false,
      gaps: [
        {
          code: "NO_SUPERVISION",
          level: "INFO",
          count: 1,
          items: [],
          more: 0
        }
      ]
    },
    {
      area: "CLASSES",
      found: {
        classes: 4
      },
      waitsForYear: false,
      gaps: [
        {
          code: "NO_CLASSES",
          level: "SOFT",
          count: 0,
          items: [],
          more: 0
        },
        {
          code: "CLASSES_WITHOUT_GRADE",
          level: "SOFT",
          count: 0,
          items: [],
          more: 0
        },
        {
          code: "CLASSES_WITHOUT_POSTS",
          level: "SOFT",
          count: 0,
          items: [],
          more: 0
        }
      ]
    },
    {
      area: "TEACHING_GROUPS",
      found: {
        teachingGroups: 1
      },
      waitsForYear: false,
      gaps: [
        {
          code: "TEACHING_GROUPS_WITHOUT_MEMBERS",
          level: "SOFT",
          count: 0,
          items: [],
          more: 0
        }
      ]
    },
    {
      area: "PEOPLE",
      found: {
        teachers: 8,
        students: 80
      },
      waitsForYear: false,
      gaps: [
        {
          code: "NO_TEACHERS",
          level: "HARD",
          count: 0,
          items: [],
          more: 0
        },
        {
          code: "NO_STUDENTS",
          level: "SOFT",
          count: 0,
          items: [],
          more: 0
        },
        {
          code: "STUDENTS_WITHOUT_CLASS",
          level: "INFO",
          count: 0,
          items: [],
          more: 0
        }
      ]
    },
    {
      area: "TIMPLAN",
      found: {
        gradesWithTimplan: 0
      },
      waitsForYear: false,
      gaps: [
        {
          code: "TIMPLAN_MISSING",
          level: "INFO",
          count: 2,
          items: [
            "7",
            "8"
          ],
          more: 0
        },
        {
          code: "TIMPLAN_NOT_DECIDED",
          level: "INFO",
          count: 0,
          items: [],
          more: 0
        }
      ]
    },
    {
      area: "REQUIREMENTS",
      found: {
        requirements: 33
      },
      waitsForYear: false,
      gaps: [
        {
          code: "NO_REQUIREMENTS",
          level: "HARD",
          count: 0,
          items: [],
          more: 0
        }
      ]
    },
    {
      area: "STAFFING",
      found: {
        posts: 0
      },
      waitsForYear: false,
      gaps: [
        {
          code: "UNSTAFFED_POSTS",
          level: "SOFT",
          count: 0,
          items: [],
          more: 0
        },
        {
          code: "TEACHERS_WITHOUT_POST",
          level: "INFO",
          count: 8,
          items: [],
          more: 0
        },
        {
          code: "POSTS_WITHOUT_SIGNATURE",
          level: "INFO",
          count: 0,
          items: [],
          more: 0
        }
      ]
    },
    {
      area: "SWITCHES",
      found: {
        switchesOn: 0
      },
      waitsForYear: false,
      gaps: [
        {
          code: "ABSENCE_WATCH_OFF",
          level: "INFO",
          count: 1,
          items: [],
          more: 0
        },
        {
          code: "ACK_OFF",
          level: "INFO",
          count: 1,
          items: [],
          more: 0
        },
        {
          code: "VIEWER_OFF",
          level: "INFO",
          count: 1,
          items: [],
          more: 0
        },
        {
          code: "SICK_REPORT_OFF",
          level: "INFO",
          count: 1,
          items: [],
          more: 0
        }
      ]
    }
  ],
  hard: 0,
  soft: 1,
  info: 9
};

export const intakeRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/intake", ({ scenario }: GatewayContext) => (scenario === "intake-empty" ? EMPTY : scenario === "intake-demo" ? DEMO_SCHOOL : NEARLY_READY)),
];
