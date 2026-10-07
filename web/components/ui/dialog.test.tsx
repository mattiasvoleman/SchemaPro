import { describe, expect, it, vi } from "vitest";
import { render as renderBare, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog";

/**
 * Rendered inside the app's own provider and catalogue: the built-in X takes
 * its screen-reader name from common.close, and a test with no provider would
 * prove nothing about which language that name is in.
 */
function render(ui: ReactNode, locale: "sv" | "en" = "sv") {
  return renderBare(ui, {
    wrapper: ({ children }) => (
      <NextIntlClientProvider locale={locale} messages={locale === "sv" ? sv : en} timeZone="Europe/Stockholm">
        {children}
      </NextIntlClientProvider>
    ),
  });
}

function ExampleDialog(props: { onOpenChange?: (open: boolean) => void }) {
  return (
    <Dialog onOpenChange={props.onOpenChange}>
      <DialogTrigger>Open settings</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Adjust your preferences.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

describe("Dialog", () => {

  it("cannot grow past the window, and scrolls when it would", () => {
    /*
     * Measured in a browser at a 560px window with forty teaching-group pills:
     * without these two classes the box was 655px tall and its top sat at -47,
     * so the TITLE was above the edge — and nothing scrolled, because the box
     * is centred with `top-1/2 -translate-y-1/2` rather than flowing down the
     * page. There was no way back to it. With them the same content measured
     * 528px, entirely inside the window, and scrolled.
     *
     * jsdom computes no layout, so what is checkable here is that the two
     * classes are still on the element. Removing either silently returns the
     * bug for every dialog in the app; nothing else would notice.
     *
     * `dvh` and not `vh`: on a phone `vh` excludes the browser's own chrome, so
     * a 100vh box puts its bottom under the address bar.
     */
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Lägg till lektion</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const box = screen.getByRole("dialog");
    expect(box.className).toContain("overflow-y-auto");
    // And never sideways. CSS forces overflow-x to `auto` once overflow-y is
    // not `visible`, so without this a footer one button too wide becomes a
    // scrollbar the reader has to operate rather than a wrap they can read.
    expect(box.className).toContain("overflow-x-hidden");
    expect(box.className).toMatch(/max-h-\[calc\(100dvh/);
  });
  it("is closed until the trigger is clicked", async () => {
    const user = userEvent.setup();
    render(<ExampleDialog />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open settings" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Adjust your preferences.")).toBeInTheDocument();
  });

  it("labels the dialog with its title", async () => {
    const user = userEvent.setup();
    render(<ExampleDialog />);

    await user.click(screen.getByRole("button", { name: "Open settings" }));

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it("closes via the built-in X button and reports it", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<ExampleDialog onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole("button", { name: "Open settings" }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    // The X in the corner carries an sr-only label, "Stäng" in Swedish.
    await user.click(screen.getByRole("button", { name: "Stäng" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("names the X in the interface's language, not always in English", async () => {
    // Walk-through 2026-10-07: every dialog's X read "Close" in the Swedish UI.
    const user = userEvent.setup();
    render(<ExampleDialog />);
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    expect(screen.getByRole("button", { name: "Stäng" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });

  it("names the X 'Close' in the English interface", async () => {
    const user = userEvent.setup();
    render(<ExampleDialog />, "en");
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("closes via a DialogClose child", async () => {
    const user = userEvent.setup();
    render(<ExampleDialog />);

    await user.click(screen.getByRole("button", { name: "Open settings" }));
    await user.click(screen.getByRole("button", { name: "Done" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<ExampleDialog onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole("button", { name: "Open settings" }));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("supports fully controlled open state", () => {
    const { rerender } = render(
      <Dialog open={false}>
        <DialogContent>
          <DialogTitle>Controlled</DialogTitle>
          <DialogDescription>Body</DialogDescription>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    rerender(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Controlled</DialogTitle>
          <DialogDescription>Body</DialogDescription>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByRole("dialog", { name: "Controlled" })).toBeInTheDocument();
  });
});
