"use client";

// Täckning → Planerat → "Visa alla elever": every pupil of the opened class and
// every line of their planned timplan — what the plan requires, what the pupil
// gets, the difference, and the groups the minutes come from — without a
// timetable.
//
// WHY A PANEL OF ITS OWN. The overview lists the pupils with a finding of their
// OWN and counts the rest: a pupil who is short because the class is short is
// in "Under mål" and nowhere else, since listing all of them made a 600-pupil
// answer 2.3 MB of the same sentence. This panel is where such a pupil can be
// read, and it asks the gateway for one class's pupils when it is opened
// (GET /timplan-coverage/planned/pupils), as the Stadium tab does. It is fetched
// with lazy() the first time it is chosen, so none of it, nor its hook, is in
// the route's own JavaScript.
//
// THE FIGURES ARE THE GATEWAY'S. The minutes and the differences are the
// overview's, pupil by pupil (the gateway's drill spec derives the table's
// min / median / max and "under mål" from these very lines); nothing is
// recomputed here. Names are the page's: the answer carries pupil ids only.
//
// EVERYTHING IS A WARNING. A line under target is amber with a minus sign,
// never "fel": the law lets a pupil's studiegång deviate.

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { PlannedLine } from "@/lib/timplan-planned";
import { usePlannedClassPupils } from "@/lib/timplan-planned-pupils-queries";
import { linesUnderTarget, shownPupils, sourceKindOf, type SourceKind } from "@/lib/timplan-planned-pupils";
import {
  signedMinutes,
  type NamedPupil,
  type PlannedClassPupil,
  type PlannedPupilFigure,
} from "@/lib/timplan-tackning";
import type { StudentGroup } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/load-error";
import { SearchField } from "@/components/ui/search-field";
import { Skeleton } from "@/components/ui/skeleton";
import { TableScroll } from "@/components/ui/table-scroll";

export interface PlannedClassPupilsProps {
  yearId: string;
  classId: string;
  /** The class's own lines: a pupil's line is told apart from one short because the class is. */
  classLines: readonly PlannedLine[];
  /** The roster, for the order and the filter; the pupils are ids in the answer. */
  people: readonly NamedPupil[];
  pupilName: (id: string) => string;
  groupName: (id: string) => string;
  /** The school's groups, for what kind of group each source is. */
  groups: readonly Pick<StudentGroup, "id" | "kind" | "halfOfId" | "replacesSubjectId">[];
  subjectNames: (ids: string[]) => string;
}

