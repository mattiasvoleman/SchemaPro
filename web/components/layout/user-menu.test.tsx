import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserMenu } from "./user-menu";

// Environment shims for Radix in jsdom (pointer capture, scroll) — not
// behaviour under test.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
const authMocks = vi.hoisted(() => ({ signOut: vi.fn() }));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => routerMocks,
}));

vi.mock("@/utils/supabase/client", () => ({
  createClient: () => ({ auth: { signOut: authMocks.signOut } }),
}));

// Namespace-aware key echo: t("signOut") from useTranslations("common")
// renders as "common.signOut", so assertions also pin the namespace used.
vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

beforeEach(() => {
  vi.clearAllMocks();
  authMocks.signOut.mockResolvedValue({ error: null });
});

describe("UserMenu initials", () => {
  it("uses the first letter of the first two name parts, uppercased", () => {
    render(<UserMenu userName="alma berg" email="alma@example.com" role="TEACHER" />);
    expect(screen.getByText("AB")).toBeInTheDocument();
  });

  it("shows a single initial for a one-part name", () => {
    render(<UserMenu userName="Alma" email="alma@example.com" role="TEACHER" />);
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("caps at two initials for long names", () => {
    render(<UserMenu userName="Anna Maria Berg" email="amb@example.com" role="TEACHER" />);
    expect(screen.getByText("AM")).toBeInTheDocument();
  });

  it("skips empty segments from doubled spaces", () => {
    render(<UserMenu userName="Alma  Berg" email="alma@example.com" role="TEACHER" />);
    expect(screen.getByText("AB")).toBeInTheDocument();
  });

  it("falls back to ? when the name is empty", () => {
    render(<UserMenu userName="" email="ghost@example.com" role="STUDENT" />);
    expect(screen.getByText("?")).toBeInTheDocument();
  });
});

describe("UserMenu dropdown", () => {
  it("shows name, email and translated role when opened", async () => {
    const user = userEvent.setup();
    render(<UserMenu userName="Alma Berg" email="alma@example.com" role="SCHOOL_ADMIN" />);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Alma Berg" }));

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByText("Alma Berg")).toBeInTheDocument();
    expect(screen.getByText("alma@example.com")).toBeInTheDocument();
    // The role is translated through the "roles" namespace, keyed by the enum.
    expect(screen.getByText("roles.SCHOOL_ADMIN")).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "common.signOut" }),
    ).toBeInTheDocument();
  });

  it("sign out ends the Supabase session, then replaces to /login and refreshes", async () => {
    const user = userEvent.setup();
    render(<UserMenu userName="Alma Berg" email="alma@example.com" role="TEACHER" />);

    await user.click(screen.getByRole("button", { name: "Alma Berg" }));
    await user.click(screen.getByRole("menuitem", { name: "common.signOut" }));

    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith("/login");
    });
    expect(authMocks.signOut).toHaveBeenCalledTimes(1);
    expect(routerMocks.refresh).toHaveBeenCalledTimes(1);
    // The redirect must wait for the session to actually be gone.
    expect(authMocks.signOut.mock.invocationCallOrder[0]).toBeLessThan(
      routerMocks.replace.mock.invocationCallOrder[0],
    );
  });
});
