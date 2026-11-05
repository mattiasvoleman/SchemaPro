import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CsvExportButton } from "./csv-export-button";

const downloadCsv = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/csv-export", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/csv-export")>()),
  downloadCsv,
}));

vi.mock("next-intl", () => ({
  // DateField reads the active locale for its month and weekday names.
  useLocale: () => "sv",
  useTranslations: () => (key: string) => key,
}));

describe("CsvExportButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("downloads straight away when a page exports one kind", async () => {
    const user = userEvent.setup();
    render(
      <CsvExportButton
        exports={[{ kind: "roomTypes", build: () => "FILINNEHÅLL" }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "exportButton" }));

    // Named from the template, so it matches the file the school already has.
    expect(downloadCsv).toHaveBeenCalledWith("salstyper.csv", "FILINNEHÅLL");
  });

  it("waits for a builder loaded at the click, and downloads nothing when it answers null", async () => {
    // /admin/requirements loads its builder at the click; one that did not
    // load has said why and answers null.
    const user = userEvent.setup();
    const { rerender } = render(
      <CsvExportButton exports={[{ kind: "roomTypes", build: async () => "SENT" }]} />,
    );
    await user.click(screen.getByRole("button", { name: "exportButton" }));
    expect(downloadCsv).toHaveBeenCalledWith("salstyper.csv", "SENT");

    rerender(<CsvExportButton exports={[{ kind: "roomTypes", build: async () => null }]} />);
    await user.click(screen.getByRole("button", { name: "exportButton" }));
    expect(downloadCsv).toHaveBeenCalledTimes(1);
  });

  it("asks which file when a page exports several kinds", async () => {
    const user = userEvent.setup();
    render(
      <CsvExportButton
        exports={[
          { kind: "classes", build: () => "KLASSER" },
          { kind: "teachingGroups", build: () => "GRUPPER" },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "exportButton" }));
    await user.click(screen.getByRole("menuitem", { name: "kinds.teachingGroups" }));

    expect(downloadCsv).toHaveBeenCalledWith("undervisningsgrupper.csv", "GRUPPER");
  });

  it("builds the file only when the entry is chosen", async () => {
    // Building eagerly would serialise every kind on every render of the page.
    const build = vi.fn(() => "KLASSER");
    const user = userEvent.setup();
    render(
      <CsvExportButton
        exports={[
          { kind: "classes", build },
          { kind: "teachingGroups", build: () => "GRUPPER" },
        ]}
      />,
    );

    expect(build).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "exportButton" }));
    await user.click(screen.getByRole("menuitem", { name: "kinds.classes" }));

    expect(build).toHaveBeenCalledTimes(1);
  });

  it("disables the button when there is nothing to export", async () => {
    const build = vi.fn(() => "");
    render(
      <CsvExportButton exports={[{ kind: "roomTypes", build, empty: true }]} />,
    );

    expect(screen.getByRole("button", { name: "exportButton" })).toBeDisabled();
    expect(build).not.toHaveBeenCalled();
  });

  describe("while a file is being built", () => {
    /** A builder that answers when the test says so, as one that reads the gateway at the click does. */
    const slow = () => {
      let answer!: (file: string | null) => void;
      const build = vi.fn(() => new Promise<string | null>((resolve) => (answer = resolve)));
      return { build, answer: (file: string | null) => answer(file) };
    };

    it("reads once for a double click on the button, downloads one file, and is disabled until it is done", async () => {
      const { build, answer } = slow();
      const user = userEvent.setup();
      render(<CsvExportButton exports={[{ kind: "guardians", build }]} />);
      const button = screen.getByRole("button", { name: "exportButton" });

      await user.dblClick(button);
      expect(build).toHaveBeenCalledTimes(1);
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("aria-busy", "true");

      answer("FILEN");
      await waitFor(() => expect(button).toBeEnabled());
      expect(downloadCsv).toHaveBeenCalledTimes(1);
      expect(downloadCsv).toHaveBeenCalledWith("vardnadshavare.csv", "FILEN");
      expect(button).toHaveAttribute("aria-busy", "false");
    });

    it("refuses a second export from the menu until the first is done", async () => {
      const { build, answer } = slow();
      const user = userEvent.setup();
      render(
        <CsvExportButton
          exports={[
            { kind: "guardians", build },
            { kind: "students", build: () => "ELEVER" },
          ]}
        />,
      );

      await user.click(screen.getByRole("button", { name: "exportButton" }));
      await user.click(screen.getByRole("menuitem", { name: "kinds.guardians" }));
      expect(screen.getByRole("button", { name: "exportButton" })).toBeDisabled();

      answer("FILEN");
      await waitFor(() => expect(screen.getByRole("button", { name: "exportButton" })).toBeEnabled());
      await user.click(screen.getByRole("button", { name: "exportButton" }));
      await user.click(screen.getByRole("menuitem", { name: "kinds.students" }));
      expect(downloadCsv.mock.calls.map((call) => call[1])).toEqual(["FILEN", "ELEVER"]);
    });

    it("is free again when the builder fails, so a retry is possible", async () => {
      const failing = vi.fn().mockRejectedValueOnce(new Error("HTTP 500")).mockResolvedValue("FILEN");
      const user = userEvent.setup();
      render(<CsvExportButton exports={[{ kind: "guardians", build: failing }]} />);
      const button = screen.getByRole("button", { name: "exportButton" });
      // The rejection is the builder's to report (the page's builders catch their own); here it is unhandled.
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);

      await user.click(button);
      await waitFor(() => expect(button).toBeEnabled());
      await user.click(button);

      await waitFor(() => expect(downloadCsv).toHaveBeenCalledWith("vardnadshavare.csv", "FILEN"));
      process.off("unhandledRejection", unhandled);
    });
  });

  describe("a file that may name a pupil with protected personal data", () => {
    it("says so once the file has been handed over, and not before", async () => {
      const user = userEvent.setup();
      render(<CsvExportButton exports={[{ kind: "students", build: () => "ELEVER", protectedWarning: true }]} />);

      expect(toast.warning).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "exportButton" }));

      expect(downloadCsv).toHaveBeenCalledWith("elever.csv", "ELEVER");
      expect(toast.warning).toHaveBeenCalledTimes(1);
      expect(toast.warning).toHaveBeenCalledWith("protectedWarning", expect.objectContaining({ duration: expect.any(Number) }));
    });

    it("says nothing for a file that has no such pupils in it, or when nothing was downloaded", async () => {
      const user = userEvent.setup();
      const { rerender } = render(<CsvExportButton exports={[{ kind: "roomTypes", build: () => "SALSTYPER" }]} />);
      await user.click(screen.getByRole("button", { name: "exportButton" }));
      expect(toast.warning).not.toHaveBeenCalled();

      rerender(<CsvExportButton exports={[{ kind: "students", build: () => null, protectedWarning: true }]} />);
      await user.click(screen.getByRole("button", { name: "exportButton" }));
      expect(toast.warning).not.toHaveBeenCalled();
    });
  });
});
