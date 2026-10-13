import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The läslogg: every read of another person's row in these six tables goes through the gateway,
 * which records who read what. A migration then takes PostgREST's `authenticated` role off other
 * people's rows in them, so a direct read that slips back into the web would not leak anything —
 * it would come back empty, and the page would show a school without pupils, or a class without
 * attendance, as if that were the data. No type and no other test sees that; this one does.
 *
 * Two direct reads stay, both of the caller's own row: lib/auth.ts reads the session's profile by
 * its authId, and useStudentAttendance a pupil's own records by studentId, which its one page
 * passes as the signed-in profile's id. They are named here with the filter that makes them own-row
 * reads, so neither can widen without this test failing.
 */
const WEB = path.resolve(__dirname, "..");
const TABLES = [
  "Users",
  "AttendanceRecords",
  "AbsenceReports",
  "LeaveRequests",
  "GuardianStudents",
  "StudentGroupMembers",
];
const NAMES = TABLES.join("|");

/**
 * The three ways a source reads a table from PostgREST: `.from("Users")`, the paging helper
 * `selectAll<Person>("Users", …)` in lib/queries.ts, and an embed in another table's select —
 * `student:Users!AttendanceRecords_studentId_fkey(…)` reads Users rows just the same.
 */
const PATTERNS = [
  new RegExp(String.raw`\.from\(\s*["'\x60](${NAMES})["'\x60]\s*\)`, "g"),
  new RegExp(String.raw`selectAll(?:<[^>]*>)?\(\s*["'\x60](${NAMES})["'\x60]`, "g"),
  new RegExp(String.raw`["'\x60\s,:(](${NAMES})(?:![A-Za-z_]+)*\(`, "g"),
];

interface Read {
  file: string;
  table: string;
  /** The exported function or const the read sits in. */
  within: string | null;
  /** The statement from the read to its semicolon, whitespace collapsed. */
  statement: string;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function enclosingExport(text: string, index: number): string | null {
  let name: string | null = null;
  for (const m of text
    .slice(0, index)
    .matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function\s+|const\s+)(\w+)/g)) {
    name = m[1];
  }
  return name;
}

function readsIn(file: string, text: string): Read[] {
  const reads: Read[] = [];
  for (const pattern of PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      const at = m.index ?? 0;
      const end = text.indexOf(";", at);
      reads.push({
        file,
        table: m[1],
        within: enclosingExport(text, at),
        statement: text.slice(at, end === -1 ? undefined : end).replace(/\s+/g, " "),
      });
    }
  }
  return reads;
}

function allSources(): Array<{ file: string; text: string }> {
  const files = [
    ...["lib", "app", "components", "utils", "i18n"].flatMap((dir) => sourceFiles(path.join(WEB, dir))),
    path.join(WEB, "proxy.ts"),
  ];
  return files.map((full) => ({ file: path.relative(WEB, full), text: readFileSync(full, "utf8") }));
}

/** The own-row reads that stay direct, and the filter that makes each one. */
const OWN_ROW_READS = [
  { file: "lib/auth.ts", table: "Users", within: "getSession", filter: '.eq("authId", user.id)' },
  {
    file: "lib/queries.ts",
    table: "AttendanceRecords",
    within: "useStudentAttendance",
    filter: '.eq("studentId", studentId)',
  },
];

const isOwnRowRead = (read: Read) =>
  OWN_ROW_READS.some(
    (own) => own.file === read.file && own.table === read.table && own.within === read.within,
  );

describe("the läslogg's tables are read through the gateway", () => {
  it("finds each form of a direct read, so a pass is not a scan that matched nothing", () => {
    const forms = [
      'supabase.from("LeaveRequests").select("id")',
      "supabase\n  .from('GuardianStudents')\n  .select('id')",
      'selectAll<Person>(\n  "Users",\n  "id, firstName",\n  "lastName",\n)',
      '.select("studentId, student:Users!AttendanceRecords_studentId_fkey!inner(studentGroupId)")',
      '.select("id, members:StudentGroupMembers(studentId)")',
    ];
    expect(forms.map((form) => readsIn("x.ts", form).map((read) => read.table))).toEqual([
      ["LeaveRequests"],
      ["GuardianStudents"],
      ["Users"],
      ["Users"],
      ["StudentGroupMembers"],
    ]);
    // A table whose name merely starts like one of the six is not one of them.
    expect(readsIn("x.ts", 'supabase.from("UsersArchive")')).toEqual([]);
  });

  it("no web source reads another person's row in the six tables from PostgREST", () => {
    const direct = allSources()
      .flatMap(({ file, text }) => readsIn(file, text))
      .filter((read) => !isOwnRowRead(read))
      .map((read) => `${read.file} (${read.within ?? "module"}): ${read.table}`);
    expect(direct).toEqual([]);
  });

  it("the two direct reads left are each there once, filtered to the caller's own row", () => {
    const reads = allSources().flatMap(({ file, text }) => readsIn(file, text)).filter(isOwnRowRead);
    for (const own of OWN_ROW_READS) {
      const found = reads.filter((read) => read.file === own.file && read.within === own.within);
      // Exactly one: a second read in the same function would ride on this exemption.
      expect(found.map((read) => read.table), `${own.file} ${own.within}`).toEqual([own.table]);
      expect(found[0]?.statement, `${own.file} ${own.within}`).toContain(own.filter);
    }
  });

  it("useStudentAttendance is only ever asked for the signed-in pupil's own records", () => {
    const calls = allSources().flatMap(({ file, text }) =>
      [...text.matchAll(/useStudentAttendance\(([^)]*)\)/g)]
        .filter((m) => !text.slice(Math.max(0, (m.index ?? 0) - 16), m.index).includes("function"))
        .map((m) => `${file}: ${m[1].trim()}`),
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((call) => !call.endsWith(": profile.id"))).toEqual([]);
  });
});
