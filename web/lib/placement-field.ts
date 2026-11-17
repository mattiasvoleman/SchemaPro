import { timeToMinutes } from "@/lib/utils";

/*
 * What the fields of a lesson to be laid read, in a module of its own. place-fields and block-place-fields are fetched lazily and took this
 * from placement-drop.ts, which pulls the mirror of the clash rule and the clash rule itself (about 3.7 KB gzipped) behind it: every lazy
 * piece that imported it carried its own copy of them (measured: +19 KB of emitted JavaScript in all, the page's first load unchanged).
 * Anything a lazy piece needs from the drop module and that needs nothing of the mirror belongs here.
 */

/** `HH:MM` as minutes, or null when it is no time (an empty field). */
export const minutesOfField = (value: string): number | null => {
  if (!/^\d{1,2}:\d{2}$/.test(value)) return null;
  const minutes = timeToMinutes(value);
  return Number.isFinite(minutes) ? minutes : null;
};
