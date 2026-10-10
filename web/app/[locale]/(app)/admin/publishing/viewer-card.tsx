"use client";

/*
 * Schemavisaren's settings: whether the school shows its published timetable
 * without a login at all, for which kinds (classes and groups, teachers,
 * rooms), how a teacher is named on it, whether a class's week shows its
 * meals, and how small a teaching group may be and still be named.
 *
 * Everything is OFF by default, and a link opens nothing until the viewer and
 * its kind are both on. The teacher is shown as NOTHING by default: a
 * signature is the school's own short form (TeacherEmployments.signature, per
 * läsår) and is never made up on the page, so a school that wants signatures
 * sets them first. A teacher's own week needs a display other than nothing —
 * the gateway refuses the combination (PUBLIC_TEACHERS_UNNAMED).
 *
 * The minimum group size protects pupils: a teaching group of two is two
 * named children. Below it the group is shown as "Grupp" and gets no link.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { MessageLookup } from "@/lib/engine-message";
import { useUpdatePublicationSettings } from "@/lib/publication-queries";
import { publicationErrorText } from "@/lib/publication-messages";
import type { PublicationSettings, PublicationSettingsInput, TeacherDisplay } from "@/lib/publication-types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

type Flag = "publicViewerEnabled" | "publicGroups" | "publicTeachers" | "publicRooms" | "publicShowMeals";
const FLAGS: Flag[] = ["publicViewerEnabled", "publicGroups", "publicTeachers", "publicRooms", "publicShowMeals"];
const DISPLAYS: TeacherDisplay[] = ["NONE", "SIGNATURE", "NAME"];

export function ViewerCard({ settings }: { settings: PublicationSettings }) {
  const t = useTranslations("publishing");
  const tErrors = useTranslations("publishing.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const update = useUpdatePublicationSettings();
  const [changes, setChanges] = useState<PublicationSettingsInput>({});
  const [problem, setProblem] = useState<string | null>(null);
  const value = <K extends keyof PublicationSettingsInput>(key: K) =>
    (changes[key] ?? settings[key]) as PublicationSettings[K];
  const minSize = value("publicMinGroupSize");
  const sizeValid = Number.isInteger(minSize) && minSize >= 3 && minSize <= 30;

  const save = async () => {
    setProblem(null);
    try {
      await update.mutateAsync(changes);
      setChanges({});
      toast.success(t("viewerSaved"));
    } catch (error) {
      setProblem(publicationErrorText(tErrors, error, tCommon("error")));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("viewerTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p>{t("viewerBody")}</p>
        <ul className="space-y-3">
          {FLAGS.map((flag) => (
            <li key={flag} className="flex items-start gap-3">
              <Switch
                id={`viewer-${flag}`}
                checked={value(flag)}
                disabled={flag !== "publicViewerEnabled" && !value("publicViewerEnabled")}
                onCheckedChange={(checked) => setChanges((previous) => ({ ...previous, [flag]: checked }))}
                aria-describedby={`viewer-${flag}-hint`}
              />
              <span>
                <Label htmlFor={`viewer-${flag}`}>{t(`viewer.${flag}`)}</Label>
                <span id={`viewer-${flag}-hint`} className="block text-xs">
                  {t(`viewer.${flag}Hint`)}
                </span>
              </span>
            </li>
          ))}
        </ul>
        <div className="grid max-w-xl gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="viewer-display">{t("viewer.teacherDisplay")}</Label>
            <Select
              value={value("publicTeacherDisplay")}
              onValueChange={(next) =>
                setChanges((previous) => ({ ...previous, publicTeacherDisplay: next as TeacherDisplay }))
              }
            >
              <SelectTrigger id="viewer-display" aria-label={t("viewer.teacherDisplay")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DISPLAYS.map((display) => (
                  <SelectItem key={display} value={display}>
                    {t(`display.${display}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs">{t("viewer.teacherDisplayHint")}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="viewer-min-size">{t("viewer.minGroupSize")}</Label>
            <Input
              id="viewer-min-size"
              type="number"
              min={3}
              max={30}
              value={String(minSize)}
              onChange={(event) =>
                setChanges((previous) => ({ ...previous, publicMinGroupSize: Number(event.target.value) }))
              }
              aria-describedby="viewer-min-size-hint"
            />
            <p id="viewer-min-size-hint" className="text-xs">
              {t("viewer.minGroupSizeHint")}
            </p>
          </div>
        </div>
        {problem ? (
          <p role="alert" className="font-medium">
            {problem}
          </p>
        ) : null}
        <Button onClick={save} disabled={Object.keys(changes).length === 0 || !sizeValid || update.isPending}>
          {tCommon("save")}
        </Button>
      </CardContent>
    </Card>
  );
}
