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

const PUPIL = "11111111-1111-4111-8111-111111111111";

function renderMark(writes: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <ProtectedIdentity userId={PUPIL} writes={writes} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("Skyddad identitet on a person's row", () => {
  beforeEach(() => {
    api.get.mockReset();
    api.put.mockReset().mockResolvedValue({ userId: PUPIL, source: "MANUAL" });
    api.delete.mockReset().mockResolvedValue({ userId: PUPIL, source: null });
  });

  it("says a person is not marked, and lets whoever writes Personal mark them", async () => {
    api.get.mockResolvedValue([]);
    renderMark(true);
    expect(await screen.findByText("Inte markerad.")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("/api/v1/person-protections");

    api.get.mockResolvedValue([{ userId: PUPIL, source: "MANUAL" }]);
    await userEvent.setup().click(screen.getByRole("button", { name: "Markera skyddad identitet" }));
    expect(api.put).toHaveBeenCalledWith(`/api/v1/person-protections/${PUPIL}`);
    expect(await screen.findByText("Markerad för hand.")).toBeInTheDocument();
  });

  it("says a mark from the register is the register's, and that removing it lasts only until the next sync", async () => {
    api.get.mockResolvedValue([{ userId: PUPIL, source: "SS12000" }]);
    renderMark(true);
    expect(await screen.findByText("Markerad. Markeringen kommer från elevregistret (SS12000).")).toBeInTheDocument();
    expect(screen.getByText(/sätts den igen vid nästa synk/)).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "Ta bort markeringen" }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith(`/api/v1/person-protections/${PUPIL}`));
  });

  it("offers no button to a profile that does not write Personal, and never names which protection", async () => {
    api.get.mockResolvedValue([{ userId: PUPIL, source: "MANUAL" }]);
    renderMark(false);
    expect(await screen.findByText("Markerad för hand.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Sekretessmarkering|folkbokföring/);
  });

  it("says the mark could not be read rather than that the person is not marked", async () => {
    api.get.mockRejectedValue(new Error("HTTP 500"));
    renderMark(true);
    expect(await screen.findByText("Markeringen kunde inte läsas.")).toBeInTheDocument();
    expect(screen.queryByText("Inte markerad.")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
