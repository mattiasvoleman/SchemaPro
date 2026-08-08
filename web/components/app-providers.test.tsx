import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "./app-providers";

// Sonner's Toaster is third-party UI; mocked at the module boundary so the
// test pins the configuration AppProviders passes it without rendering the
// real portal machinery.
vi.mock("sonner", () => ({
  Toaster: (props: { richColors?: boolean; position?: string }) => (
    <div
      data-testid="toaster"
      data-position={props.position}
      data-rich-colors={String(props.richColors)}
    />
  ),
}));

const captured: { clients: QueryClient[] } = { clients: [] };

function ClientProbe() {
  captured.clients.push(useQueryClient());
  return <p>probe child</p>;
}

beforeEach(() => {
  captured.clients.length = 0;
});

describe("AppProviders", () => {
  it("renders children and mounts the toaster bottom-right with rich colors", () => {
    render(
      <AppProviders>
        <p>authenticated page</p>
      </AppProviders>,
    );

    expect(screen.getByText("authenticated page")).toBeInTheDocument();
    const toaster = screen.getByTestId("toaster");
    expect(toaster).toHaveAttribute("data-position", "bottom-right");
    expect(toaster).toHaveAttribute("data-rich-colors", "true");
  });

  it("provides a query client with the documented defaults", () => {
    render(
      <AppProviders>
        <ClientProbe />
      </AppProviders>,
    );

    expect(captured.clients).toHaveLength(1);
    const defaults = captured.clients[0].getDefaultOptions().queries;
    expect(defaults?.staleTime).toBe(30_000);
    expect(defaults?.retry).toBe(1);
    expect(defaults?.refetchOnWindowFocus).toBe(false);
  });

  it("keeps the same query client instance across re-renders (cache survives)", () => {
    const { rerender } = render(
      <AppProviders>
        <ClientProbe />
      </AppProviders>,
    );
    rerender(
      <AppProviders>
        <ClientProbe />
      </AppProviders>,
    );

    expect(captured.clients.length).toBeGreaterThanOrEqual(2);
    expect(new Set(captured.clients).size).toBe(1);
  });
});
