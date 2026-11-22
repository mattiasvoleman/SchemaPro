"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { ApiError, api } from "@/lib/api";
import type { OptimizationJob } from "@/lib/queries";
import type { SuggestionChange, SuggestionProof, Suggestions } from "@/lib/suggestion-types";
import { hintsOf, type Hint } from "./suggestion-hints";
import { linkOfChange, linkOfRule, linkOfWorkRule, type SuggestionLink, type SuggestionPage } from "./suggestion-links";

/*
 * WHAT TO CHANGE, FOR A WEEK THAT WAS REFUSED OR RAN OUT OF TIME (omgång 13, G6 Åtgärdsförslag vid vägran).
 *
 * Up to three changes in the engine's own order of cost, each with how well the engine has shown it and a link to the page that owns
 * the data. Behind a lazy import: /admin/generate is near its bundle budget, and this is drawn only for a run that ended without a
 * timetable. NOTHING HERE CHANGES ANYTHING: a suggestion is a link, and the change is made on the page it opens, by the administrator.
 *
 * WHAT A CARD MAY SAY IS WHAT THE ENGINE SHOWED, AND NOT MORE. "Löser veckan" is said only for a list the engine checked against the
 * strict rules (SOLVED, SOLVED_TOGETHER); a list it did not check is "kan hjälpa". A list of several is shown to work TOGETHER, so the
 * card says so on every change, and says how many more belong to it when it shows fewer than the list has. It is a timetable that
 * exists, not one the next Generera is promised to find, and the changes are what the engine found, not the cheapest there are: both
 * are said, once, under the list. A timeout has no proof of its own, and what is known of it before the engine is asked is said as what
 * it is: a floor ("minst") or a measurement ("mätt"), never a figure that sounds like a promise.
 *
 * A part-timer's days are the hidden form for every reader: the card says a post needs a day more and not whose.
 */

/** How many changes are drawn: the page's three, and a line for the rest of the list. */
export const SHOWN_CHANGES = 3;
/** How often a running analysis is read again. */
const POLL_MS = 3000;

const PAGE_LABEL_KEY: Record<SuggestionPage, string> = {
  people: "link.people",
  requirements: "link.requirements",
  constraints: "link.constraints",
  staffing: "link.staffing",
};

export function SuggestionsCard({ job }: { job: OptimizationJob }) {
  const t = useTranslations("generate.suggestions");
  const queryClient = useQueryClient();
  const suggestions = job.suggestions ?? null;
  const running = suggestions?.state === "RUNNING";

  // The run is read again while the analysis runs. The page reads the same row under the same key, so what arrives here arrives there.
  useQuery({
    queryKey: ["optimizationJob", job.id],
    queryFn: () => api.get<OptimizationJob>(`/api/v1/optimization/jobs/${job.id}`),
    enabled: running,
    refetchInterval: POLL_MS,
  });

  const ask = useMutation({
    mutationFn: () => api.post<Suggestions>(`/api/v1/optimization/jobs/${job.id}/suggestions`, {}),
    onSuccess: (started) => {
      queryClient.setQueryData<OptimizationJob>(["optimizationJob", job.id], (held) => (held ? { ...held, suggestions: started } : held));
    },
  });

  const offered = job.suggestionsOffered === true;
  if (suggestions === null && !offered) return null;

  const hints = hintsOf(job);
  const listed = suggestions?.state === "DONE" && suggestions.verdict === "CHANGES" && suggestions.changes.length > 0;

  return (
    <section aria-labelledby="suggestions-title" className="space-y-3">
      <h3 id="suggestions-title" className="text-sm font-semibold">
        {t("title")}
      </h3>

      {suggestions === null ? <p className="max-w-prose text-sm">{t(job.solverStatus === "TIMEOUT" ? "offerTimeout" : "offer")}</p> : null}

      {!listed && hints.length > 0 ? <KnownBefore hints={hints} /> : null}

      {running ? (
        <p role="status" className="max-w-prose text-sm">
          {t("running")}
        </p>
      ) : null}

      {suggestions?.state === "FAILED" ? (
        <p className="max-w-prose text-sm">{t(`failed.${suggestions.failure ?? "ENGINE_FAILED"}` as never)}</p>
      ) : null}

      {suggestions?.state === "DONE" ? <Answer suggestions={suggestions} /> : null}

      {ask.isError ? (
        <p role="alert" className="max-w-prose text-sm text-destructive">
          {t(`refused.${ask.error instanceof ApiError && ask.error.code ? ask.error.code : "OTHER"}` as never)}
        </p>
      ) : null}

      {offered && !running ? (
        <Button type="button" variant="outline" size="sm" disabled={ask.isPending} onClick={() => ask.mutate()} data-writes="SCHEMALAGGNING">
          {t(suggestions === null ? "offerAction" : "again")}
        </Button>
      ) : null}
    </section>
  );
}

