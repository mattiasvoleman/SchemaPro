import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import { AckService } from '../ack/ack.service';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { todayInZone } from '../common/utils/time';
import { PrismaService } from '../database/prisma.service';
import {
  CHECKLIST_DATE_IN_THE_FUTURE,
  CHECKLIST_DATE_INVALID,
  CHECKLIST_NOT_FOUND,
  CHECKLIST_NOT_YOUR_PUPIL,
  CHECKLIST_UNKNOWN_PUPIL,
  CONSENT_FOOTER,
  CONSENT_KVITTENS_OFF,
  CONSENT_LIST_CLOSED,
  CONSENT_LIST_EXISTS,
  CONSENT_NOBODY_TO_ASK,
  CONSENT_NOT_A_CLASS,
  CONSENT_NOT_YOUR_CLASS,
  CONSENT_TITLE_PREFIX,
  TITLE_MAX,
  adminWrites,
  canVoidProof,
  messageOf,
  protectedAmong,
  translateRefusal,
} from './checklists';
import type {
  ChecklistSettings,
  ConsentAsked,
  ConsentClosed,
  ConsentDetail,
  ConsentEntryView,
  ConsentListItem,
  ConsentRow,
  ConsentWritten,
  PupilCard,
} from './checklists-views';
import { consentStateOf, countStates, inOrder, type ConsentKind, type StateAsk } from './consent-state';
import type { AskConsentDto, ConsentListsQueryDto, CreateConsentListDto, RecordConsentDto } from './dto/checklists.dto';

const fullName = (person: { firstName: string; lastName: string }) => `${person.firstName} ${person.lastName}`;
const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const asDay = (day: string) => new Date(`${day}T00:00:00.000Z`);
/** The guardian's title of a consent request: the list's, after the prefix, at most the request's 120 characters. */
const requestTitle = (listTitle: string) => {
  const whole = `${CONSENT_TITLE_PREFIX}${listTitle}`;
  return whole.length <= TITLE_MAX ? whole : `${whole.slice(0, TITLE_MAX - 1)}…`;
};

/** The database's rows of app.ack_status. */
interface StatusRow {
  request_id: string;
  student_id: string;
  asked: number;
  acked: number;
  waiting: number;
  met: boolean;
}

interface ListRow {
  id: string;
  schoolId: string;
  studentGroupId: string | null;
  groupName: string;
  title: string;
  body: string;
  createdById: string | null;
  createdAt: Date;
  closedAt: Date | null;
}

interface Person {
  id: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
  studentGroupId: string | null;
  studentGroup: { name: string } | null;
}

const PERSON = {
  id: true,
  firstName: true,
  lastName: true,
  isActive: true,
  studentGroupId: true,
  studentGroup: { select: { name: true } },
} as const;

/**
 * Samtyckeslistor per klass (F5): a list for a class (fotografering, publicering, utflykter), and an answer for each
 * pupil on it, which comes from the guardian.
 *
 * HOW A CONSENT IS GIVEN. Staff write it down from a paper, a call or a meeting (who and when are the database's),
 * or ask the guardians in the app and on the web through Kvittens (F4) with the rule ALL, which is the only
 * confirmation there is: when the last guardian a request asked has confirmed, a trigger writes the pupil's answer
 * (source KVITTENS), unless staff have written a WITHDRAWN or a DECLINED since the request was made: the last confirmation
 * of an older request does not undo it, and only a request made after it (asking again) grants it again. A consent is taken
 * back with another answer, WITHDRAWN, and the list shows it at once.
 *
 * WHAT A CONSENT IS NOW is consent-state.ts's one definition: the latest answer, or ASKED while a request made after
 * it waits for a guardian. Nothing stores "who has consented".
 *
 * WHO. A teacher writes for their mentees (the mentor definition of Kvittens and the frånvarobevakning) and reads the
 * pupils they teach or mentor; an administrator under Drift writes for any pupil. The database says the same.
 *
 * WHAT IS READ AND RECORDED. Opening a list or a pupil reads pupils' names and their answers: PEOPLE. The list of
 * lists names nobody and is not recorded. The class's pupils are as they are placed now (a list is about the class as
 * it is; after the rollover the class is empty and the list shows the pupils who have an answer on it).
 */
