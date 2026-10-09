"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import { engineMessage, type MessageLookup } from "@/lib/engine-message";
import { warningText } from "@/lib/staffing-warnings";
import { DEFAULT_LOAD_POLICY } from "@/lib/teacher-load";
import type { StaffingPolicy } from "@/lib/types";
import { StatusBadge } from "@/components/staffing/staffing-matrix";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  loadsUnderSelection,
  orderedTeachers,
  reversed,
  selectedChanges,
  touchedTeachers,
} from "./proposal-selection";
import {
  DEFAULT_STAFF_WEIGHTS,
  STAFF_ENGINE_UNAVAILABLE,
  STAFF_PROPOSAL_STALE,
  STAFF_WEIGHT_KEYS,
  useApplyStaffing,
  useStaffingProposal,
  type ProposalAssignment,
  type StaffingApplyResult,
  type StaffingChange,
  type StaffingProposal,
  type StaffWeights,
} from "./use-staffing-proposal";

/**
 * How long the applied toast, and with it Ångra, stays up — the room
 * optimisation's figure and reason: the default four seconds is shorter than
 * it takes to read the message.
 */
const UNDO_TOAST_MS = 15_000;

/** The model's own guard against a too-large school; the sentence is the engine catalogue's. */
const STAFF_MODEL_TOO_LARGE = "STAFF_MODEL_TOO_LARGE";
/** The gateway's: more staff, or more rows in play, than the engine's lists take. */
const STAFF_PROPOSAL_TOO_MANY = "STAFF_PROPOSAL_TOO_MANY";
/** The conflict line about one teacher: the page puts the name in front of it. */
const STAFF_TEACHER_CAPACITY_ZERO = "STAFF_TEACHER_CAPACITY_ZERO";

const KIND_VARIANT = { LEGITIMATION: "success", BEHORIG: "secondary", TILLATEN: "outline" } as const;

export interface StaffingProposalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  academicYearId: string;
  /** In the title: /admin/generate links here for whichever year it plans, the page opens the active one. */
  academicYearName: string;
  /**
   * From the page's load report: how many teachers have a target above 0, of
   * how many. At 0 nobody can be given a row (a teacher without a target is
   * never a candidate), so the dialog says so and does not ask.
   */
  teachersWithTarget: number;
  teachersTotal: number;
  /** The report's: whether the school has recorded any behörighet at all. */
  qualificationsRecorded: boolean;
  /**
   * The school's policy as the page holds it (null: none saved yet, undefined:
   * still loading — both read as the defaults, as the gateway reads them), for
   * two things: whether REFUSE forces "Respektera behörighet" on, and the
   * tolerance a selection's loads are re-judged with.
   */
  policy: Pick<StaffingPolicy, "qualificationMode" | "overAllocationTolerancePercent"> | null | undefined;
  /**
   * Names come from the page's own lists. The proposal carries ids only: the
   * engine never saw a name, and nothing the gateway computed holds one.
   */
  teacherName: (userId: string) => string;
  groupName: (groupId: string) => string;
  subjectName: (subjectId: string) => string;
  /** Closes the dialog and opens the settings card, where a riktmärke is set. */
  onOpenSettings: () => void;
}

/**
 * Föreslå bemanning: the engine proposes a lead for every row that is to be
 * staffed — one with room left under their limit, and qualified if the
 * school asks for it — and says why the rest stays unstaffed.
 *
 * TWO STEPS, like the room optimisation: first what may change (only the
 * unstaffed rows, or every row; behörighet; the weights under Avancerat),
 * then the answer — each teacher before → after, each row with its proposed
 * lead and why, the rows left unstaffed with the reason — and only then a
 * write. The admin can leave rows out (the figures follow the selection), pin
 * a row as it is and ask again, apply, and undo from the toast.
 *
 * NOTHING HERE DECIDES. Which rows may change, the limits, who is qualified
 * and the loads are the gateway's; the dialog only re-adds the charges of the
 * rows left out (proposal-selection.ts). The apply is judged by the same
 * WARN/REFUSE questions as any other write, as one batch.
 *
 * React.lazy from the page: it opens on a click and costs the matrix nothing.
 */
