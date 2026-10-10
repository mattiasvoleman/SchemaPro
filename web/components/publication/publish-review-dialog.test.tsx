import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import type { GateItem, PublicationPreview } from "@/lib/publication-types";
import { PublishReviewDialog } from "./publish-review-dialog";

/**
 * The review dialog over the real hooks and Swedish messages: what the dry
 * run says reaches the reader, a stopping check leaves nothing to press, a
 * warning turns the button into "Publicera ändå", and a stale preview is
 * said in words and fetched again — never published blind.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn() } };
});
const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const YEAR = { id: "y26", startDate: "2026-08-17", endDate: "2027-06-11" };
const gate = (code: GateItem["code"], severity: GateItem["severity"], count = 1, labels: string[] = []): GateItem => ({
  code,
  severity,
  count,
  items: labels.map((label) => ({ label })),
  params: {},
});
const preview = (overrides: Partial<PublicationPreview> = {}): PublicationPreview => ({
  academicYearId: "y26",
  publishMode: "DIRECT",
  validFrom: "2026-10-10",
  validTo: "2027-06-11",
  result: { created: 812, cancelled: 3, skipped: 40, fromDate: "2026-10-10", toDate: "2027-06-11" },
  gates: [],
  refused: false,
  needsAcknowledgement: false,
  digest: "a".repeat(64),
  ...overrides,
});

const server = vi.hoisted(() => ({ mode: "DIRECT", previews: [] as unknown[] }));

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <PublishReviewDialog
          open
          onOpenChange={() => {}}
          year={YEAR}
          subjects={[{ id: "s-ma", name: "Matematik" }]}
          groups={[{ id: "g-7a", name: "7A" }]}
          teachers={[{ id: "t-anna", firstName: "Anna", lastName: "Berg" }]}
          rooms={[{ id: "r-12", name: "Sal 12" }]}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("PublishReviewDialog", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    server.mode = "DIRECT";
    get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/publication-settings") return { publishMode: server.mode };
      if (path.startsWith("/api/v1/publications/state")) {
        return {
          academicYearId: "y26",
          publishMode: "DRAFT",
          publicationId: "p",
          added: [
            { id: "l-1", subjectId: "s-ma", studentGroupId: "g-7a", teacherId: "t-anna", coTeacherId: null, roomId: "r-12", dayOfWeek: 2, startTime: "09:00", endTime: "09:50", isParked: false },
          ],
          changed: [],
          removed: [],
          pendingRemovals: 0,
        };
      }
      if (path.startsWith("/api/v1/publications")) {
        return { academicYearId: "y26", today: "2026-10-10", publications: [], segments: [{ publicationId: "p", from: "2026-08-17", to: "2027-06-11" }], validNow: "p" };
      }
      throw new Error(`unexpected GET ${path}`);
    });
  });

  it("states what is valid today and what the calendar would get, and publishes the previewed window", async () => {
    post.mockImplementation(async (path: string) =>
      path === "/api/v1/publications/preview" ? preview() : { result: { created: 812 } },
    );
    const user = userEvent.setup();
    renderDialog();
    expect(await screen.findByText("Publicerat schema som gäller i dag: 2026-08-17 – 2027-06-11.")).toBeInTheDocument();
    expect(await screen.findByText("Kalendern får 812 nya lektioner och 3 inställda. 40 finns redan eller faller på lov.")).toBeInTheDocument();
    expect(screen.getByText("Ingen kontroll har något att invända.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Publicera" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/publications", {
        academicYearId: "y26",
        validFrom: "2026-10-10",
        validTo: "2027-06-11",
        expectedDigest: "a".repeat(64),
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Publicerat: 812 lektioner skapades i kalendern.");
  });

  it("leaves nothing to press when a check stops the publish, and says the severity in words", async () => {
    post.mockResolvedValue(
      preview({
        gates: [gate("PUB_CLASHES", "REFUSE", 2, ["Matematik · 7A, mån 08:00", "Matematik · 7A, tis 08:00"]), gate("PUB_NO_ROOM", "WARN")],
        refused: true,
        needsAcknowledgement: true,
      }),
    );
    renderDialog();
    expect(await screen.findByText("Stoppar:")).toBeInTheDocument();
    expect(screen.getByText("2 krockar i grundschemat.")).toBeInTheDocument();
    expect(screen.getByText("Matematik · 7A, tis 08:00")).toBeInTheDocument();
    expect(screen.getByText("Varnar:")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publicera ändå" })).toBeDisabled();
  });

  it("says a stale preview in words and fetches it again instead of publishing", async () => {
    let previews = 0;
    post.mockImplementation(async (path: string) => {
      if (path === "/api/v1/publications/preview") {
        previews += 1;
        return preview({ gates: [gate("PUB_PARKED", "WARN", 3)], needsAcknowledgement: true });
      }
      throw new ApiError(409, "Grundschemat … har ändrats", "PUBLISH_STALE");
    });
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole("button", { name: "Publicera ändå" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("har ändrats sedan provkörningen");
    await waitFor(() => expect(previews).toBe(2));
  });

  it("shows the draft against the published timetable in utkastläge, by name", async () => {
    server.mode = "DRAFT";
    post.mockResolvedValue(preview({ publishMode: "DRAFT", validFrom: "2026-10-12", draft: { moved: 1, removed: 0, adopted: 4, cancelledByMove: 0, cancelledByBatch: 0 } }));
    renderDialog();
    expect(await screen.findByText("1 nya, 0 ändrade och 0 borttagna lektioner.")).toBeInTheDocument();
    expect(screen.getByText("Matematik · 7A · Tisdag 09:00–09:50 · Anna Berg · Sal 12")).toBeInTheDocument();
    expect(await screen.findByText("Utkastet flyttar 1, tar bort 0 och behåller dagsändringar på 4 lektioner.")).toBeInTheDocument();
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/api/v1/publications/preview",
        { academicYearId: "y26", validFrom: "2026-10-12", validTo: "2027-06-11" },
        // A dry run the dates have moved past is cancelled, not left holding the lock.
        expect.any(AbortSignal),
      ),
    );
  });
});
