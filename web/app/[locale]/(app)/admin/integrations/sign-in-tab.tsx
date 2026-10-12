"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { MessageLookup } from "@/lib/engine-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { NATIVE_SELECT } from "./form-styles";
import {
  MAX_DOMAINS,
  domainsOf,
  isHostname,
  isTenantId,
  sessionFits,
  type SignInMethodInput,
  type SignInMethodView,
  type SignInProvider,
  type SignInSettings,
} from "./sign-in-types";
import { errorText } from "./ss12000-messages";
import { useRemoveSignInMethod, useSaveSignInMethod, useSignInSettings } from "./use-sign-in-method";

/*
 * Inloggning: "Logga in med skolkonto" for the school (migration
 * 20261020090000, src/sign-in).
 *
 * The admin picks Entra ID or Google Workspace, the e-mail domains /login
 * offers the school account for, and the organisation every account must
 * come from: Entra's tenant id or Google's Workspace domain. The
 * access-token hook lets nobody else in, whatever the domains say.
 *
 * "Kräv skolkonto för personal" is a second, separate choice, off until the
 * admin turns it on. The switch is live only for an admin whose own session
 * signed in with an account of the saved organisation, the gateway's own
 * rule (409 SIGN_IN_SSO_ONLY_NEEDS_OWN_SCHOOL_ACCOUNT): turning it on from
 * anywhere else could lock every member of staff out, the admin included.
 * Turning it off is always possible, and so is removing the row, which signs
 * school-account sessions out within the hour; the dialog says so.
 *
 * Until the deployment turns school accounts on (SCHOOL_ACCOUNTS=on, after
 * the hook and the providers are set up) the gateway saves nothing, and the
 * card says so above a form that cannot be sent.
 */

