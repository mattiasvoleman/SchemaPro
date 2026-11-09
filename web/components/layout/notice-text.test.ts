import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { noticeHref, noticeText, type NotificationRow } from "./notice-text";

/*
 * What a notice about an alarm says, with the real messages. A guardian is told
 * THAT the school had an alarm and that it ended, and when: never what kind of
 * alarm it was (the product's decision), whatever the notice's meta carries.
 */

const startedAt = "2027-01-12T09:14:00.000Z";
const endedAt = "2027-01-12T09:31:00.000Z";
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const row = (type: NotificationRow["type"], meta: Record<string, unknown>): NotificationRow => ({ id: "n-1", type, meta, readAt: null, createdAt: startedAt });
const say = (language: "sv" | "en", entry: NotificationRow) => {
  const t = createTranslator({ locale: language, messages: language === "sv" ? sv : en, namespace: "notifications" });
  return noticeText(entry, (key, values) => t(key as never, values as never));
};

describe("the guardian's notice after an alarm", () => {
  for (const kind of ["EVACUATION", "LOCKDOWN"]) {
    it(`says that there was an alarm and that it ended, and when, and not what kind (${kind})`, () => {
      const entry = row("CRISIS_GUARDIAN_AFTER", { kind, startedAt, endedAt });
      expect(say("sv", entry)).toBe(`Skolan hade ett larm kl ${time(startedAt)}–${time(endedAt)}. Det är avslutat.`);
      expect(say("en", entry)).toBe(`The school had an alarm at ${time(startedAt)}–${time(endedAt)}. It has ended.`);
      for (const text of [say("sv", entry), say("en", entry)]) expect(text).not.toMatch(/inrymning|utrymning|lockdown|evacuation|skarpt|övning|drill|live/i);
    });
  }

  it("is the same sentence whatever the meta holds, even a kind and a mode it should not", () => {
    const plain = say("sv", row("CRISIS_GUARDIAN_AFTER", { startedAt, endedAt }));
    expect(say("sv", row("CRISIS_GUARDIAN_AFTER", { kind: "LOCKDOWN", mode: "DRILL", startedAt, endedAt }))).toBe(plain);
  });

  it("keeps the staff's notices naming the kind, which they are to act on", () => {
    expect(say("sv", row("CRISIS_ALARM", { kind: "LOCKDOWN", mode: "LIVE", startedAt }))).toContain("inrymning");
    expect(say("sv", row("CRISIS_ENDED", { kind: "EVACUATION", mode: "DRILL", startedAt, endedAt }))).toBe(`Övningen (utrymning) avslutades kl ${time(endedAt)}.`);
    expect(say("en", row("CRISIS_ALARM", { kind: "EVACUATION", mode: "DRILL", startedAt }))).toContain("evacuation");
  });
});

describe("the notice of a pupil moved to a parallel lesson for a day (Elevens lektion för dagen)", () => {
  // The server writes the lesson the pupil is on now as subjectName: Engelska after a move, Svenska after Ångra.
  const meta = { subjectName: "Engelska", fromSubjectName: "Svenska", toSubjectName: "Engelska", startsAt: startedAt, studentName: "Alva Andersson", movedByName: "Rektor Rask" };

  it("says which lesson the pupil is on now, in both languages", () => {
    expect(say("sv", row("LESSON_PUPIL_MOVED", meta))).toMatch(/^En elevs lektion .* är nu Engelska\.$/);
    expect(say("en", row("LESSON_PUPIL_MOVED", meta))).toMatch(/^A pupil.s lesson \(.*\) is now Engelska\.$/);
  });

  it("says the lesson they are back on when the move is undone, in the same sentence", () => {
    const undone = { ...meta, subjectName: "Svenska", undone: true };
    expect(say("sv", row("LESSON_PUPIL_MOVED", undone))).toMatch(/är nu Svenska\.$/);
    expect(say("en", row("LESSON_PUPIL_MOVED", undone))).toMatch(/is now Svenska\.$/);
  });

  it("never says the pupil or who moved them, even if a newer gateway puts them in the meta", () => {
    for (const text of [say("sv", row("LESSON_PUPIL_MOVED", meta)), say("en", row("LESSON_PUPIL_MOVED", meta))]) {
      expect(text).not.toMatch(/Alva|Andersson|Rask/);
    }
  });
});

describe("the expedition's notice of days that clash with a lesson (Lokal)", () => {
  // The hirer is not a user and a notice goes on as e-mail and push: if a newer gateway puts a name or a room in the meta, the
  // sentence still must not say it.
  const meta = { days: 3, organisation: "Hjo innebandy", contactName: "Kim Kontakt", roomName: "Idrottshallen" };

  it("says how many days clash, in both languages, with the plural right", () => {
    expect(say("sv", row("EXTERNAL_BOOKING_CLASH", meta))).toBe("3 dagar av externa bokningar står nu i en sal som har en lektion. Se Externa bokningar.");
    expect(say("en", row("EXTERNAL_BOOKING_CLASH", meta))).toBe("3 days of external bookings now stand in a room that has a lesson. See External bookings.");
    expect(say("sv", row("EXTERNAL_BOOKING_CLASH", { days: 1 }))).toContain("1 dag av externa bokningar");
    expect(say("en", row("EXTERNAL_BOOKING_CLASH", { days: 1 }))).toContain("1 day of external bookings");
  });

  it("never says the hirer, the contact or the room", () => {
    for (const text of [say("sv", row("EXTERNAL_BOOKING_CLASH", meta)), say("en", row("EXTERNAL_BOOKING_CLASH", meta))]) {
      expect(text).not.toMatch(/Hjo|Kim|Kontakt|Idrottshallen/);
    }
  });

  it("leads to the list of external bookings, and says nothing of a number it was not given", () => {
    expect(noticeHref(row("EXTERNAL_BOOKING_CLASH", meta))).toBe("/admin/external-bookings");
    expect(say("sv", row("EXTERNAL_BOOKING_CLASH", {}))).toContain("0 dagar");
  });
});

