import { describe, expect, it } from "vitest";
import { BOM, serializeCsv } from "./csv-export";
import { PROTOCOL_HEADERS, heldOutSentence, protocolFilename, protocolRows, pupilIds, withoutProtected } from "./crisis-protocol";
import { ENDED, STARTED, call, protocol, pupil, teacher } from "./__fixtures__/crisis";

const ZONE = "Europe/Stockholm";

const view = protocol(
  [
    call(
      "c-7a",
      "7A",
      [
        pupil("s1", "Ines", "Ek", "FOUND", { markedAt: "2027-01-12T09:20:03.000Z", markedBy: "Anna Berg" }),
        pupil("s2", "Jamal", "Ali", "MISSING", { markedAt: "2027-01-12T09:21:00.000Z", markedBy: "Anna Berg" }),
        pupil("s3", "Klara", "Nyman"),
        pupil("s4", "Leo", "Berg", "ABSENT_BEFORE"),
      ],
      { teachers: [teacher("t-anna", "Anna Berg", "2027-01-12T09:20:03.000Z"), teacher("t-bo", "Bo Ek")] },
    ),
    call("c-8a", "8A", [pupil("s5", "Olle", "Lind", "FOUND")], {
      basis: "NEXT_LESSON",
      roomName: null,
      teachers: [teacher(null, null)],
    }),
  ],
  [
    { at: "2027-01-12T09:20:03.000Z", receivedAt: "2027-01-12T09:20:04.000Z", studentId: "s1", groupName: "7A", state: "FOUND", by: "Anna Berg", onBehalf: false, late: false },
    { at: "2027-01-12T09:21:00.000Z", receivedAt: "2027-01-12T09:21:01.000Z", studentId: "s2", groupName: "7A", state: "MISSING", by: "Anna Berg", onBehalf: false, late: false },
    { at: "2027-01-12T09:40:00.000Z", receivedAt: "2027-01-12T09:40:01.000Z", studentId: "s5", groupName: "8A", state: "FOUND", by: "Rut Rektor", onBehalf: true, late: true },
  ],
  { endedAt: ENDED, endedBy: "Rut Rektor" },
);

describe("the protocol's file name", () => {
  it("is larmprotokoll-<date>-<hhmm> from the start, in the school's zone", () => {
    expect(protocolFilename(STARTED, ZONE)).toBe("larmprotokoll-2027-01-12-1014.csv");
    expect(protocolFilename("2027-01-12T23:30:00.000Z", ZONE)).toBe("larmprotokoll-2027-01-13-0030.csv");
  });
});

