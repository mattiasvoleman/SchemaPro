import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NATIONAL } from "@/lib/__fixtures__/timplan-statute";
import { CopyDialog, gatewayDraftName } from "./copy-dialog";
import { CreateDialog, defaultVersionFor } from "./create-dialog";
import { DecideDialog } from "./decide-dialog";

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

describe("DecideDialog", () => {
  it("will not decide without a note that identifies the decision", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {});
    render(<DecideDialog open onOpenChange={() => {}} planName="Grundskola 2026" pending={false} onConfirm={onConfirm} />);

    expect(screen.getByText("decideBody(Grundskola 2026)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "decideConfirm" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("decisionNoteRequired");

    await user.type(screen.getByLabelText("decisionNoteLabel"), "   ");
    await user.click(screen.getByRole("button", { name: "decideConfirm" }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("sends the note trimmed", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {});
    render(<DecideDialog open onOpenChange={() => {}} planName="P" pending={false} onConfirm={onConfirm} />);
    await user.type(screen.getByLabelText("decisionNoteLabel"), "  Beslutat av huvudman 2026-05-12, dnr 12  ");
    await user.click(screen.getByRole("button", { name: "decideConfirm" }));
    expect(onConfirm).toHaveBeenCalledWith("Beslutat av huvudman 2026-05-12, dnr 12");
  });

  it("refuses a note longer than the column takes", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {});
    render(<DecideDialog open onOpenChange={() => {}} planName="P" pending={false} onConfirm={onConfirm} />);
    const field = screen.getByLabelText("decisionNoteLabel");
    await user.click(field);
    await user.paste("x".repeat(501));
    await user.click(screen.getByRole("button", { name: "decideConfirm" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("decisionNoteTooLong");
  });
});

describe("CopyDialog", () => {
  it("reopens a decided plan into a draft the admin may name, saying the decided one stays", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {});
    render(<CopyDialog mode="reopen" open onOpenChange={() => {}} planName="Beslutad 2026" pending={false} onConfirm={onConfirm} />);
    expect(screen.getByText("reopenBody(Beslutad 2026)")).toBeInTheDocument();
    expect(screen.getByText("copyNameHint(Beslutad 2026 (utkast))")).toBeInTheDocument();
    await user.type(screen.getByLabelText("copyNameLabel"), " Utkast HT2027 ");
    await user.click(screen.getByRole("button", { name: "reopenConfirm" }));
    expect(onConfirm).toHaveBeenCalledWith("Utkast HT2027");
  });

  it("announces the very name the gateway will give: its Swedish suffix, numbered when taken", () => {
    // The English hint said "P (draft)" and neither locale knew the number,
    // so the toast landed on a draft named otherwise than announced.
    render(
      <CopyDialog
        mode="copy"
        open
        onOpenChange={() => {}}
        planName="P"
        takenNames={["P", "P (kopia)", "P (kopia 2)"]}
        pending={false}
        onConfirm={async () => {}}
      />,
    );
    expect(screen.getByText("copyNameHint(P (kopia 3))")).toBeInTheDocument();
    expect(gatewayDraftName("x".repeat(100), "utkast", [])).toBe(`${"x".repeat(91)} (utkast)`);
    expect(gatewayDraftName("x".repeat(100), "utkast", []).length).toBe(100);
  });

  it("leaves the name to the gateway when the field is empty", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {});
    render(<CopyDialog mode="copy" open onOpenChange={() => {}} planName="P" pending={false} onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "copyConfirm" }));
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });
});

describe("CreateDialog", () => {
  it("defaults a grundskola plan to the bilaga in force, not to the unpublished 2028 law", () => {
    expect(defaultVersionFor(NATIONAL.versions, "GRUNDSKOLA")?.code).toBe("SFS2023:945/B1");
    expect(defaultVersionFor(NATIONAL.versions, "SAMESKOLA")?.code).toBe("SFS2023:945/B4");
  });

  it("creates with 35,6 weeks and the form's version, and wants a name", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {});
    render(<CreateDialog open onOpenChange={() => {}} versions={NATIONAL.versions} pending={false} onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "createConfirm" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText("nameRequired")).toBeInTheDocument();

    await user.type(screen.getByLabelText("nameLabel"), "Grundskola 2026");
    await user.click(screen.getByRole("button", { name: "createConfirm" }));
    expect(onConfirm).toHaveBeenCalledWith({
      name: "Grundskola 2026",
      schoolForm: "GRUNDSKOLA",
      nationalTimplanVersionId: NATIONAL.versions.find((v) => v.code === "SFS2023:945/B1")!.id,
      planningWeeks: 35.6,
    });
  });
});
