import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilterPicker, type FilterSection } from "./filter-picker";

vi.mock("next-intl", () => ({
  // The namespace rides along, as in the page's own mock: the component asks
  // two of them and a key alone could not tell "search" apart between them.
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values
      ? `${namespace}.${key} ${Object.values(values).join(" ")}`
      : `${namespace}.${key}`,
}));

const SECTIONS = [
  {
    label: "timetable.filterKindClasses",
    options: [
      { id: "g-41", name: "4.1" },
      { id: "g-42", name: "4.2" },
    ],
  },
  {
    label: "timetable.filterKindTeachingGroups",
    options: [
      { id: "g-ma1", name: "4ma1" },
      { id: "g-sv1", name: "Svenska åk 5" },
    ],
  },
];

function open(value: string[] = [], sections: FilterSection[] = SECTIONS) {
  const onChange = vi.fn();
  render(
    <FilterPicker
      sections={sections}
      value={value}
      onChange={onChange}
      label="timetable.filterGroup"
      allLabel="timetable.allGroups"
      countLabel={(count) => `timetable.groupsSelected ${count}`}
    />,
  );
  return { onChange, user: userEvent.setup() };
}

describe("the picker's trigger", () => {
  it("says every group when nothing is picked", () => {
    open();
    expect(screen.getByRole("button", { name: "timetable.filterGroup" })).toHaveTextContent(
      "timetable.allGroups",
    );
  });

  it("names the one group when exactly one is picked", () => {
    // The case a rektor is in most of the time, and the name is the whole
    // answer — a count would make them open the menu to see which.
    open(["g-42"]);
    expect(screen.getByRole("button", { name: "timetable.filterGroup" })).toHaveTextContent(
      "4.2",
    );
  });

  it("counts them when several are picked", () => {
    // Four names do not fit a button, and truncating would name some and hide
    // the rest, which is worse than naming none.
    open(["g-41", "g-42", "g-ma1"]);
    expect(screen.getByRole("button", { name: "timetable.filterGroup" })).toHaveTextContent(
      "timetable.groupsSelected 3",
    );
  });
});

describe("picking groups", () => {
  it("adds one without dropping the others", async () => {
    const { onChange, user } = open(["g-41"]);

    await user.click(screen.getByRole("button", { name: "timetable.filterGroup" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "4.2" }));

    expect(onChange).toHaveBeenCalledWith(["g-41", "g-42"]);
  });

  it("removes one that was already picked", async () => {
    const { onChange, user } = open(["g-41", "g-42"]);

    await user.click(screen.getByRole("button", { name: "timetable.filterGroup" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "4.1" }));

    expect(onChange).toHaveBeenCalledWith(["g-42"]);
  });

  it("stays open so several can be ticked in one visit", async () => {
    const { user } = open();

    await user.click(screen.getByRole("button", { name: "timetable.filterGroup" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "4.1" }));

    expect(screen.queryByRole("menuitemcheckbox", { name: "4.2" })).toBeInTheDocument();
  });

  it("clears back to every group", async () => {
    const { onChange, user } = open(["g-41", "g-42"]);

    await user.click(screen.getByRole("button", { name: "timetable.filterGroup" }));
    await user.click(await screen.findByText("timetable.allGroups"));

    expect(onChange).toHaveBeenCalledWith([]);
  });
});

describe("finding a group among hundreds", () => {
  it("separates the classes from the teaching groups", async () => {
    // A school can have a couple of dozen classes and hundreds of teaching
    // groups — Kunskapsskolan has 24 and 300 — so one flat list buries the
    // class a rektor is looking for.
    const { user } = open();

    await user.click(screen.getByRole("button", { name: "timetable.filterGroup" }));

    expect(await screen.findByText("timetable.filterKindClasses")).toBeInTheDocument();
    expect(screen.getByText("timetable.filterKindTeachingGroups")).toBeInTheDocument();
  });

  it("searches across both kinds at once", async () => {
    const { user } = open();

    await user.click(screen.getByRole("button", { name: "timetable.filterGroup" }));
    await user.type(await screen.findByPlaceholderText("common.search"), "4");

    // "4.1", "4.2" and "4ma1" all carry a four; "Svenska åk 5" does not.
    expect(screen.getByRole("menuitemcheckbox", { name: "4ma1" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox", { name: "Svenska åk 5" })).toBeNull();
  });

  it("matches without regard to case", async () => {
    const { user } = open();

    await user.click(screen.getByRole("button", { name: "timetable.filterGroup" }));
    await user.type(await screen.findByPlaceholderText("common.search"), "svenska");

    expect(screen.getByRole("menuitemcheckbox", { name: "Svenska åk 5" })).toBeInTheDocument();
  });

  it("says so when nothing matches, rather than showing an empty menu", async () => {
    const { user } = open();

    await user.click(screen.getByRole("button", { name: "timetable.filterGroup" }));
    await user.type(await screen.findByPlaceholderText("common.search"), "zzz");

    expect(await screen.findByText("common.noResults")).toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox")).toBeNull();
  });
});

describe("a list that needs no sections", () => {
  it("draws no heading for a single unlabelled section", async () => {
    // Teachers and rooms are one list each. A heading over the only section
    // would be a label for "everything", which says nothing.
    const { user } = open([], [{ options: [{ id: "t-1", name: "Anna Andersson" }] }]);

    await user.click(screen.getByRole("button", { name: "timetable.filterGroup" }));

    expect(
      await screen.findByRole("menuitemcheckbox", { name: "Anna Andersson" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("timetable.filterKindClasses")).toBeNull();
  });
});
