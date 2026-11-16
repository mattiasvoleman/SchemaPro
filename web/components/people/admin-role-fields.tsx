"use client";

import { useTranslations } from "next-intl";
import { ADMIN_PROFILES, HR_READ_PROFILES, type AdminProfile } from "@/lib/admin-areas";
import { FormField } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * The role chooser's administrator half (Roller i skolan): which profile,
 * and HR-läs for a schemaläggare, an expedition or a läsare (Läsbehörighet:
 * the profile that reads everything and changes nothing). Shown when the person is
 * an administrator. Only rektor and a full administrator change it; anybody
 * else sees it, disabled, with the sentence that says who does.
 *
 * "Undervisar" (Users.teaches) is the mark of an administrator who also
 * teaches: she stands on lessons and has the teacher's own pages and part in an
 * alarm, and her rights are the administrator's all the same. It is for every
 * administrator profile but the läsare, who changes nothing and so teaches
 * nothing (the database refuses it, and zeroes the mark if the profile becomes
 * one), and it is rektor's and a full administrator's to set, like the rest.
 */
export function AdminRoleFields({
  adminProfile,
  hrRead,
  teaches,
  decides,
  unavailable,
  onChange,
  onTeachesChange,
}: {
  adminProfile: AdminProfile;
  hrRead: boolean;
  teaches: boolean;
  decides: boolean;
  /**
   * The stored profile is not known (still read, or the read failed): the
   * chooser is locked, and the save leaves the profile as it is.
   */
  unavailable?: "loading" | "failed";
  onChange: (next: { adminProfile: AdminProfile; hrRead: boolean }) => void;
  onTeachesChange: (teaches: boolean) => void;
}) {
  const t = useTranslations("adminAreas");
  const narrow = HR_READ_PROFILES.includes(adminProfile);
  const locked = !decides || unavailable !== undefined;
  return (
    <div className="space-y-3">
      <FormField
        id="person-admin-profile"
        label={t("profileLabel")}
        hint={
          unavailable
            ? t(unavailable === "loading" ? "profileLoading" : "profileUnreadable")
            : decides
              ? t(`profileHint.${adminProfile}`)
              : t("roleIsDecision")
        }
      >
        {(control) => (
          <Select
            value={adminProfile}
            disabled={locked}
            onValueChange={(value) =>
              onChange({
                adminProfile: value as AdminProfile,
                // Rektor and full read tjänst % anyway; the grant is the narrow profiles'.
                hrRead: HR_READ_PROFILES.includes(value as AdminProfile) ? hrRead : false,
              })
            }
          >
            <SelectTrigger {...control}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ADMIN_PROFILES.map((profile) => (
                <SelectItem key={profile} value={profile}>
                  {t(`profile.${profile}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormField>
      {narrow ? (
        <div className="flex items-start justify-between gap-4 rounded-md border p-3">
          <div className="space-y-1">
            <Label htmlFor="person-hr-read">{t("hrReadLabel")}</Label>
            <p id="person-hr-read-hint" className="text-xs text-muted-foreground">
              {t("hrReadHint")}
            </p>
          </div>
          <Switch
            id="person-hr-read"
            checked={hrRead}
            disabled={locked}
            onCheckedChange={(checked) => onChange({ adminProfile, hrRead: checked })}
            aria-describedby="person-hr-read-hint"
          />
        </div>
      ) : null}
      {adminProfile !== "LASARE" ? (
        <div className="flex items-start justify-between gap-4 rounded-md border p-3">
          <div className="space-y-1">
            <Label htmlFor="person-teaches">{t("teaches.label")}</Label>
            <p id="person-teaches-hint" className="text-xs text-muted-foreground">
              {t("teaches.hint")}
              {decides ? "" : ` ${t("roleIsDecision")}`}
            </p>
          </div>
          <Switch
            id="person-teaches"
            checked={teaches}
            disabled={locked}
            onCheckedChange={onTeachesChange}
            aria-describedby="person-teaches-hint"
          />
        </div>
      ) : null}
    </div>
  );
}
