"use client";

/*
 * Låna en sal (Delade lokaler och lärare): ask another school of the
 * huvudman for one of its rooms, at weekly times between two dates. Each time
 * becomes a loan of its own that the owner's planner approves or declines.
 *
 * A request makes nothing at the school: the owner's approval of the first
 * loan of a room makes the school's own room for it, named after the room
 * and its school unless the planner names it, the room the school's lessons
 * in the borrowed room stand in. A later request of the room holds by that
 * room. Fetched the first time it opens (sharing-card.tsx).
 */

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { useLendableRooms, useRequestRoomLoan } from "./use-sharing";

/** At most ten times in one request, as the gateway takes them (CreateRoomLoanDto). */
export const MAX_WINDOWS = 10;
/** At most 400 days between the first date and the last (RoomLoans_at_most_400_days). */
export const MAX_LOAN_DAYS = 400;

interface Window {
  dayOfWeek: string;
  startTime: string;
  endTime: string;
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** What is wrong with the request as typed, as a message key; null when it can be sent. */
export function requestProblem(
  windows: readonly Window[],
  startDate: string,
  endDate: string,
): "windowTimes" | "windowOrder" | "windowTwice" | "dates" | "datesOrder" | "datesTooLong" | null {
  for (const window of windows) {
    if (!CLOCK.test(window.startTime) || !CLOCK.test(window.endTime)) return "windowTimes";
    if (window.startTime >= window.endTime) return "windowOrder";
  }
  const keys = windows.map((window) => `${window.dayOfWeek} ${window.startTime}`);
  if (new Set(keys).size !== keys.length) return "windowTwice";
  if (!startDate || !endDate) return "dates";
  const span = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000;
  if (span < 0) return "datesOrder";
  if (span > MAX_LOAN_DAYS) return "datesTooLong";
  return null;
}

const emptyWindow = (): Window => ({ dayOfWeek: "1", startTime: "", endTime: "" });

export interface RoomLoanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Begär igen: the room and times of a loan the school had, for the next
   * läsår's request. The dates are left for the planner to choose: a loan is
   * never rolled over by itself.
   */
  initial?: { roomId: string; windows: { dayOfWeek: number; startTime: string; endTime: string }[] } | null;
}

