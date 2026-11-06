import { describe, expect, it } from "vitest";
import { BOM, serializeCsv } from "./csv-export";
import { NO_LESSON_WORD, PROTOCOL_HEADERS, heldOutSentence, protocolFilename, protocolRows, pupilIds, unlistedPupils, withoutProtected } from "./crisis-protocol";
import { ENDED, STARTED, call, noLessonCall, protocol, protocolMark, pupil, teacher } from "./__fixtures__/crisis";

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
    protocolMark({ studentId: "s1", groupName: "7A" }),
    protocolMark({ at: "2027-01-12T09:21:00.000Z", receivedAt: "2027-01-12T09:21:01.000Z", studentId: "s2", groupName: "7A", state: "MISSING" }),
    protocolMark({ at: "2027-01-12T09:40:00.000Z", receivedAt: "2027-01-12T09:40:01.000Z", studentId: "s5", groupName: "8A", by: "Rut Rektor", onBehalf: true, late: true }),
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
    // The new column is last, so that anyone reading the first sixteen by position or by name reads the file as before.
    expect(header.slice(0, 16)).toEqual([
      "larm_start", "art", "lage", "grupp", "amne", "sal", "lektion_start", "lektion_slut", "lektionen", "larare",
      "elev_efternamn", "elev_fornamn", "status", "markerad", "markerad_av", "anmarkning",
    ]);
    expect(header.at(-1)).toBe("hittad_hos");

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
    // The sentence stays where it was, in anmarkning; the new last column of that row is empty like the rest.
    const note = rows.at(-1)!;
    expect(note[header.indexOf("anmarkning")]).toBe("2 elever med skyddad identitet är räknade utan namn");
    expect(note.filter((cell) => cell !== "")).toEqual(["2 elever med skyddad identitet är räknade utan namn"]);
  });

  it("add no note when nobody is protected, and say one pupil in the singular", () => {
    expect(protocolRows(view, new Set(), ZONE).some((row) => row[PROTOCOL_HEADERS.indexOf("anmarkning")] !== "")).toBe(false);
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

describe("the group of pupils on no lesson, and the pupils found with another group", () => {
  const header = [...PROTOCOL_HEADERS];
  const field = (row: string[], name: (typeof PROTOCOL_HEADERS)[number]) => row[header.indexOf(name)];
  // 7A has a lesson; the gateway's stand-in names for the group nobody has a lesson with are Swedish prose that the file does not repeat.
  const noLesson = noLessonCall("c-none", [pupil("s7", "Pia", "Sten"), pupil("s8", "Qvist", "Tor", "ABSENT_BEFORE"), pupil("s9", "Rut", "Ulf", "FOUND")]);
  const withNone = protocol(
    [call("c-7a", "7A", [pupil("s1", "Ines", "Ek", "FOUND"), pupil("s2", "Jamal", "Ali", "MISSING")], { teachers: [teacher("t-anna", "Anna Berg")] }), noLesson],
    [
      protocolMark({ studentId: "s1", groupName: "7A" }),
      // Pia stands on no list and was found by Anna, a teacher of 7A.
      protocolMark({ at: "2027-01-12T09:22:00.000Z", studentId: "s7", groupName: "Ej i lektion just nu", foundIn: { groupName: "7A", basis: "LESSON" } }),
      // Rut was found by a teacher, then the administration said it again for the group itself: the latest mark is not a find elsewhere.
      protocolMark({ at: "2027-01-12T09:23:00.000Z", studentId: "s9", groupName: "Ej i lektion just nu", foundIn: { groupName: "7A", basis: "LESSON" } }),
      protocolMark({ at: "2027-01-12T09:25:00.000Z", studentId: "s9", groupName: "Ej i lektion just nu", by: "Rut Rektor", onBehalf: true }),
    ],
    { endedAt: ENDED },
  );

  it("is a group row like the others, under the file's words, with no subject, room or lesson times, and nobody to ask", () => {
    const rows = protocolRows(withNone, new Set(), ZONE);
    expect(rows).toHaveLength(5);
    const pia = rows.find((row) => field(row, "elev_fornamn") === "Pia")!;
    expect(field(pia, "grupp")).toBe(NO_LESSON_WORD);
    expect(field(pia, "grupp")).toBe("Ej i lektion just nu");
    expect([field(pia, "amne"), field(pia, "sal"), field(pia, "lektion_start"), field(pia, "lektion_slut")]).toEqual(["", "", "", ""]);
    expect(field(pia, "lektionen")).toBe("ej i lektion");
    expect(field(pia, "larare")).toBe("ingen lärare");
    expect(field(pia, "status")).toBe("ej rapporterad");
    // The gateway's stand-in for the subject is not in the file at all.
    expect(JSON.stringify(rows)).not.toContain("Ingen lektion pågår");
  });

  it("says in the new last column which group found a pupil, only when the pupil's latest mark was made by a teacher of another group", () => {
    const rows = protocolRows(withNone, new Set(), ZONE);
    const by = (first: string) => field(rows.find((row) => field(row, "elev_fornamn") === first)!, "hittad_hos");
    expect(by("Pia")).toBe("Hittad hos 7A");
    expect(by("Rut")).toBe("");
    expect(by("Ines")).toBe("");
    expect(by("Qvist")).toBe("");
    expect(rows.every((row) => row.length === header.length)).toBe(true);
  });

  it("says a find with the group of pupils on no lesson in the file's words, not the gateway's", () => {
    const view = protocol([call("c-7a", "7A", [pupil("s1", "Ines", "Ek", "FOUND")])], [
      protocolMark({ studentId: "s1", groupName: "7A", foundIn: { groupName: "Ej i lektion just nu", basis: "NO_LESSON" } }),
    ]);
    expect(field(protocolRows(view, new Set(), ZONE)[0]!, "hittad_hos")).toBe("Hittad hos Ej i lektion just nu");
    const relabelled = protocol([call("c-7a", "7A", [pupil("s1", "Ines", "Ek", "FOUND")])], [
      protocolMark({ studentId: "s1", groupName: "7A", foundIn: { groupName: "Not in a lesson", basis: "NO_LESSON" } }),
    ]);
    expect(field(protocolRows(relabelled, new Set(), ZONE)[0]!, "hittad_hos")).toBe("Hittad hos Ej i lektion just nu");
  });

  it("keeps the old file's first sixteen columns as they were for a protocol with finds in it", () => {
    const [pia] = protocolRows(withNone, new Set(["s1", "s2", "s8", "s9"]), ZONE);
    expect(pia!.slice(0, 16).filter((cell) => cell !== "").length).toBeGreaterThan(5);
    expect(pia!.slice(0, 16).join(";")).not.toContain("Hittad");
  });

  it("holds out a protected pupil of the group on no lesson, by name and in every mark that names them, and counts them", () => {
    const rows = protocolRows(withNone, new Set(["s7"]), ZONE);
    const everything = JSON.stringify(rows);
    for (const hidden of ["Pia", "Sten"]) expect(everything).not.toContain(hidden);
    // The group is still there for the others, and the find is not said for a pupil who is not in the file.
    expect(rows.some((row) => field(row, "grupp") === NO_LESSON_WORD)).toBe(true);
    expect(everything).not.toContain("Hittad hos");
    expect(rows.at(-1)![header.indexOf("anmarkning")]).toBe("1 elev med skyddad identitet är räknad utan namn");

    const paper = withoutProtected(withNone, new Set(["s7"]));
    expect(paper.heldOut).toBe(1);
    expect(paper.calls.find((one) => one.basis === "NO_LESSON")!.pupils.map((one) => one.studentId)).toEqual(["s8", "s9"]);
    expect(paper.marks.map((one) => one.studentId)).not.toContain("s7");
    // The group's own figures are the gateway's and still count them.
    expect(paper.calls.find((one) => one.basis === "NO_LESSON")!.counts.pupils).toBe(3);
  });

  it("tells which pupils are on the group, so that a page can say a mark's group in its own words", () => {
    expect([...unlistedPupils(withNone.calls)].sort()).toEqual(["s7", "s8", "s9"]);
    expect(unlistedPupils([call("c", "7A", [pupil("s1", "Ines", "Ek")])]).size).toBe(0);
  });
});

describe("a pupil the administration marked not in the building", () => {
  const header = [...PROTOCOL_HEADERS];
  const field = (row: string[], name: (typeof PROTOCOL_HEADERS)[number]) => row[header.indexOf(name)];
  const away = protocol(
    [
      noLessonCall("c-none", [
        pupil("s7", "Pia", "Sten", "AWAY", { markedBy: "Rut Rektor" }),
        pupil("s8", "Qvist", "Tor", "FOUND", { markedBy: "Anna Berg" }),
        pupil("s9", "Rut", "Ulf"),
      ]),
    ],
    [
      protocolMark({ at: "2027-01-12T09:30:00.000Z", studentId: "s7", groupName: "Ej i lektion just nu", state: "AWAY", by: "Rut Rektor" }),
      // Qvist was found by a teacher of 7A, and that teacher then took the find back: the file does not still say "Hittad hos 7A".
      protocolMark({ at: "2027-01-12T09:22:00.000Z", studentId: "s8", groupName: "Ej i lektion just nu", foundIn: { groupName: "7A", basis: "LESSON" } }),
      protocolMark({ at: "2027-01-12T09:24:00.000Z", studentId: "s8", groupName: "Ej i lektion just nu", foundIn: { groupName: "7A", basis: "LESSON" }, state: "RETRACTED" }),
    ],
    { endedAt: ENDED },
  );

  it("has its own word in the status column, neither 'finns' nor 'saknas', and its row says who said it", () => {
    const rows = protocolRows(away, new Set(), ZONE);
    const pia = rows.find((row) => field(row, "elev_fornamn") === "Pia")!;
    expect(field(pia, "status")).toBe("inte i huset");
    expect(field(pia, "markerad_av")).toBe("Rut Rektor");
    expect(field(pia, "status")).not.toMatch(/finns|saknas/);
    expect(field(pia, "hittad_hos")).toBe("");
  });

  it("does not say a pupil was found with a group once the find has been taken back", () => {
    const rows = protocolRows(away, new Set(), ZONE);
    expect(field(rows.find((row) => field(row, "elev_fornamn") === "Qvist")!, "hittad_hos")).toBe("");
  });

  it("is held out by name like any pupil with a protected identity, and still counted", () => {
    const rows = protocolRows(away, new Set(["s7"]), ZONE);
    expect(JSON.stringify(rows)).not.toContain("Pia");
    expect(JSON.stringify(rows)).not.toContain("inte i huset");
    expect(rows.at(-1)![header.indexOf("anmarkning")]).toBe("1 elev med skyddad identitet är räknad utan namn");
    const paper = withoutProtected(away, new Set(["s7"]));
    expect(paper.heldOut).toBe(1);
    expect(paper.marks.map((one) => one.studentId)).not.toContain("s7");
    expect(paper.calls[0]!.counts.away).toBe(1);
  });
});
