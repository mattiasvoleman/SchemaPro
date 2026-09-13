"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { loadClient, warmClient } from "@/utils/supabase/load-client";

export type LoginFormLabels = {
  signIn: string;
  signingIn: string;
  invalidCredentials: string;
  /** Shown when the sign-in could not even be attempted. */
  failed: string;
};

/**
 * The part of the sign-in page that runs in the browser, and nothing more.
 *
 * The page renders the card, the labels, the inputs and the links on the
 * server and hands the fields in as `children`; this component owns only what
 * changes after a submit — the error line and the button's pending state.
 * Its text arrives already translated, so neither the message catalogue nor
 * next-intl's client runtime has to reach the browser for it.
 */
export function LoginForm({
  children,
  home,
  submitClassName,
  labels,
}: {
  children: React.ReactNode;
  /** The locale root, which resolves the profile and redirects by role. */
  home: string;
  submitClassName: string;
  labels: LoginFormLabels;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setError(null);
    setLoading(true);

    let failure: string | null;
    try {
      const supabase = await loadClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: String(fields.get("email") ?? ""),
        password: String(fields.get("password") ?? ""),
      });
      failure = signInError ? labels.invalidCredentials : null;
    } catch {
      failure = labels.failed;
    }

    if (failure) {
      setError(failure);
      setLoading(false);
      return;
    }

    router.replace(home);
    router.refresh();
  };

  return (
    <form onSubmit={handleSubmit} onFocus={warmClient} className="space-y-4">
      {children}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <button type="submit" className={submitClassName} disabled={loading}>
        {loading ? (
          <>
            <Loader2 className="animate-spin" />
            {labels.signingIn}
          </>
        ) : (
          labels.signIn
        )}
      </button>
    </form>
  );
}
