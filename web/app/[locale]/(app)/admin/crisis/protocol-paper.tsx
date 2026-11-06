"use client";

import { useLocale, useTranslations } from "next-intl";
import { unlistedPupils, withoutProtected } from "@/lib/crisis-protocol";
import type { ProtocolView } from "@/lib/crisis-types";
import { clock, groupLabel } from "@/lib/crisis-view";

/*
 * The protocol on paper: A4, one flow of text and tables, in the browser's
 * print (and so, saved from the print dialog, a PDF). It is on the page only
 * between a press on "Skriv ut" and the end of the printing, drawn from the
 * protocol WITHOUT the pupils the school has marked as having a protected
 * identity (lib/crisis-protocol.ts withoutProtected): no row of theirs, no
 * mark that names them, and a line at the end that says how many were counted
 * without a name. The screen's own view of the protocol is print:hidden, so a
 * print that did not start from the button (Ctrl+P) is a page that says where
 * the button is, and not the same protocol with the names in it.
 *
 * The group of pupils on no lesson is said in the reader's language, with the
 * lesson times it has none of left out; and the timeline has a column
 * "Anmärkning" when a teacher found a pupil who stands on another list, which
 * says "Hittad hos <the teacher's group>".
 */

export function ProtocolPaper({
  view,
  held,
  school,
  timeZone,
}: {
  view: ProtocolView;
  held: ReadonlySet<string>;
  school: string | null;
  timeZone: string | undefined;
}) {
  const t = useTranslations("crisis");
  const locale = useLocale();
  const { calls, marks, heldOut } = withoutProtected(view, held);
  const { alarm } = view;
  const stamp = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", { dateStyle: "medium", timeStyle: "medium", ...(timeZone ? { timeZone } : {}) });
  const nameOf = new Map(calls.flatMap((call) => call.pupils.map((pupil) => [pupil.studentId, `${pupil.firstName} ${pupil.lastName}`.trim()] as const)));
  const noLesson = t("noLesson.group");
  const unlisted = unlistedPupils(calls);
  const showFoundIn = marks.some((mark) => mark.foundIn !== null);
  return (
    <article className="hidden space-y-4 text-sm print:block" aria-label={t("protocol.paperLabel")}>
      <header className="space-y-1">
        {school ? <p className="text-xs">{school}</p> : null}
        <h1 className="text-xl font-semibold">
          {t("protocol.paperTitle")}: {t(`mode.${alarm.mode}`)} · {t(`kind.${alarm.kind}`)}
        </h1>
        <p>
          {t("protocol.paperStarted", { time: stamp.format(new Date(alarm.startedAt)), by: alarm.startedBy ?? "—" })}
          {alarm.endedAt ? ` · ${t("protocol.paperEnded", { time: stamp.format(new Date(alarm.endedAt)), by: alarm.endedBy ?? "—" })}` : ""}
        </p>
        {alarm.autoEnded ? <p>{t("live.autoEnded")}</p> : null}
        {alarm.endNote ? <p>{t("live.note", { note: alarm.endNote })}</p> : null}
        <p>
          {t("protocol.paperFigures", {
            groupsDone: alarm.callsComplete,
            groups: alarm.calls,
            found: alarm.counts.found,
            missing: alarm.counts.missing,
            unreported: alarm.counts.unreported,
            absentBefore: alarm.counts.absentBefore,
            teachersAnswered: alarm.teachersAnswered,
            teachers: alarm.teachers,
          })}
        </p>
        {heldOut > 0 ? <p className="font-medium">{t("protocol.heldOutPaper", { count: heldOut })}</p> : null}
      </header>

      {calls.map((call) => (
        <section key={call.id} className="break-inside-avoid space-y-1" aria-label={groupLabel(call, noLesson)}>
          <h2 className="text-base font-semibold">
            {call.basis === "NO_LESSON" ? (
              groupLabel(call, noLesson)
            ) : (
              <>
                {call.groupName} · {call.subjectName}
                {call.roomName ? ` · ${call.roomName}` : ""} · {clock(call.lessonStartsAt, locale, timeZone)}–{clock(call.lessonEndsAt, locale, timeZone)}
                {call.basis === "NEXT_LESSON" ? ` · ${t("live.nextLesson")}` : ""}
              </>
            )}
          </h2>
          <p>
            {call.uncovered
              ? t("live.noTeacher")
              : call.teachers
                  .map((teacher) =>
                    `${teacher.name ?? "—"} (${teacher.answeredAt ? t("live.answeredAt", { time: clock(teacher.answeredAt, locale, timeZone) }) : t("live.notAnswered")})`,
                  )
                  .join(" · ")}
          </p>
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b">
                <th scope="col" className="py-0.5 pr-3">{t("protocol.colPupil")}</th>
                <th scope="col" className="py-0.5 pr-3">{t("live.colStatus")}</th>
                <th scope="col" className="py-0.5 pr-3">{t("protocol.colMarked")}</th>
                <th scope="col" className="py-0.5">{t("protocol.colBy")}</th>
              </tr>
            </thead>
            <tbody>
              {call.pupils.map((pupil) => (
                <tr key={pupil.studentId} className="border-b">
                  <td className="py-0.5 pr-3">{nameOf.get(pupil.studentId)}</td>
                  <td className="py-0.5 pr-3">{t(`status.${pupil.status}`)}</td>
                  <td className="py-0.5 pr-3">{pupil.markedAt ? clock(pupil.markedAt, locale, timeZone) : "—"}</td>
                  <td className="py-0.5">{pupil.markedBy ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <section className="space-y-1" aria-label={t("protocol.timeline")}>
        <h2 className="text-base font-semibold">{t("protocol.timeline")}</h2>
        {marks.length === 0 ? (
          <p>{t("protocol.timelineEmpty")}</p>
        ) : (
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b">
                <th scope="col" className="py-0.5 pr-3">{t("protocol.colTime")}</th>
                <th scope="col" className="py-0.5 pr-3">{t("live.colGroup")}</th>
                <th scope="col" className="py-0.5 pr-3">{t("protocol.colPupil")}</th>
                <th scope="col" className="py-0.5 pr-3">{t("protocol.colMark")}</th>
                {showFoundIn ? <th scope="col" className="py-0.5 pr-3">{t("protocol.colNote")}</th> : null}
                <th scope="col" className="py-0.5">{t("protocol.colBy")}</th>
              </tr>
            </thead>
            <tbody>
              {marks.map((mark, index) => (
                <tr key={`${mark.studentId}-${mark.at}-${index}`} className="break-inside-avoid border-b">
                  <td className="py-0.5 pr-3 tabular-nums">{stamp.format(new Date(mark.at))}</td>
                  <td className="py-0.5 pr-3">{unlisted.has(mark.studentId) ? noLesson : mark.groupName}</td>
                  <td className="py-0.5 pr-3">{nameOf.get(mark.studentId) ?? "—"}</td>
                  <td className="py-0.5 pr-3">{t(`status.${mark.state}`)}</td>
                  {showFoundIn ? (
                    <td className="py-0.5 pr-3">{mark.foundIn ? t("protocol.foundIn", { group: groupLabel(mark.foundIn, noLesson) }) : "—"}</td>
                  ) : null}
                  <td className="py-0.5">
                    {mark.by ?? "—"}
                    {mark.onBehalf ? ` (${t("protocol.onBehalf")})` : ""}
                    {mark.late ? ` (${t("protocol.late")})` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </article>
  );
}
