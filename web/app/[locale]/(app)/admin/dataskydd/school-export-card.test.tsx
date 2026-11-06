import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import type { SchoolExportOrder } from "@/lib/school-export";
import type { Person } from "@/lib/types";
import { SchoolExportCard } from "./school-export-card";

/**
 * Hela skolans data och registerutdrag over the real hooks and the real
 * Swedish messages, the gateway answering by path. What this card decides:
 * only rektor and a full administrator are offered anything; an order in hand
 * stops a second and is watched; a finished file is offered while it can be
 * fetched, with what was held out for a protected identity; a refusal is the
 * gateway's sentence by its code; and a registerutdrag says when the person is
 * protected and how many relatives were left out.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;
const del = api.delete as unknown as Mock;
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const me = vi.hoisted(() => ({ profile: { adminProfile: "FULL" as string | null } }));
vi.mock("@/components/profile-context", () => ({ useProfile: () => me }));
const download = vi.hoisted(() => ({ downloadSchoolExport: vi.fn() }));
vi.mock("@/lib/school-export", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/school-export")>()), ...download }));
const files = vi.hoisted(() => ({ saveBase64: vi.fn() }));
vi.mock("@/lib/schedule-exchange", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/schedule-exchange")>()), ...files }));

const order = (patch: Partial<SchoolExportOrder> = {}): SchoolExportOrder => ({
  id: "e1",
  status: "READY",
  requestedAt: "2026-11-05T09:00:00.000Z",
  startedAt: "2026-11-05T09:00:10.000Z",
  finishedAt: "2026-11-05T09:02:00.000Z",
  expiresAt: "2026-11-08T09:02:00.000Z",
  byteSize: 34_900_000,
  sha256: "a".repeat(64),
  files: [],
  heldOut: { people: 2, links: 1 },
  errorClass: null,
  requestedBy: { id: "u", name: "Rek Tor" },
  fetchable: true,
  ...patch,
});
const person = (id: string, firstName: string, lastName: string, role: Person["role"]): Person => ({
  id, firstName, lastName, role, isActive: true, email: `${firstName}@x`, phone: null, invitedAt: null, studentGroupId: null,
});

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <SchoolExportCard />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("Hela skolans data", () => {
  let orders: SchoolExportOrder[];

  beforeEach(() => {
    vi.resetAllMocks();
    me.profile.adminProfile = "FULL";
    orders = [order()];
    get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/school-exports") return orders;
      if (path === "/api/v1/users") return [person("p1", "Ada", "Ek", "STUDENT"), person("g1", "Gun", "Ek", "GUARDIAN")];
      throw new Error(`unexpected GET ${path}`);
    });
  });

  it.each(["SCHEMALAGGARE", "EXPEDITION", "LASARE", null])("offers a %s nothing and asks the gateway nothing", async (adminProfile) => {
    me.profile.adminProfile = adminProfile;
    renderCard();
    expect(await screen.findByText(/lämnas ut av rektor och fullständiga administratörer/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Beställ hela skolans data" })).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("shows a finished file with its size, its time and how many protected persons are not in it, and fetches it", async () => {
    const user = userEvent.setup();
    renderCard();
    await screen.findByText("Klar");
    expect(screen.getByText(/33,3 MB/)).toBeInTheDocument();
    expect(screen.getByText("2 personer med skyddad identitet finns inte i filen.")).toBeInTheDocument();
    expect(screen.getByText(`SHA-256 ${"a".repeat(64)}`)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hämta" }));
    expect(download.downloadSchoolExport).toHaveBeenCalledWith("e1", "rastra-skolexport-2026-11-05.zip");
  });

  it("offers no fetch for a file that has expired or failed, and says why", async () => {
    orders = [order({ id: "x", status: "FAILED", fetchable: false, byteSize: null, sha256: null, errorClass: "RequesterGone", heldOut: null }), order({ id: "y", fetchable: false, expiresAt: "2026-11-05T08:00:00.000Z" })];
    renderCard();
    expect(await screen.findByText("Misslyckades (RequesterGone). Beställ igen.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hämta" })).toBeNull();
    expect(screen.getByText(/har gått ut/)).toBeInTheDocument();
  });

  it("orders once, holds the button while an order is in hand, and watches it", async () => {
    const user = userEvent.setup();
    orders = [];
    post.mockImplementation(async () => {
      orders = [order({ status: "QUEUED", byteSize: null, sha256: null, expiresAt: null, fetchable: false, heldOut: null })];
      return orders[0];
    });
    renderCard();
    await screen.findByText("Ingen beställning ännu.");
    await user.click(screen.getByRole("button", { name: "Beställ hela skolans data" }));
    expect(post).toHaveBeenCalledWith("/api/v1/school-exports");
    expect(await screen.findByText("I kö")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Beställ hela skolans data" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Avbryt" })).toBeInTheDocument();
  });

  it("says the gateway's reason for a refused order, by its code", async () => {
    const user = userEvent.setup();
    orders = [];
    post.mockRejectedValue(new ApiError(429, "x", "SCHOOL_EXPORT_TOO_MANY"));
    renderCard();
    await screen.findByText("Ingen beställning ännu.");
    await user.click(screen.getByRole("button", { name: "Beställ hela skolans data" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Skolan har redan beställt tre gånger det senaste dygnet. Hämta en av de beställda filerna."));
  });

  it("withdraws a file", async () => {
    const user = userEvent.setup();
    del.mockResolvedValue(undefined);
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Ta bort filen" }));
    expect(del).toHaveBeenCalledWith("/api/v1/school-exports/e1");
  });
});

describe("Registerutdrag", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    me.profile.adminProfile = "REKTOR";
    get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/school-exports") return [];
      if (path === "/api/v1/users") return [person("p1", "Ada", "Ek", "STUDENT"), person("g1", "Gun", "Ek", "GUARDIAN")];
      throw new Error(`unexpected GET ${path}`);
    });
  });

  const answer = (patch: object = {}) => ({ filename: "registerutdrag.zip", contentType: "application/zip", contentBase64: "UEs=", subjectIsMarked: false, relatedIncluded: 1, relatedHeldOut: 0, ...patch });

  async function ask(user: ReturnType<typeof userEvent.setup>) {
    renderCard();
    const select = await screen.findByLabelText("Person");
    await within(select).findByRole("option", { name: "Ek, Ada" });
    await user.selectOptions(select, "p1");
    await user.click(screen.getByRole("button", { name: "Hämta registerutdrag" }));
  }

  it("asks for the person and whether relatives come with, and saves the zip at once", async () => {
    const user = userEvent.setup();
    post.mockResolvedValue(answer());
    await ask(user);
    expect(post).toHaveBeenCalledWith("/api/v1/school-exports/subject-access", { personId: "p1", withRelated: true });
    await screen.findByText("Utdraget är hämtat, med 1 närstående.");
    expect(files.saveBase64).toHaveBeenCalledWith("registerutdrag.zip", "application/zip", "UEs=");
  });

  it("warns when the person is protected, and says how many relatives were left out", async () => {
    const user = userEvent.setup();
    post.mockResolvedValue(answer({ subjectIsMarked: true, relatedIncluded: 0, relatedHeldOut: 1 }));
    await ask(user);
    expect(await screen.findByText(/Personen har skyddad identitet\. Utdraget innehåller bara personens egna uppgifter/)).toBeInTheDocument();
    expect(screen.getByText("1 närstående med skyddad identitet är utelämnad.")).toBeInTheDocument();
  });

  it("says so when the extract could not be built", async () => {
    const user = userEvent.setup();
    post.mockRejectedValue(new ApiError(500, "x"));
    await ask(user);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Utdraget kunde inte hämtas."));
    expect(files.saveBase64).not.toHaveBeenCalled();
  });
});
