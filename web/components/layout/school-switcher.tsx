import { getTranslations } from "next-intl/server";
import { ChevronsUpDown } from "lucide-react";
import type { MySchool } from "@/lib/types";

/**
 * The school switcher (Flera skolor per inloggning): the school's name under
 * the app's, and for a login with more than one school a list of them to
 * switch to.
 *
 * Rendered on the server and handed to AppShell as its school name, so it is
 * no code on any route: a <details> that opens without script, and a form
 * that posts to /[locale]/skola, which sets the browser's choice and sends
 * the person to the start page of their role at that school with a full
 * page load. Every client of the new page then names the new school
 * (lib/school-choice.ts), and nothing the old school's page had cached
 * survives the switch.
 *
 * A school the session may not enter (the access-token hook closed it, as
 * for a school that requires its school account when the person signed in
 * with a password) is listed with the reason, and cannot be chosen.
 */
export async function SchoolSwitcher({
  schools,
  currentName,
  locale,
}: {
  schools: MySchool[];
  /** The page's school, as the session read it; the list's own name is the same school's. */
  currentName: string;
  locale: string;
}) {
  if (schools.length < 2) return <>{currentName}</>;
  const t = await getTranslations("schoolSwitcher");
  const tRoles = await getTranslations("roles");

  const closedReason = (reason: string): string => {
    switch (reason) {
      case "sso_required":
        return t("closedSsoRequired");
      case "sso_not_enabled":
        return t("closedSsoNotEnabled");
      case "sso_identity_not_allowed":
        return t("closedSsoIdentity");
      case "sso_reauth_required":
        return t("closedReauth");
      default:
        return t("closedOther");
    }
  };

  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="truncate">{currentName}</span>
        <ChevronsUpDown className="size-3 shrink-0" aria-hidden="true" />
        <span className="sr-only">{t("change")}</span>
      </summary>
      <form
        method="post"
        action={`/${locale}/skola`}
        className="absolute z-50 mt-2 w-56 whitespace-normal rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md"
      >
        <p className="px-2 py-1 text-xs font-medium text-muted-foreground">{t("label")}</p>
        <ul className="space-y-0.5">
          {schools.map((school) => (
            <li key={school.schoolId}>
              <button
                type="submit"
                name="school"
                value={school.schoolId}
                disabled={school.current || school.closed !== null}
                aria-current={school.current ? "true" : undefined}
                className="flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent aria-[current=true]:font-semibold"
              >
                <span>{school.schoolName}</span>
                <span className="text-xs text-muted-foreground">
                  {school.current
                    ? t("currentRole", { role: tRoles(school.role) })
                    : school.closed !== null
                      ? closedReason(school.closed)
                      : tRoles(school.role)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </form>
    </details>
  );
}
