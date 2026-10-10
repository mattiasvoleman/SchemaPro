"use client";

/*
 * Teachers Schemavisaren never shows: not as a target, not in a list, not as
 * a name or signature on any lesson (TeacherPublicLabels.hidden). For a
 * teacher with a protected identity — the users table carries no such flag,
 * so the school says it here. A hidden teacher's existing links stop
 * resolving within a minute.
 */

import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { MessageLookup } from "@/lib/engine-message";
import { publicationErrorText } from "@/lib/publication-messages";
import type { Person } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useSetTeacherHidden } from "./use-public-links";

export function HiddenTeachersCard({ teachers, hidden }: { teachers: readonly Person[]; hidden: ReadonlySet<string> }) {
  const t = useTranslations("publishing");
  const tErrors = useTranslations("publishing.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const setHidden = useSetTeacherHidden();

  const toggle = async (userId: string, next: boolean) => {
    try {
      await setHidden.mutateAsync({ userId, hidden: next });
    } catch (error) {
      toast.error(publicationErrorText(tErrors, error, tCommon("error")));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("hiddenTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>{t("hiddenBody")}</p>
        {teachers.length === 0 ? (
          <p>{t("hiddenNoTeachers")}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {teachers.map((teacher) => (
              <li key={teacher.id} className="flex items-center gap-3">
                <Switch
                  id={`hidden-${teacher.id}`}
                  checked={hidden.has(teacher.id)}
                  disabled={setHidden.isPending}
                  onCheckedChange={(checked) => void toggle(teacher.id, checked)}
                  aria-label={t("hiddenToggle", { name: `${teacher.firstName} ${teacher.lastName}` })}
                />
                <label htmlFor={`hidden-${teacher.id}`}>
                  {teacher.firstName} {teacher.lastName}
                </label>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
