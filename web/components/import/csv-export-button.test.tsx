import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CsvExportButton } from "./csv-export-button";

const downloadCsv = vi.hoisted(() => vi.fn());

vi.mock("@/lib/csv", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/csv")>()),
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
});
