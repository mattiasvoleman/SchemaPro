import { createHash } from 'node:crypto';
import type { TeacherContractKind, TeacherDutyKind, UserRole } from '@prisma/client';
import { normalizeDutyLabel } from '../staffing/duty-identity';
import { isOnSolverGrid, type DutySlot } from '../staffing/duty-slot';
import { minutesOf } from '../common/solver-grid';

/**
 * Tjänster and uppdrag carried into the next läsår (staffing Fas 5): which
 * rows, with which values, and what the admin should look at first.
 *
 * PURE, AND SHARED. The rollover asks it with `existing: null` (its target
 * year is created in the same transaction and has nothing), the carry into an
 * already rolled year (StaffingRolloverService) with what that year already
 * holds. Both hash the same writes with stableStaffing, so a preview and its
 * execute compare the same thing.
 *
 * WHO. Only rows of an active TEACHER or SCHOOL_ADMIN — a teaching rektor is
 * staff here as everywhere in staffing. Everybody else's post and uppdrag are
 * listed, never carried: a person who has left keeps their history in the old
 * year and starts nothing in the new one.
 *
 * GROUPS. An uppdrag linked to a group follows that group's successor
 * (StudentGroup.predecessorId; an INTAKE twin is never one). A MENTORSKAP
 * whose class graduates, is skipped or has no successor is NOT carried: a
 * groupless "Mentor 9A" would count its minutes in every report and
 * over-target check for a class that no longer exists, a confident wrong
 * figure, so the preview names the hole instead (GROUP_LEAVES). Any other
 * kind of such a group is carried without its group and flagged.
 *
 * LABELS. A group-linked label is promoted: every whole-token occurrence of
 * the group's name, case-sensitive, becomes the successor's ("Mentor 7B" →
 * "Mentor 8B", "Mentor 7B/7C" linked to 7B → "Mentor 8B/7C"), unless the
 * result passes the column's 80 characters. Every rewrite is listed.
 *
 * ALREADY THERE (only for a carry into a rolled year). The unit is the
 * teacher: one who already has a post in the target is skipped whole, post
 * and uppdrag, because the admin has set them up by hand — and because a
 * duty-by-duty match would bring back every carried uppdrag the admin
 * deleted, the next time the carry ran. A teacher with no post there has
 * their uppdrag matched one to one: a target duty of the same kind on the
 * successor group first, then one of the same kind, groupless or on that
 * successor, whose label (trimmed, lowercased — the uppdrag import's
 * identity) equals the source label or the promoted one. A target duty
 * absorbs one source duty at most, so two "Rastvakt" against one carry one.
 *
 * Nothing here knows a name: the preview carries ids, kinds, labels (the
 * admin's to read) and group names.
 */

/** A source year's post, as the carry reads it: the two percents as toFixed(3) strings. */
export interface SourceEmployment {
  id: string;
  userId: string;
  employmentPercent: string;
  reductionPercent: string;
  contractKind: TeacherContractKind;
  teachingTargetMinutesPerWeek: number | null;
  signature: string | null;
  note: string | null;
}

export interface SourceDuty {
  id: string;
  userId: string;
  kind: TeacherDutyKind;
  label: string;
  minutesPerWeek: number;
  countsAsTeaching: boolean;
  subjectId: string | null;
  studentGroupId: string | null;
  note: string | null;
  /** The linked slot in its guarded shape (weekly TEACHER UNAVAILABLE of the duty's teacher), or null. */
  slot: DutySlot | null;
}

export interface StaffingSource {
  employments: SourceEmployment[];
  duties: SourceDuty[];
  /** Every userId above: role and isActive, read after the staff lock. */
  staff: Map<string, { role: UserRole; isActive: boolean }>;
}

/** What a carry into an already rolled year finds there. */
export interface ExistingStaffing {
  employmentUserIds: Set<string>;
  /** signature → the userId holding it in the target year. */
  signatures: Map<string, string>;
  duties: {
    id: string;
    userId: string;
    kind: TeacherDutyKind;
    label: string;
    /** The target group's predecessor (its GroupKey), or `target:<id>` for a group with none, or null. */
    groupKey: string | null;
    slot: DutySlot | null;
  }[];
}

