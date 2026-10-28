import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { LessonRecurrence, PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError, writeConflict } from '../common/utils/prisma-errors';
import { parseDateString } from '../common/utils/time';
import { canonicalShape, lengthsProblem, type CanonicalShape } from '../common/lesson-lengths';
import { sharesProblem } from '../common/lesson-shares';
import { requirementName } from '../optimization/optimization-proxy.service';
import { RequirementImportChecks, SAME_TEACHER_TWICE, sameTeacherTwice } from '../staffing/staffing-enforcement';
import { staffingSentence } from '../staffing/staffing-checks';
import { readsHr } from '../staffing/hr-visibility';
import { readYearBoundsForShare } from './academic-year-bounds';
import {
  CLASS_ALREADY_SPLIT,
  NOT_A_CLASS,
  NOT_THE_CLASS_HALVES,
  lockClassForSplit,
  splitLockedClass,
} from './student-groups.service';
import {
  TEACHING_BLOCK_NAME_TAKEN,
  blockName,
  type BlockStaffingWarning,
} from './teaching-blocks.service';
import { requirementResponse, type TeachingRequirementResponse } from './teaching-requirements.service';
import { SHARE_SELECT, lockPostForShares, sharesRefusal } from './requirement-shares';
import type { AdjustedPostDto, SplitByTermDto } from './dto/term-halves.dto';

/** The problem codes "Dela terminsvis i halvklass" answers with besides the shared ones. */
export const TERM_SUBJECTS_SAME = 'TERM_SUBJECTS_SAME';
export const TERM_TEACHER_TWICE = 'TERM_TEACHER_TWICE';
export const REQUIREMENT_IN_A_BLOCK = 'REQUIREMENT_IN_A_BLOCK';
export const REQUIREMENT_HAS_PERIOD = 'REQUIREMENT_HAS_PERIOD';
export const SPRING_START_OUTSIDE_YEAR = 'SPRING_START_OUTSIDE_YEAR';
/** Neither `springStartDate` nor `periods`, or both. */
export const TERM_PERIODS_MISSING = 'TERM_PERIODS_MISSING';
/** Two periods that are not two of the year's stretches, the first before the second. */
export const TERM_PERIODS_INVALID = 'TERM_PERIODS_INVALID';
/** The halves' `lessons` as no timplanspost can hold them. */
export const TERM_LESSONS_INVALID = 'TERM_LESSONS_INVALID';
/**
 * `adjustedPost` that is not the class's own post in one of a swap's two
 * subjects: one subject, another group's post, another subject's, the post
 * being split, or none.
 */
export const TERM_ADJUSTED_POST_INVALID = 'TERM_ADJUSTED_POST_INVALID';
export const CLASS_HAS_ONE_HALF = 'CLASS_HAS_ONE_HALF';
export const HALF_HAS_SUBJECT = 'HALF_HAS_SUBJECT';
/**
 * The class's post splits its lessons between teachers (delade lektioner).
 * The halves' four posts are staffed per subject, and a share has no half or
 * term to go to, so the split is refused rather than the shares dropped.
 */
export const TERM_SPLIT_HAS_SHARES = 'TERM_SPLIT_HAS_SHARES';

/** The refusal of a shared post, named; `params` for the reader's language. */
function splitHasShares(postName: string): ConflictException {
  return new ConflictException({
    message:
      `${postName} delar sina lektioner mellan lärare. Ta bort delningen i postens dialog först, ` +
      'och välj sedan lärare för varje ämne här.',
    code: TERM_SPLIT_HAS_SHARES,
    params: { requirement: postName },
  });
}

/** What the split wrote: the halves, the two blocks and the two or four posts. */
export interface TermHalvesResponse {
  /** The class's two halves, the first half first. */
  halves: { id: string; name: string }[];
  /** Whether this request split the class (false: it had its halves). */
  createdHalves: boolean;
  /**
   * The first period's block first, each with its posts (two with two
   * subjects, one with one); the second's names the first's as the block
   * whose times it takes.
   */
  blocks: { id: string; name: string; sameTimesAsBlockId: string | null; requirementIds: string[] }[];
  /**
   * The posts, the first half's first: with two subjects its first period's
   * and its second's, then the second half's; with one subject the first
   * half's (the first period) and the second half's (the second).
   */
  requirements: TeachingRequirementResponse[];
  /** The class's post, which the new posts replace. */
  removedRequirementId: string;
  /** The class's own post in the swap's other subject, as `adjustedPost` left it; null without one. */
  adjustedRequirement: TeachingRequirementResponse | null;
  /** The staffing policy's WARNs, each with the new post it is about. */
  warnings: BlockStaffingWarning[];
  /**
   * The subjects that do not carry the class's post's national code (or
   * every chosen one, when that post has none): Skapa timplansposter will
   * not see that the halves read the class's line in them, and the plan's
   * national rows will not count them toward it. Said, not refused — a
   * school may mean it — and empty when the codes agree.
   */
  codeWarnings: { subjectId: string; subjectName: string; nationalCode: string | null; lineNationalCode: string | null }[];
}

