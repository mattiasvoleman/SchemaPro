import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { api } from "@/lib/api";
import { HuvudmanCard } from "./huvudman-card";
import type { SchoolHuvudman } from "./use-huvudman-ownership";

/**
 * Huvudman on Dataskydd (Huvudman, 20261212090000): who owns the school, who
 * of the owner reads it with which keys, who asks to own it, and the
 * decider's answers, over the real hooks and the Swedish messages.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;
const del = api.delete as unknown as Mock;

const H = "55555555-5555-4555-8555-555555555555";
const H2 = "77777777-7777-4777-8777-777777777777";

const view = (patch: Partial<SchoolHuvudman> = {}): SchoolHuvudman => ({
  owner: null,
  requests: [],
  readers: [],
  keys: [],
  history: [],
  ...patch,
});

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <HuvudmanCard />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("HuvudmanCard", () => {
  beforeEach(() => vi.resetAllMocks());

  it("says the school has no huvudman, and offers nothing", async () => {
    get.mockResolvedValue(view());
    renderCard();
    expect(await screen.findByText("Skolan har ingen huvudman.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(get).toHaveBeenCalledWith("/api/v1/huvudman-ownership");
  });

  it("names the owner, who of it reads the school, and its keys, and lets the decider leave it", async () => {
    get.mockResolvedValue(
      view({
        owner: { id: H, name: "Vimmerby kommun", organisationNumber: "2120000688", since: "2026-10-01T08:00:00.000Z", acceptedBy: "Rut Rektor" },
        readers: [
          { id: "m1", firstName: "Pia", lastName: "Planerare", role: "PLANERARE", isActive: true, ownRow: "INACTIVE" },
          { id: "m2", firstName: "Kim", lastName: "Kommun", role: "KOMMUNADMINISTRATOR", isActive: false, ownRow: null },
        ],
        keys: [{ id: "k1", name: "Elevregistret", scopes: ["persons.read"], createdAt: "2026-10-01T08:00:00.000Z", lastUsedAt: null, revokedAt: null }],
      }),
    );
    del.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderCard();
    expect(await screen.findByText(/Vimmerby kommun är skolans huvudman sedan/)).toHaveTextContent("Godkänt av Rut Rektor.");
    expect(screen.getByText(/^Pia Planerare, planerare/)).toBeInTheDocument();
    // A deactivated row of her own here: she reads as the huvudman's reader in its place.
    expect(screen.getByText(sv.dataProtection.huvudman.ownRowInactive)).toBeInTheDocument();
    expect(screen.queryByText(sv.dataProtection.huvudman.ownRowActive)).toBeNull();
    expect(screen.getByText("Kim Kommun, kommunadministratör (avaktiverad)")).toBeInTheDocument();
    expect(screen.getByText(/Elevregistret · aldrig använd/)).toBeInTheDocument();

    const leave = screen.getByRole("button", { name: "Lämna Vimmerby kommun" });
    expect(leave).toHaveAttribute("data-writes", "DECIDES");
    await user.click(leave);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Lämna Vimmerby kommun" }));
    expect(del).toHaveBeenCalledWith("/api/v1/huvudman-ownership");
  });

  it("answers a question yes or no, and offers no yes while the school has an owner", async () => {
    get.mockResolvedValue(
      view({ requests: [{ huvudmanId: H2, name: "Annan kommun", organisationNumber: null, requestedAt: "2026-10-20T08:00:00.000Z" }] }),
    );
    post.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Godkänn Annan kommun" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Huvudmannens planerare och kommunadministratörer får läsa skolans alla områden");
    await user.click(within(dialog).getByRole("button", { name: "Godkänn Annan kommun" }));
    expect(post).toHaveBeenCalledWith(`/api/v1/huvudman-ownership/requests/${H2}/accept`);
  });

  it("offers no yes to a second huvudman while the school has one", async () => {
    get.mockResolvedValue(
      view({
        owner: { id: H, name: "Vimmerby kommun", organisationNumber: null, since: "2026-10-01T08:00:00.000Z", acceptedBy: null },
        requests: [{ huvudmanId: H2, name: "Annan kommun", organisationNumber: null, requestedAt: "2026-10-20T08:00:00.000Z" }],
      }),
    );
    renderCard();
    expect(await screen.findByRole("button", { name: "Godkänn Annan kommun" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Avböj Annan kommun" })).not.toBeDisabled();
    // Why there is no yes.
    expect(screen.getByText(sv.dataProtection.huvudman.acceptNeedsLeave)).toBeInTheDocument();
  });
});
