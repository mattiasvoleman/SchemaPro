import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { SearchField } from "./search-field";

function Controlled({ onValueChange, hideLabel }: { onValueChange?: (value: string) => void; hideLabel?: boolean }) {
  const [value, setValue] = useState("");
  return (
    <SearchField
      id="group-search"
      label="Sök klass"
      hideLabel={hideLabel}
      placeholder="7A, 8B …"
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onValueChange?.(next);
      }}
    />
  );
}

describe("SearchField", () => {
  it("is a labelled search box with the icon inside its left edge", () => {
    render(<Controlled />);

    const input = screen.getByRole("searchbox", { name: "Sök klass" });
    expect(input).toHaveAttribute("id", "group-search");
    expect(input).toHaveAttribute("placeholder", "7A, 8B …");
    expect(input).toHaveClass("pl-9");
    const icon = input.parentElement?.querySelector("svg");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).toHaveClass("absolute", "left-3", "size-4");
    expect(screen.getByText("Sök klass")).not.toHaveClass("sr-only");
    expect(input.parentElement?.parentElement).toHaveClass("max-w-sm", "space-y-1.5");
  });

  it("reports what is typed", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Controlled onValueChange={onValueChange} />);

    await user.type(screen.getByRole("searchbox"), "7a");
    expect(onValueChange).toHaveBeenLastCalledWith("7a");
    expect(screen.getByRole("searchbox")).toHaveValue("7a");
  });

  it("can hide its label visually and keep it as the name", () => {
    render(<Controlled hideLabel />);
    expect(screen.getByText("Sök klass")).toHaveClass("sr-only");
    expect(screen.getByRole("searchbox", { name: "Sök klass" })).toBeInTheDocument();
  });
});