/**
 * A WARN about a post not written yet, by its place among the new ones; the
 * adjusted post's (written by id) is ADJUSTED.
 */
type PlannedWarning = Omit<BlockStaffingWarning, 'requirementId'> & { index: number };
const ADJUSTED = -1;

const DAY_MS = 24 * 60 * 60 * 1000;
const asDay = (date: Date): string => date.toISOString().slice(0, 10);

/** A period as the posts store it: an end that is the year's own is null. */
interface StoredPeriod {
  startDate: Date | null;
  endDate: Date | null;
}

/**
 * The two periods the halves take turns over, as stored: an end that is the
 * year's own is null, so a läsår whose dates move, or a rollover, keeps the
 * period whole. From `springStartDate` the autumn and the spring, as before;
 * from `periods` two of the year's stretches, the first ending before the
 * second starts, so the halves never read in the same week. A 400 by code
 * for anything else.
 */
export function periodsOf(
  dto: Pick<SplitByTermDto, 'springStartDate' | 'periods'>,
  year: { startDate: Date; endDate: Date },
): [StoredPeriod, StoredPeriod] {
  const stored = (start: Date, end: Date): StoredPeriod => ({
    startDate: start.getTime() === year.startDate.getTime() ? null : start,
    endDate: end.getTime() === year.endDate.getTime() ? null : end,
  });
  if (dto.springStartDate != null) {
    const springStart = parseDateString(dto.springStartDate);
    if (springStart <= year.startDate || springStart > year.endDate) {
      throw new BadRequestException({
        message:
          `springStartDate: vårterminen börjar efter läsårets första dag och senast dess sista ` +
          `(${asDay(year.startDate)} till ${asDay(year.endDate)}).`,
        code: SPRING_START_OUTSIDE_YEAR,
      });
    }
    return [stored(year.startDate, new Date(springStart.getTime() - DAY_MS)), stored(springStart, year.endDate)];
  }
  const [first, second] = (dto.periods ?? []).map((period) => ({
    start: parseDateString(period.startDate),
    end: parseDateString(period.endDate),
  })) as [{ start: Date; end: Date }, { start: Date; end: Date }];
  const invalid = (detail: string) =>
    new BadRequestException({ message: `periods: ${detail}`, code: TERM_PERIODS_INVALID });
  for (const period of [first, second]) {
    if (period.end < period.start) throw invalid('en period slutar inte före den börjar.');
    if (period.start < year.startDate || period.end > year.endDate) {
      throw invalid(`båda perioderna ligger inom läsåret (${asDay(year.startDate)} till ${asDay(year.endDate)}).`);
    }
  }
  if (second.start <= first.end) {
    throw invalid('den andra perioden börjar efter att den första slutat, så att halvorna aldrig läser samma vecka.');
  }
  return [stored(first.start, first.end), stored(second.start, second.end)];
}

/**
 * The halves' week: `lessons` as the timplanspost stores it, or the class's
 * post's when the request names none. Refused by code where the post's own
 * dialog would refuse the same lengths.
 */
export function halvesShape(
  lessons: readonly number[] | null | undefined,
  source: { lessonsPerWeek: number; minutesPerLesson: number; lessonLengths: number[] },
  field = 'lessons',
): CanonicalShape {
  if (lessons == null) {
    return {
      lessonsPerWeek: source.lessonsPerWeek,
      minutesPerLesson: source.minutesPerLesson,
      lessonLengths: source.lessonLengths,
    };
  }
  const problem = lengthsProblem(lessons);
  if (problem !== null) {
    const detail: Record<typeof problem, string> = {
      EMPTY: 'minst en lektion i veckan.',
      NOT_INTEGER: 'varje längd anges i hela minuter.',
      OUT_OF_RANGE: 'varje lektion är 15 till 240 minuter.',
      OFF_GRID: 'varje längd är jämnt delbar med 5 minuter.',
      TOO_MANY_LESSONS: 'högst 40 lektioner per vecka.',
      TOO_MANY_KINDS: 'högst tre olika längder.',
    };
    throw new BadRequestException({ message: `${field}: ${detail[problem]}`, code: TERM_LESSONS_INVALID });
  }
  return canonicalShape(lessons);
}

/** The adjusted post as the split reads it: what its guards and its judge need. */
interface AdjustedPost {
  id: string;
  teacherId: string | null;
  coTeacherId: string | null;
  shareTeacherIds: (string | null)[];
  shape: CanonicalShape;
}

