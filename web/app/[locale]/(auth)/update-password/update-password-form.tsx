"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { loadClient, warmClient } from "@/utils/supabase/load-client";

/**
 * The browser half of the new-password page. The field is server-rendered and
 * passed in as `children`, the same split as LoginForm.
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
  labels: { updatePassword: string; failed: string };
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <button type="submit" className={submitClassName} disabled={loading}>
        {loading ? <Loader2 className="animate-spin" /> : null}
        {labels.updatePassword}
      </button>
    </form>
  );
}
