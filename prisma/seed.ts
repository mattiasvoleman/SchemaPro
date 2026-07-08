/**
 * Demo-school seed for staging / local testing.
 *
 * Creates one fully configured school ("Demo Skola") with subjects, rooms,
 * classes, teachers, students, a current academic year, the teaching
 * requirements matrix and a few availability constraints — everything the AI
 * engine needs to generate a schedule.
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
import { PrismaClient } from '@prisma/client';

const databaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Set DIRECT_URL (or DATABASE_URL) before seeding.');
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

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

const ROOMS = [
  { name: 'Sal A1', code: 'A1', capacity: 30, type: 'CLASSROOM' },
  { name: 'Sal A2', code: 'A2', capacity: 30, type: 'CLASSROOM' },
  { name: 'Sal B1', code: 'B1', capacity: 28, type: 'CLASSROOM' },
  { name: 'Sal B2', code: 'B2', capacity: 28, type: 'CLASSROOM' },
  { name: 'NO-labbet', code: 'LAB', capacity: 24, type: 'LABORATORY' },
  { name: 'Gympasalen', code: 'GYM', capacity: 60, type: 'GYMNASIUM' },
  { name: 'Musiksalen', code: 'MUS', capacity: 25, type: 'OTHER' },
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

  const subjects = await Promise.all(
    SUBJECTS.map((subject) =>
      prisma.subject.create({ data: { schoolId, ...subject } }),
    ),
  );
  const subjectByCode = new Map(subjects.map((subject) => [subject.code!, subject]));

  await Promise.all(
    ROOMS.map((room) =>
      prisma.room.create({
        data: { schoolId, ...room, type: room.type as never },
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
  for (const group of groups) {
    for (let i = 0; i < 20; i++) {
      const firstName = STUDENT_FIRST[i % STUDENT_FIRST.length];
      const lastName = STUDENT_LAST[(i + studentCount) % STUDENT_LAST.length];
      await prisma.user.create({
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
      studentCount++;
    }
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

  // A couple of availability constraints so generation is non-trivial.
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
      `  teachers:     ${teachers.length}`,
      `  students:     ${studentCount}`,
      `  requirements: ${requirementCount}`,
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
