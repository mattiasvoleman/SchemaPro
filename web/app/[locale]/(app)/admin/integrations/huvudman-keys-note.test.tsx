import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { api } from "@/lib/api";
import type { SchoolHuvudman } from "../dataskydd/use-huvudman-ownership";
import { HuvudmanKeysNote } from "./huvudman-keys-note";

/**
 * The huvudman's keys on Integrationer (Huvudman, 20261212090000): nothing
 * for a school without one; the keys for the school's decider; for any other
 * administrator, whom the gateway answers keys: null, who sees them, rather
 * than "no keys".
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const get = api.get as unknown as Mock;

const owner = { id: "h", name: "Vimmerby kommun", organisationNumber: null, since: "2026-10-01T08:00:00.000Z", acceptedBy: null };
const view = (patch: Partial<SchoolHuvudman>): SchoolHuvudman => ({ owner, requests: [], readers: [], keys: [], history: [], ...patch });

function renderNote() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <HuvudmanKeysNote />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("HuvudmanKeysNote", () => {
  beforeEach(() => get.mockReset());

  it("lists the keys for the school's decider", async () => {
    get.mockResolvedValue(
      view({ keys: [{ id: "k", name: "Elevregistret", scopes: ["persons.read"], createdAt: "2026-10-01T08:00:00.000Z", lastUsedAt: null, revokedAt: null }] }),
    );
    renderNote();
    expect(await screen.findByText(/Elevregistret/)).toBeInTheDocument();
    expect(screen.queryByText(sv.integrations.huvudmanKeys.notDecider)).toBeNull();
  });

  it("says who sees the keys to an administrator who does not decide, not that there are none", async () => {
    get.mockResolvedValue(view({ keys: null }));
    renderNote();
    expect(await screen.findByText(sv.integrations.huvudmanKeys.notDecider)).toBeInTheDocument();
    expect(screen.queryByText(sv.integrations.huvudmanKeys.none)).toBeNull();
  });

  it("says there are none when the decider's huvudman has none", async () => {
    get.mockResolvedValue(view({ keys: [] }));
    renderNote();
    expect(await screen.findByText(sv.integrations.huvudmanKeys.none)).toBeInTheDocument();
  });
});
