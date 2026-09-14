/**
 * Demo-school seed for staging / local testing.
 *
 * Creates one fully configured school ("Demo Skola") with subjects, rooms,
 * classes, a nivågrupp cut across two of them, teachers, students, a current
 * academic year, the teaching requirements matrix, lunch settings and a few
 * availability constraints — everything the AI engine needs to generate a
 * schedule.
 *
 * Usage:
 *   npm run db:seed
 *
 * Notes
 * - Connects via DIRECT_URL (table owner) because seeding intentionally
 *   bypasses RLS; never run this with production credentials.
 * - Idempotent: if the demo school already exists the script aborts. Pass
 *   `--reset` to delete and recreate it.
 * - All people are fictional. Their `authId`s are random UUIDs that are NOT
 *   linked to Supabase Auth; to sign in as one of them, create the Supabase
 *   user and update the row's authId (see docs/DEPLOYMENT.md §7).
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_ROOM_TYPES } from '../src/resources/default-room-types';
import { createPgAdapter } from '../src/database/pool-config';
import { PrismaClient } from '@prisma/client';

const databaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Set DIRECT_URL (or DATABASE_URL) before seeding.');
  process.exit(1);
}

// Prisma 7 takes the connection from a driver adapter; the `datasources`
// override is gone. The API's own helper builds it, so the seed qualifies
// tables with the same schema the API does.
const prisma = new PrismaClient({ adapter: createPgAdapter(databaseUrl) });

const SCHOOL_SLUG = 'demo-skola';

const SUBJECTS = [
  { name: 'Matematik', code: 'MA', color: '#2563eb' },
  { name: 'Svenska', code: 'SV', color: '#dc2626' },
  { name: 'Engelska', code: 'EN', color: '#7c3aed' },
  { name: 'NO', code: 'NO', color: '#059669' },
  { name: 'SO', code: 'SO', color: '#d97706' },
  { name: 'Idrott', code: 'IDH', color: '#0891b2' },
  { name: 'Musik', code: 'MU', color: '#db2777' },
  { name: 'Slöjd', code: 'SL', color: '#65a30d' },
] as const;

// Room types are rows the school owns, so the seed names them the way a
// Swedish school would. "Musiksalen" gets a real Musiksal type instead of the
// catch-all the old enum forced it into.
const ROOMS = [
  { name: 'Sal A1', code: 'A1', capacity: 30, type: 'Klassrum' },
  { name: 'Sal A2', code: 'A2', capacity: 30, type: 'Klassrum' },
  { name: 'Sal B1', code: 'B1', capacity: 28, type: 'Klassrum' },
  { name: 'Sal B2', code: 'B2', capacity: 28, type: 'Klassrum' },
  { name: 'NO-labbet', code: 'LAB', capacity: 24, type: 'Laborationssal' },
  { name: 'Gympasalen', code: 'GYM', capacity: 60, type: 'Gymnastiksal' },
  { name: 'Musiksalen', code: 'MUS', capacity: 25, type: 'Musiksal' },
] as const;

const GROUPS = ['7A', '7B', '8A', '8B'] as const;

const TEACHER_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['Anna', 'Lindqvist'],
  ['Erik', 'Johansson'],
  ['Maria', 'Svensson'],
  ['Johan', 'Nilsson'],
  ['Karin', 'Andersson'],
  ['Peter', 'Karlsson'],
  ['Sara', 'Eriksson'],
  ['Magnus', 'Larsson'],
];

const STUDENT_FIRST = [
  'Elsa', 'Hugo', 'Alice', 'Liam', 'Maja', 'Noah', 'Vera', 'William',
  'Alma', 'Lucas', 'Ella', 'Oliver', 'Wilma', 'Elias', 'Astrid', 'Leo',
  'Selma', 'Adam', 'Ines', 'Nils',
];
const STUDENT_LAST = [
  'Berg', 'Ström', 'Holm', 'Lund', 'Dahl', 'Ek', 'Falk', 'Hägg',
  'Sund', 'Björk', 'Sjö', 'Ask', 'Vik', 'Norr', 'Öst', 'Palm',
  'Rosen', 'Alm', 'Bäck', 'Frid',
];

/** Weekly lessons per subject for every class (a realistic year-7/8 plan). */
const CURRICULUM: ReadonlyArray<{ code: string; lessonsPerWeek: number; minutesPerLesson: number }> = [
  { code: 'MA', lessonsPerWeek: 4, minutesPerLesson: 60 },
  { code: 'SV', lessonsPerWeek: 4, minutesPerLesson: 60 },
  { code: 'EN', lessonsPerWeek: 3, minutesPerLesson: 60 },
  { code: 'NO', lessonsPerWeek: 3, minutesPerLesson: 60 },
  { code: 'SO', lessonsPerWeek: 3, minutesPerLesson: 60 },
  { code: 'IDH', lessonsPerWeek: 2, minutesPerLesson: 60 },
  { code: 'MU', lessonsPerWeek: 1, minutesPerLesson: 60 },
  { code: 'SL', lessonsPerWeek: 1, minutesPerLesson: 90 },
];