/**
 * `adjustedPost`, read and held to the guards the post's own dialog holds a
 * new week to (TeachingRequirementsService.update): the class's own post in
 * one of the swap's two subjects — the one that is not the split post's,
 * whichever half reads it first — the lengths a post can hold, and its shares
 * fitting the new week (sharesProblem, said by its own code before the
 * trigger, TS409, would say it). Read without a lock, as a PATCH reads the
 * row; the UPDATE takes it, after the posts the split writes. A parallel
 * block holding the post refuses a week its other posts do not have (TB409,
 * the 409 BLOCK_MEMBERS_DIFFER), and nothing of the split is written then.
 */
async function readAdjustedPost(
  tx: PrismaClient,
  asked: AdjustedPostDto,
  args: {
    classId: string;
    className: string;
    academicYearId: string;
    sourceId: string;
    /** The swap's two subjects, by id and name; one subject is no swap. */
    subjects: readonly { id: string; name: string }[];
  },
): Promise<AdjustedPost> {
  const invalid = (detail: string) =>
    new BadRequestException({ message: `adjustedPost: ${detail}`, code: TERM_ADJUSTED_POST_INVALID });
  if (args.subjects.length < 2) {
    throw invalid('klassens post i bytets andra ämne ändras bara vid ett byte mellan två ämnen.');
  }
  const post = await tx.teachingRequirement.findFirst({
    where: {
      id: asked.requirementId,
      studentGroupId: args.classId,
      academicYearId: args.academicYearId,
      subjectId: { in: args.subjects.map((subject) => subject.id) },
    },
    select: {
      id: true,
      teacherId: true,
      coTeacherId: true,
      lessonsPerWeek: true,
      minutesPerLesson: true,
      lessonLengths: true,
      shares: SHARE_SELECT,
    },
  });
  if (!post || post.id === args.sourceId) {
    throw invalid(
      `posten är inte ${args.className}s egen post i ${args.subjects.map((subject) => subject.name).join(' eller ')}, ` +
        'utöver den som delas.',
    );
  }
  const shape = halvesShape(asked.lessons, post, 'adjustedPost.lessons');
  const shares = post.shares ?? [];
  const problem = sharesProblem({ teacherId: post.teacherId, coTeacherId: post.coTeacherId, ...shape }, shares);
  if (problem !== null) throw sharesRefusal(problem);
  return {
    id: post.id,
    teacherId: post.teacherId,
    coTeacherId: post.coTeacherId,
    shareTeacherIds: shares.map((share) => share.teacherId),
    shape,
  };
}

