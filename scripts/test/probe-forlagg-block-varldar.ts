/**
 * Världsprovet för ett blocks förläggningar (PR C1): slumpade världar mot riktig databas och RIKTIG motor, med en domare som inte
 * använder en rad av gatewayens kod.
 *
 *   SEED=1 FROM=0 WORLDS=120 \
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@127.0.0.1:5617/c1_real?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@127.0.0.1:5617/c1_real' \
 *   AI_ENGINE_URL=http://127.0.0.1:8813 AI_ENGINE_API_KEY=<motorns API_KEY> AI_ENGINE_TIMEOUT_MS=90000 \
 *   JWT_SECRET=x JWT_ISSUER=https://ci.invalid/auth/v1 NODE_ENV=test \
 *   npx ts-node --transpile-only scripts/test/probe-forlagg-block-varldar.ts
 *
 * Inte i CI (motorn är den riktiga). SEED väljer slumpen, FROM och WORLDS väljer vilka världar (så att de kan köras i omgångar:
 * FROM=0 WORLDS=40, FROM=40 WORLDS=40, ...), ONLY=<värld> kör en enda värld för att återge ett fel. Världen w av seed s är alltid
 * densamma.
 *
 * VAD EN VÄRLD ÄR. Ett litet läsår med 2 till 4 poster i ett parallellt block (några världar har två block, några har ett
 * HT-block och ett VT-block, några har ett block som bara går en termin), blandade längder (60, 40, 80+40, 60+60+40 ...), klasser
 * som också har egna ämnen vid sidan av, och salar av två typer. Varje värld går i fyra steg:
 *
 *   1. Generera UTAN förläggningar, mot motorn: ett giltigt schema. En värld som motorn inte löser alls räknas som `baseUnsolved`
 *      och prövas inte vidare (det är inget fel i gatewayen, men antalet skrivs ut);
 *   2. blockets förläggningar TAS UR det schemat: några av blockets lektioner (en, flera eller alla) blir blockrader med dag,
 *      start och längd som schemat har dem, med salen medlemmen hade i schemat (för ingen, några eller alla medlemmar:
 *      världens roomMode) och sparas genom BlockPlacementsService. Ibland förläggs också en vanlig posts lektion bredvid
 *      (utan sal: ett fäste, med sal: ett lås), så att båda vägarna är med i samma körning. Ett giltigt schema innehåller dem
 *      alla, så en vägran av förläggningen eller av veckan är ett fel;
 *   3. Generera igen, mot motorn och databasen, som en administratör under radsäkerhet, på riktigt;
 *   4. domaren, som bara läser MasterLessons med SQL: varje post har exakt sin efterfrågan (antal, längder, lärare, fönster);
 *      varje blockrad är exakt en lektion per medlem med fromPlacement på rätt dag, start och längd, låst och genererad, i sin
 *      sal om den hade en och annars i en sal av rätt typ; ingen lärare, klass eller sal är på två ställen samtidigt (med
 *      terminsfönster och udda och jämna veckor); och resten av blockets lektioner ligger ihop: varje medlem har samma lista av
 *      (dag, start, längd) som de andra. Var fjärde värld kör Generera en gång till och dömer igen (det skrivs om ur raderna).
 *
 * Före världarna prövar provet domaren själv: ett färdigt schema förstörs på sex sätt (en tid flyttad, ett märke borttaget, två
 * medlemmar i samma sal, en medlem skild från de andra, en lärare på två ställen, en lektion för mycket) och domaren ska se
 * varje förstörelse. Ett prov vars domare inte fäller ett medvetet fel bevisar ingenting.
 *
 * Ett fel skrivs ut med världens seed och nummer, domarens rader och ett minimalt scenario (blocken, medlemmarna, de förlagda
 * raderna och vad motorn svarade). Exitkoden är 1 vid minst ett fel. Provet har en egen skola (probe-forlagg-block-varldar) i läsåret
 * 2095/96 som börjar en lördag, planterad och borttagen av provet.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { loadavg } from 'node:os';
import 'reflect-metadata';
import { HttpException, type INestApplicationContext } from '@nestjs/common';
import { Client } from 'pg';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';

const SLUG = 'probe-forlagg-block-varldar';
const YEAR_START = '2095-08-20';
const YEAR_END = '2096-06-10';
const AUTUMN_END = '2095-12-20';
const SPRING_START = '2096-01-12';

/** mulberry32: en liten seedad slumpgenerator, densamma varje gång. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const summarise = (error: unknown): string =>
  error instanceof HttpException ? `${error.name} ${error.getStatus()} ${JSON.stringify(error.getResponse())}` : error instanceof Error ? `${error.name}: ${error.message}` : String(error);

// ---------------------------------------------------------------------------
// Vad en värld är
// ---------------------------------------------------------------------------

type Kind = 'K' | 'S';
type Window = 'ALL' | 'HT' | 'VT';

interface PostSpec {
  key: string;
  /** Index i världens klasser. */
  group: number;
  kind: Kind;
  /** Index i världens lärare. */
  teacher: number;
  lengths: number[];
  window: Window;
  block: number | null;
  // Fylls i när världen byggs:
  id?: string;
  groupId?: string;
  subjectId?: string;
  teacherId?: string;
}

