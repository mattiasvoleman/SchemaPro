"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import type { ImportPlanDto, PlanRefusal } from "@/lib/schedule-exchange";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Table } from "@/components/ui/table";

/** The most rows the table draws before it says how many more there are. */
const ROW_LIMIT = 300;

/**
 * What an import would do, read before anything is written: the counts, every
 * row that cannot be placed with its reasons (named, never summarised away),
 * the choices a reader made where the format is ambiguous, the warnings, and
 * the timplansposter the lessons imply. Skriv in is offered only when no row
 * is refused and no line was unreadable: the import is all of it or none, so
 * no row is dropped in silence.
 */
export function ImportPreview({
  plan,
  applying,
  onApply,
}: {
  plan: ImportPlanDto;
  applying: boolean;
  onApply: () => void;
}) {
  const t = useTranslations("scheduleExchange.preview");
  const [onlyRefused, setOnlyRefused] = useState(plan.summary.refused > 0);
  const rows = (onlyRefused ? plan.rows.filter((row) => row.action === "REFUSED") : plan.rows).slice(0, ROW_LIMIT);
  const shown = onlyRefused ? plan.summary.refused : plan.rows.length;
  const created = plan.requirements.filter((q) => q.action === "CREATE");

  return (
    <div className="space-y-4" aria-live="polite">
      <Notice tone={plan.canApply ? "success" : "destructive"} title={plan.canApply ? t("okTitle") : t("blockedTitle")}>
        {t("summary", {
          rows: plan.summary.rows,
          create: plan.summary.create,
          unchanged: plan.summary.unchanged,
          refused: plan.summary.refused,
          unreadable: plan.summary.unreadable,
          notInFile: plan.summary.notInFile,
        })}
      </Notice>

      {plan.notes.length > 0 ? (
        <Notice tone="neutral" title={t("notes")}>
          <ul className="list-disc pl-5">
            {plan.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {plan.unreadable.length > 0 ? (
        <section aria-labelledby="unreadable-title">
          <h3 id="unreadable-title" className="mb-1 text-sm font-semibold">
            {t("unreadable", { count: plan.unreadable.length })}
          </h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {plan.unreadable.slice(0, ROW_LIMIT).map((problem) => (
              <li key={`${problem.ref}-${problem.code}`}>
                <span className="font-medium">{problem.ref}</span>: {problem.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="rows-title">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 id="rows-title" className="text-sm font-semibold">
            {t("rows")}
          </h3>
          {plan.summary.refused > 0 ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={onlyRefused} onChange={(event) => setOnlyRefused(event.target.checked)} />
              {t("onlyRefused")}
            </label>
          ) : null}
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("ref")}</TableHead>
              <TableHead>{t("lesson")}</TableHead>
              <TableHead>{t("result")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.ref}-${row.label}`}>
                <TableCell className="whitespace-nowrap">{row.ref}</TableCell>
                <TableCell>{row.label}</TableCell>
                <TableCell>
                  {row.action === "REFUSED" ? (
                    <ul className="space-y-1">
                      {row.refusals.map((refusal, i) => (
                        <li key={`${refusal.code}-${i}`} className="text-sm">
                          <Badge variant="destructive">{t("refused")}</Badge> <RefusalText refusal={refusal} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Badge variant={row.action === "CREATE" ? "default" : "secondary"}>{t(`action.${row.action}`)}</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {shown > ROW_LIMIT ? <p className="mt-2 text-sm text-muted-foreground">{t("more", { count: shown - ROW_LIMIT })}</p> : null}
      </section>

      {plan.warnings.length > 0 ? (
        <Notice tone="warning" title={t("warnings", { count: plan.warnings.length })}>
          <ul className="list-disc space-y-1 pl-5">
            {plan.warnings.slice(0, 50).map((warning, i) => (
              <li key={`${warning.code}-${i}`}>{t.has(`warning.${warning.code}`) ? t(`warning.${warning.code}`, warning.params) : warning.detail}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {created.length > 0 || plan.newBlocks.length > 0 ? (
        <section aria-labelledby="posts-title">
          <h3 id="posts-title" className="mb-1 text-sm font-semibold">
            {t("posts", { count: created.length })}
          </h3>
          <p className="mb-2 text-sm text-muted-foreground">{t("postsHint")}</p>
          <ul className="grid gap-1 text-sm sm:grid-cols-2">
            {created.slice(0, 100).map((q) => (
              <li key={`${q.groupName}-${q.subjectName}`}>
                {q.subjectName} · {q.groupName}: {q.lessonLengths.length > 0 ? q.lessonLengths.join(" + ") : `${q.lessonsPerWeek} × ${q.minutesPerLesson}`} min
                {q.block ? ` · ${q.block}` : ""}
              </li>
            ))}
          </ul>
          {plan.newBlocks.length > 0 ? <p className="mt-2 text-sm">{t("newBlocks", { names: plan.newBlocks.join(", ") })}</p> : null}
        </section>
      ) : null}

      <div className="flex justify-end">
        <Button data-writes="SCHEMALAGGNING" disabled={!plan.canApply || applying} onClick={onApply}>
          {applying ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          {t("apply", { count: plan.summary.create })}
        </Button>
      </div>
    </div>
  );
}

/** A refusal in the page's language by its code, else the gateway's own sentence. */
function RefusalText({ refusal }: { refusal: PlanRefusal }) {
  const tRefusal = useTranslations("scheduleExchange.refusal");
  const day = useTranslations("days");
  const change = useTranslations("scheduleExchange.change");
  const params: Record<string, string | number> = { ...refusal.params };
  if (typeof params.day === "number") params.day = day(String(params.day));
  // The gateway names what differs in Swedish words; the page says them in its own language.
  if (typeof params.changes === "string") {
    params.changes = params.changes
      .split(", ")
      .map((word) => (change.has(word) ? change(word) : word))
      .join(", ");
  }
  return <>{tRefusal.has(refusal.code) ? tRefusal(refusal.code, params) : refusal.detail}</>;
}
