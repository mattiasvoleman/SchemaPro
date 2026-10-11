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
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
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
    <SectionCard
      id="publish-viewer"
      title={t("viewerTitle")}
      description={t("viewerBody")}
      descriptionClassName="max-w-prose"
      footer={
        <Button onClick={save} disabled={Object.keys(changes).length === 0 || !sizeValid || update.isPending}>
          {update.isPending ? (
            <>
              <Loader2 className="animate-spin" />
              {tCommon("saving")}
            </>
          ) : (
            tCommon("save")
          )}
        </Button>
      }
    >
      <ul className="space-y-2">
        {FLAGS.map((flag) => (
          <li key={flag} className="flex items-start justify-between gap-4 rounded-md border p-3">
            <div className="min-w-0 space-y-1">
              <Label htmlFor={`viewer-${flag}`}>{t(`viewer.${flag}`)}</Label>
              <p id={`viewer-${flag}-hint`} className="text-xs text-muted-foreground">
                {t(`viewer.${flag}Hint`)}
              </p>
            </div>
            <Switch
              id={`viewer-${flag}`}
              checked={value(flag)}
              disabled={flag !== "publicViewerEnabled" && !value("publicViewerEnabled")}
              onCheckedChange={(checked) => setChanges((previous) => ({ ...previous, [flag]: checked }))}
              aria-describedby={`viewer-${flag}-hint`}
            />
          </li>
        ))}
      </ul>
      <div className="grid max-w-xl gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <FormField id="viewer-display" label={t("viewer.teacherDisplay")} hint={t("viewer.teacherDisplayHint")}>
          {(control) => (
            <Select
              value={value("publicTeacherDisplay")}
              onValueChange={(next) =>
                setChanges((previous) => ({ ...previous, publicTeacherDisplay: next as TeacherDisplay }))
              }
            >
              <SelectTrigger {...control}>
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
          )}
        </FormField>
        <FormField id="viewer-min-size" label={t("viewer.minGroupSize")} hint={t("viewer.minGroupSizeHint")}>
          <Input
            type="number"
            min={3}
            max={30}
            className="tabular-nums"
            value={String(minSize)}
            onChange={(event) =>
              setChanges((previous) => ({ ...previous, publicMinGroupSize: Number(event.target.value) }))
            }
          />
        </FormField>
      </div>
      {problem ? <Notice tone="destructive">{problem}</Notice> : null}
    </SectionCard>
  );
}
