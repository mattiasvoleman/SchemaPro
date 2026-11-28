import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { ApiError } from "@/lib/api";
import type { DirectReach } from "@/lib/direct-reach";
import { DirectReachDialog } from "./direct-reach-dialog";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const reach: DirectReach = {
  academicYearId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  mode: "DIRECT",
  period: { from: "2026-08-01", to: "2027-06-11" },
  acknowledgedAt: null,
  ask: true,
  audience: { pupils: 1, guardians: 2 },
};

function mount(over: Partial<DirectReach> = {}, locale: "sv" | "en" = "sv") {
  const onAnswered = vi.fn();
  const onDeclined = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <NextIntlClientProvider locale={locale} messages={locale === "sv" ? sv : en} timeZone="Europe/Stockholm">
        <DirectReachDialog reach={{ ...reach, ...over }} onAnswered={onAnswered} onDeclined={onDeclined} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { onAnswered, onDeclined };
}

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  toast.error.mockReset();
});

describe("DirectReachDialog", () => {
  it("counts in the singular and the plural, and says it in English", () => {
    mount({ audience: { pupils: 1, guardians: 1 } });
    expect(screen.getByTestId("direct-reach-audience").textContent).toContain("1 elev och 1 vårdnadshavare");
  });

  it("names the audience in English", () => {
    mount({}, "en");
    expect(screen.getByTestId("direct-reach-audience").textContent).toContain("1 pupil and 2 guardians");
    expect(screen.getByRole("button", { name: "Continue in Direkt" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use draft" })).toBeTruthy();
  });

  it("says the question without a period or an audience when the gateway sent none", () => {
    mount({ period: null, audience: null });
    expect(screen.queryByTestId("direct-reach-audience")).toBeNull();
    expect(screen.getByRole("dialog").textContent).toContain("Skolan publicerar i läget Direkt. En ändring flyttar");
  });

  it("stays open and says why when the answer is refused (a school administrator without Publicering)", async () => {
    api.post.mockRejectedValue(new ApiError(403, "Området Publicering krävs.", undefined));
    const { onAnswered, onDeclined } = mount();
    await userEvent.click(screen.getByRole("button", { name: "Fortsätt i Direkt" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(onAnswered).not.toHaveBeenCalled();
    expect(onDeclined).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("reports the answer it was given: Direkt kept, or utkast", async () => {
    api.post.mockResolvedValue({});
    const first = mount();
    await userEvent.click(screen.getByRole("button", { name: "Fortsätt i Direkt" }));
    await waitFor(() => expect(first.onAnswered).toHaveBeenCalledWith("DIRECT"));
  });
});