interface WorldSpec {
  w: number;
  seed: number;
  family: 'plain' | 'dated' | 'terms';
  roomMode: 'none' | 'some' | 'all';
  /** Hur många av blockets lektioner som förläggs: 'some' en del, 'all' alla. */
  placeMode: 'some' | 'all';
  groups: number;
  teachers: number;
  blocks: Array<{ name: string; window: Window; members: string[] }>;
  posts: PostSpec[];
}

interface BlockRow {
  block: number;
  day: number;
  start: string;
  minutes: number;
  /** postens nyckel -> sal */
  rooms: Record<string, string>;
}

interface PostRow {
  post: string;
  day: number;
  start: string;
  minutes: number;
  roomId: string | null;
}

const SHAPES = [[60, 60], [60, 60, 60], [40, 40], [60], [80, 40], [60, 60, 40], [80, 40, 40], [60, 60, 60, 60], [40, 40, 40]];
const BLOCK_SHAPES = [[60, 60], [60, 60, 60], [40, 40], [60], [80, 40], [60, 60, 40], [80, 40, 40], [60, 60], [60, 60, 40]];

function specOf(seed: number, w: number): WorldSpec {
  const rand = prng((seed * 1000003 + w * 7919) >>> 0);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const family: WorldSpec['family'] = pick(['plain', 'plain', 'plain', 'plain', 'plain', 'plain', 'dated', 'terms']);
  const roomMode: WorldSpec['roomMode'] = pick(['none', 'none', 'none', 'some', 'some', 'all']);
  const placeMode: WorldSpec['placeMode'] = pick(['some', 'some', 'all']);
  const groups = 8;
  const teachers = 12;
  const spec: WorldSpec = { w, seed, family, roomMode, placeMode, groups, teachers, blocks: [], posts: [] };
  let nextTeacher = 0;
  const teacher = () => nextTeacher++ % teachers;
  const bumpedGroups = Array.from({ length: groups }, (_, i) => i);
  const takeGroups = (n: number) => {
    const chosen: number[] = [];
    for (let i = 0; i < n; i++) chosen.push(bumpedGroups.splice(Math.floor(rand() * bumpedGroups.length), 1)[0]!);
    return chosen;
  };
  const blockCount = family === 'terms' ? 2 : rand() < 0.2 ? 2 : 1;
  for (let b = 0; b < blockCount; b++) {
    const window: Window = family === 'terms' ? (b === 0 ? 'HT' : 'VT') : family === 'dated' && b === 0 ? pick<Window>(['HT', 'VT']) : 'ALL';
    const members = 2 + Math.floor(rand() * 3);
    const shape = pick(BLOCK_SHAPES);
    // Terminsblocken (HT och VT) delar klasser så att motorn kan lägga dem på samma tid; ett vanligt andra block får klasser av egna.
    const classes = family === 'terms' && b === 1 ? spec.posts.filter((p) => p.block === 0).map((p) => p.group) : takeGroups(members);
    const name = `W${w} block ${b + 1}`;
    spec.blocks.push({ name, window, members: [] });
    for (let m = 0; m < classes.length; m++) {
      const key = `b${b}m${m}`;
      spec.blocks[b]!.members.push(key);
      spec.posts.push({ key, group: classes[m]!, kind: rand() < 0.15 ? 'S' : 'K', teacher: family === 'terms' && b === 1 ? spec.posts.find((p) => p.key === `b0m${m}`)!.teacher : teacher(), lengths: [...shape], window, block: b });
    }
  }
  // Vid sidan av: en till fyra vanliga poster, på klasser som också sitter i blocken eller på egna.
  const bystanders = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < bystanders; i++) {
    spec.posts.push({ key: `p${i}`, group: Math.floor(rand() * groups), kind: rand() < 0.2 ? 'S' : 'K', teacher: Math.floor(rand() * teachers), lengths: [...pick(SHAPES)], window: 'ALL', block: null });
  }
  // Ett (klass, ämne) är en post och ett ämne är en post här, så klasserna kan inte krocka i nyckeln. En lärare i ett block får inte vara två medlemmar.
  for (const block of spec.blocks) {
    const seen = new Set<number>();
    for (const key of block.members) {
      const post = spec.posts.find((p) => p.key === key)!;
      while (seen.has(post.teacher)) post.teacher = (post.teacher + 1) % teachers;
      seen.add(post.teacher);
    }
  }
  return spec;
}