/** Which teacher (by index) teaches which subject codes. */
const TEACHER_SUBJECTS: ReadonlyArray<readonly string[]> = [
  ['MA'],
  ['MA', 'NO'],
  ['SV'],
  ['SV', 'SO'],
  ['EN', 'SO'],
  ['NO', 'IDH'],
  ['IDH', 'MU'],
  ['EN', 'SL'],
];

function time(hhmm: string): Date {
  const date = new Date(0);
  const [h, m] = hhmm.split(':').map(Number);
  date.setUTCHours(h, m, 0, 0);
  return date;
}

function currentSchoolYear(): { name: string; startDate: Date; endDate: Date } {
  const now = new Date();
  // School years run Aug 15 – Jun 12; before August we are in last year's.
  const startYear = now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return {
    name: `${startYear}/${startYear + 1}`,
    startDate: new Date(Date.UTC(startYear, 7, 15)),
    endDate: new Date(Date.UTC(startYear + 1, 5, 12)),
  };
}

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');

  const existing = await prisma.school.findUnique({ where: { slug: SCHOOL_SLUG } });
  if (existing) {
    if (!reset) {
      console.log(`Demo school already exists (${existing.id}). Use --reset to recreate it.`);
      return;
    }
    console.log('Deleting existing demo school…');
    await prisma.school.delete({ where: { id: existing.id } });
  }

  console.log('Creating demo school…');
  const school = await prisma.school.create({
    data: {
      name: 'Demo Skola',
      slug: SCHOOL_SLUG,
      timezone: 'Europe/Stockholm',
    },
  });
  const schoolId = school.id;

  const yearSpec = currentSchoolYear();
  const year = await prisma.academicYear.create({
    data: { schoolId, ...yearSpec, isActive: true },
  });

  // Lunch belongs to the building, not to the läsår, so there is exactly one
  // of these rows per school. 60 seats against 80 pupils is deliberate: the
  // demo school cannot feed everyone at once, which is the only way the
  // capacity rule shows up in a generated schedule. A 30-minute break inside
  // an 11:00-13:00 window leaves room for four sittings, and every number here
  // is a multiple of the solver's 15-minute grid.
  const lunch = { start: '11:00', end: '13:00', minutes: 30, seats: 60 };
  await prisma.lunchSetting.create({
    data: {
      schoolId,
      lunchEnabled: true,
      lunchStartTime: time(lunch.start),
      lunchEndTime: time(lunch.end),
      lunchMinutes: lunch.minutes,
      diningSeats: lunch.seats,
      maxLessonsPerDayPerGroup: 8,
    },
  });

  const subjects = await Promise.all(
    SUBJECTS.map((subject) =>
      prisma.subject.create({ data: { schoolId, ...subject } }),
    ),
  );
  const subjectByCode = new Map(subjects.map((subject) => [subject.code!, subject]));

  // Every school starts with the standard set; the rooms below then reference
  // them by id.
  await prisma.roomType.createMany({
    data: DEFAULT_ROOM_TYPES.map((name) => ({ schoolId, name })),
    skipDuplicates: true,
  });
  const roomTypes = await prisma.roomType.findMany({ where: { schoolId } });
  const roomTypeByName = new Map(roomTypes.map((rt) => [rt.name, rt.id]));

  await Promise.all(
    ROOMS.map(({ type, ...room }) =>
      prisma.room.create({
        data: { schoolId, ...room, roomTypeId: roomTypeByName.get(type) ?? null },
      }),
    ),
  );

  const groups = await Promise.all(
    GROUPS.map((name) =>
      prisma.studentGroup.create({
        data: {
          schoolId,
          academicYearId: year.id,
          name,
          gradeLevel: Number(name[0]),
        },
      }),
    ),
  );

  // Admin + teachers + students. Emails use example.com (reserved for docs).
  await prisma.user.create({
    data: {
      schoolId,
      authId: randomUUID(),
      role: 'SCHOOL_ADMIN',
      firstName: 'Admin',
      lastName: 'Demo',
      email: 'admin@demo-skola.example.com',
    },
  });

  const teachers = await Promise.all(
    TEACHER_NAMES.map(([firstName, lastName]) =>
      prisma.user.create({
        data: {
          schoolId,
          authId: randomUUID(),
          role: 'TEACHER',
          firstName,
          lastName,
          email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@demo-skola.example.com`,
        },
      }),
    ),
  );

  let studentCount = 0;
  // Kept per class so a teaching group can be cut out of one below.
  const studentsByClass = new Map<string, string[]>();
  for (const group of groups) {
    const classmates: string[] = [];
    for (let i = 0; i < 20; i++) {
      const firstName = STUDENT_FIRST[i % STUDENT_FIRST.length];
      const lastName = STUDENT_LAST[(i + studentCount) % STUDENT_LAST.length];
      const student = await prisma.user.create({
        data: {
          schoolId,
          authId: randomUUID(),
          role: 'STUDENT',
          firstName,
          lastName,
          email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}.${group.name.toLowerCase()}@demo-skola.example.com`,
          studentGroupId: group.id,
        },
      });
      classmates.push(student.id);
      studentCount++;
    }
    studentsByClass.set(group.id, classmates);
  }

  // Curriculum: every class needs every subject; teachers are assigned
  // round-robin among those qualified for the subject.
  const teacherForSubject = (code: string, groupIndex: number) => {
    const qualified = teachers.filter((_, index) =>
      TEACHER_SUBJECTS[index].includes(code),
    );
    return qualified[groupIndex % qualified.length];
  };

  let requirementCount = 0;
  for (const [groupIndex, group] of groups.entries()) {
    for (const entry of CURRICULUM) {
      const subject = subjectByCode.get(entry.code)!;
      await prisma.teachingRequirement.create({
        data: {
          schoolId,
          academicYearId: year.id,
          subjectId: subject.id,
          studentGroupId: group.id,
          teacherId: teacherForSubject(entry.code, groupIndex).id,
          lessonsPerWeek: entry.lessonsPerWeek,
          minutesPerLesson: entry.minutesPerLesson,
        },
      });
      requirementCount++;
    }
  }

  // A nivågrupp cut across both year-7 classes: eight pupils from 7A and eight
  // from 7B take extra maths together and stay in their home class for
  // everything else. Every seeded group was a plain CLASS until now, which
  // meant the demo school could not show either of the two things that only go
  // wrong for teaching groups:
  //
  //   * it carries no `gradeLevel` of its own — a year is a property of its
  //     members' home classes — so a rule written per class never reaches it,
  //     and an årskurs rule does;
  //   * its members already eat with 7A and 7B, so a dining hall that adds up
  //     every group's headcount counts them twice.
  const teachingGroup = await prisma.studentGroup.create({
    data: {
      schoolId,
      academicYearId: year.id,
      name: 'Ma71',
      kind: 'TEACHING_GROUP',
    },
  });

  const teachingMembers = groups
    .filter((group) => group.gradeLevel === 7)
    .flatMap((group) => (studentsByClass.get(group.id) ?? []).slice(0, 8));
  await prisma.studentGroupMember.createMany({
    data: teachingMembers.map((studentId) => ({
      schoolId,
      studentGroupId: teachingGroup.id,
      studentId,
    })),
  });

  await prisma.teachingRequirement.create({
    data: {
      schoolId,
      academicYearId: year.id,
      subjectId: subjectByCode.get('MA')!.id,
      studentGroupId: teachingGroup.id,
      teacherId: teacherForSubject('MA', 0).id,
      lessonsPerWeek: 2,
      minutesPerLesson: 60,
    },
  });
  requirementCount++;

  // A few availability constraints so generation is non-trivial.
  await prisma.availabilityConstraint.createMany({
    data: [
      {
        schoolId,
        resourceType: 'TEACHER',
        userId: teachers[0].id,
        dayOfWeek: 5,
        startTime: time('12:00'),
        endTime: time('23:59'),
        type: 'UNAVAILABLE',
        reason: 'Deltid — ledig fredag eftermiddag',
      },
      {
        schoolId,
        resourceType: 'ROOM',
        roomId: (await prisma.room.findFirstOrThrow({
          where: { schoolId, code: 'GYM' },
        })).id,
        dayOfWeek: 3,
        startTime: time('08:00'),
        endTime: time('10:00'),
        type: 'UNAVAILABLE',
        reason: 'Föreningsverksamhet',
      },
      // Points at no row at all: it holds every year-7 group free, which is
      // 7A, 7B *and* Ma71 — the last one being precisely what the same rule
      // written per class would have missed.
      {
        schoolId,
        resourceType: 'GRADE_LEVEL',
        minGradeLevel: 7,
        maxGradeLevel: 7,
        dayOfWeek: 2,
        startTime: time('11:00'),
        endTime: time('11:45'),
        type: 'UNAVAILABLE',
        reason: 'Åk 7 äter tidig lunch — hela skolan får inte plats samtidigt',
      },
    ],
  });

  console.log(
    [
      'Demo school seeded:',
      `  school:       ${school.name} (${schoolId})`,
      `  year:         ${year.name}`,
      `  subjects:     ${subjects.length}`,
      `  rooms:        ${ROOMS.length}`,
      `  classes:      ${groups.length}`,
      `  nivågrupp:    ${teachingGroup.name} (${teachingMembers.length} elever)`,
      `  teachers:     ${teachers.length}`,
      `  students:     ${studentCount}`,
      `  requirements: ${requirementCount}`,
      `  lunch:        ${lunch.start}-${lunch.end}, ${lunch.minutes} min, ${lunch.seats} platser i matsalen`,
      '',
      'Next: link a Supabase Auth user to the admin row, then generate a schedule.',
    ].join('\n'),
  );
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
