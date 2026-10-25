import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateKeyForm } from "./create-key-form";

/**
 * The huvudman's new SS12000 key (Huvudman): posted as JSON to ./keys, shown
 * once in the component's state, with a way to copy it; a refusal in the
 * reader's words. fetch and the clipboard are stand-ins.
 */

const H = "55555555-5555-4555-8555-555555555555";
const labels = {
  title: "Ny nyckel",
  name: "Namn",
  scopes: "Behörigheter",
  submit: "Skapa nyckel",
  creating: "Skapar …",
  created: "Nyckeln {name} är skapad.",
  failed: "Det gick inte.",
  notYours: "Bara kommunadministratören.",
  copy: "Kopiera nyckeln",
  copied: "Kopierad",
};

describe("CreateKeyForm", () => {
  const fetchMock = vi.fn();
  const writeText = vi.fn(async () => undefined);
  beforeEach(() => {
    fetchMock.mockReset();
    writeText.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  const form = () =>
    render(<CreateKeyForm huvudman={H} action="/sv/huvudman/keys" scopes={["persons.read", "responsibles.read"]} labels={labels} />);

  it("posts the name and the scopes checked as JSON, shows the key once, and copies it", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "k", name: "Elevregistret", scopes: ["persons.read"], key: "sh_abc" }), { status: 201 }));
    form();
    const submit = screen.getByRole("button", { name: labels.submit });
    expect(submit.closest("form")).toHaveAttribute("method", "post");
    await waitFor(() => expect(submit).not.toBeDisabled());

    fireEvent.change(screen.getByLabelText(labels.name), { target: { value: "Elevregistret" } });
    fireEvent.click(submit);

    expect(await screen.findByText("sh_abc")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/sv/huvudman/keys",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ huvudman: H, name: "Elevregistret", scopes: ["persons.read"] }) }),
    );
    fireEvent.click(screen.getByRole("button", { name: labels.copy }));
    expect(await screen.findByRole("button", { name: labels.copied })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith("sh_abc");
  });

  it.each([
    ["HUVUDMAN_NOT_YOURS", 403, labels.notYours],
    ["HUVUDMAN_SCOPE_NOT_ALLOWED", 400, labels.failed],
  ])("says %s as the reader reads it", async (error, status, said) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error }), { status }));
    form();
    const submit = screen.getByRole("button", { name: labels.submit });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText(labels.name), { target: { value: "x" } });
    fireEvent.click(submit);

    expect(await screen.findByRole("alert")).toHaveTextContent(said);
    expect(screen.queryByRole("button", { name: labels.copy })).toBeNull();
  });
});
