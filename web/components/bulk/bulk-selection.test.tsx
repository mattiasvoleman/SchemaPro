import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BULK_MAX, BulkSelectionBar, SelectAllCheckbox, SelectRowCheckbox } from "./bulk-selection";

// Echo the key and its values, so assertions read against stable text.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

describe("SelectAllCheckbox", () => {
  it("is named by how many rows it ticks, and half ticked while some are", () => {
    const { rerender } = render(<SelectAllCheckbox entity="groups" state="some" shown={24} onToggle={() => undefined} />);
    const box = screen.getByRole("checkbox", { name: "selectAll(groups|24)" }) as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    expect(box).not.toBeChecked();
    rerender(<SelectAllCheckbox entity="groups" state="all" shown={24} onToggle={() => undefined} />);
    expect(box.indeterminate).toBe(false);
    expect(box).toBeChecked();
    rerender(<SelectAllCheckbox entity="groups" state="none" shown={24} onToggle={() => undefined} />);
    expect(box).not.toBeChecked();
  });

  it("cannot be ticked when nothing is shown", () => {
    render(<SelectAllCheckbox entity="students" state="none" shown={0} onToggle={() => undefined} />);
    expect(screen.getByRole("checkbox", { name: "selectAll(students|0)" })).toBeDisabled();
  });

  it("toggles with Space from the keyboard", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<SelectAllCheckbox entity="students" state="none" shown={3} onToggle={onToggle} />);
    await user.tab();
    await user.keyboard(" ");
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("SelectRowCheckbox", () => {
  it("is named by its row, and says whether Shift was held", async () => {
    const onToggle = vi.fn();
    render(<SelectRowCheckbox name="7A" checked={false} onToggle={onToggle} />);
    const box = screen.getByRole("checkbox", { name: "selectRow(7A)" });
    fireEvent.click(box);
    fireEvent.click(box, { shiftKey: true });
    expect(onToggle.mock.calls).toEqual([[false], [true]]);
  });

  it("toggles with Space from the keyboard", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<SelectRowCheckbox name="Alma Berg" checked onToggle={onToggle} />);
    await user.tab();
    await user.keyboard(" ");
    expect(onToggle).toHaveBeenCalledWith(false);
  });
});

describe("BulkSelectionBar", () => {
  const bar = (count: number, handlers: Partial<Record<"onClear" | "onEdit" | "onDelete", () => void>> = {}) =>
    render(
      <BulkSelectionBar
        entity="students"
        count={count}
        shown={30}
        onClear={handlers.onClear ?? (() => undefined)}
        onEdit={handlers.onEdit ?? (() => undefined)}
        onDelete={handlers.onDelete ?? (() => undefined)}
        writes="PERSONAL"
      />,
    );

  it("keeps its live region mounted but says nothing, and offers nothing, while nothing is ticked", () => {
    bar(0);
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("counts the ticked rows of the shown ones, and acts on them", async () => {
    const onClear = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const user = userEvent.setup();
    bar(3, { onClear, onEdit, onDelete });
    expect(screen.getByRole("status")).toHaveTextContent("selected(students|3|30)");
    await user.click(screen.getByRole("button", { name: "edit" }));
    await user.click(screen.getByRole("button", { name: "delete" }));
    await user.click(screen.getByRole("button", { name: "clear" }));
    expect([onEdit, onDelete, onClear].map((handler) => handler.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("is marked with the area it writes, so a profile that does not write it never sees it", () => {
    const { container } = bar(2);
    expect(container.firstElementChild).toHaveAttribute("data-writes", "PERSONAL");
  });

  it(`refuses Redigera and Ta bort over ${BULK_MAX} rows, and says why`, () => {
    bar(BULK_MAX + 1);
    expect(screen.getByText(`tooMany(${BULK_MAX})`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "edit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "delete" })).toBeDisabled();
    // Letting go is still possible.
    expect(screen.getByRole("button", { name: "clear" })).toBeEnabled();
  });
});