export function RoomLoanDialog({ open, onOpenChange, initial = null }: RoomLoanDialogProps) {
  const t = useTranslations("sharing");
  const tDays = useTranslations("days");
  const tCommon = useTranslations("common");
  const rooms = useLendableRooms(open);
  const requestLoan = useRequestRoomLoan();
  const [roomId, setRoomId] = useState("");
  const [windows, setWindows] = useState<Window[]>([emptyWindow()]);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [note, setNote] = useState("");
  const [localName, setLocalName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  // Each opening for a loan asked for again starts from that loan's room and times.
  useEffect(() => {
    if (!open || !initial) return;
    setRoomId(initial.roomId);
    setWindows(
      initial.windows.length > 0
        ? initial.windows.map((window) => ({ dayOfWeek: String(window.dayOfWeek), startTime: window.startTime, endTime: window.endTime }))
        : [emptyWindow()],
    );
    setStartDate("");
    setEndDate("");
    setFormError(null);
  }, [open, initial]);

  const chosen = useMemo(() => {
    for (const school of rooms.data ?? []) {
      const room = school.rooms.find((candidate) => candidate.id === roomId);
      if (room) return { school, room };
    }
    return null;
  }, [rooms.data, roomId]);
  const problem = requestProblem(windows, startDate, endDate);
  const suggestedName = chosen ? `${chosen.room.name} (${chosen.school.name})` : "";

  const setWindow = (index: number, patch: Partial<Window>) =>
    setWindows((current) => current.map((window, i) => (i === index ? { ...window, ...patch } : window)));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (!chosen || problem) return;
    try {
      await requestLoan.mutateAsync({
        roomId: chosen.room.id,
        windows: windows.map((window) => ({
          dayOfWeek: Number(window.dayOfWeek),
          startTime: window.startTime,
          endTime: window.endTime,
        })),
        startDate,
        endDate,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(!chosen.room.localRoomId && localName.trim() ? { localRoomName: localName.trim() } : {}),
      });
      toast.success(t("requested", { room: chosen.room.name, school: chosen.school.name }));
      onOpenChange(false);
      setRoomId("");
      setWindows([emptyWindow()]);
      setNote("");
      setLocalName("");
    } catch (error) {
      setFormError(
        error instanceof ApiError && error.code && t.has(`errors.${error.code}`)
          ? t(`errors.${error.code}`)
          : error instanceof Error
            ? error.message
            : tCommon("error"),
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <form onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>{t("borrowTitle")}</DialogTitle>
            <DialogDescription>{t("borrowHint")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {formError ? (
              <Notice tone="destructive" title={t("requestFailed")}>
                {formError}
              </Notice>
            ) : null}
            {rooms.isLoading ? (
              <div aria-busy="true">
                <Skeleton className="h-9 w-full" />
              </div>
            ) : rooms.isError ? (
              <Notice tone="destructive" title={t("roomsLoadFailed")} />
            ) : (rooms.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noRooms")}</p>
            ) : (
              <FormField id="room-loan-room" label={t("fields.room")}>
                <NativeSelect value={roomId} onChange={(event) => setRoomId(event.target.value)} required>
                  <option value="">{t("fields.roomPlaceholder")}</option>
                  {(rooms.data ?? []).map((school) => (
                    <optgroup key={school.id} label={school.name}>
                      {school.rooms.map((room) => (
                        <option key={room.id} value={room.id}>
                          {room.roomTypeName || room.capacity
                            ? t("roomOption", { name: room.name, type: room.roomTypeName ?? "", capacity: room.capacity ?? "" })
                            : room.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </NativeSelect>
              </FormField>
            )}

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("fields.windows")}</legend>
              <ul className="space-y-2">
                {windows.map((window, index) => (
                  <li key={index} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2 sm:grid-cols-[1fr_6rem_6rem_auto]">
                    {/* On a phone the day has the row to itself, and the times and the button share the next. */}
                    <FormField id={`room-loan-day-${index}`} label={t("fields.day")} className="col-span-3 sm:col-span-1">
                      <NativeSelect value={window.dayOfWeek} onChange={(event) => setWindow(index, { dayOfWeek: event.target.value })}>
                        {["1", "2", "3", "4", "5", "6", "7"].map((day) => (
                          <option key={day} value={day}>
                            {tDays(day)}
                          </option>
                        ))}
                      </NativeSelect>
                    </FormField>
                    <FormField id={`room-loan-start-${index}`} label={t("fields.start")}>
                      <Input
                        type="time"
                        step={300}
                        value={window.startTime}
                        onChange={(event) => setWindow(index, { startTime: event.target.value })}
                      />
                    </FormField>
                    <FormField id={`room-loan-end-${index}`} label={t("fields.end")}>
                      <Input type="time" step={300} value={window.endTime} onChange={(event) => setWindow(index, { endTime: event.target.value })} />
                    </FormField>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("removeWindow", { n: index + 1 })}
                      disabled={windows.length === 1}
                      onClick={() => setWindows((current) => current.filter((_, i) => i !== index))}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={windows.length >= MAX_WINDOWS}
                onClick={() => setWindows((current) => [...current, emptyWindow()])}
              >
                <Plus aria-hidden="true" />
                {t("addWindow")}
              </Button>
            </fieldset>

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField id="room-loan-from" label={t("fields.from")}>
                <DateField value={startDate} onChange={setStartDate} />
              </FormField>
              <FormField id="room-loan-to" label={t("fields.to")}>
                <DateField value={endDate} onChange={setEndDate} min={startDate || undefined} />
              </FormField>
            </div>
            {problem && problem !== "dates" && problem !== "windowTimes" ? (
              <p className="text-sm text-destructive">{t(`problems.${problem}`)}</p>
            ) : null}

            {chosen && !chosen.room.localRoomId ? (
              <FormField id="room-loan-local" label={t("fields.localRoom")} hint={t("fields.localRoomHint")} optional>
                <Input value={localName} maxLength={100} placeholder={suggestedName} onChange={(event) => setLocalName(event.target.value)} />
              </FormField>
            ) : null}

            <FormField id="room-loan-note" label={t("fields.note")} optional>
              <Input value={note} maxLength={300} onChange={(event) => setNote(event.target.value)} />
            </FormField>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={!chosen || problem !== null || requestLoan.isPending}>
              {t("send")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
