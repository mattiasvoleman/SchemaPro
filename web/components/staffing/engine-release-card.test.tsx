import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import { EngineReleaseCard, type EngineReleaseCardProps } from "./engine-release-card";

/**
 * "Släppta poster" over the real hooks and the real Swedish messages, with the gateway mocked at lib/api: what the table
 * says, which post ids each press sends (one write path, by post id), which controls are off when a press would change
 * nothing, what a profile that may not write sees, and every refusal said in words.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const get = api.get as unknown as Mock;
const put = api.put as unknown as Mock;

const me = vi.hoisted(() => ({ readOnly: false, adminProfile: undefined as string | undefined }));
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({
    profile: { id: "u-admin", ...(me.adminProfile ? { adminProfile: me.adminProfile } : {}) },
    school: { timezone: "Europe/Stockholm" },
  }),
  useReadOnly: () => me.readOnly,
}));

const LIST = "/api/v1/staffing/engine-release?academicYearId=y1";
const WRITE = "/api/v1/staffing/engine-release";

const subjects = [
  { id: "s-ma", name: "Matematik" },
  { id: "s-en", name: "Engelska" },
];
const groups = [
  { id: "g-7a", name: "7A", gradeLevel: 7 },
  { id: "g-7b", name: "7B", gradeLevel: 7 },
  { id: "g-7c", name: "7C", gradeLevel: 7 },
  { id: "g-8a", name: "8A", gradeLevel: 8 },
  { id: "g-8b", name: "8B", gradeLevel: 8 },
  { id: "g-sg", name: "Studiegrupp", gradeLevel: null },
];
const post = (id: string, subjectId: string, studentGroupId: string, teacherId: string | null) => ({
  id,
  subjectId,
  studentGroupId,
  teacherId,
});

/**
 * Matematik åk 7: three posts led by Bo, 7A released already. Åk 8: Anna leads 8A, and 8B has nobody. Engelska åk 7:
 * one post, released. Matematik utan årskurs: Anna, from a group with no årskurs.
 */
const requirements = [
  post("r-ma-7a", "s-ma", "g-7a", "t-bo"),
  post("r-ma-7b", "s-ma", "g-7b", "t-bo"),
  post("r-ma-7c", "s-ma", "g-7c", "t-bo"),
  post("r-ma-8a", "s-ma", "g-8a", "t-anna"),
  post("r-ma-8b", "s-ma", "g-8b", null),
  post("r-en-7a", "s-en", "g-7a", "t-anna"),
  post("r-ma-sg", "s-ma", "g-sg", "t-anna"),
  post("r-ma-left", "s-ma", "g-8a", "t-gone"),
];

const names: Record<string, string> = { "t-bo": "Bo Ek", "t-anna": "Anna Lind", "t-gone": "Gun Gone" };
const people: Record<string, string> = { "u-admin": "Rut Rektorsson" };

const RELEASES = {
  releases: [
    { requirementId: "r-ma-7a", releasedAt: "2026-11-18T10:00:00.000Z", releasedById: "u-admin" },
    { requirementId: "r-en-7a", releasedAt: "2026-11-17T22:30:00.000Z", releasedById: null },
  ],
};

function renderCard(props: Partial<EngineReleaseCardProps> = {}, locale: "sv" | "en" = "sv") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidated = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider
        locale={locale}
        messages={locale === "sv" ? sv : en}
        timeZone="Europe/Stockholm"
        onError={(error) => {
          throw error;
        }}
      >
        <EngineReleaseCard
          academicYearId="y1"
          requirements={requirements}
          groups={groups}
          subjects={subjects}
          teacherName={(id) => names[id] ?? id}
          personName={(id) => people[id] ?? null}
          activeStaff={(id) => id !== "t-gone"}
          {...props}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { invalidated };
}

const writes = () => put.mock.calls.map(([path, body]) => [path, body]);
const lineRow = (name: string) => screen.getByRole("button", { name }).closest("tr") as HTMLElement;
const open = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(screen.getByRole("button", { name }));
  return screen.getByRole("list", { name: `Poster i ${name}` });
};

