"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { apiErrorText } from "@/lib/api-error-text";
import {
  bricksOf,
  brickKey,
  brickSubject,
  fetchTray,
  headFigures,
  layBodyOf,
  layBrick,
  layFailureOf,
  type LayFailure,
  type TrayBrick,
} from "@/lib/board-tray";
import { askPossibleTimes, askRoomChoices, clockOf, costWords, type PossibleOption, type PossibleTimes, type RoomChoice } from "@/lib/possible-times";
import { roomWords } from "@/lib/room-words";
import { cn } from "@/lib/utils";

/*
 * ATT LÄGGA (E4): the grundschema's tray on the board's page.
 *
 * One BRICK for each lesson a timplanspost has left, counted as Generera counts it (GET /api/v1/board-tray), the hardest first as the gateway
 * orders them. A brick is laid where the schemaläggare puts it, in a room the gateway's own chooser ranks first by default, and becomes a LOCKED
 * lesson at once: it stands in the schedule, in the versions and in what is published, and Generera keeps it. The head says how many of the
 * lessons the year's posts ask for are laid.
 *
 * Nothing here decides anything: the gateway counts the bricks, ranks the times and the rooms, and judges the lay as it judges a hand edit.
 * This says what it answered, and offers the way on when the answer is a no that has one (another room, no room, "Lägg ändå").
 *
 * Two pieces of one module, fetched as one chunk when the page has mounted for a writer: TrayHead (the button and the figure, in the board's
 * own toolbar) and TrayPanel (the region under it, open when the button says so).
 */

const TRAY_KEY = "boardTray";

/** The year's tray, read again when the lessons of the grundschema are (`revision`: when the page last read them). */
function useTray(yearId: string, revision: number) {
  return useQuery({ queryKey: [TRAY_KEY, yearId, revision], queryFn: () => fetchTray(yearId), staleTime: 30_000 });
}

