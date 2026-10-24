import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { api } from "@/lib/api";
import type { MySchool } from "@/lib/types";
import { OtherSchools } from "./other-schools";

/**
 * Flera skolor per inloggning: the children at a guardian's other schools,
 * each list read with that school's id, so that school's row security
 * answers it and its läslogg records it.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn() } };
});
const get = api.get as unknown as Mock;

const school = (id: string, name: string, extra: Partial<MySchool> = {}): MySchool => ({
  schoolId: id,
  schoolName: name,
  role: "GUARDIAN",
  adminProfile: null,
  closed: null,
  current: false,
  ...extra,
});
const B = school("44444444-4444-4444-8444-444444444444", "Granen");
const C = school("55555555-5555-4555-8555-555555555555", "Hagen");

const renderCard = (schools: MySchool[]) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <OtherSchools schools={schools} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  get.mockReset();
});

describe("OtherSchools", () => {
  it("reads each school's children with that school's id, and names the active ones", async () => {
    get.mockImplementation((_path: string, options?: { school?: string }) =>
      Promise.resolve(
        options?.school === B.schoolId
          ? [
              { linkId: "l", id: "c-1", firstName: "Olle", lastName: "Granlund", isActive: true, studentGroupId: null },
              { linkId: "m", id: "c-2", firstName: "Gammal", lastName: "Elev", isActive: false, studentGroupId: null },
            ]
          : [],
      ),
    );
    renderCard([B, C]);

    expect(await screen.findByText("Olle Granlund")).toBeInTheDocument();
    expect(screen.queryByText(/Gammal/)).toBeNull();
    expect(await screen.findByText("Inga barn kopplade på skolan.")).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/api/v1/family/children", { school: B.schoolId });
    expect(get).toHaveBeenCalledWith("/api/v1/family/children", { school: C.schoolId });
    expect(screen.getByRole("region", { name: "Barn på andra skolor" })).toBeInTheDocument();
  });

  it("switches with a form that posts the school to /skola", async () => {
    get.mockResolvedValue([]);
    renderCard([B]);
    const button = await screen.findByRole("button", { name: "Byt till Granen" });
    expect(button).toHaveAttribute("name", "school");
    expect(button).toHaveAttribute("value", B.schoolId);
    expect(button.closest("form")).toHaveAttribute("action", "/sv/skola");
    expect(button.closest("form")).toHaveAttribute("method", "post");
  });

  it("names a school closed to this sign-in without asking for its children, and offers no switch there", async () => {
    // The gateway refuses a read at a school the hook closed (SCHOOL_NOT_AVAILABLE).
    get.mockResolvedValue([]);
    renderCard([school(B.schoolId, "Granen", { closed: "sso_not_enabled" }), C]);

    expect(await screen.findByText("Inga barn kopplade på skolan.")).toBeInTheDocument();
    expect(screen.getByText("Går inte att byta till med den här inloggningen.")).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/v1/family/children", { school: C.schoolId });
    expect(screen.queryByRole("button", { name: "Byt till Granen" })).toBeNull();
    expect(screen.getByRole("button", { name: "Byt till Hagen" })).toBeInTheDocument();
  });

  it("says a list could not be read, never that the school has no child", async () => {
    get.mockRejectedValue(new Error("boom"));
    renderCard([B]);
    expect(await screen.findByText("Barnen på skolan kunde inte hämtas just nu.")).toBeInTheDocument();
    expect(screen.queryByText("Inga barn kopplade på skolan.")).toBeNull();
  });
});
