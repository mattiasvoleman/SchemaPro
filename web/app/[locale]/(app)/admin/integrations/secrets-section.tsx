"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { KeyRound, Loader2 } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { errorText, formatWhen } from "./ss12000-messages";
import { secretKindsFor, type SecretKind, type SourceView } from "./ss12000-types";
import { useClearSecret, useSetSecret } from "./use-ss12000-source";

/*
 * The source's credentials, write-only.
 *
 * Each field starts empty and stays empty: the gateway answers only that a
 * credential exists and since when (GET /api/v1/ss12000-source's
 * `secrets`), so there is nothing to show back and nothing is shown. A value
 * typed here lives in this component's state until it is sent, and the field
 * is cleared the moment the gateway has it — on success and on failure, so a
 * refused secret is not left on screen either. A PEM key or certificate is
 * checked by the gateway when saved (SS12000_KEY_PEM_INVALID,
 * SS12000_CERT_PEM_INVALID); the refusal names the kind, never the value.
 *
 * A credential is bound to the host it is sent to. When the address changes
 * the gateway clears it, and the row here says it is missing again.
 */

const PEM: ReadonlySet<SecretKind> = new Set(["CLIENT_KEY_PEM", "CLIENT_CERT_PEM"]);

export function SecretsSection({ source }: { source: SourceView }) {
  const t = useTranslations("integrations.secrets");
  const kinds = secretKindsFor(source.authKind, source.tokenUrl !== null);
  return (
    <section className="space-y-3" aria-labelledby="ss-secrets-title">
      <h3 id="ss-secrets-title" className="flex items-center gap-2 text-sm font-semibold">
        <KeyRound className="h-4 w-4" aria-hidden />
        {t("title")}
      </h3>
      <p className="text-sm text-muted-foreground">{t("body")}</p>
      <div className="space-y-3">
        {kinds.map((kind) => (
          <SecretRow key={kind} kind={kind} setAt={source.secrets[kind]?.setAt ?? null} optional={source.authKind === "MTLS_CLIENT_CERT" && kind === "BEARER_TOKEN"} />
        ))}
      </div>
    </section>
  );
}

function SecretRow({ kind, setAt, optional }: { kind: SecretKind; setAt: string | null; optional: boolean }) {
  const t = useTranslations("integrations.secrets");
  const tErrors = useTranslations("integrations.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const [value, setValue] = useState("");
  const setSecret = useSetSecret();
  const clear = useClearSecret();
  const id = `ss-secret-${kind}`;

  const submit = () => {
    const sent = value;
    setSecret.mutate(
      { kind, value: sent },
      {
        onSuccess: () => toast.success(t("saved", { kind: t(`kinds.${kind}`) })),
        onError: (error) => toast.error(errorText(tErrors, error, tCommon("error"))),
        onSettled: () => setValue(""),
      },
    );
  };

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor={id}>{t(`kinds.${kind}`)}</Label>
        {setAt ? (
          <Badge variant="success">{t("setAt", { when: formatWhen(locale, setAt) })}</Badge>
        ) : (
          <Badge variant={optional ? "outline" : "warning"}>{optional ? t("optional") : t("missing")}</Badge>
        )}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        {PEM.has(kind) ? (
          <Textarea
            id={id}
            className="min-h-24 font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
            placeholder={kind === "CLIENT_KEY_PEM" ? "-----BEGIN PRIVATE KEY-----" : "-----BEGIN CERTIFICATE-----"}
            value={value}
            maxLength={16_384}
            onChange={(event) => setValue(event.target.value)}
          />
        ) : (
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={value}
            maxLength={16_384}
            placeholder={setAt ? t("replacePlaceholder") : t("placeholder")}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
        <div className="flex gap-2">
          <Button type="button" size="sm" onClick={submit} disabled={value.trim() === "" || setSecret.isPending}>
            {setSecret.isPending ? <Loader2 className="animate-spin" /> : null}
            {setAt ? t("replace") : t("save")}
          </Button>
          {setAt ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={clear.isPending}
              onClick={() =>
                clear.mutate(kind, {
                  onSuccess: () => toast.success(t("cleared", { kind: t(`kinds.${kind}`) })),
                  onError: (error) => toast.error(errorText(tErrors, error, tCommon("error"))),
                })
              }
            >
              {t("clear")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