// ---------------------------------------------------------------------------
// Körningen
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const started = Date.now();
  if (!process.env['AI_ENGINE_URL'] || !process.env['AI_ENGINE_API_KEY']) {
    console.error('AI_ENGINE_URL och AI_ENGINE_API_KEY pekar ut den riktiga motorn som provet frågar.');
    process.exit(2);
  }
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
  process.env['NODE_ENV'] ??= 'test';
  process.env['JWT_SECRET'] ??= 'probe-secret-not-used-by-anything-here';
  process.env['JWT_ISSUER'] ??= 'https://probe.invalid/auth/v1';
  const { EnvironmentVariables } = await import('../../src/config/env.validation');
  for (const name of Object.keys(new EnvironmentVariables()).filter((key) => key.endsWith('_BACKGROUND'))) process.env[name] = 'off';
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../src/app.module');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  let violations = 0;
  try {
    violations = await run(owner, app, started);
  } finally {
    await app.close();
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]).catch((error: unknown) => console.error(`provets skola togs inte bort: ${summarise(error)}`));
    await owner.end();
  }
  process.exitCode = violations > 0 ? 1 : 0;
}

async function run(owner: Client, app: INestApplicationContext, started: number): Promise<number> {
  const { Role } = await import('../../src/auth/enums/role.enum');
  const { OptimizationProxyService } = await import('../../src/optimization/optimization-proxy.service');
  const { BlockPlacementsService } = await import('../../src/requirement-placements/block-placements.service');
  const { RequirementPlacementsService } = await import('../../src/requirement-placements/requirement-placements.service');
  const resolve = <T>(token: abstract new (...args: never[]) => T): T => app.get<T>(token as never, { strict: false });
  const proxy = resolve(OptimizationProxyService);
  const blocks = resolve(BlockPlacementsService);
  const postPlacements = resolve(RequirementPlacementsService);

  const seed = Number(process.env['SEED'] ?? 1);
  const from = Number(process.env['FROM'] ?? 0);
  const count = Number(process.env['WORLDS'] ?? 100);
  const only = process.env['ONLY'] !== undefined ? Number(process.env['ONLY']) : null;

  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const all = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;

  // Skolan, läsåret, administratören och salarna: en gång för alla världar.
  const s = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('Probe blockvärldar', $1, 'Europe/Stockholm', now()) RETURNING id`, [SLUG])).id;
  const year = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt") VALUES ($1, 'Probe 2095/96', $2, $3, true, now()) RETURNING id`,
      [s, YEAR_START, YEAR_END],
    )
  ).id;
  let counter = 0;
  const person = async (label: string, role: string, extra: { groupId?: string; adminProfile?: string } = {}) => {
    counter += 1;
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, 'Blockvärld', $4, $5, $6, true, $7, now()) RETURNING id`,
      [s, `${SLUG}-${label}-${counter}@example.invalid`, label, role, extra.adminProfile ?? null, authId, extra.groupId ?? null],
    );
    return { id: row.id, authId };
  };
  const adminRow = await person('admin', 'SCHOOL_ADMIN', { adminProfile: 'FULL' });
  const admin = { authId: adminRow.authId, userId: adminRow.id, schoolId: s, role: Role.SCHOOL_ADMIN, adminProfile: 'FULL', channel: 'WEB', hrRead: false } as AuthenticatedUser;
  const roomType = async (name: string) => (await one<{ id: string }>(`INSERT INTO "RoomTypes" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [s, name])).id;
  const types: Record<Kind, string> = { K: await roomType('BV Klassrum'), S: await roomType('BV Slöjdsal') };
  const roomKind = new Map<string, Kind>();
  for (const [kind, n] of [['K', 8], ['S', 2]] as const) {
    for (let i = 1; i <= n; i++) {
      const id = (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, capacity, "roomTypeId", "updatedAt") VALUES ($1, $2, 30, $3, now()) RETURNING id`, [s, `BV ${kind}-sal ${i}`, types[kind]])).id;
      roomKind.set(id, kind);
    }
  }

  // ------------------------------------------------------------------------
  // Att bygga och riva en värld
  // ------------------------------------------------------------------------
  interface Built {
    spec: WorldSpec;
    blockIds: string[];
    groupIds: string[];
    teacherIds: string[];
  }
  const dropWorld = async (): Promise<void> => {
    await owner.query(`DELETE FROM "MasterLessons" WHERE "academicYearId" = $1`, [year]);
    await owner.query(`DELETE FROM "TeachingRequirements" WHERE "academicYearId" = $1`, [year]);
    await owner.query(`DELETE FROM "TeachingBlocks" WHERE "academicYearId" = $1`, [year]);
    await owner.query(`DELETE FROM "Users" WHERE "schoolId" = $1 AND id <> $2`, [s, adminRow.id]);
    await owner.query(`DELETE FROM "StudentGroups" WHERE "academicYearId" = $1`, [year]);
    await owner.query(`DELETE FROM "Subjects" WHERE "schoolId" = $1`, [s]);
  };
  const build = async (spec: WorldSpec): Promise<Built> => {
    const groupIds: string[] = [];
    for (let g = 0; g < spec.groups; g++) {
      const id = (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'CLASS', 7, now()) RETURNING id`, [s, year, `BV klass ${g} v${spec.w}`])).id;
      await person(`elev-${g}`, 'STUDENT', { groupId: id });
      groupIds.push(id);
    }
    const teacherIds: string[] = [];
    for (let t = 0; t < spec.teachers; t++) teacherIds.push((await person(`lärare-${t}`, 'TEACHER')).id);
    const blockIds: string[] = [];
    for (const block of spec.blocks) blockIds.push((await one<{ id: string }>(`INSERT INTO "TeachingBlocks" ("schoolId", "academicYearId", name, "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [s, year, block.name])).id);
    for (const post of spec.posts) {
      post.groupId = groupIds[post.group]!;
      post.teacherId = teacherIds[post.teacher]!;
      post.subjectId = (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "requiredRoomTypeId", "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [s, `BV ämne ${post.key} v${spec.w}`, types[post.kind]])).id;
      const sorted = [...post.lengths].sort((a, b) => b - a);
      const mixed = new Set(sorted).size > 1;
      post.id = (
        await one<{ id: string }>(
          `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "lessonLengths", "blockId", "startDate", "endDate", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11::date, now()) RETURNING id`,
          [
            s,
            year,
            post.subjectId,
            post.groupId,
            post.teacherId,
            sorted.length,
            sorted[0],
            mixed ? sorted : [],
            post.block === null ? null : blockIds[post.block],
            post.window === 'VT' ? SPRING_START : null,
            post.window === 'HT' ? AUTUMN_END : null,
          ],
        )
      ).id;
    }
    return { spec, blockIds, groupIds, teacherIds };
  };

  // ------------------------------------------------------------------------
  // Domaren: ren SQL över MasterLessons, ingen rad av gatewayens kod
  // ------------------------------------------------------------------------
  interface MasterRow {
    id: string;
    groupId: string;
    subjectId: string;
    teacherId: string | null;
    roomId: string | null;
    day: number;
    start: string;
    end: string;
    minutes: number;
    recurrence: string;
    startDate: string | null;
    endDate: string | null;
    isLocked: boolean;
    isGenerated: boolean;
    fromPlacement: boolean;
  }
  const masterRows = (): Promise<MasterRow[]> =>
    all<MasterRow>(
      `SELECT id, "studentGroupId" AS "groupId", "subjectId", "teacherId", "roomId", "dayOfWeek" AS day,
              to_char("startTime", 'HH24:MI') AS start, to_char("endTime", 'HH24:MI') AS "end",
              (extract(epoch FROM "endTime" - "startTime") / 60)::int AS minutes,
              recurrence::text AS recurrence, "startDate"::text AS "startDate", "endDate"::text AS "endDate",
              "isLocked", "isGenerated", "fromPlacement"
         FROM "MasterLessons" WHERE "academicYearId" = $1 ORDER BY id`,
      [year],
    );
  const sameWeeks = (a: MasterRow, b: MasterRow): boolean =>
    (a.startDate ?? '0000-00-00') <= (b.endDate ?? '9999-99-99') &&
    (b.startDate ?? '0000-00-00') <= (a.endDate ?? '9999-99-99') &&
    !((a.recurrence === 'ODD_WEEKS' && b.recurrence === 'EVEN_WEEKS') || (a.recurrence === 'EVEN_WEEKS' && b.recurrence === 'ODD_WEEKS'));
  const tupleOf = (row: MasterRow) => `${row.day} ${row.start} ${row.minutes}`;

  const judge = async (built: Built, blockRows: BlockRow[], postRows: PostRow[]): Promise<string[]> => {
    const { spec } = built;
    const rows = await masterRows();
    const problems: string[] = [];
    const lessonsOf = (post: PostSpec) => rows.filter((row) => row.groupId === post.groupId && row.subjectId === post.subjectId);
    const placedOf = new Map<string, number>();
    // a) efterfrågan: antal, längder, lärare, fönster, vecka, och en sal av rätt typ
    for (const post of spec.posts) {
      const mine = lessonsOf(post);
      const want = [...post.lengths].sort((a, b) => b - a).join(',');
      const got = mine.map((row) => row.minutes).sort((a, b) => b - a).join(',');
      if (want !== got) problems.push(`post ${post.key}: längderna ska vara ${want}, är ${got}`);
      for (const row of mine) {
        if (row.teacherId !== post.teacherId) problems.push(`post ${post.key}: fel lärare på ${tupleOf(row)}`);
        if (row.recurrence !== 'ALL_WEEKS') problems.push(`post ${post.key}: ${row.recurrence} på ${tupleOf(row)}`);
        const startWant = post.window === 'VT' ? SPRING_START : null;
        const endWant = post.window === 'HT' ? AUTUMN_END : null;
        if (row.startDate !== startWant || row.endDate !== endWant) problems.push(`post ${post.key}: fönstret ${row.startDate}..${row.endDate} ska vara ${startWant}..${endWant}`);
        if (row.roomId === null || roomKind.get(row.roomId) !== post.kind) problems.push(`post ${post.key}: sal ${row.roomId === null ? 'saknas' : `av fel typ (${roomKind.get(row.roomId)})`} på ${tupleOf(row)}`);
        if (!row.isGenerated) problems.push(`post ${post.key}: en lektion som inte är genererad (${tupleOf(row)})`);
        if (row.isLocked && !row.fromPlacement) problems.push(`post ${post.key}: en låst lektion som inte är förlagd (${tupleOf(row)})`);
      }
      placedOf.set(post.key, mine.filter((row) => row.fromPlacement).length);
    }
    if (rows.length !== spec.posts.reduce((n, post) => n + post.lengths.length, 0)) problems.push(`${rows.length} lektioner, efterfrågan är ${spec.posts.reduce((n, post) => n + post.lengths.length, 0)}`);
    // b) blockraderna: exakt en märkt lektion per medlem och rad, på rätt plats, i sin sal eller en annan av rätt typ
    for (const [b, block] of spec.blocks.entries()) {
      const mineRows = blockRows.filter((row) => row.block === b);
      for (const key of block.members) {
        const post = spec.posts.find((p) => p.key === key)!;
        const marked = lessonsOf(post).filter((row) => row.fromPlacement);
        if (marked.length !== mineRows.length) problems.push(`block ${b}, post ${key}: ${marked.length} märkta lektioner för ${mineRows.length} blockrader`);
        const free = [...marked];
        for (const row of mineRows) {
          const at = free.findIndex((candidate) => candidate.day === row.day && candidate.start === row.start && candidate.minutes === row.minutes);
          if (at < 0) {
            problems.push(`block ${b}, post ${key}: ingen märkt lektion på ${row.day} ${row.start} ${row.minutes} (har ${marked.map(tupleOf).join('; ')})`);
            continue;
          }
          const [hit] = free.splice(at, 1);
          if (!hit!.isLocked || !hit!.isGenerated) problems.push(`block ${b}, post ${key}: den förlagda lektionen ${tupleOf(hit!)} är inte låst och genererad`);
          const chosen = row.rooms[key];
          if (chosen !== undefined && hit!.roomId !== chosen) problems.push(`block ${b}, post ${key}: lektionen ${tupleOf(hit!)} ligger i sal ${hit!.roomId}, skolan valde ${chosen}`);
        }
      }
      // e) resten ligger ihop: samma lista (dag, start, längd) hos alla medlemmar
      const lists = block.members.map((key) => lessonsOf(spec.posts.find((p) => p.key === key)!).map(tupleOf).sort());
      for (const [i, list] of lists.entries()) {
        if (JSON.stringify(list) !== JSON.stringify(lists[0])) problems.push(`block ${b}: medlem ${block.members[i]} ligger inte ihop med ${block.members[0]}: ${list.join('; ')} mot ${lists[0]!.join('; ')}`);
      }
    }
    // c) de vanliga posternas förlagda rader
    for (const post of spec.posts.filter((p) => p.block === null)) {
      const wantRows = postRows.filter((row) => row.post === post.key);
      const marked = lessonsOf(post).filter((row) => row.fromPlacement);
      if (marked.length !== wantRows.length) problems.push(`post ${post.key}: ${marked.length} märkta lektioner för ${wantRows.length} förlagda rader`);
      const free = [...marked];
      for (const row of wantRows) {
        const at = free.findIndex((candidate) => candidate.day === row.day && candidate.start === row.start && candidate.minutes === row.minutes);
        if (at < 0) {
          problems.push(`post ${post.key}: ingen märkt lektion på ${row.day} ${row.start} ${row.minutes}`);
          continue;
        }
        const [hit] = free.splice(at, 1);
        if (!hit!.isLocked) problems.push(`post ${post.key}: en förlagd lektion är inte låst`);
        if (row.roomId !== null && hit!.roomId !== row.roomId) problems.push(`post ${post.key}: en förlagd lektion med sal ${row.roomId} ligger i ${hit!.roomId}`);
      }
    }
    // d) ingen lärare, klass eller sal på två ställen samtidigt
    for (const [i, a] of rows.entries()) {
      for (const b of rows.slice(i + 1)) {
        if (a.day !== b.day || !(a.start < b.end && b.start < a.end) || !sameWeeks(a, b)) continue;
        if (a.groupId === b.groupId) problems.push(`krock: klass ${a.groupId} d${a.day} ${a.start}-${a.end} / ${b.start}-${b.end}`);
        if (a.teacherId !== null && a.teacherId === b.teacherId) problems.push(`krock: lärare ${a.teacherId} d${a.day} ${a.start}-${a.end} / ${b.start}-${b.end}`);
        if (a.roomId !== null && a.roomId === b.roomId) problems.push(`krock: sal ${a.roomId} d${a.day} ${a.start}-${a.end} / ${b.start}-${b.end}`);
      }
    }
    return problems;
  };

  // ------------------------------------------------------------------------
  // Domaren prövas själv: ett färdigt schema förstörs sex gånger och varje förstörelse ska ses
  // ------------------------------------------------------------------------
  const selfTest = async (): Promise<number> => {
    const spec = specOf(seed, 100000);
    // En fast, enkel värld: ett block om tre poster på två lektioner, en lektion förlagd (tisdag 10:00), ett par vanliga poster bredvid.
    spec.family = 'plain';
    spec.roomMode = 'none';
    spec.blocks = [{ name: 'W-självprov block', window: 'ALL', members: ['b0m0', 'b0m1', 'b0m2'] }];
    spec.posts = [
      ...[0, 1, 2].map((m): PostSpec => ({ key: `b0m${m}`, group: m, kind: 'K', teacher: m, lengths: [60, 60], window: 'ALL', block: 0 })),
      { key: 'p0', group: 3, kind: 'K', teacher: 5, lengths: [60, 60, 60], window: 'ALL', block: null },
    ];
    const built = await build(spec);
    try {
      await blocks.replace(built.blockIds[0]!, { placements: [{ dayOfWeek: 2, startTime: '10:00', minutes: 60 }] } as never, admin);
      const answer = await proxy.triggerScheduling(year, admin);
      assert.ok(['OPTIMAL', 'FEASIBLE'].includes(answer.status), `självprovets värld löstes inte: ${answer.status}`);
      const rows: BlockRow[] = [{ block: 0, day: 2, start: '10:00', minutes: 60, rooms: {} }];
      assert.deepEqual(await judge(built, rows, []), [], 'domaren ska godta ett riktigt schema');
      const idOf = (key: string) => spec.posts.find((p) => p.key === key)!;
      const corruptions: Array<[string, () => Promise<void>]> = [
        ['en märkt lektion flyttad en timme', async () => void (await owner.query(`UPDATE "MasterLessons" SET "startTime" = '11:00', "endTime" = '12:00' WHERE "academicYearId" = $1 AND "studentGroupId" = $2 AND "fromPlacement"`, [year, idOf('b0m0').groupId]))],
        ['ett märke borttaget', async () => void (await owner.query(`UPDATE "MasterLessons" SET "fromPlacement" = false WHERE "academicYearId" = $1 AND "studentGroupId" = $2 AND "fromPlacement"`, [year, idOf('b0m1').groupId]))],
        ['två medlemmar i samma sal samtidigt', async () => void (await owner.query(`UPDATE "MasterLessons" SET "roomId" = (SELECT "roomId" FROM "MasterLessons" WHERE "academicYearId" = $1 AND "studentGroupId" = $2 AND "fromPlacement") WHERE "academicYearId" = $1 AND "studentGroupId" = $3 AND "fromPlacement"`, [year, idOf('b0m0').groupId, idOf('b0m1').groupId]))],
        ['en medlems andra lektion skild från de andras', async () => void (await owner.query(`UPDATE "MasterLessons" SET "dayOfWeek" = CASE WHEN "dayOfWeek" = 5 THEN 4 ELSE 5 END WHERE id = (SELECT id FROM "MasterLessons" WHERE "academicYearId" = $1 AND "studentGroupId" = $2 AND NOT "fromPlacement" LIMIT 1)`, [year, idOf('b0m2').groupId]))],
        ['en lärare på två ställen', async () => void (await owner.query(`UPDATE "MasterLessons" SET "teacherId" = $3 WHERE "academicYearId" = $1 AND "studentGroupId" = $2 AND "fromPlacement"`, [year, idOf('b0m1').groupId, idOf('b0m0').teacherId]))],
        ['en lektion för mycket', async () => void (await owner.query(`INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "isGenerated", "updatedAt") VALUES ($1, $2, $3, $4, $5, 1, '16:00', '17:00', true, now())`, [s, year, idOf('p0').subjectId, idOf('p0').groupId, idOf('p0').teacherId]))],
      ];
      let seen = 0;
      for (const [label, corrupt] of corruptions) {
        // Förstörelsen görs i en transaktion på samma anslutning som domaren läser med, och rullas tillbaka.
        await owner.query('BEGIN');
        try {
          await corrupt();
          const problems = await judge(built, rows, []);
          if (problems.length === 0) console.error(`SJÄLVPROV: domaren såg inte "${label}"`);
          else seen += 1;
        } finally {
          await owner.query('ROLLBACK');
        }
      }
      assert.deepEqual(await judge(built, rows, []), [], 'domaren ska godta det återställda schemat');
      console.log(`självprov: domaren såg ${seen} av ${corruptions.length} medvetna fel`);
      return corruptions.length - seen;
    } finally {
      await dropWorld();
    }
  };

  // ------------------------------------------------------------------------
  // Världarna
  // ------------------------------------------------------------------------
  const stats = {
    seed,
    from,
    worlds: 0,
    ok: 0,
    baseUnsolved: 0,
    violations: 0,
    saveRefused: 0,
    refusedWithPlacements: 0,
    slow: 0,
    blockRowsSaved: 0,
    pinnedLessonsOfBlocks: 0,
    postRowsPinned: 0,
    postRowsLocked: 0,
    secondRuns: 0,
    byFamily: {} as Record<string, number>,
    byRoomMode: {} as Record<string, number>,
    byPlaceMode: {} as Record<string, number>,
    byMembers: {} as Record<string, number>,
    mixedLengthBlocks: 0,
    maxSeconds: 0,
  };
  const bump = (bucket: Record<string, number>, key: string) => void (bucket[key] = (bucket[key] ?? 0) + 1);

  console.log(`blockvärldar seed=${seed} från ${from}, ${only !== null ? `bara värld ${only}` : `${count} världar`}; last ${loadavg()[0]!.toFixed(1)}`);
  const selfFailures = await selfTest();
  if (selfFailures > 0) {
    console.error(`==> självprovet FAILED: domaren missade ${selfFailures} medvetna fel`);
    return selfFailures;
  }

  const solve = async (): Promise<{ status: string; lines: Array<[string, unknown]>; thrown?: string }> => {
    try {
      const answer = await proxy.triggerScheduling(year, admin);
      return { status: answer.status, lines: (answer.conflicts?.conflicts ?? []).map((line) => [line.code, line.params] as [string, unknown]) };
    } catch (error) {
      return { status: 'THROWN', lines: [], thrown: summarise(error) };
    }
  };
  const worlds = only !== null ? [only] : Array.from({ length: count }, (_, i) => from + i);
  for (const w of worlds) {
    const spec = specOf(seed, w);
    const t0 = Date.now();
    await dropWorld();
    const built = await build(spec);
    const blockRows: BlockRow[] = [];
    const postRows: PostRow[] = [];
    const fail = async (what: string, extra: string[] = []): Promise<void> => {
      stats.violations += 1;
      console.error(`FEL värld ${w} (seed ${seed}; återge med SEED=${seed} ONLY=${w}): ${what}`);
      for (const line of extra.slice(0, 12)) console.error(`     ${line}`);
      console.error(
        `     scenario: ${JSON.stringify({
          family: spec.family,
          roomMode: spec.roomMode,
          placeMode: spec.placeMode,
          blocks: spec.blocks,
          posts: spec.posts.map((p) => ({ key: p.key, grupp: p.group, typ: p.kind, lärare: p.teacher, längder: p.lengths, fönster: p.window, block: p.block })),
          blockRows,
          postRows,
        })}`,
      );
    };
    try {
      stats.worlds += 1;
      bump(stats.byFamily, spec.family);
      bump(stats.byRoomMode, spec.roomMode);
      bump(stats.byPlaceMode, spec.placeMode);
      for (const block of spec.blocks) bump(stats.byMembers, String(block.members.length));
      stats.mixedLengthBlocks += spec.blocks.filter((block) => new Set(spec.posts.find((p) => p.key === block.members[0])!.lengths).size > 1).length;

      // 1. ett giltigt schema utan förläggningar
      const base = await solve();
      if (!['OPTIMAL', 'FEASIBLE'].includes(base.status)) {
        stats.baseUnsolved += 1;
        console.log(`värld ${w}: motorn löste inte grunden (${base.status} ${base.thrown ?? JSON.stringify(base.lines).slice(0, 160)}), hoppas över`);
        continue;
      }
      const baseRows = await masterRows();
      const rand = prng((seed * 7919 + w * 104729) >>> 0);
      const shuffle = <T,>(items: T[]): T[] => {
        const copy = [...items];
        for (let i = copy.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [copy[i], copy[j]] = [copy[j]!, copy[i]!];
        }
        return copy;
      };

      // 2. blockens förläggningar tas ur schemat
      for (const [b, block] of spec.blocks.entries()) {
        const members = block.members.map((key) => spec.posts.find((p) => p.key === key)!);
        const lead = baseRows.filter((row) => row.groupId === members[0]!.groupId && row.subjectId === members[0]!.subjectId);
        const wanted = spec.placeMode === 'all' ? lead.length : 1 + Math.floor(rand() * Math.max(1, lead.length - (lead.length > 1 ? 1 : 0)));
        const chosen = shuffle(lead).slice(0, Math.min(wanted, lead.length));
        const sheet: Array<{ dayOfWeek: number; startTime: string; minutes: number; rooms?: Array<{ requirementId: string; roomId: string }> }> = [];
        for (const lesson of chosen) {
          const rooms: Record<string, string> = {};
          for (const member of members) {
            const theirs = baseRows.find((row) => row.groupId === member.groupId && row.subjectId === member.subjectId && row.day === lesson.day && row.start === lesson.start && row.minutes === lesson.minutes);
            const withRoom = spec.roomMode === 'all' || (spec.roomMode === 'some' && rand() < 0.5);
            if (withRoom && theirs?.roomId) rooms[member.key] = theirs.roomId;
          }
          blockRows.push({ block: b, day: lesson.day, start: lesson.start, minutes: lesson.minutes, rooms });
          sheet.push({
            dayOfWeek: lesson.day,
            startTime: lesson.start,
            minutes: lesson.minutes,
            ...(Object.keys(rooms).length > 0 ? { rooms: Object.entries(rooms).map(([key, roomId]) => ({ requirementId: spec.posts.find((p) => p.key === key)!.id!, roomId })) } : {}),
          });
        }
        try {
          await blocks.replace(built.blockIds[b]!, { placements: sheet } as never, admin);
          stats.blockRowsSaved += sheet.length;
          stats.pinnedLessonsOfBlocks += sheet.length * members.length;
        } catch (error) {
          stats.saveRefused += 1;
          await fail(`förlägget ur ett giltigt schema vägrades vid sparningen: ${summarise(error)}`, [`rader: ${JSON.stringify(sheet)}`]);
          throw new SkipWorld();
        }
      }
      // en vanlig posts lektion bredvid, i var fjärde värld: utan sal (ett fäste) eller med (ett lås)
      if (w % 4 === 1) {
        const candidates = spec.posts.filter((p) => p.block === null);
        const post = candidates[Math.floor(rand() * candidates.length)];
        if (post) {
          const lesson = baseRows.filter((row) => row.groupId === post.groupId && row.subjectId === post.subjectId)[0];
          if (lesson) {
            const withRoom = rand() < 0.5 && lesson.roomId !== null;
            const row: PostRow = { post: post.key, day: lesson.day, start: lesson.start, minutes: lesson.minutes, roomId: withRoom ? lesson.roomId : null };
            try {
              await postPlacements.replace(post.id!, { placements: [{ dayOfWeek: row.day, startTime: row.start, minutes: row.minutes, recurrence: 'ALL_WEEKS', ...(row.roomId ? { roomId: row.roomId } : {}) }] } as never, admin);
              postRows.push(row);
              if (row.roomId) stats.postRowsLocked += 1;
              else stats.postRowsPinned += 1;
            } catch (error) {
              stats.saveRefused += 1;
              await fail(`en vanlig posts förlägg ur ett giltigt schema vägrades: ${summarise(error)}`, [`rad: ${JSON.stringify(row)}`]);
              throw new SkipWorld();
            }
          }
        }
      }

      // 3. Generera igen, på riktigt
      const again = await solve();
      if (!['OPTIMAL', 'FEASIBLE'].includes(again.status)) {
        stats.refusedWithPlacements += 1;
        await fail(`Generera vägrades trots att ett giltigt schema innehåller förläggningarna: ${again.status} ${again.thrown ?? ''}`, again.lines.map((line) => JSON.stringify(line)));
        continue;
      }
      // 4. domaren
      const problems = await judge(built, blockRows, postRows);
      if (problems.length > 0) {
        await fail('domaren fällde resultatet', problems);
        continue;
      }
      if (w % 4 === 0) {
        stats.secondRuns += 1;
        const third = await solve();
        if (!['OPTIMAL', 'FEASIBLE'].includes(third.status)) {
          stats.refusedWithPlacements += 1;
          await fail(`den andra körningen vägrades: ${third.status} ${third.thrown ?? ''}`, third.lines.map((line) => JSON.stringify(line)));
          continue;
        }
        const problems2 = await judge(built, blockRows, postRows);
        if (problems2.length > 0) {
          await fail('domaren fällde den andra körningens resultat', problems2);
          continue;
        }
      }
      stats.ok += 1;
    } catch (error) {
      if (!(error instanceof SkipWorld)) await fail(`oväntat fel: ${summarise(error)}`);
    } finally {
      const seconds = (Date.now() - t0) / 1000;
      stats.maxSeconds = Math.max(stats.maxSeconds, seconds);
      if (seconds > 5) {
        stats.slow += 1;
        console.log(`värld ${w}: ${seconds.toFixed(1)} s (över 5 s)`);
      }
      await dropWorld();
    }
    if (stats.worlds % 10 === 0) console.log(`  ... ${stats.worlds} världar, ${stats.violations} fel, ${Math.round((Date.now() - started) / 1000)} s, last ${loadavg()[0]!.toFixed(1)}`);
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  console.log(`RESULT ${JSON.stringify({ ...stats, maxSeconds: Math.round(stats.maxSeconds * 10) / 10, totalSeconds: seconds, loadEnd: Number(loadavg()[0]!.toFixed(1)) })}`);
  console.log(stats.violations > 0 ? `==> Blockvärldar FAILED: ${stats.violations} fel i ${stats.worlds} världar (seed ${seed}) på ${seconds} s` : `==> Blockvärldar passed: ${stats.ok} av ${stats.worlds} världar (${stats.baseUnsolved} olösta grunder), 0 fel (seed ${seed}) på ${seconds} s`);
  return stats.violations;
}

/** Världen hoppas över i fortsättningen utan ett fel till (felet är redan skrivet). */
class SkipWorld extends Error {}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
