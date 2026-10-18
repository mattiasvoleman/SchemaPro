import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import IntegrationsPage from "./page";
import { ProfileProvider } from "@/components/profile-context";
import type { Profile } from "@/lib/types";
import { PERSONAL_MAIL_DOMAINS, domainsOf, isPersonalDomain, sessionFits } from "./sign-in-types";
import type { SignInSettings } from "./sign-in-types";

// Radix's Switch measures its thumb; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * The Inloggning tab of /admin/integrations ("Logga in med skolkonto"), over
 * the real hooks and the real Swedish messages, with the gateway answering
 * by path. What only this tab decides: what is sent for each provider, that
 * a domain list is cleaned before it goes, that "Kräv skolkonto för
 * personal" is live only for an admin signed in with the saved
 * organisation's account (the gateway's own 409, met before it is asked),
 * and that turning school accounts off is confirmed first.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const get = api.get as unknown as Mock;
const put = api.put as unknown as Mock;
const del = api.delete as unknown as Mock;

vi.mock("@/lib/queries", () => ({ usePeople: () => ({ data: [] }) }));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const TENANT = "2f6a1c3e-8b4d-4f5a-9c7e-1d2b3a4c5e6f";
let settings: SignInSettings;

function answer() {
  get.mockImplementation(async (path: string) => {
    if (path === "/api/v1/sign-in-method") return settings;
    if (path === "/api/v1/ss12000-source") throw new ApiError(404, "none", "SS12000_SOURCE_NOT_FOUND");
    return [];
  });
  put.mockImplementation(async (_path: string, body: Record<string, unknown>) => {
    settings = {
      ...settings,
      method: { ...(body as unknown as NonNullable<SignInSettings["method"]>), updatedAt: new Date().toISOString() },
    };
    return settings;
  });
  del.mockImplementation(async () => {
    settings = { ...settings, method: null };
    return { removed: true };
  });
}

/** The tab, as a writer of Integrationer sees it or, with `reader`, a läsare (Läsbehörighet). */
async function openTab(reader = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <ProfileProvider profile={{} as Profile} school={null} readOnly={reader}>
          <IntegrationsPage />
        </ProfileProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  await userEvent.setup().click(screen.getByRole("tab", { name: "Inloggning" }));
  return screen.findByRole("region", { name: "Logga in med skolkonto" });
}

beforeEach(() => {
  vi.resetAllMocks();
  settings = { available: true, method: null, session: { schoolAccount: null } };
  answer();
});

