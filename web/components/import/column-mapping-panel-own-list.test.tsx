import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TemplateKind } from "@/lib/column-fields";
import { readTable } from "@/lib/column-table";
import { templateCsvContent } from "@/lib/csv";
import { ColumnMappingPanel } from "./column-mapping-panel";

/** A school's own list, Rastra's own template for a kind, says nothing of Skola24 in the panel: no offer, nothing recognised. */

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) => (values ? `${key}(${Object.values(values).join("|")})` : key);
    t.has = () => true;
    return t;
  },
}));

describe("Rastra's own template in the column panel", () => {
  it.each(["students", "guardians", "teachers"] as const)("is not offered as a file from Skola24: %s", (kind: TemplateKind) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ColumnMappingPanel kind={kind} table={readTable(templateCsvContent(kind as "students"))} templates={[]} onChange={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(screen.queryByText(/^format\.(offered|recognised)/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "format.use" })).not.toBeInTheDocument();
  });
});
