"use client";

import { useTranslations } from "next-intl";
import { ArrowRight } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { GRADE_GAPS, ownerOf, type IntakeArea, type IntakeGap, type IntakeLevel } from "@/lib/intake";
import { useIntake } from "@/lib/intake-queries";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Vad kom in: what the school's base data holds and what is missing from it, counted against what Generera and the steps after it
 * ask for. The page READS and counts; it writes nothing, and every gap is a link to the page that owns it.
 *
 * It never says that a week can be laid, or that the school is ready: a page with no gap is the absence of the gaps the gateway
 * counts (src/intake/intake.ts) and nothing more, and the first thing it says under a clean count is to run Kontrollera veckan.
 * The levels are said in words on every row as well as in the badge's colour: a gap that stops Generera, one that gives a worse
 * timetable, one only another step reads.
 *
 * A failed read says so and shows no figure: an empty list read as a school with no data would tell a school with hundreds of
 * classes that it had none.
 */

const BADGE: Record<IntakeLevel, NonNullable<BadgeProps["variant"]>> = {
  HARD: "destructive",
  SOFT: "warning",
  INFO: "secondary",
};

export default function IntakePage() {
  const t = useTranslations("intake");
  const intake = useIntake();
  const view = intake.data;

  return (
    <Page width="wide">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {intake.isLoading ? (
        <div aria-busy="true" className="space-y-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : view === undefined ? (
        <LoadError
          title={t("loadFailed")}
          hint={t("loadFailedHint")}
          headingLevel={2}
          action={
            <Button variant="outline" size="sm" onClick={() => void intake.refetch()}>
              {t("retry")}
            </Button>
          }
        />
      ) : (
        <>
          <Summary hard={view.hard} soft={view.soft} info={view.info} yearName={view.year?.name ?? null} />
          <p className="max-w-3xl text-sm text-muted-foreground">{t("intro")}</p>
          <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
            {view.areas.map((area) => (
              <AreaCard key={area.area} area={area} />
            ))}
          </div>
        </>
      )}
    </Page>
  );
}

function Summary({ hard, soft, info, yearName }: { hard: number; soft: number; info: number; yearName: string | null }) {
  const t = useTranslations("intake");
  const others = [soft > 0 ? t("summary.soft", { count: soft }) : null, info > 0 ? t("summary.info", { count: info }) : null].filter(
    (text): text is string => text !== null,
  );
  return (
    <Notice
      // The warning tone says something needs doing; neutral says nothing is known to stop the run, and not that it is ready.
      tone={hard > 0 ? "warning" : "neutral"}
      title={hard > 0 ? t("summary.hardTitle", { count: hard }) : t("summary.okTitle")}
      action={
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/generate">
            {t("summary.generate")}
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      }
    >
      <p>{hard > 0 ? t("summary.hardBody") : t("summary.okBody")}</p>
      {yearName !== null || others.length > 0 ? (
        <p className="mt-1">{[yearName !== null ? t("year", { name: yearName }) : null, ...others].filter(Boolean).join(" · ")}</p>
      ) : null}
    </Notice>
  );
}

function AreaCard({ area }: { area: IntakeArea }) {
  const t = useTranslations("intake");
  const there = area.gaps.filter((gap) => gap.count > 0);
  // A count a newer gateway has and this build has no words for is left out of the line, never written as a key.
  const found = Object.entries(area.found)
    .filter(([key]) => t.has(`found.${key}`))
    .map(([key, count]) => t(`found.${key}`, { count }))
    .join(", ");
  const id = `intake-${area.area.toLowerCase().replace(/_/g, "-")}`;
  return (
    <SectionCard id={id} title={t(`areas.${area.area}`)} description={area.waitsForYear ? undefined : `${t("foundHeading")}: ${found}`}>
      {area.waitsForYear ? (
        // Nothing is counted for a läsår that is not there, and "nothing is missing" would be said over an area that has not been looked at.
        <p className="text-sm text-muted-foreground">{t("waitsForYear")}</p>
      ) : there.length === 0 ? (
        <p className="text-sm">{t("nothingMissing")}</p>
      ) : (
        <ul className="space-y-3">
          {there.map((gap) => (
            <GapRow key={gap.code} gap={gap} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function GapRow({ gap }: { gap: IntakeGap }) {
  const t = useTranslations("intake");
  const tNav = useTranslations("nav");
  const owner = ownerOf(gap.code);
  const items = gap.items.map((item) => (GRADE_GAPS.has(gap.code) ? t("grade", { grade: item }) : item));
  if (gap.more > 0) items.push(t("more", { count: gap.more }));
  // A post with no teacher is a hard gap only when the school has chosen Vägra; its own hint then says so.
  // A gap a newer gateway has and this build has no words for is still a row: its code stands where its title would, so that
  // "Inget saknas" is never said over a gap the page cannot name.
  const known = t.has(`gaps.${gap.code}.title`);
  const hint = !known ? null : gap.code === "UNSTAFFED_POSTS" && gap.level === "HARD" ? t("gaps.UNSTAFFED_POSTS.hintHard") : t(`gaps.${gap.code}.hint`);
  return (
    <li className="space-y-1.5 border-t pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={BADGE[gap.level]}>{t(`levels.${gap.level}`)}</Badge>
        <span className="text-sm font-medium">{known ? t(`gaps.${gap.code}.title`, { count: gap.count }) : gap.code}</span>
      </div>
      {hint !== null ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
      {items.length > 0 ? <p className="text-sm">{t("appliesTo", { items: items.join(", ") })}</p> : null}
      {owner !== null ? (
        <Button asChild variant="ghost" size="sm">
          <Link href={owner.href}>
            {t("open", { page: tNav(owner.navKey) })}
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      ) : null}
    </li>
  );
}