export function PlannedClassPupils({
  yearId,
  classId,
  classLines,
  people,
  pupilName,
  groupName,
  groups,
  subjectNames,
}: PlannedClassPupilsProps) {
  const t = useTranslations("timplanCoverage");
  const query = usePlannedClassPupils(yearId, classId);
  const [filter, setFilter] = useState("");

  // An answer for another class or year (the key changed under it) is no answer.
  const answer =
    query.data && query.data.academicYearId === yearId && query.data.studentGroupId === classId ? query.data : null;
  const shown = useMemo(
    () => (answer ? shownPupils(answer.pupils, people, filter) : []),
    [answer, people, filter],
  );
  const classStatus = useMemo(() => new Map(classLines.map((line) => [line.key, line.status])), [classLines]);
  const kindById = useMemo(() => new Map(groups.map((group) => [group.id, sourceKindOf(group)])), [groups]);
  const groupKind = (id: string): SourceKind | null => kindById.get(id) ?? null;

  if (!answer) {
    return query.isError ? (
      <LoadError
        variant="inline"
        title={t("plannedPupils.loadFailed")}
        hint={t("plannedPupils.loadFailedHint")}
        action={
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            {t("plannedPupils.retry")}
          </Button>
        }
      />
    ) : (
      <Skeleton className="h-24 w-full" aria-busy="true" />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("plannedPupils.hint")}</p>
      {answer.pupils.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("plannedPupils.empty")}</p>
      ) : (
        <>
          <SearchField
            id="tackning-pupil-search"
            label={t("plannedPupils.searchLabel")}
            value={filter}
            onValueChange={setFilter}
          />
          {filter.trim() !== "" ? (
            <p role="status" className="text-xs text-muted-foreground tabular-nums">
              {t("plannedPupils.shown", { shown: shown.length, total: answer.pupils.length })}
            </p>
          ) : null}
          {shown.length === 0 ? (
            <p className="text-sm text-foreground">{t("plannedPupils.noMatch")}</p>
          ) : (
            <ul className="space-y-2">
              {shown.map((pupil) => (
                <PupilCard
                  key={pupil.pupilId}
                  pupil={pupil}
                  name={pupilName(pupil.pupilId)}
                  classStatus={classStatus}
                  groupName={groupName}
                  groupKind={groupKind}
                  subjectNames={subjectNames}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

interface PupilCardProps {
  pupil: PlannedClassPupil;
  name: string;
  classStatus: ReadonlyMap<string, PlannedLine["status"]>;
  groupName: (id: string) => string;
  groupKind: (id: string) => SourceKind | null;
  subjectNames: (ids: string[]) => string;
}

function PupilCard({ pupil, name, classStatus, groupName, groupKind, subjectNames }: PupilCardProps) {
  const t = useTranslations("timplanCoverage");
  const under = linesUnderTarget(pupil).length;
  return (
    <li className="rounded-md border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="font-medium">{name}</p>
        {under > 0 ? (
          <Badge variant="warning" className="tabular-nums">
            {t("plannedPupils.underBadge", { count: under })}
          </Badge>
        ) : pupil.lines.length > 0 ? (
          <span className="text-xs text-muted-foreground">{t("plannedPupils.onTarget")}</span>
        ) : null}
      </div>
      {pupil.lines.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">{t("plannedPupils.noLines")}</p>
      ) : (
        <div className="mt-2">
          <TableScroll>
            <table className="w-full text-sm">
              <caption className="sr-only">{t("plannedPupils.pupilCaption", { pupil: name })}</caption>
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 font-medium">{t("plannedPupils.columnSubject")}</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t("plannedPupils.columnTarget")}</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t("plannedPupils.columnPlanned")}</th>
                  <th scope="col" className="py-1.5 text-right font-medium">{t("plannedPupils.columnDelta")}</th>
                </tr>
              </thead>
              <tbody>
                {pupil.lines.map((line) => (
                  <LineRow
                    key={line.key}
                    line={line}
                    classShort={
                      line.status === "UNDER" &&
                      (classStatus.get(line.key) === "UNDER" || classStatus.get(line.key) === "UNPLANNED")
                    }
                    groupName={groupName}
                    groupKind={groupKind}
                    subjectNames={subjectNames}
                  />
                ))}
              </tbody>
            </table>
          </TableScroll>
        </div>
      )}
    </li>
  );
}

interface LineRowProps {
  line: PlannedPupilFigure;
  classShort: boolean;
  groupName: (id: string) => string;
  groupKind: (id: string) => SourceKind | null;
  subjectNames: (ids: string[]) => string;
}

function LineRow({ line, classShort, groupName, groupKind, subjectNames }: LineRowProps) {
  const t = useTranslations("timplanCoverage");
  const delta = line.deltaMinutesPerWeek;
  const under = line.status === "UNDER";
  // A line made of several subjects (the alternatives, the parts of one national
  // subject) names the subject each group gives; a line of one needs no name.
  const named = line.subjectIds.length > 1;
  const sources = line.sources.map((source) => {
    const kind = groupKind(source.studentGroupId);
    const values = {
      subject: subjectNames([source.subjectId]),
      group: groupName(source.studentGroupId),
      kind: kind === null ? "" : t(`plannedPupils.kind.${kind}`),
      minutes: source.minutesPerWeek,
    };
    const key =
      kind === null
        ? named
          ? "plannedPupils.sourceNamedBare"
          : "plannedPupils.sourceBare"
        : named
          ? "plannedPupils.sourceNamed"
          : "plannedPupils.source";
    return { id: `${source.studentGroupId}:${source.subjectId}`, text: t(key, values) };
  });
  return (
    <>
      <tr className="align-top">
        <th scope="row" className="pt-1.5 pr-3 text-left font-medium">
          {subjectNames(line.subjectIds)}
          {line.alternativeCode !== null ? (
            <span className="ml-1 text-xs font-normal text-muted-foreground">{t("together")}</span>
          ) : null}
          {line.nationalCode !== undefined ? (
            <span className="ml-1 text-xs font-normal text-muted-foreground">{t("partsTogether")}</span>
          ) : null}
        </th>
        <td className="pt-1.5 pr-3 text-right tabular-nums">{line.targetMinutesPerWeek ?? "—"}</td>
        <td
          className={cn(
            "pt-1.5 pr-3 text-right tabular-nums",
            under && "font-medium text-warning-foreground dark:text-warning",
          )}
        >
          {line.plannedMinutesPerWeek}
        </td>
        <td
          className={cn(
            "pt-1.5 text-right tabular-nums",
            under && "font-medium text-warning-foreground dark:text-warning",
          )}
        >
          <span aria-hidden="true">{delta === null ? "—" : signedMinutes(delta)}</span>
          <span className="sr-only">
            {delta === null
              ? t("plannedPupils.noTarget")
              : delta < 0
                ? t("plannedPupils.deltaUnder", { minutes: -delta })
                : delta > 0
                  ? t("plannedPupils.deltaOver", { minutes: delta })
                  : t("plannedPupils.deltaMet")}
          </span>
        </td>
      </tr>
      {/* Where the minutes come from sits on a row of its own under the line,
          across the table: on a phone a fifth column is off the edge, and it
          is the one that answers "where do these minutes come from". */}
      <tr className="border-b last:border-b-0">
        <td colSpan={4} className="pb-1.5 text-xs text-muted-foreground">
          {sources.length === 0 ? (
            <p>{t("plannedPupils.noSources")}</p>
          ) : (
            <>
              <p>{t("plannedPupils.sourcesLabel")}</p>
              <ul>
                {sources.map((source) => (
                  <li key={source.id}>{source.text}</li>
                ))}
              </ul>
            </>
          )}
          {classShort ? <p className="mt-0.5 text-foreground">{t("plannedPupils.classAlsoUnder")}</p> : null}
          {line.doublePlannedSubjectIds.length > 0 ? (
            <p className="mt-0.5 text-foreground">
              {t("pupilDouble", { subjects: subjectNames(line.doublePlannedSubjectIds) })}
            </p>
          ) : null}
          {line.alternativeSubjectIds.length > 0 ? (
            <p className="mt-0.5 text-foreground">
              {t("pupilAlternatives", { subjects: subjectNames(line.alternativeSubjectIds) })}
            </p>
          ) : null}
        </td>
      </tr>
    </>
  );
}
