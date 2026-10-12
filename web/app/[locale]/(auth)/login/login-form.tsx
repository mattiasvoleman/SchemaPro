"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { emailDomain, isSsoRequired, lookupProvider, providerHints } from "@/lib/school-account";
import { loadClient, warmClient } from "@/utils/supabase/load-client";

export type LoginFormLabels = {
  signIn: string;
  signingIn: string;
  invalidCredentials: string;
  /** Shown when the sign-in could not even be attempted. */
  failed: string;
  /** The school requires its staff to sign in with the school account (the hook's sso_required). */
  ssoRequired: string;
};

/** "Logga in med skolkonto": where to ask, where to come back, and its words. */
export type SchoolAccountOption = {
  /** The gateway's origin, for /public/v1/sign-in-methods/:domain. */
  apiBase: string;
  /** The locale's /auth/callback, which exchanges the code for a session. */
  callbackPath: string;
  className: string;
  labels: {
    button: string;
    or: string;
    redirecting: string;
    /** No address typed yet, or one without a domain. */
    needsEmail: string;
    /** No school signs in with a school account on that domain. */
    notFound: string;
  };
};

/**
 * The part of the sign-in page that runs in the browser, and nothing more.
 *
 * The page renders the card, the labels, the inputs and the links on the
 * server and hands the fields in as `children`; this component owns only what
 * changes after a submit — the error line and the buttons' pending state.
 * Its text arrives already translated, so neither the message catalogue nor
 * next-intl's client runtime has to reach the browser for it.
 *
 * "Logga in med skolkonto" sits in the same form, below the password's
 * button, and reads the address the person already typed: the gateway is
 * asked which provider the address's domain signs in with (only the domain
 * is sent), and Supabase Auth then sends the browser to Entra ID or Google
 * with the address as a hint. The Supabase client stores the PKCE verifier
 * in a cookie, which /auth/callback reads on the way back. Enter in a field
 * still submits the password: the school-account button is type="button".
 */
export function LoginForm({
  children,
  home,
  submitClassName,
  labels,
  schoolAccount,
}: {
  children: React.ReactNode;
  /** The locale root, which resolves the profile and redirects by role. */
  home: string;
  submitClassName: string;
  labels: LoginFormLabels;
  schoolAccount?: SchoolAccountOption;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"password" | "school-account" | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setError(null);
    setPending("password");

    let failure: string | null;
    try {
      const supabase = await loadClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: String(fields.get("email") ?? ""),
        password: String(fields.get("password") ?? ""),
      });
      failure = !signInError
        ? null
        : isSsoRequired(signInError)
          ? labels.ssoRequired
          : labels.invalidCredentials;
    } catch {
      failure = labels.failed;
    }

    if (failure) {
      setError(failure);
      setPending(null);
      return;
    }

    router.replace(home);
    router.refresh();
  };

  const startSchoolAccount = async (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!schoolAccount) return;
    const field = event.currentTarget.form?.elements.namedItem("email");
    const email = field instanceof HTMLInputElement ? field.value : "";
    const domain = emailDomain(email);
    setError(null);
    if (!domain) {
      setError(schoolAccount.labels.needsEmail);
      if (field instanceof HTMLInputElement) field.focus();
      return;
    }

    setPending("school-account");
    let failure: string;
    try {
      const provider = await lookupProvider(schoolAccount.apiBase, domain);
      if (!provider) {
        failure = schoolAccount.labels.notFound;
      } else {
        const supabase = await loadClient();
        const { error: oauthError } = await supabase.auth.signInWithOAuth({
          provider,
          options: {
            redirectTo: new URL(schoolAccount.callbackPath, window.location.origin).toString(),
            queryParams: providerHints(provider, email, domain),
          },
        });
        // On its way to the provider: the button stays busy until the page goes.
        if (!oauthError) return;
        failure = labels.failed;
      }
    } catch {
      failure = labels.failed;
    }
    setError(failure);
    setPending(null);
  };

  return (
    <form onSubmit={handleSubmit} onFocus={warmClient} className="space-y-4">
      {children}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <button type="submit" className={submitClassName} disabled={pending !== null}>
        {pending === "password" ? (
          <>
            <Loader2 className="animate-spin" />
            {labels.signingIn}
          </>
        ) : (
          labels.signIn
        )}
      </button>
      {schoolAccount ? (
        <>
          <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
            <span className="h-px flex-1 bg-border" />
            {schoolAccount.labels.or}
            <span className="h-px flex-1 bg-border" />
          </div>
          <button
            type="button"
            className={schoolAccount.className}
            disabled={pending !== null}
            onClick={startSchoolAccount}
          >
            {pending === "school-account" ? (
              <>
                <Loader2 className="animate-spin" />
                {schoolAccount.labels.redirecting}
              </>
            ) : (
              schoolAccount.labels.button
            )}
          </button>
        </>
      ) : null}
    </form>
  );
}
