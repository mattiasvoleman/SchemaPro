import { s1Duty, s1Group, s1Pupil } from '../../../test/utils/ss12000-mock-provider';
import {
  DUTY_ROLES,
  S1_SOURCE,
  activeOn,
  dateOf,
  isProtected,
  parseDeletedEntities,
  parseDuty,
  parseGroup,
  parseOrganisation,
  parsePerson,
  uuidOf,
} from './s1';

const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('S1 transcription (SS12000 2.1.0)', () => {
  it('names its source: SIS TK450, version 2.1.0, with the sha256 of the YAML read', () => {
    expect(S1_SOURCE.version).toBe('2.1.0');
    expect(S1_SOURCE.url).toBe('https://www.sis.se/globalassets/standardutveckling/tksidor/tk-450/openapi_ss12000_version2_1_0.yaml');
    expect(S1_SOURCE.sha256).toBe('aee9a95a4c5bd25cebaf357d266592f94e9388ae785ee9ac3b58e1992acccd28');
  });

  it('keeps every DutyRole S1 lists, spelled as S1 spells it', () => {
    expect(DUTY_ROLES).toHaveLength(19);
    expect(DUTY_ROLES).toEqual(expect.arrayContaining(['Lärare', 'Speciallärare/specialpedagog', 'Studie- och yrkesvägledare', 'Förskolechef']));
  });

  describe('uuidOf', () => {
    it('lowercases and accepts any RFC 4122 version, not only v4', () => {
      expect(uuidOf('AAAAAAAA-0000-1000-8000-000000000001')).toBe('aaaaaaaa-0000-1000-8000-000000000001');
      expect(uuidOf(' aaaaaaaa-0000-7000-8000-000000000001 ')).toBe('aaaaaaaa-0000-7000-8000-000000000001');
    });
    it('refuses anything that is not a uuid', () => {
      for (const value of ['', 'abc', 42, null, 'aaaaaaaa-0000-4000-8000-00000000000g', '{aaaaaaaa-0000-4000-8000-000000000001}']) {
        expect(uuidOf(value)).toBeNull();
      }
    });
  });

  it('reads a full-date, cuts a date-time to its day, and refuses a day that does not exist', () => {
    expect(dateOf('2026-10-10')).toBe('2026-10-10');
    expect(dateOf('2026-10-10T08:00:00+02:00')).toBe('2026-10-10');
    expect(dateOf('2026-02-30')).toBeNull();
    expect(dateOf('10/10/2026')).toBeNull();
  });

  it('treats an end date as inclusive and an absent one as open (S1: "Inkluderande")', () => {
    expect(activeOn('2026-10-10', '2026-08-15', '2026-10-10')).toBe(true);
    expect(activeOn('2026-10-11', '2026-08-15', '2026-10-10')).toBe(false);
    expect(activeOn('2026-10-10', '2026-10-10', null)).toBe(true);
    expect(activeOn('2026-10-09', '2026-10-10', null)).toBe(false);
  });

  it('calls a person protected for Sekretessmarkering and Skyddad folkbokföring only', () => {
    expect(isProtected('Ingen')).toBe(false);
    expect(isProtected(null)).toBe(false);
    expect(isProtected('Sekretessmarkering')).toBe(true);
    expect(isProtected('Skyddad folkbokföring')).toBe(true);
  });

  describe('parsePerson', () => {
    const raw = s1Pupil('BBBBBBBB-0000-4000-8000-000000000001', ' Ella ', 'Ek', 'ella@skola.se', ORG, {
      schoolYear: 7,
      responsibles: [{ id: 'cccccccc-0000-4000-8000-000000000001', securityMarking: 'Sekretessmarkering' }],
    });

    it('keeps what the diff needs, lowercasing ids and trimming names', () => {
      const parsed = parsePerson(raw);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value).toMatchObject({
        id: 'bbbbbbbb-0000-4000-8000-000000000001',
        givenName: 'Ella',
        familyName: 'Ek',
        securityMarking: 'Ingen',
        emails: [{ value: 'ella@skola.se', type: 'Skola elev' }],
        enrolments: [{ organisationId: ORG, schoolYear: 7, schoolType: 'GR', endDate: null, cancelled: false }],
        responsibles: [{ personId: 'cccccccc-0000-4000-8000-000000000001', securityMarking: 'Sekretessmarkering', relationType: 'Vårdnadshavare' }],
      });
    });

    it('drops civicNo, birthDate, sex, addresses, phone numbers and photo at parse', () => {
      const parsed = parsePerson({ ...raw, photo: 'https://example.invalid/p.jpg' });
      const text = JSON.stringify(parsed);
      for (const leaked of ['201001012384', '2010-01-01', 'Kvinna', 'Hemliga vägen', '070-0000000', 'p.jpg', 'civicNo', 'addresses', 'phoneNumbers']) {
        expect(text).not.toContain(leaked);
      }
    });

    it('refuses a record missing a required field, naming its id when one could be read', () => {
      expect(parsePerson({ ...raw, familyName: '' })).toEqual({ ok: false, externalId: 'bbbbbbbb-0000-4000-8000-000000000001' });
      expect(parsePerson({ ...raw, id: 'not-a-uuid' })).toEqual({ ok: false, externalId: null });
      expect(parsePerson('nope')).toEqual({ ok: false, externalId: null });
    });

    it('ignores an email of a type S1 does not define, and an enrolment without its required fields', () => {
      const parsed = parsePerson({
        ...raw,
        emails: [{ value: 'x@y.se', type: 'Jobb' }, { value: 'ok@y.se', type: 'Privat' }],
        enrolments: [{ enroledAt: { id: ORG }, schoolType: 'GR' }],
      });
      expect(parsed.ok && parsed.value.emails).toEqual([{ value: 'ok@y.se', type: 'Privat' }]);
      expect(parsed.ok && parsed.value.enrolments).toEqual([]);
    });
  });

  it('parses a Group with its memberships (a direct property, Group_allOf)', () => {
    const parsed = parseGroup(s1Group('dddddddd-0000-4000-8000-000000000001', '7A', 'Klass', ORG, ['BBBBBBBB-0000-4000-8000-000000000001']));
    expect(parsed.ok && parsed.value).toMatchObject({
      id: 'dddddddd-0000-4000-8000-000000000001',
      displayName: '7A',
      groupType: 'Klass',
      organisationId: ORG,
      memberships: [{ personId: 'bbbbbbbb-0000-4000-8000-000000000001' }],
    });
    expect(parseGroup({ id: 'dddddddd-0000-4000-8000-000000000001', displayName: '7A', groupType: 'Klass' })).toEqual({
      ok: false,
      externalId: 'dddddddd-0000-4000-8000-000000000001',
    });
    expect(parseGroup({ ...s1Group('dddddddd-0000-4000-8000-000000000001', '7A', 'Klass', ORG, []), groupType: 'Klassen' }).ok).toBe(false);
  });

  it('parses a Duty and never keeps dutyPercent, hoursPerYear or the signature', () => {
    const parsed = parseDuty(s1Duty('eeeeeeee-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000001', ORG));
    expect(parsed.ok).toBe(true);
    const text = JSON.stringify(parsed);
    expect(text).not.toMatch(/dutyPercent|hoursPerYear|ABCD|1440/);
    expect(parseDuty({ ...s1Duty('eeeeeeee-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000001', ORG), dutyRole: 'Lärarinna' }).ok).toBe(false);
  });

  it('parses an Organisation and refuses one without an organisationType from the enum', () => {
    expect(parseOrganisation({ id: ORG, displayName: 'Skolan', organisationType: 'Skolenhet', schoolUnitCode: '123' })).toEqual({
      ok: true,
      value: { id: ORG, displayName: 'Skolan', organisationType: 'Skolenhet', schoolUnitCode: '123' },
    });
    expect(parseOrganisation({ id: ORG, displayName: 'Skolan', organisationType: 'Gymnasium' }).ok).toBe(false);
  });

  it('reads deletedEntities.persons, groups and duties, ignoring the other categories and non-uuids', () => {
    expect(
      parseDeletedEntities({ persons: ['BBBBBBBB-0000-4000-8000-000000000001', 'x'], groups: [], activitites: ['dddddddd-0000-4000-8000-000000000001'] }),
    ).toEqual({ persons: ['bbbbbbbb-0000-4000-8000-000000000001'], groups: [], duties: [] });
    expect(parseDeletedEntities([])).toBeNull();
  });
});
