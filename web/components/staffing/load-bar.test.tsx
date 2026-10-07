import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoadBar } from "./load-bar";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const segment = (name: string) =>
  document.querySelector(`[data-segment="${name}"]`) as HTMLElement | null;

describe("LoadBar", () => {
  it("draws teaching and the remainder, labelled as a percentage of target", () => {
    render(
      <LoadBar
        teacher={{
          assignedMinutesPerWeek: 900,
          targetMinutesPerWeek: 1080,
          peakMinutesPerWeek: 900,
          percentOfTarget: 83.3,
        }}
      />,
    );
    expect(segment("teaching")?.style.width).toBe("83.3%");
    expect(segment("remaining")?.style.width).toBe("16.7%");
    expect(segment("over")).toBeNull();
    expect(screen.getByText("barLabel(83,3)")).toBeInTheDocument();
    // The sentence a screen reader gets names every minute count.
    expect(screen.getByRole("img")).toHaveAttribute(
      "aria-label",
      "barDescription(900|1080|barRemaining(180))",
    );
  });

  it("paints the excess red and says how far over", () => {
    render(
      <LoadBar
        teacher={{
          assignedMinutesPerWeek: 1200,
          targetMinutesPerWeek: 1080,
          peakMinutesPerWeek: 1200,
          percentOfTarget: 111.1,
        }}
      />,
    );
    expect(segment("over")?.style.width).toBe("10%");
    expect(segment("remaining")).toBeNull();
    expect(screen.getByText("barLabel(111,1)")).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAttribute(
      "aria-label",
      "barDescription(1080|1080|barOver(120))",
    );
  });

  it("says there is no target rather than a percentage of nothing", () => {
    render(
      <LoadBar
        teacher={{
          assignedMinutesPerWeek: 300,
          targetMinutesPerWeek: null,
          peakMinutesPerWeek: 300,
          percentOfTarget: null,
        }}
      />,
    );
    expect(screen.getByText("barNoTarget")).toBeInTheDocument();
    expect(segment("teaching")?.style.width).toBe("100%");
    expect(screen.getByRole("img")).toHaveAttribute(
      "aria-label",
      "barTeaching(300) · barNoTarget",
    );
  });

  it("reads the peak week when asked", () => {
    render(
      <LoadBar
        week="peak"
        teacher={{
          assignedMinutesPerWeek: 900,
          targetMinutesPerWeek: 1080,
          peakMinutesPerWeek: 1140,
          percentOfTarget: 83.3,
        }}
      />,
    );
    expect(screen.getByText("barLabel(105,6)")).toBeInTheDocument();
    expect(segment("over")).not.toBeNull();
  });

  it("draws an uncounted uppdrag first and names a counted one in the sentence", () => {
    render(
      <LoadBar
        teacher={{
          assignedMinutesPerWeek: 900,
          targetMinutesPerWeek: 1080,
          peakMinutesPerWeek: 900,
          percentOfTarget: 88.9,
          // 90 min mentorskap that does not count, 60 min that does.
          dutyMinutesPerWeek: 150,
          countedDutyMinutesPerWeek: 60,
        }}
      />,
    );
    // Scale: 90 + 1080 = 1170.
    expect(segment("duty")?.style.width).toBe("7.7%");
    expect(segment("teaching")?.style.width).toBe("82.1%");
    expect(segment("remaining")?.style.width).toBe("10.3%");
    // 960 counted of 1080.
    expect(screen.getByText("barLabel(88,9)")).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAttribute(
      "aria-label",
      "barDescription(960|1080|barRemaining(120)) · barCountedDuty(60) · barDuty(90)",
    );
    // The duty segment comes first in the track.
    expect(segment("duty")?.nextElementSibling).toBe(segment("teaching"));
  });
});