/**
 * "Dela i halvklass": a class's post, slöjd for 7A, replaced by four on the
 * class's two halves, so that one half reads textilslöjd in the autumn and
 * trä- och metallslöjd in the spring and the other half the other way round.
 * Everything the school could already do by hand in eight steps on two pages
 * (Dela klassen, four posts with a period each, two blocks, the class's post
 * removed), done in one transaction from the post.
 *
 * TWO PERIODS, NOT ONLY TWO TERMS. The halves take turns over two of the
 * year's stretches: the autumn and the spring (`springStartDate`), or any two
 * (`periods`) — the first and the second half of the autumn, or half the
 * autumn and half the spring. A post's period is its own startDate and
 * endDate, which every reader already reads (the lessons the generator
 * writes, the coverage, the load report, the rollover's date shift), so a
 * shorter period is the same split with other dates.
 *
 * ONE SUBJECT, OR TWO. Hemkunskap in halvklass is one subject: the first half
 * reads it in the first period and the second half in the second, and
 * neither reads it outside its own. That is two posts, one per half and
 * period, in a block each. With two subjects the halves swap them as below.
 *
 * THE HALVES' OWN WEEK, WHEN ASKED. A half that reads its hemkunskap in half
 * a term has a quarter of the year to read the class's hours in: the load
 * report and the timplan weigh a dated post by its share of the year's
 * teaching weeks (standardWeekWeight), so 1 × 30 over a quarter of the year
 * is a quarter of the class's 1 × 30. `lessons` is the halves' week when it is
 * not the class's (4 × 30, or 1 × 120); the dialog proposes the one that keeps
 * each pupil's hours and shows the figures. Every new post has the same week,
 * which a block holds (TB409) and the generator's same-times needs.
 *
 * A SWAP IS BETWEEN TWO SUBJECTS. A group has one post per subject in a year
 * (TeachingRequirements' unique key, which the generator, the coverage and
 * the hand-edit checks all read as "the demand of this group in this
 * subject"), so a half cannot hold slöjd in the autumn and slöjd again in the
 * spring. The swap is between two subjects, which is also what lets each
 * half's post ask for its own sal: textilsalen and trä- och metallsalen are
 * the subjects' room types. Hemkunskap is no swap: each half reads it once.
 *
 * ONE BLOCK PER PERIOD. A block's posts have the same lessons and weeks by
 * trigger (TB409), and the first period's posts have other weeks than the
 * second's. So with two subjects the first period's block holds the first
 * half's first subject and the second half's second, and the second period's
 * block the swap. Each block puts its two halves at the same times, which is
 * what keeps the class's week from holding slöjd twice: two halves of one
 * class never share a pupil, so the block is always one the generator
 * accepts. With one subject each block holds the one post of its period;
 * the block is there for the link below.
 *
 * THE SECOND PERIOD ON THE FIRST'S TIMES. The generator plans one week and
 * has no terms, so two blocks would each get their own times, both held all
 * year, and one of them empty each period. The second period's block names
 * the first's (TeachingBlocks."sameTimesAsBlockId"): the generator places the
 * first period's block and writes each post of the second at the times of
 * the first period's post in its subject, which is its room's subject and,
 * the halves swapping, usually its teacher's (same-times.ts). With one
 * subject the first half's hemkunskap is placed for the whole class, so the
 * second half is free at those times too, and the second half's is written
 * there in its own weeks. A lock takes the two together, and so does a card
 * move where the blocks have cards (two subjects).
 *
 * THE SWAP'S OTHER LINE. Hemkunskap swapped with slöjd gives each pupil
 * slöjd in the half's other period, on top of the class's own slöjd post.
 * `adjustedPost` brings that post down in the same transaction — the dialog
 * proposes how far, judged by the timplan (web/lib/half-class-timplan.ts) —
 * with the guards a new week meets in the post's own dialog (readAdjustedPost)
 * and the staffing policy's questions asked of it before the new posts', so
 * its teacher's load is the lighter one when theirs are judged.
 *
 * THE NEW POSTS CARRY THE CLASS'S POST OVER: its lessons (count, lengths,
 * ombyte, its own distribution, its weeks) unless `lessons` names the
 * halves' own, and how much of it counts for the teacher and the co-teacher
 * (teacherLoadPercent, coTeacherLoadPercent). The teacher is each subject's
 * own, named in the request. The co-teacher is the class's post's unless the
 * request names one per subject (null for none); the class's post is
 * removed, so its teachers' load is released before the new posts are
 * judged, and the new ones are charged at the carried percentages, each over
 * its own period (periodsOf).
 *
 * NOBODY ON BOTH SUBJECTS. Each block holds one post of each subject at the
 * same times, and the generator refuses a block whose posts share a teacher
 * or co-teacher. So a person, as teacher or co-teacher, on both subjects is
 * refused (TERM_TEACHER_TWICE) — which is also what a class's co-teacher,
 * carried to both subjects by default, comes to: the request has to say
 * which subject they follow, and nothing is dropped unseen. One subject's
 * teacher has the two halves one after the other, never at once.
 *
 * WHICH HALF IS THE FIRST. A class that has its halves is split in the order
 * the request names them (`halfIds`, the order the dialog drew), since the
 * database's collation and the browser's need not sort two names alike; a
 * request without them gets the halves by name, and the answer says the
 * order it used. A request that names halves the class no longer has, or new
 * names for a class that has halves since, is a 409 with nothing written.
 *
 * REFUSED: a post that is not a class's (a half is split already), one in a
 * block (removing it would leave the block without it unseen), one with a
 * period of its own (it is already a part of the year), the same subject
 * twice, a person on both subjects, a teacher who is their own co-teacher, a
 * spring start that leaves either term empty, periods that are not two of the
 * year's in order, lessons no post can hold, a half that already has a post
 * in one of the subjects, a class with only one half left, halves that are
 * not the class's, and a block name the year has. Each by its own code,
 * before anything is written.
 *
 * LOCK ORDER: the year FOR SHARE first, as a timplanspost create or PATCH
 * with a period takes it, and as year activation takes it before the year's
 * groups (FOR NO KEY UPDATE, then the groups FOR SHARE): taken after the
 * class, the two could wait on each other. Then the class row (FOR NO KEY
 * UPDATE, as Dela klassen takes it, so two splits of one class run one after
 * the other and the second finds the post gone), then the teachers' posts
 * (RequirementImportChecks, the import's order), then the requirement rows.
 * The class's post is read without a lock, as a timplanspost PATCH reads it,
 * and removed by a DELETE that matches only the post as it was read — its
 * updatedAt among the rest: any write to it in between makes the whole split
 * a 409 with nothing written.
 */
@Injectable()
export class TermHalvesService {
  constructor(private readonly prisma: PrismaService) {}

