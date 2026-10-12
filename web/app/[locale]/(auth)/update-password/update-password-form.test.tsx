import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpdatePasswordForm } from "./update-password-form";

/**
 * The browser half of /update-password, rendered without an intl provider for
 * the same reason as login-form.test.tsx.
 */

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
const authMocks = vi.hoisted(() => ({ updateUser: vi.fn(), unavailable: false }));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

vi.mock("@/utils/supabase/client", () => ({
  createClient: () => {
    if (authMocks.unavailable) throw new Error("chunk failed to load");
    return { auth: { updateUser: authMocks.updateUser } };
  },
}));

const labels = {
  updatePassword: "Uppdatera lösenord",
  failed: "Något gick fel",
  linkNeedsSchoolAccount: "Din skola kräver att personal loggar in med skolkonto.",
};

function renderForm() {
  return render(
    <UpdatePasswordForm home="/en" submitClassName="btn w-full" labels={labels}>
      <label htmlFor="password">Nytt lösenord</label>
      <input id="password" name="password" type="password" />
    </UpdatePasswordForm>,
  );
}

async function submitPassword() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Nytt lösenord"), "ett-nytt-lösenord");
  await user.click(screen.getByRole("button", { name: "Uppdatera lösenord" }));
}

beforeEach(() => {
  routerMocks.replace.mockReset();
  routerMocks.refresh.mockReset();
  authMocks.updateUser.mockReset();
  authMocks.unavailable = false;
  window.history.replaceState(null, "", "/sv/update-password");
});

describe("UpdatePasswordForm", () => {
  it("sets the typed password and sends the user to the locale root", async () => {
    authMocks.updateUser.mockResolvedValue({ error: null });
    renderForm();

    await submitPassword();

    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/en"));
    expect(authMocks.updateUser).toHaveBeenCalledWith({ password: "ett-nytt-lösenord" });
    expect(routerMocks.refresh).toHaveBeenCalled();
  });

  it("shows Supabase's own reason when the update is refused", async () => {
    authMocks.updateUser.mockResolvedValue({
      error: { message: "Password should be at least 8 characters." },
    });
    renderForm();

    await submitPassword();

    expect(
      await screen.findByText("Password should be at least 8 characters."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Uppdatera lösenord" })).toBeEnabled();
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });

  it("says something went wrong when the client cannot load", async () => {
    authMocks.unavailable = true;
    renderForm();

    await submitPassword();

    expect(await screen.findByText(labels.failed)).toBeInTheDocument();
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });

  it("says a refused invitation or recovery link needs the school account, and offers no password", async () => {
    // How Auth comes back when the access-token hook refuses the link's token.
    window.history.replaceState(null, "", "/sv/update-password#error=access_denied&error_code=&error_description=sso_required");
    renderForm();

    expect(await screen.findByRole("alert")).toHaveTextContent(labels.linkNeedsSchoolAccount);
    expect(screen.getByRole("button", { name: "Uppdatera lösenord" })).toBeDisabled();
  });

  it("reads the same refusal from the query, where a PKCE recovery link puts it", async () => {
    window.history.replaceState(null, "", "/sv/update-password?error=access_denied&error_description=sso_required");
    renderForm();

    expect(await screen.findByRole("alert")).toHaveTextContent(labels.linkNeedsSchoolAccount);
  });

  it("says nothing of the school account for any other link", () => {
    window.history.replaceState(null, "", "/sv/update-password#error_description=Email+link+is+invalid+or+has+expired");
    renderForm();

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Uppdatera lösenord" })).toBeEnabled();
  });
});
