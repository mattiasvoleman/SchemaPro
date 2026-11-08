import {
  DEFAULT_PLACEMENT_WEIGHT,
  MAX_EDGE_SUBJECTS,
  PLACEMENT_SETTINGS_SELECT,
  limitsBuildings,
  placementModesOf,
  placementRulesOf,
  roomPlacementOf,
  type PlacementSettings,
} from './placement-rules';

/*
 * Placeringsregler, the payload half. ai-engine-contract.spec.ts holds the
 * whole payload; what is pinned here is each decision on its own: which rule
 * is on, what a room says, and what is left out.
 */

const identity = (id: string) => id;
const sent = (...ids: string[]) => (id: string) => (ids.includes(id) ? `anon-${id}` : undefined);

describe('placementModesOf', () => {
  it('reads every rule as off for a school with no row, a row from before the columns and the defaults', () => {
    const off = { edge: null, places: null, shared: null };
    expect(placementModesOf(null)).toEqual(off);
    expect(placementModesOf(undefined)).toEqual(off);
    expect(placementModesOf({})).toEqual(off);
    expect(
      placementModesOf({
        placementEdgeMode: 'OFF',
        placementPlacesMode: 'OFF',
        placementSharedMode: 'OFF',
        maxClassRoomsPerDay: 2,
      }),
    ).toEqual(off);
  });

  it('reads SOFT as on for each rule apart, and HARD as on for rule 3 alone', () => {
    expect(placementModesOf({ placementEdgeMode: 'SOFT' })).toEqual({ edge: 'SOFT', places: null, shared: null });
    expect(placementModesOf({ placementPlacesMode: 'SOFT', maxTeacherRoomsPerDay: 1 })).toEqual({
      edge: null,
      places: 'SOFT',
      shared: null,
    });
    expect(placementModesOf({ placementSharedMode: 'SOFT' })).toEqual({ edge: null, places: null, shared: 'SOFT' });
    expect(placementModesOf({ placementSharedMode: 'HARD' })).toEqual({ edge: null, places: null, shared: 'HARD' });
  });

  it('never reads a HARD rule 1 or rule 2 as HARD: a row that still holds one (the CHECK keeps it out of the table) is held SOFT', () => {
    // Defence in depth for LunchSettings_placementEdgeMode_off_or_soft_check and …PlacesMode…: the generator
    // never builds the cost that is the reason a hard rule 1 or 2 is not offered, whatever the row says.
    expect(placementModesOf({ placementEdgeMode: 'HARD' })).toEqual({ edge: 'SOFT', places: null, shared: null });
    expect(placementModesOf({ placementPlacesMode: 'HARD', maxTeacherRoomsPerDay: 1 })).toEqual({
      edge: null,
      places: 'SOFT',
      shared: null,
    });
  });

  it.each([
    'maxClassRoomsPerDay',
    'maxTeacherRoomsPerDay',
    'maxClassBuildingsPerDay',
    'maxTeacherBuildingsPerDay',
  ] as const)('holds rule 2 on by %s alone, a limit of 1 (a single place) included', (field) => {
    expect(placementModesOf({ placementPlacesMode: 'SOFT', [field]: 1 }).places).toBe('SOFT');
  });

  it('holds rule 2 off while it has no limit to hold, whatever its mode: the engine refuses a block that limits nothing', () => {
    expect(placementModesOf({ placementPlacesMode: 'SOFT' }).places).toBeNull();
    expect(
      placementModesOf({
        placementPlacesMode: 'SOFT',
        maxClassRoomsPerDay: null,
        maxTeacherRoomsPerDay: null,
        maxClassBuildingsPerDay: null,
        maxTeacherBuildingsPerDay: null,
      }).places,
    ).toBeNull();
  });
});

describe('limitsBuildings', () => {
  it('is true for a class’s or a teacher’s building limit of a rule that is on, 1 included', () => {
    expect(limitsBuildings({ placementPlacesMode: 'SOFT', maxClassBuildingsPerDay: 1 })).toBe(true);
    expect(limitsBuildings({ placementPlacesMode: 'HARD', maxTeacherBuildingsPerDay: 2 })).toBe(true); // held SOFT
  });

  it('is false for room limits alone, a rule that is off, and a school without a row', () => {
    expect(limitsBuildings({ placementPlacesMode: 'SOFT', maxClassRoomsPerDay: 1, maxTeacherRoomsPerDay: 1 })).toBe(false);
    expect(limitsBuildings({ placementPlacesMode: 'OFF', maxClassBuildingsPerDay: 1 })).toBe(false);
    expect(limitsBuildings(null)).toBe(false);
    expect(limitsBuildings(undefined)).toBe(false);
  });
});

