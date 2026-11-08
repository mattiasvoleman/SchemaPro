import { HttpException } from '@nestjs/common';

/**
 * DELTID IN DAYS, AND THE LIMIT ON TEACHING IN A ROW: WHO MAY READ A SENTENCE
 * ABOUT THEM.
 *
 * (The second half of this file is the limit on teaching in a row, which
 * moved to the post in 20261218090000 and is read here exactly as the days
 * are: see "THE LIMIT ON TEACHING IN A ROW" below. Everything said about the
 * days holds for it, with a note instead of a refusal.)
 *
 * A post may say on how many days a week its teacher teaches
 * (TeacherEmployments.maxTeachingDaysPerWeek, 20261123090000), and the
 * generator holds it as a hard rule. A week the days make impossible is
 * refused by a sentence that names the limit and its number of days — and
 * the number is HR data like the tjänst % beside it (Roller i skolan): rektor,
 * a full administrator and anyone with HR-läs read it, a schemaläggare or an
 * expedition without HR-läs does not. The generator does not know who will
 * read its refusal. A run is started by one administrator and read, on the
 * Generera page and in its history, by every other, so the refusal cannot be
 * worded for its starter.
 *
 * SO NOTHING HR IS STORED, AND THE READER DECIDES WHAT IS SHOWN. The gateway
 * strips the figure the moment it realises the engine's answer: a sentence
 * whose code bears the days keeps `limit` (the post's id, as a lunch sentence
 * keeps `rule`, the work rule's), loses `days`, and carries this file's
 * English instead of the engine's, so not even the fallback a screen shows
 * for an untranslated code says the number. Whose post it was rides beside it
 * in a field no answer ever carries (`subjectIds`, Users ids), because the
 * Läslogg names people and a post id would be dropped there as nobody. The
 * post itself is then the one place the figure lives, and gallring has no
 * second copy in OptimizationJobs to miss.
 *
 * When the run is read, `forReader` says the sentence to the reader: for one
 * without HR-läs every days-bearing sentence becomes TEACHER_WORK_DAYS_HIDDEN
 * — no figure, no limit, no teacher, its category kept — and two of those say
 * nothing the first did not, so they are one; for one with HR-läs the figure
 * is read back from the post as it stands and the teacher is named. A post
 * that no longer has a limit, or is gone, has nothing to read back, and its
 * sentence stays hidden for that reader too.
 *
 * What a reader without HR-läs can still infer — that some teacher's days are
 * what stops the week, and, by counting the visible timetable, perhaps whose —
 * was weighed and accepted, as it was for STAFF_TEACHER_OVER_TARGET_HIDDEN
 * (src/staffing/staffing-checks.ts): the rule is the same for every reader,
 * only the wording is masked.
 */

/** The masked sentence, for a reader without HR-läs. No params. */
export const TEACHER_WORK_DAYS_HIDDEN = 'TEACHER_WORK_DAYS_HIDDEN' as const;

/**
 * Every sentence whose params carry a post's days. Every code of the
 * catalogue (optimization-engine/app/messages.py) containing WORK_DAYS but the
 * hidden one: work-days.spec.ts reads the catalogue's fixture and fails on a
 * code that is missing here, because a days sentence this list does not know
 * reaches every administrator as the engine wrote it.
 */
export const DAYS_BEARING_CODES: readonly string[] = [
  'TEACHER_WORK_DAYS_CANNOT_BE_KEPT',
  'TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK',
  // Bästa möjliga schema: a part-timer's days gave way in a timetable that
  // WAS placed. Its params carry the post's limit, `taught` and `needed` (the
  // limit and the days used), so it is held to the rule of every sentence about
  // a post's days; a deviation is stored in the hidden form (deviations.ts).
  'DEVIATION_TEACHER_WORK_DAYS',
];

const DAYS_BEARING = new Set<string | null | undefined>(DAYS_BEARING_CODES);

export function isDaysBearing(code: string | null | undefined): boolean {
  return DAYS_BEARING.has(code);
}