function Answer({ suggestions }: { suggestions: Suggestions }) {
  const t = useTranslations("generate.suggestions");
  switch (suggestions.verdict) {
    case "CHANGES":
      return <ChangesList suggestions={suggestions} />;
    case "SOLVABLE_AS_IS":
      return (
        <p className="max-w-prose text-sm">
          {/* Said only for a week the engine checked: a timetable that holds every rule was found, so the run that ended was short of time. */}
          {suggestions.verified ? t("verdict.SOLVABLE_AS_IS") : t("verdict.UNCHECKED")}
        </p>
      );
    case "NOT_FOUND":
      return <p className="max-w-prose text-sm">{t("verdict.NOT_FOUND", { seconds: suggestions.searchSeconds ?? 0 })}</p>;
    case "HARD_REFUSAL":
      return <p className="max-w-prose text-sm">{t("verdict.HARD_REFUSAL")}</p>;
    default:
      return <p className="max-w-prose text-sm">{t("failed.ENGINE_FAILED")}</p>;
  }
}

function ChangesList({ suggestions }: { suggestions: Suggestions }) {
  const t = useTranslations("generate.suggestions");
  const locale = useLocale();
  const shown = suggestions.changes.slice(0, SHOWN_CHANGES);
  // One proof for the whole list: the engine checks the list, never a change of it.
  const proof: SuggestionProof = shown[0]?.proof ?? "MAY_HELP";
  const more = Math.max(0, suggestions.total - shown.length);
  const when = suggestions.finishedAt === null ? null : formatWhen(suggestions.finishedAt, locale);
  return (
    <div className="space-y-3">
      <p className="max-w-prose text-sm">
        {proof === "SOLVED" ? t("intro.SOLVED") : proof === "SOLVED_TOGETHER" ? t("intro.SOLVED_TOGETHER", { total: suggestions.total }) : t("intro.MAY_HELP")}
      </p>
      <ol className="space-y-2">
        {shown.map((change, index) => (
          <li key={`${change.rule}-${index}`}>
            <ChangeCard change={change} index={index + 1} />
          </li>
        ))}
      </ol>
      {more > 0 ? <p className="max-w-prose text-sm">{t("more", { count: more })}</p> : null}
      <p className="max-w-prose text-sm text-muted-foreground">{t("caveat", { when: when ?? "" })}</p>
    </div>
  );
}

function ChangeCard({ change, index }: { change: SuggestionChange; index: number }) {
  const t = useTranslations("generate.suggestions");
  const tDays = useTranslations("days");
  const locale = useLocale();
  const link = linkOfChange(change);
  const sentence = sentenceOf(change, t, locale);
  // A weekday in the middle of a Swedish sentence is written with a small letter; the catalogue's names stand alone, with a capital.
  const days = listOf(change.weekdays.map((day) => (locale === "en" ? tDays(String(day) as never) : tDays(String(day) as never).toLocaleLowerCase("sv-SE"))), locale);
  return (
    <div className="space-y-1 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{index}.</span>
        <Badge variant={change.proof === "MAY_HELP" ? "warning" : "success"}>{t(`proof.${change.proof}` as never)}</Badge>
      </div>
      <p className="max-w-prose">{sentence}</p>
      {change.hidden ? <p className="max-w-prose text-muted-foreground">{t("hidden")}</p> : null}
      {days !== "" && !change.hidden ? <p className="max-w-prose text-muted-foreground">{t("weekdays", { days })}</p> : null}
      <OwnerLink link={link} sentence={sentence} />
    </div>
  );
}

