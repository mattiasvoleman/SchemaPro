import { generatedMastersWhere, keptMastersWhere, PRESERVED_FROM_REGENERATION } from './preserved-lessons';

describe('keptMastersWhere (review of #315, MEDEL-1)', () => {
  it('is the preserved arms of the year, not parked: the lessons Generera keeps and plans around', () => {
    expect(keptMastersWhere('year-1')).toEqual({ academicYearId: 'year-1', isParked: false, OR: PRESERVED_FROM_REGENERATION });
  });

  it('holds all four arms of what a regeneration leaves alone, not a slice of them', () => {
    expect(PRESERVED_FROM_REGENERATION).toEqual([
      { isGenerated: false },
      { isLocked: true, fromPlacement: false },
      { extraGroups: { some: {} } },
      { participants: { some: {} } },
    ]);
    // The same list, by reference: a reader that built its own would be a reader that could drop an arm.
    expect((keptMastersWhere('year-1') as { OR: unknown }).OR).toBe(PRESERVED_FROM_REGENERATION);
  });
});

describe('generatedMastersWhere', () => {
  it('is what the next Generera replaces: not one of the preserved arms, not parked, and not written from a förläggning', () => {
    expect(generatedMastersWhere('year-1')).toEqual({
      academicYearId: 'year-1',
      isParked: false,
      fromPlacement: false,
      NOT: { OR: PRESERVED_FROM_REGENERATION },
    });
  });

  it('negates the same list by reference, so that an arm added to what is kept is left out of this too', () => {
    expect((generatedMastersWhere('year-1').NOT as { OR: unknown }).OR).toBe(PRESERVED_FROM_REGENERATION);
  });
});
