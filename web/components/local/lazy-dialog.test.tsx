import { act, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import { LazyDialog, loadConfirm } from "./lazy-dialog";

/**
 * A dialog fetched the first time it is opened: nothing is fetched while it is shut, it is fetched once and then
 * kept, and a chunk that does not arrive is said in the reader's language, closes the dialog and is fetched
 * afresh on the next open.
 */

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

interface StubProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label?: string;
}
function Stub({ open, label }: StubProps) {
  return <p>{`${label ?? "dialog"} ${open ? "open" : "shut"}`}</p>;
}

function renderDialog(load: () => Promise<{ default: typeof Stub }>, props: StubProps, kind: "form" | "confirm" = "form") {
  const ui = (next: StubProps) => (
    <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
      <LazyDialog load={load} kind={kind} props={next} />
    </NextIntlClientProvider>
  );
  const view = render(ui(props));
  return { ...view, again: (next: StubProps) => view.rerender(ui(next)) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LazyDialog", () => {
  it("fetches nothing and draws nothing while it has never been open", () => {
    const load = vi.fn(async () => ({ default: Stub }));
    const { container } = renderDialog(load, { open: false, onOpenChange: vi.fn() });
    expect(load).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it("fetches on the first open, once, and keeps the dialog mounted after it closes", async () => {
    const load = vi.fn(async () => ({ default: Stub }));
    const { again } = renderDialog(load, { open: false, onOpenChange: vi.fn() });
    again({ open: true, onOpenChange: vi.fn() });
    expect(await screen.findByText("dialog open")).toBeInTheDocument();
    again({ open: false, onOpenChange: vi.fn() });
    expect(await screen.findByText("dialog shut")).toBeInTheDocument();
    again({ open: true, onOpenChange: vi.fn() });
    expect(await screen.findByText("dialog open")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("opens at once when it is rendered open", async () => {
    const load = vi.fn(async () => ({ default: Stub }));
    renderDialog(load, { open: true, onOpenChange: vi.fn() });
    expect(await screen.findByText("dialog open")).toBeInTheDocument();
  });

  it("passes the dialog's props on", async () => {
    const load = vi.fn(async () => ({ default: Stub }));
    renderDialog(load, { open: true, onOpenChange: vi.fn(), label: "Serien" });
    expect(await screen.findByText("Serien open")).toBeInTheDocument();
  });

  it.each([
    ["form", "Formuläret kunde inte öppnas. Inget är ändrat – försök igen."],
    ["confirm", "Bekräftelsen kunde inte öppnas. Inget är ändrat – försök igen."],
  ] as const)("says in the reader's language that a %s that does not arrive could not be opened, and closes", async (kind, sentence) => {
    const onOpenChange = vi.fn();
    const load = vi.fn(async (): Promise<{ default: typeof Stub }> => {
      throw new Error("Failed to fetch dynamically imported module: /_next/static/chunks/x.js");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderDialog(load, { open: true, onOpenChange }, kind);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(sentence));
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining("dynamically imported module"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    spy.mockRestore();
  });

  it("fetches afresh on the next open after a chunk failed", async () => {
    let attempts = 0;
    const load = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Failed to fetch dynamically imported module");
      return { default: Stub };
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { again } = renderDialog(load, { open: true, onOpenChange: vi.fn() });
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    await act(async () => {
      again({ open: false, onOpenChange: vi.fn() });
    });
    again({ open: true, onOpenChange: vi.fn() });
    expect(await screen.findByText("dialog open")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe("loadConfirm", () => {
  it("loads the confirmation dialog as a default export", async () => {
    const loaded = await loadConfirm();
    expect(typeof loaded.default).toBe("function");
  });
});
