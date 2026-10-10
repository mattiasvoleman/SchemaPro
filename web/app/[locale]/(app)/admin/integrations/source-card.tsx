"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { CheckCircle2, Loader2, PlugZap, ShieldAlert } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CHECKBOX, NATIVE_SELECT } from "./form-styles";
import { SecretsSection } from "./secrets-section";
import { codeText, errorCodeOf, errorText, formatWhen } from "./ss12000-messages";
import {
  MAX_ORGANISATIONS,
  requiredSecrets,
  type AuthKind,
  type ConnectionTest,
  type SourceInput,
  type SourceView,
  type TokenAuthStyle,
} from "./ss12000-types";
import { useSaveSource, useTestConnection } from "./use-ss12000-source";

/*
 * Källsystem: where the school's register is, how SchemaPro signs in to it,
 * and which of its skolenheter this school is.
 *
 * The address and the sign-in are saved first; the credentials go in below
 * them, one at a time and write-only; "Testa anslutning" then lists the
 * source's skolenheter and the admin picks this school's (1–5). Nothing is
 * read from the register into the school until a sync is run and its diff
 * applied (sync-card.tsx).
 *
 * Changing the register's address or the chosen skolenheter once people are
 * linked is refused by the gateway (409 SS12000_SOURCE_RELINK_REQUIRED) until
 * the admin confirms it here; the next sync is then a full one. A new host
 * also clears the credentials bound to the old one, which the secrets list
 * shows as missing.
 */

const AUTH_KINDS: AuthKind[] = ["OAUTH2_CLIENT_CREDENTIALS", "BEARER_TOKEN", "MTLS_CLIENT_CERT"];
const TOKEN_STYLES: TokenAuthStyle[] = ["BASIC", "FORM"];

interface FormState {
  name: string;
  baseUrl: string;
  authKind: AuthKind;
  tokenUrl: string;
  clientId: string;
  tokenScope: string;
  tokenAuthStyle: TokenAuthStyle;
  pageSize: string;
  enabled: boolean;
}

function formOf(source: SourceView | null): FormState {
  return {
    name: source?.name ?? "",
    baseUrl: source?.baseUrl ?? "",
    authKind: source?.authKind ?? "OAUTH2_CLIENT_CREDENTIALS",
    tokenUrl: source?.tokenUrl ?? "",
    clientId: source?.clientId ?? "",
    tokenScope: source?.tokenScope ?? "",
    tokenAuthStyle: source?.tokenAuthStyle ?? "BASIC",
    pageSize: String(source?.pageSize ?? 1000),
    enabled: source?.enabled ?? true,
  };
}

/** https, no user info, no query or fragment — the gateway's rule (vetSourceUrl), checked early so the admin sees it at the field. */
export function urlProblem(value: string, kind: "base" | "token"): "https" | "userinfo" | "query" | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "https";
  }
  if (url.protocol !== "https:") return "https";
  if (url.username || url.password || /^https:\/\/[^/]*@/i.test(trimmed)) return "userinfo";
  if (trimmed.includes("?") || trimmed.includes("#")) return "query";
  if (kind === "base" && trimmed.endsWith("/")) return "query";
  return null;
}

export function inputOf(form: FormState): SourceInput {
  const usesClient = form.authKind === "OAUTH2_CLIENT_CREDENTIALS" || (form.authKind === "MTLS_CLIENT_CERT" && form.tokenUrl.trim() !== "");
  const pageSize = Number(form.pageSize);
  return {
    name: form.name.trim(),
    baseUrl: form.baseUrl.trim(),
    authKind: form.authKind,
    tokenUrl: usesClient ? form.tokenUrl.trim() || null : null,
    clientId: usesClient ? form.clientId.trim() || null : null,
    tokenScope: usesClient ? form.tokenScope.trim() || null : null,
    tokenAuthStyle: form.tokenAuthStyle,
    ...(Number.isInteger(pageSize) && pageSize >= 100 && pageSize <= 2000 ? { pageSize } : {}),
    enabled: form.enabled,
  };
}

