"use client";

import { useTranslations } from "next-intl";
import type { RolloverPreview, StudentGroup } from "@/lib/types";
import type { GroupChoiceState, RolloverFormState } from "@/lib/year-rollover-form";
import {
  lowestClassGrade,
  type NameCollision,
  type ResolvedGroup,
  type RolloverOutcome,
} from "@/lib/year-rollover";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const DEFAULT = "DEFAULT";
type Switches = "carryTeachingGroups" | "carryTeachingGroupMembers" | "keepTeachers" | "carryClassRules" | "carryStaffing";
const SWITCHES: Switches[] = [
  "carryTeachingGroups",
  "carryTeachingGroupMembers",
  "keepTeachers",
  "carryClassRules",
  "carryStaffing",
];

/**
 * Steg 2, Klasser och grupper: what each group of this year becomes.
 *
 * The OUTCOME and the NEW NAME come from the mirror (lib/year-rollover.ts),
 * so they follow every click and keystroke at once. The COUNTS — pupils,
 * members carried and left out, timplansposter, where the carried minutes
 * part from the decided timplan — come from the gateway's preview, which
 * reads rows the mirror cannot; they catch up when it answers.
 *
 * A name is typed over a placeholder, never into a prefilled field: a blank
 * field means "the name the rule gives" (8A), so clearing a mistyped override
 * goes back to the rule instead of sending an empty name.
 */
