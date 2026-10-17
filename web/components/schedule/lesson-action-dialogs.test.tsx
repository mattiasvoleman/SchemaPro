import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import type { DayLessonRow } from "@/lib/queries";
import { LessonActionDialogs, type LessonActionDialogsProps } from "./lesson-action-dialogs";

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * Ställ in, Tilldela vikarie and Byt sal, shared by Dagsplanering and
 * Lärarfrånvaro: each hands up what was written, with labelled fields, and a
 * vikarie is never one of the lesson's own teachers.
 */

const LESSON = {
  id: "cl-1",
  date: "2026-10-12",
  startsAt: "2026-10-12T06:00:00Z",
  endsAt: "2026-10-12T07:00:00Z",
  subjectId: "s-ma",
  studentGroupId: "g-7a",
  roomId: "r-12",
  status: "SCHEDULED",
  teachers: [{ role: "LEAD", teacherId: "t-anna" }],
} as unknown as DayLessonRow;

const TEACHERS = [
  { id: "t-anna", name: "Anna Lind" },
  { id: "t-bo", name: "Bo Ek" },
];

function renderDialogs(props: Partial<LessonActionDialogsProps>) {
  const handlers = { onCancel: vi.fn(), onSubstitute: vi.fn(), onChangeRoom: vi.fn(), onClose: vi.fn() };
  render(
    <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
      <LessonActionDialogs
        target={null}
        teachers={TEACHERS}
        rooms={[{ id: "r-12", name: "Sal 12" }]}
        pending={{ cancel: false, substitute: false, room: false }}
        {...handlers}
        {...props}
      />
    </NextIntlClientProvider>,
  );
  return handlers;
}

describe("the lesson action dialogs", () => {
  it("cancels with the message written to the class", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialogs({ target: { action: "cancel", lesson: LESSON } });
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Meddelande till elever och vårdnadshavare (valfritt)"), "Läxa på Classroom");
    await user.click(within(dialog).getByRole("button", { name: "Ställ in lektion" }));
    expect(onCancel).toHaveBeenCalledWith(LESSON, "Läxa på Classroom");
  });

  it("offers as vikarie only teachers who are not already on the lesson", async () => {
    const user = userEvent.setup();
    const { onSubstitute } = renderDialogs({ target: { action: "substitute", lesson: LESSON } });
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Tilldela vikarie" });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole("combobox", { name: "Vikarierande lärare" }));
    expect(screen.queryByRole("option", { name: "Anna Lind" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "Bo Ek" }));
    await user.click(confirm);
    expect(onSubstitute).toHaveBeenCalledWith(LESSON, "t-bo", "");
  });

  it("marks the chosen suggestion as pressed", async () => {
    const user = userEvent.setup();
    renderDialogs({
      target: { action: "substitute", lesson: LESSON },
      suggestions: { loading: false, items: [{ teacherId: "t-bo", isPrimary: true }] },
    });
    const group = screen.getByRole("group", { name: "Föreslagna vikarier" });
    const bo = within(group).getByRole("button", { name: /Bo Ek/ });
    expect(bo).toHaveAttribute("aria-pressed", "false");
    await user.click(bo);
    expect(bo).toHaveAttribute("aria-pressed", "true");
  });

  it("moves the lesson out of its room when Ingen sal is chosen", async () => {
    const user = userEvent.setup();
    const { onChangeRoom } = renderDialogs({ target: { action: "room", lesson: LESSON } });
    const dialog = screen.getByRole("dialog");
    const room = within(dialog).getByRole("combobox", { name: "Sal" });
    expect(room).toHaveTextContent("Sal 12");
    await user.click(room);
    await user.click(await screen.findByRole("option", { name: "Ingen sal" }));
    await user.click(within(dialog).getByRole("button", { name: "Byt sal" }));
    expect(onChangeRoom).toHaveBeenCalledWith(LESSON, null);
  });

  it.each([
    ["cancel", "Ställ in lektion"],
    ["substitute", "Tilldela vikarie"],
    ["room", "Byt sal"],
  ] as const)("marks the %s dialog's confirmation as drift's write (Läsbehörighet)", (action, name) => {
    renderDialogs({ target: { action, lesson: LESSON } });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name })).toHaveAttribute("data-writes", "DRIFT");
    expect(within(dialog).getByRole("button", { name: "Avbryt" })).not.toHaveAttribute("data-writes");
  });
});
