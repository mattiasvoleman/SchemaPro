import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
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
  CHECKLIST_TEMPLATE_EXISTS,
  CHECKLIST_TEMPLATE_RETIRED,
  CHECKLIST_UNKNOWN_PUPIL,
  CHECKLIST_UNKNOWN_SUBJECT,
  adminWrites,
  canVoidProof,
  messageOf,
  protectedAmong,
  protectedStaff,
  translateRefusal,
} from './checklists';
import type { GroupChoice, Instructor, ProofRoster, ProofRow, ProofsWritten, ProofView, ProofVoided, TemplateView } from './checklists-views';
import type { CreateTemplateDto, TickProofsDto, UpdateTemplateDto, VoidProofDto } from './dto/checklists.dto';

const fullName = (person: { firstName: string; lastName: string }) => `${person.firstName} ${person.lastName}`;
const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const asDay = (day: string) => new Date(`${day}T00:00:00.000Z`);

/**
 * Instruktionsbevis (F5): a school's templates for an instruction (slöjdens maskiner, NO:s laborationssäkerhet,
 * idrottens moment), and the ticks that say a pupil has had it, on a day, from a person.
 *
 * A PROOF IS THE PUPIL'S, not the class's: it is keyed to the pupil, so it follows them through a change of class and
 * the year rollover, and nothing here reads a class history. Who may tick whom is the database's: a teacher ticks
 * the pupils of their own groups and lessons (app.checklist_taught_ids), an administrator under Drift anyone; this
 * service answers first, with a code, and the policies say the same. A tick made in error is voided (with why) and
 * stays; the same pupil, template and day is one proof.
 *
 * WHAT IS READ AND RECORDED. A staff member opening a group's roster reads pupils' names and what they have had
 * instruction in: PEOPLE. The list of templates and of groups names nobody and is not recorded.
 */