describe('roomPlacementOf', () => {
  const token = (building: string) => `token-of-${building.length}`;

  it('says nothing of a room while neither rule that reads it is on', () => {
    expect(roomPlacementOf({ capacity: 30, building: 'Hus B', canBeShared: true }, { buildings: false, shared: false }, token)).toEqual({});
  });

  it('gives a room with a building its token, and a room without one nothing: no building is itself a value', () => {
    const on = { buildings: true, shared: false };
    expect(roomPlacementOf({ capacity: 30, building: 'Hus B' }, on, token)).toEqual({ building: 'token-of-5' });
    expect(roomPlacementOf({ capacity: 30, building: null }, on, token)).toEqual({});
    expect(roomPlacementOf({ capacity: 30, building: '' }, on, token)).toEqual({});
    expect(roomPlacementOf({ capacity: 30 }, on, token)).toEqual({});
  });

  it('marks a room shareable only when it is marked, has a capacity and the rule is on', () => {
    const on = { buildings: false, shared: true };
    expect(roomPlacementOf({ capacity: 60, canBeShared: true }, on, token)).toEqual({ shareable: true });
    expect(roomPlacementOf({ capacity: 60, canBeShared: false }, on, token)).toEqual({});
    expect(roomPlacementOf({ capacity: 60, canBeShared: null }, on, token)).toEqual({});
    expect(roomPlacementOf({ capacity: 60 }, on, token)).toEqual({});
    // No capacity, no limit to share under.
    expect(roomPlacementOf({ capacity: null, canBeShared: true }, on, token)).toEqual({});
    expect(roomPlacementOf({ capacity: 0, canBeShared: true }, on, token)).toEqual({});
  });

  it('can say both of one room', () => {
    expect(roomPlacementOf({ capacity: 60, building: 'Gymnastikhuset', canBeShared: true }, { buildings: true, shared: true }, token)).toEqual({
      building: 'token-of-14',
      shareable: true,
    });
  });
});

