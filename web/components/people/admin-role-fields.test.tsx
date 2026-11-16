import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import { AdminRoleFields } from "./admin-role-fields";

/**
 * The administrator half of the role chooser. What is held here is the mark
 * "Undervisar" (Users.teaches): who sees it, who can change it, and what it is
 * said to be. The page's own test covers when it is sent and in what order.
 */

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

function renderFields(props: Partial<Parameters<typeof AdminRoleFields>[0]> = {}) {
  const onTeachesChange = vi.fn();
  render(
    <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
      <AdminRoleFields
        adminProfile="REKTOR"
        hrRead={false}
        teaches={false}
        decides
        onChange={vi.fn()}
        onTeachesChange={onTeachesChange}
        {...props}
      />
    </NextIntlClientProvider>,
  );
  return { onTeachesChange };
}

describe("Undervisar", () => {
  it("explains what the mark is and what it is not: the teacher's pages and part in an alarm, the rights unchanged", () => {
    renderFields();
    expect(screen.getByRole("switch", { name: "Undervisar" })).toHaveAccessibleDescription(
      "Personen står på lektioner och får lärarens egna sidor och roll i larmet. Rätten som administratör är densamma.",
    );
  });

  it("is changed by somebody who decides", async () => {
    const { onTeachesChange } = renderFields();
    await userEvent.setup().click(screen.getByRole("switch", { name: "Undervisar" }));
    expect(onTeachesChange).toHaveBeenCalledWith(true);
  });

  it("is locked for somebody who does not, with the sentence that says who changes it, as the profile has", () => {
    renderFields({ decides: false });
    const mark = screen.getByRole("switch", { name: "Undervisar" });
    expect(mark).toBeDisabled();
    expect(mark).toHaveAccessibleDescription(/Bara rektor eller en fullständig administratör ändrar roller, profiler och HR-läs\.$/);
    // The profile beside it says the same, with the same sentence.
    expect(screen.getAllByText(/Bara rektor eller en fullständig administratör ändrar roller/).length).toBe(2);
  });

  it("is locked while the profile is not known: the stored mark is not known either", () => {
    renderFields({ unavailable: "loading" });
    expect(screen.getByRole("switch", { name: "Undervisar" })).toBeDisabled();
  });

  it("shows the mark as stored", () => {
    renderFields({ teaches: true });
    expect(screen.getByRole("switch", { name: "Undervisar" })).toBeChecked();
  });

  it.each(["FULL", "REKTOR", "SCHEMALAGGARE", "EXPEDITION"] as const)("is offered to the profile %s", (adminProfile) => {
    renderFields({ adminProfile });
    expect(screen.getByRole("switch", { name: "Undervisar" })).toBeInTheDocument();
  });

  it("is not offered to a läsare, who changes nothing and so teaches nothing", () => {
    renderFields({ adminProfile: "LASARE" });
    expect(screen.queryByRole("switch", { name: "Undervisar" })).not.toBeInTheDocument();
    // HR-läs is still a läsare's grant.
    expect(screen.getByRole("switch", { name: "HR-läs" })).toBeInTheDocument();
  });
});
