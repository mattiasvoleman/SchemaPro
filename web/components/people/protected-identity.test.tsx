import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import { ProtectedIdentity } from "./protected-identity";

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api", () => ({ api }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/profile-context", () => ({ useProfile: () => ({ school: { timezone: "Europe/Stockholm" } }) }));

const PUPIL = "11111111-1111-4111-8111-111111111111";
const PATH = `/api/v1/person-protections/${PUPIL}`;
const view = (sources: string[], events: unknown[] = [], linked = true) => ({ userId: PUPIL, sources, linked, events });

function renderMark(writes: boolean, decides: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <ProtectedIdentity userId={PUPIL} writes={writes} decides={decides} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("Skyddad identitet on a person's row", () => {
  beforeEach(() => {
    api.get.mockReset();
    api.put.mockReset().mockResolvedValue(view(["MANUAL"]));
    api.delete.mockReset().mockResolvedValue(view([]));
  });

  it("reads the opened person alone, says they are not marked, and lets whoever writes Personal mark them", async () => {
    api.get.mockResolvedValue(view([]));
    renderMark(true, false);
    expect(await screen.findByText("Inte markerad.")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(PATH);
    expect(screen.queryByRole("button", { name: "Ta bort markeringarna" })).toBeNull();

    api.get.mockResolvedValue(view(["MANUAL"]));
    await userEvent.setup().click(screen.getByRole("button", { name: "Markera skyddad identitet" }));
    expect(api.put).toHaveBeenCalledWith(PATH);
    expect(await screen.findByText("Markerad för hand.")).toBeInTheDocument();
  });

  it("offers a mark by hand beside the register's, which then stands whatever the register says (#263, L1)", async () => {
    api.get.mockResolvedValue(view(["SS12000"]));
    renderMark(true, false);
    expect(await screen.findByText("Markerad. Markeringen kommer från elevregistret (SS12000).")).toBeInTheDocument();
    expect(screen.getByText(/säger registret Ingen föreslår synken att den tas bort/)).toBeInTheDocument();

    api.get.mockResolvedValue(view(["MANUAL", "SS12000"]));
    await userEvent.setup().click(screen.getByRole("button", { name: "Markera för hand också" }));
    expect(await screen.findByText("Markerad för hand och av elevregistret (SS12000).")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Markera/ })).toBeNull();
  });

  it("says when the register's mark was made on an address match, and what to do if it is the wrong person (#263, N1)", async () => {
    api.get.mockResolvedValue(view(["SS12000"], [], false));
    renderMark(true, true);
    expect(await screen.findByText(/en skyddad person i registret har samma e-postadress/)).toBeInTheDocument();
    expect(screen.getByText(/Är det fel person: rätta e-postadressen och ta bort markeringen/)).toBeInTheDocument();
  });

  it("says nothing of an address match for a linked person, or for a mark by hand alone", async () => {
    api.get.mockResolvedValue(view(["SS12000"]));
    renderMark(true, true);
    expect(await screen.findByText("Markerad. Markeringen kommer från elevregistret (SS12000).")).toBeInTheDocument();
    expect(screen.queryByText(/samma e-postadress/)).toBeNull();
  });

  it("lets only those who decide remove the marks (#263, L11)", async () => {
    api.get.mockResolvedValue(view(["MANUAL", "SS12000"]));
    renderMark(true, true);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Ta bort markeringarna" }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith(PATH));
  });

  it("shows who set or removed a mark and when, and the sync or gallring as Rastra (#263, M3)", async () => {
    api.get.mockResolvedValue(
      view(["MANUAL"], [
        { action: "ADDED", source: "MANUAL", actorName: "Rita Rektor", at: "2026-11-05T09:00:00.000Z" },
        { action: "REMOVED", source: "SS12000", actorName: null, at: "2026-11-04T09:00:00.000Z" },
      ]),
    );
    renderMark(false, false);
    const history = await screen.findByRole("list", { name: "Historik för markeringen" });
    expect(history).toHaveTextContent("markerad för hand av Rita Rektor");
    expect(history).toHaveTextContent("registrets markering borttagen av Rastra (synken eller gallringen)");
  });

  it("says the systems connected over SS12000 still get the person (#263, M1), offers no button to a profile that writes nothing, and never names which protection", async () => {
    api.get.mockResolvedValue(view(["MANUAL"]));
    renderMark(false, false);
    expect(await screen.findByText("System som skolan anslutit via SS12000 får personen som förut, utan markering.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Sekretessmarkering|folkbokföring/);
  });

  it("says the mark could not be read rather than that the person is not marked", async () => {
    api.get.mockRejectedValue(new Error("HTTP 500"));
    renderMark(true, true);
    expect(await screen.findByText("Markeringen kunde inte läsas.")).toBeInTheDocument();
    expect(screen.queryByText("Inte markerad.")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
