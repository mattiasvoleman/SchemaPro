import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import {
  PlacementRulesFields,
  type PlacementErrors,
  type PlacementValues,
} from "./placement-rules-fields";

/**
 * Placeringsregler against the real message files, in both languages, with a
 * provider that throws on a missing key or a sentence that does not parse.
 * The card's and the forms' tests use an echo translator and would see
 * neither. What the card does with the values is in lunch-settings-card.test.tsx.
 */

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));

const values = (overrides: Partial<PlacementValues> = {}): PlacementValues => ({
  placementEdgeMode: "OFF",
  placementEdgeWeight: "250",
  placementPlacesMode: "OFF",
  placementPlacesWeight: "250",
  placementSharedMode: "OFF",
  placementSharedWeight: "250",
  maxClassRoomsPerDay: "",
  maxTeacherRoomsPerDay: "",
  maxClassBuildingsPerDay: "",
  maxTeacherBuildingsPerDay: "",
  ...overrides,
});

const fine: PlacementErrors = {
  edgeWeight: false,
  placesWeight: false,
  sharedWeight: false,
  limits: {
    maxClassRoomsPerDay: false,
    maxTeacherRoomsPerDay: false,
    maxClassBuildingsPerDay: false,
    maxTeacherBuildingsPerDay: false,
  },
  noLimit: false,
};

function inLocale(locale: "sv" | "en", ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "sv" ? sv : en}
      onError={(error) => {
        throw error;
      }}
    >
      {ui}
    </NextIntlClientProvider>,
  );
}

const fields = (
  overrides: Partial<PlacementValues> = {},
  errors: Partial<PlacementErrors> = {},
  markedSubjects: number | null = 0,
) => (
  <PlacementRulesFields
    values={values(overrides)}
    errors={{ ...fine, ...errors }}
    markedSubjects={markedSubjects}
    onChange={() => undefined}
  />
);

