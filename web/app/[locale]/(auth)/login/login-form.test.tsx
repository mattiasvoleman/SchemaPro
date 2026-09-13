import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "./login-form";

/**
 * The browser half of /login. The page renders the fields on the server and
 * hands them in; this pins what the form does with them.
 *
 * Nothing here mounts NextIntlClientProvider, and that is part of the test:
 * the unauthenticated routes no longer have one, so a next-intl hook creeping
 * back into this component fails every case below.
 *
 * The Supabase client is reached through the real lazy import in
 * utils/supabase/load-client.ts; only the client module itself is mocked.
 */

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
const authMocks = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  unavailable: false,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

vi.mock("@/utils/supabase/client", () => ({
  createClient: () => {
    if (authMocks.unavailable) throw new Error("chunk failed to load");
    return { auth: { signInWithPassword: authMocks.signInWithPassword } };
  },
}));

const labels = {
  signIn: "Logga in",
  signingIn: "Loggar in…",
  invalidCredentials: "Fel e-post eller lösenord.",
  failed: "Något gick fel",
};

function renderForm() {
  return render(
    <LoginForm home="/sv" submitClassName="btn w-full" labels={labels}>
      <label htmlFor="email">E-post</label>
      <input id="email" name="email" type="email" />
      <label htmlFor="password">Lösenord</label>
      <input id="password" name="password" type="password" />
    </LoginForm>,
  );
}

async function fillAndSubmit() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("E-post"), "larare@skola.se");
  await user.type(screen.getByLabelText("Lösenord"), "hemligt123");
  await user.click(screen.getByRole("button", { name: "Logga in" }));
}

beforeEach(() => {
  routerMocks.replace.mockReset();
  routerMocks.refresh.mockReset();
  authMocks.signInWithPassword.mockReset();
  authMocks.unavailable = false;
});

describe("LoginForm", () => {
  it("renders the fields it is given and a submit button with the server's class", () => {
    renderForm();

    expect(screen.getByLabelText("E-post")).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "Logga in" });
    expect(submit).toHaveAttribute("type", "submit");
    expect(submit).toHaveClass("btn", "w-full");
  });

  it("signs in with what was typed and sends the user to the locale root", async () => {
    authMocks.signInWithPassword.mockResolvedValue({ error: null });
    renderForm();

    await fillAndSubmit();

    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/sv"));
    expect(authMocks.signInWithPassword).toHaveBeenCalledWith({
      email: "larare@skola.se",
      password: "hemligt123",
    });
    expect(routerMocks.refresh).toHaveBeenCalled();
    expect(screen.queryByText(labels.invalidCredentials)).not.toBeInTheDocument();
  });

  it("disables the button and says it is signing in while the request runs", async () => {
    authMocks.signInWithPassword.mockReturnValue(new Promise(() => {}));
    renderForm();

    await fillAndSubmit();

    const pending = await screen.findByRole("button", { name: "Loggar in…" });
    expect(pending).toBeDisabled();
  });

  it("shows the credentials error and lets the user try again", async () => {
    authMocks.signInWithPassword.mockResolvedValue({
      error: { message: "Invalid login credentials" },
    });
    renderForm();

    await fillAndSubmit();

    expect(await screen.findByText(labels.invalidCredentials)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Logga in" })).toBeEnabled();
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });

  it("says something went wrong, not that the password was wrong, when the client cannot load", async () => {
    authMocks.unavailable = true;
    renderForm();

    await fillAndSubmit();

    expect(await screen.findByText(labels.failed)).toBeInTheDocument();
    expect(screen.queryByText(labels.invalidCredentials)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Logga in" })).toBeEnabled();
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });
});
