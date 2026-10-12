import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import NoProfilePage from "./page";

/**
 * /no-profile, rendered as the server renders it. The browser suites cannot
 * reach it (without a session the proxy sends it to /login), so this is
 * where its text is pinned: a session that signed in with a school account
 * is told which address it used, any other session gets the general
 * sentence, and a failed claims read never breaks the page.
 */

const claims = vi.hoisted(() => ({ read: (): Promise<unknown> => Promise.resolve({ data: null }) }));

vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => undefined }) }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => ({ auth: { getClaims: () => claims.read() } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined, refresh: () => undefined }) }));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "sv",
  getTranslations: async (namespace: "auth" | "common") => (key: string, values?: Record<string, string>) => {
    const text = (sv[namespace] as Record<string, string>)[key] ?? key;
    return Object.entries(values ?? {}).reduce((out, [name, value]) => out.replace(`{${name}}`, value), text);
  },
}));

beforeEach(() => {
  claims.read = () => Promise.resolve({ data: null });
});

describe("/no-profile", () => {
  it("names the address a school-account session signed in with", async () => {
    claims.read = () =>
      Promise.resolve({ data: { claims: { email: "anna@skola.example", amr: [{ method: "oauth", timestamp: 1 }] } } });
    render(await NoProfilePage());
    expect(
      screen.getByText(sv.auth.noProfileSchoolAccount.replace("{email}", "anna@skola.example")),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: sv.common.signOut })).toBeInTheDocument();
  });

  it("says the general sentence for a password session", async () => {
    claims.read = () => Promise.resolve({ data: { claims: { email: "anna@skola.example", amr: [{ method: "password" }] } } });
    render(await NoProfilePage());
    expect(screen.getByText(sv.auth.noProfile)).toBeInTheDocument();
    expect(screen.queryByText(/anna@skola\.example/)).not.toBeInTheDocument();
  });

  it("says the general sentence when the claims cannot be read", async () => {
    claims.read = () => Promise.reject(new Error("JWKS unreachable"));
    render(await NoProfilePage());
    expect(screen.getByText(sv.auth.noProfile)).toBeInTheDocument();
  });
});
