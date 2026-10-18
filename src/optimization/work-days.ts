import { HttpException } from '@nestjs/common';

/**
 * DELTID IN DAYS, AND WHO MAY READ A REFUSAL ABOUT IT.
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
];

const DAYS_BEARING = new Set<string | null | undefined>(DAYS_BEARING_CODES);

export function isDaysBearing(code: string | null | undefined): boolean {
  return DAYS_BEARING.has(code);
}

/**
 * The catalogue's English for TEACHER_WORK_DAYS_HIDDEN, rendered here because
 * the engine never produces it. Stored as the English of every days-bearing
 * sentence, so the fallback a screen shows is never more revealing than the
 * code it stands for.
 */
export const WORK_DAYS_HIDDEN_MESSAGE =
  "A teacher's limit on how many days a week they teach is one of the reasons the timetable could not be made. " +
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
  days: number;
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
  if (!isDaysBearing(sentence.code)) {
    return { code: sentence.code, params: sentence.params, message: sentence.message, names: [], revealed: [] };
  }
  const shown = posts === null ? [] : sentence.subjectIds.map((id) => posts.get(id));
  if (shown.length === 0 || shown.some((post) => post === undefined)) {
    return { ...HIDDEN, revealed: [] };
  }
  // One limit per sentence and one post per limit, so one teacher: the first
  // is the figure — the post's, over any a hand-edited row might carry. Every
  // one of them is named and recorded all the same.
  const posted = shown as PostShown[];
  return {
    code: sentence.code,
    params: { ...sentence.params, days: posted[0]!.days },
    message: sentence.message,
    names: posted.map((post) => post.name),
    revealed: [...sentence.subjectIds],
  };
}