/** One sentence per rule, in the school's own words: what to change, from what, to what, and where the engine needed it. */
function sentenceOf(change: SuggestionChange, t: ReturnType<typeof useTranslations>, locale: string): string {
  const post = change.requirementNames[0] ?? "";
  switch (change.rule) {
    case "TEACHER_DAILY_CAP":
      return change.teacherNames.length > 0
        ? t("change.TEACHER_DAILY_CAP", { teacher: change.teacherNames[0] ?? "", current: change.current ?? 0, needed: change.needed ?? 0 })
        : t("change.TEACHER_DAILY_CAP_ANON", { current: change.current ?? 0, needed: change.needed ?? 0 });
    case "TEACHER_WORK_DAYS":
      return t("change.TEACHER_WORK_DAYS");
    case "SUBJECT_PER_DAY":
      return t("change.SUBJECT_PER_DAY", { post, current: change.current ?? 0, needed: change.needed ?? 0 });
    case "SUBJECT_DAYS_APART":
      // A spread of one day is no rule: the field starts at two.
      return (change.needed ?? 0) <= 1
        ? t("change.SUBJECT_DAYS_APART_REMOVE", { post, current: change.current ?? 0 })
        : t("change.SUBJECT_DAYS_APART", { post, current: change.current ?? 0, needed: change.needed ?? 0 });
    case "ROOM_LOCK": {
      const rooms = listOf(change.roomNames, locale);
      return rooms === "" ? t("change.ROOM_LOCK_UNNAMED", { post }) : t("change.ROOM_LOCK", { post, rooms });
    }
  }
}

function OwnerLink({ link, sentence }: { link: SuggestionLink; sentence: string }) {
  const t = useTranslations("generate.suggestions");
  return (
    <p>
      <Link
        href={link.href}
        aria-label={t("linkLabel", { page: t(PAGE_LABEL_KEY[link.page] as never), sentence })}
        className="font-medium underline underline-offset-4"
      >
        {t(PAGE_LABEL_KEY[link.page] as never)}
      </Link>
    </p>
  );
}

/** What is already known before the engine is asked: a floor for a cap, and what a timeout's probe measured. */
function KnownBefore({ hints }: { hints: Hint[] }) {
  const t = useTranslations("generate.suggestions");
  return (
    <div className="space-y-1.5">
      <h4 className="text-sm font-medium">{t("known.title")}</h4>
      <ul className="space-y-2 text-sm">
        {hints.map((hint, index) => {
          const link = hint.kind === "CAP_AT_LEAST" ? linkOfWorkRule(hint.workRuleId ?? undefined) : linkOfRule(hint.rule === "SUBJECT_SPREAD" ? "SUBJECT_PER_DAY" : hint.rule);
          const sentence =
            hint.kind === "CAP_AT_LEAST"
              ? t(hint.because === "LESSON" ? "known.capLesson" : "known.capWeek", { minutes: hint.minutes })
              : t(`known.measured.${hint.rule}` as never);
          return (
            <li key={`${hint.kind}-${index}`} className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{t(hint.kind === "CAP_AT_LEAST" ? "proof.AT_LEAST" : "proof.MEASURED")}</Badge>
              </div>
              <p className="max-w-prose">{sentence}</p>
              <OwnerLink link={link} sentence={sentence} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** "a, b and c" in the reader's language; an empty list is the empty text. */
function listOf(items: readonly string[], locale: string): string {
  if (items.length === 0) return "";
  return new Intl.ListFormat(locale === "en" ? "en-GB" : "sv-SE", { style: "long", type: "conjunction" }).format(items);
}

/** The date and the time the analysis was made, in the reader's own notation. */
function formatWhen(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}
