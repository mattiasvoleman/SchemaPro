"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import {
  useRoomPreferenceActions,
  useRoomPreferences,
  useRooms,
  useRoomTypes,
  useSubjects,
} from "@/lib/queries";
import { Button } from "@/components/ui/button";
import type { RoomRuleKind } from "@/lib/types";
import type { RoomPreference } from "@/lib/queries";
import { Badge } from "@/components/ui/badge";
import {
  STRENGTH_DEFAULT,
  STRENGTH_STEP,
  clampStrength,
  strengthBand,
  strengthBounds,
} from "@/lib/preference-strength";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import { LoadError } from "@/components/ui/load-error";
import { RowActions } from "@/components/ui/row-actions";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { GradeSpanField } from "@/components/ui/grade-span-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const BY_TYPE = "type";
const BY_ROOMS = "rooms";

/**
 * Room rules — one card per kind, and the separation is the whole design.
 *
 * A WISH that cannot be honoured costs the optimizer points and produces a
 * timetable anyway; a LOCK that cannot be honoured refuses the week. Presenting
 * them as one list would invite a school to state wishes it believes are
 * promises — which is the argument this card already made for keeping itself
 * apart from the unavailability rules above it, applied one level down.
 *
 * ONE COMPONENT, MOUNTED TWICE, rather than two files. Everything except the
 * words and the strength slider is identical, and a copy would be the version
 * that stops matching the first time the room picker changes. Mounted twice
 * on one page, so every id it writes carries the kind: two open forms must
 * not hand two labels the same control.
 */
