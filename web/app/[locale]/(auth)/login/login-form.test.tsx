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
  signInWithOAuth: vi.fn(),
  unavailable: false,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

vi.mock("@/utils/supabase/client", () => ({
  createClient: () => {
    if (authMocks.unavailable) throw new Error("chunk failed to load");
    return {
      auth: { signInWithPassword: authMocks.signInWithPassword, signInWithOAuth: authMocks.signInWithOAuth },
    };
  },
}));

const labels = {
  signIn: "Logga in",
  signingIn: "Loggar in…",
  invalidCredentials: "Fel e-post eller lösenord.",
  failed: "Något gick fel",
  ssoRequired: "Din skola kräver att personal loggar in med skolkonto.",
};

const schoolAccount = {
  apiBase: "https://api.example/",
  callbackPath: "/sv/auth/callback",
  className: "btn-outline w-full",
  labels: {
    button: "Logga in med skolkonto",
    or: "eller",
    redirecting: "Skickar dig till skolans inloggning…",
    needsEmail: "Skriv din e-postadress först.",
    notFound: "Ingen skola loggar in med skolkonto på den domänen.",
  },
};

function renderForm(options: { withSchoolAccount?: boolean } = {}) {
  return render(
    <LoginForm
      home="/sv"
      submitClassName="btn w-full"
      labels={labels}
      schoolAccount={options.withSchoolAccount ? schoolAccount : undefined}
    >
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

const fetchMock = vi.fn();

beforeEach(() => {
  routerMocks.replace.mockReset();
  routerMocks.refresh.mockReset();
  authMocks.signInWithPassword.mockReset();
  authMocks.signInWithOAuth.mockReset();
  authMocks.unavailable = false;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

const answer = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

async function chooseSchoolAccount(email: string) {
  const user = userEvent.setup();
  if (email) await user.type(screen.getByLabelText("E-post"), email);
  await user.click(screen.getByRole("button", { name: "Logga in med skolkonto" }));
}

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

  it("says the school requires its school account when the access-token hook refuses the password", async () => {
    // Auth's answer, measured against GoTrue v2.197.0: 403, the hook's code as the message.
    authMocks.signInWithPassword.mockResolvedValue({ error: { status: 403, message: "sso_required", code: "unknown" } });
    renderForm();

    await fillAndSubmit();

    expect(await screen.findByRole("alert")).toHaveTextContent(labels.ssoRequired);
    expect(screen.queryByText(labels.invalidCredentials)).not.toBeInTheDocument();
  });

  it("offers no school account without the gateway's address", () => {
    renderForm();
    expect(screen.queryByRole("button", { name: "Logga in med skolkonto" })).not.toBeInTheDocument();
  });

  it("asks for the address first, and puts the cursor in it", async () => {
    renderForm({ withSchoolAccount: true });

    await chooseSchoolAccount("");

    expect(await screen.findByRole("alert")).toHaveTextContent(schoolAccount.labels.needsEmail);
    expect(screen.getByLabelText("E-post")).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the gateway about the domain alone, and sends the browser to the school's provider with hints", async () => {
    fetchMock.mockReturnValue(answer({ provider: "azure" }));
    authMocks.signInWithOAuth.mockResolvedValue({ error: null });
    renderForm({ withSchoolAccount: true });

    await chooseSchoolAccount("Anna.Andersson@Skola.Example");

    await waitFor(() => expect(authMocks.signInWithOAuth).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("https://api.example/public/v1/sign-in-methods/skola.example", expect.anything());
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain("anna");
    expect(authMocks.signInWithOAuth).toHaveBeenCalledWith({
      provider: "azure",
      options: {
        redirectTo: `${window.location.origin}/sv/auth/callback`,
        queryParams: { login_hint: "Anna.Andersson@Skola.Example", domain_hint: "skola.example" },
        // Entra returns an address only when asked for it.
        scopes: "email",
      },
    });
    // On its way to the provider: still busy, nothing to retry.
    expect(screen.getByRole("button", { name: schoolAccount.labels.redirecting })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Logga in" })).toBeDisabled();
    expect(authMocks.signInWithPassword).not.toHaveBeenCalled();
  });

  it("gives Google the address and no domain hint", async () => {
    fetchMock.mockReturnValue(answer({ provider: "google" }));
    authMocks.signInWithOAuth.mockResolvedValue({ error: null });
    renderForm({ withSchoolAccount: true });

    await chooseSchoolAccount("elev@skola.example");

    await waitFor(() =>
      expect(authMocks.signInWithOAuth).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "google",
          options: { redirectTo: `${window.location.origin}/sv/auth/callback`, queryParams: { login_hint: "elev@skola.example" } },
        }),
      ),
    );
  });

  it("says no school signs in with a school account on that domain", async () => {
    fetchMock.mockReturnValue(answer({ provider: null }));
    renderForm({ withSchoolAccount: true });

    await chooseSchoolAccount("vardnadshavare@gmail.example");

    expect(await screen.findByRole("alert")).toHaveTextContent(schoolAccount.labels.notFound);
    expect(authMocks.signInWithOAuth).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Logga in med skolkonto" })).toBeEnabled();
  });

  it("says something went wrong, not that there is no school account, when the gateway or Auth fails", async () => {
    fetchMock.mockReturnValue(answer({ message: "Too Many Requests" }, 429));
    renderForm({ withSchoolAccount: true });
    await chooseSchoolAccount("larare@skola.example");
    expect(await screen.findByRole("alert")).toHaveTextContent(labels.failed);

    fetchMock.mockReturnValue(answer({ provider: "azure" }));
    authMocks.signInWithOAuth.mockResolvedValue({ error: { message: "Unsupported provider" } });
    await userEvent.setup().click(screen.getByRole("button", { name: "Logga in med skolkonto" }));
    await waitFor(() => expect(authMocks.signInWithOAuth).toHaveBeenCalled());
    expect(await screen.findByRole("alert")).toHaveTextContent(labels.failed);
    expect(screen.getByRole("button", { name: "Logga in med skolkonto" })).toBeEnabled();
  });

  it("still signs in with the password on Enter", async () => {
    authMocks.signInWithPassword.mockResolvedValue({ error: null });
    renderForm({ withSchoolAccount: true });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("E-post"), "larare@skola.se");
    await user.type(screen.getByLabelText("Lösenord"), "hemligt123{Enter}");

    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/sv"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
