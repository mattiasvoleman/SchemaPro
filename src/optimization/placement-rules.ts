import type { PlacementRuleMode } from '@prisma/client';
import { offeredMode, type PlacementRule } from '../common/placement-modes';
import type {
  AnonymousPlacementRules,
  AnonymousSubjectEdge,
  PlacementMode,
} from './interfaces/ai-engine-payload.interface';

/**
 * Placeringsregler (20270126090000), the payload half: what the generator is
 * told of the school's three placement rules.
 *
 *   1. a subject marked not first / not last in a class's day
 *      (Subject.notFirstInDay, notLastInDay), per subject;
 *   2. at most N different room groups and M different buildings in a day, for a class and
 *      for a teacher (the Skolregler's four limits);
 *   3. the pupils of a shared room (Room.canBeShared) fitting its capacity
 *      together.
 *
 * EVERY RULE THAT IS OFF IS LEFT OUT, and with all three off the key is
 * absent: a school that has turned none on gets the payload, the model and the
 * response it always got, byte for byte (ai-engine-contract.spec.ts pins it
 * against a school with the defaults). A rule that is on but has nothing to
 * apply to is left out the same way: rule 1 with no subject marked (or none
 * the week teaches), rule 3 with no room marked and a capacity. That is the
 * order a school works in (turn the rule on, then mark), and the engine
 * refuses a rule that names nothing.
 *
 * NO NAME LEAVES. A subject goes by its anonymous id (the map the
 * requirements use), a room's building by an opaque token coined per request.
 */

/** What the engine's SubjectEdges.subjects takes at most (schemas/schedule.py). */
export const MAX_EDGE_SUBJECTS = 500;
/** The weight a rule is paid at when the row carries none: the column's default. */
export const DEFAULT_PLACEMENT_WEIGHT = 250;

/** The columns of the Skolregler row this reads. Every one optional: a row read before the columns existed has none. */
export interface PlacementSettings {
  placementEdgeMode?: PlacementRuleMode | null;
  placementEdgeWeight?: number | null;
  placementPlacesMode?: PlacementRuleMode | null;
  placementPlacesWeight?: number | null;
  maxClassRoomsPerDay?: number | null;
  maxTeacherRoomsPerDay?: number | null;
  maxClassBuildingsPerDay?: number | null;
  maxTeacherBuildingsPerDay?: number | null;
  placementSharedMode?: PlacementRuleMode | null;
  placementSharedWeight?: number | null;
}

/** The columns a select must name to feed {@link placementRulesOf}. */
export const PLACEMENT_SETTINGS_SELECT = {
  placementEdgeMode: true,
  placementEdgeWeight: true,
  placementPlacesMode: true,
  placementPlacesWeight: true,
  maxClassRoomsPerDay: true,
  maxTeacherRoomsPerDay: true,
  maxClassBuildingsPerDay: true,
  maxTeacherBuildingsPerDay: true,
  placementSharedMode: true,
  placementSharedWeight: true,
} as const;

const modeOf = (rule: PlacementRule, mode: PlacementRuleMode | null | undefined): PlacementMode | null => {
  // A HARD that rule 1 or 2 is not offered at (the CHECK keeps one out of the
  // table) goes to the engine as the SOFT it is held at everywhere else, never
  // as the hard rule that is the reason it is not offered. The weight is the
  // row's, which a SOFT carries.
  const held = offeredMode(rule, mode);
  return held === 'SOFT' || held === 'HARD' ? held : null;
};

/** SOFT carries the school's weight; HARD has none to carry. */
const weightOf = (mode: PlacementMode, weight: number | null | undefined): { weight?: number } =>
  mode === 'SOFT' ? { weight: weight ?? DEFAULT_PLACEMENT_WEIGHT } : {};

/**
 * Which rules are on. Rule 2 is on only with a limit to hold: the database
 * says a rule that is on has one (LunchSettings_placementPlaces_needs_a_limit_check),
 * so a row without is one nothing wrote, and the engine would refuse it.
 * Rules 1 and 2 are never HARD here (src/common/placement-modes.ts).
 */
