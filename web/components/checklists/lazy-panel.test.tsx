import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderChecklists } from "@/lib/__fixtures__/checklists-render";
import sv from "@/messages/sv.json";
import { LazyPanel, useLazy } from "./lazy-panel";

/**
 * A part of the page fetched when it is drawn: a skeleton while it comes, the
 * part when it has, and, when its chunk does not arrive, a notice where the part
 * would have been with a button that tries again (and never a retry of its own,
 * which would loop on a chunk that keeps failing).
 */

function Probe({ load }: { load: () => Promise<{ default: () => React.ReactElement }> }) {
  const [Part, again] = useLazy(load);
  return (
    <LazyPanel again={again}>
      <Part />
    </LazyPanel>
  );
}

let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React logs the error a boundary catches.
  log = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  log.mockRestore();
});

describe("a lazy part of the page", () => {
  it("shows a skeleton while the part is fetched, and then the part", async () => {
    let arrive: ((module: { default: () => React.ReactElement }) => void) | undefined;
    const load = vi.fn(() => new Promise<{ default: () => React.ReactElement }>((resolve) => (arrive = resolve)));
    const { container } = renderChecklists(<Probe load={load} />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    arrive!({ default: () => <p>Delen</p> });
    expect(await screen.findByText("Delen")).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("is a skeleton in the server's html and while the page hydrates, and draws the part only after, so the two agree", async () => {
    // The server cannot fetch what the part reads, and by the time the part's chunk has arrived a sibling has, so a part drawn during hydration would read the cache where the html shows it loading.
    const part = <p>Delen</p>;
    const tree = (
      <NextIntlClientProvider locale="sv" messages={sv}>
        <LazyPanel again={() => undefined}>{part}</LazyPanel>
      </NextIntlClientProvider>
    );
    const html = renderToString(tree);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("Delen");

    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.append(host);
    const problems: unknown[] = [];
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(host, tree, { onRecoverableError: (error) => problems.push(error) });
    });
    expect(problems).toEqual([]);
    expect(host.textContent).toContain("Delen");
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    act(() => root?.unmount());
    host.remove();
  });

  it("says a chunk that does not arrive, where the part would be, and fetches it again on the button", async () => {
    const user = userEvent.setup({ delay: null });
    const load = vi
      .fn<() => Promise<{ default: () => React.ReactElement }>>()
      .mockRejectedValueOnce(new Error("ChunkLoadError"))
      .mockResolvedValue({ default: () => <p>Delen</p> });
    renderChecklists(<Probe load={load} />);
    expect(await screen.findByText("Den här delen av sidan kunde inte hämtas")).toBeInTheDocument();
    expect(screen.getByText("Inget har ändrats. Kontrollera anslutningen och försök igen.")).toBeInTheDocument();
    // It does not try again by itself.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(load).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(await screen.findByText("Delen")).toBeInTheDocument();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Den här delen av sidan kunde inte hämtas")).not.toBeInTheDocument();
  });

  it("keeps saying so when the chunk fails again", async () => {
    const user = userEvent.setup({ delay: null });
    const load = vi.fn().mockRejectedValue(new Error("ChunkLoadError"));
    renderChecklists(<Probe load={load} />);
    await user.click(await screen.findByRole("button", { name: "Försök igen" }));
    expect(await screen.findByText("Den här delen av sidan kunde inte hämtas")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
