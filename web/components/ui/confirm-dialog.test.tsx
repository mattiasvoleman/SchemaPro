import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "./confirm-dialog";

// Key-echo translator: t("cancel") renders as "cancel", which is what the
// button queries below assert against.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

function renderDialog(overrides: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onConfirm = vi.fn();
  const props = {
    open: true,
    onOpenChange,
    title: "Delete schedule?",
    description: "This cannot be undone.",
    onConfirm,
    ...overrides,
  };
  const view = render(<ConfirmDialog {...props} />);
  return { view, onOpenChange, onConfirm };
}

describe("ConfirmDialog", () => {
  it("renders nothing while closed", () => {
    renderDialog({ open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows title and description when open", () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "Delete schedule?" })).toBeInTheDocument();
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
  });

  it("omits the description element when none is given", () => {
    renderDialog({ description: undefined });
    expect(screen.getByRole("dialog", { name: "Delete schedule?" })).toBeInTheDocument();
    expect(screen.queryByText("This cannot be undone.")).not.toBeInTheDocument();
  });

  it("fires onConfirm exactly once per confirm click and does not self-close", async () => {
    const user = userEvent.setup();
    const { onConfirm, onOpenChange } = renderDialog();

    await user.click(screen.getByRole("button", { name: "confirm" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    // Closing after a confirm is the caller's job (e.g. when the mutation
    // settles), so the dialog must not close itself here.
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("cancel closes exactly once without confirming", async () => {
    const user = userEvent.setup();
    const { onConfirm, onOpenChange } = renderDialog();

    await user.click(screen.getByRole("button", { name: "cancel" }));

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("uses the provided confirm label over the default", () => {
    renderDialog({ confirmLabel: "Yes, delete it" });
    expect(screen.getByRole("button", { name: "Yes, delete it" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "confirm" })).not.toBeInTheDocument();
  });

  it("styles the confirm button destructive by default and default otherwise", () => {
    const { view } = renderDialog();
    expect(screen.getByRole("button", { name: "confirm" })).toHaveClass("bg-destructive");

    view.unmount();
    renderDialog({ destructive: false });
    expect(screen.getByRole("button", { name: "confirm" })).toHaveClass("bg-primary");
  });

  it("disables both action buttons while loading", async () => {
    const user = userEvent.setup();
    const { onConfirm, onOpenChange } = renderDialog({ loading: true });

    const confirm = screen.getByRole("button", { name: "confirm" });
    const cancel = screen.getByRole("button", { name: "cancel" });
    expect(confirm).toBeDisabled();
    expect(cancel).toBeDisabled();

    await user.click(confirm);
    await user.click(cancel);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("still dismisses via Escape and the X button while loading", async () => {
    // SUSPECTED BUG (pinned, not fixed): loading disables the footer buttons,
    // which reads as "you cannot leave while the mutation is in flight" — but
    // Escape and the DialogContent X button are not gated on `loading`, so the
    // dialog can still be dismissed mid-mutation. If dismissal is meant to be
    // blocked, DialogContent needs onEscapeKeyDown/onInteractOutside guards
    // and the X needs disabling.
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog({ loading: true });

    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);

    onOpenChange.mockClear();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