/*
 * THE LIMIT ON TEACHING IN A ROW (Sammanhängande undervisning,
 * TeacherEmployments.maxConsecutiveTeachingMinutes and consecutiveBreakMinutes,
 * 20261218090000) IS HR DATA, AND READ HERE AS THE DAYS ARE.
 *
 * A limit may be an arbetsanpassning after sick leave, so the user decided it
 * is the post's and not the work rule's: no reader without HR-läs is shown the
 * figures or the weekday, and what a RUN says of it names no teacher. (As for
 * the days, the Vikarietavla and a hand edit's warning can still show that a
 * named teacher cannot take a lesson because of a hidden working-time rule;
 * that is recorded in the Läslogg and is the user's choice of parity with the
 * days.) The generator
 * does not soft-refuse a week over it, so what a run says about it is a NOTE
 * (the teacher whose longest stretch the finished timetable leaves over the
 * limit, consecutive-wishes.ts) and not a conflict, but the note is stored and
 * shown by the same rule as a days refusal:
 *
 *  - STORED WITHOUT THE LIMIT. The note keeps the weekday and the length of
 *    the longest stretch (what the timetable itself shows), the teacher's
 *    Users id server-side in `subjectIds`, and an English fallback with no
 *    figure of the limit. The post is the one place the limit lives, so
 *    gallring has no second copy in OptimizationJobs to miss.
 *  - SHOWN PER READER. A reader without HR-läs gets TEACHER_CONSECUTIVE_
 *    TEACHING_HIDDEN: no teacher, no limit, no weekday, its category kept, and
 *    two of those say nothing the first did not, so they are one. A reader
 *    with HR-läs gets the note with the limit and the pause read back from
 *    the post as it stands and the teacher named, and the read is recorded
 *    (EMPLOYMENT). A post that no longer has a limit, or is gone, has nothing
 *    to read back, and its note stays hidden for that reader too.
 *  - A SCHEMAFÖRSLAG STORES THE HIDDEN SENTENCE FOR EVERY READER (hideConsecutiveNotes),
 *    as it does a days sentence: a candidate is read by a page that has no
 *    read-back of the posts, so nothing HR is kept to be shown.
 */

/** The note about a limit the finished timetable does not keep. */
export const TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT = 'TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT' as const;

/** The masked note, for a reader without HR-läs. No params. */
export const TEACHER_CONSECUTIVE_TEACHING_HIDDEN = 'TEACHER_CONSECUTIVE_TEACHING_HIDDEN' as const;

/** Every sentence whose params are completed from a post's limit on teaching in a row. */
export const STRETCH_BEARING_CODES: readonly string[] = [TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT];

const STRETCH_BEARING = new Set<string | null | undefined>(STRETCH_BEARING_CODES);

export function isStretchBearing(code: string | null | undefined): boolean {
  return STRETCH_BEARING.has(code);
}

/**
 * The catalogue's English for TEACHER_CONSECUTIVE_TEACHING_HIDDEN, rendered
 * here because the engine never produces it: the English of the note with
 * nothing in it that names a limit, a weekday or a teacher.
 */
export const CONSECUTIVE_TEACHING_HIDDEN_MESSAGE =
  "A teacher's limit on teaching in a row was not kept in the timetable. " +
  'The limit is shown to the principal, a full administrator and anyone with HR read access.';

/**
 * The catalogue's English for TEACHER_WORK_DAYS_HIDDEN, rendered here because
 * the engine never produces it. Stored as the English of every days-bearing
 * sentence, so the fallback a screen shows is never more revealing than the
 * code it stands for.
 */
export const WORK_DAYS_HIDDEN_MESSAGE =
  "A teacher's limit on how many days a week they teach is one of the reasons the timetable could not be made. " +
  'The limit is shown to the principal, a full administrator and anyone with HR read access.';

/**
 * The English of the masked sentence about a post's days when the timetable
 * WAS made: a deviation (Bästa möjliga schema, deviations.ts) that bore the
 * days. Not WORK_DAYS_HIDDEN_MESSAGE, which says the limit is one of the
 * reasons the timetable could not be made — a refusal's sentence, wrong for a
 * timetable that exists. The code stays TEACHER_WORK_DAYS_HIDDEN, which the web
 * says itself for a deviation (deviation-list.tsx); this is the fallback a
 * screen shows without a translation, and it names no figure, no post and no
 * teacher.
 */
export const DEVIATION_WORK_DAYS_HIDDEN_MESSAGE =
  "A teacher's limit on how many days a week they teach gave way in this timetable. " +
  'The limit is shown to the principal, a full administrator and anyone with HR read access.';

/** A sentence's params without the post's days: what is stored. */
export function withoutDays(params: Record<string, string | number>): Record<string, string | number> {
  return Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'days'));
}

/**
 * The engine's 400 about a post's days, with the figure already stripped
 * from its body, and the teachers it is about kept OFF the body.
 *
 * Nest answers an HttpException with getResponse() and nothing else, so
 * `subjectIds` never reaches a caller; the job store reads it from here to
 * keep it beside the refusal (inside the stored errorParams, which no view
 * passes an array out of), and the synchronous trigger to read the post back
 * for a reader with HR-läs.
 */
