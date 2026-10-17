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
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useReadOnly } from "@/components/profile-context";
import { useSetTeacherHidden } from "./use-public-links";

export function HiddenTeachersCard({
  teachers,
  hidden,
  loading = false,
  failed = false,
}: {
  teachers: readonly Person[];
  hidden: ReadonlySet<string>;
  /** The teachers or the hidden list still on their way. */
  loading?: boolean;
  /**
   * Either list failed. Then every switch would read "shown" whatever the
   * school decided, and one press could expose a protected teacher — so the
   * switches are not drawn at all.
   */
  failed?: boolean;
}) {
  const t = useTranslations("publishing");
  const tErrors = useTranslations("publishing.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const setHidden = useSetTeacherHidden();
  // A press saves: a reader (Läsbehörighet) sees who is hidden, the switches not pressable.
  const readOnly = useReadOnly();

  const toggle = async (userId: string, next: boolean) => {
    try {
      await setHidden.mutateAsync({ userId, hidden: next });
    } catch (error) {
      toast.error(publicationErrorText(tErrors, error, tCommon("error")));
    }
  };

  return (
    <SectionCard
      id="publish-hidden"
      title={t("hiddenTitle")}
      description={t("hiddenBody")}
      descriptionClassName="max-w-prose"
    >
      {loading ? (
        <div aria-busy="true">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : failed ? (
        <LoadError variant="inline" title={t("hiddenLoadFailed")} hint={t("hiddenLoadFailedHint")} />
      ) : teachers.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("hiddenNoTeachers")}</p>
      ) : (
        <ul className="grid gap-2 text-sm sm:grid-cols-2">
          {teachers.map((teacher) => (
            // The whole row: the name is the switch's label, and pressing it would save.
            <li key={teacher.id} className="flex items-center gap-3" data-writes-inert="PUBLICERING">
              <Switch
                id={`hidden-${teacher.id}`}
                checked={hidden.has(teacher.id)}
                disabled={readOnly || setHidden.isPending}
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
    </SectionCard>
  );
}