export function placementModesOf(settings: PlacementSettings | null | undefined): {
  edge: PlacementMode | null;
  places: PlacementMode | null;
  shared: PlacementMode | null;
} {
  const limited = [
    settings?.maxClassRoomsPerDay,
    settings?.maxTeacherRoomsPerDay,
    settings?.maxClassBuildingsPerDay,
    settings?.maxTeacherBuildingsPerDay,
  ].some((limit) => limit !== null && limit !== undefined);
  return {
    edge: modeOf('edge', settings?.placementEdgeMode),
    places: limited ? modeOf('places', settings?.placementPlacesMode) : null,
    shared: modeOf('shared', settings?.placementSharedMode),
  };
}

/** Whether a room's building is told to the engine: only a school that limits the buildings a day holds. */
export function limitsBuildings(settings: PlacementSettings | null | undefined): boolean {
  return (
    placementModesOf(settings).places !== null &&
    ((settings?.maxClassBuildingsPerDay ?? null) !== null ||
      (settings?.maxTeacherBuildingsPerDay ?? null) !== null)
  );
}

/** What the payload says of one room, beyond what it always said. */
export interface RoomPlacement {
  building?: string;
  shareable?: true;
}

/**
 * The room's building token and its shareable mark. `token` coins the opaque
 * token for a real building name (one per distinct name, per request).
 */
export function roomPlacementOf(
  room: { capacity: number | null; building?: string | null; canBeShared?: boolean | null },
  on: { buildings: boolean; shared: boolean },
  token: (building: string) => string,
): RoomPlacement {
  return {
    ...(on.buildings && room.building ? { building: token(room.building) } : {}),
    // A room without a capacity has no limit to share under: it stays exclusive.
    ...(on.shared && room.canBeShared === true && room.capacity !== null && room.capacity > 0
      ? { shareable: true as const }
      : {}),
  };
}

/** A marked subject, as the subjects table answers. */
export interface MarkedSubject {
  id: string;
  notFirstInDay: boolean;
  notLastInDay: boolean;
}

/**
 * The rules to send, or undefined when none is on or none has anything to
 * apply to.
 *
 * `subjectId` turns a real subject id into the payload's (undefined for a
 * subject the payload does not carry: a rule about a subject the week does not
 * teach is no rule). `anyShareableRoom` is whether the rooms sent hold a
 * shareable one.
 */
export function placementRulesOf(input: {
  settings: PlacementSettings | null | undefined;
  markedSubjects: readonly MarkedSubject[];
  subjectId: (realId: string) => string | undefined;
  anyShareableRoom: boolean;
}): AnonymousPlacementRules | undefined {
  const { settings } = input;
  const modes = placementModesOf(settings);

  const subjects: AnonymousSubjectEdge[] = [];
  if (modes.edge !== null) {
    for (const subject of input.markedSubjects) {
      if (!subject.notFirstInDay && !subject.notLastInDay) continue;
      const id = input.subjectId(subject.id);
      if (id === undefined) continue;
      subjects.push({ subjectId: id, notFirst: subject.notFirstInDay, notLast: subject.notLastInDay });
    }
  }

  const rules: AnonymousPlacementRules = {
    ...(modes.edge !== null && subjects.length > 0
      ? {
          subjectEdges: {
            mode: modes.edge,
            ...weightOf(modes.edge, settings?.placementEdgeWeight),
            // Beyond what the engine takes the rest are left out; the caller
            // says so in the log (a school has tens of subjects, not 500).
            subjects: subjects.slice(0, MAX_EDGE_SUBJECTS),
          },
        }
      : {}),
    ...(modes.places !== null
      ? {
          places: {
            mode: modes.places,
            ...weightOf(modes.places, settings?.placementPlacesWeight),
            ...limitOf('maxClassRooms', settings?.maxClassRoomsPerDay),
            ...limitOf('maxTeacherRooms', settings?.maxTeacherRoomsPerDay),
            ...limitOf('maxClassBuildings', settings?.maxClassBuildingsPerDay),
            ...limitOf('maxTeacherBuildings', settings?.maxTeacherBuildingsPerDay),
          },
        }
      : {}),
    ...(modes.shared !== null && input.anyShareableRoom
      ? { sharedRooms: { mode: modes.shared, ...weightOf(modes.shared, settings?.placementSharedWeight) } }
      : {}),
  };
  return Object.keys(rules).length > 0 ? rules : undefined;
}

function limitOf<K extends string>(key: K, limit: number | null | undefined): { [P in K]?: number } {
  return limit === null || limit === undefined ? {} : ({ [key]: limit } as { [P in K]?: number });
}
