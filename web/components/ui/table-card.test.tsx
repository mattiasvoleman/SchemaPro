import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";
import { TableCard } from "./table-card";

function renderCard(props: Partial<Parameters<typeof TableCard>[0]> = {}) {
  return render(
    <TableCard caption="Läsår och deras datum" {...props}>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Namn</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>2026/2027</TableCell>
        </TableRow>
      </TableBody>
    </TableCard>,
  );
}

describe("TableCard", () => {
  it("names the table by a visually hidden caption", () => {
    renderCard();
    const table = screen.getByRole("table", { name: "Läsår och deras datum" });
    expect(table.querySelector("caption")).toHaveClass("sr-only");
    expect(screen.getByRole("cell", { name: "2026/2027" })).toBeInTheDocument();
  });

  it("frames the table in a scrolling card", () => {
    const { container } = renderCard({ className: "max-h-[70vh]", tableClassName: "min-w-[40rem]" });
    const frame = container.firstElementChild;
    expect(frame).toHaveClass("overflow-x-auto", "rounded-lg", "border", "bg-card", "max-h-[70vh]");
    expect(frame).not.toHaveAttribute("aria-busy");
    expect(screen.getByRole("table")).toHaveClass("min-w-[40rem]", "w-full", "text-sm");
  });

  it("dims and marks itself busy while placeholder data stands in", () => {
    const { container } = renderCard({ busy: true });
    const frame = container.firstElementChild;
    expect(frame).toHaveClass("opacity-60");
    expect(frame).toHaveAttribute("aria-busy", "true");
  });
});
