import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";

function LessonsTable() {
  return (
    <Table className="min-w-[600px]">
      <TableHeader>
        <TableRow>
          <TableHead>Subject</TableHead>
          <TableHead>Teacher</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow data-state="selected">
          <TableCell>Mathematics</TableCell>
          <TableCell>A. Nyberg</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>Physics</TableCell>
          <TableCell>K. Ek</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

describe("Table", () => {
  it("renders an accessible table structure", () => {
    render(<LessonsTable />);

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Subject",
      "Teacher",
    ]);
    // Header row + two body rows.
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByRole("cell", { name: "Mathematics" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "K. Ek" })).toBeInTheDocument();
  });

  it("wraps the table in a horizontal-scroll container", () => {
    render(<LessonsTable />);
    // The wrapper div is presentational and has no accessible handle, so it is
    // reached as the table's parent on purpose.
    const wrapper = screen.getByRole("table").parentElement;
    expect(wrapper).toHaveClass("overflow-auto");
  });

  it("merges custom classes with the defaults", () => {
    render(<LessonsTable />);
    const table = screen.getByRole("table");
    expect(table).toHaveClass("min-w-[600px]");
    expect(table).toHaveClass("w-full");
  });

  it("passes selection state through to the row", () => {
    render(<LessonsTable />);
    const selectedRow = screen.getByRole("cell", { name: "Mathematics" }).closest("tr");
    expect(selectedRow).toHaveAttribute("data-state", "selected");
  });
});
