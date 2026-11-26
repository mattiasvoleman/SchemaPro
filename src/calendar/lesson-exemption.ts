import type { Prisma } from '@prisma/client';

/*
 * E1b, UNDANTAG MED FLIT: the two rules of the board an administrator may break on purpose, on one lesson, by naming them.
 *
 * The stage's ramtid and the class's meal. Not the teacher, the room, the class or its pupils (no double booking can be forced: beslut 5), not a
 * weekly closure, not a rule on whole årskurser, not another school's time, and not the school day. A lesson carries the NAMES
 * (MasterLessons.exemptFrom), so a third rule is a change of the table's CHECK and of this list, and no new column.
 */

export const EXEMPTABLE_RULES = ['FRAME', 'LUNCH'] as const;
export type ExemptableRule = (typeof EXEMPTABLE_RULES)[number];

export const isExemptable = (reason: string): reason is ExemptableRule => (EXEMPTABLE_RULES as readonly string[]).includes(reason);

/**
 * Whether a locked lesson stands over its class's meal on purpose: what Generera tells the engine (FixedLesson.exemptFromLunch), so that a meal
 * the school placed by hand on it is not refused. A row read without the column (a förläggning's lock) is a lesson without one.
 */
export const exemptFromLunch = (row: object): boolean =>
  'exemptFrom' in row && Array.isArray(row.exemptFrom) && exemptionsOf(row.exemptFrom as string[]).includes('LUNCH');

/** The names a request or a row holds, as the rules they are, each once, in the order of EXEMPTABLE_RULES: the order a row is written in. */
export function exemptionsOf(names: readonly string[] | null | undefined): ExemptableRule[] {
  return EXEMPTABLE_RULES.filter((rule) => (names ?? []).includes(rule));
}

/**
 * The key a lesson's result carries: only a lesson that has an exemption says so, so every other lesson is the object it was (toResult, a swap's
 * log and answer).
 */
export function exemptionKey(names: readonly string[] | null | undefined): { exemptFrom?: ExemptableRule[] } {
  const rules = exemptionsOf(names);
  return rules.length > 0 ? { exemptFrom: rules } : {};
}

/**
 * A transaction that writes a lesson's exemption itself, to a value it has decided on, says so for the rest of the transaction
 * (app.keep_exemptions, the trigger MasterLessons_exemption_ends). Without it the trigger ends an exemption that a write leaves unchanged while
 * the lesson's day, clock, dates or lock change: the guard that catches a writer which does not know the column (a swap's apply), and
 * the one thing it cannot tell from "the same exemption again" is a request that says yes a second time for the new time, a restored row, a discarded draft.
 */
export async function keepExemptions(tx: Pick<Prisma.TransactionClient, '$executeRaw'>): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.keep_exemptions', 'on', true)`;
}

/**
 * The rules as a schedule file says them (Schema som fil, the column Undantag): Swedish words, one or two, with | between. The reader takes the
 * English words as well, and nothing else: a word that is not one of them is a row that cannot be read, never a rule guessed at.
 */
export const EXEMPTION_WORDS: Readonly<Record<ExemptableRule, string>> = { FRAME: 'Ramtid', LUNCH: 'Lunch' };

const EXEMPTION_SPELLINGS: ReadonlyMap<string, ExemptableRule> = new Map<string, ExemptableRule>([
  ['ramtid', 'FRAME'],
  ['frame', 'FRAME'],
  ['lunch', 'LUNCH'],
  ['meal', 'LUNCH'],
]);

/** The words for a lesson's exemptions, as the file writes them: `Ramtid | Lunch`, empty for none. */
export const exemptionWords = (rules: readonly string[] | null | undefined): string => exemptionsOf(rules).map((rule) => EXEMPTION_WORDS[rule]).join(' | ');

/** The rules a cell names, or null when any word in it is none of them. Separated by | or ; or a comma, case and spaces aside. */
export function exemptionsRead(text: string): ExemptableRule[] | null {
  const rules: ExemptableRule[] = [];
  for (const word of text.split(/[|;,]/).map((part) => part.trim().toLowerCase()).filter((part) => part !== '')) {
    const rule = EXEMPTION_SPELLINGS.get(word);
    if (rule === undefined) return null;
    rules.push(rule);
  }
  return exemptionsOf(rules);
}
