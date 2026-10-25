import { getTranslations } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { localePath } from "@/i18n/paths";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NATIVE_SELECT_CLASS } from "@/components/ui/native-select";
import { labelClassName } from "@/components/ui/label-style";
import { getSession } from "@/lib/auth";
import { HUVUDMAN_SCOPES, huvudmanGateway, type HuvudmanView, type MyHuvudman } from "@/lib/huvudman";
import { cn } from "@/lib/utils";
import { SignOutButton } from "../(auth)/no-profile/sign-out-button";
import { CreateKeyForm } from "./create-key-form";

export const dynamic = "force-dynamic";

/**
 * The huvudman's own pages (Huvudman, 20261212090000): the schools it owns
 * and asks for, its people and its SS12000 keys, and its history with the
 * schools. Every member reads them; the kommunadministratör also acts, and
 * each act is a plain form posted to ./act (no client code), the key's
 * creation aside, whose one-time secret ./create-key-form.tsx shows.
 *
 * Outside the (app) group: a member may have no row at any school, and the
 * schools themselves are opened through the school switcher's route, as the
 * huvudman's läsare there.
 */
export default async function HuvudmanPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const one = (name: string) => (typeof query[name] === "string" ? (query[name] as string) : null);
  const session = await getSession();
  if (!session) {
    redirect({ href: "/login", locale });
    return null;
  }
  const t = await getTranslations("huvudman");
  const tCommon = await getTranslations("common");

  const mine = await huvudmanGateway<MyHuvudman[]>(session.accessToken, "GET", "/api/v1/huvudman");
  const memberships = mine.body ?? [];
  const chosen = memberships.find((membership) => membership.id === one("h")) ?? memberships[0];
  const read = chosen ? await huvudmanGateway<HuvudmanView>(session.accessToken, "GET", `/api/v1/huvudman/${chosen.id}`) : null;
  const view = read?.body ?? null;
  // The gateway could not answer: not the same as "no member".
  const failed = !mine.body || (chosen !== undefined && !view);

  const dateTime = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Stockholm",
  });
  const day = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", { dateStyle: "medium", timeZone: "Europe/Stockholm" });
  const keeps = view?.role === "KOMMUNADMINISTRATOR";
  const act = localePath(locale, "/huvudman/act");
  // Only the act route's own answers: a done* key it sends, a refusal's code
  // (HUVUDMAN_*) or errorOther; the school named by its id in the page's list.
  const DONE = ["doneRequested", "doneWithdrawn", "doneReleased", "doneInvited", "doneInvitedNoMail", "doneUpdated", "doneRevoked"];
  const done = one("done");
  const error = one("error");
  const doneKey = done && DONE.includes(done) ? done : null;
  const errorKey = error
    ? /^HUVUDMAN_[A-Z_]+$/.test(error) && t.has(`error${error}`)
      ? `error${error}`
      : "errorOther"
    : null;
  const schoolNamed = view?.schools.find((school) => school.id === one("school"))?.name ?? "";
  // A question before an act that cannot be taken back (./act asks it).
  const confirm = one("confirm");
  const target = one("target");
  const asked = (() => {
    if (!view || !target) return null;
    if (confirm === "release") {
      const school = view.schools.find((one) => one.id === target && one.state === "OWNED");
      return school ? { text: t("confirmRelease", { school: school.name }), fields: { action: "release", school: school.id } } : null;
    }
    if (confirm === "revoke") {
      const key = view.keys?.find((one) => one.id === target && !one.revokedAt);
      return key ? { text: t("confirmRevoke", { name: key.name }), fields: { action: "revoke", key: key.id } } : null;
    }
    if (confirm === "member") {
      const member = view.members.find((one) => one.id === target && one.isActive);
      return member
        ? { text: t("confirmDeactivate", { name: `${member.firstName} ${member.lastName}` }), fields: { action: "member", member: member.id, isActive: "false" } }
        : null;
    }
    return null;
  })();
  const memberName = (id: string | null) => {
    const member = id ? view?.members.find((one) => one.id === id) : undefined;
    return member ? `${member.firstName} ${member.lastName}` : t("byHuvudman");
  };

  return (
    <div className="min-h-screen bg-muted/40">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <div className="text-sm font-semibold">{tCommon("appName")}</div>
            <div className="text-xs text-muted-foreground">
              {chosen ? chosen.name : t("title")}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Back to the school the browser remembers, when the login has one. */}
            {session.schools.length > 0 ? (
              <a href={localePath(locale, "/")} className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
                {t("toSchool")}
              </a>
            ) : null}
            <SignOutButton
              loginPath={localePath(locale, "/login")}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
              label={tCommon("signOut")}
              failed={tCommon("error")}
            />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{view ? view.name : t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
          {view?.organisationNumber ? (
            <p className="text-sm text-muted-foreground">{t("orgNumber", { number: view.organisationNumber })}</p>
          ) : null}
        </div>

        {memberships.length > 1 ? (
          <nav aria-label={t("chooseHuvudman")} className="flex flex-wrap gap-2">
            {memberships.map((membership) => (
              <a
                key={membership.id}
                href={`${localePath(locale, "/huvudman")}?h=${membership.id}`}
                aria-current={membership.id === chosen?.id ? "page" : undefined}
                className={cn(buttonVariants({ variant: membership.id === chosen?.id ? "default" : "outline", size: "sm" }))}
              >
                {membership.name}
              </a>
            ))}
          </nav>
        ) : null}

        {doneKey ? (
          <p id="huvudman-result" tabIndex={-1} role="status" className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm">
            {doneKey === "doneRequested" && !schoolNamed ? t("doneRequestedUnnamed") : t(doneKey, { school: schoolNamed })}
          </p>
        ) : null}
        {errorKey ? (
          <p id="huvudman-result" tabIndex={-1} role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
            {t(errorKey)}
          </p>
        ) : null}
        {asked && view ? (
          <section
            id="huvudman-confirm"
            tabIndex={-1}
            aria-labelledby="huvudman-confirm-title"
            className="space-y-3 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm"
          >
            <h2 id="huvudman-confirm-title" className="font-semibold">{t("confirmTitle")}</h2>
            <p>{asked.text}</p>
            <div className="flex flex-wrap gap-2">
              <form method="post" action={act}>
                <input type="hidden" name="huvudman" value={view.id} />
                <input type="hidden" name="confirmed" value="yes" />
                {Object.entries(asked.fields).map(([name, value]) => (
                  <input key={name} type="hidden" name={name} value={value} />
                ))}
                <button type="submit" className={cn(buttonVariants({ variant: "destructive", size: "sm" }))}>{t("confirmYes")}</button>
              </form>
              <a href={`${localePath(locale, "/huvudman")}?h=${view.id}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                {t("confirmNo")}
              </a>
            </div>
          </section>
        ) : null}

        {failed ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{t("loadFailed")}</p>
        ) : !view ? (
          <Card>
            <CardContent className="pt-6 text-sm text-muted-foreground">{t("notMember")}</CardContent>
          </Card>
        ) : (
          <>
            <p className="text-sm">
              {t("yourRole", { role: t(`role${view.role}`) })} {t("readsAsLasare")}
            </p>

            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>{t("schools")}</h2>
                </CardTitle>
                <CardDescription>{t("schoolsIntro")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {view.schools.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("noSchools")}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th scope="col" className="py-2 pr-3 font-medium">{t("schoolColumn")}</th>
                          <th scope="col" className="py-2 pr-3 font-medium">{t("stateColumn")}</th>
                          <th scope="col" className="py-2 pr-3 font-medium">{t("sinceColumn")}</th>
                          <th scope="col" className="py-2 font-medium">{t("actionsColumn")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {view.schools.map((school) => (
                          <tr key={`${school.state}:${school.id}`} className="border-b last:border-0">
                            <th scope="row" className="py-2 pr-3 text-left font-normal">
                              {school.name}
                              <span className="block text-xs text-muted-foreground">{school.slug}</span>
                            </th>
                            <td className="py-2 pr-3">{t(`state${school.state}`)}</td>
                            <td className="py-2 pr-3">{day.format(new Date(school.since))}</td>
                            <td className="py-2">
                              <div className="flex flex-wrap gap-2">
                                {school.state === "OWNED" ? (
                                  <form method="post" action={localePath(locale, "/skola")}>
                                    <button
                                      type="submit"
                                      name="school"
                                      value={school.id}
                                      className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                                    >
                                      {t("open", { school: school.name })}
                                    </button>
                                  </form>
                                ) : null}
                                {keeps ? (
                                  <form method="post" action={act}>
                                    <input type="hidden" name="huvudman" value={view.id} />
                                    <input type="hidden" name="action" value={school.state === "OWNED" ? "release" : "withdraw"} />
                                    <input type="hidden" name="school" value={school.id} />
                                    <button type="submit" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
                                      {school.state === "OWNED" ? t("release", { school: school.name }) : t("withdraw", { school: school.name })}
                                    </button>
                                  </form>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {keeps ? (
                  <form method="post" action={act} className="space-y-2 rounded-md border p-3">
                    <h3 className="text-sm font-semibold">{t("requestTitle")}</h3>
                    <p id="huvudman-request-hint" className="text-xs text-muted-foreground">{t("requestHint")}</p>
                    <input type="hidden" name="huvudman" value={view.id} />
                    <input type="hidden" name="action" value="request" />
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="space-y-1">
                        <label htmlFor="huvudman-slug" className={labelClassName}>{t("slug")}</label>
                        <Input
                          id="huvudman-slug"
                          name="slug"
                          required
                          pattern="[a-z0-9][a-z0-9\-]{0,99}"
                          aria-describedby="huvudman-request-hint"
                          className="w-64"
                        />
                      </div>
                      <button type="submit" className={cn(buttonVariants({ size: "sm" }))}>{t("request")}</button>
                    </div>
                  </form>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>{t("members")}</h2>
                </CardTitle>
                <CardDescription>{t("membersIntro")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th scope="col" className="py-2 pr-3 font-medium">{t("nameColumn")}</th>
                        <th scope="col" className="py-2 pr-3 font-medium">{t("emailColumn")}</th>
                        <th scope="col" className="py-2 pr-3 font-medium">{t("roleColumn")}</th>
                        <th scope="col" className="py-2 pr-3 font-medium">{t("statusColumn")}</th>
                        {keeps ? <th scope="col" className="py-2 font-medium">{t("actionsColumn")}</th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {view.members.map((member) => {
                        const name = `${member.firstName} ${member.lastName}`;
                        const other = member.role === "KOMMUNADMINISTRATOR" ? "PLANERARE" : "KOMMUNADMINISTRATOR";
                        return (
                          <tr key={member.id} className="border-b last:border-0">
                            <th scope="row" className="py-2 pr-3 text-left font-normal">{name}</th>
                            <td className="py-2 pr-3">{member.email}</td>
                            <td className="py-2 pr-3">{t(`roleName${member.role}`)}</td>
                            <td className="py-2 pr-3">
                              {!member.isActive ? t("inactive") : member.invited ? t("active") : t("notInvited")}
                            </td>
                            {keeps ? (
                              <td className="py-2">
                                <div className="flex flex-wrap gap-2">
                                  <form method="post" action={act}>
                                    <input type="hidden" name="huvudman" value={view.id} />
                                    <input type="hidden" name="action" value="member" />
                                    <input type="hidden" name="member" value={member.id} />
                                    <input type="hidden" name="role" value={other} />
                                    <button type="submit" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
                                      {t("makeRole", { name, role: t(`role${other}`) })}
                                    </button>
                                  </form>
                                  <form method="post" action={act}>
                                    <input type="hidden" name="huvudman" value={view.id} />
                                    <input type="hidden" name="action" value="member" />
                                    <input type="hidden" name="member" value={member.id} />
                                    <input type="hidden" name="isActive" value={member.isActive ? "false" : "true"} />
                                    <button type="submit" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
                                      {member.isActive ? t("deactivate", { name }) : t("activate", { name })}
                                    </button>
                                  </form>
                                </div>
                              </td>
                            ) : null}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {keeps ? (
                  <form method="post" action={act} className="space-y-2 rounded-md border p-3">
                    <h3 className="text-sm font-semibold">{t("inviteTitle")}</h3>
                    <input type="hidden" name="huvudman" value={view.id} />
                    <input type="hidden" name="action" value="invite" />
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="space-y-1">
                        <label htmlFor="huvudman-first" className={labelClassName}>{t("firstName")}</label>
                        <Input id="huvudman-first" name="firstName" required maxLength={100} autoComplete="off" />
                      </div>
                      <div className="space-y-1">
                        <label htmlFor="huvudman-last" className={labelClassName}>{t("lastName")}</label>
                        <Input id="huvudman-last" name="lastName" required maxLength={100} autoComplete="off" />
                      </div>
                      <div className="space-y-1">
                        <label htmlFor="huvudman-email" className={labelClassName}>{t("email")}</label>
                        <Input id="huvudman-email" name="email" type="email" required maxLength={254} autoComplete="off" />
                      </div>
                      <div className="space-y-1">
                        <label htmlFor="huvudman-role" className={labelClassName}>{t("role")}</label>
                        <select id="huvudman-role" name="role" className={NATIVE_SELECT_CLASS} defaultValue="PLANERARE">
                          <option value="PLANERARE">{t("roleNamePLANERARE")}</option>
                          <option value="KOMMUNADMINISTRATOR">{t("roleNameKOMMUNADMINISTRATOR")}</option>
                        </select>
                      </div>
                    </div>
                    <button type="submit" className={cn(buttonVariants({ size: "sm" }))}>{t("invite")}</button>
                  </form>
                ) : null}
              </CardContent>
            </Card>

            {view.keys ? (
              <Card>
                <CardHeader>
                  <CardTitle>
                  <h2>{t("keys")}</h2>
                </CardTitle>
                  <CardDescription>{t("keysIntro")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {view.keys.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("noKeys")}</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b text-left text-muted-foreground">
                            <th scope="col" className="py-2 pr-3 font-medium">{t("keyColumn")}</th>
                            <th scope="col" className="py-2 pr-3 font-medium">{t("scopesColumn")}</th>
                            <th scope="col" className="py-2 pr-3 font-medium">{t("lastUsedColumn")}</th>
                            <th scope="col" className="py-2 font-medium">{t("actionsColumn")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {view.keys.map((key) => (
                            <tr key={key.id} className="border-b last:border-0">
                              <th scope="row" className="py-2 pr-3 text-left font-normal">{key.name}</th>
                              <td className="py-2 pr-3 font-mono text-xs">{key.scopes.join(", ")}</td>
                              <td className="py-2 pr-3">
                                {key.revokedAt ? t("revoked") : key.lastUsedAt ? dateTime.format(new Date(key.lastUsedAt)) : t("never")}
                              </td>
                              <td className="py-2">
                                {key.revokedAt ? null : (
                                  <form method="post" action={act}>
                                    <input type="hidden" name="huvudman" value={view.id} />
                                    <input type="hidden" name="action" value="revoke" />
                                    <input type="hidden" name="key" value={key.id} />
                                    <button type="submit" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
                                      {t("revoke", { name: key.name })}
                                    </button>
                                  </form>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <CreateKeyForm
                    huvudman={view.id}
                    action={localePath(locale, "/huvudman/keys")}
                    scopes={[...HUVUDMAN_SCOPES]}
                    labels={{
                      title: t("createKeyTitle"),
                      name: t("keyName"),
                      scopes: t("scopes"),
                      submit: t("createKey"),
                      creating: t("creatingKey"),
                      created: t("keyCreated", { name: "{name}" }),
                      failed: t("keyFailed"),
                      notYours: t("errorHUVUDMAN_NOT_YOURS"),
                      copy: t("copyKey"),
                      copied: t("copiedKey"),
                    }}
                  />
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>{t("history")}</h2>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {view.history.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("noHistory")}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th scope="col" className="py-2 pr-3 font-medium">{t("atColumn")}</th>
                          <th scope="col" className="py-2 pr-3 font-medium">{t("schoolColumn")}</th>
                          <th scope="col" className="py-2 pr-3 font-medium">{t("eventColumn")}</th>
                          <th scope="col" className="py-2 font-medium">{t("byColumn")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {view.history.map((event, index) => (
                          <tr key={`${event.at}:${index}`} className="border-b last:border-0">
                            <td className="py-2 pr-3">{dateTime.format(new Date(event.at))}</td>
                            <td className="py-2 pr-3">{event.schoolName}</td>
                            <td className="py-2 pr-3">{t.has(`event${event.kind}`) ? t(`event${event.kind}`) : event.kind}</td>
                            <td className="py-2">{event.bySchool ? t("bySchool") : memberName(event.byMember)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