describe("EngineReleaseCard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    me.readOnly = false;
    me.adminProfile = undefined;
    get.mockResolvedValue(RELEASES);
    put.mockResolvedValue({ changed: 1, unchanged: 0 });
  });

  describe("what it says", () => {
    it("names what a release is, says how many staffed posts are released, and asks nothing before it has read the list", async () => {
      renderCard();
      expect(screen.getByRole("heading", { name: "Släppta poster" })).toBeInTheDocument();
      expect(
        screen.getByText(
          "Föreslå bemanning flyttar aldrig en lärare du har valt. Släpp en post om motorn får föreslå en annan behörig lärare för den. Inget skrivs utan att du godkänner.",
        ),
      ).toBeInTheDocument();
      // Until the list is in, no switch can be drawn in a state that is only a guess.
      expect(screen.queryByRole("table")).toBeNull();
      expect(await screen.findByText("Släppta för motorn: 2 av 6 bemannade poster.")).toBeInTheDocument();
      expect(get).toHaveBeenCalledWith(LIST);
    });

    it("draws a row for each subject and årskurs, 'utan årskurs' last, with its posts, its staffed posts and its released ones", async () => {
      renderCard();
      await screen.findByRole("table");
      const rows = screen.getAllByRole("row").slice(1);
      expect(rows.map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent?.replace(/\s+/g, " ").trim()))).toEqual([
        // Posts, staffed, released — and the two presses, named by their row.
        ["1", "1", "1", "Släpp 0 bemannadeTa tillbaka alla"],
        ["3", "3", "1", "Släpp 2 bemannadeTa tillbaka alla"],
        // 8B has nobody and 8A's second post has a teacher who has left: neither is staffed.
        ["3", "1", "0", "Släpp 1 bemannadTa tillbaka alla"],
        ["1", "1", "0", "Släpp 1 bemannadTa tillbaka alla"],
      ]);
      expect(rows.map((row) => within(row).getByRole("rowheader").textContent)).toEqual([
        "Engelska · åk 7",
        "Matematik · åk 7",
        "Matematik · åk 8",
        "Matematik · utan årskurs",
      ]);
    });

    it("lists a row's posts when it is opened: the group, the teacher, and who released it and when", async () => {
      const user = userEvent.setup();
      renderCard();
      await screen.findByRole("table");
      const toggle = screen.getByRole("button", { name: "Matematik · åk 7" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle).not.toHaveAttribute("aria-controls");
      const list = await open(user, "Matematik · åk 7");
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(toggle).toHaveAttribute("aria-controls", list.id);

      const [a, b, c] = within(list).getAllByRole("listitem");
      expect(a).toHaveTextContent("7A");
      expect(a).toHaveTextContent("Bo Ek");
      // 18 November, 10:00 UTC is the 18th in Stockholm too.
      expect(a).toHaveTextContent("Släppt av Rut Rektorsson 2026-11-18");
      expect(within(a!).getByRole("switch", { name: "Släppt: Matematik för 7A" })).toBeChecked();
      expect(within(b!).getByRole("switch", { name: "Släppt: Matematik för 7B" })).not.toBeChecked();
      expect(within(b!).queryByText(/Släppt av/)).toBeNull();
      expect(within(c!).getByRole("switch", { name: "Släppt: Matematik för 7C" })).not.toBeChecked();

      await user.click(toggle);
      expect(screen.queryByRole("list", { name: "Poster i Matematik · åk 7" })).toBeNull();
      expect(toggle).toHaveAttribute("aria-expanded", "false");
    });

    it("says that a post nobody teaches, or whose teacher has left, is always open, and gives it no switch", async () => {
      const user = userEvent.setup();
      renderCard();
      await screen.findByRole("table");
      const list = await open(user, "Matematik · åk 8");
      const [eightA, eightALeft, eightB] = within(list).getAllByRole("listitem");
      expect(within(eightA!).getByRole("switch", { name: "Släppt: Matematik för 8A" })).toBeInTheDocument();
      expect(eightALeft).toHaveTextContent("Gun Gone har slutat — alltid öppen för motorn");
      expect(within(eightALeft!).queryByRole("switch")).toBeNull();
      expect(eightB).toHaveTextContent("Obemannad — alltid öppen för motorn");
      expect(within(eightB!).queryByRole("switch")).toBeNull();
    });

    it("names a release whose person has been removed, and one the page cannot name", async () => {
      const user = userEvent.setup();
      get.mockResolvedValue({
        releases: [
          // 23:30 UTC on the 17th is half past midnight on the 18th in Stockholm: the school's day, not the server's.
          { requirementId: "r-en-7a", releasedAt: "2026-11-17T23:30:00.000Z", releasedById: null },
          { requirementId: "r-ma-7a", releasedAt: "2026-11-18T10:00:00.000Z", releasedById: "u-unknown" },
        ],
      });
      renderCard();
      await screen.findByRole("table");
      const english = await open(user, "Engelska · åk 7");
      expect(within(english).getByRole("listitem")).toHaveTextContent("Släppt av en borttagen person 2026-11-18");
      const maths = await open(user, "Matematik · åk 7");
      expect(within(maths).getAllByRole("listitem")[0]).toHaveTextContent("Släppt av en okänd person 2026-11-18");
    });

    it("says it in English, and names an entry what the English product does", async () => {
      renderCard({}, "en");
      expect(screen.getByRole("heading", { name: "Released entries" })).toBeInTheDocument();
      expect(await screen.findByText("Released for the engine: 2 of 6 staffed entries.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Release 2 staffed: Matematik · year 7" })).toBeInTheDocument();
    });

    it("says there is nothing to release in a year with no posts", async () => {
      renderCard({ requirements: [] });
      expect(await screen.findByText("Läsåret har inga poster än.")).toBeInTheDocument();
      expect(screen.queryByRole("table")).toBeNull();
    });

    it("waits for the posts and the groups: a skeleton, not an empty year and not every post under 'utan årskurs'", () => {
      renderCard({ requirements: undefined });
      expect(screen.queryByText("Läsåret har inga poster än.")).toBeNull();
      expect(screen.queryByRole("table")).toBeNull();
    });

    it("says the list could not be read, and draws no switch for a state it does not know", async () => {
      get.mockRejectedValue(new ApiError(500, "boom"));
      renderCard();
      expect(await screen.findByRole("alert")).toHaveTextContent("Släppta poster kunde inte hämtas");
      expect(screen.getByRole("alert")).toHaveTextContent("Inget har ändrats. Ladda om sidan för att försöka igen.");
      expect(screen.queryByRole("table")).toBeNull();
      expect(screen.queryByRole("button", { name: /Släpp/ })).toBeNull();
    });
  });

  describe("what a press sends", () => {
    it("releases one post from its switch, by post id, and says so", async () => {
      const user = userEvent.setup();
      const { invalidated } = renderCard();
      await screen.findByRole("table");
      const list = await open(user, "Matematik · åk 7");
      await user.click(within(list).getByRole("switch", { name: "Släppt: Matematik för 7B" }));
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0]).toEqual([WRITE, { academicYearId: "y1", requirementIds: ["r-ma-7b"], released: true }]);
      expect(await screen.findByText("1 post släpptes för motorn.")).toBeInTheDocument();
      expect(invalidated).toHaveBeenCalledWith({ queryKey: ["engineReleases"] });
    });

    it("takes one post back from its switch", async () => {
      const user = userEvent.setup();
      renderCard();
      await screen.findByRole("table");
      const list = await open(user, "Matematik · åk 7");
      await user.click(within(list).getByRole("switch", { name: "Släppt: Matematik för 7A" }));
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0]).toEqual([WRITE, { academicYearId: "y1", requirementIds: ["r-ma-7a"], released: false }]);
      expect(await screen.findByText("1 post togs tillbaka.")).toBeInTheDocument();
    });

    it("releases the staffed posts of a subject in an årskurs, and not one that is released already", async () => {
      const user = userEvent.setup();
      renderCard();
      await screen.findByRole("table");
      await user.click(screen.getByRole("button", { name: "Släpp 2 bemannade: Matematik · åk 7" }));
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0]).toEqual([
        WRITE,
        { academicYearId: "y1", requirementIds: ["r-ma-7b", "r-ma-7c"], released: true },
      ]);
    });

    it("never sends a post nobody teaches, nor one whose teacher has left, with 'Släpp bemannade'", async () => {
      const user = userEvent.setup();
      renderCard();
      await screen.findByRole("table");
      await user.click(screen.getByRole("button", { name: "Släpp 1 bemannad: Matematik · åk 8" }));
      await waitFor(() => expect(writes()).toHaveLength(1));
      // 8B has no teacher and 8A's other post has lost its own: both are open to the engine already.
      expect(writes()[0]![1]).toEqual({ academicYearId: "y1", requirementIds: ["r-ma-8a"], released: true });
    });

    it("sends the posts of the row 'utan årskurs' too: a group with no årskurs is a row, not a gap", async () => {
      const user = userEvent.setup();
      renderCard();
      await screen.findByRole("table");
      await user.click(screen.getByRole("button", { name: "Släpp 1 bemannad: Matematik · utan årskurs" }));
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0]![1]).toEqual({ academicYearId: "y1", requirementIds: ["r-ma-sg"], released: true });
    });

    it("takes back every post of a row, the released and the others", async () => {
      const user = userEvent.setup();
      renderCard();
      await screen.findByRole("table");
      await user.click(screen.getByRole("button", { name: "Ta tillbaka alla: Matematik · åk 7" }));
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0]).toEqual([
        WRITE,
        { academicYearId: "y1", requirementIds: ["r-ma-7a", "r-ma-7b", "r-ma-7c"], released: false },
      ]);
      expect(await screen.findByText("1 post togs tillbaka.")).toBeInTheDocument();
    });

    it("says that nothing changed when the gateway says so", async () => {
      const user = userEvent.setup();
      put.mockResolvedValue({ changed: 0, unchanged: 2 });
      renderCard();
      await screen.findByRole("table");
      await user.click(screen.getByRole("button", { name: "Släpp 2 bemannade: Matematik · åk 7" }));
      expect(await screen.findByText("Inga poster ändrades.")).toBeInTheDocument();
    });

    it("reads the list again after the write, and shows the new state", async () => {
      const user = userEvent.setup();
      renderCard();
      await screen.findByRole("table");
      const list = await open(user, "Matematik · åk 7");
      get.mockResolvedValue({
        releases: [...RELEASES.releases, { requirementId: "r-ma-7b", releasedAt: "2026-11-19T08:00:00.000Z", releasedById: "u-admin" }],
      });
      await user.click(within(list).getByRole("switch", { name: "Släppt: Matematik för 7B" }));
      await waitFor(() => expect(within(lineRow("Matematik · åk 7")).getAllByRole("cell")[2]).toHaveTextContent("2"));
      expect(screen.getByText("Släppta för motorn: 3 av 6 bemannade poster.")).toBeInTheDocument();
      expect(screen.getByRole("switch", { name: "Släppt: Matematik för 7B" })).toBeChecked();
    });
  });

  describe("what is off, and while it writes", () => {
    it("turns a press off when it would change nothing", async () => {
      renderCard();
      await screen.findByRole("table");
      // Engelska åk 7: its one staffed post is released, so there is nothing to release.
      expect(screen.getByRole("button", { name: "Släpp 0 bemannade: Engelska · åk 7" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Ta tillbaka alla: Engelska · åk 7" })).toBeEnabled();
      // Matematik åk 8: nothing is released, so there is nothing to take back.
      expect(screen.getByRole("button", { name: "Släpp 1 bemannad: Matematik · åk 8" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Ta tillbaka alla: Matematik · åk 8" })).toBeDisabled();
    });

    it("holds every control, and shows which press is working, until the write and the list are in", async () => {
      const user = userEvent.setup();
      let finish: (value: { changed: number; unchanged: number }) => void = () => {};
      put.mockImplementation(() => new Promise((done) => (finish = done)));
      renderCard();
      await screen.findByRole("table");
      const list = await open(user, "Matematik · åk 7");
      await user.click(screen.getByRole("button", { name: "Släpp 2 bemannade: Matematik · åk 7" }));

      const press = screen.getByRole("button", { name: "Släpp 2 bemannade: Matematik · åk 7" });
      await waitFor(() => expect(press).toBeDisabled());
      expect(press.querySelector("svg.animate-spin")).not.toBeNull();
      expect(screen.getByRole("button", { name: "Ta tillbaka alla: Matematik · åk 7" })).toBeDisabled();
      expect(within(list).getByRole("switch", { name: "Släppt: Matematik för 7B" })).toBeDisabled();
      expect(screen.getByRole("table")).toHaveAttribute("aria-busy", "true");

      finish({ changed: 2, unchanged: 0 });
      expect(await screen.findByText("2 poster släpptes för motorn.")).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("table")).toHaveAttribute("aria-busy", "false"));
    });

    it("keeps focus where the admin was: on the switch they turned, on the row of a press that disabled itself", async () => {
      const user = userEvent.setup();
      renderCard();
      await screen.findByRole("table");
      const list = await open(user, "Matematik · åk 7");
      const toggle = within(list).getByRole("switch", { name: "Släppt: Matematik för 7B" });
      await user.click(toggle);
      await screen.findByText("1 post släpptes för motorn.");
      await waitFor(() => expect(within(list).getByRole("switch", { name: "Släppt: Matematik för 7B" })).toHaveFocus());

      // A press whose own button goes off (nothing left to take back) hands focus to the row's opener, which stays.
      await user.click(screen.getByRole("button", { name: "Ta tillbaka alla: Matematik · åk 7" }));
      await screen.findByText("1 post togs tillbaka.");
      await waitFor(() => expect(screen.getByRole("button", { name: "Matematik · åk 7" })).toHaveFocus());
    });

    it("marks every write with Planering, for the läsare's style rule (Läsbehörighet)", async () => {
      const user = userEvent.setup();
      renderCard();
      await screen.findByRole("table");
      const list = await open(user, "Matematik · åk 7");
      for (const name of ["Släpp 2 bemannade: Matematik · åk 7", "Ta tillbaka alla: Matematik · åk 7"]) {
        expect(screen.getByRole("button", { name })).toHaveAttribute("data-writes", "PLANERING");
      }
      expect(within(list).getByRole("switch", { name: "Släppt: Matematik för 7B" }).closest("label")).toHaveAttribute(
        "data-writes",
        "PLANERING",
      );
      // Reading is every administrator's: the row's opener is not marked.
      expect(screen.getByRole("button", { name: "Matematik · åk 7" })).not.toHaveAttribute("data-writes");
    });
  });

  describe("a profile that may not write", () => {
    it.each([
      ["the läsare", () => (me.readOnly = true)],
      ["a profile without Planering", () => (me.adminProfile = "EXPEDITION")],
    ])("shows %s the state as words and offers no control", async (_name, setUp) => {
      setUp();
      const user = userEvent.setup();
      renderCard();
      await screen.findByRole("table");
      expect(screen.queryByRole("button", { name: /Släpp \d|Ta tillbaka/ })).toBeNull();
      expect(screen.queryByRole("columnheader", { name: "Ändra" })).toBeNull();
      const list = await open(user, "Matematik · åk 7");
      expect(screen.queryByRole("switch")).toBeNull();
      const [a, b] = within(list).getAllByRole("listitem");
      // The state is drawn as text, so a style rule that hides every write leaves it said.
      expect(within(a!).getByText("Släppt")).toBeInTheDocument();
      expect(within(b!).getByText("Inte släppt")).toBeInTheDocument();
      expect(writes()).toEqual([]);
    });

    it("lets a schemaläggare write, as Planering is theirs", async () => {
      me.adminProfile = "SCHEMALAGGARE";
      renderCard();
      await screen.findByRole("table");
      expect(screen.getByRole("button", { name: "Släpp 2 bemannade: Matematik · åk 7" })).toBeEnabled();
    });
  });

  describe("a refusal", () => {
    it.each([
      [
        "a post that is not the year's",
        new ApiError(400, "En av posterna hör inte till läsåret. Läs om sidan och försök igen.", "ENGINE_RELEASE_POST_NOT_IN_YEAR", { count: 1 }),
        "En av posterna hör inte till läsåret. Läs om sidan.",
      ],
      [
        "a year somebody else holds",
        new ApiError(409, "…", "SCHEDULE_BUSY"),
        "Tjänstefördelningen ändras just nu av någon annan. Försök igen om en stund.",
      ],
      ["a year that is gone", new ApiError(404, "Academic year not found."), "Läsåret finns inte längre. Välj ett annat läsår."],
      [
        "a profile the gateway refuses",
        new ApiError(403, "Du ändrar inte planering. Planering ändras av rektor, administratör eller schemaläggare.", "AREA_NOT_YOURS"),
        "Du ändrar inte planering. Planering ändras av rektor, administratör eller schemaläggare.",
      ],
      ["a failure with no word of its own", new Error("network"), "Något gick fel"],
    ])("says %s in words, and reads the list again", async (_name, error, sentence) => {
      const user = userEvent.setup();
      put.mockRejectedValue(error);
      renderCard();
      await screen.findByRole("table");
      await user.click(screen.getByRole("button", { name: "Släpp 2 bemannade: Matematik · åk 7" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(sentence);
      await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
      // The controls are the admin's again, to try once more.
      await waitFor(() => expect(screen.getByRole("button", { name: "Släpp 2 bemannade: Matematik · åk 7" })).toBeEnabled());
    });

    it("takes the sentence away when the admin presses again", async () => {
      const user = userEvent.setup();
      put.mockRejectedValueOnce(new ApiError(409, "…", "SCHEDULE_BUSY"));
      renderCard();
      await screen.findByRole("table");
      await user.click(screen.getByRole("button", { name: "Släpp 2 bemannade: Matematik · åk 7" }));
      await screen.findByRole("alert");
      await waitFor(() => expect(screen.getByRole("button", { name: "Släpp 2 bemannade: Matematik · åk 7" })).toBeEnabled());
      await user.click(screen.getByRole("button", { name: "Släpp 2 bemannade: Matematik · åk 7" }));
      await screen.findByText("1 post släpptes för motorn.");
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});
