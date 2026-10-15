import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import type { SheetDocument } from "@/lib/print-sheet";
import { PrintWeekButton } from "./print-week-button";

/**
 * "Skriv ut veckan": the page's own week on paper, with the week's validity
 * asked for, printed once the sheet is there, and the page left as it was.
 */

const validity = vi.hoisted(() => vi.fn());
vi.mock("@/lib/print-queries", () => ({ weekValidity: validity }));
// The sheet's module as it loads, or as a chunk gone since a deploy would fail.
const chunk = vi.hoisted(() => ({ fails: false }));
vi.mock("./printed-sheet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./printed-sheet")>();
  return {
    PrintedSheet: (props: Parameters<typeof actual.PrintedSheet>[0]) => {
      if (chunk.fails) throw new Error("Loading chunk failed");
      return <actual.PrintedSheet {...props} />;
    },
  };
});

const SHEET: SheetDocument = {
  kind: "TEACHER",
  title: "Anna Lind",
  school: "Skolan i Exempelby",
  week: { from: "2026-10-12", to: "2026-10-18", isoWeek: "2026-W42" },
  days: [
    { date: "2026-10-12", lessons: [{ start: "08:00", end: "09:00", subject: "Matematik", groups: ["7A · Vikarie"], room: "Sal 12", teachers: [] }] },
    ...["13", "14", "15", "16", "17", "18"].map((day) => ({ date: `2026-10-${day}`, lessons: [] })),
  ],
};

function renderButton(build = () => SHEET, disabled = false) {
  return render(
    <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
      <PrintWeekButton build={build} disabled={disabled} />
    </NextIntlClientProvider>,
  );
}

describe("PrintWeekButton", () => {
  const print = vi.fn();
  beforeEach(() => {
    validity.mockReset().mockResolvedValue([{ from: "2026-08-17", to: "2027-06-11" }]);
    print.mockReset();
    vi.stubGlobal("print", print);
    chunk.fails = false;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.classList.remove("printing-sheet");
  });

  it("asks the week's validity, prints once the sheet is on the page, and leaves nothing behind", async () => {
    const user = userEvent.setup();
    const build = vi.fn(() => SHEET);
    renderButton(build);
    await user.click(screen.getByRole("button", { name: "Skriv ut veckan" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(build).toHaveBeenCalledTimes(1);
    expect(validity).toHaveBeenCalledWith("2026-10-12");
    // The sheet, under <body>, where only paper shows it; the page is the sheet alone while it prints.
    const root = document.body.querySelector(":scope > .print-sheet-root") as HTMLElement;
    expect(root).not.toBeNull();
    expect(root).toHaveTextContent("Anna Lind");
    expect(root).toHaveTextContent("Giltig fr.o.m. 17 aug. 2026 t.o.m. 11 juni 2027");
    expect(root).toHaveTextContent("7A · Vikarie");
    expect(document.documentElement).toHaveClass("printing-sheet");
    expect(screen.getByRole("button", { name: "Förbereder utskriften …" })).toHaveAttribute("aria-disabled", "true");

    act(() => {
      window.dispatchEvent(new Event("afterprint"));
    });
    await waitFor(() => expect(document.body.querySelector(".print-sheet-root")).toBeNull());
    expect(document.documentElement).not.toHaveClass("printing-sheet");
    expect(screen.getByRole("button", { name: "Skriv ut veckan" })).toBeEnabled();
  });

  it("prints the week without a validity line when the validity cannot be read", async () => {
    validity.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderButton();
    await user.click(screen.getByRole("button", { name: "Skriv ut veckan" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(document.body.querySelector(".print-sheet-root")).not.toHaveTextContent("Giltig");
  });

  it("prints a second time from a sheet module already loaded, with the page already the sheet alone", async () => {
    const user = userEvent.setup();
    renderButton();
    await user.click(screen.getByRole("button", { name: "Skriv ut veckan" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    act(() => {
      window.dispatchEvent(new Event("afterprint"));
    });
    print.mockImplementation(() => {
      // The order a cached chunk gives: the sheet's own effect prints in the commit that mounts it.
      expect(document.documentElement).toHaveClass("printing-sheet");
    });
    await user.click(await screen.findByRole("button", { name: "Skriv ut veckan" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(2));
  });

  it("gives the page back at the next click when the browser never says the print is done", async () => {
    const user = userEvent.setup();
    renderButton();
    await user.click(screen.getByRole("button", { name: "Skriv ut veckan" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(document.documentElement).toHaveClass("printing-sheet");
    await user.click(document.body);
    await waitFor(() => expect(document.body.querySelector(".print-sheet-root")).toBeNull());
    expect(document.documentElement).not.toHaveClass("printing-sheet");
    expect(screen.getByRole("button", { name: "Skriv ut veckan" })).toBeEnabled();
  });

  it("leaves nothing behind when the page is left while the validity is asked", async () => {
    let answer!: (periods: unknown) => void;
    validity.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const user = userEvent.setup();
    const { unmount } = renderButton();
    await user.click(screen.getByRole("button", { name: "Skriv ut veckan" }));
    unmount();
    await act(async () => answer([{ from: "2026-08-17", to: "2027-06-11" }]));
    expect(document.documentElement).not.toHaveClass("printing-sheet");
    expect(document.body.querySelector(".print-sheet-root")).toBeNull();
    expect(print).not.toHaveBeenCalled();
  });

  it("gives the page back when the sheet cannot be drawn", async () => {
    chunk.fails = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderButton();
    await user.click(screen.getByRole("button", { name: "Skriv ut veckan" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Skriv ut veckan" })).toBeEnabled());
    expect(document.documentElement).not.toHaveClass("printing-sheet");
    expect(document.body.querySelector(".print-sheet-root")).toBeNull();
    expect(print).not.toHaveBeenCalled();
    vi.mocked(console.error).mockRestore();
  });

  it("is not offered while the week is not read: it says so, and a press does nothing", async () => {
    const user = userEvent.setup();
    const build = vi.fn(() => SHEET);
    renderButton(build, true);
    const button = screen.getByRole("button", { name: "Skriv ut veckan" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    await user.click(button);
    expect(build).not.toHaveBeenCalled();
    expect(validity).not.toHaveBeenCalled();
  });

  it("keeps the keyboard's focus on the button while the print is prepared, and after it", async () => {
    let answer!: (periods: unknown) => void;
    validity.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const user = userEvent.setup();
    renderButton();
    await user.tab();
    await user.keyboard("{Enter}");
    // Preparing: the button keeps the focus and says so, and a second press does nothing.
    // Never natively disabled, which a browser answers by moving the focus to <body> (jsdom does not).
    expect(screen.getByRole("button", { name: "Förbereder utskriften …" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Förbereder utskriften …" })).toBeEnabled();
    await user.keyboard("{Enter}");
    await act(async () => answer([{ from: "2026-08-17", to: "2027-06-11" }]));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(validity).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event("afterprint"));
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Skriv ut veckan" })).toHaveFocus());
    expect(print).toHaveBeenCalledTimes(1);
  });
});