export function SourceCard({ source }: { source: SourceView | null }) {
  const t = useTranslations("integrations.source");
  const tErrors = useTranslations("integrations.errors") as unknown as MessageLookup;
  const tCodes = useTranslations("integrations.codes") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const [form, setForm] = useState<FormState>(() => formOf(source));
  const [relink, setRelink] = useState<{ input: SourceInput; linked: number } | null>(null);
  const [tested, setTested] = useState<ConnectionTest | null>(null);
  const [chosenOrgs, setChosenOrgs] = useState<string[]>(source?.organisationIds ?? []);
  const save = useSaveSource();
  const test = useTestConnection();

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));
  const baseProblem = urlProblem(form.baseUrl, "base");
  const usesClient = form.authKind === "OAUTH2_CLIENT_CREDENTIALS" || form.authKind === "MTLS_CLIENT_CERT";
  const tokenProblem = usesClient ? urlProblem(form.tokenUrl, "token") : null;
  const clientIncomplete =
    form.authKind === "OAUTH2_CLIENT_CREDENTIALS"
      ? form.tokenUrl.trim() === "" || form.clientId.trim() === ""
      : form.authKind === "MTLS_CLIENT_CERT" && (form.tokenUrl.trim() === "") !== (form.clientId.trim() === "");
  const canSave =
    form.name.trim() !== "" && form.baseUrl.trim() !== "" && !baseProblem && !tokenProblem && !clientIncomplete && !save.isPending;

  const submit = (input: SourceInput, okMessage: string) =>
    save.mutate(input, {
      onSuccess: () => {
        setRelink(null);
        toast.success(okMessage);
      },
      onError: (error) => {
        if (errorCodeOf(error) === "SS12000_SOURCE_RELINK_REQUIRED") {
          const linked = (error as { params?: Record<string, string | number> }).params?.["linked"];
          setRelink({ input, linked: Number(linked ?? 0) });
          return;
        }
        toast.error(errorText(tErrors, error, tCommon("error")));
      },
    });

  const missingSecrets = source ? requiredSecrets(source.authKind, source.tokenUrl !== null).filter((kind) => !source.secrets[kind]) : [];

  const runTest = () =>
    test.mutate(undefined, {
      onSuccess: (result) => {
        setTested(result);
        if (result.ok && source && source.organisationIds.length === 0 && result.organisations.length === 1) {
          setChosenOrgs([result.organisations[0]!.id]);
        }
      },
      onError: (error) => toast.error(errorText(tErrors, error, tCommon("error"))),
    });

  const toggleOrg = (id: string, on: boolean) =>
    setChosenOrgs((current) => (on ? [...current, id].slice(0, MAX_ORGANISATIONS) : current.filter((entry) => entry !== id)));
  const orgsChanged =
    source !== null &&
    (chosenOrgs.length !== source.organisationIds.length || chosenOrgs.some((id) => !source.organisationIds.includes(id)));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("body")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) submit(inputOf(form), t("saved"));
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="ss-name">{t("name")}</Label>
              <Input id="ss-name" value={form.name} maxLength={120} placeholder={t("namePlaceholder")} onChange={(e) => set("name", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ss-auth">{t("authKind")}</Label>
              <select id="ss-auth" className={NATIVE_SELECT} value={form.authKind} onChange={(e) => set("authKind", e.target.value as AuthKind)}>
                {AUTH_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`authKinds.${kind}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ss-base">{t("baseUrl")}</Label>
            <Input
              id="ss-base"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={form.baseUrl}
              maxLength={2048}
              placeholder="https://api.ist.com/ss12000v2-api/source/…/v2.0"
              aria-invalid={baseProblem !== null}
              aria-describedby="ss-base-hint"
              onChange={(e) => set("baseUrl", e.target.value)}
            />
            <p id="ss-base-hint" className={`text-xs ${baseProblem ? "text-destructive" : "text-muted-foreground"}`}>
              {baseProblem ? t(`urlProblems.${baseProblem}`) : t("baseUrlHint")}
            </p>
          </div>
          {usesClient ? (
            <div className="space-y-4 rounded-md border p-3">
              <p className="text-xs text-muted-foreground">
                {form.authKind === "MTLS_CLIENT_CERT" ? t("clientOptionalHint") : t("clientHint")}
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="ss-token-url">{t("tokenUrl")}</Label>
                  <Input
                    id="ss-token-url"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    value={form.tokenUrl}
                    maxLength={2048}
                    placeholder="https://skolid.se/connect/token"
                    aria-invalid={tokenProblem !== null}
                    onChange={(e) => set("tokenUrl", e.target.value)}
                  />
                  {tokenProblem ? <p className="text-xs text-destructive">{t(`urlProblems.${tokenProblem}`)}</p> : null}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ss-client-id">{t("clientId")}</Label>
                  <Input id="ss-client-id" autoComplete="off" spellCheck={false} value={form.clientId} maxLength={256} onChange={(e) => set("clientId", e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ss-scope">{t("tokenScope")}</Label>
                  <Input id="ss-scope" autoComplete="off" spellCheck={false} value={form.tokenScope} maxLength={512} onChange={(e) => set("tokenScope", e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ss-style">{t("tokenAuthStyle")}</Label>
                  <select id="ss-style" className={NATIVE_SELECT} value={form.tokenAuthStyle} onChange={(e) => set("tokenAuthStyle", e.target.value as TokenAuthStyle)}>
                    {TOKEN_STYLES.map((style) => (
                      <option key={style} value={style}>
                        {t(`tokenAuthStyles.${style}`)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {clientIncomplete ? <p className="text-xs text-destructive">{t("clientIncomplete")}</p> : null}
            </div>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="ss-page">{t("pageSize")}</Label>
              <Input id="ss-page" type="number" min={100} max={2000} step={100} value={form.pageSize} onChange={(e) => set("pageSize", e.target.value)} />
            </div>
            <div className="flex items-center gap-2 self-end pb-2">
              <Switch id="ss-enabled" checked={form.enabled} onCheckedChange={(checked) => set("enabled", checked)} />
              <Label htmlFor="ss-enabled">{t("enabled")}</Label>
            </div>
          </div>
          <Button type="submit" disabled={!canSave}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            {source ? t("save") : t("create")}
          </Button>
        </form>

        {source ? (
          <>
            <SecretsSection source={source} />

            <section className="space-y-3" aria-labelledby="ss-test-title">
              <h3 id="ss-test-title" className="text-sm font-semibold">
                {t("connectionTitle")}
              </h3>
              <p className="text-sm text-muted-foreground">{t("connectionBody")}</p>
              {missingSecrets.length > 0 ? (
                <p className="flex items-center gap-2 text-sm text-warning-foreground dark:text-warning">
                  <ShieldAlert className="h-4 w-4" aria-hidden />
                  {t("secretsMissing")}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" variant="outline" onClick={runTest} disabled={test.isPending}>
                  {test.isPending ? <Loader2 className="animate-spin" /> : <PlugZap />}
                  {t("test")}
                </Button>
                {source.lastTestedAt ? (
                  <span className="text-xs text-muted-foreground">
                    {t("lastTested", { when: formatWhen(locale, source.lastTestedAt), outcome: codeText(tCodes, source.lastTestOutcome) })}
                  </span>
                ) : null}
              </div>
              {tested ? (
                <div role="status" className={`rounded-md border p-3 text-sm ${tested.ok ? "border-success/40" : "border-destructive/40"}`}>
                  {tested.ok ? (
                    <p className="flex items-center gap-2 font-medium">
                      <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
                      {t("testOk", { count: tested.organisations.length })}
                    </p>
                  ) : (
                    <p className="font-medium">
                      {tested.tokenOk ? t("testFailedAfterToken") : t("testFailed")} {codeText(tCodes, tested.code)}
                    </p>
                  )}
                </div>
              ) : null}

              <div className="space-y-2">
                <h4 className="text-sm font-medium">{t("organisationsTitle")}</h4>
                {tested?.ok && tested.organisations.length > 0 ? (
                  <fieldset className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
                    <legend className="sr-only">{t("organisationsTitle")}</legend>
                    {tested.organisations.map((organisation) => {
                      const checked = chosenOrgs.includes(organisation.id);
                      return (
                        <label key={organisation.id} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted">
                          <input
                            type="checkbox"
                            className={CHECKBOX}
                            checked={checked}
                            disabled={!checked && chosenOrgs.length >= MAX_ORGANISATIONS}
                            onChange={(event) => toggleOrg(organisation.id, event.target.checked)}
                          />
                          <span className="flex-1">{organisation.displayName}</span>
                          {organisation.schoolUnitCode ? (
                            <span className="text-xs text-muted-foreground">{t("unitCode", { code: organisation.schoolUnitCode })}</span>
                          ) : null}
                        </label>
                      );
                    })}
                  </fieldset>
                ) : source.organisationIds.length > 0 ? (
                  <p className="text-sm">
                    {t("organisationsChosen", { count: source.organisationIds.length })}{" "}
                    {source.schoolUnitCodes.length > 0 ? (
                      <span className="text-muted-foreground">{t("unitCodes", { codes: source.schoolUnitCodes.join(", ") })}</span>
                    ) : null}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("organisationsNone")}</p>
                )}
                {tested?.ok && tested.organisations.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={!orgsChanged || chosenOrgs.length === 0 || save.isPending}
                      onClick={() => submit({ ...inputOf(formOf(source)), organisationIds: chosenOrgs }, t("organisationsSaved"))}
                    >
                      {t("organisationsSave")}
                    </Button>
                    <span className="text-xs text-muted-foreground">{t("organisationsLimit", { max: MAX_ORGANISATIONS })}</span>
                  </div>
                ) : null}
              </div>
              {source.incrementalUnsupported ? <Badge variant="warning">{t("incrementalUnsupported")}</Badge> : null}
            </section>
          </>
        ) : null}
      </CardContent>

      <ConfirmDialog
        open={relink !== null}
        onOpenChange={(open) => !open && setRelink(null)}
        title={t("relinkTitle")}
        description={t("relinkBody", { linked: relink?.linked ?? 0 })}
        confirmLabel={t("relinkConfirm")}
        loading={save.isPending}
        onConfirm={() => relink && submit({ ...relink.input, confirmRelink: true }, t("saved"))}
      />
    </Card>
  );
}
