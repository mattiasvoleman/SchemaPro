import { ConflictException } from '@nestjs/common';
import type { HardRuleCode, RuleFinding } from './cover-rules';

/**
 * A YES THAT BREAKS A RULE IS REFUSED BY NAME.
 *
 * A request is only worth sending to a colleague the hard rules of cover
 * (cover-rules.ts) let in front of the class, and a yes is judged by the same
 * rules again when it is given: the day may have moved since the question was
 * asked, and the person's own week with it. The refusal names each rule in
 * Swedish and carries the codes, so the app and the web can say it in their
 * own words, and so a colleague who is told "no" is told why.
 *
 * The figures stay out. A rule that holds HR data (the post's days, its limit
 * for teaching in a row) is masked as it is for any reader without HR-läs
 * (maskFindings, WORK_DAYS_HIDDEN); the daily cap keeps its words only: the
 * minutes are the person's own work rule, which they read, but the sentence
 * does not need them.
 */

export const COVER_REQUEST_RULE = 'COVER_REQUEST_RULE';
export const COVER_REQUEST_RECIPIENT_RULE = 'COVER_REQUEST_RECIPIENT_RULE';

/**
 * Who a refusal speaks to: the colleague whose yes it is ("eftersom du …") or
 * the administrator reading about a colleague ("…, som …"). Swedish verbs do
 * not change with the person, so the words differ only where a pronoun sits
 * inside the rule.
 */
export interface Voice {
  /** "du" / "hen": the pronoun in "att du inte kan då". */
  readonly subject: string;
  /** "din" / "sin": the possessive in "inte skulle få din lunch". */
  readonly own: string;
}

export const TO_THE_COLLEAGUE: Voice = { subject: 'du', own: 'din' };
export const ABOUT_THE_COLLEAGUE: Voice = { subject: 'hen', own: 'sin' };

/**
 * The rules of cover as a subordinate clause's words, in its word order
 * (after "eftersom du" or "som": the negation before the verb, "redan"
 * before it too).
 */
export const RULE_PHRASES: Readonly<Record<HardRuleCode, (voice: Voice) => string>> = {
  INACTIVE: () => 'inte är en aktiv lärare',
  ON_LESSON: () => 'redan undervisar på lektionen',
  ABSENT: () => 'är frånvarande då',
  BUSY_LESSON: () => 'undervisar på en annan lektion då',
  BUSY_SUPERVISION: () => 'har ett rastvaktspass då',
  BUSY_DUTY: () => 'har ett uppdrag med fast tid då',
  UNAVAILABLE: (voice) => `har markerat att ${voice.subject} inte kan då`,
  BOOKED_ROOM: () => 'har en lokalbokning då',
  LUNCH: (voice) => `inte skulle få ${voice.own} lunch`,
  DAILY_REST: () => 'skulle få för kort vila mellan dagarna',
  DAILY_CAP: () => 'skulle överskrida dagens tak för undervisning',
  CONSECUTIVE_TEACHING: () => 'skulle undervisa för länge i följd',
  CONSECUTIVE_TEACHING_HIDDEN: () => 'skulle undervisa för länge i följd',
  WORK_DAYS: () => 'skulle undervisa en dag som tjänsten inte omfattar',
  WORK_DAYS_HIDDEN: () => 'skulle undervisa en dag som tjänsten inte omfattar',
  POOL_NOT_DECLARED: (voice) => `inte har angett att ${voice.subject} kan arbeta då`,
};

/** "undervisar på en annan lektion då och skulle överskrida dagens tak för undervisning". */
export function rulesInWords(findings: readonly RuleFinding[], voice: Voice): string {
  const phrases = [...new Set(findings.map((finding) => RULE_PHRASES[finding.code](voice)))];
  if (phrases.length <= 1) return phrases[0] ?? '';
  return `${phrases.slice(0, -1).join(', ')} och ${phrases[phrases.length - 1]}`;
}

/** The codes as one scalar, for the error filter's params: "BUSY_LESSON,DAILY_CAP". */
export function ruleCodes(findings: readonly RuleFinding[]): string {
  return [...new Set(findings.map((finding) => finding.code))].sort().join(',');
}

/** The colleague's own yes, refused: "Du kan inte ta uppdraget (tis 14 okt 08:00) eftersom du …". */
export function ownYesBreaksRule(when: string, lessonId: string, findings: readonly RuleFinding[]): ConflictException {
  return new ConflictException({
    message: `Du kan inte ta uppdraget (${when}) eftersom du ${rulesInWords(findings, TO_THE_COLLEAGUE)}.`,
    code: COVER_REQUEST_RULE,
    params: { lessonId, rules: ruleCodes(findings) },
  });
}

/** A colleague the administrator chose, refused before anything is sent. */
export function recipientBreaksRule(
  name: string,
  userId: string,
  when: string,
  lessonId: string,
  findings: readonly RuleFinding[],
): ConflictException {
  return new ConflictException({
    message: `Förfrågan om ${when} kan inte gå till ${name}, som ${rulesInWords(findings, ABOUT_THE_COLLEAGUE)}.`,
    code: COVER_REQUEST_RECIPIENT_RULE,
    params: { userId, lessonId, rules: ruleCodes(findings) },
  });
}
