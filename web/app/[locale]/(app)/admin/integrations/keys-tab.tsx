"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, KeyRound, Loader2, Pause, Play, Plus, Trash2 } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { CHECKBOX } from "./form-styles";
import { errorText, formatWhen } from "./ss12000-messages";
import { DEFAULT_SCOPES, SCOPES, type ProviderKey, type ProviderSubscription, type Scope } from "./ss12000-types";
import {
  useCreateKey,
  useCreateWebhookSecret,
  useProviderKeys,
  useRevokeKey,
  useSubscriptionState,
  useUpdateScopes,
} from "./use-integration-keys";

/*
 * API-nycklar: what other systems may read from SchemaPro.
 *
 * Every key has scopes. A key made without a choice reaches exactly what
 * every key reached before scopes existed (the house-shaped /ss12000/v1 and
 * its import), so nothing that works today stops working; a new key can be
 * read-only, or reach only the SS12000 2.1 resources under /ss12000/v2.0. A
 * key's webhook signing secret and its plaintext are each shown once, in the
 * answer that makes them, and never again — the gateway keeps a hash of the
 * key and a sealed copy of the secret.
 *
 * Subscriptions are made by the consuming system (POST /ss12000/v2.0/
 * subscriptions with its key, which needs a signing secret first); the school
 * sees them here, where they go (host only) and how delivery is faring, and
 * can pause one.
 */

const SCOPE_GROUPS: Array<{ key: "v1" | "v2"; scopes: Scope[] }> = [
  { key: "v1", scopes: ["ss12000.v1", "ss12000.v1.import"] },
  { key: "v2", scopes: SCOPES.filter((scope) => !scope.startsWith("ss12000.")) },
];

