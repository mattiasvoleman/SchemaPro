import {
  dropOf,
  dropOfBlock,
  moverOfBlockBrick,
  moverOfBlockRow,
  moverOfRow,
  nextFreeSpot,
  nextFreeSpotOfBlock,
  suggestedBlockRooms,
  suggestedRoom,
  type BlockMover,
  type Mover,
  type OtherNames,
  type Span,
} from "@/lib/placement-drop";
import { buildMirror, type MirrorContext } from "@/lib/placement-mirror";

/*
 * WHAT A DRAG, A CHOSEN BRICK AND AN OPEN CARD NEED, FETCHED WHEN THE PAGE IS UP (lib/use-lazy-module.ts) AND NOT WITH IT.
 *
 * The week's ghost, the first free time and the sentence under the fields are the grundschema's mirror of the clash rule
 * (placement-mirror.ts) asked about a lesson (placement-drop.ts), and the mirror pulls the clash rule itself (lib/conflicts.ts) and the
 * stages' spans (lib/grade-span.ts) with it: about 3.7 KB gzipped, which nobody needs before they press a brick or pick up a card.
 * /admin/placements was at 189,8 of 190 KB with them in its first load (D1, D2 and teaches 5b all added to it), so they are here, and
 * the page holds a few bytes of glue for them.
 *
 * UNTIL THEY ARRIVE the page has no mirror, as it has none for a reader who may not write or before its board is read: a press or a drop
 * is judged by the gateway alone, which judges every one of them anyway, and the fields offer no ghost, no sentence and no next free time.
 * ONE MODULE, ONE REQUEST, for the drag and for the pair (D2: lib/placement-pair-control.ts), which asks the same mirror: two lazy
 * modules that share the mirror each got a copy of it from the chunker (measured: +19 KB of emitted JavaScript in all, and the same
 * again for every lazy piece that imported placement-drop.ts). So nothing a lazy piece loads apart from this one may import
 * placement-drop.ts or placement-mirror.ts for a value: the fields take `minutesOfField` from placement-field.ts, and
 * placement-drag-tools.test.ts walks the imports to say so.
 *
 * Pure.
 */

export { buildMirror, suggestedBlockRooms, suggestedRoom };
export { guardLeaving, heldViewOf, pairControl } from "@/lib/placement-pair-control";

type From = { dayOfWeek: number; startMinutes: number };

/**
 * The mirror and the names it reads, bound once: what the page asks is `drag.dropOf(mover, span)` and not the four arguments of the
 * function in placement-drop.ts. A mover has no use for the mirror and is handed out as it is.
 */
export function dragOf(mirror: MirrorContext, names: OtherNames) {
  return {
    dropOf: (mover: Mover, span: Span) => dropOf(mirror, mover, span, names),
    dropOfBlock: (mover: BlockMover, span: Span) => dropOfBlock(mirror, mover, span, names),
    nextFreeSpot: (mover: Mover, minutes: number, from: From) => nextFreeSpot(mirror, mover, minutes, from, names),
    nextFreeSpotOfBlock: (mover: BlockMover, minutes: number, from: From) => nextFreeSpotOfBlock(mirror, mover, minutes, from, names),
    moverOfRow,
    moverOfBlockBrick,
    moverOfBlockRow,
  };
}

/** The mirror's questions, bound to one mirror: null in the page until the module is here and a mirror is built. */
export type Drag = ReturnType<typeof dragOf>;
