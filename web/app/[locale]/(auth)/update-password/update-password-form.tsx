"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { loadClient, warmClient } from "@/utils/supabase/load-client";

/**
 * The browser half of the new-password page. The field is server-rendered and
 * passed in as `children`, the same split as LoginForm.
 *
 * An invitation or recovery link for staff at a school that requires the
 * school account is refused by the access-token hook, and Auth sends the
 * browser here anyway with the refusal in the fragment
 * (#error=…&error_description=sso_required, or the same in the query for a
 * PKCE recovery link). The form then says so and
 * points to the sign-in page, rather than letting the person choose a
 * password nothing will accept.
 */
export function UpdatePasswordForm({
  children,
  home,
  submitClassName,
  labels,
}: {
  children: React.ReactNode;
  /** The locale root, which resolves the profile and redirects by role. */
  home: string;
  submitClassName: string;
  labels: { updatePassword: string; failed: string; linkNeedsSchoolAccount: string };
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refused, setRefused] = useState(false);

  useEffect(() => {
    // The fragment for an invitation link (implicit flow), the query for a
    // recovery link the PKCE client asked for.
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const query = new URLSearchParams(window.location.search);
    if (fragment.get("error_description") === "sso_required" || query.get("error_description") === "sso_required") {
      setRefused(true);
    }
  }, []);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    setError(null);
    setLoading(true);

    let failure: string | null;
    try {
      const supabase = await loadClient();
      const { error: updateError } = await supabase.auth.updateUser({ password });
      failure = updateError ? updateError.message : null;
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
      {refused ? (
        <p role="alert" className="text-sm">
          {labels.linkNeedsSchoolAccount}
        </p>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <button type="submit" className={submitClassName} disabled={loading || refused}>
        {loading ? <Loader2 className="animate-spin" /> : null}
        {labels.updatePassword}
      </button>
    </form>
  );
}