export interface StaffingCarryInput {
  staffing: StaffingSource;
  /** The source group's successor in the target, by GroupKey; null when it has none. */
  successorOf(sourceGroupId: string): { key: string; name: string } | null;
  /** The source group's name, for the flags; null for a group outside the source year. */
  groupName(sourceGroupId: string): string | null;
  existing: ExistingStaffing | null;
}

export interface StaffingWrites {
  employments: {
    sourceEmploymentId: string;
    userId: string;
    employmentPercent: string;
    reductionPercent: string;
    contractKind: TeacherContractKind;
    teachingTargetMinutesPerWeek: number | null;
    signature: string | null;
    note: string | null;
  }[];
  duties: {
    sourceDutyId: string;
    userId: string;
    kind: TeacherDutyKind;
    label: string;
    minutesPerWeek: number;
    countsAsTeaching: boolean;
    subjectId: string | null;
    groupKey: string | null;
    note: string | null;
    slot: DutySlot | null;
  }[];
}

export type EmploymentNotCarried = 'INACTIVE' | 'NOT_STAFF' | 'ALREADY_PRESENT';
export type DutyNotCarried = 'GROUP_LEAVES' | 'TEACHER_NOT_CARRIED' | 'TEACHER_ALREADY_SET_UP' | 'ALREADY_PRESENT';

interface DutyRef {
  sourceDutyId: string;
  userId: string;
  kind: TeacherDutyKind;
  label: string;
}

export interface StaffingCarryPreview {
  employments: {
    carried: number;
    /** A nedsättning carried: often agreed for one year only. */
    withReduction: string[];
    /** A per-teacher target carried, likewise. */
    withTargetOverride: string[];
    notCarried: { userId: string; reason: EmploymentNotCarried }[];
    signaturesDropped: { userId: string; signature: string }[];
  };
  duties: {
    carried: number;
    slots: number;
    followedGroup: number;
    relabelled: { sourceDutyId: string; userId: string; from: string; to: string }[];
    groupDropped: (DutyRef & { groupName: string | null })[];
    slotDropped: (DutyRef & { reason: 'OFF_GRID' })[];
    /** A carried slot that overlaps a slot the teacher already has in the target. */
    overlapsTargetDuty: (DutyRef & { targetDutyId: string })[];
    /** A carried mentorskap whose class already has one in the target, held by anyone. */
    successorHasMentor: (DutyRef & { groupName: string })[];
    notCarried: (DutyRef & { groupName: string | null; reason: DutyNotCarried })[];
  };
  /** Per teacher, sorted by userId, for the review table (the web resolves the names). */
  teachers: {
    userId: string;
    employment: 'CARRIED' | 'ALREADY_PRESENT' | 'NOT_CARRIED' | 'NONE';
    duties: number;
    dutyMinutesPerWeek: number;
  }[];
}

export type StaffingProblemCode =
  | 'STAFFING_MENTORSKAP_NOT_CARRIED'
  | 'STAFFING_DUTY_GROUP_DROPPED'
  | 'STAFFING_TEACHERS_NOT_CARRIED'
  | 'STAFFING_SLOT_OFF_GRID'
  | 'STAFFING_PER_YEAR_TERMS_CARRIED'
  | 'STAFFING_SIGNATURE_TAKEN'
  | 'STAFFING_ALREADY_PRESENT'
  | 'STAFFING_SLOTS_OVER_LESSONS';

/** Every staffing problem is advice: none blocks. Params hold counts and group names, never a teacher's id. */
export interface StaffingProblem {
  code: StaffingProblemCode;
  blocking: false;
  params: Record<string, string | number | string[]>;
}

export interface StaffingCarryPlan {
  preview: StaffingCarryPreview;
  problems: StaffingProblem[];
  writes: StaffingWrites;
}

const STAFF_ROLES: ReadonlySet<UserRole> = new Set<UserRole>(['TEACHER', 'SCHOOL_ADMIN']);
const LABEL_MAX = 80;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `label` with every whole-token occurrence of `from` replaced by `to`: a
 * token boundary is anything that is not a Unicode letter or digit, so "7B"
 * in "Mentor 7B/7C" is replaced and in "17B" is not. Case-sensitive — "mentor
 * 7b" is somebody's own spelling, and guessing at it rewrites the wrong
 * thing. The source label when nothing matches or the result would not fit
 * the column (80 code points, as TeacherDuties_label_is_sane counts).
 */