export function StaffingProposalDialog({
  open,
  onOpenChange,
  academicYearId,
  academicYearName,
  teachersWithTarget,
  teachersTotal,
  qualificationsRecorded,
  policy,
  teacherName,
  groupName,
  subjectName,
  onOpenSettings,
}: StaffingProposalDialogProps) {
  const t = useTranslations("staffing.proposal");
  const tCommon = useTranslations("common");
  const tEngine = useTranslations("engineMessages") as unknown as MessageLookup;
  const locale = useLocale();
  const propose = useStaffingProposal();
  const apply = useApplyStaffing();

  const qualificationMode = policy?.qualificationMode ?? DEFAULT_LOAD_POLICY.qualificationMode;
  const tolerancePercent = policy?.overAllocationTolerancePercent ?? DEFAULT_LOAD_POLICY.overAllocationTolerancePercent;
  const forced = qualificationsRecorded && qualificationMode === "REFUSE";
  const [onlyUnstaffed, setOnlyUnstaffed] = useState(true);
  const [respectChoice, setRespectChoice] = useState(true);
  const respect = qualificationsRecorded && (forced || respectChoice);
  const [weights, setWeights] = useState<StaffWeights>(DEFAULT_STAFF_WEIGHTS);
  const [pinned, setPinned] = useState<string[]>([]);
  const [proposal, setProposal] = useState<StaffingProposal | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [showAllTeachers, setShowAllTeachers] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  /*
   * Which ask an answer belongs to — the room dialog's guard. Closing abandons
   * the ask in flight, but the solve goes on and would otherwise land in a
   * dialog reopened later, offering a stale proposal to apply.
   */
  const ask = useRef(0);

  const number = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1, useGrouping: false }),
    [locale],
  );
  const rowName = (subjectId: string, groupId: string) =>
    t("rowName", { subject: subjectName(subjectId), group: groupName(groupId) });

  const changeOpen = (next: boolean) => {
    if (!next) {
      ask.current += 1;
      setProposal(null);
      setProblem(null);
      setStale(false);
    }
    onOpenChange(next);
  };

  /** A failed ask or apply, as one sentence for the dialog's alert. */
  const failure = (error: unknown): string => {
    if (!(error instanceof ApiError)) return tCommon("error");
    if (error.code === STAFF_ENGINE_UNAVAILABLE || error.status === 502 || error.status === 503) {
      return t("engineUnavailable");
    }
    if (error.status === 404) return t("yearMissing");
    if (error.code === STAFF_MODEL_TOO_LARGE) {
      return engineMessage(tEngine, { code: error.code, message: error.message, params: error.params ?? null });
    }
    if (error.code === STAFF_PROPOSAL_TOO_MANY && error.params) {
      const { teachers, requirements, limitTeachers, limitRequirements } = error.params;
      return t("tooMany", {
        teachers: Number(teachers),
        rows: Number(requirements),
        limitTeachers: Number(limitTeachers),
        limitRows: Number(limitRequirements),
      });
    }
    return error.message || tCommon("error");
  };

  const sentWeights = (): Partial<StaffWeights> | undefined => {
    const changed = STAFF_WEIGHT_KEYS.filter((key) => weights[key] !== DEFAULT_STAFF_WEIGHTS[key]);
    return changed.length === 0 ? undefined : Object.fromEntries(changed.map((key) => [key, weights[key]]));
  };

  /**
   * `leftOut`: rows the admin had unticked, kept unticked in the answer when
   * it proposes them again — a "Behåll" asks again for one row's sake, not to
   * undo the admin's other choices.
   */
  const compute = async (pins: string[] = pinned, leftOut: ReadonlySet<string> = new Set()) => {
    const mine = ++ask.current;
    setProblem(null);
    try {
      const answer = await propose.mutateAsync({
        academicYearId,
        onlyUnstaffed,
        respectQualifications: respect,
        ...(pins.length > 0 ? { pinnedRequirementIds: pins } : {}),
        ...(sentWeights() ? { weights: sentWeights() } : {}),
      });
      if (mine !== ask.current) return;
      setStale(false);
      setProposal(answer);
      setSelected(
        new Set(
          answer.assignments
            .map((assignment) => assignment.requirementId)
            .filter((requirementId) => !leftOut.has(requirementId)),
        ),
      );
    } catch (error) {
      if (mine === ask.current) setProblem(failure(error));
    }
  };

  /**
   * "Behåll som nu och beräkna om": the row is pinned, and the proposal asked
   * again without it. It leaves the selection at once — a recompute that
   * fails (the throttle, the engine) leaves the old proposal on screen, and
   * "Tillämpa" must not then write the very row the admin asked to keep.
   */
  const keep = (requirementId: string) => {
    const pins = pinned.includes(requirementId) ? pinned : [...pinned, requirementId];
    const leftOut = new Set(
      (proposal?.assignments ?? [])
        .map((assignment) => assignment.requirementId)
        .filter((id) => !selected.has(id)),
    );
    setSelected((previous) => {
      const next = new Set(previous);
      next.delete(requirementId);
      return next;
    });
    setPinned(pins);
    void compute(pins, leftOut);
  };

  /** A REFUSE of the batch: whom it is about, which row, and the policy's sentence. */
  const refusalText = (error: ApiError): string => {
    const params = error.params ?? {};
    const userId = typeof params.userId === "string" ? params.userId : null;
    const requirementId = typeof params.requirementId === "string" ? params.requirementId : null;
    const row = proposal?.assignments.find((assignment) => assignment.requirementId === requirementId);
    const who = userId ? teacherName(userId) : null;
    if (error.code && tEngine.has(error.code)) {
      const sentence = engineMessage(tEngine, { code: error.code, message: error.message, params });
      const where = row ? rowName(row.subjectId, row.studentGroupId) : null;
      return [who, where].filter(Boolean).join(", ") + (who || where ? ": " : "") + sentence;
    }
    // The gateway's Swedish already starts with the row's name.
    return who ? `${who}: ${error.message}` : error.message;
  };

  const warningLines = (result: StaffingApplyResult): string =>
    result.warnings
      .map((warning) => {
        const rows = (proposal?.assignments ?? [])
          .filter((assignment) => warning.requirementIds.includes(assignment.requirementId))
          .map((assignment) => rowName(assignment.subjectId, assignment.studentGroupId));
        const where = rows.length > 0 ? ` (${rows.join(", ")})` : "";
        return `${teacherName(warning.userId)}${where}: ${warningText(tEngine, warning)}`;
      })
      .join(" ");

  /**
   * The applied changes sent back, against the basis the apply returned. A
   * stale 409 means somebody changed a lead since, and reversing blind would
   * undo their change too; a REFUSE is the policy answering the reversal
   * like any other write (undo gets no bypass).
   */
  const undo = async (yearId: string, changes: StaffingChange[], applied: StaffingApplyResult) => {
    try {
      await apply.mutateAsync({
        academicYearId: yearId,
        basisSha256: applied.basisSha256,
        undo: true,
        changes: reversed(changes),
      });
      toast.success(t("undone"));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast.error(error.code === STAFF_PROPOSAL_STALE ? t("undoStale") : t("undoRefused", { reason: refusalText(error) }));
        return;
      }
      toast.error(failure(error));
    }
  };

  const doApply = async () => {
    if (!proposal) return;
    const changes = selectedChanges(proposal.assignments, selected);
    if (changes.length === 0) return;
    setProblem(null);
    try {
      const result = await apply.mutateAsync({ academicYearId, basisSha256: proposal.basisSha256, changes });
      const title = t("applied", { count: result.updated });
      const options = {
        duration: UNDO_TOAST_MS,
        action: { label: t("undo"), onClick: () => void undo(academicYearId, changes, result) },
      };
      if (result.warnings.length > 0) toast.warning(title, { ...options, description: warningLines(result) });
      else toast.success(title, options);
      changeOpen(false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === STAFF_PROPOSAL_STALE) {
        // Nothing was written. Back to the options, said there, with the
        // button that asks again.
        ask.current += 1;
        setProposal(null);
        setStale(true);
        return;
      }
      setProblem(error instanceof ApiError && error.status === 409 ? refusalText(error) : failure(error));
    }
  };

  const noTargets = teachersWithTarget === 0;
  const busy = propose.isPending || apply.isPending;

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t("title", { year: academicYearName })}</DialogTitle>
          <DialogDescription>{t("body")}</DialogDescription>
        </DialogHeader>

        {problem ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {problem}
          </p>
        ) : null}

        {proposal === null ? (
          <>
            {stale ? (
              <p role="status" className="rounded-md bg-muted p-3 text-sm text-foreground">
                {t("stale")}
              </p>
            ) : null}
            <fieldset className="space-y-3" disabled={propose.isPending}>
              <legend className="sr-only">{t("optionsLabel")}</legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={onlyUnstaffed}
                  onChange={(event) => setOnlyUnstaffed(event.target.checked)}
                />
                <span>
                  <span className="font-medium">{t("onlyUnstaffed")}</span>
                  <span className="block text-muted-foreground">
                    {onlyUnstaffed ? t("onlyUnstaffedOnHint") : t("onlyUnstaffedOffHint")}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={respect}
                  disabled={!qualificationsRecorded || forced}
                  onChange={(event) => setRespectChoice(event.target.checked)}
                />
                <span>
                  <span className="font-medium">{t("respect")}</span>
                  <span className="block text-muted-foreground">
                    {!qualificationsRecorded
                      ? t("respectNoRecords")
                      : forced
                        ? t("respectForced")
                        : respect
                          ? t("respectOnHint")
                          : t("respectOffHint")}
                  </span>
                </span>
              </label>

              <details className="rounded-md border p-3 text-sm">
                <summary className="cursor-pointer font-medium">{t("advanced")}</summary>
                <p className="mt-2 text-muted-foreground">{t("advancedHint")}</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {STAFF_WEIGHT_KEYS.map((key) => (
                    <label key={key} className="flex items-center justify-between gap-3">
                      <span>{t(`weight_${key}`)}</span>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={100}
                        step={1}
                        className="w-20"
                        value={weights[key]}
                        onChange={(event) => {
                          const value = Math.round(Number(event.target.value));
                          setWeights((current) => ({
                            ...current,
                            [key]: Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0,
                          }));
                        }}
                      />
                    </label>
                  ))}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => setWeights(DEFAULT_STAFF_WEIGHTS)}
                >
                  {t("weightsReset")}
                </Button>
              </details>
            </fieldset>

            {pinned.length > 0 ? (
              <p className="flex flex-wrap items-center gap-2 text-sm">
                {t("pinned", { count: pinned.length })}
                <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setPinned([])}>
                  {t("pinnedClear")}
                </Button>
              </p>
            ) : null}

            {noTargets ? (
              <div role="status" className="space-y-2 rounded-md bg-muted p-3 text-sm text-foreground">
                <p>{t("noTargets")}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    changeOpen(false);
                    onOpenSettings();
                  }}
                >
                  {t("noTargetsAction")}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("targets", { withTarget: teachersWithTarget, total: teachersTotal })}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t("unchanged")}</p>

            <DialogFooter className="flex-wrap gap-2">
              <Button variant="outline" onClick={() => changeOpen(false)}>
                {tCommon("cancel")}
              </Button>
              <Button onClick={() => void compute()} disabled={noTargets || propose.isPending}>
                {propose.isPending ? (
                  <>
                    <Loader2 className="animate-spin" />
                    {t("computing")}
                  </>
                ) : stale ? (
                  t("recompute")
                ) : (
                  t("compute")
                )}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <ProposalResult
            proposal={proposal}
            selected={selected}
            onSelect={setSelected}
            showAllTeachers={showAllTeachers}
            onShowAllTeachers={setShowAllTeachers}
            tolerancePercent={tolerancePercent}
            number={number}
            teacherName={teacherName}
            rowName={rowName}
            onKeep={keep}
            busy={busy}
          >
            <DialogFooter className="flex-wrap gap-2">
              <Button variant="outline" onClick={() => setProposal(null)} disabled={busy}>
                {t("back")}
              </Button>
              {proposal.assignments.length === 0 ? (
                <Button onClick={() => changeOpen(false)}>{tCommon("close")}</Button>
              ) : (
                <Button onClick={() => void doApply()} disabled={busy || selected.size === 0}>
                  {apply.isPending || propose.isPending ? <Loader2 className="animate-spin" /> : null}
                  {t("apply", { count: selected.size })}
                </Button>
              )}
            </DialogFooter>
          </ProposalResult>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The answer: the rows, the teachers before → after, what stays unstaffed and why. */
