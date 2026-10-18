/**
 * A högstadium test school, for staging and local testing: 450 pupils in åk
 * 7–9, with språkval and elevens val read in teaching groups across the
 * classes and run as parallel blocks.
 *
 * The demo school (prisma/seed.ts) has home classes, one nivågrupp and no
 * block, and the RLS suite and the adapter probe count its rows, so this is a
 * seed of its own rather than more of that one. Its week is the engine's
 * benchmark school (optimization-engine/benchmarks/hogstadium.py) in the
 * database: the same subjects, groups, blocks and teachers, so a generation
 * run here exercises the whole path — the gateway's payload, the engine's
 * blocks and the lessons written back — on the week the solver is measured
 * on.
 *
 *   per class and week (60 minutes unless named): matematik 3, svenska 3,
 *   engelska 2, NO 3 (laboratory), SO 3, idrott 2 (gymnastiksal), bild 1,
 *   musik 1, slöjd 1 × 90, hem- och konsumentkunskap 1, teknik 1;
 *   per årskurs two blocks of five teaching groups of 30:
 *     Språkval åk N     Spanska A, Spanska B, Tyska, Franska and
 *                       Svenska/engelska, 2 × 60, each its own teacher;
 *     Elevens val åk N  Idrott, Bild, Musik, Matematik and Programmering,
 *                       1 × 60, taught by teachers who also teach classes.
 *   Pupil p of an årskurs (0..149) is in class p / 25, språkval group p % 5
 *   and elevens val group (p + p / 25) % 5, so every group holds pupils of
 *   every class of its year and the two choices are independent.
 *
 * Usage:
 *   npm run db:seed:hogstadium            (--reset to recreate it)
 *
 * Connects via DIRECT_URL (table owner), as the demo seed does; never run it
 * with production credentials. All people are fictional, their authIds random
 * and linked to no Supabase user.
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

const prisma = new PrismaClient({ adapter: createPgAdapter(databaseUrl) });

const SCHOOL_SLUG = 'hogstadieskolan';
const DOMAIN = 'hogstadieskolan.example.com';

const YEARS = [7, 8, 9] as const;
const CLASSES_PER_YEAR = 6;
const PUPILS_PER_CLASS = 25;

/** code, name, national code, lessons, minutes, room type, teachers in the pool. */
const CLASS_SUBJECTS: ReadonlyArray<
  readonly [string, string, string, number, number, string | null, number]
> = [
  ['MA', 'Matematik', 'MA', 3, 60, null, 3],
  ['SV', 'Svenska', 'SV_SVA', 3, 60, null, 3],
  ['EN', 'Engelska', 'EN', 2, 60, null, 2],
  ['NO', 'NO', 'NO', 3, 60, 'Laborationssal', 3],
  ['SO', 'SO', 'SO', 3, 60, null, 3],
  ['IDH', 'Idrott och hälsa', 'IDH', 2, 60, 'Gymnastiksal', 2],
  ['BL', 'Bild', 'BL', 1, 60, 'Bildsal', 1],
  ['MU', 'Musik', 'MU', 1, 60, 'Musiksal', 1],
  ['SL', 'Slöjd', 'SL', 1, 90, 'Trä- och metallslöjd', 1],
  ['HKK', 'Hem- och konsumentkunskap', 'HKK', 1, 60, 'Hemkunskapssal', 1],
  ['TK', 'Teknik', 'TK', 1, 60, null, 1],
];
const POOL = new Map(CLASS_SUBJECTS.map(([code, , , , , , pool]) => [code, pool]));

/** Språkval: group, subject code, the teacher who teaches it in every year. */
const SPRAKVAL: ReadonlyArray<readonly [string, string, string]> = [
  ['Spanska A', 'SPA', 'SPA-0'],
  ['Spanska B', 'SPA', 'SPA-1'],
  ['Tyska', 'TY', 'TY-0'],
  ['Franska', 'FR', 'FR-0'],
  ['Svenska/engelska', 'SVEN', 'SVEN-0'],
];
const LANGUAGES: ReadonlyArray<readonly [string, string]> = [
  ['SPA', 'Spanska'],
  ['TY', 'Tyska'],
  ['FR', 'Franska'],
  ['SVEN', 'Svenska/engelska (språkval)'],
];

/** Elevens val: group, room type, the class subject whose teacher takes it. */
const ELEVENS_VAL: ReadonlyArray<readonly [string, string | null, string]> = [
  ['Idrott', 'Gymnastiksal', 'IDH'],
  ['Bild', 'Bildsal', 'BL'],
  ['Musik', 'Musiksal', 'MU'],
  ['Matematik', null, 'MA'],
  ['Programmering', null, 'TK'],
];

const ROOMS: ReadonlyArray<readonly [string, number]> = [
  ['Klassrum', 22],
  ['Laborationssal', 3],
  ['Gymnastiksal', 2],
  ['Bildsal', 1],
  ['Musiksal', 1],
  ['Trä- och metallslöjd', 2],
  ['Hemkunskapssal', 1],
];

