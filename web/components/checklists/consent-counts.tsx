import { CONSENT_STATES, countOf, sharesOf, type ConsentCounts as Counts, type ConsentState } from "@/lib/checklists";
import { useChecklistsText } from "./use-checklists-text";

/** The bar's colour per state: the tone of the badge's, and drawn only as a glance, with the numbers beside it in words. */
const SEGMENT: Record<ConsentState, string> = {
  GRANTED: "bg-success",
  DECLINED: "bg-destructive/70",
  WITHDRAWN: "bg-destructive",
  ASKED: "bg-muted-foreground/50",
  MISSING: "bg-warning",
};

/**
 * Where a list stands, in numbers and words: Samtycke 12, Har tackat nej 1 ...
 * (every state, a zero too, so that the line reads the same list after list),
 * and a bar that is only a glance: the words carry the meaning.
 */
export function ConsentCounts({ counts }: { counts: Counts }) {
  const { t, number } = useChecklistsText();
  return (
    <div className="space-y-1.5">
      <div className="flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        {sharesOf(counts).map((share) => (
          <span key={share.state} className={SEGMENT[share.state]} style={{ width: `${share.percent}%` }} />
        ))}
      </div>
      <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm">
        {CONSENT_STATES.map((state) => (
          <div key={state} className="flex gap-1.5">
            <dt className="text-muted-foreground">{t(`state.${state}`)}</dt>
            <dd className="font-medium">{number(countOf(counts, state))}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
