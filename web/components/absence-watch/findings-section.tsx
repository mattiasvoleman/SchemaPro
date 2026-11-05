"use client";

import { useState } from "react";
import { CircleCheck } from "lucide-react";
import { useAbsenceWatchFindings } from "@/lib/absence-watch-queries";
import {
  ABSENCE_WATCH_GROUPS,
  FINDINGS_LIMIT,
  RECENT_DAYS,
  measuredPercent,
  openFirst,
  pupilsIn,
  type AbsenceWatchFinding,
  type AbsenceWatchGroup,
} from "@/lib/absence-watch";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterField } from "@/components/ui/filter-bar";
import { Label } from "@/components/ui/label";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";
import { useAbsenceWatchText } from "./use-absence-watch-text";

/** Whose list it is: the administrator's (every group), the mentor's (own class) or the guardian's (own child). */
export type FindingsAudience = "admin" | "mentor" | "guardian";

/**
 * The pupils who have passed a limit, and since when: the one list of
 * Frånvarobevakning, shared by /admin/absence-watch, /teacher/absence-watch
 * and /guardian/absence-watch.
 *
 * What each reader gets is the database's say (GET /api/v1/absence-watch/findings
 * under the reader's own row security), so the list is the same component for
 * all three and an empty list is normal: a school with the watch off, a teacher
 * who mentors nobody, a guardian whose school sets no limit for guardians.
 *
 * Only figures are shown: for a share the minutes absent of the minutes
 * registered and the percent they make, for a run the days in a row. Never an
 * absence reason, and never a type of absence beyond what the limit counts
 * (giltig, ogiltig or all frånvaro).
 */
export function FindingsSection({ audience, watchOn }: { audience: FindingsAudience; watchOn?: boolean }) {
  const { t, day, number, limitText } = useAbsenceWatchText();
  const [recent, setRecent] = useState(false);
  const [group, setGroup] = useState<AbsenceWatchGroup | "ALL">("ALL");
  const query = useAbsenceWatchFindings(recent);
  const admin = audience === "admin";

  const all = query.data?.findings ?? [];
  const shown = openFirst(group === "ALL" ? all : all.filter((one) => one.recipientGroup === group));
  const open = shown.filter((one) => one.clearedOn === null);
  const cleared = shown.filter((one) => one.clearedOn !== null);

  const figures = (finding: AbsenceWatchFinding): string => {
    if (finding.kind === "CONSECUTIVE") return t("findings.streak", { days: finding.streakDays ?? 0 });
    const percent = measuredPercent(finding);
    return percent === null
      ? t("findings.minutesOnly", { absent: number(finding.absentMinutes ?? 0) })
      : t("findings.share", {
          absent: number(finding.absentMinutes ?? 0),
          recorded: number(finding.recordedMinutes ?? 0),
          percent,
        });
  };

  const empty = () => {
    if (all.length > 0) return { title: t("findings.emptyGroupTitle"), description: t("findings.emptyGroupBody") };
    if (admin && watchOn === false) return { title: t("findings.emptyOffTitle"), description: t("findings.emptyOffBody") };
    return {
      title: recent ? t("findings.emptyRecentTitle", { days: RECENT_DAYS }) : t(`findings.empty.${audience}.title`),
      description: t(`findings.empty.${audience}.body`),
    };
  };

  return (
    <SectionCard
      id="absence-watch-findings"
      title={t(`findings.title.${audience}`)}
      description={t(`findings.description.${audience}`)}
    >
      <FilterBar>
        {admin ? (
          <FilterField id="absence-watch-group" label={t("findings.groupFilter")}>
            <NativeSelect
              id="absence-watch-group"
              className="w-48"
              value={group}
              onChange={(event) => setGroup(event.target.value as AbsenceWatchGroup | "ALL")}
            >
              <option value="ALL">{t("findings.allGroups")}</option>
              {ABSENCE_WATCH_GROUPS.map((one) => (
                <option key={one} value={one}>
                  {t(`group.${one}`)}
                </option>
              ))}
            </NativeSelect>
          </FilterField>
        ) : null}
        <div className="flex items-center gap-2 pb-1.5">
          <Switch id="absence-watch-recent" checked={recent} onCheckedChange={setRecent} />
          <Label htmlFor="absence-watch-recent">{t("findings.recent")}</Label>
        </div>
      </FilterBar>

      {query.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-40 w-full" />
        </div>
      ) : query.isError || !query.data ? (
        <LoadError title={t("findings.loadFailed")} hint={t("findings.loadFailedHint")} headingLevel={3} />
      ) : (
        <>
          {query.data.truncated ? (
            <Notice tone="warning" title={t("findings.truncatedTitle")}>
              {t("findings.truncatedBody", { count: number(FINDINGS_LIMIT) })}
            </Notice>
          ) : null}
          {shown.length === 0 ? (
            <EmptyState icon={CircleCheck} headingLevel={3} {...empty()} />
          ) : (
            <>
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {t("findings.summaryOpen", { count: pupilsIn(open) })}
                {recent ? ` ${t("findings.summaryCleared", { count: pupilsIn(cleared) })}` : ""}
              </p>
              <TableCard caption={t("findings.caption")} busy={query.isPlaceholderData} tableClassName="min-w-[44rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">{t("findings.student")}</TableHead>
                    <TableHead scope="col">{t("findings.class")}</TableHead>
                    {admin ? <TableHead scope="col">{t("findings.group")}</TableHead> : null}
                    <TableHead scope="col">{t("findings.limit")}</TableHead>
                    <TableHead scope="col">{t("findings.figures")}</TableHead>
                    <TableHead scope="col">{t("findings.since")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((finding) => (
                    <TableRow key={finding.id}>
                      <TableCell className="font-medium">
                        {finding.studentName ?? (
                          <>
                            <span aria-hidden="true">—</span>
                            <span className="sr-only">{t("findings.nameHidden")}</span>
                          </>
                        )}
                      </TableCell>
                      <TableCell>{finding.className ?? "—"}</TableCell>
                      {admin ? <TableCell>{t(`group.${finding.recipientGroup}`)}</TableCell> : null}
                      <TableCell>{limitText(finding)}</TableCell>
                      <TableCell>
                        <div>{figures(finding)}</div>
                        <div className="text-xs text-muted-foreground">
                          {t("findings.measured", { date: day(finding.lastSeenOn) })}
                        </div>
                      </TableCell>
                      <TableCell>
                        {finding.clearedOn === null ? (
                          t("findings.openSince", { date: day(finding.firstCrossedOn) })
                        ) : (
                          <>
                            <div>{t("findings.clearedSince", { date: day(finding.clearedOn) })}</div>
                            <div className="text-xs text-muted-foreground">
                              {t("findings.wasOverSince", { date: day(finding.firstCrossedOn) })}
                            </div>
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </TableCard>
            </>
          )}
        </>
      )}
    </SectionCard>
  );
}