export function TrayHead({
  yearId,
  revision,
  open,
  onToggle,
}: {
  yearId: string;
  revision: number;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations("boardTray");
  const { data: tray } = useTray(yearId, revision);
  const figures = tray ? headFigures(tray.tally) : null;
  return (
    <>
      <Button size="sm" variant={open ? "default" : "outline"} aria-expanded={open} aria-controls="board-tray" onClick={onToggle}>
        <Inbox />
        {t("button")}
        {tray ? (
          <Badge variant="secondary" className="ml-1 tabular-nums">
            {tray.tally.left}
          </Badge>
        ) : null}
      </Button>
      {figures ? (
        <span className="text-sm tabular-nums text-muted-foreground">
          {figures.placedByRow > 0
            ? t("headPlaced", { laid: figures.laid, of: figures.of, placed: figures.placedByRow })
            : t("head", { laid: figures.laid, of: figures.of })}
        </span>
      ) : null}
    </>
  );
}

/** What the page knows by id, so that the tray names a class, a subject and a teacher: no person's name ever leaves the gateway for it. */
interface TrayNames {
  group: (id: string) => string;
  subject: (id: string) => string;
  teacher: (id: string) => string | null;
}

export function TrayPanel({
  yearId,
  revision,
  groupById,
  subjectById,
  teacherById,
  writable,
  onClose,
}: {
  yearId: string;
  revision: number;
  groupById: ReadonlyMap<string, { name: string }>;
  subjectById: ReadonlyMap<string, { name: string }>;
  teacherById: ReadonlyMap<string, { firstName: string; lastName: string }>;
  /** Whether this reader may lay a brick: a reader of the grundschema sees the tray and no button. */
  writable: boolean;
  onClose: () => void;
}) {
  const names: TrayNames = {
    group: (id) => groupById.get(id)?.name ?? "",
    subject: (id) => subjectById.get(id)?.name ?? "",
    teacher: (id) => {
      const person = teacherById.get(id);
      return person ? `${person.firstName} ${person.lastName}` : null;
    },
  };
  const t = useTranslations("boardTray");
  const { data: tray, isLoading, isError, refetch } = useTray(yearId, revision);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [laying, setLaying] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // The class a reader picked that has no brick left any more (the last one was laid) is the whole year again.
  const chosen = tray && groupId !== null && tray.groups.some((group) => group.studentGroupId === groupId && group.left > 0) ? groupId : null;
  const bricks = tray ? bricksOf(tray, chosen) : [];

  return (
    <section id="board-tray" aria-labelledby="board-tray-title" className="mb-3 rounded-md border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="board-tray-title" ref={heading} tabIndex={-1} className="text-base font-semibold focus-visible:outline-2 focus-visible:outline-ring">
          {t("title")}
        </h2>
        {tray ? (
          <label className="ml-2 inline-flex items-center gap-2">
            <span className="text-muted-foreground">{t("classLabel")}</span>
            <NativeSelect className="h-8 w-auto" value={chosen ?? ""} onChange={(event) => setGroupId(event.target.value === "" ? null : event.target.value)}>
              <option value="">{t("allClasses", { count: tray.tally.left })}</option>
              {tray.groups
                .filter((group) => group.left > 0)
                .map((group) => ({ group, name: names.group(group.studentGroupId) }))
                .sort((a, b) => a.name.localeCompare(b.name, "sv"))
                .map(({ group, name }) => (
                  <option key={group.studentGroupId} value={group.studentGroupId}>
                    {t("classOption", { name, count: group.left })}
                  </option>
                ))}
            </NativeSelect>
          </label>
        ) : null}
        <Button size="icon" variant="ghost" className="ml-auto size-9" aria-label={t("close")} onClick={onClose}>
          <X />
        </Button>
      </div>
      <p className="mt-1 text-muted-foreground">{t("hint")}</p>

      {isLoading ? <p className="mt-2 text-muted-foreground">{t("loading")}</p> : null}
      {isError || (!isLoading && !tray) ? (
        <Notice tone="warning" action={<Button size="sm" variant="outline" onClick={() => void refetch()}>{t("retry")}</Button>}>
          {t("failed")}
        </Notice>
      ) : null}
      {tray && bricks.length === 0 ? <p className="mt-2 font-medium">{chosen === null ? t("empty") : t("emptyClass")}</p> : null}
      {tray && bricks.length > 0 ? (
        <ul className="mt-2 grid max-h-96 gap-1 overflow-y-auto" aria-label={t("listLabel", { count: bricks.length })}>
          {bricks.map((brick) => {
            const key = brickKey(brick);
            const open = laying === key;
            return (
              <li key={key} className="rounded-md border">
                <BrickRow
                  brick={brick}
                  names={names}
                  writable={writable}
                  open={open}
                  onLay={() => setLaying(open ? null : key)}
                />
                {open ? (
                  <BrickForm
                    brick={brick}
                    yearId={yearId}
                    names={names}
                    onDone={() => {
                      setLaying(null);
                      heading.current?.focus();
                    }}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function BrickRow({
  brick,
  names,
  writable,
  open,
  onLay,
}: {
  brick: TrayBrick;
  names: TrayNames;
  writable: boolean;
  open: boolean;
  onLay: () => void;
}) {
  const t = useTranslations("boardTray");
  const lesson = t("brick", { subject: names.subject(brick.subjectId), className: names.group(brick.studentGroupId) });
  const teacher = brick.teacherId === null ? t("noTeacher") : (names.teacher(brick.teacherId) ?? t("noTeacher"));
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
      <div className="min-w-0 flex-1">
        <span className="font-medium">{lesson}</span>
        <span className="ml-2 text-xs text-muted-foreground">
          {t("detail", { teacher, minutes: brick.minutes })}, {t(`weeks.${brick.recurrence}`)}
        </span>
        {brick.lessonId !== null ? <Badge variant="outline" className="ml-2">{t("parked")}</Badge> : null}
        {brick.cannotPlace === "BLOCK" ? <Badge variant="outline" className="ml-2">{t("block")}</Badge> : null}
        {brick.cannotPlace === "NO_TEACHER" ? <Badge variant="outline" className="ml-2">{t("noTeacherBadge")}</Badge> : null}
        {brick.possibleTimes !== null ? (
          <span className="ml-2 text-xs tabular-nums text-muted-foreground">{t("possible", { count: brick.possibleTimes })}</span>
        ) : null}
      </div>
      {writable && brick.cannotPlace === null ? (
        <Button size="sm" variant="outline" className="min-h-11" aria-expanded={open} aria-label={t("layLabel", { lesson })} data-writes="SCHEMALAGGNING DRIFT" onClick={onLay}>
          {t("lay")}
        </Button>
      ) : null}
    </div>
  );
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const ROOM_DELAY_MS = 300;

/** The form under a brick: the gateway's best times, the day and the start, the room, and the answer when it says no. */
function BrickForm({ brick, yearId, names, onDone }: { brick: TrayBrick; yearId: string; names: TrayNames; onDone: () => void }) {
  const t = useTranslations("boardTray");
  const tPossible = useTranslations("boardPossible");
  const tDays = useTranslations("days");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const subject = brickSubject(brick, yearId);
  const [day, setDay] = useState("1");
  const [start, setStart] = useState("");
  const [roomId, setRoomId] = useState("");
  const [roomTouched, setRoomTouched] = useState(false);
  const [times, setTimes] = useState<PossibleTimes | null | undefined>(undefined);
  const [rooms, setRooms] = useState<{ key: string; rooms: RoomChoice[] | null } | null>(null);
  const [failure, setFailure] = useState<{ failure: LayFailure; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const lesson = t("brick", { subject: names.subject(brick.subjectId), className: names.group(brick.studentGroupId) });
  const clockOk = CLOCK.test(start);
  const roomKey = `${day}|${start}`;

  // The gateway's best times for the brick, asked once when the form opens.
  useEffect(() => {
    const asking = new AbortController();
    askPossibleTimes(subject, asking.signal).then(
      (answer) => {
        if (!asking.signal.aborted) setTimes(answer && Array.isArray(answer.options) && Array.isArray(answer.days) ? answer : null);
      },
      () => {
        if (!asking.signal.aborted) setTimes(null);
      },
    );
    return () => asking.abort();
    // The brick is the form's: a part read again is another form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brick.partKey, brick.lessonId]);

  // The rooms for the day and the start the fields say, in the order the gateway ranks them, after a moment.
  useEffect(() => {
    if (!clockOk) return;
    const asking = new AbortController();
    const timer = setTimeout(() => {
      askRoomChoices(subject, Number(day), start, asking.signal).then(
        (answer) => {
          if (asking.signal.aborted) return;
          const list = answer && Array.isArray(answer.rooms) ? answer.rooms : null;
          setRooms({ key: roomKey, rooms: list });
        },
        () => {
          if (!asking.signal.aborted) setRooms({ key: roomKey, rooms: null });
        },
      );
    }, ROOM_DELAY_MS);
    return () => {
      clearTimeout(timer);
      asking.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomKey, clockOk, brick.partKey, brick.lessonId]);

  const roomList = rooms?.key === roomKey ? rooms.rooms : null;
  // The room the generator would put the lesson in is the default, until the reader has chosen one themselves.
  const best = roomList?.find((room) => room.state === "FREE" && room.rank === 1)?.roomId ?? "";
  const shownRoom = roomTouched ? roomId : best;

  const choose = (option: PossibleOption) => {
    setDay(String(option.dayOfWeek));
    setStart(clockOf(option.startMinutes));
    setRoomTouched(false);
    setFailure(null);
  };

  const submit = async (override?: { roomId?: string | null; exempt?: ("FRAME" | "LUNCH")[] }) => {
    if (!clockOk || busy) return;
    setBusy(true);
    const room = override && "roomId" in override ? (override.roomId ?? null) : shownRoom === "" ? null : shownRoom;
    try {
      const answer = await layBrick(layBodyOf(brick, yearId, { dayOfWeek: Number(day), startTime: start, roomId: room, exempt: override?.exempt }));
      const where = { lesson, day: tDays(day), from: start, to: answer.lesson.endTime ?? "" };
      toast.success(answer.noRoom ? t("laidNoRoom", where) : t("laid", where));
      for (const key of [TRAY_KEY, "masterLessons", "calendarLessons", "teacherLessons"]) void queryClient.invalidateQueries({ queryKey: [key] });
      onDone();
    } catch (error) {
      const found = layFailureOf(error);
      if (found.kind === "STALE") {
        toast.error(t("errors.stale"));
        void queryClient.invalidateQueries({ queryKey: [TRAY_KEY] });
        onDone();
      } else {
        setFailure({ failure: found, text: found.kind === "OTHER" || found.kind === "REFUSED" ? apiErrorText(error, tCommon) : "" });
      }
    } finally {
      setBusy(false);
    }
  };

  const id = `tray-${brickKey(brick)}`;
  return (
    <form
      className="grid gap-3 border-t px-3 py-3"
      aria-label={t("formLabel", { lesson })}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div>
        <p className="font-medium">{t("timesTitle")}</p>
        {times === undefined ? <p className="text-muted-foreground">{tPossible("list.loading")}</p> : null}
        {times === null ? <p className="text-muted-foreground">{tPossible("dialog.failed")}</p> : null}
        {times && times.options.length === 0 ? <p className="text-muted-foreground">{t("timesNone", { lesson })}</p> : null}
        {times && times.options.length > 0 ? (
          <ol className="mt-1 grid gap-1 sm:grid-cols-2">
            {times.options.map((option) => {
              const words = costWords(option);
              const pressed = day === String(option.dayOfWeek) && start === clockOf(option.startMinutes);
              return (
                <li key={option.rank}>
                  <button
                    type="button"
                    aria-pressed={pressed}
                    onClick={() => choose(option)}
                    className={cn(
                      "grid min-h-11 w-full gap-0.5 rounded-md border px-3 py-1.5 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                      pressed && "border-primary bg-accent",
                    )}
                  >
                    <span className="font-medium tabular-nums">
                      {tPossible("list.option", { rank: option.rank, day: tDays(String(option.dayOfWeek)), from: clockOf(option.startMinutes), to: clockOf(option.endMinutes) })}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {words.length > 0 ? words.map((word) => tPossible(`list.words.${word}`)).join(", ") : tPossible("list.plain")}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <FormField id={`${id}-day`} label={t("day")}>
          <NativeSelect value={day} onChange={(event) => setDay(event.target.value)}>
            {[1, 2, 3, 4, 5].map((value) => (
              <option key={value} value={String(value)}>
                {tDays(String(value))}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField id={`${id}-start`} label={t("start")} hint={t("startHint")}>
          <Input value={start} inputMode="numeric" placeholder="08:00" autoComplete="off" onChange={(event) => setStart(event.target.value)} />
        </FormField>
        <FormField id={`${id}-room`} label={t("room")} hint={clockOk && !roomList ? t("roomsLoading") : undefined}>
          <NativeSelect
            value={shownRoom}
            onChange={(event) => {
              setRoomTouched(true);
              setRoomId(event.target.value);
            }}
          >
            <option value="">{t("noRoom")}</option>
            {(roomList ?? []).map((room) => (
              <option key={room.roomId} value={room.roomId}>
                {room.name}: {roomWords(room, tPossible, tDays)}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      </div>

      {failure ? (
        <Notice tone="destructive" title={t(`errors.${failure.failure.kind}.title`)}>
          <p>{failure.failure.kind === "ROOM" ? t(`errors.ROOM.${failure.failure.reason}`) : failure.text || t(`errors.${failure.failure.kind}.text`)}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {failure.failure.kind === "ROOM" ? (
              <Button type="button" size="sm" variant="outline" className="min-h-11" disabled={busy} onClick={() => void submit({ roomId: null })}>
                {t("layWithoutRoom")}
              </Button>
            ) : null}
            {failure.failure.kind === "REFUSED" && failure.failure.exemptable ? (
              <Button type="button" size="sm" variant="outline" className="min-h-11" disabled={busy} onClick={() => void submit({ exempt: failure.failure.kind === "REFUSED" ? (failure.failure.exemptable ?? []) : [] })}>
                {t("layAnyway")}
              </Button>
            ) : null}
          </div>
        </Notice>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="min-h-11" disabled={!clockOk || busy} data-writes="SCHEMALAGGNING DRIFT">
          {t("submit")}
        </Button>
        <Button type="button" variant="outline" className="min-h-11" onClick={onDone}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}