export function RolloverGroupsStep({
  form,
  update,
  sourceGroups,
  resolved,
  defaults,
  collisions,
  plan,
}: {
  form: RolloverFormState;
  update: (patch: Partial<RolloverFormState>) => void;
  sourceGroups: StudentGroup[];
  resolved: ResolvedGroup[];
  defaults: ResolvedGroup[];
  collisions: NameCollision[];
  plan: RolloverPreview | undefined;
}) {
  const t = useTranslations("years");
  const lowest = lowestClassGrade(sourceGroups);
  const resolvedOf = new Map(resolved.map((row) => [row.sourceGroupId, row]));
  const defaultOf = new Map(defaults.map((row) => [row.sourceGroupId, row]));
  const plannedOf = new Map((plan?.groups ?? []).map((row) => [row.sourceGroupId, row]));
  const blocked = new Set(collisions.filter((c) => !c.caseOnly).flatMap((c) => c.sourceGroupIds));
  const caseOnly = new Set(collisions.filter((c) => c.caseOnly).flatMap((c) => c.sourceGroupIds));

  const choose = (groupId: string, patch: GroupChoiceState) => {
    const next = { ...(form.groups[groupId] ?? {}), ...patch };
    update({ groups: { ...form.groups, [groupId]: next } });
  };

  return (
    <div className="space-y-6">
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="sr-only">{t("optionsLabel")}</legend>
        {SWITCHES.map((key) => (
          <label key={key} className="flex items-start gap-3 text-sm">
            <Switch
              checked={form[key]}
              onCheckedChange={(checked) => update({ [key]: checked })}
              aria-describedby={`rollover-${key}-hint`}
            />
            <span>
              <span className="font-medium">{t(`option.${key}`)}</span>
              <span id={`rollover-${key}-hint`} className="block text-xs text-muted-foreground">
                {t(`optionHint.${key}`)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {sourceGroups.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noGroups")}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("colGroup")}</TableHead>
              <TableHead>{t("colOutcome")}</TableHead>
              <TableHead>{t("colNewName")}</TableHead>
              <TableHead>{t("colCarried")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sourceGroups.map((group) => {
              const row = resolvedOf.get(group.id);
              const byDefault = defaultOf.get(group.id);
              const planned = plannedOf.get(group.id);
              const choice = form.groups[group.id] ?? {};
              if (!row || !byDefault) return null;
              const graduates = byDefault.outcome === "GRADUATE";
              const canPromote = group.gradeLevel !== null && !graduates;
              const canIntake = group.kind === "CLASS" && group.gradeLevel !== null && group.gradeLevel === lowest;
              const outcomes: ("PROMOTE" | "CARRY" | "SKIP" | "INTAKE")[] = [
                ...(canPromote ? (["PROMOTE"] as const) : []),
                "CARRY",
                "SKIP",
                ...(canIntake ? (["INTAKE"] as const) : []),
              ];
              const nameId = `rollover-name-${group.id}`;
              return (
                <TableRow key={group.id}>
                  <TableCell>
                    <div className="font-medium">{group.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {group.gradeLevel !== null ? t("gradeShort", { grade: group.gradeLevel }) : t("noGrade")}
                      {group.kind === "TEACHING_GROUP" ? ` · ${t("teachingGroup")}` : ""}
                    </div>
                  </TableCell>
                  <TableCell className="min-w-44">
                    <Select
                      value={choice.outcome ?? DEFAULT}
                      onValueChange={(value) =>
                        choose(group.id, {
                          outcome: value === DEFAULT ? undefined : (value as GroupChoiceState["outcome"]),
                        })
                      }
                    >
                      <SelectTrigger aria-label={t("outcomeFor", { name: group.name })}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT}>
                          {t("outcomeDefault", { outcome: t(`outcome.${byDefault.outcome}`) })}
                        </SelectItem>
                        {outcomes.map((outcome) => (
                          <SelectItem key={outcome} value={outcome}>
                            {t(`outcome.${outcome}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {row.error ? (
                      <p role="alert" className="mt-1 text-xs text-destructive">
                        {t(`choiceError.${row.error}`)}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell className="min-w-44">
                    {row.successor ? (
                      <>
                        <Label htmlFor={nameId} className="sr-only">
                          {t("newNameFor", { name: group.name })}
                        </Label>
                        <Input
                          id={nameId}
                          value={choice.name ?? ""}
                          maxLength={60}
                          placeholder={row.successor.name}
                          aria-invalid={blocked.has(group.id) || undefined}
                          className={blocked.has(group.id) ? "border-destructive" : undefined}
                          onChange={(event) => choose(group.id, { name: event.target.value })}
                        />
                        <GroupFlags
                          row={row}
                          collision={blocked.has(group.id)}
                          caseCollision={caseOnly.has(group.id)}
                        />
                      </>
                    ) : (
                      <span className="text-sm text-muted-foreground">{t(`leaves.${row.outcome}`)}</span>
                    )}
                    {row.intake ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("intakeNote", { name: row.successor?.name ?? group.name, intake: row.intake.name })}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {planned ? <PlannedCounts planned={planned} outcome={row.outcome} /> : "…"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function GroupFlags({
  row,
  collision,
  caseCollision,
}: {
  row: ResolvedGroup;
  collision: boolean;
  caseCollision: boolean;
}) {
  const t = useTranslations("years");
  const flags: { key: string; text: string; variant: "destructive" | "warning" | "secondary" }[] = [];
  if (collision) flags.push({ key: "collision", text: t("flag.collision"), variant: "destructive" });
  if (caseCollision) flags.push({ key: "case", text: t("flag.caseCollision"), variant: "warning" });
  if (row.nameStatus === "KEPT_AMBIGUOUS") flags.push({ key: "ambiguous", text: t("flag.ambiguous"), variant: "warning" });
  if (row.nameStatus === "KEPT_NO_GRADE_DIGIT" && row.outcome !== "CARRY") {
    flags.push({ key: "kept", text: t("flag.keptNoDigit"), variant: "secondary" });
  }
  if (row.nameStatus === "F_KLASS") flags.push({ key: "f", text: t("flag.fKlass"), variant: "secondary" });
  if (row.noGrade) flags.push({ key: "noGrade", text: t("flag.noGrade"), variant: "secondary" });
  if (flags.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {flags.map((flag) => (
        <Badge key={flag.key} variant={flag.variant} className="text-[10px]">
          {flag.text}
        </Badge>
      ))}
    </div>
  );
}

function PlannedCounts({
  planned,
  outcome,
}: {
  planned: RolloverPreview["groups"][number];
  outcome: RolloverOutcome;
}) {
  const t = useTranslations("years");
  const lines: string[] = [];
  // What happens to the class's pupils at the activation follows the outcome:
  // a promoted, carried or intake class has a successor to move into; a
  // graduating class's pupils leave; a skipped class's are left with none.
  if (planned.kind === "CLASS") {
    const fate =
      outcome === "GRADUATE" || (outcome === "INTAKE" && planned.targetName === null)
        ? "count.homePupilsGraduate"
        : outcome === "SKIP"
          ? "count.homePupilsUnplaced"
          : "count.homePupils";
    lines.push(t(fate, { count: planned.homePupils }));
  }
  if (planned.kind === "TEACHING_GROUP" && outcome !== "SKIP" && outcome !== "GRADUATE") {
    lines.push(t("count.membersCopied", { count: planned.membersCopied }));
  }
  const excluded = planned.membersExcluded.graduating + planned.membersExcluded.noSuccessor;
  if (excluded > 0) {
    lines.push(
      t("count.membersExcluded", {
        count: excluded,
        graduating: planned.membersExcluded.graduating,
        noSuccessor: planned.membersExcluded.noSuccessor,
      }),
    );
  }
  if (planned.membersStranded > 0) lines.push(t("count.membersStranded", { count: planned.membersStranded }));
  lines.push(t("count.requirements", { count: planned.requirementsCarried }));
  return (
    <div className="space-y-0.5">
      {lines.map((line) => (
        <div key={line}>{line}</div>
      ))}
      {planned.volumeFindings.length > 0 ? (
        <details className="text-warning-foreground dark:text-warning">
          <summary className="cursor-pointer">
            {t("count.volume", { count: planned.volumeFindings.length, plan: planned.volumePlanName ?? "" })}
          </summary>
          <ul className="mt-1 space-y-0.5">
            {planned.volumeFindings.map((finding) => (
              <li key={finding.subjectId}>
                {t("volumeLine", {
                  subject: finding.subjectName || "—",
                  carried: finding.carried,
                  planned: finding.planned,
                })}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
