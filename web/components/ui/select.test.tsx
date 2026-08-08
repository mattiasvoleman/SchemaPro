import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./select";

// jsdom implements neither the pointer-capture API nor scrollIntoView, and
// Radix's popper positioning wants ResizeObserver. These are environment
// shims, not behaviour under test.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function FruitSelect(props: {
  onValueChange?: (value: string) => void;
  defaultValue?: string;
}) {
  return (
    <Select onValueChange={props.onValueChange} defaultValue={props.defaultValue}>
      <SelectTrigger aria-label="Fruit">
        <SelectValue placeholder="Pick a fruit" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Fruits</SelectLabel>
          <SelectItem value="apple">Apple</SelectItem>
          <SelectItem value="banana">Banana</SelectItem>
          <SelectSeparator />
          <SelectItem value="cherry" disabled>
            Cherry
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

describe("Select", () => {
  it("shows the placeholder until a value is chosen", () => {
    render(<FruitSelect />);
    const trigger = screen.getByRole("combobox", { name: "Fruit" });
    expect(trigger).toHaveTextContent("Pick a fruit");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("opens a listbox with all options on trigger click", async () => {
    const user = userEvent.setup();
    render(<FruitSelect />);

    // While the portal is open Radix aria-hides everything outside it,
    // including the trigger — so grab the trigger before opening.
    const trigger = screen.getByRole("combobox", { name: "Fruit" });
    await user.click(trigger);

    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Apple" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Banana" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Cherry" })).toBeInTheDocument();
    expect(screen.getByText("Fruits")).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("selecting an option fires onValueChange with its value, closes, and updates the trigger", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<FruitSelect onValueChange={onValueChange} />);

    await user.click(screen.getByRole("combobox", { name: "Fruit" }));
    await user.click(screen.getByRole("option", { name: "Banana" }));

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith("banana");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Fruit" })).toHaveTextContent("Banana");
  });

  it("marks the defaultValue option as selected", async () => {
    const user = userEvent.setup();
    render(<FruitSelect defaultValue="apple" />);

    expect(screen.getByRole("combobox", { name: "Fruit" })).toHaveTextContent("Apple");

    await user.click(screen.getByRole("combobox", { name: "Fruit" }));
    expect(screen.getByRole("option", { name: "Apple" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("option", { name: "Banana" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("ignores clicks on a disabled option", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<FruitSelect onValueChange={onValueChange} />);

    await user.click(screen.getByRole("combobox", { name: "Fruit" }));
    const cherry = screen.getByRole("option", { name: "Cherry" });
    expect(cherry).toHaveAttribute("data-disabled");

    await user.click(cherry);

    expect(onValueChange).not.toHaveBeenCalled();
    // A no-op click must not close the list either.
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("supports full keyboard selection", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<FruitSelect onValueChange={onValueChange} />);

    await user.tab();
    expect(screen.getByRole("combobox", { name: "Fruit" })).toHaveFocus();

    // Enter opens; first option gets highlighted; ArrowDown moves to Banana.
    await user.keyboard("{Enter}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onValueChange).toHaveBeenCalledWith("banana");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes without selecting on Escape", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<FruitSelect onValueChange={onValueChange} />);

    await user.click(screen.getByRole("combobox", { name: "Fruit" }));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Fruit" })).toHaveTextContent(
      "Pick a fruit",
    );
  });
});