export function RoomPreferencesCard({ kind = "WISH" }: { kind?: RoomRuleKind }) {
  const isLock = kind === "LOCK";
  const idOf = (field: string) => `${isLock ? "lock" : "wish"}-${field}`;
  const t = useTranslations("constraints");
  const tCommon = useTranslations("common");
  const {
    data: preferences,
    isLoading: preferencesLoading,
    isError: preferencesFailed,
  } = useRoomPreferences();
  const { data: subjects } = useSubjects();
  const { data: rooms } = useRooms();
  const { data: roomTypes } = useRoomTypes();
  const actions = useRoomPreferenceActions();

  const [adding, setAdding] = useState(false);
  const [subjectId, setSubjectId] = useState("");
  const [target, setTarget] = useState<typeof BY_TYPE | typeof BY_ROOMS>(BY_TYPE);
  const [roomTypeId, setRoomTypeId] = useState("");
  const [roomIds, setRoomIds] = useState<string[]>([]);
  const [weight, setWeight] = useState(STRENGTH_DEFAULT);
  const [span, setSpan] = useState<{ min: number | null; max: number | null }>({
    min: null,
    max: null,
  });
  const [deleting, setDeleting] = useState<RoomPreference | null>(null);

  const subjectName = useMemo(
    () => new Map((subjects ?? []).map((subject) => [subject.id, subject.name])),
    [subjects],
  );
  const roomName = useMemo(
    () => new Map((rooms ?? []).map((room) => [room.id, room.name])),
    [rooms],
  );
  const typeName = useMemo(
    () => new Map((roomTypes ?? []).map((type) => [type.id, type.name])),
    [roomTypes],
  );

  // Bounds follow the value: a rule saved above the usual band still shows,
  // rather than being dragged down the moment the form opens.
  const bounds = strengthBounds(weight);

  const reset = () => {
    setAdding(false);
    setSubjectId("");
    setTarget(BY_TYPE);
    setRoomTypeId("");
    setRoomIds([]);
    setWeight(STRENGTH_DEFAULT);
    setSpan({ min: null, max: null });
  };

  const submit = async () => {
    try {
      await actions.create.mutateAsync({
        subjectId,
        // Exactly one target: the API refuses both and neither, and the form
        // must not be the place where that becomes a 400 the admin has to
        // decode.
        ...(target === BY_TYPE ? { roomTypeId } : { roomIds }),
        kind,
        // Both or neither; the API and the database both refuse half a span.
        minGradeLevel: span.min,
        maxGradeLevel: span.max,
        // A lock never reaches the objective, so the number it carries is the
        // column default and means nothing. Sending the slider's value anyway
        // would put a strength on a rule that has none.
        ...(isLock ? {} : { weight: clampStrength(weight) }),
      });
      toast.success(tCommon("created"));
      reset();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  /** Only this card's own kind. A row written as the other belongs elsewhere. */
  const rules = useMemo(
    () => (preferences ?? []).filter((preference) => preference.kind === kind),
    [preferences, kind],
  );

  /** "Åk 4" or "Åk 4–6", and nothing at all when the rule has no span. */
  const gradeBadge = (rule: { minGradeLevel: number | null; maxGradeLevel: number | null }) => {
    if (rule.minGradeLevel === null || rule.maxGradeLevel === null) return null;
    return rule.minGradeLevel === rule.maxGradeLevel
      ? t("ruleGradeBadgeOne", { min: rule.minGradeLevel })
      : t("ruleGradeBadge", { min: rule.minGradeLevel, max: rule.maxGradeLevel });
  };

  const canSubmit =
    subjectId !== "" && (target === BY_TYPE ? roomTypeId !== "" : roomIds.length > 0);

  const describe = (preference: {
    roomTypeId: string | null;
    rooms: { roomId: string }[];
  }) =>
    preference.roomTypeId
      ? (typeName.get(preference.roomTypeId) ?? "—")
      : preference.rooms
          .map((entry) => roomName.get(entry.roomId) ?? "—")
          .join(", ");

  /** The rule as a sentence: the list's line, and the name its delete button and confirm carry. */
  const summary = (preference: RoomPreference) =>
    t(isLock ? "lockSummary" : "preferenceSummary", {
      subject: subjectName.get(preference.subjectId) ?? "—",
      rooms: describe(preference),
    });

  /**
   * Behind a confirm, and loud when it fails. The bin used to delete on the
   * click and drop the promise, so a refused delete left the row standing with
   * nothing said, and a slip of the pointer removed a lock nobody meant to.
   */
  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await actions.remove.mutateAsync(deleting.id);
      toast.success(tCommon("deleted"));
      setDeleting(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  return (
    <SectionCard
      id={isLock ? "salslasningar" : "salsonskemal"}
      title={t(isLock ? "locksTitle" : "preferencesTitle")}
      description={t(isLock ? "locksHint" : "preferencesHint")}
      action={
        !adding ? (
          <Button data-writes="PLANERING" variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            {t(isLock ? "addLock" : "addPreference")}
          </Button>
        ) : null
      }
    >
      {adding ? (
        <div className="space-y-3 rounded-md border p-3">
          <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            <FormField id={idOf("subject")} label={t("preferenceSubject")}>
              {(control) => (
                <Select value={subjectId} onValueChange={setSubjectId}>
                  <SelectTrigger {...control}>
                    <SelectValue placeholder={tCommon("select")} />
                  </SelectTrigger>
                  <SelectContent>
                    {(subjects ?? []).map((subject) => (
                      <SelectItem key={subject.id} value={subject.id}>
                        {subject.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>

            <FormField id={idOf("target")} label={t("preferenceTarget")}>
              {(control) => (
                <Select
                  value={target}
                  onValueChange={(value) => setTarget(value as typeof BY_TYPE)}
                >
                  <SelectTrigger {...control}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={BY_TYPE}>{t("preferenceByType")}</SelectItem>
                    <SelectItem value={BY_ROOMS}>{t("preferenceByRooms")}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>
          </div>

          {target === BY_TYPE ? (
            <FormField id={idOf("type")} label={t("preferenceRoomType")}>
              {(control) => (
                <Select value={roomTypeId} onValueChange={setRoomTypeId}>
                  <SelectTrigger {...control}>
                    <SelectValue placeholder={tCommon("select")} />
                  </SelectTrigger>
                  <SelectContent>
                    {(roomTypes ?? []).map((type) => (
                      <SelectItem key={type.id} value={type.id}>
                        {type.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
          ) : (
            /* A group of checkboxes, so its name is a legend: a Label with no
               control behind it named nothing. */
            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium leading-none">{t("preferenceRooms")}</legend>
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
                {(rooms ?? []).map((room) => (
                  <label
                    key={room.id}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={roomIds.includes(room.id)}
                      onChange={() =>
                        setRoomIds((prev) =>
                          prev.includes(room.id)
                            ? prev.filter((id) => id !== room.id)
                            : [...prev, room.id],
                        )
                      }
                    />
                    {room.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <GradeSpanField
            label={t("ruleGrades")}
            min={span.min}
            max={span.max}
            onChange={setSpan}
            allowAll
            hint={t("ruleGradesHint")}
          />

          {/* A lock has no strength: it is a bound, and no number can buy its
              way past one. Showing the slider would offer a choice that does
              nothing. */}
          {isLock ? null : (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor={idOf("weight")}>{t("preferenceWeight")}</Label>
              <span className="text-xs text-muted-foreground">
                {t(`strength.${strengthBand(weight)}`)}{" "}
                <span className="tabular-nums">({weight})</span>
              </span>
            </div>
            <input
              id={idOf("weight")}
              type="range"
              min={bounds.min}
              max={bounds.max}
              step={STRENGTH_STEP}
              // Without this a screen reader announces "50", which is exactly
              // the number that means nothing on its own — the word beside the
              // slider is visual only and never reaches it.
              aria-valuetext={`${t(`strength.${strengthBand(weight)}`)} (${weight})`}
              aria-describedby={idOf("weight-hint")}
              value={weight}
              onChange={(event) => setWeight(clampStrength(Number(event.target.value)))}
              className="w-full accent-primary"
            />
            <p id={idOf("weight-hint")} className="text-xs text-muted-foreground">
              {t("preferenceWeightHint")}
            </p>
          </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={reset}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={submit} disabled={!canSubmit || actions.create.isPending}>
              {actions.create.isPending ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden="true" />
                  {tCommon("saving")}
                </>
              ) : (
                tCommon("save")
              )}
            </Button>
          </div>
        </div>
      ) : null}

      {/*
        Loading, failed, empty and listed are four different answers. Before,
        the list read `data ?? []`, so a request in flight and one that had
        failed both said "no locks" — a claim a school acts on.
      */}
      {preferencesFailed && preferences !== undefined ? (
        // A failed refetch keeps the rules as last read, with this above them.
        <LoadError
          variant="inline"
          title={t("roomRulesLoadFailed")}
          hint={tCommon("refetchFailedHint")}
        />
      ) : null}
      {preferencesLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : preferencesFailed && preferences === undefined ? (
        <LoadError
          variant="inline"
          title={t("roomRulesLoadFailed")}
          hint={t("roomRulesLoadFailedHint")}
        />
      ) : rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t(isLock ? "locksEmpty" : "preferencesEmpty")}
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {rules.map((preference) => (
            <li
              key={preference.id}
              className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
            >
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                {summary(preference)}
                {gradeBadge(preference) ? (
                  <Badge variant="secondary">{gradeBadge(preference)}</Badge>
                ) : null}
                {/* A lock has no strength. Showing the column default beside it
                    would read as a number the admin chose. */}
                {isLock ? null : (
                  <Badge variant="outline">
                    {t("preferenceWeightBadge", { weight: preference.weight })}
                  </Badge>
                )}
              </span>
              {/* room-preferences.controller.ts @Area: RowActions takes no attribute. */}
              <div data-writes="PLANERING" className="contents">
                <RowActions
                  name={summary(preference)}
                  actions={[
                    { label: tCommon("delete"), icon: Trash2, onSelect: () => setDeleting(preference) },
                  ]}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t(isLock ? "deleteLockTitle" : "deletePreferenceTitle")}
        description={
          deleting
            ? t(isLock ? "deleteLockBody" : "deletePreferenceBody", { rule: summary(deleting) })
            : undefined
        }
        confirmLabel={tCommon("delete")}
        loading={actions.remove.isPending}
        onConfirm={confirmDelete}
      />
    </SectionCard>
  );
}