describe("the guardian's notice of a message to confirm (Kvittens)", () => {
  const title = "Utflykten på torsdag";
  // A pupil's name and the text of the message are not in a notice's meta; if a newer gateway puts them there, the sentence still must not say them.
  const meta = { requestId: "r-1", title, studentName: "Ada Berg", body: "Ta med matsäck" };

  it("says that the school asks for a confirmation and what it is called, in both languages", () => {
    expect(say("sv", row("ACK_REQUESTED", meta))).toBe(`Skolan ber dig bekräfta: ${title}`);
    expect(say("en", row("ACK_REQUESTED", meta))).toBe(`The school asks you to confirm: ${title}`);
  });

  it("reminds once, in words that tell it from the request", () => {
    expect(say("sv", row("ACK_REMINDER", meta))).toBe(`Påminnelse: skolan väntar på din bekräftelse av ${title}`);
    expect(say("en", row("ACK_REMINDER", meta))).toBe(`Reminder: the school is waiting for your confirmation of ${title}`);
  });

  it("never says a pupil or the text of the message", () => {
    for (const type of ["ACK_REQUESTED", "ACK_REMINDER"] as const) {
      for (const text of [say("sv", row(type, meta)), say("en", row(type, meta))]) expect(text).not.toMatch(/Ada|Berg|matsäck/);
    }
  });

  it("leads both to the guardian's list, whoever the reader is", () => {
    for (const type of ["ACK_REQUESTED", "ACK_REMINDER"] as const) {
      expect(noticeHref(row(type, meta))).toBe("/guardian/acknowledgements");
      expect(noticeHref(row(type, meta), "GUARDIAN")).toBe("/guardian/acknowledgements");
    }
  });
});

describe("the guardian's notices of a leave request that asks for consent (Ledighetspolicy)", () => {
  // Who applied and who answered are not in a notice's meta; if a newer gateway puts them there, the sentence still must not say them.
  const meta = {
    leaveRequestId: "l-1",
    studentName: "Ada Berg",
    startDate: "2027-03-01",
    endDate: "2027-03-05",
    requestedBy: "Gun Berg",
    refusedBy: "Tom Berg",
  };
  const TYPES = ["LEAVE_CONSENT_REQUESTED", "LEAVE_CONSENT_REMINDER", "LEAVE_CONSENT_REFUSED"] as const;

  it("asks for the consent, naming the child and the days, in both languages", () => {
    expect(say("sv", row("LEAVE_CONSENT_REQUESTED", meta))).toBe("Skolan ber dig samtycka till en ledighetsansökan för Ada Berg (2027-03-01 – 2027-03-05).");
    expect(say("en", row("LEAVE_CONSENT_REQUESTED", meta))).toBe("The school asks you to consent to a leave request for Ada Berg (2027-03-01 – 2027-03-05).");
  });

  it("reminds in words that tell it from the request", () => {
    expect(say("sv", row("LEAVE_CONSENT_REMINDER", meta))).toBe("Påminnelse: ledighetsansökan för Ada Berg (2027-03-01 – 2027-03-05) väntar på ditt samtycke.");
    expect(say("en", row("LEAVE_CONSENT_REMINDER", meta))).toBe("Reminder: the leave request for Ada Berg (2027-03-01 – 2027-03-05) is waiting for your consent.");
  });

  it("tells whoever applied that the request was ended because a guardian did not consent, and not which", () => {
    expect(say("sv", row("LEAVE_CONSENT_REFUSED", meta))).toBe(
      "Ledighetsansökan för Ada Berg (2027-03-01 – 2027-03-05) har avslutats, eftersom en vårdnadshavare inte samtyckte.",
    );
    expect(say("en", row("LEAVE_CONSENT_REFUSED", meta))).toBe(
      "The leave request for Ada Berg (2027-03-01 – 2027-03-05) has been ended because a guardian did not consent.",
    );
  });

  it("never says who applied or who answered, whatever the meta carries", () => {
    for (const type of TYPES) {
      for (const text of [say("sv", row(type, meta)), say("en", row(type, meta))]) expect(text).not.toMatch(/Gun|Tom|undefined/);
    }
  });

  it("leaves a missing name or date empty rather than printing undefined", () => {
    for (const text of [say("sv", row("LEAVE_CONSENT_REQUESTED", {})), say("en", row("LEAVE_CONSENT_REFUSED", {}))]) {
      expect(text).not.toMatch(/undefined|null/);
    }
  });

  it("leads all three to the guardian's page, where the requests are listed, whoever the reader is", () => {
    for (const type of TYPES) {
      expect(noticeHref(row(type, meta))).toBe("/guardian");
      expect(noticeHref(row(type, meta), "GUARDIAN")).toBe("/guardian");
    }
  });
});