@Injectable()
export class InstructionService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------
  // Templates

  async templates(user: AuthenticatedUser, includeRetired = false): Promise<TemplateView[]> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.instructionTemplate.findMany({
        where: { schoolId, ...(includeRetired ? {} : { active: true }) },
        orderBy: [{ title: 'asc' }, { id: 'asc' }],
      });
      return this.viewTemplates(tx, rows);
    });
  }

  async createTemplate(dto: CreateTemplateDto, user: AuthenticatedUser): Promise<TemplateView> {
    const schoolId = requireSchoolId(user);
    return this.refusing(() =>
      this.prisma.withRls(user, async (tx) => {
        const row = await tx.instructionTemplate.create({
          data: { schoolId, title: dto.title, description: dto.description ?? null, subjectId: dto.subjectId ?? null },
        });
        return (await this.viewTemplates(tx, [row]))[0]!;
      }),
    );
  }

  async updateTemplate(id: string, dto: UpdateTemplateDto, user: AuthenticatedUser): Promise<TemplateView> {
    const schoolId = requireSchoolId(user);
    return this.refusing(() =>
      this.prisma.withRls(user, async (tx) => {
        const data: Prisma.InstructionTemplateUncheckedUpdateInput = {};
        if (dto.title !== undefined) data.title = dto.title;
        if (dto.description !== undefined) data.description = dto.description;
        if (dto.subjectId !== undefined) data.subjectId = dto.subjectId;
        if (dto.active !== undefined) data.active = dto.active;
        try {
          const row = await tx.instructionTemplate.update({ where: { id_schoolId: { id, schoolId } }, data });
          return (await this.viewTemplates(tx, [row]))[0]!;
        } catch (error) {
          if ((error as { code?: string })?.code === 'P2025') {
            throw new NotFoundException({ code: CHECKLIST_NOT_FOUND, message: messageOf(CHECKLIST_NOT_FOUND) });
          }
          throw error;
        }
      }),
    );
  }

  // -------------------------------------------------------------------
  // Groups, and the staff who can have given an instruction

  /**
   * The groups the caller can look at the proofs of: a teacher's are the groups of their lessons in the school's
   * active year (and the extra classes of those lessons), with the subjects they teach there, and the classes of
   * their mentees (to look at, not to tick); an administrator's are every group of the active year.
   */
  async groups(user: AuthenticatedUser): Promise<GroupChoice[]> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const found = new Map<string, GroupChoice>();
      const add = (
        group: { id: string; name: string; kind: 'CLASS' | 'TEACHING_GROUP' },
        subject: string | null,
        canTick: boolean,
        canMakeList = false,
      ) => {
        const was = found.get(group.id);
        if (was) {
          if (subject && !was.subjects.includes(subject)) was.subjects.push(subject);
          was.canTick = was.canTick || canTick;
          was.canMakeList = was.canMakeList || canMakeList;
          return;
        }
        found.set(group.id, { id: group.id, name: group.name, kind: group.kind, subjects: subject ? [subject] : [], canTick, canMakeList });
      };
      if (user.role === Role.SCHOOL_ADMIN) {
        const groups = await tx.studentGroup.findMany({
          where: { schoolId, academicYear: { isActive: true } },
          select: { id: true, name: true, kind: true },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
        });
        for (const group of groups) add(group, null, adminWrites(user), group.kind === 'CLASS' && adminWrites(user));
        return [...found.values()];
      }
      const me = requireUserId(user);
      const lessons = await tx.masterLesson.findMany({
        where: { schoolId, isParked: false, academicYear: { isActive: true }, OR: [{ teacherId: me }, { coTeacherId: me }] },
        select: {
          subject: { select: { name: true } },
          studentGroup: { select: { id: true, name: true, kind: true } },
          extraGroups: { select: { studentGroup: { select: { id: true, name: true, kind: true } } } },
        },
      });
      for (const lesson of lessons) {
        add(lesson.studentGroup, lesson.subject.name, true);
        for (const extra of lesson.extraGroups) add(extra.studentGroup, lesson.subject.name, true);
      }
      const mentees = await this.idsOf(tx, 'ack_mentee_ids');
      if (mentees.length > 0) {
        const classes = await tx.user.findMany({
          where: { id: { in: mentees }, studentGroupId: { not: null } },
          select: { studentGroup: { select: { id: true, name: true, kind: true } } },
        });
        // The classes of the caller's mentees: to look at, and the ones a list may be made for.
        for (const pupil of classes) if (pupil.studentGroup) add(pupil.studentGroup, null, false, pupil.studentGroup.kind === 'CLASS');
      }
      return [...found.values()].sort((a, b) => a.name.localeCompare(b.name, 'sv') || (a.id < b.id ? -1 : 1));
    });
  }

  /**
   * The staff who can have given an instruction: the school's active teachers and administrators. To a teacher the whole staff on
   * one screen leaves out a colleague the school has marked as having a protected identity, with no id and no count, as Skolans dag
   * does (the answer has no field that says someone is left out); the teacher themselves stays, and an administrator reads everyone.
   */
  async instructors(user: AuthenticatedUser): Promise<Instructor[]> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const staff = await tx.user.findMany({
        where: { schoolId, isActive: true, role: { in: ['TEACHER', 'SCHOOL_ADMIN'] } },
        select: { id: true, firstName: true, lastName: true },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
      });
      const marked = user.role === Role.TEACHER ? await protectedStaff(tx) : new Set<string>();
      return staff.filter((person) => person.id === user.userId || !marked.has(person.id)).map((person) => ({ id: person.id, name: fullName(person) }));
    });
  }

  // -------------------------------------------------------------------
  // The roster: a group's pupils and what they have had

  /**
   * A group's pupils and what they have had. `forPaper` builds the sheet that is printed: a pupil with a protected identity is left
   * out (the database says who, app.checklist_protected_ids) and counted in `heldOut`, and the counts are of the pupils kept.
   */
  async roster(templateId: string, groupId: string, user: AuthenticatedUser, forPaper = false): Promise<ProofRoster> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const template = await tx.instructionTemplate.findFirst({ where: { id: templateId, schoolId } });
      const group = await tx.studentGroup.findFirst({ where: { id: groupId, schoolId }, select: { id: true, name: true, kind: true } });
      if (!template || !group) throw new NotFoundException({ code: CHECKLIST_NOT_FOUND, message: messageOf(CHECKLIST_NOT_FOUND) });

      const members =
        group.kind === 'CLASS'
          ? await tx.user.findMany({
              where: { schoolId, role: 'STUDENT', isActive: true, studentGroupId: group.id },
              select: { id: true, firstName: true, lastName: true, studentGroup: { select: { name: true } } },
            })
          : (
              await tx.studentGroupMember.findMany({
                where: { studentGroupId: group.id, student: { isActive: true, role: 'STUDENT' } },
                select: { student: { select: { id: true, firstName: true, lastName: true, studentGroup: { select: { name: true } } } } },
              })
            ).map((member) => member.student);

      const isTeacher = user.role === Role.TEACHER;
      const taught = isTeacher ? new Set(await this.idsOf(tx, 'checklist_taught_ids')) : null;
      const visible = isTeacher ? new Set(await this.idsOf(tx, 'checklist_visible_ids')) : null;
      const pupils = members
        .filter((pupil) => !visible || visible.has(pupil.id))
        .sort((a, b) => a.lastName.localeCompare(b.lastName, 'sv') || a.firstName.localeCompare(b.firstName, 'sv') || (a.id < b.id ? -1 : 1));

      const proofs = await tx.instructionProof.findMany({
        where: { schoolId, templateId, voidedAt: null, studentId: { in: pupils.map((pupil) => pupil.id) } },
        orderBy: [{ instructedOn: 'desc' }, { recordedAt: 'desc' }, { id: 'asc' }],
      });
      const names = await this.namesOf(tx, schoolId, proofs.flatMap((proof) => [proof.instructorId, proof.recordedById]));
      const byPupil = new Map<string, ProofView[]>();
      for (const proof of proofs) {
        const list = byPupil.get(proof.studentId) ?? [];
        list.push(this.viewProof(proof, names, user));
        byPupil.set(proof.studentId, list);
      }
      const all: ProofRow[] = pupils.map((pupil) => ({
        studentId: pupil.id,
        name: fullName(pupil),
        className: pupil.studentGroup?.name ?? null,
        canTick: taught ? taught.has(pupil.id) : adminWrites(user),
        proofs: byPupil.get(pupil.id) ?? [],
      }));
      const marked = forPaper ? await protectedAmong(tx, all.map((row) => row.studentId)) : new Set<string>();
      const rows = all.filter((row) => !marked.has(row.studentId));
      await recordRead(tx, 'PEOPLE', rows.map((row) => row.studentId), user.channel);
      return {
        template: (await this.viewTemplates(tx, [template]))[0]!,
        group,
        rows,
        done: rows.filter((row) => row.proofs.length > 0).length,
        pupils: rows.length,
        heldOut: all.length - rows.length,
      };
    });
  }

  // -------------------------------------------------------------------
  // Ticking and voiding

  /**
   * Ticks the pupils for one instruction on one day. A teacher's pupils are the ones they teach (the database says the
   * same, in the policy of InstructionProofs); a pupil who already has a proof for that day is counted, not written
   * twice. The writer, the clock and (unless named) the instructor are the database's.
   */
  async tick(dto: TickProofsDto, user: AuthenticatedUser): Promise<ProofsWritten> {
    const schoolId = requireSchoolId(user);
    const studentIds = [...new Set(dto.studentIds)];
    return this.refusing(() =>
      this.prisma.withRls(user, async (tx) => {
        const template = await tx.instructionTemplate.findFirst({ where: { id: dto.templateId, schoolId } });
        if (!template) throw new NotFoundException({ code: CHECKLIST_NOT_FOUND, message: messageOf(CHECKLIST_NOT_FOUND) });
        if (!template.active) throw new ConflictException({ code: CHECKLIST_TEMPLATE_RETIRED, message: messageOf(CHECKLIST_TEMPLATE_RETIRED) });

        const school = await tx.school.findUnique({ where: { id: schoolId }, select: { timezone: true } });
        const today = todayInZone(school?.timezone ?? 'Europe/Stockholm');
        const day = dto.instructedOn ? asDay(dto.instructedOn) : today;
        if (Number.isNaN(day.getTime()) || dayOf(day) !== (dto.instructedOn ?? dayOf(day))) {
          throw new UnprocessableEntityException({ code: CHECKLIST_DATE_INVALID, message: messageOf(CHECKLIST_DATE_INVALID) });
        }
        if (day.getTime() > today.getTime()) {
          throw new UnprocessableEntityException({ code: CHECKLIST_DATE_IN_THE_FUTURE, message: messageOf(CHECKLIST_DATE_IN_THE_FUTURE) });
        }

        const pupils = await tx.user.findMany({ where: { id: { in: studentIds }, schoolId, role: 'STUDENT', isActive: true }, select: { id: true } });
        if (pupils.length !== studentIds.length) {
          throw new UnprocessableEntityException({ code: CHECKLIST_UNKNOWN_PUPIL, message: messageOf(CHECKLIST_UNKNOWN_PUPIL) });
        }
        if (user.role === Role.TEACHER) {
          const taught = new Set(await this.idsOf(tx, 'checklist_taught_ids'));
          if (studentIds.some((id) => !taught.has(id))) {
            throw new ForbiddenException({ code: CHECKLIST_NOT_YOUR_PUPIL, message: messageOf(CHECKLIST_NOT_YOUR_PUPIL) });
          }
        }

        const had = await tx.instructionProof.findMany({
          where: { schoolId, templateId: template.id, studentId: { in: studentIds }, instructedOn: day, voidedAt: null },
          select: { studentId: true },
        });
        const already = new Set(had.map((proof) => proof.studentId));
        const fresh = studentIds.filter((id) => !already.has(id));
        // createMany, not create: an INSERT … RETURNING asks the SELECT arms, and nothing here reads the row back.
        const made =
          fresh.length === 0
            ? { count: 0 }
            : await tx.instructionProof.createMany({
                data: fresh.map((studentId) => ({
                  schoolId,
                  templateId: template.id,
                  studentId,
                  instructedOn: day,
                  instructorId: dto.instructorId ?? null,
                  note: dto.note ?? null,
                })),
                skipDuplicates: true,
              });
        return { written: made.count, already: studentIds.length - made.count };
      }),
    );
  }

  async voidProof(id: string, dto: VoidProofDto, user: AuthenticatedUser): Promise<ProofVoided> {
    return this.refusing(() =>
      this.prisma.withRls(user, async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ at: Date }>>`SELECT app.checklist_void_proof(${id}::uuid, ${dto.reason}) AS "at"`;
        return { voidedAt: row!.at.toISOString() };
      }),
    );
  }

  // -------------------------------------------------------------------
  // Helpers

  /** Runs the work and answers a refusal of the database (a trigger's or a function's) as the HTTP error it is. */
  private async refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'P2002') throw new ConflictException({ code: CHECKLIST_TEMPLATE_EXISTS, message: messageOf(CHECKLIST_TEMPLATE_EXISTS) });
      if (code === 'P2003') throw new UnprocessableEntityException({ code: CHECKLIST_UNKNOWN_SUBJECT, message: messageOf(CHECKLIST_UNKNOWN_SUBJECT) });
      const refusal = translateRefusal(error);
      if (refusal) throw refusal;
      throw error;
    }
  }

  /** One of the database's id lists for the caller (app.checklist_taught_ids and the like). */
  private async idsOf(tx: PrismaClient, fn: 'checklist_taught_ids' | 'checklist_visible_ids' | 'ack_mentee_ids'): Promise<string[]> {
    const [row] = await tx.$queryRaw<Array<{ ids: string[] | null }>>(Prisma.sql`SELECT app.${Prisma.raw(fn)}() AS "ids"`);
    return row?.ids ?? [];
  }

  private async namesOf(tx: PrismaClient, schoolId: string, ids: Array<string | null>): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
    if (wanted.length === 0) return new Map();
    const people = await tx.user.findMany({ where: { schoolId, id: { in: wanted } }, select: { id: true, firstName: true, lastName: true } });
    return new Map(people.map((person) => [person.id, fullName(person)]));
  }

  private async viewTemplates(
    tx: PrismaClient,
    rows: Array<{ id: string; subjectId: string | null; title: string; description: string | null; active: boolean; schoolId: string }>,
  ): Promise<TemplateView[]> {
    const subjectIds = [...new Set(rows.map((row) => row.subjectId).filter((id): id is string => id !== null))];
    const subjects = subjectIds.length === 0 ? [] : await tx.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } });
    const names = new Map(subjects.map((subject) => [subject.id, subject.name]));
    return rows.map((row) => ({
      id: row.id,
      subjectId: row.subjectId,
      subjectName: row.subjectId ? (names.get(row.subjectId) ?? null) : null,
      title: row.title,
      description: row.description,
      active: row.active,
    }));
  }

  private viewProof(
    proof: { id: string; instructedOn: Date; instructorId: string | null; recordedById: string | null; recordedAt: Date; note: string | null },
    names: Map<string, string>,
    user: AuthenticatedUser,
  ): ProofView {
    return {
      id: proof.id,
      instructedOn: dayOf(proof.instructedOn),
      instructorId: proof.instructorId,
      instructorName: proof.instructorId ? (names.get(proof.instructorId) ?? null) : null,
      recordedByName: proof.recordedById ? (names.get(proof.recordedById) ?? null) : null,
      recordedAt: proof.recordedAt.toISOString(),
      note: proof.note,
      canVoid: canVoidProof(user, proof.recordedById),
    };
  }
}