describe("/admin/integrations — Inloggning", () => {
  it("sets up Entra ID: the domains cleaned, the tenant lower case, SSO-only off", async () => {
    const card = await openTab();
    const user = userEvent.setup();
    expect(within(card).getByText("Av")).toBeInTheDocument();
    expect(within(card).getByText("Du är inloggad med lösenord.")).toBeInTheDocument();
    // Nothing to require yet, nothing to turn off.
    expect(within(card).queryByRole("switch")).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Stäng av skolkonton" })).not.toBeInTheDocument();

    const save = within(card).getByRole("button", { name: "Spara inloggningen" });
    expect(save).toBeDisabled();
    await user.type(within(card).getByLabelText("E-postdomäner"), " Skola.Example\nelev.skola.example, skola.example");
    await user.type(within(card).getByLabelText("Klient-id (tenant id)"), TENANT.toUpperCase());
    await user.click(save);

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/api/v1/sign-in-method", {
        provider: "azure",
        domains: ["skola.example", "elev.skola.example"],
        entraTenantId: TENANT,
        googleHostedDomain: null,
        ssoOnlyForStaff: false,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Inloggningen är sparad.");
    expect(await within(await screen.findByRole("region", { name: "Logga in med skolkonto" })).findByText("På")).toBeInTheDocument();
  });

  it("sets up Google Workspace with its domain, and no tenant", async () => {
    const card = await openTab();
    const user = userEvent.setup();
    await user.selectOptions(within(card).getByLabelText("Inloggning"), "google");
    expect(within(card).queryByLabelText("Klient-id (tenant id)")).not.toBeInTheDocument();
    await user.type(within(card).getByLabelText("E-postdomäner"), "skola.example");
    await user.type(within(card).getByLabelText("Workspace-domän"), "Skola.Example");
    await user.click(within(card).getByRole("button", { name: "Spara inloggningen" }));

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/api/v1/sign-in-method", {
        provider: "google",
        domains: ["skola.example"],
        entraTenantId: null,
        googleHostedDomain: "skola.example",
        ssoOnlyForStaff: false,
      }),
    );
  });

  it("says what is wrong with a domain or a tenant at the field, and sends nothing", async () => {
    const card = await openTab();
    const user = userEvent.setup();
    await user.type(within(card).getByLabelText("E-postdomäner"), "https://skola.example");
    await user.type(within(card).getByLabelText("Klient-id (tenant id)"), "not-a-guid");

    expect(within(card).getByLabelText("E-postdomäner")).toHaveAttribute("aria-invalid", "true");
    expect(within(card).getByText(/Skriv varje domän utan @ och utan https/)).toBeInTheDocument();
    expect(within(card).getByLabelText("Klient-id (tenant id)")).toHaveAttribute("aria-invalid", "true");
    expect(within(card).getByRole("button", { name: "Spara inloggningen" })).toBeDisabled();
    expect(put).not.toHaveBeenCalled();
  });

  it("refuses a personal mail domain, listed or as the Workspace domain, at the field, and sends nothing", async () => {
    const card = await openTab();
    const user = userEvent.setup();
    await user.selectOptions(within(card).getByLabelText("Inloggning"), "google");
    await user.type(within(card).getByLabelText("E-postdomäner"), "skola.example\nGmail.com");
    await user.type(within(card).getByLabelText("Workspace-domän"), "hotmail.se");

    expect(within(card).getByLabelText("E-postdomäner")).toHaveAttribute("aria-invalid", "true");
    expect(within(card).getByText(sv.integrations.signIn.domainsPersonal.replace("{domains}", "gmail.com"))).toBeInTheDocument();
    expect(within(card).getByLabelText("Workspace-domän")).toHaveAttribute("aria-invalid", "true");
    expect(within(card).getByText(sv.integrations.signIn.hostedDomainPersonal)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Spara inloggningen" })).toBeDisabled();
    expect(put).not.toHaveBeenCalled();
  });

  it("says which staff domains the school account would leave out, and that a new address moves the login only with a new invitation", async () => {
    settings = {
      available: true,
      method: { provider: "azure", domains: ["skola.example"], entraTenantId: TENANT, googleHostedDomain: null, ssoOnlyForStaff: false, updatedAt: "2026-10-20T08:00:00.000Z" },
      session: { schoolAccount: { provider: "azure", entraTenantId: TENANT } },
    };
    put.mockRejectedValue(
      new ApiError(409, "conflict", "SIGN_IN_SSO_ONLY_LEAVES_STAFF_OUT", { domains: "kommun.example (12), gmail.com (1)" }),
    );
    const card = await openTab();
    await userEvent.setup().click(within(card).getByRole("switch", { name: "Kräv skolkonto för personal" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        sv.integrations.errors.SIGN_IN_SSO_ONLY_LEAVES_STAFF_OUT.replace("{domains}", "kommun.example (12), gmail.com (1)"),
      ),
    );
  });

  it("keeps SSO-only out of reach from a password session, and says why", async () => {
    settings = {
      available: true,
      method: { provider: "azure", domains: ["skola.example"], entraTenantId: TENANT, googleHostedDomain: null, ssoOnlyForStaff: false, updatedAt: "2026-10-20T08:00:00.000Z" },
      session: { schoolAccount: null },
    };
    const card = await openTab();
    const toggle = within(card).getByRole("switch", { name: "Kräv skolkonto för personal" });
    expect(toggle).toBeDisabled();
    expect(within(card).getByText(/Logga in med ett skolkonto från den här organisationen först/)).toBeInTheDocument();
  });

  it("turns SSO-only on from a session signed in with the school's own tenant", async () => {
    settings = {
      available: true,
      method: { provider: "azure", domains: ["skola.example"], entraTenantId: TENANT, googleHostedDomain: null, ssoOnlyForStaff: false, updatedAt: "2026-10-20T08:00:00.000Z" },
      session: { schoolAccount: { provider: "azure", entraTenantId: TENANT } },
    };
    const card = await openTab();
    expect(within(card).getByText("Du är inloggad med ett skolkonto från Microsoft Entra ID.")).toBeInTheDocument();
    await userEvent.setup().click(within(card).getByRole("switch", { name: "Kräv skolkonto för personal" }));

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/api/v1/sign-in-method", {
        provider: "azure",
        domains: ["skola.example"],
        entraTenantId: TENANT,
        googleHostedDomain: null,
        ssoOnlyForStaff: true,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Personalen loggar nu in med skolkonto.");
  });

  it("keeps the saved method on screen for a reader, read-only and not pressable, and marks every change", async () => {
    settings = {
      available: true,
      method: { provider: "azure", domains: ["skola.example"], entraTenantId: TENANT, googleHostedDomain: null, ssoOnlyForStaff: false, updatedAt: "2026-10-20T08:00:00.000Z" },
      session: { schoolAccount: { provider: "azure", entraTenantId: TENANT } },
    };
    const card = await openTab(true);
    // Read, scrolled and copied, by pointer and keyboard, and changed by neither.
    const form = within(card).getByLabelText("E-postdomäner").closest("form")!;
    expect(form).not.toHaveAttribute("data-writes-inert");
    expect(within(card).getByLabelText("E-postdomäner")).toHaveAttribute("readonly");
    expect(within(card).getByRole("combobox", { name: "Inloggning" })).toBeDisabled();
    expect(within(card).getByRole("switch", { name: "Kräv skolkonto för personal" })).toBeDisabled();
    expect(within(form).getByRole("button", { name: "Spara inloggningen" })).toHaveAttribute("data-writes", "INTEGRATIONER");
    // The row, label and all: a press on the label presses the switch, and that saves.
    expect(within(card).getByRole("switch", { name: "Kräv skolkonto för personal" }).closest("[data-writes-inert]")).toHaveAttribute(
      "data-writes-inert",
      "INTEGRATIONER",
    );
    expect(within(card).getByRole("button", { name: "Stäng av skolkonton" }).closest("[data-writes]")).toHaveAttribute(
      "data-writes",
      "INTEGRATIONER",
    );
  });

  it("says the gateway's refusal in words", async () => {
    settings = {
      available: true,
      method: { provider: "azure", domains: ["skola.example"], entraTenantId: TENANT, googleHostedDomain: null, ssoOnlyForStaff: false, updatedAt: "2026-10-20T08:00:00.000Z" },
      session: { schoolAccount: { provider: "azure", entraTenantId: TENANT } },
    };
    put.mockRejectedValue(new ApiError(409, "conflict", "SIGN_IN_SSO_ONLY_NEEDS_OWN_SCHOOL_ACCOUNT"));
    const card = await openTab();
    await userEvent.setup().click(within(card).getByRole("switch", { name: "Kräv skolkonto för personal" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(sv.integrations.errors.SIGN_IN_SSO_ONLY_NEEDS_OWN_SCHOOL_ACCOUNT));
  });

  it("turns school accounts off only after the dialog says what follows", async () => {
    settings = {
      available: true,
      method: { provider: "google", domains: ["skola.example"], entraTenantId: null, googleHostedDomain: "skola.example", ssoOnlyForStaff: true, updatedAt: "2026-10-20T08:00:00.000Z" },
      session: { schoolAccount: { provider: "google", googleHostedDomain: "skola.example" } },
    };
    const card = await openTab();
    const user = userEvent.setup();
    expect(within(card).getByText("Krävs för personal")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Stäng av skolkonton" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Alla loggar in med lösenord igen/)).toBeInTheDocument();
    expect(del).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Stäng av" }));

    await waitFor(() => expect(del).toHaveBeenCalledWith("/api/v1/sign-in-method"));
    expect(toast.success).toHaveBeenCalledWith("Inloggning med skolkonto är avstängd.");
  });

  it("says a domain another school uses with another provider, in words with the domain", async () => {
    put.mockRejectedValue(new ApiError(409, "conflict", "SIGN_IN_DOMAIN_TAKEN", { domains: "delad.example" }));
    const card = await openTab();
    const user = userEvent.setup();
    await user.type(within(card).getByLabelText("E-postdomäner"), "delad.example");
    await user.type(within(card).getByLabelText("Klient-id (tenant id)"), TENANT);
    await user.click(within(card).getByRole("button", { name: "Spara inloggningen" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "En annan skola loggar in med en annan inloggning på delad.example. Ta bort domänen här, eller kontakta den som driftar Rastra Schema om domänen är er.",
      ),
    );
  });

  it("says school accounts are not turned on yet, sends nothing, and still lets a row be removed", async () => {
    settings = {
      available: false,
      method: { provider: "azure", domains: ["skola.example"], entraTenantId: TENANT, googleHostedDomain: null, ssoOnlyForStaff: false, updatedAt: "2026-10-20T08:00:00.000Z" },
      session: { schoolAccount: { provider: "azure", entraTenantId: TENANT } },
    };
    const card = await openTab();
    const user = userEvent.setup();
    expect(within(card).getByText("Inte påslaget än")).toBeInTheDocument();
    await user.type(within(card).getByLabelText("E-postdomäner"), "\nelev.skola.example");
    expect(within(card).getByRole("button", { name: "Spara inloggningen" })).toBeDisabled();
    expect(within(card).getByRole("switch", { name: "Kräv skolkonto för personal" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Stäng av skolkonton" })).toBeEnabled();
    expect(put).not.toHaveBeenCalled();
  });

  it("says the settings could not be read", async () => {
    get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/sign-in-method") throw new ApiError(500, "boom");
      if (path === "/api/v1/ss12000-source") throw new ApiError(404, "none", "SS12000_SOURCE_NOT_FOUND");
      return [];
    });
    await userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
          <IntegrationsPage />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    await userEvent.setup().click(screen.getByRole("tab", { name: "Inloggning" }));
    expect(await screen.findByText("Inloggningen gick inte att läsa.")).toBeInTheDocument();
  });
});

describe("sign-in-types", () => {
  it("reads a domain list from lines, commas and spaces", () => {
    expect(domainsOf(" A.example\n\nb.example, a.example ;c.example ")).toEqual(["a.example", "b.example", "c.example"]);
    expect(domainsOf("")).toEqual([]);
  });

  it("knows the personal mail domains exactly, not their subdomains or look-alikes", () => {
    for (const domain of PERSONAL_MAIL_DOMAINS) expect(isPersonalDomain(domain)).toBe(true);
    expect(isPersonalDomain("skola.example")).toBe(false);
    expect(isPersonalDomain("gmail.com.skola.example")).toBe(false);
    expect(isPersonalDomain("elev.gmail.company")).toBe(false);
  });

  it("fits the session to the row as the gateway does", () => {
    const entra = { provider: "azure" as const, entraTenantId: TENANT, googleHostedDomain: null };
    expect(sessionFits({ provider: "azure", entraTenantId: TENANT }, entra)).toBe(true);
    expect(sessionFits({ provider: "azure", entraTenantId: TENANT }, { ...entra, entraTenantId: TENANT.toUpperCase() })).toBe(true);
    expect(sessionFits({ provider: "azure" }, entra)).toBe(false);
    expect(sessionFits({ provider: "google", googleHostedDomain: "skola.example" }, entra)).toBe(false);
    expect(sessionFits(null, entra)).toBe(false);
    const google = { provider: "google" as const, entraTenantId: null, googleHostedDomain: "skola.example" };
    expect(sessionFits({ provider: "google", googleHostedDomain: "skola.example" }, google)).toBe(true);
    expect(sessionFits({ provider: "google" }, google)).toBe(false);
  });
});
