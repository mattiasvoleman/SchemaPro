"use client";

// /teacher/crisis — Larm, the teacher's side of Krisläge: when the school
// starts an alarm (utrymning or inrymning, skarpt or övning) the groups the
// teacher answers for are listed here, taken from the schedule at the moment
// it started, and the teacher says for each pupil "Finns" or "Saknas". A pupil
// who was absent before the alarm needs no mark ("Frånvarande sedan tidigare").
// In a break the list is of the lesson the pupils are on their way to, said so
// on the group. The administration sees every mark as it is made.
//
// A teacher who meets a pupil who is on none of their lists says so with
// "Hittat en elev som inte står på listan" (components/crisis/find-other.tsx):
// the pupil is marked FOUND on one of the teacher's groups and listed under
// that group as "Hittade hos dig", waiting like the other marks until the
// gateway has taken it. Only FOUND: the gateway refuses MISSING for a pupil
// who is not on the group's list, so nothing here offers it.
//
// A BAD NETWORK IS THE CASE THIS PAGE IS DESIGNED FOR (lib/crisis-queue.ts):
// the last list is kept on the device and shown again when the signal is gone
// ("Listan hämtades kl 10:32"), and a mark is kept as "Väntar på att skickas"
// until the gateway has answered it, then sent when the network is back, the
// page is looked at again, and on a timer. Nothing here is React.lazy: a chunk
// that has not been fetched is a chunk that cannot be fetched when the page
// needs it most, so the page is one piece. The tap targets are 44 px, and the
// counters are a live region.
//
// Bundle: core tier (170 KB).

import { useTranslations, useLocale } from "next-intl";
import { ClipboardCheck, WifiOff } from "lucide-react";
import { FindOther } from "@/components/crisis/find-other";
import { PupilRow } from "@/components/crisis/pupil-row";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { useProfile } from "@/components/profile-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadFailed } from "@/components/crisis/load-failed";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { pendingKey, type Dropped } from "@/lib/crisis-queue";
import { useMyCrisis } from "@/lib/crisis-mine";
import type { FoundHereView, MyAlarm, MyCall, PupilCounts, PupilView } from "@/lib/crisis-types";
import { clock, countPupils, isOpen, unmarkedPupils } from "@/lib/crisis-view";
import { useCrisisRealtime } from "@/lib/use-crisis-realtime";

const sum = (calls: readonly MyCall[]): PupilCounts => {
  const total = countPupils([]);
  for (const call of calls) {
    total.pupils += call.counts.pupils;
    total.found += call.counts.found;
    total.missing += call.counts.missing;
    total.absentBefore += call.counts.absentBefore;
    total.unreported += call.counts.unreported;
  }
  return total;
};

/** A pupil found with the teacher, as a row: found, and by whom is theirs to know. */
const foundRow = (one: FoundHereView): PupilView => ({
  studentId: one.studentId,
  firstName: one.firstName,
  lastName: one.lastName,
  status: "FOUND",
  priorAbsentSource: null,
  markedAt: one.markedAt,
  markedBy: null,
});

