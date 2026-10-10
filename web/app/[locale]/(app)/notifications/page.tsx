"use client";

import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useProfile } from "@/components/profile-context";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  useNotificationPreferences,
  useSaveNotificationPreferences,
  withChoice,
  type NotificationPreference,
} from "@/lib/notification-preferences-queries";

/**
 * "Notiser": what each person lets leave SchemaPro as e-mail and push, per
 * notice type. Every role, each for themself; reached from the bell.
 *
 * The inbox row is always written. A type the school must deliver is shown
 * switched on and cannot be switched off: the unreported absence for a
 * guardian (skollagen 7 kap. 19 a §), a booked cover lesson's withdrawal for
 * staff. LESSON_SUBSTITUTE is the class's "has a substitute" for families and
 * "substitutes on my lessons" for staff, whose own cover bookings arrive
 * whatever is chosen here.
 */

const STAFF = new Set(["TEACHER", "SCHOOL_ADMIN"]);

export default function NotificationSettingsPage() {
  const t = useTranslations("notificationSettings");
  const tCommon = useTranslations("common");
  const { profile } = useProfile();
  const { data, isLoading, isError } = useNotificationPreferences();
  const save = useSaveNotificationPreferences();
  const staff = STAFF.has(profile.role);

  const label = (entry: NotificationPreference) =>
    entry.type === "LESSON_SUBSTITUTE" && staff ? t("types.LESSON_SUBSTITUTE_STAFF") : t(`types.${entry.type}`);
  const hint = (entry: NotificationPreference): string | null => {
    if (entry.type === "ABSENCE_UNREPORTED") return t("requiredAbsence");
    if (entry.type === "LESSON_COVER_WITHDRAWN") return t("requiredCover");
    if (entry.type === "LESSON_SUBSTITUTE" && staff) return t("substituteStaffHint");
    return entry.required ? t("required") : null;
  };

  const change = async (types: readonly NotificationPreference[], entry: NotificationPreference, enabled: boolean) => {
    try {
      await save.mutateAsync(withChoice(types, entry.type, enabled));
      toast.success(t("saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const types = data?.types ?? [];

  return (
    <div className="max-w-2xl">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <Card>
        <CardHeader>
          <CardTitle>{t("cardTitle")}</CardTitle>
          <CardDescription>{t("cardBody")}</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t("loading")}</p>
          ) : isError ? (
            <p role="alert" className="text-sm text-destructive">
              {tCommon("error")}
            </p>
          ) : types.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <ul className="divide-y">
              {types.map((entry) => {
                const id = `notification-${entry.type}`;
                const text = hint(entry);
                return (
                  <li key={entry.type} className="flex items-start justify-between gap-4 py-3">
                    <span>
                      <Label htmlFor={id}>{label(entry)}</Label>
                      {text ? (
                        <span id={`${id}-hint`} className="mt-0.5 block text-xs text-muted-foreground">
                          {text}
                        </span>
                      ) : null}
                    </span>
                    <Switch
                      id={id}
                      checked={entry.enabled}
                      disabled={entry.required || save.isPending}
                      aria-describedby={text ? `${id}-hint` : undefined}
                      onCheckedChange={(checked) => void change(types, entry, checked)}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