  async split(
    requirementId: string,
    dto: SplitByTermDto,
    user: AuthenticatedUser,
  ): Promise<TermHalvesResponse> {
    const schoolId = requireSchoolId(user);
    const [first, second] = dto.subjects;
    if (!first) throw new BadRequestException('subjects: ett eller två ämnen.');
    if (second && first.subjectId === second.subjectId) {
      throw new BadRequestException({
        message:
          'subjects: halvorna byter mellan två olika ämnen, till exempel textilslöjd och trä- och metallslöjd. ' +
          'Läser halvorna samma ämne var sin period, ange det en gång.',
        code: TERM_SUBJECTS_SAME,
      });
    }
    // The subjects in the order the halves take them: one, or the swap's two.
    const pair = second ? [first, second] : [first];
    for (const subject of dto.subjects) {
      if (sameTeacherTwice(subject.teacherId, subject.coTeacherId)) {
        throw new BadRequestException(SAME_TEACHER_TWICE);
      }
    }
    if (dto.halfIds && dto.halfNames) {
      throw new BadRequestException('halfIds och halfNames: klassen har halvor eller får nya, inte båda.');
    }
    // An explicit null is no value either (@IsOptional lets it through).
    if ((dto.springStartDate == null) === (dto.periods == null)) {
      throw new BadRequestException({
        message: 'springStartDate eller periods: vårterminens första dag, eller två perioder, inte båda.',
        code: TERM_PERIODS_MISSING,
      });
    }
    const askedBlockNames = dto.blockNames?.map(blockName);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const located = await tx.teachingRequirement.findUnique({
          where: { id: requirementId },
          select: { studentGroupId: true, academicYearId: true },
        });
        if (!located) throw new NotFoundException('Timplansposten finns inte.');
        // The year before the class: see LOCK ORDER above. A post never
        // changes year, so the one read here is the post's.
        const year = await readYearBoundsForShare(tx, located.academicYearId);
        // A year RLS hides is a post RLS hides; the guard is for the type.
        if (!year) throw new NotFoundException('Timplansposten finns inte.');
        await lockClassForSplit(tx, located.studentGroupId);

        const source = await tx.teachingRequirement.findUnique({
          where: { id: requirementId },
          include: {
            subject: { select: { name: true, nationalCode: true } },
            block: { select: { name: true } },
            // Delade lektioner: whether the post has a share, counted in
            // this statement.
            _count: { select: { shares: true } },
            studentGroup: {
              select: {
                id: true,
                name: true,
                kind: true,
                halves: { select: { id: true, name: true }, orderBy: { name: 'asc' } },
              },
            },
          },
        });
        // Moved to another group while this waited on the class: not the
        // post the request was about any more.
        if (!source || source.studentGroupId !== located.studentGroupId) {
          throw new NotFoundException('Timplansposten finns inte.');
        }
        const theClass = source.studentGroup;
        const postName = requirementName(source.subject.name, theClass.name);
        if (theClass.kind !== 'CLASS') {
          throw new BadRequestException({
            message: `${postName} är en undervisningsgrupps post. Bara en klass post kan delas terminsvis i halvklass.`,
            code: NOT_A_CLASS,
          });
        }
        if (source.blockId !== null) {
          throw new ConflictException({
            message: `${postName} ligger i blocket "${source.block?.name ?? ''}". Ta den ur blocket först.`,
            code: REQUIREMENT_IN_A_BLOCK,
          });
        }
        if (source.startDate !== null || source.endDate !== null) {
          throw new BadRequestException({
            message: `${postName} gäller redan bara en del av läsåret. Ta bort postens datum först.`,
            code: REQUIREMENT_HAS_PERIOD,
          });
        }
        if (source._count.shares > 0) throw splitHasShares(postName);

        const periods = periodsOf(dto, year);
        const shape = halvesShape(dto.lessons, source);

        // Who teaches each subject: its teacher, and its co-teacher — the
        // class's post's unless the request names one (null for none).
        const staff = pair.map((subject) => ({
          teacherId: subject.teacherId ?? null,
          coTeacherId: subject.coTeacherId === undefined ? source.coTeacherId : subject.coTeacherId,
        }));
        for (const [index, people] of staff.entries()) {
          if (sameTeacherTwice(people.teacherId, people.coTeacherId)) {
            // Only the carried co-teacher can get here: a request naming the
            // pair itself was answered before the transaction.
            throw new BadRequestException(
              `subjects: ${postName} har läraren som medlärare i ämne ${index + 1}. Välj en annan medlärare för ämnet, eller ingen.`,
            );
          }
        }
        const onFirst = new Set([staff[0]!.teacherId, staff[0]!.coTeacherId].filter((id): id is string => id !== null));
        if (staff[1] && [staff[1].teacherId, staff[1].coTeacherId].some((id) => id !== null && onFirst.has(id))) {
          throw new BadRequestException({
            message:
              'subjects: halvorna har lektion samtidigt, så samma lärare eller medlärare kan inte finnas i båda ämnena.' +
              (source.coTeacherId !== null && staff.every((people) => people.coTeacherId === source.coTeacherId)
                ? ` ${postName} har en medlärare: välj vilket av ämnena hen följer, eller inget.`
                : ''),
            code: TERM_TEACHER_TWICE,
          });
        }

        const subjects = await tx.subject.findMany({
          where: { id: { in: pair.map((subject) => subject.subjectId) } },
          select: { id: true, name: true, nationalCode: true },
        });
        const subjectName = new Map(subjects.map((subject) => [subject.id, subject.name]));
        // The class's line as Skapa timplansposter and the plan's national
        // rows read it: the post's subject, or another with its code.
        const lineCode = source.subject.nationalCode ?? null;
        const codeWarnings = subjects
          .filter((subject) => subject.id !== source.subjectId && (lineCode === null || subject.nationalCode !== lineCode))
          .sort((a, b) => (a.id === first.subjectId ? -1 : b.id === first.subjectId ? 1 : 0))
          .map((subject) => ({
            subjectId: subject.id,
            subjectName: subject.name,
            nationalCode: subject.nationalCode ?? null,
            lineNationalCode: lineCode,
          }));
        if (pair.some((subject) => !subjectName.has(subject.subjectId))) {
          throw new BadRequestException('subjects: ett av ämnena finns inte i skolan.');
        }
        const adjusted = dto.adjustedPost
          ? await readAdjustedPost(tx, dto.adjustedPost, {
              classId: theClass.id,
              className: theClass.name,
              academicYearId: source.academicYearId,
              sourceId: source.id,
              subjects: pair.map((subject) => ({ id: subject.subjectId, name: subjectName.get(subject.subjectId) ?? '' })),
            })
          : null;

        // The class's halves, or two new ones. A class with one half left
        // (the other removed) cannot be split again until that one goes too.
        let createdHalves = false;
        let halves: { id: string; name: string }[] = theClass.halves;
        if (halves.length === 0) {
          if (dto.halfIds) {
            throw new ConflictException({
              message: `${theClass.name} har inte längre halvorna som valdes. Öppna dialogen igen.`,
              code: NOT_THE_CLASS_HALVES,
            });
          }
          halves = (await splitLockedClass(tx, schoolId, theClass.id, dto.halfNames)).map(({ id, name }) => ({ id, name }));
          createdHalves = true;
        } else if (dto.halfNames) {
          // The request drew new halves; the class has halves since.
          throw new ConflictException({ message: `${theClass.name} är redan delad i halvor. Öppna dialogen igen.`, code: CLASS_ALREADY_SPLIT });
        } else if (halves.length !== 2) {
          throw new ConflictException({
            message:
              `${theClass.name} har bara halvan ${halves.map((half) => half.name).join(', ')}. ` +
              'Ta bort den under Klasser och försök igen, så delas klassen i två nya halvor.',
            code: CLASS_HAS_ONE_HALF,
          });
        } else if (dto.halfIds) {
          // The order the request drew them in, when they are the class's two.
          const byId = new Map(halves.map((half) => [half.id, half]));
          const named = dto.halfIds.map((id) => byId.get(id));
          if (named.some((half) => half === undefined) || new Set(dto.halfIds).size !== 2) {
            throw new ConflictException({
              message: `halfIds: halvorna är inte ${theClass.name}s två halvor. Öppna dialogen igen.`,
              code: NOT_THE_CLASS_HALVES,
            });
          }
          halves = named as { id: string; name: string }[];
        }

        const taken = await tx.teachingRequirement.findMany({
          where: {
            studentGroupId: { in: halves.map((half) => half.id) },
            subjectId: { in: pair.map((subject) => subject.subjectId) },
          },
          select: { studentGroup: { select: { name: true } }, subject: { select: { name: true } } },
          orderBy: [{ studentGroup: { name: 'asc' } }, { subject: { name: 'asc' } }],
        });
        if (taken.length > 0) {
          throw new ConflictException({
            message:
              taken.map((row) => `${row.studentGroup.name} har redan en post i ${row.subject.name}`).join(', ') +
              (taken.length === 1 ? '. Ta bort den eller välj ett annat ämne.' : '. Ta bort dem eller välj andra ämnen.'),
            code: HALF_HAS_SUBJECT,
          });
        }

        const names =
          askedBlockNames ??
          (dto.springStartDate != null ? ['HT', 'VT'] : ['period 1', 'period 2']).map((suffix) =>
            blockName(`${source.subject.name} ${theClass.name} ${suffix}`),
          );
        if (names[0]!.toLowerCase() === names[1]!.toLowerCase()) {
          throw new BadRequestException('blockNames: två olika namn, ett för varje period.');
        }
        const takenBlocks = await tx.teachingBlock.findMany({
          where: { academicYearId: source.academicYearId, name: { in: names } },
          select: { name: true },
          orderBy: { name: 'asc' },
        });
        if (takenBlocks.length > 0) {
          throw new ConflictException({
            message: `Läsåret har redan ett block som heter "${takenBlocks[0]!.name}".`,
            code: TEACHING_BLOCK_NAME_TAKEN,
          });
        }

        // The posts: half h reads subject (h + period) mod 2 in each period —
        // with one subject, the first half in the first period and the second
        // half in the second, and nobody in the other.
        const planned = halves.flatMap((half, h) =>
          periods.flatMap((period, t) => {
            const index = (h + t) % 2;
            const subject = pair[index];
            return subject ? [{ half, term: t, ...period, subjectId: subject.subjectId, ...staff[index]! }] : [];
          }),
        );

        const warnings = await this.judge(tx, user, source, shape, planned, subjectName, adjusted);

        // Delade lektioner: the post locked as a shares PATCH locks it
        // (lockPostForShares), where the DELETE below would take it anyway —
        // after the teachers' posts, the import's order — and its shares
        // counted again in a statement of their own. A PATCH that committed
        // since the read above is seen here; one after waits for the split
        // and finds the post gone. The DELETE's `shares: none` alone is
        // judged on the DELETE's snapshot, and a share committed while it
        // waited on the row would go with the post.
        await lockPostForShares(tx, source.id);
        if ((await tx.teachingRequirementShare.count({ where: { requirementId: source.id } })) > 0) {
          throw splitHasShares(postName);
        }

        const { count } = await tx.teachingRequirement.deleteMany({
          where: {
            id: source.id,
            studentGroupId: theClass.id,
            blockId: null,
            startDate: null,
            endDate: null,
            lessonsPerWeek: source.lessonsPerWeek,
            minutesPerLesson: source.minutesPerLesson,
            // Any write to the post since it was read moves this, whatever
            // the write was: a recurrence, a length, a teacher.
            updatedAt: source.updatedAt,
            // A share is written to its own table and moves no updatedAt: one
            // saved since the read makes the split a 409 too, not a share
            // removed with the post.
            shares: { none: {} },
          },
        });
        if (count !== 1) throw writeConflict();

        // The first period's first, so the second's can name it.
        const blocks: { id: string; name: string; sameTimesAsBlockId: string | null }[] = [];
        for (const name of names) {
          blocks.push(
            await tx.teachingBlock.create({
              data: { schoolId, academicYearId: source.academicYearId, name, sameTimesAsBlockId: blocks[0]?.id ?? null },
              select: { id: true, name: true, sameTimesAsBlockId: true },
            }),
          );
        }

        const created = await tx.teachingRequirement.createManyAndReturn({
          data: planned.map((row) => ({
            schoolId,
            academicYearId: source.academicYearId,
            subjectId: row.subjectId,
            studentGroupId: row.half.id,
            teacherId: row.teacherId,
            coTeacherId: row.coTeacherId,
            teacherLoadPercent: source.teacherLoadPercent,
            coTeacherLoadPercent: source.coTeacherLoadPercent,
            lessonsPerWeek: shape.lessonsPerWeek,
            minutesPerLesson: shape.minutesPerLesson,
            lessonLengths: shape.lessonLengths,
            minutesBefore: source.minutesBefore,
            minutesAfter: source.minutesAfter,
            ownDistribution: source.ownDistribution,
            maxLessonsPerDay: source.maxLessonsPerDay,
            minDaysBetween: source.minDaysBetween,
            recurrence: source.recurrence,
            startDate: row.startDate,
            endDate: row.endDate,
            blockId: blocks[row.term]!.id,
          })),
        });
        // In the planned order, by the (group, subject) the unique key makes one row.
        const byDemand = new Map(created.map((row) => [`${row.studentGroupId}:${row.subjectId}`, row]));
        const rows = planned.map((row) => byDemand.get(`${row.half.id}:${row.subjectId}`)!);
        // The class's post in the second subject, last: its block's trigger
        // (TB409) and its shares' (TS409) judge the week as the PATCH would.
        const adjustedRow = adjusted
          ? await tx.teachingRequirement.update({
              where: { id: adjusted.id },
              data: {
                lessonsPerWeek: adjusted.shape.lessonsPerWeek,
                minutesPerLesson: adjusted.shape.minutesPerLesson,
                lessonLengths: adjusted.shape.lessonLengths,
              },
            })
          : null;

        return {
          halves,
          createdHalves,
          blocks: blocks.map((block, t) => ({
            ...block,
            requirementIds: rows.filter((_, index) => planned[index]!.term === t).map((row) => row.id),
          })),
          requirements: rows.map(requirementResponse),
          removedRequirementId: source.id,
          adjustedRequirement: adjustedRow ? requirementResponse(adjustedRow) : null,
          codeWarnings,
          warnings: warnings.map(({ index, ...warning }) => ({
            ...warning,
            requirementId: index === ADJUSTED ? adjusted!.id : rows[index]!.id,
          })),
        };
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      rethrowPrismaError(error);
    }
  }

  /**
   * The staffing policy's two questions over the new posts, as the import
   * asks them of a file: the year read once, the class's post with its
   * teachers taken off first (it is about to go), and each post laid over the
   * year before the next is asked, with its teacher and co-teacher at the
   * class's post's percentages and the halves' week, so a teacher with the
   * subject in both halves is charged both periods. A REFUSE is a 409 naming
   * the post, and
   * nothing is written; a WARN keeps the index of the post it is about.
   *
   * The adjusted post (adjustedPost) is asked after the class's post is
   * released and before the new posts, as a PATCH of its week would be asked:
   * its teachers are locked with the rest (the import's order), and a teacher
   * of the class's slöjd who also takes the halves' slöjd is judged on the
   * lighter week.
   */
  private async judge(
    tx: PrismaClient,
    user: AuthenticatedUser,
    source: {
      id: string;
      academicYearId: string;
      studentGroupId: string;
      recurrence: LessonRecurrence;
      teacherLoadPercent: number;
      coTeacherLoadPercent: number;
    },
    shape: CanonicalShape,
    planned: readonly {
      half: { id: string; name: string };
      subjectId: string;
      teacherId: string | null;
      coTeacherId: string | null;
      startDate: Date | null;
      endDate: Date | null;
    }[],
    subjectName: ReadonlyMap<string, string>,
    adjusted: AdjustedPost | null,
  ): Promise<PlannedWarning[]> {
    const adjustedTeachers = adjusted ? [adjusted.teacherId, adjusted.coTeacherId, ...adjusted.shareTeacherIds] : [];
    const teacherIds = [
      ...new Set(
        [...planned.flatMap((row) => [row.teacherId, row.coTeacherId]), ...adjustedTeachers].filter(
          (id): id is string => id !== null,
        ),
      ),
    ];
    // No teacher on any post: nothing to ask, and releasing the class's
    // teachers changes no answer.
    if (teacherIds.length === 0) return [];
    const checks = await RequirementImportChecks.open(tx, {
      viewer: user,
      showsPeriods: readsHr(user),
      schoolId: requireSchoolId(user),
      academicYearId: source.academicYearId,
      teacherIds,
      groupIds: [...new Set([source.studentGroupId, ...planned.map((row) => row.half.id)])],
    });
    if (!checks) return [];

    const stored = checks.stored(source.id);
    if (stored) {
      const { after } = checks.judge({
        requirementId: source.id,
        rowNumber: 0,
        subjectId: stored.subjectId,
        subjectName: stored.subjectName,
        studentGroupId: stored.studentGroupId,
        groupName: stored.groupName,
        // Every teacher off the source: the post goes, and its lessons are
        // the halves' from here on. A shared post is refused above.
        patch: { teacherId: null, coTeacherId: null },
      });
      checks.apply(after);
    }

    const warnings: PlannedWarning[] = [];
    const storedAdjusted = adjusted ? checks.stored(adjusted.id) : null;
    if (adjusted && storedAdjusted) {
      const { findings, after } = checks.judge({
        requirementId: adjusted.id,
        rowNumber: 0,
        subjectId: storedAdjusted.subjectId,
        subjectName: storedAdjusted.subjectName,
        studentGroupId: storedAdjusted.studentGroupId,
        groupName: storedAdjusted.groupName,
        patch: {
          lessonsPerWeek: adjusted.shape.lessonsPerWeek,
          minutesPerLesson: adjusted.shape.minutesPerLesson,
          lessonLengths: adjusted.shape.lessonLengths,
        },
      });
      const refusal = findings.find((finding) => finding.mode === 'REFUSE');
      if (refusal) {
        throw new ConflictException({
          message: `${requirementName(storedAdjusted.subjectName, storedAdjusted.groupName)}: ${staffingSentence(refusal)}`,
          code: refusal.code,
          params: { ...refusal.params, subjectId: storedAdjusted.subjectId, studentGroupId: storedAdjusted.studentGroupId },
        });
      }
      warnings.push(...findings.map(({ code, params }) => ({ code, params, index: ADJUSTED })));
      checks.apply(after);
    }
    for (const [index, row] of planned.entries()) {
      if (row.teacherId === null && row.coTeacherId === null) continue;
      const name = subjectName.get(row.subjectId) ?? '';
      const { findings, after } = checks.judge({
        requirementId: null,
        rowNumber: index + 1,
        subjectId: row.subjectId,
        subjectName: name,
        studentGroupId: row.half.id,
        groupName: row.half.name,
        patch: {
          teacherId: row.teacherId,
          coTeacherId: row.coTeacherId,
          // As the class's post counted them: 120 % for the teacher stays 120 %.
          teacherLoadPercent: source.teacherLoadPercent,
          coTeacherLoadPercent: source.coTeacherLoadPercent,
          lessonsPerWeek: shape.lessonsPerWeek,
          minutesPerLesson: shape.minutesPerLesson,
          lessonLengths: shape.lessonLengths,
          recurrence: source.recurrence,
          startDate: row.startDate ? asDay(row.startDate) : null,
          endDate: row.endDate ? asDay(row.endDate) : null,
        },
      });
      const refusal = findings.find((finding) => finding.mode === 'REFUSE');
      if (refusal) {
        throw new ConflictException({
          message: `${requirementName(name, row.half.name)}: ${staffingSentence(refusal)}`,
          code: refusal.code,
          params: { ...refusal.params, subjectId: row.subjectId, studentGroupId: row.half.id },
        });
      }
      warnings.push(...findings.map(({ code, params }) => ({ code, params, index })));
      checks.apply(after);
    }
    return warnings;
  }
}