/** The four figures of a set of pupils, in words; never colour alone. */
function Counts({ counts, live = false }: { counts: PupilCounts; live?: boolean }) {
  const t = useTranslations("crisis");
  const items = [
    ["found", counts.found],
    ["missing", counts.missing],
    ["unreported", counts.unreported],
    ["absentBefore", counts.absentBefore],
  ] as const;
  return (
    // The live region is a wrapper of the list, not the list: a list that is given a role is no list for its items.
    <div role={live ? "status" : undefined} aria-live={live ? "polite" : undefined} aria-atomic={live ? true : undefined}>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {items.map(([key, value]) => (
          <li key={key}>
            <span className="tabular-nums font-semibold">{value}</span> <span className="text-muted-foreground">{t(`count.${key}`)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CallCard({
  call,
  pending,
  open,
  timeZone,
  onMark,
}: {
  call: MyCall;
  pending: ReadonlySet<string>;
  /** The alarm is going: the pupils can be marked. */
  open: boolean;
  timeZone: string | undefined;
  onMark: (callId: string, studentIds: readonly string[], state: "FOUND" | "MISSING") => void;
}) {
  const t = useTranslations("crisis");
  const locale = useLocale();
  const unmarked = unmarkedPupils(call.pupils);
  const rest = call.counts.missing > 0;
  return (
    <section aria-labelledby={`call-${call.id}`} className="space-y-3 rounded-lg border bg-card p-4">
      <div className="space-y-1">
        <h3 id={`call-${call.id}`} className="text-lg font-semibold">
          {call.groupName}
        </h3>
        <p className="text-sm text-muted-foreground">
          {[call.subjectName, call.roomName, `${clock(call.lessonStartsAt, locale, timeZone)}–${clock(call.lessonEndsAt, locale, timeZone)}`]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {call.basis === "NEXT_LESSON" ? (
          <Badge variant="warning">{t("teacher.nextLesson", { time: clock(call.lessonStartsAt, locale, timeZone) })}</Badge>
        ) : null}
        {call.colleagues.length > 0 ? (
          <p className="text-sm text-muted-foreground">{t("teacher.colleagues", { names: call.colleagues.join(", ") })}</p>
        ) : null}
      </div>
      <Counts counts={call.counts} />
      {open && unmarked.length > 0 ? (
        <Button
          type="button"
          size="lg"
          className="h-11 w-full text-base sm:w-auto"
          onClick={() => onMark(call.id, unmarked, "FOUND")}
        >
          {rest ? t("teacher.restFound", { count: unmarked.length }) : t("teacher.allFound", { count: unmarked.length })}
        </Button>
      ) : null}
      {call.pupils.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("teacher.noPupils")}</p>
      ) : (
        <ul className="divide-y rounded-md border" aria-label={t("teacher.pupilsOf", { group: call.groupName })}>
          {call.pupils.map((pupil) => (
            <PupilRow
              key={pupil.studentId}
              large
              pupil={pupil}
              pending={pending.has(pendingKey(call.id, pupil.studentId))}
              {...(open ? { onMark: (state) => onMark(call.id, [pupil.studentId], state) } : {})}
            />
          ))}
        </ul>
      )}
      {(call.foundHere ?? []).length > 0 ? (
        <div className="space-y-2">
          <h4 id={`found-${call.id}`} className="text-sm font-semibold">
            {t("teacher.foundHereTitle")}
          </h4>
          <ul className="divide-y rounded-md border" aria-labelledby={`found-${call.id}`}>
            {call.foundHere.map((one) => (
              <PupilRow
                key={one.studentId}
                large
                pupil={foundRow(one)}
                {...(one.className ? { detail: one.className } : {})}
                pending={pending.has(pendingKey(call.id, one.studentId))}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function AlarmSection({
  alarm,
  pending,
  timeZone,
  onMark,
}: {
  alarm: MyAlarm;
  pending: ReadonlySet<string>;
  timeZone: string | undefined;
  onMark: (callId: string, studentIds: readonly string[], state: "FOUND" | "MISSING") => void;
}) {
  const t = useTranslations("crisis");
  const locale = useLocale();
  const open = isOpen(alarm);
  const live = alarm.mode === "LIVE";
  return (
    <section aria-labelledby={`alarm-${alarm.id}`} className="space-y-3">
      <div className="space-y-2 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={live ? "destructive" : "warning"} className="text-sm">
            {t(`mode.${alarm.mode}`)}
          </Badge>
          <h2 id={`alarm-${alarm.id}`} className="text-xl font-semibold">
            {t(`kind.${alarm.kind}`)}
            {open ? "" : ` · ${t("teacher.over")}`}
          </h2>
        </div>
        <p className="text-sm text-muted-foreground">
          {open
            ? t("teacher.startedAt", { time: clock(alarm.startedAt, locale, timeZone) })
            : t("teacher.endedAt", { time: clock(alarm.endedAt!, locale, timeZone) })}
        </p>
        <p className="text-sm">{open ? t("teacher.do") : t("teacher.overBody")}</p>
        <Counts counts={sum(alarm.calls)} live={open} />
      </div>
      {alarm.calls.length === 0 ? (
        <Notice tone="neutral">{t("teacher.noGroups")}</Notice>
      ) : (
        alarm.calls.map((call) => (
          <CallCard key={call.id} call={call} pending={pending} open={open} timeZone={timeZone} onMark={onMark} />
        ))
      )}
      {/* Nothing to attach a found pupil to without a group of one's own; and nobody to find when every pupil is on a list. */}
      {open && alarm.calls.length > 0 && (alarm.others ?? []).length > 0 ? (
        <FindOther alarm={alarm} onFound={(callId, studentId) => onMark(callId, [studentId], "FOUND")} />
      ) : null}
    </section>
  );
}

/** The marks that could not be kept, by what the gateway said, each with the groups it was about. */
function DroppedNotice({
  dropped,
  groupOf,
  onDismiss,
}: {
  dropped: readonly Dropped[];
  groupOf: (callId: string) => string | undefined;
  onDismiss: () => void;
}) {
  const t = useTranslations("crisis");
  const lookup = (key: string) => (t.has(`errors.${key}`) ? t(`errors.${key}`) : t("errors.OTHER"));
  const codes = [...new Set(dropped.map((one) => one.code))];
  return (
    <Notice tone="destructive" title={t("teacher.droppedTitle", { count: dropped.length })} onDismiss={onDismiss} dismissLabel={t("teacher.droppedDismiss")}>
      <ul className="list-disc space-y-1 pl-5">
        {codes.map((code) => {
          const groups = [...new Set(dropped.filter((one) => one.code === code).map((one) => groupOf(one.mark.callId)).filter(Boolean))];
          return (
            <li key={code}>
              {lookup(code)}
              {groups.length > 0 ? ` (${groups.join(", ")})` : ""}
            </li>
          );
        })}
      </ul>
    </Notice>
  );
}

export default function TeacherCrisisPage() {
  const t = useTranslations("crisis");
  const locale = useLocale();
  const { school, profile } = useProfile();
  const timeZone = school?.timezone;
  useCrisisRealtime();
  // The queue and the list kept on this device are this login's (lib/crisis-queue.ts).
  const my = useMyCrisis(profile.id);

  const alarms = [...(my.data?.alarms ?? [])].sort(
    (a, b) => Number(isOpen(b)) - Number(isOpen(a)) || Date.parse(b.startedAt) - Date.parse(a.startedAt),
  );
  const groupOf = (callId: string) => alarms.flatMap((alarm) => alarm.calls).find((call) => call.id === callId)?.groupName;
  const asOf = my.asOf ? clock(my.asOf, locale, timeZone) : null;
  // Either the gateway did not answer this time or the list is the one the device kept: the clock says how old it is.
  const old = my.offline || my.fromCache;

  return (
    <Page width="narrow">
      <PageHeader title={t("teacher.title")} subtitle={t("teacher.subtitle")} />

      {old && asOf ? (
        <Notice
          tone="warning"
          role="status"
          hideIcon
          title={
            <span className="flex items-center gap-2">
              <WifiOff className="size-4 shrink-0" aria-hidden="true" />
              {t("teacher.noContact")}
            </span>
          }
          action={
            <Button type="button" variant="outline" size="sm" onClick={my.refetch}>
              {t("teacher.tryAgain")}
            </Button>
          }
        >
          {t("teacher.asOf", { time: asOf })} {t("teacher.keptHere")}
        </Notice>
      ) : null}

      {my.queued > 0 ? (
        <Notice tone="neutral" role="status">
          {my.sending ? t("teacher.sending", { count: my.queued }) : t("teacher.queued", { count: my.queued })}
        </Notice>
      ) : null}

      {my.dropped.length > 0 ? <DroppedNotice dropped={my.dropped} groupOf={groupOf} onDismiss={my.clearDropped} /> : null}

      {my.loading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : my.data === null ? (
        <LoadFailed
          title={t("teacher.loadFailed")}
          hint={t("teacher.loadFailedHint")}
          headingLevel={2}
          action={
            <Button type="button" variant="outline" onClick={my.refetch}>
              {t("teacher.tryAgain")}
            </Button>
          }
        />
      ) : alarms.length === 0 ? (
        <EmptyState icon={ClipboardCheck} headingLevel={2} title={t("teacher.noAlarm")} description={t("teacher.noAlarmBody")} />
      ) : (
        alarms.map((alarm) => (
          <AlarmSection key={alarm.id} alarm={alarm} pending={my.pending} timeZone={timeZone} onMark={my.mark} />
        ))
      )}
    </Page>
  );
}
