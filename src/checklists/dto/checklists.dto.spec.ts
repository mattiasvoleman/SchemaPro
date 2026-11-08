import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AskConsentDto,
  ConsentListsQueryDto,
  CreateConsentListDto,
  CreateTemplateDto,
  RecordConsentDto,
  RosterQueryDto,
  TemplatesQueryDto,
  TickProofsDto,
  UpdateTemplateDto,
  VoidProofDto,
} from './checklists.dto';

const ID = '44444444-4444-4444-8444-444444444444';

/** What the global ValidationPipe does (whitelist, forbidNonWhitelisted, transform): the instance and the properties it refuses. */
async function check<T extends object>(cls: new () => T, plain: Record<string, unknown>): Promise<{ dto: T; refused: string[] }> {
  const dto = plainToInstance(cls, plain);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, refused: errors.map((error) => error.property).sort() };
}

const repeat = (n: number, text = 'x') => text.repeat(n);
const ids = (n: number) => Array.from({ length: n }, () => ID);

describe('Checklistor’s DTOs', () => {
  describe('CreateTemplateDto', () => {
    it('trims the title and takes a description and a subject', async () => {
      const { dto, refused } = await check(CreateTemplateDto, { title: '  Cirkelsågen  ', description: ' Skydd ', subjectId: ID });
      expect(refused).toEqual([]);
      expect(dto).toMatchObject({ title: 'Cirkelsågen', description: 'Skydd', subjectId: ID });
    });

    it('takes a title of 120 characters and not of 121, and not an empty or blank one', async () => {
      expect((await check(CreateTemplateDto, { title: repeat(120) })).refused).toEqual([]);
      expect((await check(CreateTemplateDto, { title: repeat(121) })).refused).toEqual(['title']);
      expect((await check(CreateTemplateDto, { title: '' })).refused).toEqual(['title']);
      expect((await check(CreateTemplateDto, { title: '   ' })).refused).toEqual(['title']);
      expect((await check(CreateTemplateDto, {})).refused).toEqual(['title']);
      expect((await check(CreateTemplateDto, { title: 5 })).refused).toEqual(['title']);
    });

    it('leaves a blank description out, and takes 2000 characters and not 2001', async () => {
      expect((await check(CreateTemplateDto, { title: 'T', description: '   ' })).dto.description).toBeUndefined();
      expect((await check(CreateTemplateDto, { title: 'T', description: repeat(2000) })).refused).toEqual([]);
      expect((await check(CreateTemplateDto, { title: 'T', description: repeat(2001) })).refused).toEqual(['description']);
      expect((await check(CreateTemplateDto, { title: 'T', description: 4 })).refused).toEqual(['description']);
    });

    it('refuses a subject that is not an id, and a field it does not know', async () => {
      expect((await check(CreateTemplateDto, { title: 'T', subjectId: 'slöjd' })).refused).toEqual(['subjectId']);
      expect((await check(CreateTemplateDto, { title: 'T', active: false })).refused).toEqual(['active']);
    });
  });

  describe('UpdateTemplateDto', () => {
    it('takes every field optional, and null for the description and the subject', async () => {
      expect((await check(UpdateTemplateDto, {})).refused).toEqual([]);
      const cleared = await check(UpdateTemplateDto, { description: null, subjectId: null });
      expect(cleared.refused).toEqual([]);
      expect(cleared.dto.description).toBeNull();
      expect(cleared.dto.subjectId).toBeNull();
      expect((await check(UpdateTemplateDto, { title: ' Ny ', active: false })).dto).toMatchObject({ title: 'Ny', active: false });
    });

    it('leaves a blank description out, which is no change; null is what clears it', async () => {
      const { dto, refused } = await check(UpdateTemplateDto, { description: '  ' });
      expect(refused).toEqual([]);
      expect(dto.description).toBeUndefined();
    });

    it('refuses what is not valid when it is named', async () => {
      expect((await check(UpdateTemplateDto, { title: '' })).refused).toEqual(['title']);
      expect((await check(UpdateTemplateDto, { title: repeat(121) })).refused).toEqual(['title']);
      expect((await check(UpdateTemplateDto, { description: repeat(2001) })).refused).toEqual(['description']);
      expect((await check(UpdateTemplateDto, { subjectId: 'slöjd' })).refused).toEqual(['subjectId']);
      expect((await check(UpdateTemplateDto, { active: 'yes' })).refused).toEqual(['active']);
      expect((await check(UpdateTemplateDto, { schoolId: ID })).refused).toEqual(['schoolId']);
    });

    it('refuses a null title and a null switch (a required column cannot be cleared: that was a 500), while a null description or subject clears', async () => {
      expect((await check(UpdateTemplateDto, { title: null })).refused).toEqual(['title']);
      expect((await check(UpdateTemplateDto, { active: null })).refused).toEqual(['active']);
      expect((await check(UpdateTemplateDto, { description: null, subjectId: null })).refused).toEqual([]);
    });
  });

  describe('the queries', () => {
    it.each([
      ['true', true],
      [true, true],
      ['false', false],
      [false, false],
      ['1', false],
      ['yes', false],
    ])('reads includeRetired=%p as %p, and includeClosed alike', async (given, expected) => {
      expect((await check(TemplatesQueryDto, { includeRetired: given })).dto.includeRetired).toBe(expected);
      expect((await check(ConsentListsQueryDto, { includeClosed: given })).dto.includeClosed).toBe(expected);
    });

    it('leaves them out when they are not given', async () => {
      expect((await check(TemplatesQueryDto, {})).dto.includeRetired).toBeUndefined();
      expect((await check(ConsentListsQueryDto, {})).refused).toEqual([]);
    });

    it('refuses a class that is not an id, a group that is not an id or is missing, and a parameter it does not know', async () => {
      expect((await check(ConsentListsQueryDto, { classId: '7A' })).refused).toEqual(['classId']);
      expect((await check(ConsentListsQueryDto, { classId: ID })).refused).toEqual([]);
      expect((await check(ConsentListsQueryDto, { closed: 'true' })).refused).toEqual(['closed']);
      expect((await check(TemplatesQueryDto, { retired: 'true' })).refused).toEqual(['retired']);
      expect((await check(RosterQueryDto, {})).refused).toEqual(['groupId']);
      expect((await check(RosterQueryDto, { groupId: '7A' })).refused).toEqual(['groupId']);
      expect((await check(RosterQueryDto, { groupId: ID })).refused).toEqual([]);
    });
  });

  describe('TickProofsDto', () => {
    const ok = { templateId: ID, studentIds: [ID] };

    it('takes the template and the pupils, and nothing else', async () => {
      const { dto, refused } = await check(TickProofsDto, ok);
      expect(refused).toEqual([]);
      expect(dto.instructedOn).toBeUndefined();
    });

    it('takes 300 pupils and not 301, and not none', async () => {
      expect((await check(TickProofsDto, { ...ok, studentIds: ids(300) })).refused).toEqual([]);
      expect((await check(TickProofsDto, { ...ok, studentIds: ids(301) })).refused).toEqual(['studentIds']);
      expect((await check(TickProofsDto, { ...ok, studentIds: [] })).refused).toEqual(['studentIds']);
      expect((await check(TickProofsDto, { templateId: ID })).refused).toEqual(['studentIds']);
      expect((await check(TickProofsDto, { ...ok, studentIds: ID })).refused).toEqual(['studentIds']);
      expect((await check(TickProofsDto, { ...ok, studentIds: ['anna'] })).refused).toEqual(['studentIds']);
    });

    it('takes a day written yyyy-mm-dd and no other way (whether the day exists is the service’s)', async () => {
      expect((await check(TickProofsDto, { ...ok, instructedOn: '2026-11-03' })).refused).toEqual([]);
      expect((await check(TickProofsDto, { ...ok, instructedOn: '2026-02-30' })).refused).toEqual([]);
      for (const day of ['2026-1-1', '3/11/2026', '2026-11-03T10:00:00Z', ' 2026-11-03', '2026-11-03 ', '20261103', 5]) {
        expect((await check(TickProofsDto, { ...ok, instructedOn: day })).refused).toEqual(['instructedOn']);
      }
    });

    it('takes who gave it as an id, and a note of 500 characters and not 501, a blank one being none', async () => {
      expect((await check(TickProofsDto, { ...ok, instructorId: ID })).refused).toEqual([]);
      expect((await check(TickProofsDto, { ...ok, instructorId: 'ada' })).refused).toEqual(['instructorId']);
      expect((await check(TickProofsDto, { ...ok, note: repeat(500) })).refused).toEqual([]);
      expect((await check(TickProofsDto, { ...ok, note: repeat(501) })).refused).toEqual(['note']);
      expect((await check(TickProofsDto, { ...ok, note: '   ' })).dto.note).toBeUndefined();
      expect((await check(TickProofsDto, { ...ok, note: ' Grupp 2 ' })).dto.note).toBe('Grupp 2');
    });

    it('refuses a template that is not an id, and a field it does not know', async () => {
      expect((await check(TickProofsDto, { ...ok, templateId: 'cirkel' })).refused).toEqual(['templateId']);
      expect((await check(TickProofsDto, { ...ok, voided: true })).refused).toEqual(['voided']);
    });
  });

  describe('VoidProofDto', () => {
    it('trims the reason, and takes 300 characters and not 301, and not none', async () => {
      expect((await check(VoidProofDto, { reason: '  Fel elev  ' })).dto.reason).toBe('Fel elev');
      expect((await check(VoidProofDto, { reason: repeat(300) })).refused).toEqual([]);
      expect((await check(VoidProofDto, { reason: repeat(301) })).refused).toEqual(['reason']);
      expect((await check(VoidProofDto, { reason: '   ' })).refused).toEqual(['reason']);
      expect((await check(VoidProofDto, {})).refused).toEqual(['reason']);
    });
  });

  describe('CreateConsentListDto', () => {
    const ok = { classId: ID, title: 'Fotografering', body: 'Text' };

    it('trims the title and the text', async () => {
      const { dto, refused } = await check(CreateConsentListDto, { ...ok, title: ' T ', body: ' B ' });
      expect(refused).toEqual([]);
      expect(dto).toMatchObject({ title: 'T', body: 'B' });
    });

    it('takes a text of 1700 characters and not 1701, so that the request to the guardians fits Kvittens', async () => {
      expect((await check(CreateConsentListDto, { ...ok, body: repeat(1700) })).refused).toEqual([]);
      expect((await check(CreateConsentListDto, { ...ok, body: repeat(1701) })).refused).toEqual(['body']);
      expect((await check(CreateConsentListDto, { ...ok, body: '   ' })).refused).toEqual(['body']);
    });

    it('takes a title of 120 characters and not 121', async () => {
      expect((await check(CreateConsentListDto, { ...ok, title: repeat(120) })).refused).toEqual([]);
      expect((await check(CreateConsentListDto, { ...ok, title: repeat(121) })).refused).toEqual(['title']);
    });

    it('refuses a missing class, a class that is not an id, and a field it does not know', async () => {
      expect((await check(CreateConsentListDto, { title: 'T', body: 'B' })).refused).toEqual(['classId']);
      expect((await check(CreateConsentListDto, { ...ok, classId: '7A' })).refused).toEqual(['classId']);
      expect((await check(CreateConsentListDto, { ...ok, closedAt: '2026-01-01' })).refused).toEqual(['closedAt']);
    });
  });

  describe('RecordConsentDto', () => {
    const ok = { studentIds: [ID], kind: 'GRANTED' };

    it.each(['GRANTED', 'DECLINED', 'WITHDRAWN'])('takes the kind %s', async (kind) => {
      expect((await check(RecordConsentDto, { ...ok, kind })).refused).toEqual([]);
    });

    it('refuses a kind it does not know, in another case, or none', async () => {
      expect((await check(RecordConsentDto, { ...ok, kind: 'MAYBE' })).refused).toEqual(['kind']);
      expect((await check(RecordConsentDto, { ...ok, kind: 'granted' })).refused).toEqual(['kind']);
      expect((await check(RecordConsentDto, { studentIds: [ID] })).refused).toEqual(['kind']);
    });

    it('takes 300 pupils and not 301, and not none', async () => {
      expect((await check(RecordConsentDto, { ...ok, studentIds: ids(300) })).refused).toEqual([]);
      expect((await check(RecordConsentDto, { ...ok, studentIds: ids(301) })).refused).toEqual(['studentIds']);
      expect((await check(RecordConsentDto, { ...ok, studentIds: [] })).refused).toEqual(['studentIds']);
      expect((await check(RecordConsentDto, { kind: 'GRANTED' })).refused).toEqual(['studentIds']);
    });

    it('takes a day written yyyy-mm-dd, who gave it in 120 characters, and a note of 300', async () => {
      expect((await check(RecordConsentDto, { ...ok, givenOn: '2026-10-15', givenBy: repeat(120), note: repeat(300) })).refused).toEqual([]);
      expect((await check(RecordConsentDto, { ...ok, givenOn: '15/10/2026' })).refused).toEqual(['givenOn']);
      expect((await check(RecordConsentDto, { ...ok, givenBy: repeat(121) })).refused).toEqual(['givenBy']);
      expect((await check(RecordConsentDto, { ...ok, note: repeat(301) })).refused).toEqual(['note']);
    });

    it('trims who gave it and the note, and a blank one is none', async () => {
      const { dto } = await check(RecordConsentDto, { ...ok, givenBy: ' Mamma ', note: '  ' });
      expect(dto.givenBy).toBe('Mamma');
      expect(dto.note).toBeUndefined();
    });

    it('refuses a field it does not know, such as a source', async () => {
      expect((await check(RecordConsentDto, { ...ok, source: 'KVITTENS' })).refused).toEqual(['source']);
    });
  });

  describe('AskConsentDto', () => {
    it('takes no pupils, which is every pupil with no answer', async () => {
      const { dto, refused } = await check(AskConsentDto, {});
      expect(refused).toEqual([]);
      expect(dto.studentIds).toBeUndefined();
    });

    it('takes 2000 pupils and not 2001, and not an empty list', async () => {
      expect((await check(AskConsentDto, { studentIds: ids(2000) })).refused).toEqual([]);
      expect((await check(AskConsentDto, { studentIds: ids(2001) })).refused).toEqual(['studentIds']);
      expect((await check(AskConsentDto, { studentIds: [] })).refused).toEqual(['studentIds']);
      expect((await check(AskConsentDto, { studentIds: ['anna'] })).refused).toEqual(['studentIds']);
    });

    it('refuses a rule or a title of its own: the request is the list’s, with the rule ALL', async () => {
      expect((await check(AskConsentDto, { rule: 'ANY' })).refused).toEqual(['rule']);
      expect((await check(AskConsentDto, { title: 'Ett eget' })).refused).toEqual(['title']);
    });
  });
});
