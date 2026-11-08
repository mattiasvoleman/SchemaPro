import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { TYPE_BUS, TYPE_TABLETS, resource } from "@/lib/__fixtures__/local";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import ResourcesPage from "./page";

// Environment shims for Radix in jsdom — not behaviour under test.
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * Resurser, the administrator's page (/admin/resources), through the gateway's routes and the real messages:
 * a key missing from sv.json or en.json throws here instead of printing its path.
 *
 * What this guards: a failed read is said as such and never "nothing here"; a kind and a resource are made,
 * changed and removed through the routes of src/local/local.controllers.ts with the body the DTOs take; a
 * form is refused before it is sent and the sentence names the field; a kind in use, and a resource a series
 * stands on, are said to be kept rather than shown a raw error; and every control that writes is Planering's.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const state = vi.hoisted(() => ({
  types: undefined as unknown,
  resources: undefined as unknown,
  sites: undefined as unknown,
  typesError: false,
  resourcesError: false,
}));

function renderPage(locale: "sv" | "en" = "sv") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider
        locale={locale}
        messages={locale === "sv" ? sv : en}
        timeZone="Europe/Stockholm"
        onError={(error) => {
          throw error;
        }}
      >
        <ResourcesPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.types = [TYPE_TABLETS, TYPE_BUS];
  state.resources = [resource(), resource({ id: "r-2", name: "Minibuss", resourceTypeId: "t-2", resourceTypeName: "Minibuss", quantity: 1, place: null, requiresApproval: true })];
  state.sites = { sites: [{ id: "site-1", name: "Norra", roomCount: 2 }], travelTimes: [], roomsWithoutSite: 0 };
  state.typesError = false;
  state.resourcesError = false;
  api.get.mockImplementation(async (path: string) => {
    if (path === "/api/v1/resource-types") {
      if (state.typesError) throw new ApiError(500, "boom");
      return state.types;
    }
    if (path === "/api/v1/resources") {
      if (state.resourcesError) throw new ApiError(500, "boom");
      return state.resources;
    }
    if (path === "/api/v1/sites") return state.sites;
    throw new Error(`unexpected read ${path}`);
  });
  api.post.mockImplementation(async (_path: string, body: object) => ({ id: "new", ...body }));
  api.patch.mockImplementation(async (_path: string, body: object) => ({ id: "x", ...body }));
  api.delete.mockResolvedValue(undefined);
});

const typesCard = async () => within(await screen.findByRole("region", { name: "Resurstyper" }));