export function promoteLabel(label: string, from: string, to: string): string {
  if (from.length === 0 || from === to) return label;
  const token = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(from)}(?![\\p{L}\\p{N}])`, 'gu');
  const promoted = label.replace(token, () => to);
  return [...promoted].length > LABEL_MAX ? label : promoted;
}

const overlaps = (a: DutySlot, b: { dayOfWeek: number; startTime: string; endTime: string }) =>
  a.dayOfWeek === b.dayOfWeek &&
  minutesOf(a.startTime) < minutesOf(b.endTime) &&
  minutesOf(b.startTime) < minutesOf(a.endTime);

const clockOf = (time: string) => time.slice(0, 5);

export function planStaffingCarry(input: StaffingCarryInput): StaffingCarryPlan {
  const { staffing, existing } = input;
  const preview: StaffingCarryPreview = {
    employments: { carried: 0, withReduction: [], withTargetOverride: [], notCarried: [], signaturesDropped: [] },
    duties: {
      carried: 0,
      slots: 0,
      followedGroup: 0,
      relabelled: [],
      groupDropped: [],
      slotDropped: [],
      overlapsTargetDuty: [],
      successorHasMentor: [],
      notCarried: [],
    },
    teachers: [],
  };
  const writes: StaffingWrites = { employments: [], duties: [] };

  /** Why a person's rows are not carried, or null when they are staff and active. */
  const notStaff = (userId: string): 'INACTIVE' | 'NOT_STAFF' | null => {
    const person = staffing.staff.get(userId);
    if (!person || !STAFF_ROLES.has(person.role)) return 'NOT_STAFF';
    return person.isActive ? null : 'INACTIVE';
  };
  const setUp = (userId: string) => existing?.employmentUserIds.has(userId) ?? false;
  const notCarriedPeople = new Set<string>();

  // ---- posts
  const employmentOf = new Map<string, 'CARRIED' | 'ALREADY_PRESENT' | 'NOT_CARRIED'>();
  for (const employment of [...staffing.employments].sort((a, b) => (a.userId < b.userId ? -1 : 1))) {
    const refused = notStaff(employment.userId);
    if (refused) {
      preview.employments.notCarried.push({ userId: employment.userId, reason: refused });
      employmentOf.set(employment.userId, 'NOT_CARRIED');
      notCarriedPeople.add(employment.userId);
      continue;
    }
    if (setUp(employment.userId)) {
      preview.employments.notCarried.push({ userId: employment.userId, reason: 'ALREADY_PRESENT' });
      employmentOf.set(employment.userId, 'ALREADY_PRESENT');
      continue;
    }
    let signature = employment.signature;
    const holder = signature !== null ? existing?.signatures.get(signature) : undefined;
    if (signature !== null && holder !== undefined && holder !== employment.userId) {
      preview.employments.signaturesDropped.push({ userId: employment.userId, signature });
      signature = null;
    }
    writes.employments.push({
      sourceEmploymentId: employment.id,
      userId: employment.userId,
      employmentPercent: employment.employmentPercent,
      reductionPercent: employment.reductionPercent,
      contractKind: employment.contractKind,
      teachingTargetMinutesPerWeek: employment.teachingTargetMinutesPerWeek,
      signature,
      note: employment.note,
    });
    preview.employments.carried++;
    employmentOf.set(employment.userId, 'CARRIED');
    if (Number(employment.reductionPercent) > 0) preview.employments.withReduction.push(employment.userId);
    if (employment.teachingTargetMinutesPerWeek !== null) preview.employments.withTargetOverride.push(employment.userId);
  }

  // ---- uppdrag
  const absorbed = new Set<string>();
  const mentoredGroups = new Set(
    (existing?.duties ?? []).filter((duty) => duty.kind === 'MENTORSKAP' && duty.groupKey !== null).map((duty) => duty.groupKey),
  );
  const leaving = { mentorskap: new Set<string>(), mentorskapDuties: 0, dropped: new Set<string>() };
  const carriedPerTeacher = new Map<string, { duties: number; minutes: number }>();
  for (const duty of [...staffing.duties].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const ref: DutyRef = { sourceDutyId: duty.id, userId: duty.userId, kind: duty.kind, label: duty.label };
    const sourceGroupName = duty.studentGroupId ? input.groupName(duty.studentGroupId) : null;
    if (notStaff(duty.userId)) {
      preview.duties.notCarried.push({ ...ref, groupName: sourceGroupName, reason: 'TEACHER_NOT_CARRIED' });
      notCarriedPeople.add(duty.userId);
      continue;
    }
    if (setUp(duty.userId)) {
      preview.duties.notCarried.push({ ...ref, groupName: sourceGroupName, reason: 'TEACHER_ALREADY_SET_UP' });
      continue;
    }

    const successor = duty.studentGroupId ? input.successorOf(duty.studentGroupId) : null;
    if (duty.studentGroupId && !successor && duty.kind === 'MENTORSKAP') {
      preview.duties.notCarried.push({ ...ref, groupName: sourceGroupName, reason: 'GROUP_LEAVES' });
      leaving.mentorskapDuties++;
      if (sourceGroupName) leaving.mentorskap.add(sourceGroupName);
      continue;
    }
    const label =
      successor && sourceGroupName ? promoteLabel(duty.label, sourceGroupName, successor.name) : duty.label;

    if (existing) {
      const same = (candidate: ExistingStaffing['duties'][number]) =>
        !absorbed.has(candidate.id) && candidate.userId === duty.userId && candidate.kind === duty.kind;
      const labels = new Set([normalizeDutyLabel(duty.label), normalizeDutyLabel(label)]);
      const match =
        (successor ? existing.duties.find((candidate) => same(candidate) && candidate.groupKey === successor.key) : undefined) ??
        existing.duties.find(
          (candidate) =>
            same(candidate) &&
            (candidate.groupKey === null || (successor !== null && candidate.groupKey === successor.key)) &&
            labels.has(normalizeDutyLabel(candidate.label)),
        );
      if (match) {
        absorbed.add(match.id);
        preview.duties.notCarried.push({ ...ref, groupName: sourceGroupName, reason: 'ALREADY_PRESENT' });
        continue;
      }
    }

    if (duty.studentGroupId && !successor) {
      preview.duties.groupDropped.push({ ...ref, groupName: sourceGroupName });
      if (sourceGroupName) leaving.dropped.add(sourceGroupName);
    }
    if (successor) {
      preview.duties.followedGroup++;
      if (label !== duty.label) {
        preview.duties.relabelled.push({ sourceDutyId: duty.id, userId: duty.userId, from: duty.label, to: label });
      }
    }
    let slot: DutySlot | null = null;
    if (duty.slot) {
      if (isOnSolverGrid(duty.slot)) {
        slot = { dayOfWeek: duty.slot.dayOfWeek, startTime: clockOf(duty.slot.startTime), endTime: clockOf(duty.slot.endTime) };
        preview.duties.slots++;
      } else {
        preview.duties.slotDropped.push({ ...ref, reason: 'OFF_GRID' });
      }
    }
    if (existing && slot) {
      const near = existing.duties.find((candidate) => candidate.userId === duty.userId && candidate.slot && overlaps(slot!, candidate.slot));
      if (near) preview.duties.overlapsTargetDuty.push({ ...ref, targetDutyId: near.id });
    }
    if (existing && successor && duty.kind === 'MENTORSKAP' && mentoredGroups.has(successor.key)) {
      preview.duties.successorHasMentor.push({ ...ref, groupName: successor.name });
    }
    writes.duties.push({
      sourceDutyId: duty.id,
      userId: duty.userId,
      kind: duty.kind,
      label,
      minutesPerWeek: duty.minutesPerWeek,
      countsAsTeaching: duty.countsAsTeaching,
      subjectId: duty.subjectId,
      groupKey: successor?.key ?? null,
      note: duty.note,
      slot,
    });
    preview.duties.carried++;
    const sum = carriedPerTeacher.get(duty.userId) ?? { duties: 0, minutes: 0 };
    sum.duties++;
    sum.minutes += duty.minutesPerWeek;
    carriedPerTeacher.set(duty.userId, sum);
  }

  const people = [...new Set([...staffing.employments.map((row) => row.userId), ...staffing.duties.map((row) => row.userId)])].sort();
  preview.teachers = people.map((userId) => ({
    userId,
    employment: employmentOf.get(userId) ?? 'NONE',
    duties: carriedPerTeacher.get(userId)?.duties ?? 0,
    dutyMinutesPerWeek: carriedPerTeacher.get(userId)?.minutes ?? 0,
  }));

  // ---- problems: advice, never blocking
  const problems: StaffingProblem[] = [];
  const add = (code: StaffingProblemCode, params: StaffingProblem['params']) => problems.push({ code, blocking: false, params });
  if (leaving.mentorskapDuties > 0) {
    add('STAFFING_MENTORSKAP_NOT_CARRIED', { duties: leaving.mentorskapDuties, groups: [...leaving.mentorskap].sort() });
  }
  if (preview.duties.groupDropped.length > 0) {
    add('STAFFING_DUTY_GROUP_DROPPED', { duties: preview.duties.groupDropped.length, groups: [...leaving.dropped].sort() });
  }
  if (notCarriedPeople.size > 0) add('STAFFING_TEACHERS_NOT_CARRIED', { teachers: notCarriedPeople.size });
  if (preview.duties.slotDropped.length > 0) add('STAFFING_SLOT_OFF_GRID', { duties: preview.duties.slotDropped.length });
  if (preview.employments.withReduction.length > 0 || preview.employments.withTargetOverride.length > 0) {
    add('STAFFING_PER_YEAR_TERMS_CARRIED', {
      reductions: preview.employments.withReduction.length,
      overrides: preview.employments.withTargetOverride.length,
    });
  }
  if (preview.employments.signaturesDropped.length > 0) {
    add('STAFFING_SIGNATURE_TAKEN', { teachers: preview.employments.signaturesDropped.length });
  }
  if (existing) {
    const teachers = preview.employments.notCarried.filter((row) => row.reason === 'ALREADY_PRESENT').length;
    const duties = preview.duties.notCarried.filter(
      (row) => row.reason === 'ALREADY_PRESENT' || row.reason === 'TEACHER_ALREADY_SET_UP',
    ).length;
    if (teachers > 0 || duties > 0) add('STAFFING_ALREADY_PRESENT', { teachers, duties });
  }
  return { preview, problems, writes };
}

/** A lesson of the target year, for STAFFING_SLOTS_OVER_LESSONS. */
export interface TargetLesson {
  teacherId: string | null;
  coTeacherId: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

/**
 * The carried slots that would land on a lesson the teacher already has in
 * the target: a carry into a year that is already scheduled turns those
 * lessons into conflicts. Advice, outside the hash: a lesson moved between
 * preview and execute changes no row the carry writes.
 */
export function slotsOverLessons(writes: StaffingWrites, lessons: readonly TargetLesson[]): StaffingProblem | null {
  let duties = 0;
  const hit = new Set<number>();
  for (const duty of writes.duties) {
    if (!duty.slot) continue;
    let any = false;
    lessons.forEach((lesson, index) => {
      if ((lesson.teacherId === duty.userId || lesson.coTeacherId === duty.userId) && overlaps(duty.slot!, lesson)) {
        hit.add(index);
        any = true;
      }
    });
    if (any) duties++;
  }
  return duties > 0 ? { code: 'STAFFING_SLOTS_OVER_LESSONS', blocking: false, params: { duties, lessons: hit.size } } : null;
}

/**
 * The writes in a fixed order, for a hash: posts by teacher, uppdrag by
 * their source row, slot times as HH:MM. The order the rows were read in
 * never changes the hash.
 */
export function stableStaffing(writes: StaffingWrites): StaffingWrites {
  return {
    employments: [...writes.employments].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)),
    duties: [...writes.duties]
      .sort((a, b) => (a.sourceDutyId < b.sourceDutyId ? -1 : a.sourceDutyId > b.sourceDutyId ? 1 : 0))
      .map((duty) => ({
        ...duty,
        slot: duty.slot
          ? { dayOfWeek: duty.slot.dayOfWeek, startTime: clockOf(duty.slot.startTime), endTime: clockOf(duty.slot.endTime) }
          : null,
      })),
  };
}

/** The standalone carry's hash: both years and the writes. */
export function hashStaffingCarry(sourceYearId: string, targetYearId: string, writes: StaffingWrites): string {
  return createHash('sha256')
    .update(JSON.stringify({ sourceYearId, targetYearId, staffing: stableStaffing(writes) }))
    .digest('hex');
}