@Injectable()
export class ConsentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ack: AckService,
  ) {}

  async settings(user: AuthenticatedUser): Promise<ChecklistSettings> {
    return this.prisma.withRls(user, async (tx) => ({ kvittens: await this.kvittensOn(tx) }));
  }

  // -------------------------------------------------------------------
  // Lists

  async lists(user: AuthenticatedUser, query: ConsentListsQueryDto = {}): Promise<ConsentListItem[]> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const lists = await tx.consentList.findMany({
        where: {
          schoolId,
          ...(query.classId ? { studentGroupId: query.classId } : {}),
          ...(query.includeClosed ? {} : { closedAt: null }),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      });
      return this.items(tx, user, lists);
    });
  }

  async createList(dto: CreateConsentListDto, user: AuthenticatedUser): Promise<ConsentListItem> {
    const schoolId = requireSchoolId(user);
    return this.refusing(() =>
      this.prisma.withRls(user, async (tx) => {
        const klass = await tx.studentGroup.findFirst({ where: { id: dto.classId, schoolId, kind: 'CLASS' }, select: { id: true } });
        if (!klass) throw new UnprocessableEntityException({ code: CONSENT_NOT_A_CLASS, message: messageOf(CONSENT_NOT_A_CLASS) });
        // A teacher makes lists for the classes they have a mentee in (the policy says the same; this answers first with a code).
        if (user.role === Role.TEACHER && !(await this.idsOf(tx, 'checklist_mentee_class_ids')).includes(klass.id)) {
          throw new ForbiddenException({ code: CONSENT_NOT_YOUR_CLASS, message: messageOf(CONSENT_NOT_YOUR_CLASS) });
        }
        const list = await tx.consentList.create({ data: { schoolId, studentGroupId: klass.id, title: dto.title, body: dto.body } });
        return (await this.items(tx, user, [list]))[0]!;
      }),
    );
  }

  /**
   * A list and where each pupil stands. `forPaper` builds the sheet that is printed: a pupil with a protected identity is left out
   * (the database says who, app.checklist_protected_ids) and counted in `heldOut`, and the counts are of the pupils kept.
   */
  async detail(id: string, user: AuthenticatedUser, forPaper = false): Promise<ConsentDetail> {
    return this.prisma.withRls(user, async (tx) => {
      const list = await this.listOf(tx, user, id);
      const all = (await this.build(tx, user, [list])).get(list.id) ?? [];
      const marked = forPaper ? await protectedAmong(tx, all.map((row) => row.studentId)) : new Set<string>();
      const rows = all.filter((row) => !marked.has(row.studentId));
      const item = (await this.items(tx, user, [list], new Map([[list.id, rows]])))[0]!;
      await recordRead(tx, 'PEOPLE', rows.map((row) => row.studentId), user.channel);
      return {
        list: { ...item, body: list.body },
        kvittens: await this.kvittensOn(tx),
        canClose: user.role === Role.SCHOOL_ADMIN ? adminWrites(user) : list.createdById === requireUserId(user),
        rows,
        heldOut: all.length - rows.length,
      };
    });
  }

  async close(id: string, user: AuthenticatedUser): Promise<ConsentClosed> {
    return this.refusing(() =>
      this.prisma.withRls(user, async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ at: Date }>>`SELECT app.checklist_close_list(${id}::uuid) AS "at"`;
        return { closedAt: row!.at.toISOString() };
      }),
    );
  }

  // -------------------------------------------------------------------
  // Answers

  /**
   * Writes an answer for each pupil: a consent given on paper, a no, or a consent taken back. A teacher writes for
   * their mentees only.
   */
  async record(id: string, dto: RecordConsentDto, user: AuthenticatedUser): Promise<ConsentWritten> {
    const schoolId = requireSchoolId(user);
    const studentIds = [...new Set(dto.studentIds)];
    return this.refusing(() =>
      this.prisma.withRls(user, async (tx) => {
        const list = await this.listOf(tx, user, id);
        if (list.closedAt) throw new ConflictException({ code: CONSENT_LIST_CLOSED, message: messageOf(CONSENT_LIST_CLOSED) });
        await this.requireWritable(tx, user, schoolId, studentIds);
        const day = await this.dayOf(tx, schoolId, dto.givenOn);
        await tx.consentEntry.createMany({
          data: studentIds.map((studentId) => ({
            schoolId,
            listId: list.id,
            studentId,
            kind: dto.kind,
            givenOn: day,
            givenBy: dto.givenBy ?? null,
            note: dto.note ?? null,
          })),
        });
        return { written: studentIds.length };
      }),
    );
  }

  /**
   * Asks the guardians of the pupils through Kvittens, with the rule ALL, and links the request to the list in the same
   * transaction. Left without pupils it asks every pupil of the list who has no answer; the title and the text are the
   * list's, with the sentence that says a confirmation is the consent.
   */
  async ask(id: string, dto: AskConsentDto, user: AuthenticatedUser): Promise<ConsentAsked> {
    const schoolId = requireSchoolId(user);
    const chosen = await this.prisma.withRls(user, async (tx) => {
      const list = await this.listOf(tx, user, id);
      if (list.closedAt) throw new ConflictException({ code: CONSENT_LIST_CLOSED, message: messageOf(CONSENT_LIST_CLOSED) });
      if (!(await this.kvittensOn(tx))) throw new ConflictException({ code: CONSENT_KVITTENS_OFF, message: 'Skolan har inte slagit på kvittens.' });
      let studentIds: string[];
      if (dto.studentIds) {
        studentIds = [...new Set(dto.studentIds)];
        await this.requireWritable(tx, user, schoolId, studentIds);
      } else {
        const rows = (await this.build(tx, user, [list])).get(list.id) ?? [];
        studentIds = rows.filter((row) => row.inClass && row.canWrite && row.state === 'MISSING').map((row) => row.studentId);
      }
      if (studentIds.length === 0) throw new UnprocessableEntityException({ code: CONSENT_NOBODY_TO_ASK, message: messageOf(CONSENT_NOBODY_TO_ASK) });
      return { list, studentIds };
    });
    try {
      const { created } = await this.ack.createThen(
        {
          // A title the prefix pushes past the request's 120 characters is cut with an ellipsis, not silently.
          title: requestTitle(chosen.list.title),
          body: `${chosen.list.body}\n\n${CONSENT_FOOTER}`,
          rule: 'ALL',
          studentIds: chosen.studentIds,
        },
        user,
        async (tx, request) => {
          await tx.consentAsk.createMany({ data: [{ ackRequestId: request.id, schoolId, listId: chosen.list.id }] });
        },
      );
      return { requestId: created.id, pupils: created.pupils, guardians: created.guardians, withoutGuardian: created.withoutGuardian };
    } catch (error) {
      const refusal = translateRefusal(error);
      if (refusal) throw refusal;
      throw error;
    }
  }

  // -------------------------------------------------------------------
  // A pupil's card

  /** What a pupil has had instruction in (every tick, voided ones with why) and where they stand on each list. */
  async student(studentId: string, user: AuthenticatedUser): Promise<PupilCard> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      if (user.role === Role.TEACHER) {
        const visible = await this.idsOf(tx, 'checklist_visible_ids');
        if (!visible.includes(studentId)) throw new NotFoundException({ code: CHECKLIST_NOT_FOUND, message: messageOf(CHECKLIST_NOT_FOUND) });
      }
      const pupil = await tx.user.findFirst({ where: { id: studentId, schoolId, role: 'STUDENT' }, select: PERSON });
      if (!pupil) throw new NotFoundException({ code: CHECKLIST_NOT_FOUND, message: messageOf(CHECKLIST_NOT_FOUND) });

      const proofs = await tx.instructionProof.findMany({
        where: { schoolId, studentId },
        orderBy: [{ instructedOn: 'desc' }, { recordedAt: 'desc' }, { id: 'asc' }],
      });
      const templates = await tx.instructionTemplate.findMany({ where: { schoolId, id: { in: [...new Set(proofs.map((proof) => proof.templateId))] } } });
      const subjects = await tx.subject.findMany({
        where: { id: { in: templates.map((template) => template.subjectId).filter((s): s is string => s !== null) } },
        select: { id: true, name: true },
      });
      const subjectName = new Map(subjects.map((subject) => [subject.id, subject.name]));
      const templateOf = new Map(templates.map((template) => [template.id, template]));
      const names = await this.namesOf(tx, schoolId, proofs.flatMap((proof) => [proof.instructorId, proof.recordedById, proof.voidedById]));

      const lists = await tx.consentList.findMany({
        where: {
          schoolId,
          OR: [{ entries: { some: { studentId } } }, ...(pupil.studentGroupId ? [{ studentGroupId: pupil.studentGroupId, closedAt: null }] : [])],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      });
      const built = await this.build(tx, user, lists);
      await recordRead(tx, 'PEOPLE', [studentId], user.channel);
      return {
        student: { id: pupil.id, name: fullName(pupil), className: pupil.studentGroup?.name ?? null },
        proofs: proofs.map((proof) => {
          const template = templateOf.get(proof.templateId);
          return {
            id: proof.id,
            instructedOn: dayOf(proof.instructedOn),
            instructorId: proof.instructorId,
            instructorName: proof.instructorId ? (names.get(proof.instructorId) ?? null) : null,
            recordedByName: proof.recordedById ? (names.get(proof.recordedById) ?? null) : null,
            recordedAt: proof.recordedAt.toISOString(),
            note: proof.note,
            canVoid: canVoidProof(user, proof.recordedById),
            templateId: proof.templateId,
            templateTitle: template?.title ?? '',
            subjectName: template?.subjectId ? (subjectName.get(template.subjectId) ?? null) : null,
            voidedAt: proof.voidedAt ? proof.voidedAt.toISOString() : null,
            voidedByName: proof.voidedById ? (names.get(proof.voidedById) ?? null) : null,
            voidReason: proof.voidReason,
          };
        }),
        consents: lists.flatMap((list) => {
          const row = built.get(list.id)?.find((candidate) => candidate.studentId === studentId);
          return row ? [{ listId: list.id, title: list.title, className: list.groupName, closed: list.closedAt !== null, state: row.state, entry: row.entry }] : [];
        }),
      };
    });
  }

  // -------------------------------------------------------------------
  // Helpers

  /** Runs the work and answers a refusal of the database (a trigger's or a function's) as the HTTP error it is. */
  private async refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') {
        throw new ConflictException({ code: CONSENT_LIST_EXISTS, message: messageOf(CONSENT_LIST_EXISTS) });
      }
      const refusal = translateRefusal(error);
      if (refusal) throw refusal;
      throw error;
    }
  }

  private async kvittensOn(tx: PrismaClient): Promise<boolean> {
    const [row] = await tx.$queryRaw<Array<{ on: boolean | null }>>`SELECT app.ack_enabled() AS "on"`;
    return row?.on === true;
  }

  private async idsOf(tx: PrismaClient, fn: 'checklist_visible_ids' | 'ack_mentee_ids' | 'checklist_mentee_class_ids'): Promise<string[]> {
    const [row] = await tx.$queryRaw<Array<{ ids: string[] | null }>>(Prisma.sql`SELECT app.${Prisma.raw(fn)}() AS "ids"`);
    return row?.ids ?? [];
  }

  private async listOf(tx: PrismaClient, user: AuthenticatedUser, id: string): Promise<ListRow> {
    const list = await tx.consentList.findFirst({ where: { id, schoolId: requireSchoolId(user) } });
    if (!list) throw new NotFoundException({ code: CHECKLIST_NOT_FOUND, message: messageOf(CHECKLIST_NOT_FOUND) });
    return list;
  }

  /** The pupils are active pupils of the school, and for a teacher their mentees. */
  private async requireWritable(tx: PrismaClient, user: AuthenticatedUser, schoolId: string, studentIds: string[]): Promise<void> {
    const pupils = await tx.user.findMany({ where: { id: { in: studentIds }, schoolId, role: 'STUDENT', isActive: true }, select: { id: true } });
    if (pupils.length !== studentIds.length) {
      throw new UnprocessableEntityException({ code: CHECKLIST_UNKNOWN_PUPIL, message: messageOf(CHECKLIST_UNKNOWN_PUPIL) });
    }
    if (user.role === Role.TEACHER) {
      const mentees = new Set(await this.idsOf(tx, 'ack_mentee_ids'));
      if (studentIds.some((id) => !mentees.has(id))) {
        throw new ForbiddenException({ code: CHECKLIST_NOT_YOUR_PUPIL, message: messageOf(CHECKLIST_NOT_YOUR_PUPIL) });
      }
    }
  }

  /** The given day, or today in the school's zone; not a day that has not come. */
  private async dayOf(tx: PrismaClient, schoolId: string, given: string | undefined): Promise<Date> {
    const school = await tx.school.findUnique({ where: { id: schoolId }, select: { timezone: true } });
    const today = todayInZone(school?.timezone ?? 'Europe/Stockholm');
    if (!given) return today;
    const day = asDay(given);
    if (Number.isNaN(day.getTime()) || dayOf(day) !== given) {
      throw new UnprocessableEntityException({ code: CHECKLIST_DATE_INVALID, message: messageOf(CHECKLIST_DATE_INVALID) });
    }
    if (day.getTime() > today.getTime()) {
      throw new UnprocessableEntityException({ code: CHECKLIST_DATE_IN_THE_FUTURE, message: messageOf(CHECKLIST_DATE_IN_THE_FUTURE) });
    }
    return day;
  }

  private async namesOf(tx: PrismaClient, schoolId: string, ids: Array<string | null>): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
    if (wanted.length === 0) return new Map();
    const people = await tx.user.findMany({ where: { schoolId, id: { in: wanted } }, select: { id: true, firstName: true, lastName: true } });
    return new Map(people.map((person) => [person.id, fullName(person)]));
  }

  /** The lists as items, with counts from the rows (given, or built here). */
  private async items(tx: PrismaClient, user: AuthenticatedUser, lists: ListRow[], given?: Map<string, ConsentRow[]>): Promise<ConsentListItem[]> {
    const rows = given ?? (await this.build(tx, user, lists));
    const names = await this.namesOf(tx, requireSchoolId(user), lists.map((list) => list.createdById));
    return lists.map((list) => ({
      id: list.id,
      title: list.title,
      classId: list.studentGroupId,
      className: list.groupName,
      createdAt: list.createdAt.toISOString(),
      createdByName: list.createdById ? (names.get(list.createdById) ?? null) : null,
      closedAt: list.closedAt ? list.closedAt.toISOString() : null,
      counts: countStates((rows.get(list.id) ?? []).map((row) => row.state)),
    }));
  }

  /**
   * The rows of each list: the pupils of its class as they are placed now, and the pupils who have an answer on it (a
   * pupil who has moved or left keeps theirs), with the state from consent-state.ts. A teacher's rows are the pupils
   * they teach or mentor, which is what the database lets them read.
   */
  private async build(tx: PrismaClient, user: AuthenticatedUser, lists: ListRow[]): Promise<Map<string, ConsentRow[]>> {
    const schoolId = requireSchoolId(user);
    const result = new Map<string, ConsentRow[]>();
    if (lists.length === 0) return result;
    const isTeacher = user.role === Role.TEACHER;
    const visible = isTeacher ? new Set(await this.idsOf(tx, 'checklist_visible_ids')) : null;
    const mentees = isTeacher ? new Set(await this.idsOf(tx, 'ack_mentee_ids')) : null;
    const listIds = lists.map((list) => list.id);

    const entries = await tx.consentEntry.findMany({ where: { schoolId, listId: { in: listIds } }, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }] });
    const asks = await tx.consentAsk.findMany({ where: { schoolId, listId: { in: listIds } } });
    const requestIds = asks.map((ask) => ask.ackRequestId);
    const status =
      requestIds.length === 0
        ? []
        : await tx.$queryRaw<StatusRow[]>`SELECT request_id, student_id, asked, acked, waiting, met FROM app.ack_status(${requestIds}::uuid[])`;

    const classIds = [...new Set(lists.map((list) => list.studentGroupId).filter((id): id is string => id !== null))];
    const members: Person[] =
      classIds.length === 0 ? [] : await tx.user.findMany({ where: { schoolId, role: 'STUDENT', isActive: true, studentGroupId: { in: classIds } }, select: PERSON });
    const holders: Person[] = await tx.user.findMany({
      where: { schoolId, role: 'STUDENT', id: { in: [...new Set(entries.map((entry) => entry.studentId))] } },
      select: PERSON,
    });
    const people = new Map<string, Person>([...members, ...holders].map((person) => [person.id, person]));
    const names = await this.namesOf(tx, schoolId, entries.map((entry) => entry.recordedById));

    for (const list of lists) {
      const ids = new Set<string>();
      for (const member of members) if (member.studentGroupId === list.studentGroupId) ids.add(member.id);
      for (const entry of entries) if (entry.listId === list.id) ids.add(entry.studentId);
      const listAsks = asks.filter((ask) => ask.listId === list.id);
      const rows: ConsentRow[] = [];
      for (const id of ids) {
        if (visible && !visible.has(id)) continue;
        const person = people.get(id);
        if (!person) continue;
        const own = entries.filter((entry) => entry.listId === list.id && entry.studentId === id);
        const stateAsks: StateAsk[] = listAsks.flatMap((ask) => {
          const found = status.find((row) => row.request_id === ask.ackRequestId && row.student_id === id);
          return found ? [{ requestId: ask.ackRequestId, askedAt: ask.createdAt, asked: found.asked, waiting: found.waiting, met: found.met }] : [];
        });
        const { state, latest, ask } = consentStateOf(
          own.map((entry) => ({ id: entry.id, kind: entry.kind as ConsentKind, recordedAt: entry.recordedAt })),
          stateAsks,
        );
        const view = (entry: (typeof own)[number]): ConsentEntryView => ({
          id: entry.id,
          kind: entry.kind as ConsentKind,
          source: entry.source,
          givenOn: dayOf(entry.givenOn),
          givenBy: entry.givenBy,
          note: entry.note,
          recordedByName: entry.recordedById ? (names.get(entry.recordedById) ?? null) : null,
          recordedAt: entry.recordedAt.toISOString(),
        });
        const ordered = inOrder(own).reverse();
        rows.push({
          studentId: id,
          name: fullName(person),
          className: person.studentGroup?.name ?? null,
          inClass: person.isActive && list.studentGroupId !== null && person.studentGroupId === list.studentGroupId,
          state,
          entry: latest ? view(own.find((entry) => entry.id === latest.id)!) : null,
          history: ordered.map(view),
          ask: ask ? { askedAt: ask.askedAt.toISOString(), guardiansAsked: ask.asked, guardiansWaiting: ask.waiting } : null,
          canWrite: !list.closedAt && person.isActive && (mentees ? mentees.has(id) : adminWrites(user)),
        });
      }
      rows.sort((a, b) => a.name.localeCompare(b.name, 'sv') || (a.studentId < b.studentId ? -1 : 1));
      result.set(list.id, rows);
    }
    return result;
  }
}
