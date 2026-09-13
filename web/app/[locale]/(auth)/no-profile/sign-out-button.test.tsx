import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SignOutButton } from "./sign-out-button";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
const authMocks = vi.hoisted(() => ({ signOut: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

vi.mock("@/utils/supabase/client", () => ({
  createClient: () => ({ auth: { signOut: authMocks.signOut } }),
}));

describe("SignOutButton", () => {
  it("signs out before sending the user to this locale's sign-in page", async () => {
    const order: string[] = [];
    authMocks.signOut.mockImplementation(async () => {
      order.push("signOut");
    });
    routerMocks.replace.mockImplementation(() => {
      order.push("replace");
    });
    render(<SignOutButton loginPath="/sv/login" className="btn" label="Logga ut" />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Logga ut" }));

    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/sv/login"));
    expect(order).toEqual(["signOut", "replace"]);
    expect(routerMocks.refresh).toHaveBeenCalled();
  });
});