function ProposalResult({
  proposal,
  selected,
  onSelect,
  showAllTeachers,
  onShowAllTeachers,
  tolerancePercent,
  number,
  teacherName,
  rowName,
  onKeep,
  busy,
  children,
}: {
  proposal: StaffingProposal;
  selected: ReadonlySet<string>;
  onSelect: (next: ReadonlySet<string>) => void;
  showAllTeachers: boolean;
  onShowAllTeachers: (next: boolean) => void;
  tolerancePercent: number;
  number: Intl.NumberFormat;
  teacherName: (userId: string) => string;
  rowName: (subjectId: string, groupId: string) => string;
  onKeep: (requirementId: string) => void;
  busy: boolean;
  children: ReactNode;
}) {
  const t = useTranslations("staffing.proposal");
  const tStaffing = useTranslations("staffing");
  const tEngine = useTranslations("engineMessages") as unknown as MessageLookup;
  const loads = loadsUnderSelection(proposal, selected, tolerancePercent);
  const touched = touchedTeachers(proposal.assignments);
  const teachers = orderedTeachers(proposal.teachers, touched, teacherName);
  const changed = teachers.filter((teacher) => touched.has(teacher.userId));
  const shown = showAllTeachers ? teachers : changed;
  const staff = new Set(proposal.teachers.map((teacher) => teacher.userId));
  const allSelected = proposal.assignments.length > 0 && selected.size === proposal.assignments.length;
  const recorded = proposal.options.qualificationsRecorded;

  const toggle = (requirementId: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(requirementId);
    else next.delete(requirementId);
    onSelect(next);
  };
  const minutesText = (minutes: number, percent: number | null) =>
    percent === null
      ? t("minutes", { minutes: number.format(minutes) })
      : t("minutesPercent", { minutes: number.format(minutes), percent: number.format(percent) });
  const nowText = (assignment: ProposalAssignment) =>
    assignment.fromTeacherId === null
      ? t("nowNobody")
      : staff.has(assignment.fromTeacherId)
        ? teacherName(assignment.fromTeacherId)
        : t("nowLeft", { teacher: teacherName(assignment.fromTeacherId) });

  return (
    <div className="space-y-4">
      <div role="status" className="space-y-1 text-sm">
        <p className="font-medium">
          {t(`status${proposal.status}`)}
          {proposal.unstaffedProven ? ` · ${t("unstaffedProven")}` : ""}
        </p>
        {proposal.status === "FEASIBLE" ? <p className="text-muted-foreground">{t("feasibleHint")}</p> : null}
        {proposal.counts.freeRequirements === 0 ? (
          <p>{t("nothingToDo")}</p>
        ) : (
          <p>{t("summary", { changes: proposal.assignments.length, unstaffed: proposal.unstaffed.length })}</p>
        )}
        {proposal.counts.vacated > 0 ? <p>{t("vacated", { count: proposal.counts.vacated })}</p> : null}
        {proposal.counts.inconsistent > 0 ? (
          <p>{t("inconsistent", { count: proposal.counts.inconsistent })}</p>
        ) : null}
        {proposal.options.pinnedRequirementIds.length > 0 ? (
          <p>{t("pinned", { count: proposal.options.pinnedRequirementIds.length })}</p>
        ) : null}
        {!recorded ? <p className="text-muted-foreground">{t("respectNoRecords")}</p> : null}
      </div>

      {proposal.assignments.length > 0 ? (
        <section aria-labelledby="proposal-rows" className="space-y-2">
          <h3 id="proposal-rows" className="text-sm font-semibold">
            {t("rowsTitle")}
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="w-8 py-1 pr-2 font-medium">
                    <input
                      type="checkbox"
                      aria-label={t("selectAll")}
                      checked={allSelected}
                      onChange={(event) =>
                        onSelect(
                          event.target.checked
                            ? new Set(proposal.assignments.map((assignment) => assignment.requirementId))
                            : new Set(),
                        )
                      }
                    />
                  </th>
                  <th className="py-1 pr-3 font-medium">{t("colRow")}</th>
                  <th className="py-1 pr-3 font-medium">{t("colProposed")}</th>
                  <th className="py-1 pr-3 font-medium">{t("colNow")}</th>
                  <th className="py-1 font-medium">
                    <span className="sr-only">{t("colKeep")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {proposal.assignments.map((assignment) => {
                  const name = rowName(assignment.subjectId, assignment.studentGroupId);
                  const { reasons } = assignment;
                  return (
                    <tr key={assignment.requirementId} className="border-t align-top">
                      <td className="py-1.5 pr-2">
                        <input
                          type="checkbox"
                          aria-label={t("selectRow", { row: name })}
                          checked={selected.has(assignment.requirementId)}
                          onChange={(event) => toggle(assignment.requirementId, event.target.checked)}
                        />
                      </td>
                      <td className="py-1.5 pr-3">
                        <span className="font-medium">{name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {t("minutes", { minutes: number.format(assignment.chargeMinutesPerWeek) })}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3">
                        <span className="font-medium">{teacherName(assignment.toTeacherId)}</span>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {reasons.qualificationKind ? (
                            <Badge variant={KIND_VARIANT[reasons.qualificationKind]}>
                              {tStaffing(`kind${reasons.qualificationKind}`)}
                            </Badge>
                          ) : recorded ? (
                            <Badge variant="warning">{t("badgeUnqualified")}</Badge>
                          ) : null}
                          {reasons.taughtLastYear ? (
                            <Badge variant="secondary">{t("badgeLastYear")}</Badge>
                          ) : reasons.familiarWithSubject ? (
                            <Badge variant="outline">{t("badgeFamiliar")}</Badge>
                          ) : null}
                          {reasons.teachesGroupAlready ? (
                            <Badge variant="outline">{t("badgeGroup")}</Badge>
                          ) : null}
                        </div>
                      </td>
                      <td className="py-1.5 pr-3">{nowText(assignment)}</td>
                      <td className="py-1.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-auto px-2 py-1 text-xs"
                          disabled={busy}
                          aria-label={t("keepRow", { row: name })}
                          onClick={() => onKeep(assignment.requirementId)}
                        >
                          {t("keep")}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {proposal.teachers.length > 0 ? (
        <section aria-labelledby="proposal-teachers" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="proposal-teachers" className="text-sm font-semibold">
              {t("teachersTitle")}
            </h3>
            {teachers.length > changed.length ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={() => onShowAllTeachers(!showAllTeachers)}
              >
                {showAllTeachers ? t("teachersShowChanged") : t("teachersShowAll", { count: teachers.length })}
              </Button>
            ) : null}
          </div>
          {shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("teachersNoneChanged")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="py-1 pr-3 font-medium">{t("colTeacher")}</th>
                    <th className="py-1 pr-3 font-medium">{t("colBefore")}</th>
                    <th className="py-1 pr-3 font-medium">{t("colAfter")}</th>
                    <th className="py-1 font-medium">{t("colStatus")}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((teacher) => {
                    const load = loads.get(teacher.userId)!;
                    return (
                      <tr key={teacher.userId} className="border-t align-top">
                        <th scope="row" className="py-1.5 pr-3 text-left font-medium">
                          {teacherName(teacher.userId)}
                          {teacher.keepOrShed ? (
                            <span className="block text-xs font-normal text-muted-foreground">
                              {/* No target: the gateway keeps their rows fixed. */}
                              {teacher.targetMinutesPerWeek === null ? t("keepsNoTarget") : t("keepOrShed")}
                            </span>
                          ) : null}
                        </th>
                        <td className="py-1.5 pr-3 tabular-nums">
                          {minutesText(teacher.before.countedMinutesPerWeek, teacher.before.percentOfTarget)}
                        </td>
                        <td className="py-1.5 pr-3 tabular-nums">
                          {minutesText(load.minutes, load.percentOfTarget)}
                          {load.overLimit ? (
                            <span className="block text-xs text-foreground">{t("overLimitSelection")}</span>
                          ) : null}
                        </td>
                        <td className="py-1.5">
                          <StatusBadge status={load.status} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {proposal.unstaffed.length > 0 ? (
        <section aria-labelledby="proposal-unstaffed" className="space-y-2">
          <h3 id="proposal-unstaffed" className="text-sm font-semibold">
            {t("unstaffedTitle", { count: proposal.unstaffed.length })}
          </h3>
          <ul className="space-y-1 text-sm">
            {proposal.unstaffed.map((row) => (
              <li key={row.requirementId}>
                <span className="font-medium">{rowName(row.subjectId, row.studentGroupId)}</span>
                {" · "}
                {t("minutes", { minutes: number.format(row.chargeMinutesPerWeek) })}
                {" — "}
                {row.onlyCoTeacherQualified ? t("reasonOnlyCoTeacher") : t(`reason_${row.reason}`)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {proposal.conflicts.length > 0 ? (
        <section aria-labelledby="proposal-conflicts" className="space-y-2">
          <h3 id="proposal-conflicts" className="text-sm font-semibold">
            {t("conflictsTitle")}
          </h3>
          <ul className="space-y-1 text-sm">
            {proposal.conflicts.map((conflict, index) => {
              const sentence = engineMessage(tEngine, conflict);
              const names = conflict.teacherIds.map(teacherName).join(", ");
              return (
                <li key={`${conflict.code}-${index}`} className="rounded-md border bg-card p-2">
                  {conflict.code === STAFF_TEACHER_CAPACITY_ZERO && names ? `${names}: ${sentence}` : sentence}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <p className="text-xs text-muted-foreground">{t("unchanged")}</p>
      {children}
    </div>
  );
}
