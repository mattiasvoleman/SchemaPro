import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { ScopeAssessmentCard } from "./scope-assessment-card";

/**
 * What the principal reads when the gateway refuses the assessment.
 *
 * The card shows the failure of its write in a toast. Until api.ts kept a problem's `errors` and the card asked apiErrorText for the
 * sentence, a 400 from the DTO read "One or more fields failed validation." in every language, a 404 "Academic year not found.", a 429
 * "ThrottlerException: Too Many Requests" and a server that did not answer "Failed to fetch". This runs the card through the real
 * api.ts, the real mutation and the real catalogues, with the gateway's answers as its HttpExceptionFilter writes them
 * (granskning #411, L-2: loggar/filter-probe.txt), so that what is asserted is the sentence a reader gets.
 */
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_BASE_URL = "https://api.test";
});
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/utils/supabase/client", () => ({
  createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } }),
}));
vi.mock("@/components/profile-context", () => ({ useProfile: () => ({ profile: {}, school: null }) }));

const problem = (status: number, title: string, detail: string, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({ type: "about:blank", title, status, detail, instance: "/api/v1/scope-assessments/t-anna", traceId: "t-1", ...extra }),
    { status, headers: { "Content-Type": "application/problem+json" } },
  );

const gateway = {
  dto: () =>
    problem(400, "Bad Request", "One or more fields failed validation.", { errors: { body: ["Nivån kan vara högst 1500 timmar."] } }),
  notFound: () => problem(404, "Not Found", "Academic year not found."),
  throttled: () => problem(429, "Too Many Requests", "ThrottlerException: Too Many Requests"),
  broken: () => problem(500, "Internal Server Error", "An unexpected error occurred. Please try again later."),
};

const teacher = { id: "t-anna", firstName: "Anna", lastName: "Ek" };

/** The card opened in the reader's language, the level filled in, and Spara pressed once. */
async function saveUnder(locale: "sv" | "en", answer: () => Response | Promise<Response>) {
  cleanup();
  vi.stubGlobal("fetch", vi.fn(async () => answer()));
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const messages = locale === "sv" ? sv : en;
  const user = userEvent.setup();
  render(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Europe/Stockholm">
      <QueryClientProvider client={client}>
        <ScopeAssessmentCard teacher={teacher} academicYearId="y1" assessment={undefined} fullTimeHighestHours={650} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  await user.click(screen.getByRole("button", { name: messages.common.add }));
  fireEvent.change(screen.getByLabelText(messages.staffing.scopeAssessment.level), { target: { value: "580" } });
  await user.click(screen.getByRole("button", { name: messages.staffing.scopeAssessment.save }));
  return vi.mocked(fetch);
}

describe("ScopeAssessmentCard: the gateway's refusals, as the reader gets them", () => {
  beforeEach(() => {
    toast.success.mockClear();
    toast.error.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says the DTO's own sentence for a 400, not the constant detail", async () => {
    const fetched = await saveUnder("sv", gateway.dto);
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("Uppgifterna kunde inte sparas. Nivån kan vara högst 1500 timmar.");
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining("One or more fields"));
    toast.error.mockClear();
    await saveUnder("en", gateway.dto);
    expect(toast.error).toHaveBeenCalledWith("The details could not be saved. Nivån kan vara högst 1500 timmar.");
  });

  it("says a 404 in the reader's language, not Nest's English", async () => {
    await saveUnder("sv", gateway.notFound);
    expect(toast.error).toHaveBeenCalledWith("Det du försökte nå finns inte längre. Ladda om sidan och försök igen.");
    toast.error.mockClear();
    await saveUnder("en", gateway.notFound);
    expect(toast.error).toHaveBeenCalledWith("What you tried to reach no longer exists. Reload the page and try again.");
  });

  it("says a 429 in the reader's language, not the throttler's class name", async () => {
    await saveUnder("sv", gateway.throttled);
    expect(toast.error).toHaveBeenCalledWith("För många förfrågningar på kort tid. Vänta en stund och försök igen.");
    toast.error.mockClear();
    await saveUnder("en", gateway.throttled);
    expect(toast.error).toHaveBeenCalledWith("Too many requests in a short time. Wait a moment and try again.");
  });

  it("says a 500 in the reader's language", async () => {
    await saveUnder("sv", gateway.broken);
    expect(toast.error).toHaveBeenCalledWith("Något gick fel hos oss. Försök igen om en stund.");
    toast.error.mockClear();
    await saveUnder("en", gateway.broken);
    expect(toast.error).toHaveBeenCalledWith("Something went wrong on our side. Try again in a moment.");
  });

  it("says a server that did not answer in the reader's language, not the browser's 'Failed to fetch'", async () => {
    const refused = () => {
      throw new TypeError("Failed to fetch");
    };
    await saveUnder("sv", refused);
    expect(toast.error).toHaveBeenCalledWith("Servern gick inte att nå. Kontrollera anslutningen och försök igen.");
    toast.error.mockClear();
    await saveUnder("en", refused);
    expect(toast.error).toHaveBeenCalledWith("The server could not be reached. Check your connection and try again.");
  });
});
