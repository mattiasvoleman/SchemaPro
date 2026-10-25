"use client";

import { useEffect, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { labelClassName } from "@/components/ui/label-style";
import { cn } from "@/lib/utils";

/**
 * The one control on the huvudman's pages with client code: a new SS12000
 * key is shown once, so it comes back as JSON to this form (./keys) and is
 * kept in this component's state only, never in a cookie, an address or the
 * page's HTML. The list above shows the key after the next load.
 */
export function CreateKeyForm({
  huvudman,
  action,
  scopes,
  labels,
}: {
  huvudman: string;
  action: string;
  scopes: string[];
  labels: {
    title: string;
    name: string;
    scopes: string;
    submit: string;
    creating: string;
    created: string;
    failed: string;
    notYours: string;
    copy: string;
    copied: string;
  };
}) {
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ name: string; key: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Not before this component runs: the form only ever posts as JSON from
  // here, so before hydration (or without script) it submits nothing at all.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setFailed(null);
    setMade(null);
    setCopied(false);
    try {
      const response = await fetch(action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ huvudman, name: form.get("name"), scopes: form.getAll("scopes") }),
      });
      const body = (await response.json().catch(() => null)) as { name?: string; key?: string; error?: string } | null;
      if (response.ok && body?.key && body.name) {
        setMade({ name: body.name, key: body.key });
      } else {
        setFailed(body?.error === "HUVUDMAN_NOT_YOURS" ? labels.notYours : labels.failed);
      }
    } catch {
      setFailed(labels.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form method="post" action={action} onSubmit={submit} className="space-y-3 rounded-md border p-3">
      <h3 className="text-sm font-semibold">{labels.title}</h3>
      <div className="space-y-1">
        <label htmlFor="huvudman-key-name" className={labelClassName}>
          {labels.name}
        </label>
        <Input id="huvudman-key-name" name="name" required maxLength={100} className="w-64" />
      </div>
      <fieldset className="space-y-1">
        <legend className={labelClassName}>{labels.scopes}</legend>
        <div className="grid gap-1 sm:grid-cols-3">
          {scopes.map((scope) => (
            <label key={scope} className="flex items-center gap-2 font-mono text-xs">
              <input type="checkbox" name="scopes" value={scope} defaultChecked={scope !== "responsibles.read"} />
              {scope}
            </label>
          ))}
        </div>
      </fieldset>
      <button type="submit" disabled={busy || !ready} className={cn(buttonVariants({ size: "sm" }))}>
        {busy ? labels.creating : labels.submit}
      </button>
      <div aria-live="polite">
        {made ? (
          <div className="space-y-1 rounded-md border border-success/40 bg-success/10 p-2 text-sm">
            <p>{labels.created.replace("{name}", made.name)}</p>
            <output className="block break-all font-mono text-xs">{made.key}</output>
            <button
              type="button"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
              onClick={() => {
                void navigator.clipboard?.writeText(made.key).then(() => setCopied(true), () => undefined);
              }}
            >
              {copied ? labels.copied : labels.copy}
            </button>
          </div>
        ) : null}
        {failed ? <p role="alert" className="text-sm text-destructive">{failed}</p> : null}
      </div>
    </form>
  );
}
