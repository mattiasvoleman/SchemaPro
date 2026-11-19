/**
 * The adapter probe's checks for Behörighet som i ett annat ämne (20270225090000): Subjects."qualificationSubjectId",
 * the subject whose teachers' behörigheter a subject uses ("SO WS" -> "SO"), through the real services on the API's
 * role and real Postgres as CI runs it. In two schools of their own (slugs <marker>-behorighet and -b), swept whole
 * before and after:
 *
 *   bi1  the full administrator makes "SO" and "SO WS" with the pointer, moves and clears it, and deletes the source: the
 *        subject that used it keeps its row and its school with the pointer cleared (the key's SET NULL on the column
 *        alone, through @prisma/adapter-pg); the service's own asks answer 409 with the code and the subjects named
 *        for a chain, for the heir of a source and for a subject pointed at itself, 400 for another school's subject
 *        and for one that is not there; a teacher writes nothing;
 *   bi2  what the service asks first is what a writer that did not ask meets: the trigger's QS409 comes through the
 *        adapter as P2039 (a model call) and as P2010 (raw SQL), is read by qualificationSourceRefusal, and is answered
 *        as the same 409 by rethrowPrismaError, for both reasons;
 *   bi3  two writers at once: X -> Y in one transaction and Y -> Z in another, ten rounds, in both orders: the school's
 *        advisory lock makes them take turns, so exactly one stands and the other is QS409, and no round leaves a chain;
 *   bi4  the readers, on real rows: readHeldQualifications returns the stored rows and a copy under each using subject,
 *        scoped and unscoped; a subject whose pointer is gone derives nothing; the list endpoint's service answers the
 *        stored rows by default and the derived ones, marked and with ids of their own, on ?inherited=true; the school
 *        export's list is the stored rows alone;
 *   bi5  the report and its readers agree: a teacher with SO on a post in SO WS is listed as unqualified without the
 *        pointer and is not with it, with the SO row's årskurser kept (a row for åk 1–6 does not reach åk 8).
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { rethrowPrismaError, qualificationSourceRefusal } from '../../src/common/utils/prisma-errors';
import type { PrismaService } from '../../src/database/prisma.service';
import { SubjectsService } from '../../src/resources/subjects.service';
import { readHeldQualifications } from '../../src/staffing/qualification-inheritance';
import { StaffingLoadService } from '../../src/staffing/staffing-load.service';
import { TeacherQualificationsService } from '../../src/staffing/teacher-qualifications.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function behorighetSlug(marker: string): string {
  return `${marker}-behorighet`;
}

export async function sweepBehorighetSchools(owner: Client, marker: string): Promise<void> {
  const slug = behorighetSlug(marker);
  await owner.query(`DELETE FROM "Schools" WHERE slug IN ($1, $2)`, [slug, `${slug}-b`]);
}

const rejectsWith = async (body: () => Promise<unknown>, status: number | number[], code?: string) => {
  await assert.rejects(body, (error: { getStatus?: () => number; getResponse?: () => unknown }) => {
    const wanted = Array.isArray(status) ? status : [status];
    assert.ok(wanted.includes(error.getStatus?.() ?? -1), `status ${String(error.getStatus?.())}: ${JSON.stringify(error.getResponse?.() ?? error)}`);
    if (code !== undefined) assert.equal((error.getResponse?.() as { code?: string } | undefined)?.code, code);
    return true;
  });
};

export async function behorighetChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepBehorighetSchools(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const today = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS d`)).d;
  const school = async (slug: string, name: string) =>
    (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [name, slug])).id;
  const a = await school(behorighetSlug(marker), `${marker} behörighet`);
  const b = await school(`${behorighetSlug(marker)}-b`, `${marker} behörighet b`);
  const person = async (schoolId: string, role: string, label: string, profile: string | null = null) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
       VALUES ($1, $2, $3, 'Probe', $4::"UserRole", $5::"AdminProfile", $6, true, now()) RETURNING id`,
      [schoolId, `${marker}-behorighet-${label}@example.invalid`, label, role, profile, authId],
    );
    return { id: row.id, authId };
  };
  const user = (schoolId: string, who: { id: string; authId: string }, role: Role, adminProfile?: AuthenticatedUser['adminProfile']): AuthenticatedUser => ({
    authId: who.authId,
    userId: who.id,
    schoolId,
    role,
    channel: 'WEB',
    ...(adminProfile ? { adminProfile } : {}),
  });
  const full = await person(a, 'SCHOOL_ADMIN', 'full', 'FULL');
  const fullB = await person(b, 'SCHOOL_ADMIN', 'full-b', 'FULL');
  const anna = await person(a, 'TEACHER', 'anna');
  const bo = await person(a, 'TEACHER', 'bo');
  const asFull = user(a, full, Role.SCHOOL_ADMIN, 'FULL');
  const asFullB = user(b, fullB, Role.SCHOOL_ADMIN, 'FULL');
  const asAnna = user(a, anna, Role.TEACHER);
  const subjects = new SubjectsService(api);
  const qualifications = new TeacherQualificationsService(api);

  const pointerOf = async (id: string) => (await one<{ q: string | null; s: string }>(`SELECT "qualificationSubjectId" AS q, "schoolId" AS s FROM "Subjects" WHERE id = $1`, [id]));

  try {
    await check('(bi1) the administrator points, moves, clears and deletes a source; the service names a refusal in Swedish', async () => {
      const so = await subjects.create({ name: 'SO' }, asFull);
      const ws = await subjects.create({ name: 'SO WS', qualificationSubjectId: so.id }, asFull);
      assert.equal(ws.qualificationSubjectId, so.id);
      assert.equal(so.qualificationSubjectId, null);
      const kemi = await subjects.create({ name: 'Kemi' }, asFull);
      // Moved to another source, cleared, set again: three states, as for the national code.
      assert.equal((await subjects.update(ws.id, { qualificationSubjectId: kemi.id }, asFull)).qualificationSubjectId, kemi.id);
      assert.equal((await subjects.update(ws.id, { name: 'SO WS 2' }, asFull)).qualificationSubjectId, kemi.id, 'absent leaves it');
      assert.equal((await subjects.update(ws.id, { qualificationSubjectId: null }, asFull)).qualificationSubjectId, null);
      await subjects.update(ws.id, { qualificationSubjectId: so.id }, asFull);

      // The service's own asks: each a 409 with a code of its own and the subjects named.
      await rejectsWith(() => subjects.update(so.id, { qualificationSubjectId: so.id }, asFull), 409, 'SUBJECT_QUALIFICATION_IS_ITSELF');
      await rejectsWith(() => subjects.update(kemi.id, { qualificationSubjectId: ws.id }, asFull), 409, 'SUBJECT_QUALIFICATION_SOURCE_INHERITS');
      await rejectsWith(() => subjects.update(so.id, { qualificationSubjectId: kemi.id }, asFull), 409, 'SUBJECT_QUALIFICATION_IS_INHERITED');
      const inherited = await subjects.update(so.id, { qualificationSubjectId: kemi.id }, asFull).catch((e: { getResponse: () => { message: string } }) => e.getResponse().message);
      assert.match(String(inherited), /Ämnet "SO WS 2" har behörighet som i det här ämnet/);
      // Another school's subject is not one of this school's: the same 400 as one that is not there.
      const foreign = await subjects.create({ name: 'SO annan' }, asFullB);
      await rejectsWith(() => subjects.update(ws.id, { qualificationSubjectId: foreign.id }, asFull), 400, 'SUBJECT_QUALIFICATION_SOURCE_NOT_FOUND');
      await rejectsWith(() => subjects.update(ws.id, { qualificationSubjectId: randomUUID() }, asFull), 400, 'SUBJECT_QUALIFICATION_SOURCE_NOT_FOUND');
      await rejectsWith(() => subjects.create({ name: 'Y', qualificationSubjectId: foreign.id }, asFull), 400, 'SUBJECT_QUALIFICATION_SOURCE_NOT_FOUND');
      // A teacher writes nothing.
      await rejectsWith(() => subjects.update(ws.id, { qualificationSubjectId: null }, asAnna), [403, 404]);
      assert.equal((await pointerOf(ws.id)).q, so.id);

      // The source goes: the subject that used it keeps its row and its school, the pointer cleared (SET NULL on the column alone).
      await subjects.remove(so.id, asFull);
      const after = await pointerOf(ws.id);
      assert.equal(after.q, null, 'the pointer is cleared');
      assert.equal(after.s, a, 'the school stays');
    });

    await check('(bi2) the trigger’s refusal reaches the gateway as P2039 and P2010 and is answered as the service answers it', async () => {
      const x = await subjects.create({ name: 'bi2 X' }, asFull);
      const y = await subjects.create({ name: 'bi2 Y' }, asFull);
      const z = await subjects.create({ name: 'bi2 Z' }, asFull);
      await subjects.update(x.id, { qualificationSubjectId: y.id }, asFull);

      // The writes the service did not ask about: straight through the model delegate, and as raw SQL.
      const viaModel = (id: string, source: string) =>
        api.withRls(asFull, (tx) => tx.subject.update({ where: { id }, data: { qualificationSubjectId: source } }));
      const viaRaw = (id: string, source: string) =>
        api.withRls(asFull, (tx) => tx.$executeRaw`UPDATE "Subjects" SET "qualificationSubjectId" = ${source}::uuid WHERE id = ${id}::uuid`);

      for (const [shape, write] of [['a model call', viaModel], ['raw SQL', viaRaw]] as const) {
        // Y -> Z while X -> Y: Y is a source, so it may take none (IS_INHERITED); z -> x: x inherits (SOURCE_INHERITS).
        const heir = await write(y.id, z.id).then(
          () => null,
          (error: unknown) => error,
        );
        assert.ok(heir, `${shape}: the chain was written`);
        assert.deepEqual(
          { ...qualificationSourceRefusal(heir) },
          { code: 'SUBJECT_QUALIFICATION_IS_INHERITED', subjectId: y.id, sourceId: null, inheritorId: x.id },
          `${shape}: ${String((heir as Error).message).slice(0, 200)}`,
        );
        assert.throws(
          () => rethrowPrismaError(heir),
          (e: { getStatus?: () => number; getResponse?: () => { code?: string; params?: Record<string, string> } }) =>
            e.getStatus?.() === 409 && e.getResponse?.().code === 'SUBJECT_QUALIFICATION_IS_INHERITED' && e.getResponse?.().params?.['inheritorId'] === x.id,
        );
        const chain = await write(z.id, x.id).then(
          () => null,
          (error: unknown) => error,
        );
        assert.ok(chain, `${shape}: the chain was written the other way`);
        assert.deepEqual(
          { ...qualificationSourceRefusal(chain) },
          { code: 'SUBJECT_QUALIFICATION_SOURCE_INHERITS', subjectId: z.id, sourceId: x.id, inheritorId: null },
          `${shape}: ${String((chain as Error).message).slice(0, 200)}`,
        );
        assert.throws(
          () => rethrowPrismaError(chain),
          (e: { getStatus?: () => number; getResponse?: () => { code?: string } }) => e.getStatus?.() === 409 && e.getResponse?.().code === 'SUBJECT_QUALIFICATION_SOURCE_INHERITS',
        );
      }
      // And a subject pointed at itself meets the CHECK, which the gateway's service would have named first.
      await assert.rejects(() => viaModel(z.id, z.id), (error: { code?: string; message?: string }) => qualificationSourceRefusal(error) === null && /check|23514/i.test(String(error.message)));
      assert.equal((await pointerOf(y.id)).q, null);
      assert.equal((await pointerOf(z.id)).q, null);
    });

    await check('(bi3) two writers at once take turns: exactly one of X -> Y and Y -> Z stands, ten rounds, both orders', async () => {
      for (let round = 0; round < 10; round += 1) {
        const [x, y, z] = await Promise.all(['X', 'Y', 'Z'].map((n) => subjects.create({ name: `bi3 ${round} ${n}` }, asFull)));
        const write = (id: string, source: string) =>
          api.withRls(asFull, (tx) => tx.subject.update({ where: { id }, data: { qualificationSubjectId: source } }));
        const writers = round % 2 === 0 ? [() => write(x!.id, y!.id), () => write(y!.id, z!.id)] : [() => write(y!.id, z!.id), () => write(x!.id, y!.id)];
        const results = await Promise.allSettled(writers.map((go) => go()));
        const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
        const refusals = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => qualificationSourceRefusal(r.reason)?.code ?? String(r.reason));
        assert.equal(fulfilled, 1, `round ${round}: ${fulfilled} writers stood, refusals ${JSON.stringify(refusals)}`);
        assert.equal(refusals.length, 1);
        assert.ok(
          ['SUBJECT_QUALIFICATION_IS_INHERITED', 'SUBJECT_QUALIFICATION_SOURCE_INHERITS'].includes(refusals[0]!),
          `round ${round}: the loser met ${refusals[0]}`,
        );
        const standing = (await owner.query(`SELECT id FROM "Subjects" WHERE id = ANY($1::uuid[]) AND "qualificationSubjectId" IS NOT NULL`, [[x!.id, y!.id, z!.id]])).rowCount;
        assert.equal(standing, 1, `round ${round}: ${standing} links stand: a chain`);
      }
    });

    await check('(bi4) the readers return the stored rows and a copy under each using subject; the list and the export say which', async () => {
      const so = await subjects.create({ name: 'bi4 SO' }, asFull);
      const ws = await subjects.create({ name: 'bi4 SO WS', qualificationSubjectId: so.id }, asFull);
      const ws2 = await subjects.create({ name: 'bi4 SO fördjupning', qualificationSubjectId: so.id }, asFull);
      const ma = await subjects.create({ name: 'bi4 MA' }, asFull);
      const stored = async (userId: string, subjectId: string, min: number, max: number, kind: string, validTo: string | null = null) =>
        (
          await one<{ id: string }>(
            `INSERT INTO "TeacherSubjectQualifications" ("schoolId", "userId", "subjectId", "minGradeLevel", "maxGradeLevel", kind, "validTo", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6::"TeacherQualificationKind", $7::date, now()) RETURNING id`,
            [a, userId, subjectId, min, max, kind, validTo],
          )
        ).id;
      const annaSo = await stored(anna.id, so.id, 7, 9, 'LEGITIMATION', `${today.slice(0, 4)}-12-31`);
      await stored(bo.id, ma.id, 1, 9, 'BEHORIG');

      const all = await api.withRls(asFull, (tx) => readHeldQualifications(tx));
      const mine = all.filter((row) => row.userId === anna.id);
      assert.deepEqual(
        mine.map((row) => [row.subjectId, row.viaSubjectId ?? null, row.kind, row.minGradeLevel, row.maxGradeLevel]).sort(),
        [
          [so.id, null, 'LEGITIMATION', 7, 9],
          [ws.id, so.id, 'LEGITIMATION', 7, 9],
          [ws2.id, so.id, 'LEGITIMATION', 7, 9],
        ].sort(),
      );
      assert.equal(mine.find((row) => row.subjectId === ws.id)!.validTo?.toISOString().slice(0, 10), `${today.slice(0, 4)}-12-31`, 'the validity follows the source');
      assert.equal(all.filter((row) => row.userId === bo.id).length, 1, 'Bo holds MA alone and nothing is derived from it');

      const scoped = await api.withRls(asFull, (tx) => readHeldQualifications(tx, { subjectIds: [ws.id] }));
      assert.deepEqual(scoped.map((row) => [row.userId, row.subjectId, row.viaSubjectId ?? null]), [[anna.id, ws.id, so.id]]);
      assert.deepEqual(await api.withRls(asFull, (tx) => readHeldQualifications(tx, { subjectIds: [] })), []);

      // The list endpoint's service: stored by default, derived and marked on request, every id of a list unique.
      const plain = await qualifications.list(undefined, asFull);
      assert.equal(plain.filter((row) => row.userId === anna.id).length, 1);
      assert.ok(plain.every((row) => row.viaSubjectId === undefined));
      const withDerived = await qualifications.list(undefined, asFull, { inherited: true });
      const annas = withDerived.filter((row) => row.userId === anna.id);
      assert.equal(annas.length, 3);
      assert.deepEqual(annas.filter((row) => row.viaSubjectId !== undefined).map((row) => [row.subjectId, row.viaSubjectId]).sort(), [[ws.id, so.id], [ws2.id, so.id]].sort());
      assert.equal(new Set(withDerived.map((row) => row.id)).size, withDerived.length);
      assert.ok(annas.some((row) => row.id === annaSo && row.viaSubjectId === undefined), 'the stored row keeps its own id');

      // The school export lists what the table holds: three rows are stored for the school, never five.
      const exported = (await owner.query(`SELECT count(*)::int AS n FROM "TeacherSubjectQualifications" WHERE "schoolId" = $1`, [a])).rows[0]!.n as number;
      assert.equal(exported, 2);

      // The source's rows removed with the source: the subjects that used it hold nothing.
      await subjects.remove(so.id, asFull);
      const afterRemoval = await api.withRls(asFull, (tx) => readHeldQualifications(tx));
      assert.equal(afterRemoval.filter((row) => row.userId === anna.id).length, 0, 'the stored row went with its subject and nothing is derived from it');
      assert.equal((await pointerOf(ws.id)).q, null);
    });

    await check('(bi5) the load report lists a SO teacher on a SO WS post as unqualified without the pointer, and not with it', async () => {
      const year = await one<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
         VALUES ($1, 'probe behörighet', '${today}'::date - 30, '${today}'::date + 300, true, 'NIOARIG', now()) RETURNING id`,
        [a],
      );
      const group = await one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt") VALUES ($1, $2, 'BI8A', 8, now()) RETURNING id`,
        [a, year.id],
      );
      const so = await subjects.create({ name: 'bi5 SO' }, asFull);
      const ws = await subjects.create({ name: 'bi5 SO WS' }, asFull);
      await owner.query(
        `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "reductionPercent", "updatedAt") VALUES ($1, $2, $3, 100, 0, now()), ($1, $4, $3, 100, 0, now())`,
        [a, anna.id, year.id, bo.id],
      );
      await owner.query(
        `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "updatedAt") VALUES ($1, $2, $3, $4, $5, 2, 60, now())`,
        [a, year.id, ws.id, group.id, anna.id],
      );
      // Anna holds SO for åk 7–9; Bo holds SO for åk 1–6 only, and leads nothing.
      for (const [teacher, min, max] of [[anna.id, 7, 9], [bo.id, 1, 6]] as const) {
        await owner.query(
          `INSERT INTO "TeacherSubjectQualifications" ("schoolId", "userId", "subjectId", "minGradeLevel", "maxGradeLevel", kind, "updatedAt") VALUES ($1, $2, $3, $4, $5, 'BEHORIG', now())`,
          [a, teacher, so.id, min, max],
        );
      }
      const load = new StaffingLoadService(api);
      const unqualified = async () => (await load.load(year.id, undefined, asFull, { record: false })).unqualifiedAssignments.map((row) => [row.userId, row.subjectId]);

      assert.deepEqual(await unqualified(), [[anna.id, ws.id]], 'without the pointer: the SO teacher on the SO WS post is flagged');
      await subjects.update(ws.id, { qualificationSubjectId: so.id }, asFull);
      assert.deepEqual(await unqualified(), [], 'with the pointer: she is not');
      // The source row's årskurser are kept: a 1–6 row does not reach the åk 8 post.
      await owner.query(`UPDATE "TeacherSubjectQualifications" SET "minGradeLevel" = 1, "maxGradeLevel" = 6 WHERE "userId" = $1 AND "subjectId" = $2`, [anna.id, so.id]);
      assert.deepEqual(await unqualified(), [[anna.id, ws.id]], 'a 1–6 row of the source does not cover åk 8');
      await subjects.update(ws.id, { qualificationSubjectId: null }, asFull);
      assert.deepEqual(await unqualified(), [[anna.id, ws.id]]);
    });
  } finally {
    await sweepBehorighetSchools(owner, marker);
  }
}