describe("Resurser, the administrator's page", () => {
  it("is busy until the lists are read, then names the kinds with their counts and the resources with their place", async () => {
    renderPage();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();

    const kinds = await typesCard();
    expect(await kinds.findByText("Surfplattor")).toBeInTheDocument();
    expect(kinds.getByText("1 resurs")).toBeInTheDocument();
    expect(kinds.getByText("0 resurser")).toBeInTheDocument();

    const table = await screen.findByRole("table", { name: "Skolans resurser" });
    const bus = within(table).getByRole("row", { name: /Minibuss/ });
    expect(within(bus).getByText("Kräver godkännande")).toBeInTheDocument();
    expect(within(table).getByRole("row", { name: /Surfplattor klass 7/ })).toHaveTextContent("Skåp 3 i B-huset");
    expect(screen.getByRole("heading", { level: 1, name: "Resurser" })).toBeInTheDocument();
  });

  it("is in English too, with the same structure", async () => {
    renderPage("en");
    expect(await screen.findByRole("heading", { level: 1, name: "Resources" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "The school’s resources" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add resource type" })).toBeInTheDocument();
  });

  it("says a failed read is a failed read, in each card, and not that there is nothing", async () => {
    state.typesError = true;
    state.resourcesError = true;
    renderPage();
    expect(await screen.findByText("Resurstyperna kunde inte hämtas")).toBeInTheDocument();
    expect(await screen.findByText("Resurserna kunde inte hämtas")).toBeInTheDocument();
    expect(screen.queryByText(/Inga resurstyper ännu/)).not.toBeInTheDocument();
    expect(screen.queryByText("Inga resurser ännu.")).not.toBeInTheDocument();
  });

  it("asks for a kind before a resource when the school has none", async () => {
    state.types = [];
    state.resources = [];
    renderPage();
    expect(await screen.findByText(/Inga resurstyper ännu/)).toBeInTheDocument();
    expect(await screen.findByText("Inga resurser ännu.")).toBeInTheDocument();
    expect(screen.getByText("Lägg till en resurstyp först.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lägg till resurs" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Lägg till resurs" })).toHaveAccessibleDescription("Lägg till en resurstyp först.");
  });

  it("marks every control that writes as Planering's, so the läsare is shown none of them", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Skolans resurser" });
    for (const name of ["Lägg till resurstyp", "Lägg till resurs", "Byt namn på resurstypen Surfplattor", "Ta bort resurstypen Surfplattor", "Redigera Minibuss", "Ta bort Minibuss"]) {
      expect(screen.getByRole("button", { name }).closest("[data-writes]")).toHaveAttribute("data-writes", "PLANERING");
    }
  });

  it("adds a kind: refused empty with the field named, then posted trimmed", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Lägg till resurstyp" }));
    const dialog = await screen.findByRole("dialog", { name: "Lägg till resurstyp" });

    await user.click(within(dialog).getByRole("button", { name: "Spara" }));
    expect(within(dialog).getByText("Fyll i det här fältet.")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    await user.type(within(dialog).getByRole("textbox", { name: "Namn" }), "  Laptops ");
    await user.click(within(dialog).getByRole("button", { name: "Spara" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/v1/resource-types", { name: "Laptops" }));
    expect(toast.success).toHaveBeenCalledWith("Skapad");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("renames a kind from its own name, by its id", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Byt namn på resurstypen Minibuss" }));
    const dialog = await screen.findByRole("dialog", { name: "Byt namn på resurstypen" });
    const name = within(dialog).getByRole("textbox", { name: "Namn" });
    expect(name).toHaveValue("Minibuss");
    await user.clear(name);
    await user.type(name, "Buss");
    await user.click(within(dialog).getByRole("button", { name: "Spara" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/api/v1/resource-types/t-2", { name: "Buss" }));
    expect(toast.success).toHaveBeenCalledWith("Sparad");
  });

  it("says a kind with resources is in use, and does not ask the gateway", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Ta bort resurstypen Surfplattor" }));
    expect(await screen.findByText("Resurstypen Surfplattor används")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("removes a kind with none, after the question", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Ta bort resurstypen Minibuss" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Ta bort Minibuss?");
    expect(api.delete).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Ta bort" }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/api/v1/resource-types/t-2"));
    expect(toast.success).toHaveBeenCalledWith("Borttagen");
  });

  it("says a kind is in use when the gateway finds a resource the page did not know", async () => {
    api.delete.mockRejectedValueOnce(new ApiError(400, "Slaget används av 1 resurs(er)"));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Ta bort resurstypen Minibuss" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Ta bort" }));
    expect(await screen.findByText("Resurstypen Minibuss används")).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("adds a resource with every key of the body, and refuses a quantity the DTO would", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Lägg till resurs" }));
    const dialog = await screen.findByRole("dialog", { name: "Lägg till resurs" });

    await user.click(within(dialog).getByRole("button", { name: "Spara" }));
    expect(within(dialog).getAllByText("Fyll i det här fältet.")).toHaveLength(2);
    expect(api.post).not.toHaveBeenCalled();

    await user.type(within(dialog).getByRole("textbox", { name: "Namn" }), "Aulan");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Typ" }), "t-2");
    const quantity = within(dialog).getByRole("spinbutton", { name: "Antal" });
    await user.clear(quantity);
    await user.type(quantity, "5000");
    await user.click(within(dialog).getByRole("button", { name: "Spara" }));
    expect(within(dialog).getByText("Ange ett heltal från 1 till 1000.")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    await user.clear(quantity);
    await user.type(quantity, "1");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: /Skolområde/ }), "site-1");
    await user.type(within(dialog).getByRole("textbox", { name: /Plats/ }), "Entréplan");
    await user.click(within(dialog).getByRole("switch", { name: "Kräver godkännande" }));
    await user.click(within(dialog).getByRole("button", { name: "Spara" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/v1/resources", {
        name: "Aulan",
        resourceTypeId: "t-2",
        quantity: 1,
        siteId: "site-1",
        place: "Entréplan",
        requiresApproval: true,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Skapad");
  });

  it("edits a resource from its row: the form starts from it and a cleared place is sent as null", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Redigera Surfplattor klass 7" }));
    const dialog = await screen.findByRole("dialog", { name: "Ändra resurs" });
    expect(within(dialog).getByRole("textbox", { name: "Namn" })).toHaveValue("Surfplattor klass 7");
    expect(within(dialog).getByRole("combobox", { name: "Typ" })).toHaveValue("t-1");
    expect(within(dialog).getByRole("spinbutton", { name: "Antal" })).toHaveValue(30);
    await user.clear(within(dialog).getByRole("textbox", { name: /Plats/ }));
    await user.click(within(dialog).getByRole("button", { name: "Spara" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/v1/resources/r-1", {
        name: "Surfplattor klass 7",
        resourceTypeId: "t-1",
        quantity: 30,
        siteId: null,
        place: null,
        requiresApproval: false,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Sparad");
  });

  it("says why a save was refused, in a toast, and keeps the form", async () => {
    api.patch.mockRejectedValueOnce(new ApiError(400, "Ett lägre antal än en senare bokning håller."));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Redigera Surfplattor klass 7" }));
    const dialog = await screen.findByRole("dialog", { name: "Ändra resurs" });
    await user.click(within(dialog).getByRole("button", { name: "Spara" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Ett lägre antal än en senare bokning håller."));
    expect(screen.getByRole("dialog", { name: "Ändra resurs" })).toBeInTheDocument();
  });

  it("removes a resource after the question, and says a resource a series stands on is kept", async () => {
    const user = userEvent.setup();
    renderPage();
    const table = await screen.findByRole("table", { name: "Skolans resurser" });
    await user.click(within(table).getByRole("button", { name: "Ta bort Minibuss" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Ta bort Minibuss?");
    expect(dialog).toHaveTextContent("Resursen och alla dess bokningar tas bort.");
    api.delete.mockRejectedValueOnce(new ApiError(409, "Resursen hyrs ut i 1 serie(r)", "RESOURCE_IS_LET_OUT"));
    await user.click(within(dialog).getByRole("button", { name: "Ta bort" }));
    expect(await screen.findByText("Minibuss kan inte tas bort")).toBeInTheDocument();
    expect(screen.getByText(/Resursen finns kvar tills serien gallras/)).toBeInTheDocument();
    expect(api.delete).toHaveBeenCalledWith("/api/v1/resources/r-2");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("says another refusal of a removal as it came", async () => {
    api.delete.mockRejectedValueOnce(new ApiError(500, "boom"));
    const user = userEvent.setup();
    renderPage();
    const table = await screen.findByRole("table", { name: "Skolans resurser" });
    await user.click(within(table).getByRole("button", { name: "Ta bort Minibuss" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Ta bort" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("boom"));
  });
});
