import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "./confirm-dialog";

type User = ReturnType<typeof userEvent.setup>;

// Key-echo translator: t("cancel") renders as "cancel", which is what the
// button queries below assert against.
vi.mock("next-intl", () => ({
  // DateField reads the active locale for its month and weekday names.
  useLocale: () => "sv",
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

  // Every way out of the dialog other than its footer, one test each. One
  // test walking all three stops at the first route that fails, and a route
  // that never reached the dialog at all would pass "blocked" unnoticed — so
  // each route is blocked while loading AND shown to dismiss once it is not.
  const dismissals: Array<[string, (user: User) => Promise<void>]> = [
    ["Escape", (user) => user.keyboard("{Escape}")],
    ["the X", (user) => user.click(screen.getByRole("button", { name: "close" }))],
    [
      "an outside press",
      async () => {
        // Outside is the overlay, which covers the page in a browser. user-event
        // cannot press it (the modal puts pointer-events: none on body), so the
        // gesture is dispatched by hand, and three things make it one Radix
        // hears. A macrotask first: the dismissable layer attaches its
        // pointerdown listener in a setTimeout after mounting. Then pointerdown
        // AND click: Dialog defers an outside left press until the click, and
        // counts it only if the click lands on the overlay. Miss any of them
        // and the press reaches nothing — and "blocked" passes with no guard.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const overlay = screen.getByRole("dialog").previousElementSibling;
        expect(overlay).toHaveAttribute("data-state", "open");
        fireEvent.pointerDown(overlay!);
        fireEvent.click(overlay!);
      },
    ],
  ];

  it.each(dismissals)("blocks %s while loading", async (_route, dismiss) => {
    // The disabled footer buttons promise the dialog cannot be left mid-
    // mutation; every other route out has to keep that promise too.
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog({ loading: true });

    await dismiss(user);

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it.each(dismissals)("still dismisses via %s once loading finishes", async (_route, dismiss) => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog({ loading: false });

    await dismiss(user);

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("greys out the X only while loading", () => {
    const { view } = renderDialog({ loading: true });
    expect(screen.getByRole("button", { name: "close" })).toBeDisabled();

    view.unmount();
    renderDialog({ loading: false });
    expect(screen.getByRole("button", { name: "close" })).not.toBeDisabled();
  });
});