export function SignInTab() {
  const t = useTranslations("integrations.signIn");
  const tErrors = useTranslations("integrations.errors") as unknown as MessageLookup;
  const settings = useSignInSettings();

  if (settings.isLoading) {
    return (
      <div aria-busy="true">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (settings.isError || !settings.data) {
    const reason = settings.isError ? errorText(tErrors, settings.error, "") : "";
    return <LoadError title={t("loadFailed")} hint={reason || undefined} headingLevel={2} />;
  }
  return <SignInCard key={settings.data.method?.updatedAt ?? "none"} settings={settings.data} />;
}

interface FormState {
  provider: SignInProvider;
  domains: string;
  tenant: string;
  hostedDomain: string;
}

function formOf(method: SignInMethodView | null): FormState {
  return {
    provider: method?.provider ?? "azure",
    domains: method?.domains.join("\n") ?? "",
    tenant: method?.entraTenantId ?? "",
    hostedDomain: method?.googleHostedDomain ?? "",
  };
}

function inputOf(form: FormState, ssoOnlyForStaff: boolean): SignInMethodInput {
  return {
    provider: form.provider,
    domains: domainsOf(form.domains),
    entraTenantId: form.provider === "azure" ? form.tenant.trim().toLowerCase() : null,
    googleHostedDomain: form.provider === "google" ? form.hostedDomain.trim().toLowerCase() : null,
    ssoOnlyForStaff,
  };
}

function SignInCard({ settings }: { settings: SignInSettings }) {
  const t = useTranslations("integrations.signIn");
  const tErrors = useTranslations("integrations.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const { available, method, session } = settings;
  const [form, setForm] = useState<FormState>(() => formOf(method));
  const [confirmRemove, setConfirmRemove] = useState(false);
  const save = useSaveSignInMethod();
  const remove = useRemoveSignInMethod();
  const busy = save.isPending || remove.isPending;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const domains = domainsOf(form.domains);
  const domainsProblem =
    form.domains.trim() !== "" && (domains.length > MAX_DOMAINS || !domains.every(isHostname));
  const tenantProblem = form.provider === "azure" && form.tenant.trim() !== "" && !isTenantId(form.tenant);
  const hostedProblem =
    form.provider === "google" && form.hostedDomain.trim() !== "" && !isHostname(form.hostedDomain.trim().toLowerCase());
  const complete =
    domains.length > 0 &&
    (form.provider === "azure" ? form.tenant.trim() !== "" : form.hostedDomain.trim() !== "");
  const input = inputOf(form, method?.ssoOnlyForStaff ?? false);
  const dirty =
    method === null ||
    input.provider !== method.provider ||
    input.entraTenantId !== method.entraTenantId ||
    input.googleHostedDomain !== method.googleHostedDomain ||
    input.domains.join("\n") !== method.domains.join("\n");
  const canSave = available && complete && !domainsProblem && !tenantProblem && !hostedProblem && dirty && !busy;

  const persist = (next: SignInMethodInput, okMessage: string) =>
    save.mutate(next, {
      onSuccess: () => toast.success(okMessage),
      onError: (error) => toast.error(errorText(tErrors, error, tCommon("error"))),
    });

  const fits = method !== null && sessionFits(session.schoolAccount, method);
  const status = method === null ? t("statusOff") : method.ssoOnlyForStaff ? t("statusSsoOnly") : t("statusOn");
  const signedInWith =
    session.schoolAccount === null
      ? t("signedInWithPassword")
      : session.schoolAccount.provider === "azure"
        ? t("signedInWithAzure")
        : t("signedInWithGoogle");

  return (
    <SectionCard
      id="sign-in-card"
      title={t("title")}
      description={t("body")}
      action={<Badge variant={method === null ? "outline" : "success"}>{status}</Badge>}
    >
      <div className="space-y-6">
        {!available ? (
          <Notice title={t("notAvailableTitle")}>{t("notAvailableBody")}</Notice>
        ) : null}
        <p className="text-sm text-muted-foreground">{signedInWith}</p>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) persist(input, t("saved"));
          }}
        >
          <FormField id="sign-in-provider" label={t("provider")}>
            <select
              className={NATIVE_SELECT}
              value={form.provider}
              onChange={(event) => set("provider", event.target.value as SignInProvider)}
            >
              <option value="azure">{t("providerAzure")}</option>
              <option value="google">{t("providerGoogle")}</option>
            </select>
          </FormField>
          <FormField
            id="sign-in-domains"
            label={t("domains")}
            hint={domainsProblem ? undefined : t("domainsHint")}
            error={domainsProblem ? t("domainsInvalid") : undefined}
          >
            <Textarea
              rows={3}
              autoComplete="off"
              spellCheck={false}
              value={form.domains}
              onChange={(event) => set("domains", event.target.value)}
            />
          </FormField>
          {form.provider === "azure" ? (
            <FormField
              id="sign-in-tenant"
              label={t("tenant")}
              hint={tenantProblem ? undefined : t("tenantHint")}
              error={tenantProblem ? t("tenantInvalid") : undefined}
            >
              <Input
                autoComplete="off"
                spellCheck={false}
                maxLength={36}
                value={form.tenant}
                onChange={(event) => set("tenant", event.target.value)}
              />
            </FormField>
          ) : (
            <FormField
              id="sign-in-hd"
              label={t("hostedDomain")}
              hint={hostedProblem ? undefined : t("hostedDomainHint")}
              error={hostedProblem ? t("hostedDomainInvalid") : undefined}
            >
              <Input
                autoComplete="off"
                spellCheck={false}
                maxLength={253}
                value={form.hostedDomain}
                onChange={(event) => set("hostedDomain", event.target.value)}
              />
            </FormField>
          )}
          <Button type="submit" size="sm" disabled={!canSave}>
            {t("save")}
          </Button>
        </form>

        {method !== null ? (
          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <Label htmlFor="sign-in-sso-only">{t("ssoOnly")}</Label>
                <p id="sign-in-sso-only-hint" className="text-xs text-muted-foreground">
                  {t("ssoOnlyBody")}
                </p>
              </div>
              <Switch
                id="sign-in-sso-only"
                checked={method.ssoOnlyForStaff}
                disabled={busy || !available || (!method.ssoOnlyForStaff && !fits)}
                aria-describedby={
                  !method.ssoOnlyForStaff && !fits ? "sign-in-sso-only-hint sign-in-sso-only-needs" : "sign-in-sso-only-hint"
                }
                onCheckedChange={(checked) =>
                  persist(
                    {
                      provider: method.provider,
                      domains: method.domains,
                      entraTenantId: method.entraTenantId,
                      googleHostedDomain: method.googleHostedDomain,
                      ssoOnlyForStaff: checked,
                    },
                    checked ? t("ssoOnlySaved") : t("ssoOnlyOff"),
                  )
                }
              />
            </div>
            {!method.ssoOnlyForStaff && !fits ? (
              <p id="sign-in-sso-only-needs" className="text-xs text-foreground">
                {t("ssoOnlyNeedsOwn")}
              </p>
            ) : null}
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground">{t("setupHint")}</p>

        {method !== null ? (
          <div className="flex justify-end border-t pt-4">
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirmRemove(true)}>
              {t("remove")}
            </Button>
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={t("removeTitle")}
        description={t("removeBody")}
        confirmLabel={t("removeConfirm")}
        destructive
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => {
              setConfirmRemove(false);
              toast.success(t("removed"));
            },
            onError: (error) => toast.error(errorText(tErrors, error, tCommon("error"))),
          })
        }
      />
    </SectionCard>
  );
}
