"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import {
  useRoomPreferenceActions,
  useRoomPreferences,
  useRooms,
  useRoomTypes,
  useSubjects,
} from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
 * Soft room wishes, alongside the school's hard constraints.
 *
 * Kept visibly separate from the unavailability rules above it because the two
 * fail differently: an unavailability that cannot be honoured makes the week
 * unschedulable and must be fixed, while a wish that cannot be honoured simply
 * costs the optimizer points and produces a timetable anyway. Presenting them
 * as one list would invite a school to state wishes it believes are promises.
 */
export function RoomPreferencesCard() {
  const t = useTranslations("constraints");
  const tCommon = useTranslations("common");
  const { data: preferences } = useRoomPreferences();
  const { data: subjects } = useSubjects();
  const { data: rooms } = useRooms();
  const { data: roomTypes } = useRoomTypes();
  const actions = useRoomPreferenceActions();

  const [adding, setAdding] = useState(false);
  const [subjectId, setSubjectId] = useState("");
  const [target, setTarget] = useState<typeof BY_TYPE | typeof BY_ROOMS>(BY_TYPE);
  const [roomTypeId, setRoomTypeId] = useState("");
  const [roomIds, setRoomIds] = useState<string[]>([]);
  const [weight, setWeight] = useState("50");

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

  const reset = () => {
    setAdding(false);
    setSubjectId("");
    setTarget(BY_TYPE);
    setRoomTypeId("");
    setRoomIds([]);
    setWeight("50");
  };

  const submit = async () => {
    try {
      await actions.create.mutateAsync({
        subjectId,
        // Exactly one target: the API refuses both and neither, and the form
        // must not be the place where that becomes a 400 the admin has to
        // decode.
        ...(target === BY_TYPE ? { roomTypeId } : { roomIds }),
        weight: Number(weight) || 50,
      });
      toast.success(tCommon("created"));
      reset();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
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

  return (
    <div className="mt-8 rounded-lg border bg-card p-4">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("preferencesTitle")}</h2>
        {!adding ? (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus />
            {t("addPreference")}
          </Button>
        ) : null}
      </div>
      <p className="mb-4 text-sm text-muted-foreground">{t("preferencesHint")}</p>

      {adding ? (
        <div className="mb-4 space-y-3 rounded-md border p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="pref-subject">{t("preferenceSubject")}</Label>
              <Select value={subjectId} onValueChange={setSubjectId}>
                <SelectTrigger id="pref-subject" aria-label={t("preferenceSubject")}>
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
            </div>

            <div className="space-y-2">
              <Label htmlFor="pref-target">{t("preferenceTarget")}</Label>
              <Select
                value={target}
                onValueChange={(value) => setTarget(value as typeof BY_TYPE)}
              >
                <SelectTrigger id="pref-target" aria-label={t("preferenceTarget")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={BY_TYPE}>{t("preferenceByType")}</SelectItem>
                  <SelectItem value={BY_ROOMS}>{t("preferenceByRooms")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {target === BY_TYPE ? (
            <div className="space-y-2">
              <Label htmlFor="pref-type">{t("preferenceRoomType")}</Label>
              <Select value={roomTypeId} onValueChange={setRoomTypeId}>
                <SelectTrigger id="pref-type" aria-label={t("preferenceRoomType")}>
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
            </div>
          ) : (
            <div className="space-y-2">
              <Label>{t("preferenceRooms")}</Label>
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
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="pref-weight">{t("preferenceWeight")}</Label>
            <Input
              id="pref-weight"
              type="number"
              min={1}
              max={1000}
              value={weight}
              onChange={(event) => setWeight(event.target.value)}
              className="max-w-32"
            />
            <p className="text-xs text-muted-foreground">{t("preferenceWeightHint")}</p>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={reset}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={submit} disabled={!canSubmit || actions.create.isPending}>
              {tCommon("save")}
            </Button>
          </div>
        </div>
      ) : null}

      {(preferences ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("preferencesEmpty")}</p>
      ) : (
        <ul className="space-y-2">
          {(preferences ?? []).map((preference) => (
            <li
              key={preference.id}
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
            >
              <span>
                {t("preferenceSummary", {
                  subject: subjectName.get(preference.subjectId) ?? "—",
                  rooms: describe(preference),
                })}
                <Badge variant="outline" className="ml-2 font-normal">
                  {t("preferenceWeightBadge", { weight: preference.weight })}
                </Badge>
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={tCommon("delete")}
                onClick={() => void actions.remove.mutateAsync(preference.id)}
              >
                <Trash2 className="text-destructive" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