describe('placementRulesOf', () => {
  const marked = [
    { id: 'ma', notFirstInDay: true, notLastInDay: false },
    { id: 'idh', notFirstInDay: true, notLastInDay: true },
    { id: 'sv', notFirstInDay: false, notLastInDay: false },
    { id: 'bild', notFirstInDay: false, notLastInDay: true },
  ];
  const rulesOf = (settings: PlacementSettings | null, extra: { subjectId?: (id: string) => string | undefined; anyShareableRoom?: boolean } = {}) =>
    placementRulesOf({
      settings,
      markedSubjects: marked,
      subjectId: extra.subjectId ?? sent('ma', 'idh', 'sv', 'bild'),
      anyShareableRoom: extra.anyShareableRoom ?? true,
    });

  it('sends nothing when every rule is off: the key is absent, not empty', () => {
    expect(rulesOf(null)).toBeUndefined();
    expect(rulesOf({})).toBeUndefined();
    expect(rulesOf({ placementEdgeMode: 'OFF', placementPlacesMode: 'OFF', placementSharedMode: 'OFF', maxClassRoomsPerDay: 1 })).toBeUndefined();
  });

  it('sends rule 1 with the marked subjects in the payload’s ids, a mark on neither end left out, SOFT with its weight', () => {
    expect(rulesOf({ placementEdgeMode: 'SOFT', placementEdgeWeight: 400 })).toEqual({
      subjectEdges: {
        mode: 'SOFT',
        weight: 400,
        subjects: [
          { subjectId: 'anon-ma', notFirst: true, notLast: false },
          { subjectId: 'anon-idh', notFirst: true, notLast: true },
          { subjectId: 'anon-bild', notFirst: false, notLast: true },
        ],
      },
    });
  });

  it('sends a HARD rule without a weight (rule 3), and a SOFT one without a figure at the column’s default', () => {
    expect(rulesOf({ placementSharedMode: 'HARD', placementSharedWeight: 900 })!.sharedRooms).not.toHaveProperty('weight');
    expect(rulesOf({ placementEdgeMode: 'SOFT' })!.subjectEdges!.weight).toBe(DEFAULT_PLACEMENT_WEIGHT);
    expect(rulesOf({ placementEdgeMode: 'SOFT', placementEdgeWeight: null })!.subjectEdges!.weight).toBe(DEFAULT_PLACEMENT_WEIGHT);
  });

  it('leaves out a subject the payload does not carry, and the rule when none is left', () => {
    const only = rulesOf({ placementEdgeMode: 'SOFT' }, { subjectId: sent('bild') });
    expect(only!.subjectEdges!.subjects).toEqual([{ subjectId: 'anon-bild', notFirst: false, notLast: true }]);
    expect(rulesOf({ placementEdgeMode: 'SOFT' }, { subjectId: sent('sv') })).toBeUndefined();
    expect(rulesOf({ placementEdgeMode: 'SOFT' }, { subjectId: () => undefined })).toBeUndefined();
    expect(placementRulesOf({ settings: { placementEdgeMode: 'SOFT' }, markedSubjects: [], subjectId: identity, anyShareableRoom: false })).toBeUndefined();
  });

  it('sends no more subjects than the engine takes', () => {
    const many = Array.from({ length: MAX_EDGE_SUBJECTS + 25 }, (_, index) => ({ id: `s${index}`, notFirstInDay: true, notLastInDay: false }));
    const rules = placementRulesOf({ settings: { placementEdgeMode: 'SOFT' }, markedSubjects: many, subjectId: identity, anyShareableRoom: false });
    expect(rules!.subjectEdges!.subjects).toHaveLength(MAX_EDGE_SUBJECTS);
    expect(rules!.subjectEdges!.subjects[0]!.subjectId).toBe('s0');
  });

  it('sends rule 2 with only the limits that are set under the engine’s names', () => {
    expect(
      rulesOf({
        placementPlacesMode: 'SOFT',
        placementPlacesWeight: 120,
        maxClassRoomsPerDay: 2,
        maxTeacherRoomsPerDay: null,
        maxClassBuildingsPerDay: 1,
      }),
    ).toEqual({ places: { mode: 'SOFT', weight: 120, maxClassRooms: 2, maxClassBuildings: 1 } });
  });

  it('sends a stored HARD rule 1 or rule 2 as the SOFT it is held at, with the row’s weight, and never as HARD', () => {
    expect(
      rulesOf({ placementPlacesMode: 'HARD', placementPlacesWeight: 90, maxTeacherRoomsPerDay: 6, maxTeacherBuildingsPerDay: 1 }),
    ).toEqual({ places: { mode: 'SOFT', weight: 90, maxTeacherRooms: 6, maxTeacherBuildings: 1 } });
    expect(rulesOf({ placementEdgeMode: 'HARD', placementEdgeWeight: 900 })!.subjectEdges).toMatchObject({ mode: 'SOFT', weight: 900 });
    expect(JSON.stringify(rulesOf({ placementEdgeMode: 'HARD', placementPlacesMode: 'HARD', maxClassRoomsPerDay: 1 }))).not.toContain('HARD');
  });

  it('sends rule 3 only when a room is shareable, SOFT with its weight and HARD without', () => {
    expect(rulesOf({ placementSharedMode: 'SOFT', placementSharedWeight: 60 })).toEqual({ sharedRooms: { mode: 'SOFT', weight: 60 } });
    expect(rulesOf({ placementSharedMode: 'HARD', placementSharedWeight: 60 })).toEqual({ sharedRooms: { mode: 'HARD' } });
    expect(rulesOf({ placementSharedMode: 'HARD' }, { anyShareableRoom: false })).toBeUndefined();
  });

  it('sends the rules that are on together, and only those', () => {
    const rules = rulesOf({ placementEdgeMode: 'SOFT', placementSharedMode: 'SOFT', placementPlacesMode: 'OFF', maxClassRoomsPerDay: 1 })!;
    expect(Object.keys(rules).sort()).toEqual(['sharedRooms', 'subjectEdges']);
  });
});

describe('PLACEMENT_SETTINGS_SELECT', () => {
  it('names the ten columns the rules are read from, and no other', () => {
    expect(Object.keys(PLACEMENT_SETTINGS_SELECT).sort()).toEqual([
      'maxClassBuildingsPerDay',
      'maxClassRoomsPerDay',
      'maxTeacherBuildingsPerDay',
      'maxTeacherRoomsPerDay',
      'placementEdgeMode',
      'placementEdgeWeight',
      'placementPlacesMode',
      'placementPlacesWeight',
      'placementSharedMode',
      'placementSharedWeight',
    ]);
  });
});
