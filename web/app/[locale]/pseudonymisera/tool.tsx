"use client";

import { useEffect, useRef, useState } from "react";
import type { Treatment } from "@/lib/pseudonym-headers";
import { parseSource, type InputSource, type ParseFailure } from "@/lib/pseudonym-input";
import { sayWith, type Labels, type LabelKey } from "@/lib/pseudonym-labels";
import { planFile, pseudonymise, type RunResult } from "@/lib/pseudonym-run";
import { defaultOutName, type Entry } from "./entry";
import { FileCard } from "./file-card";
import { ResultView } from "./result-view";
import { BUTTON, BUTTON_OUTLINE, CARD, LABEL, TEXTAREA } from "./styles";

/** The sentence for a file that could not be read, by why. */
function problemKey(failure: ParseFailure): LabelKey {
  switch (failure.reason) {
    case "tooLong":
      return "problem.tooLong";
    case "empty":
      return "problem.empty";
    case "utf16":
      return "problem.utf16";
    case "msdos":
      return "problem.msdos";
    case "unsupported":
      return `problem.${failure.kind}`;
    case "workbook":
      // A zip that is no workbook is said as a zip (parseSource turns that one into "unsupported" already); the rest are the workbook's own.
      return failure.problem === "notWorkbook" ? "problem.zip" : `problem.workbook.${failure.problem}`;
  }
}

/**
 * The pseudonymiser, in the browser (Pseudonymiseraren, X1). Everything in this file and what it imports happens on this page: a file is read
 * with the File API, replaced in memory, and handed back as a download. Nothing is sent, stored or logged, which pseudonym-offline.test.ts reads
 * from the code, the component test runs with every way out replaced by a trap, and the page's own policy (connect-src 'none') makes the
 * browser refuse. The state lives in this component and goes with the tab; "Rensa allt" drops it at once.
 */