const FIRST = ['Elsa', 'Hugo', 'Alice', 'Liam', 'Maja', 'Noah', 'Vera', 'William', 'Alma', 'Lucas'];
const LAST = ['Berg', 'Ström', 'Holm', 'Lund', 'Dahl', 'Ek', 'Falk', 'Hägg', 'Sund', 'Björk', 'Sjö', 'Ask'];

function time(hhmm: string): Date {
  const date = new Date(0);
  const [h, m] = hhmm.split(':').map(Number);
  date.setUTCHours(h, m, 0, 0);
  return date;
}

function currentSchoolYear(): { name: string; startDate: Date; endDate: Date } {
  const now = new Date();
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
      console.log(`The högstadium school already exists (${existing.id}). Use --reset to recreate it.`);
      return;
    }
    console.log('Deleting the högstadium school…');
    await prisma.school.delete({ where: { id: existing.id } });
  }

  const school = await prisma.school.create({
    data: { name: 'Högstadieskolan', slug: SCHOOL_SLUG, timezone: 'Europe/Stockholm' },
  });
  const schoolId = school.id;
  // Nioårig by name: the school's 7–9 is that numbering's (seed.ts says why).
  const year = await prisma.academicYear.create({
    data: { schoolId, ...currentSchoolYear(), gradeNumbering: 'NIOARIG', isActive: true },
  });

  await prisma.lunchSetting.create({
    data: {
      schoolId,
      lunchEnabled: true,
      lunchStartTime: time('11:00'),
      lunchEndTime: time('13:00'),
      lunchMinutes: 30,
      maxLessonsPerDayPerGroup: 7,
    },
  });
  await prisma.frameTime.createMany({
    data: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
      schoolId,
      minGradeLevel: 7,
      maxGradeLevel: 9,
      dayOfWeek,
      startTime: time('08:00'),
      endTime: time('16:00'),
    })),
  });

  await prisma.roomType.createMany({
    data: DEFAULT_ROOM_TYPES.map((name) => ({ schoolId, name })),
    skipDuplicates: true,
  });
  const roomTypeId = new Map(
    (await prisma.roomType.findMany({ where: { schoolId } })).map((type) => [type.name, type.id]),
  );
  let roomNumber = 0;
  await prisma.room.createMany({
    data: ROOMS.flatMap(([type, count]) =>
      Array.from({ length: count }, (_, index) => ({
        schoolId,
        name: `${type} ${index + 1}`,
        code: `R${++roomNumber}`,
        capacity: 32,
        roomTypeId: roomTypeId.get(type) ?? null,
      })),
    ),
  });

  const subjectId = new Map<string, string>();
  for (const [code, name, nationalCode, , , roomType] of CLASS_SUBJECTS) {
    const subject = await prisma.subject.create({
      data: {
        schoolId,
        name,
        code,
        nationalCode,
        requiredRoomTypeId: roomType ? (roomTypeId.get(roomType) ?? null) : null,
      },
    });
    subjectId.set(code, subject.id);
  }
  for (const [code, name] of LANGUAGES) {
    const subject = await prisma.subject.create({ data: { schoolId, name, code, nationalCode: 'M2' } });
    subjectId.set(code, subject.id);
  }
  for (const [choice, roomType] of ELEVENS_VAL) {
    const subject = await prisma.subject.create({
      data: {
        schoolId,
        name: `Elevens val: ${choice}`,
        code: `EV-${choice.slice(0, 3).toUpperCase()}`,
        requiredRoomTypeId: roomType ? (roomTypeId.get(roomType) ?? null) : null,
      },
    });
    subjectId.set(`EV-${choice}`, subject.id);
  }

  await prisma.user.create({
    data: {
      schoolId,
      authId: randomUUID(),
      role: 'SCHOOL_ADMIN',
      firstName: 'Admin',
      lastName: 'Högstadiet',
      email: `admin@${DOMAIN}`,
    },
  });
  const teacherKeys = [
    ...CLASS_SUBJECTS.flatMap(([code, , , , , , pool]) => Array.from({ length: pool }, (_, i) => `${code}-${i}`)),
    ...SPRAKVAL.map(([, , teacher]) => teacher),
  ];
  const teacherId = new Map<string, string>();
  for (const [index, key] of teacherKeys.entries()) {
    const teacher = await prisma.user.create({
      data: {
        schoolId,
        authId: randomUUID(),
        role: 'TEACHER',
        firstName: FIRST[index % FIRST.length],
        lastName: `${LAST[index % LAST.length]}-${key}`,
        email: `${key.toLowerCase()}@${DOMAIN}`,
      },
    });
    teacherId.set(key, teacher.id);
  }
  // One planning afternoon a week for every teacher of a class subject.
  await prisma.availabilityConstraint.createMany({
    data: teacherKeys
      .filter((key) => !SPRAKVAL.some(([, , teacher]) => teacher === key))
      .map((key, index) => ({
        schoolId,
        resourceType: 'TEACHER' as const,
        userId: teacherId.get(key)!,
        dayOfWeek: (index % 5) + 1,
        startTime: time('14:00'),
        endTime: time('16:00'),
        type: 'UNAVAILABLE' as const,
        reason: 'Planering',
      })),
  });

  let requirements = 0;
  let pupils = 0;
  const blocks: string[] = [];
  for (const grade of YEARS) {
    const classes = [];
    for (let index = 0; index < CLASSES_PER_YEAR; index++) {
      classes.push(
        await prisma.studentGroup.create({
          data: { schoolId, academicYearId: year.id, name: `${grade}${String.fromCharCode(65 + index)}`, gradeLevel: grade },
        }),
      );
    }
    const pupilIds: string[] = [];
    await prisma.user.createMany({
      data: classes.flatMap((group, classIndex) =>
        Array.from({ length: PUPILS_PER_CLASS }, (_, i) => {
          const id = randomUUID();
          pupilIds.push(id);
          return {
            id,
            schoolId,
            authId: randomUUID(),
            role: 'STUDENT' as const,
            firstName: FIRST[(i + classIndex) % FIRST.length],
            lastName: LAST[(i * 7 + grade) % LAST.length],
            email: `elev.${group.name.toLowerCase()}.${i + 1}@${DOMAIN}`,
            studentGroupId: group.id,
          };
        }),
      ),
    });
    pupils += pupilIds.length;

    for (const [classIndex, group] of classes.entries()) {
      await prisma.teachingRequirement.createMany({
        data: CLASS_SUBJECTS.map(([code, , , lessons, minutes]) => ({
          schoolId,
          academicYearId: year.id,
          subjectId: subjectId.get(code)!,
          studentGroupId: group.id,
          teacherId: teacherId.get(`${code}-${(classIndex + grade) % POOL.get(code)!}`)!,
          lessonsPerWeek: lessons,
          minutesPerLesson: minutes,
        })),
      });
      requirements += CLASS_SUBJECTS.length;
    }

    const sprakval = await prisma.teachingBlock.create({
      data: { schoolId, academicYearId: year.id, name: `Språkval åk ${grade}` },
    });
    const elevensVal = await prisma.teachingBlock.create({
      data: { schoolId, academicYearId: year.id, name: `Elevens val åk ${grade}` },
    });
    blocks.push(sprakval.name, elevensVal.name);

    const languageGroups = [];
    for (const [name, code, teacher] of SPRAKVAL) {
      const group = await prisma.studentGroup.create({
        data: { schoolId, academicYearId: year.id, name: `${name} ${grade}`, kind: 'TEACHING_GROUP', gradeLevel: grade },
      });
      languageGroups.push(group);
      await prisma.teachingRequirement.create({
        data: {
          schoolId,
          academicYearId: year.id,
          subjectId: subjectId.get(code)!,
          studentGroupId: group.id,
          teacherId: teacherId.get(teacher)!,
          lessonsPerWeek: 2,
          minutesPerLesson: 60,
          blockId: sprakval.id,
        },
      });
      requirements++;
    }
    const choiceGroups = [];
    for (const [choice, , code] of ELEVENS_VAL) {
      const group = await prisma.studentGroup.create({
        data: { schoolId, academicYearId: year.id, name: `Elevens val ${choice} ${grade}`, kind: 'TEACHING_GROUP', gradeLevel: grade },
      });
      choiceGroups.push(group);
      await prisma.teachingRequirement.create({
        data: {
          schoolId,
          academicYearId: year.id,
          subjectId: subjectId.get(`EV-${choice}`)!,
          studentGroupId: group.id,
          teacherId: teacherId.get(`${code}-${(grade + 1) % POOL.get(code)!}`)!,
          lessonsPerWeek: 1,
          minutesPerLesson: 60,
          blockId: elevensVal.id,
        },
      });
      requirements++;
    }
    await prisma.studentGroupMember.createMany({
      data: pupilIds.flatMap((studentId, p) => [
        { schoolId, studentGroupId: languageGroups[p % 5].id, studentId },
        {
          schoolId,
          studentGroupId: choiceGroups[(p + Math.floor(p / PUPILS_PER_CLASS)) % 5].id,
          studentId,
        },
      ]),
    });
  }

  console.log(
    [
      'Högstadium school seeded:',
      `  school:       ${school.name} (${schoolId})`,
      `  year:         ${year.name}`,
      `  pupils:       ${pupils} in ${YEARS.length * CLASSES_PER_YEAR} classes`,
      `  teachers:     ${teacherKeys.length}`,
      `  requirements: ${requirements}`,
      `  blocks:       ${blocks.join(', ')}`,
    ].join('\n'),
  );
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
