"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { loadClient, warmClient } from "@/utils/supabase/load-client";

export type ForgotPasswordFormLabels = {
  sendResetLink: string;
  resetSent: string;
  /** Shown when the request could not even be sent. */
  failed: string;
};

/**
 * The browser half of the reset page: the submit, its pending state and the
 * confirmation that replaces the form. The fields are server-rendered and
 * passed in as `children`, the same split as LoginForm.
 */
export function ForgotPasswordForm({
  children,
  updatePasswordPath,
  submitClassName,
  labels,
}: {
  children: React.ReactNode;
  /** Locale-prefixed path the emailed link returns to, e.g. /sv/update-password. */
  updatePasswordPath: string;
  submitClassName: string;
  labels: ForgotPasswordFormLabels;
}) {
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    setFailed(false);
    setLoading(true);

    let supabase;
    try {
      supabase = await loadClient();
    } catch {
      // Nothing was sent, so saying it was would be a lie; let them retry.
      setFailed(true);
      setLoading(false);
      return;
    }

    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}${updatePasswordPath}`,
    });

    // Always report success — never reveal whether an email is registered.
    setSent(true);
    setLoading(false);
  };

  if (sent) {
    return <p className="text-sm text-success">{labels.resetSent}</p>;
  }

  return (
    <form onSubmit={handleSubmit} onFocus={warmClient} className="space-y-4">
      {children}
      {failed ? <p className="text-sm text-destructive">{labels.failed}</p> : null}
      <button type="submit" className={submitClassName} disabled={loading}>
        {loading ? <Loader2 className="animate-spin" /> : null}
        {labels.sendResetLink}
      </button>
    </form>
  );
}