describe("the protocol's rows", () => {
  it("are a row per pupil of every group: the alarm, the group, who answers for it, the pupil, the status and the last mark", () => {
    const rows = protocolRows(view, new Set(), ZONE);
    expect(rows).toHaveLength(5);
    const header = [...PROTOCOL_HEADERS];
    const field = (row: string[], name: (typeof PROTOCOL_HEADERS)[number]) => row[header.indexOf(name)];
    expect(rows.every((row) => row.length === header.length)).toBe(true);

    const ines = rows[0]!;
    expect(field(ines, "larm_start")).toBe("2027-01-12 10:14:00");
    expect(field(ines, "art")).toBe("utrymning");
    expect(field(ines, "lage")).toBe("skarpt larm");
    expect(field(ines, "grupp")).toBe("7A");
    expect(field(ines, "sal")).toBe("Sal 12");
    expect(field(ines, "lektion_start")).toBe("10:00");
    expect(field(ines, "lektion_slut")).toBe("10:50");
    expect(field(ines, "lektionen")).toBe("pågående lektion");
    expect(field(ines, "larare")).toBe("Anna Berg (10:20) / Bo Ek (ej svarat)");
    expect([field(ines, "elev_efternamn"), field(ines, "elev_fornamn")]).toEqual(["Ek", "Ines"]);
    expect(field(ines, "status")).toBe("finns");
    expect(field(ines, "markerad")).toBe("2027-01-12 10:20:03");
    expect(field(ines, "markerad_av")).toBe("Anna Berg");

    expect(rows.map((row) => field(row, "status"))).toEqual(["finns", "saknas", "ej rapporterad", "frånvarande sedan tidigare", "finns"]);
    // A group in a break, and one nobody answers for.
    const olle = rows[4]!;
    expect(field(olle, "lektionen")).toBe("nästa lektion (rast)");
    expect(field(olle, "larare")).toBe("ingen lärare");
    expect(field(olle, "sal")).toBe("");
  });

  it("leave the protected pupils out by name, and say once how many were counted without one", () => {
    const rows = protocolRows(view, new Set(["s2", "s5", "s-not-in-it"]), ZONE);
    const header = [...PROTOCOL_HEADERS];
    const names = rows.map((row) => row[header.indexOf("elev_fornamn")]);
    expect(names).toEqual(["Ines", "Klara", "Leo", ""]);
    // No cell of the file holds a protected pupil's name, and no mark that names them.
    const everything = JSON.stringify(rows);
    for (const hidden of ["Jamal", "Ali", "Olle", "Lind"]) expect(everything).not.toContain(hidden);
    const note = rows.at(-1)!;
    expect(note.at(-1)).toBe("2 elever med skyddad identitet är räknade utan namn");
    expect(note.slice(0, -1).every((cell) => cell === "")).toBe(true);
  });

  it("add no note when nobody is protected, and say one pupil in the singular", () => {
    expect(protocolRows(view, new Set(), ZONE).some((row) => row.at(-1) !== "")).toBe(false);
    expect(heldOutSentence(0)).toBe("");
    expect(heldOutSentence(1)).toBe("1 elev med skyddad identitet är räknad utan namn");
  });
});

describe("the protocol as a CSV file, like the others", () => {
  const file = serializeCsv([...PROTOCOL_HEADERS], protocolRows(view, new Set(), ZONE));

  it("has a BOM, semicolons, CRLF and headers in ASCII", () => {
    expect(file.startsWith(BOM)).toBe(true);
    expect(file).toContain("\r\n");
    expect(file.split("\r\n")[0]!.slice(1)).toBe(PROTOCOL_HEADERS.join(";"));
    expect(/^[\x20-\x7e]*$/.test(PROTOCOL_HEADERS.join(";"))).toBe(true);
  });

  it("keeps a formula in a name from running when the file is opened in Excel", () => {
    const hostile = protocol([call("c", "7A", [pupil("s1", "=HYPERLINK(\"http://x\")", "+cmd|calc", "FOUND", { markedBy: "@SUM(A1)" })])]);
    const text = serializeCsv([...PROTOCOL_HEADERS], protocolRows(hostile, new Set(), ZONE));
    expect(text).toContain("'+cmd|calc");
    expect(text).toContain("'=HYPERLINK");
    expect(text).toContain("'@SUM(A1)");
    // Never at the start of a cell, quoted or not.
    expect(text).not.toMatch(/(^|;|")[=+@-][A-Za-z]/m);
  });

  it("puts a group whose name has a semicolon in one cell", () => {
    const odd = protocol([call("c", "Idrott; hälsa", [pupil("s1", "Ines", "Ek", "FOUND")])]);
    const lines = serializeCsv([...PROTOCOL_HEADERS], protocolRows(odd, new Set(), ZONE)).split("\r\n");
    expect(lines[1]).toContain('"Idrott; hälsa"');
  });
});

describe("the protocol on paper", () => {
  it("is the groups without the protected pupils and the timeline without the marks that name them", () => {
    const paper = withoutProtected(view, new Set(["s2", "s5"]));
    expect(paper.heldOut).toBe(2);
    expect(paper.calls.map((one) => one.pupils.map((row) => row.studentId))).toEqual([["s1", "s3", "s4"], []]);
    expect(paper.marks.map((one) => one.studentId)).toEqual(["s1"]);
    // The groups' own figures are the gateway's and count them: "räknade utan namn".
    expect(paper.calls[0]!.counts.missing).toBe(1);
  });

  it("counts a pupil once, and not one the protocol does not name", () => {
    expect(withoutProtected(view, new Set(["s1", "x"])).heldOut).toBe(1);
    expect(pupilIds(view)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
  });
});
