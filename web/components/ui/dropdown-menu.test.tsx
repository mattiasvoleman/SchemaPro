import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu";

// Environment shims for Radix in jsdom (pointer capture, scroll, popper
// sizing) — not behaviour under test.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function RowMenu(props: {
  onEdit?: () => void;
  onArchive?: () => void;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Row actions</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Actions</DropdownMenuLabel>
        <DropdownMenuItem onSelect={props.onEdit}>Edit</DropdownMenuItem>
        <DropdownMenuItem disabled onSelect={props.onArchive}>
          Archive
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={props.checked ?? false}
          onCheckedChange={props.onCheckedChange}
        >
          Show done
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe("DropdownMenu", () => {
  it("stays closed until the trigger is clicked", async () => {
    const user = userEvent.setup();
    render(<RowMenu />);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Row actions" }));

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByText("Actions")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeInTheDocument();
  });

  it("clicking an item fires onSelect once and closes the menu", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<RowMenu onEdit={onEdit} />);

    await user.click(screen.getByRole("button", { name: "Row actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("a disabled item does not fire and does not close the menu", async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    render(<RowMenu onArchive={onArchive} />);

    await user.click(screen.getByRole("button", { name: "Row actions" }));
    const archive = screen.getByRole("menuitem", { name: "Archive" });
    expect(archive).toHaveAttribute("aria-disabled", "true");

    await user.click(archive);

    expect(onArchive).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("checkbox item reflects checked state and reports the toggle", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<RowMenu checked={false} onCheckedChange={onCheckedChange} />);

    await user.click(screen.getByRole("button", { name: "Row actions" }));
    const checkbox = screen.getByRole("menuitemcheckbox", { name: "Show done" });
    expect(checkbox).toHaveAttribute("aria-checked", "false");

    await user.click(checkbox);

    expect(onCheckedChange).toHaveBeenCalledTimes(1);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("a checked checkbox item reports unchecking", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<RowMenu checked onCheckedChange={onCheckedChange} />);

    await user.click(screen.getByRole("button", { name: "Row actions" }));
    const checkbox = screen.getByRole("menuitemcheckbox", { name: "Show done" });
    expect(checkbox).toHaveAttribute("aria-checked", "true");

    await user.click(checkbox);

    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it("Escape closes the menu and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<RowMenu />);

    const trigger = screen.getByRole("button", { name: "Row actions" });
    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("Enter activates the highlighted item via keyboard", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<RowMenu onEdit={onEdit} />);

    await user.tab();
    expect(screen.getByRole("button", { name: "Row actions" })).toHaveFocus();

    // Enter opens the menu and highlights the first item ("Edit").
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Enter}");

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
