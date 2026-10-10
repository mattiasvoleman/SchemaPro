import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { api } from "@/lib/api";
import IntegrationsPage from "./page";
import type { ProviderKey } from "./ss12000-types";

/**
 * /admin/integrations over the real hooks and the real Swedish messages (an
 * untranslated key or an unfilled ICU argument throws), with the gateway
 * answering by path. What only this page decides: that a new key's scopes,
 * its signing secret and its subscriptions are what the gateway is sent, and
 * that a key and a secret are each shown once.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;
const patch = api.patch as unknown as Mock;

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const KEY: ProviderKey = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Vklass",
  scopes: ["ss12000.v1", "ss12000.v1.import"],
  lastUsedAt: null,
  revokedAt: null,
  createdAt: "2026-09-01T08:00:00.000Z",
  webhookSecret: null,
  subscriptions: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Vklass schema",
      targetHost: "hooks.vklass.example",
      resourceTypes: ["CalendarEvent"],
      expiresAt: "2099-01-01T00:00:00.000Z",
      suspendedAt: null,
      suspendedReason: null,
      lastNotifiedAt: null,
      failingSince: null,
      attempts: 0,
      createdAt: "2026-09-02T08:00:00.000Z",
    },
  ],
};

const server = vi.hoisted(() => ({ keys: [] as unknown[] }));

function answer() {
  get.mockImplementation(async (path: string) => {
    if (path === "/api/v1/integration-keys/provider") return server.keys;
    throw new Error(`unexpected GET ${path}`);
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <IntegrationsPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("/admin/integrations — API keys", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    server.keys = [KEY];
    answer();
  });

  it("creates a key with the scopes chosen, starting from today's v1 reach, and shows it once", async () => {
    const user = userEvent.setup();
    post.mockResolvedValueOnce({ id: "k2", name: "Bibliotek", createdAt: "2026-10-10T10:00:00.000Z", key: "sp_abc123" });
    renderPage();
    const name = await screen.findByLabelText("Nyckelns namn");
    const card = name.closest("div.rounded-xl, div.rounded-lg, div[class*='card']") ?? document.body;
    expect(within(card as HTMLElement).getByRole("checkbox", { name: "ss12000.v1" })).toBeChecked();
    await user.type(name, "Bibliotek");
    await user.click(within(card as HTMLElement).getByRole("checkbox", { name: "ss12000.v1.import" }));
    await user.click(within(card as HTMLElement).getByRole("checkbox", { name: "persons.read" }));
    await user.click(screen.getByRole("button", { name: "Skapa nyckel" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/integration-keys", { name: "Bibliotek", scopes: ["ss12000.v1", "persons.read"] }),
    );
    expect(await screen.findByText("sp_abc123")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Jag har sparat den" }));
    expect(screen.queryByText("sp_abc123")).toBeNull();
  });

  it("makes a signing secret, shown once, and pauses a subscription", async () => {
    const user = userEvent.setup();
    post.mockImplementation(async (path: string) => {
      if (path.endsWith("/webhook-secret")) return { id: KEY.id, secret: "whsec_xyz", setAt: "2026-10-10T10:00:00.000Z" };
      if (path.endsWith("/pause")) return { id: "s", state: "PAUSED" };
      throw new Error(`unexpected POST ${path}`);
    });
    renderPage();
    expect(await screen.findByText("Ingen signeringshemlighet: systemet kan inte prenumerera på ändringar förrän en finns.")).toBeInTheDocument();
    expect(screen.getByText("hooks.vklass.example")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skapa signeringshemlighet" }));
    expect(await screen.findByText("whsec_xyz")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pausa" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/api/v1/integration-keys/${KEY.id}/subscriptions/${KEY.subscriptions[0]!.id}/pause`),
    );
  });

  it("changes a key's scopes and refuses an empty set", async () => {
    const user = userEvent.setup();
    patch.mockResolvedValueOnce({ id: KEY.id, scopes: ["ss12000.v1"] });
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Ändra omfång" }));
    const row = screen.getByText("Vklass").closest("li") as HTMLElement;
    await user.click(within(row).getByRole("checkbox", { name: "ss12000.v1.import" }));
    await user.click(within(row).getByRole("checkbox", { name: "ss12000.v1" }));
    expect(within(row).getByText("Välj minst ett omfång.")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Spara" })).toBeDisabled();
    await user.click(within(row).getByRole("checkbox", { name: "ss12000.v1" }));
    await user.click(within(row).getByRole("button", { name: "Spara" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith(`/api/v1/integration-keys/${KEY.id}`, { scopes: ["ss12000.v1"] }));
  });
});
