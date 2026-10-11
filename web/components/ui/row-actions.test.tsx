import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Mail, Pencil, Trash2, Users, KeyRound } from "lucide-react";
import { RowActions } from "./row-actions";
import { ConfirmDialog } from "./confirm-dialog";

// The real Swedish copy for the composed names.
vi.mock("next-intl", async () => {
  const sv = (await import("@/messages/sv.json")).default as unknown as Record<string, Record<string, string>>;
  return {
    useTranslations: (namespace: string) => (key: string, values?: Record<string, string>) =>
      Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.replace(`{${name}}`, value),
        sv[namespace]![key]!,
      ),
  };
});

describe("RowActions", () => {
  it("names every icon button after the row it acts on", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(
      <RowActions
        name="7A"
        actions={[
          { label: "Redigera", icon: Pencil, onSelect: onEdit },
          { label: "Ta bort", icon: Trash2, onSelect: onDelete },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Redigera 7A" }));
    await user.click(screen.getByRole("button", { name: "Ta bort 7A" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);

    // Icon only, and the bin is not painted red: the ConfirmDialog carries the red.
    const remove = screen.getByRole("button", { name: "Ta bort 7A" });
    expect(remove).toHaveTextContent("");
    expect(remove).not.toHaveClass("text-destructive");
    expect(remove.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(remove.parentElement).toHaveClass("flex", "justify-end", "gap-1");
  });

  it("gives every icon button its name as a tooltip, for a pointer user who cannot read the icon", () => {
    render(
      <RowActions
        name="7A"
        actions={[
          { label: "Redigera", icon: Pencil, onSelect: () => undefined },
          { label: "Medlemmar", ariaLabel: "Visa medlemmarna i 7A", icon: Users, onSelect: () => undefined },
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "Redigera 7A" })).toHaveAttribute("title", "Redigera 7A");
    expect(screen.getByRole("button", { name: "Visa medlemmarna i 7A" })).toHaveAttribute(
      "title",
      "Visa medlemmarna i 7A",
    );
  });

  it("takes a whole name where the verb and the row do not make a sentence", () => {
    render(
      <RowActions
        name="7A"
        actions={[{ label: "Medlemmar", ariaLabel: "Visa medlemmarna i 7A", icon: Users, onSelect: () => undefined }]}
      />,
    );
    expect(screen.getByRole("button", { name: "Visa medlemmarna i 7A" })).toBeInTheDocument();
  });

  it("keeps three as buttons", () => {
    render(
      <RowActions
        name="Alma Berg"
        actions={[
          { label: "Redigera", icon: Pencil, onSelect: () => undefined },
          { label: "Konto", icon: KeyRound, onSelect: () => undefined },
          { label: "Ta bort", icon: Trash2, onSelect: () => undefined },
        ]}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /Fler åtgärder/ })).not.toBeInTheDocument();
  });

  it("folds the rest into a named menu past three, keeping the first two", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(
      <RowActions
        name="Alma Berg"
        actions={[
          { label: "Redigera", icon: Pencil, onSelect: () => undefined },
          { label: "Vårdnadshavare", icon: Users, onSelect: () => undefined },
          { label: "Konto", icon: KeyRound, onSelect: () => undefined, disabled: true },
          { label: "Ta bort", icon: Trash2, onSelect: onDelete },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "Redigera Alma Berg" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Vårdnadshavare Alma Berg" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ta bort Alma Berg" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Fler åtgärder för Alma Berg" }));
    expect(screen.getByRole("menuitem", { name: "Konto" })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("menuitem", { name: "Ta bort" }));
    // Run once the menu has closed, not as it is picked (see the focus test below).
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
  });

  it("disables a single action", () => {
    render(
      <RowActions name="7A" actions={[{ label: "Ta bort", icon: Trash2, onSelect: () => undefined, disabled: true }]} />,
    );
    expect(screen.getByRole("button", { name: "Ta bort 7A" })).toBeDisabled();
  });

  it("keeps a fourth action in sight when the page raises inlineMax", () => {
    // Personer: the manual sends the reader to the envelope on the row.
    render(
      <RowActions
        name="Karin Ek"
        inlineMax={4}
        actions={[
          { label: "Redigera", icon: Pencil, onSelect: () => undefined },
          { label: "Arbetstid", icon: KeyRound, onSelect: () => undefined },
          { label: "Skicka inbjudan", icon: Mail, onSelect: () => undefined },
          { label: "Ta bort", icon: Trash2, onSelect: () => undefined },
        ]}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Skicka inbjudan Karin Ek" })).toBeInTheDocument();
    expect(screen.getAllByRole("button").at(-1)).toHaveAccessibleName("Ta bort Karin Ek");
    expect(screen.queryByRole("button", { name: /Fler åtgärder/ })).not.toBeInTheDocument();
  });

  it("opens a menu action's dialog once the menu has closed, and the dialog hands focus back to the menu button", async () => {
    // Run from onSelect, the ConfirmDialog mounted under the menu's own focus
    // trap and focus fell to <body> on cancel; a keyboard user started over
    // from the top of the page.
    function Row() {
      const [deleting, setDeleting] = useState(false);
      return (
        <>
          <RowActions
            name="Alma Berg"
            actions={[
              { label: "Redigera", icon: Pencil, onSelect: () => undefined },
              { label: "Vårdnadshavare", icon: Users, onSelect: () => undefined },
              { label: "Konto", icon: KeyRound, onSelect: () => undefined },
              { label: "Ta bort", icon: Trash2, onSelect: () => setDeleting(true) },
            ]}
          />
          <ConfirmDialog
            open={deleting}
            onOpenChange={setDeleting}
            title="Ta bort Alma Berg?"
            confirmLabel="Ta bort"
            onConfirm={() => setDeleting(false)}
          />
        </>
      );
    }
    const user = userEvent.setup();
    render(<Row />);

    await user.click(screen.getByRole("button", { name: "Fler åtgärder för Alma Berg" }));
    await user.click(screen.getByRole("menuitem", { name: "Ta bort" }));
    const dialog = await screen.findByRole("dialog", { name: "Ta bort Alma Berg?" });
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));

    await user.click(screen.getByRole("button", { name: "Avbryt" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Fler åtgärder för Alma Berg" })).toHaveFocus(),
    );
  });

  it("hands focus back to the menu button when the menu is left with Escape", async () => {
    const onDelete = vi.fn();
    const user = userEvent.setup();
    render(
      <RowActions
        name="Alma Berg"
        actions={[
          { label: "Redigera", icon: Pencil, onSelect: () => undefined },
          { label: "Vårdnadshavare", icon: Users, onSelect: () => undefined },
          { label: "Konto", icon: KeyRound, onSelect: () => undefined },
          { label: "Ta bort", icon: Trash2, onSelect: onDelete },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Fler åtgärder för Alma Berg" }));
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Fler åtgärder för Alma Berg" })).toHaveFocus(),
    );
    expect(onDelete).not.toHaveBeenCalled();
  });
});
