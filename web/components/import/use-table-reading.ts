"use client";

import { useRef, useState } from "react";
import { readTable, type RawTable } from "@/lib/column-table";
import { readSource, type TableSource } from "@/lib/column-source";
import type { MappingState } from "@/components/import/column-mapping-panel";

/** A file or a paste read into a table, before and apart from what the mapping makes of it. */
export type Reading =
  | { state: "table"; name: string; table: RawTable; encoding: string | null; serial: number }
  | { state: "problem"; name: string; problem: string };

/**
 * The state the CSV dialogs share (Kolumnmappning, X2): a file or a paste read into a table, and what the column panel says of
 * it. `load` replaces whatever was read before (the last one read wins, even if an earlier file is slower to decode), a new table
 * gets a new `serial` to key the panel by (the choices of the last one are for another table's columns), and `clear` forgets
 * the table and the mapping when a dialog is closed or the kind changes.
 *
 * `say` words the two things a source can be refused for: a text that is too long to be a table, and no table in it.
 */
export function useTableReading(say: (problem: "tooLong" | "empty") => string) {
  const [reading, setReading] = useState<Reading | null>(null);
  // What the column panel says of the table: the mapped table, and what is wrong with the mapping. Null until it has been shown.
  const [mapping, setMapping] = useState<MappingState | null>(null);
  const serial = useRef(0);
  const ticket = useRef(0);

  const load = async (from: TableSource, name: string) => {
    const mine = (ticket.current += 1);
    setMapping(null);
    // Bytes, not file.text(): a file saved in Excel is Windows-1252, and read as UTF-8 its å, ä and ö would be lost (readSource).
    const read = await readSource(from);
    if (mine !== ticket.current) return;
    if (!read.ok) {
      setReading({ state: "problem", name, problem: read.reason === "tooLong" ? say("tooLong") : read.problem });
      return;
    }
    const table = readTable(read.text);
    if (table.rows.length === 0) {
      setReading({ state: "problem", name, problem: say("empty") });
      return;
    }
    serial.current += 1;
    setReading({ state: "table", name, table, encoding: read.encoding, serial: serial.current });
  };

  const clear = () => {
    ticket.current += 1;
    setReading(null);
    setMapping(null);
  };

  return { reading, mapping, setMapping, load, clear };
}