describe("Placeringsregler in Swedish", () => {
  it("names the three rules and what Av, Mjuk and Hård mean, in plain words", () => {
    inLocale("sv", fields());

    expect(screen.getByRole("heading", { name: "Placeringsregler" })).toBeInTheDocument();
    for (const name of ["Inte först eller sist på dagen", "Salar och byggnader per dag", "Delade salar"]) {
      expect(screen.getByRole("group", { name })).toBeInTheDocument();
    }
    const section = screen.getByRole("region", { name: "Placeringsregler" });
    // Hård can make a timetable impossible, and Generera then refuses and says why;
    // Mjuk tries and never refuses.
    expect(section).toHaveTextContent("Hård:");
    expect(section).toHaveTextContent("Generera vägrar då och skriver ut orsaken");
    expect(section).toHaveTextContent("Generera försöker hålla regeln men vägrar aldrig");
  });

  it("offers Inte först eller sist på dagen and Salar och byggnader per dag as Av and Mjuk, and says why not Hård", () => {
    inLocale("sv", fields());

    for (const name of ["Inte först eller sist på dagen", "Salar och byggnader per dag"]) {
      const group = screen.getByRole("group", { name });
      expect(within(group).getAllByRole("radio").map((radio) => radio.getAttribute("value"))).toEqual(["OFF", "SOFT"]);
      expect(group).toHaveTextContent("Hård finns inte för den här regeln ännu");
      expect(group).toHaveTextContent("inte mätt på en stor skola");
      expect(group).toHaveTextContent("Välj Av eller Mjuk.");
    }
    // Delade salar keeps all three, and says that Hård is the one rule that can be.
    const shared = screen.getByRole("group", { name: "Delade salar" });
    expect(within(shared).getAllByRole("radio")).toHaveLength(3);
    expect(shared).not.toHaveTextContent("Hård finns inte");
    expect(screen.getByRole("region", { name: "Placeringsregler" })).toHaveTextContent("som än så länge bara Delade salar kan vara");
  });

  it("states what Salar och byggnader per dag counts: the building field, room groups and how many are visited", () => {
    inLocale("sv", fields());

    const group = screen.getByRole("group", { name: "Salar och byggnader per dag" });
    expect(group).toHaveTextContent("salens uppgift Byggnad");
    expect(group).toHaveTextContent("salar utan byggnad räknas som samma byggnad");
    expect(group).toHaveTextContent("Lika salar av samma typ, storlek och årskurser räknas som en sal");
    // How many different ones are visited, not in what order: A–B–A is two buildings.
    expect(group).toHaveTextContent("1 betyder en enda hela dagen");
    expect(group).toHaveTextContent("Regeln räknar hur många olika som besöks och inte i vilken ordning");
    expect(group).toHaveTextContent("en dag som går A–B–A räknas som två byggnader");
    expect(group).toHaveTextContent("Klassen räknas på den grupps egna lektioner.");
    expect(group).toHaveTextContent("Lämna tomt för ingen gräns. 1 betyder en enda. Högst 20.");
    expect(within(group).getByLabelText("Klassens olika salar per dag")).toBeInTheDocument();
    expect(within(group).getByLabelText("Lärarens olika salar per dag")).toBeInTheDocument();
    expect(within(group).getByLabelText("Klassens olika byggnader per dag")).toBeInTheDocument();
    expect(within(group).getByLabelText("Lärarens olika byggnader per dag")).toBeInTheDocument();
  });

  it("says what Delade salar applies to and the difference between Hård and Mjuk", () => {
    inLocale("sv", fields());

    const group = screen.getByRole("group", { name: "Delade salar" });
    expect(group).toHaveTextContent("Gäller bara salar som markerats Kan delas");
    expect(group).toHaveTextContent("Hård: elevantalet i salen samtidigt ryms alltid i salens kapacitet.");
    expect(group).toHaveTextContent("Mjuk: kapaciteten får överskridas, till en vikt per elev över kapaciteten.");
  });

  it("gives the weight its scale, and only while the rule is Mjuk", () => {
    inLocale("sv", fields({ placementEdgeMode: "SOFT", placementSharedMode: "SOFT", placementPlacesMode: "HARD" }));

    for (const name of ["Inte först eller sist på dagen", "Delade salar"]) {
      const group = screen.getByRole("group", { name });
      expect(within(group).getByLabelText("Vikt")).toHaveValue(250);
      expect(group).toHaveTextContent("Som jämförelse väger ett önskat fridagsval 40 och sammanhängande undervisning 250.");
    }
    expect(within(screen.getByRole("group", { name: "Salar och byggnader per dag" })).queryByLabelText("Vikt")).toBeNull();
  });

  it("counts the marked subjects with the right plural, and links to them", () => {
    const { rerender } = inLocale("sv", fields({}, {}, 0));
    expect(screen.getByText(/Inget ämne är markerat än\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Markera ämnen" })).toHaveAttribute("href", "/admin/subjects");

    const again = (n: number | null) =>
      rerender(
        <NextIntlClientProvider locale="sv" messages={sv} onError={(error) => { throw error; }}>
          {fields({}, {}, n)}
        </NextIntlClientProvider>,
      );
    again(1);
    expect(screen.getByText(/1 ämne är markerat\./)).toBeInTheDocument();
    again(3);
    expect(screen.getByText(/3 ämnen är markerade\./)).toBeInTheDocument();
    again(null);
    expect(screen.queryByText(/är markerad|är markerat|Inget ämne/)).toBeNull();
  });

  it("says each mistake at its field", () => {
    inLocale(
      "sv",
      fields(
        { placementEdgeMode: "SOFT", placementPlacesMode: "HARD" },
        {
          edgeWeight: true,
          noLimit: true,
          limits: { ...fine.limits, maxTeacherRoomsPerDay: true },
        },
      ),
    );

    expect(screen.getByText("Ange ett heltal mellan 1 och 1000.")).toBeInTheDocument();
    expect(screen.getByText("Ange ett heltal mellan 1 och 20, eller lämna tomt.")).toBeInTheDocument();
    expect(screen.getByText(/Ange minst en gräns, annars har regeln inget att hålla\./)).toBeInTheDocument();
  });
});

describe("Placeringsregler in English", () => {
  it("offers Not first or last in the day and Rooms and buildings per day as Off and Soft, and says why not Hard", () => {
    inLocale("en", fields());

    for (const name of ["Not first or last in the day", "Rooms and buildings per day"]) {
      const group = screen.getByRole("group", { name });
      expect(within(group).getAllByRole("radio").map((radio) => radio.getAttribute("value"))).toEqual(["OFF", "SOFT"]);
      expect(group).toHaveTextContent("Hard is not offered for this rule yet");
      expect(group).toHaveTextContent("it has not been measured on a large school");
      expect(group).toHaveTextContent("Choose Off or Soft.");
    }
    expect(within(screen.getByRole("group", { name: "Shared rooms" })).getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("region", { name: "Placement rules" })).toHaveTextContent("which only Shared rooms can be for now");
  });

  it("says it all in English too", () => {
    inLocale(
      "en",
      fields({ placementEdgeMode: "SOFT", placementSharedMode: "SOFT" }, { noLimit: true }, 2),
    );

    expect(screen.getByRole("heading", { name: "Placement rules" })).toBeInTheDocument();
    for (const name of ["Not first or last in the day", "Rooms and buildings per day", "Shared rooms"]) {
      expect(screen.getByRole("group", { name })).toBeInTheDocument();
    }
    const section = screen.getByRole("region", { name: "Placement rules" });
    expect(section).toHaveTextContent("Generate then refuses and prints the reason");
    expect(section).toHaveTextContent("Generate tries to keep the rule but never refuses");
    expect(section).toHaveTextContent("2 subjects are marked.");
    expect(section).toHaveTextContent("For comparison, a wished-for free day weighs 40 and teaching in a row weighs 250.");
    const changes = screen.getByRole("group", { name: "Rooms and buildings per day" });
    expect(changes).toHaveTextContent("rooms without a building count as the same building");
    expect(changes).toHaveTextContent("Equal rooms of the same type, size and year levels count as one room");
    expect(changes).toHaveTextContent("1 means a single one all day");
    expect(changes).toHaveTextContent("not in what order: a day that goes A–B–A counts as two buildings");
    expect(changes).toHaveTextContent("A class is counted on its own group's lessons.");
    expect(changes).toHaveTextContent("Set at least one limit");
    expect(within(changes).getByLabelText("The class's different rooms per day")).toBeInTheDocument();
  });
});

/** Reads one message from the placementRules namespace, throwing on a miss. */
function Say({ id, values: params }: { id: string; values?: Record<string, string | number> }) {
  const t = useTranslations("placementRules");
  return <p data-testid={id}>{t(id as never, params as never)}</p>;
}

describe("the messages the subject form, the room form and the Generera page read", () => {
  const keys: Array<[string, Record<string, string | number>?]> = [
    ["subject.legend"],
    ["subject.hint"],
    ["subject.notFirst"],
    ["subject.notLast"],
    ["room.canBeShared"],
    ["room.hint"],
    ["room.needsCapacity"],
    ["edge.hardHint"],
    ["errors.PLACEMENT_EDGE_HARD_NOT_OFFERED"],
    ["errors.PLACEMENT_PLACES_NEEDS_A_LIMIT"],
    ["errors.PLACEMENT_PLACES_HARD_NOT_OFFERED"],
    ["places.hardHint"],
    ["summary.edge.SOFT", { weight: 250 }],
    ["summary.edge.HARD"],
    ["summary.places.SOFT", { weight: 250, limits: "x" }],
    ["summary.places.HARD", { limits: "x" }],
    ["summary.shared.SOFT", { weight: 250 }],
    ["summary.shared.HARD"],
    ["summary.limit.classRoom", { count: 2 }],
    ["summary.limit.teacherRoom", { count: 0 }],
    ["summary.limit.classBuilding", { count: 1 }],
    ["summary.limit.teacherBuilding", { count: 3 }],
  ];

  it.each(["sv", "en"] as const)("all exist and parse in %s", (locale) => {
    inLocale(
      locale,
      <>
        {keys.map(([id, params]) => (
          <Say key={id} id={id} values={params} />
        ))}
      </>,
    );

    for (const [id] of keys) {
      const text = screen.getByTestId(id).textContent ?? "";
      expect(text, id).not.toBe("");
      expect(text, id).not.toContain("placementRules.");
    }
  });

  it("gives the three new conflict categories a name in both languages", () => {
    for (const messages of [sv, en]) {
      for (const category of ["PLACEMENT_EDGE", "PLACEMENT_PLACES", "SHARED_ROOM"] as const) {
        expect(messages.conflictCategories[category], category).toEqual(expect.any(String));
      }
    }
    expect(sv.conflictCategories.PLACEMENT_EDGE).toBe("Första och sista lektionen");
    expect(en.conflictCategories.SHARED_ROOM).toBe("Shared rooms");
  });
});
