import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignOutButton } from "./sign-out-button";

/**
 * The Supabase client is reached through the real lazy import in
 * utils/supabase/load-client.ts; only the client module itself is mocked, as
 * in the sign-in form's tests.
 */

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
const authMocks = vi.hoisted(() => ({ signOut: vi.fn(), unavailable: false }));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

vi.mock("@/utils/supabase/client", () => ({
  createClient: () => {
    if (authMocks.unavailable) throw new Error("chunk failed to load");
    return { auth: { signOut: authMocks.signOut } };
  },
}));

const failed = "Något gick fel";

function renderButton() {
  return render(
    <SignOutButton loginPath="/sv/login" className="btn" label="Logga ut" failed={failed} />,
  );
}

beforeEach(() => {
  routerMocks.replace.mockReset();
  routerMocks.refresh.mockReset();
  authMocks.signOut.mockReset();
  authMocks.unavailable = false;
});

describe("SignOutButton", () => {
  it("signs out before sending the user to this locale's sign-in page", async () => {
    const order: string[] = [];
    authMocks.signOut.mockImplementation(async () => {
      order.push("signOut");
      return { error: null };
    });
    routerMocks.replace.mockImplementation(() => {
      order.push("replace");
    });
    renderButton();

    await userEvent.setup().click(screen.getByRole("button", { name: "Logga ut" }));

    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/sv/login"));
    expect(order).toEqual(["signOut", "replace"]);
    expect(routerMocks.refresh).toHaveBeenCalled();
    expect(screen.queryByText(failed)).not.toBeInTheDocument();
  });

  it("says something went wrong and stays put when the client cannot load", async () => {
    authMocks.unavailable = true;
    renderButton();

    await userEvent.setup().click(screen.getByRole("button", { name: "Logga ut" }));

    expect(await screen.findByText(failed)).toBeInTheDocument();
    expect(authMocks.signOut).not.toHaveBeenCalled();
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(routerMocks.refresh).not.toHaveBeenCalled();
  });

  it("does not pretend the user is signed out when Supabase refuses", async () => {
    authMocks.signOut.mockResolvedValue({ error: { message: "Failed to fetch" } });
    renderButton();

    await userEvent.setup().click(screen.getByRole("button", { name: "Logga ut" }));

    expect(await screen.findByText(failed)).toBeInTheDocument();
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(routerMocks.refresh).not.toHaveBeenCalled();
  });

  it("lets the user try again, and clears the error when the retry works", async () => {
    authMocks.unavailable = true;
    authMocks.signOut.mockResolvedValue({ error: null });
    renderButton();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Logga ut" }));
    expect(await screen.findByText(failed)).toBeInTheDocument();

    authMocks.unavailable = false;
    await user.click(screen.getByRole("button", { name: "Logga ut" }));

    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/sv/login"));
    expect(screen.queryByText(failed)).not.toBeInTheDocument();
  });
});