function ScopePicker({ value, onChange, idPrefix }: { value: Scope[]; onChange: (next: Scope[]) => void; idPrefix: string }) {
  const tScopes = useTranslations("integrations.scopes");
  const toggle = (scope: Scope, on: boolean) =>
    onChange(SCOPES.filter((entry) => (entry === scope ? on : value.includes(entry))));
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {SCOPE_GROUPS.map((group) => (
        <fieldset key={group.key} className="space-y-1 rounded-md border p-2">
          <legend className="px-1 text-xs font-medium">{tScopes(`groups.${group.key}`)}</legend>
          {group.scopes.map((scope) => {
            const id = `${idPrefix}-${scope}`;
            return (
              <div key={scope} className="flex items-start gap-2 text-sm">
                <input
                  id={id}
                  type="checkbox"
                  className={`${CHECKBOX} mt-0.5`}
                  aria-describedby={`${id}-what`}
                  checked={value.includes(scope)}
                  onChange={(event) => toggle(scope, event.target.checked)}
                />
                <div>
                  <label htmlFor={id}>
                    <code className="text-xs">{scope}</code>
                  </label>
                  <span id={`${id}-what`} className="block text-xs text-muted-foreground">
                    {tScopes(`names.${scope.replace(/\./g, "_")}`)}
                  </span>
                </div>
              </div>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}

function OnceNotice({ title, value, hint, onDone }: { title: string; value: string; hint: string; onDone: () => void }) {
  const tCommon = useTranslations("common");
  const t = useTranslations("integrations");
  return (
    <div className="rounded-md border border-warning/50 bg-warning/10 p-3" role="status">
      <p className="mb-2 text-sm font-medium">{title}</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded bg-background px-2 py-1 text-xs">{value}</code>
        <Button
          size="icon"
          variant="outline"
          aria-label={t("keys.copy")}
          onClick={() => {
            void navigator.clipboard.writeText(value);
            toast.success(tCommon("copied"));
          }}
        >
          <Copy />
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{hint}</p>
      <Button className="mt-2" size="sm" variant="outline" onClick={onDone}>
        {t("keys.done")}
      </Button>
    </div>
  );
}

export function KeysTab() {
  const t = useTranslations("integrations");
  const tErrors = useTranslations("integrations.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const keys = useProviderKeys(true);
  const create = useCreateKey();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>([...DEFAULT_SCOPES]);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const list = keys.data ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("createTitle")}</CardTitle>
          <CardDescription>{t("createBody")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input placeholder={t("namePlaceholder")} value={name} maxLength={120} aria-label={t("keys.name")} onChange={(e) => setName(e.target.value)} />
          <ScopePicker value={scopes} onChange={setScopes} idPrefix="new-key" />
          <Button
            onClick={() =>
              create.mutate(
                { name: name.trim() || "Integration", scopes },
                {
                  onSuccess: (result) => {
                    setFreshKey(result.key);
                    setName("");
                    setScopes([...DEFAULT_SCOPES]);
                  },
                  onError: (error) => toast.error(errorText(tErrors, error, tCommon("error"))),
                },
              )
            }
            disabled={create.isPending || scopes.length === 0}
          >
            {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
            {t("create")}
          </Button>
          {freshKey ? <OnceNotice title={t("freshKeyTitle")} value={freshKey} hint={t("freshKeyHint")} onDone={() => setFreshKey(null)} /> : null}
          <p className="text-xs text-muted-foreground">{t("docsHint")}</p>
        </CardContent>
      </Card>

      {keys.isError ? <p role="alert" className="text-sm">{errorText(tErrors, keys.error, tCommon("error"))}</p> : null}
      {keys.data && list.length === 0 ? <EmptyState icon={KeyRound} title={tCommon("noResults")} description={t("empty")} /> : null}
      <ul className="space-y-3">
        {list.map((key) => (
          <KeyRow key={key.id} entry={key} />
        ))}
      </ul>
    </div>
  );
}

function KeyRow({ entry }: { entry: ProviderKey }) {
  const t = useTranslations("integrations");
  const tScopes = useTranslations("integrations.scopes");
  const tErrors = useTranslations("integrations.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const updateScopes = useUpdateScopes();
  const revoke = useRevokeKey();
  const secret = useCreateWebhookSecret();
  const [editing, setEditing] = useState<Scope[] | null>(null);
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [now] = useState(() => Date.now());
  const live = entry.revokedAt === null;
  const onError = (error: unknown) => toast.error(errorText(tErrors, error, tCommon("error")));

  return (
    <li className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{entry.name}</span>
            {live ? <Badge variant="success">{t("active")}</Badge> : <Badge variant="destructive">{t("revoked")}</Badge>}
          </div>
          <div className="text-xs text-muted-foreground">
            {t("created")}: {formatWhen(locale, entry.createdAt)} ·{" "}
            {entry.lastUsedAt ? `${t("lastUsed")}: ${formatWhen(locale, entry.lastUsedAt)}` : t("neverUsed")}
          </div>
        </div>
        {live ? (
          <Button size="sm" variant="outline" onClick={() => setRevoking(true)} disabled={revoke.isPending}>
            <Trash2 />
            {t("revoke")}
          </Button>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs font-medium">{tScopes("title")}</span>
          {entry.scopes.map((scope) => (
            <Badge key={scope} variant="outline">
              {scope}
            </Badge>
          ))}
          {live && editing === null ? (
            <Button size="sm" variant="ghost" onClick={() => setEditing(entry.scopes.filter((scope): scope is Scope => (SCOPES as readonly string[]).includes(scope)))}>
              {tScopes("edit")}
            </Button>
          ) : null}
        </div>
        {editing !== null ? (
          <div className="space-y-2">
            <ScopePicker value={editing} onChange={setEditing} idPrefix={`key-${entry.id}`} />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={editing.length === 0 || updateScopes.isPending}
                onClick={() =>
                  updateScopes.mutate(
                    { id: entry.id, scopes: editing },
                    {
                      onSuccess: () => {
                        toast.success(tScopes("saved"));
                        setEditing(null);
                      },
                      onError,
                    },
                  )
                }
              >
                {tCommon("save")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(null)}>
                {tCommon("cancel")}
              </Button>
            </div>
            {editing.length === 0 ? <p className="text-xs text-destructive">{tScopes("empty")}</p> : null}
          </div>
        ) : null}
      </div>

      {live ? (
        <div className="space-y-2 rounded-md bg-muted/40 p-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs">
              {entry.webhookSecret
                ? t("keys.secretSet", { when: formatWhen(locale, entry.webhookSecret.setAt) })
                : t("keys.secretMissing")}
              {entry.webhookSecret?.previousValidUntil && new Date(entry.webhookSecret.previousValidUntil).getTime() > now
                ? ` ${t("keys.previousValid", { when: formatWhen(locale, entry.webhookSecret.previousValidUntil) })}`
                : ""}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={secret.isPending}
              onClick={() => secret.mutate(entry.id, { onSuccess: (result) => setFreshSecret(result.secret), onError })}
            >
              {secret.isPending ? <Loader2 className="animate-spin" /> : null}
              {entry.webhookSecret ? t("keys.rotateSecret") : t("keys.createSecret")}
            </Button>
          </div>
          {freshSecret ? (
            <OnceNotice title={t("keys.freshSecretTitle")} value={freshSecret} hint={t("keys.freshSecretHint")} onDone={() => setFreshSecret(null)} />
          ) : null}
          <Subscriptions keyId={entry.id} subscriptions={entry.subscriptions} />
        </div>
      ) : null}

      <ConfirmDialog
        open={revoking}
        onOpenChange={setRevoking}
        title={t("keys.revokeTitle", { name: entry.name })}
        description={t("keys.revokeBody")}
        confirmLabel={t("revoke")}
        loading={revoke.isPending}
        onConfirm={() => revoke.mutate(entry.id, { onSuccess: () => setRevoking(false), onError })}
      />
    </li>
  );
}

function subscriptionState(subscription: ProviderSubscription, now: number): "ACTIVE" | "PAUSED" | "FAILING" | "EXPIRED" {
  if (subscription.suspendedReason === "ADMIN") return "PAUSED";
  if (subscription.suspendedAt) return "FAILING";
  if (new Date(subscription.expiresAt).getTime() < now) return "EXPIRED";
  return "ACTIVE";
}

function Subscriptions({ keyId, subscriptions }: { keyId: string; subscriptions: ProviderSubscription[] }) {
  const tSubs = useTranslations("integrations.subscriptions");
  const tErrors = useTranslations("integrations.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const state = useSubscriptionState();
  const [now] = useState(() => Date.now());
  if (subscriptions.length === 0) return <p className="text-xs text-muted-foreground">{tSubs("none")}</p>;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">{tSubs("title", { count: subscriptions.length })}</p>
      <ul className="space-y-1">
        {subscriptions.map((subscription) => {
          const current = subscriptionState(subscription, now);
          const paused = current === "PAUSED" || current === "FAILING";
          return (
            <li key={subscription.id} className="flex flex-wrap items-center justify-between gap-2 rounded border bg-background px-2 py-1 text-xs">
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{subscription.name}</span>
                  <Badge variant={current === "ACTIVE" ? "success" : current === "FAILING" ? "destructive" : "outline"}>{tSubs(`state.${current}`)}</Badge>
                  <span className="text-muted-foreground">{subscription.targetHost}</span>
                </div>
                <p className="text-muted-foreground">
                  {tSubs("details", {
                    resources: subscription.resourceTypes.join(", "),
                    expires: formatWhen(locale, subscription.expiresAt),
                    notified: subscription.lastNotifiedAt ? formatWhen(locale, subscription.lastNotifiedAt) : tSubs("never"),
                  })}
                </p>
                {subscription.failingSince ? (
                  <p className="text-destructive">{tSubs("failing", { since: formatWhen(locale, subscription.failingSince), attempts: subscription.attempts })}</p>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={state.isPending || current === "EXPIRED"}
                onClick={() =>
                  state.mutate(
                    { keyId, subscriptionId: subscription.id, action: paused ? "resume" : "pause" },
                    { onError: (error) => toast.error(errorText(tErrors, error, tCommon("error"))) },
                  )
                }
              >
                {paused ? <Play /> : <Pause />}
                {paused ? tSubs("resume") : tSubs("pause")}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
