import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForgotPasswordForm } from "./forgot-password-form";

/**
 * The browser half of /forgot-password, rendered without an intl provider for
 * the same reason as login-form.test.tsx.
 */

const authMocks = vi.hoisted(() => ({
  resetPasswordForEmail: vi.fn(),
  unavailable: false,
}));

vi.mock("@/utils/supabase/client", () => ({
  createClient: () => {
    if (authMocks.unavailable) throw new Error("chunk failed to load");
    return { auth: { resetPasswordForEmail: authMocks.resetPasswordForEmail } };
  },
}));

const labels = {
  sendResetLink: "Skicka länk",
  resetSent: "Kolla din inkorg — återställningslänken är på väg.",
  failed: "Något gick fel",
};

function renderForm() {
  return render(
    <ForgotPasswordForm
      updatePasswordPath="/sv/update-password"
      submitClassName="btn w-full"
      labels={labels}
    >
      <label htmlFor="email">E-post</label>
      <input id="email" name="email" type="email" />
    </ForgotPasswordForm>,
  );
}

async function requestLink() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("E-post"), "larare@skola.se");
  await user.click(screen.getByRole("button", { name: "Skicka länk" }));
}

beforeEach(() => {
  authMocks.resetPasswordForEmail.mockReset();
  authMocks.unavailable = false;
});

describe("ForgotPasswordForm", () => {
  it("asks for a link back to this locale's update-password page and confirms it", async () => {
    authMocks.resetPasswordForEmail.mockResolvedValue({ error: null });
    renderForm();

    await requestLink();

    expect(await screen.findByText(labels.resetSent)).toBeInTheDocument();
    expect(authMocks.resetPasswordForEmail).toHaveBeenCalledWith("larare@skola.se", {
      redirectTo: `${window.location.origin}/sv/update-password`,
    });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("confirms even when Supabase refuses, so the page never reveals who has an account", async () => {
    authMocks.resetPasswordForEmail.mockResolvedValue({
      error: { message: "User not found" },
    });
    renderForm();

    await requestLink();

    expect(await screen.findByText(labels.resetSent)).toBeInTheDocument();
  });

  it("does not claim a link was sent when the client could not even load", async () => {
    authMocks.unavailable = true;
    renderForm();

    await requestLink();

    expect(await screen.findByText(labels.failed)).toBeInTheDocument();
    expect(screen.queryByText(labels.resetSent)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Skicka länk" })).toBeEnabled(),
    );
  });
});
