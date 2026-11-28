import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { FillHead } from "./fill-head";
import sv from "@/messages/sv.json";

/*
 * The button of Lägg det som går in the board's toolbar: a writer's, small, and the dialog behind it is fetched when it is pressed.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const dialog = vi.hoisted(() => ({ renders: vi.fn(), explode: false }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/components/schedule/fill-dialog", () => ({
  FillDialog: (props: { yearId: string; open: boolean; onClose: () => void }) => {
    dialog.renders(props.yearId);
    if (dialog.explode) throw new Error("the dialog threw while it drew");
    return (
      <div role="dialog" aria-label="fill">
        <button onClick={props.onClose}>stäng dialogen</button>
      </div>
    );
  },
}));

const groups = new Map([["g1", { name: "7A", gradeLevel: 7 }]]);
const subjects = new Map([["s1", { name: "Matematik" }]]);
const head = (writable: boolean) => (
  <NextIntlClientProvider locale="sv" messages={sv}>
    <FillHead yearId="y1" revision={1} groupById={groups} subjectById={subjects} writable={writable} />
  </NextIntlClientProvider>
);

beforeEach(() => {
  dialog.renders.mockReset();
  dialog.explode = false;
  toast.error.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FillHead", () => {
  it("is a button for a writer, and nothing for a reader of the grundschema", () => {
    const { container } = render(head(false));
    expect(container.innerHTML).toBe("");
    cleanup();
    render(head(true));
    expect(screen.getByRole("button", { name: "Lägg det som går" }).getAttribute("data-writes")).toBe("SCHEMALAGGNING DRIFT");
  });

  it("fetches the dialog when the button is pressed, hands it the year and the lists the page reads, and closes it again", async () => {
    render(head(true));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(dialog.renders).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Lägg det som går" }));
    fireEvent.click(await screen.findByRole("button", { name: "stäng dialogen" }));
    expect(dialog.renders).toHaveBeenCalledWith("y1");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says in a toast when the dialog did not arrive or threw while it drew, and the button works again", async () => {
    dialog.explode = true;
    render(head(true));
    fireEvent.click(screen.getByRole("button", { name: "Lägg det som går" }));
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith("Dialogen gick inte att hämta. Försök igen."));
    expect(screen.queryByRole("dialog")).toBeNull();
    dialog.explode = false;
    fireEvent.click(screen.getByRole("button", { name: "Lägg det som går" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});