export function PseudonymiserareTool({ labels, locale }: { labels: Labels; locale: string }) {
  const say = sayWith(labels, locale);
  const nextId = useRef(1);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [words, setWords] = useState("");
  const [pasted, setPasted] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [reading, setReading] = useState(false);
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);

  // A result that has just been made is where the person is taken: the heading, which says so to a screen reader too.
  const resultReady = result !== null && result.ok;
  useEffect(() => {
    if (resultReady) resultHeading.current?.focus();
  }, [resultReady]);

  /** Anything that changes what would be made makes the last result stale: it is dropped, and what was confirmed with it. */
  const stale = (): void => {
    setResult(null);
    setConfirmed(false);
  };

  const add = async (source: InputSource, shownName: string): Promise<void> => {
    const parsed = await parseSource(source);
    if (!parsed.ok) {
      setProblems((current) => [...current, say("problem.line", { name: shownName, reason: say(problemKey(parsed)) })]);
      return;
    }
    const additions: Entry[] = parsed.inputs.map((input) => {
      const id = nextId.current++;
      return {
        id,
        name: input.facts.sheet === null ? shownName : `${shownName}, ${input.facts.sheet}`,
        input,
        plan: planFile(input),
        treatments: {},
        headersAreNames: false,
        outName: defaultOutName(id, input, shownName),
      };
    });
    setEntries((current) => [...current, ...additions]);
    if (parsed.hiddenSheets > 0) setProblems((current) => [...current, say("problem.hiddenSheets", { name: shownName, count: parsed.hiddenSheets })]);
  };

  const addFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    setReading(true);
    setProblems([]);
    stale();
    for (const file of files) await add({ file }, file.name);
    setReading(false);
  };

  const addPaste = async (): Promise<void> => {
    setReading(true);
    setProblems([]);
    stale();
    await add({ text: pasted }, say("tool.pastedName"));
    setPasted("");
    setReading(false);
  };

  const update = (id: number, change: (entry: Entry) => Entry): void => {
    stale();
    setEntries((current) => current.map((entry) => (entry.id === id ? change(entry) : entry)));
  };

  const clearAll = (): void => {
    setEntries([]);
    setWords("");
    setPasted("");
    setProblems([]);
    stale();
    if (fileInput.current !== null) fileInput.current.value = "";
  };

  const run = async (): Promise<void> => {
    setWorking(true);
    // One turn of the page's loop, so that "Arbetar…" is on the screen before the work that holds it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const outcome = pseudonymise(
      entries.map((entry) => entry.input),
      {
        words: words.split(/\r\n|\n|\r/).map((line) => line.trim()).filter((line) => line !== ""),
        files: entries.map((entry) => ({ headerRow: entry.plan.headerRow, headersAreNames: entry.headersAreNames, treatments: entry.treatments })),
      },
    );
    setResult(outcome);
    setConfirmed(false);
    setWorking(false);
  };

  const undecided = entries.reduce(
    (sum, entry) => sum + entry.plan.columns.filter((column) => (entry.treatments[column.index] ?? column.proposal?.treatment) === undefined).length,
    0,
  );

  return (
    <div className="space-y-8">
      <section aria-labelledby="add-heading" className="space-y-4">
        <h2 id="add-heading" className="text-xl font-semibold">
          {say("tool.addHeading")}
        </h2>
        <div className={CARD}>
          <div className="space-y-2">
            <label htmlFor="file-input" className={LABEL}>
              {say("tool.chooseFiles")}
            </label>
            <input
              ref={fileInput}
              id="file-input"
              type="file"
              multiple
              accept=".csv,.txt,.tsv,.xlsx,text/csv,text/plain,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                void addFiles(files);
              }}
              aria-describedby="file-hint"
            />
            <p id="file-hint" className="text-xs text-muted-foreground">
              {say("tool.accepted")}
            </p>
          </div>
          <div className="mt-6 space-y-2">
            <label htmlFor="paste-input" className={LABEL}>
              {say("tool.pasteLabel")}
            </label>
            <textarea id="paste-input" className={TEXTAREA} value={pasted} onChange={(event) => setPasted(event.target.value)} aria-describedby="paste-hint" spellCheck={false} />
            <p id="paste-hint" className="text-xs text-muted-foreground">
              {say("tool.pasteHint")}
            </p>
            <button type="button" className={BUTTON_OUTLINE} onClick={() => void addPaste()} disabled={pasted.trim() === "" || reading}>
              {say("tool.addPaste")}
            </button>
          </div>
        </div>
        <div aria-live="polite" className="text-sm">
          {reading ? <p>{say("tool.reading")}</p> : null}
          {problems.length > 0 ? (
            <ul role="alert" className="space-y-1 rounded-md border border-destructive/50 bg-destructive/10 p-3">
              {problems.map((problem, i) => (
                <li key={i}>{problem}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>

      {entries.length > 0 ? (
        <>
          <section aria-labelledby="files-heading" className="space-y-4">
            <h2 id="files-heading" className="text-xl font-semibold">
              {say("tool.filesHeading")}
            </h2>
            {entries.map((entry, index) => (
              <FileCard
                key={entry.id}
                entry={entry}
                index={index}
                say={say}
                onHeaderRow={(row) =>
                  update(entry.id, (e) => ({ ...e, plan: planFile(e.input, row), treatments: {}, headersAreNames: row === null ? false : e.headersAreNames }))
                }
                onHeadersAreNames={(value) => update(entry.id, (e) => ({ ...e, headersAreNames: value }))}
                onTreatment={(column, treatment: Treatment | null) =>
                  update(entry.id, (e) => {
                    const treatments = { ...e.treatments };
                    if (treatment === null) delete treatments[column];
                    else treatments[column] = treatment;
                    return { ...e, treatments };
                  })
                }
                onRemove={() => {
                  stale();
                  setEntries((current) => current.filter((e) => e.id !== entry.id));
                }}
              />
            ))}
          </section>

          <section aria-labelledby="words-heading" className="space-y-2">
            <h2 id="words-heading" className="text-xl font-semibold">
              {say("tool.wordsHeading")}
            </h2>
            <div className={CARD}>
              <label htmlFor="words-input" className={LABEL}>
                {say("tool.wordsLabel")}
              </label>
              <textarea
                id="words-input"
                className={`${TEXTAREA} mt-2`}
                value={words}
                onChange={(event) => {
                  stale();
                  setWords(event.target.value);
                }}
                aria-describedby="words-hint"
                spellCheck={false}
              />
              <p id="words-hint" className="mt-2 text-xs text-muted-foreground">
                {say("tool.wordsHint")}
              </p>
            </div>
          </section>

          <section aria-labelledby="run-heading" className="space-y-3">
            <h2 id="run-heading" className="text-xl font-semibold">
              {say("tool.runHeading")}
            </h2>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className={BUTTON} onClick={() => void run()} disabled={undecided > 0 || working || reading}>
                {say("tool.run")}
              </button>
              <button type="button" className={BUTTON_OUTLINE} onClick={clearAll}>
                {say("tool.clearAll")}
              </button>
            </div>
            <div aria-live="polite" className="text-sm">
              {working ? <p>{say("tool.working")}</p> : null}
              {undecided > 0 ? <p className="font-medium text-destructive">{say("tool.undecided", { count: undecided })}</p> : null}
              {resultReady ? <p>{say("result.ready")}</p> : null}
            </div>
          </section>

          {result !== null && result.ok ? (
            <section aria-labelledby="result-heading" className="space-y-4">
              <h2 id="result-heading" ref={resultHeading} tabIndex={-1} className="text-xl font-semibold outline-none">
                {say("result.heading")}
              </h2>
              <ResultView
                result={result}
                entries={entries}
                say={say}
                confirmed={confirmed}
                onConfirmed={setConfirmed}
                onOutName={(id, name) => setEntries((current) => current.map((e) => (e.id === id ? { ...e, outName: name } : e)))}
              />
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