export class WorkDaysRefusal extends HttpException {
  constructor(
    response: { message: string; code: string; params: Record<string, string | number> },
    status: number,
    readonly subjectIds: readonly string[],
  ) {
    super(response, status);
  }
}

/** One sentence of a run as stored: what it says, and whom it is about. */
export interface StoredSentence {
  code: string | null;
  params: Record<string, string | number> | null;
  message: string | null;
  /** Users ids of the teachers whose post the sentence names. Never shown. */
  subjectIds: readonly string[];
}

/** One teacher's post as a reader with HR-läs is shown it. */
export interface PostShown {
  /** The post's deltid in days; null when the post has none (a limit on teaching in a row alone). */
  days: number | null;
  /** The post's limit on teaching in a row; null when the post has none. */
  stretch: { max: number; breakMinutes: number } | null;
  /** The teacher, as the school wrote them: first and last name. */
  name: string;
}

/** What one sentence says to its reader, and which teachers it showed them. */
export interface SentenceShown {
  code: string | null;
  params: Record<string, string | number> | null;
  message: string | null;
  /** The teachers named, beside the sentence; empty for every other sentence. */
  names: string[];
  /** Users ids whose post's days this reader was shown: the Läslogg's subjects. */
  revealed: string[];
}

const HIDDEN: Omit<SentenceShown, 'revealed'> = {
  code: TEACHER_WORK_DAYS_HIDDEN,
  params: {},
  message: WORK_DAYS_HIDDEN_MESSAGE,
  names: [],
};

/**
 * What a stored sentence says to its reader.
 *
 * `posts` is the teachers' posts read back for a reader with HR-läs (Users id
 * → the post's days and the teacher's name; a post without a limit is not in
 * it), or null for a reader without. A sentence whose code bears no days is
 * passed through as it is. A days-bearing one is shown in full only when
 * every teacher it is about still has a limit on their post; otherwise it is
 * the hidden sentence, so a reader is never shown a figure the post no longer
 * holds, nor a sentence with its figure missing.
 */
export function forReader(
  sentence: StoredSentence,
  posts: ReadonlyMap<string, PostShown> | null,
): SentenceShown {
  if (isStretchBearing(sentence.code)) return stretchForReader(sentence, posts);
  if (!isDaysBearing(sentence.code)) {
    return { code: sentence.code, params: sentence.params, message: sentence.message, names: [], revealed: [] };
  }
  const shown = posts === null ? [] : sentence.subjectIds.map((id) => posts.get(id));
  if (shown.length === 0 || shown.some((post) => post === undefined || post.days === null)) {
    return { ...HIDDEN, revealed: [] };
  }
  // One limit per sentence and one post per limit, so one teacher: the first
  // is the figure — the post's, over any a hand-edited row might carry. Every
  // one of them is named and recorded all the same.
  const posted = shown as Array<PostShown & { days: number }>;
  return {
    code: sentence.code,
    params: { ...sentence.params, days: posted[0]!.days },
    message: sentence.message,
    names: posted.map((post) => post.name),
    revealed: [...sentence.subjectIds],
  };
}

const HIDDEN_STRETCH: Omit<SentenceShown, 'revealed'> = {
  code: TEACHER_CONSECUTIVE_TEACHING_HIDDEN,
  params: {},
  message: CONSECUTIVE_TEACHING_HIDDEN_MESSAGE,
  names: [],
};

/**
 * What one note about a limit on teaching in a row says to its reader, by the
 * rule `forReader` states for the days: the limit and the pause read back from
 * the post, and the teacher named, only for a reader with HR-läs and only
 * while every teacher it is about still has a limit; the hidden note
 * otherwise.
 */
function stretchForReader(
  sentence: StoredSentence,
  posts: ReadonlyMap<string, PostShown> | null,
): SentenceShown {
  const shown = posts === null ? [] : sentence.subjectIds.map((id) => posts.get(id));
  if (shown.length === 0 || shown.some((post) => post === undefined || post.stretch === null)) {
    return { ...HIDDEN_STRETCH, revealed: [] };
  }
  const posted = shown as Array<PostShown & { stretch: { max: number; breakMinutes: number } }>;
  return {
    code: sentence.code,
    params: {
      ...sentence.params,
      max: posted[0]!.stretch.max,
      breakMinutes: posted[0]!.stretch.breakMinutes,
    },
    message: sentence.message,
    names: posted.map((post) => post.name),
    revealed: [...sentence.subjectIds],
  };
}

