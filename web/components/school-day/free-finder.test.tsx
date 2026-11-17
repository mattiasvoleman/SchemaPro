import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { FreeFinder } from "./free-finder";

/**
 * Vem och vad är ledigt?, and what it says about an administrator who teaches
 * (Users.teaches). GET /school-day/free takes her among the free ("who
 * teaches"), as the grid's rows do, but she is not the substitute pool and is
 * refused as a substitute: the gateway's comment and DEPLOYMENT 20.5 say the
 * page that shows the list says so in its own text. The sentence is in the
 * card's description, in both languages.
 */

vi.mock("@/lib/school-day-queries", () => ({
  isRateLimited: () => false,
  useSchoolDayFree: () => ({ data: undefined, isLoading: false, isError: false, error: null }),
}));

const renderIn = (locale: "sv" | "en", messages: typeof sv | typeof en) =>
  render(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Europe/Stockholm">
      <FreeFinder />
    </NextIntlClientProvider>,
  );

describe("the description of Vem och vad är ledigt?", () => {
  it("says in Swedish that an administrator who teaches can be in the list but is not asked to cover", () => {
    renderIn("sv", sv);
    const text = document.getElementById("school-day-free")?.textContent ?? "";
    expect(text).toContain("en administratör som undervisar kan stå i den, men tillfrågas inte som vikarie");
  });

  it("says it in English too", () => {
    renderIn("en", en);
    const text = document.getElementById("school-day-free")?.textContent ?? "";
    expect(text).toContain("an administrator who teaches can be in it, but is not asked to cover");
  });

  it("still says what the card is for", () => {
    renderIn("sv", sv);
    expect(screen.getByText(/vilka lärare och salar som inte är upptagna hela tiden/)).toBeInTheDocument();
  });
});
