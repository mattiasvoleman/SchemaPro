import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AckController } from '../ack/ack.controller';
import { AREA_KEY } from '../auth/decorators/area.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { testUser } from '../../test/utils/prisma-mock';
import { ChecklistsController } from './checklists.controller';

const user = testUser({ schoolId: 'school-1', userId: 'teacher-1', role: 'TEACHER' as never });
const ID = '44444444-4444-4444-8444-444444444444';

function setup() {
  const instructions = {
    templates: jest.fn(),
    createTemplate: jest.fn(),
    updateTemplate: jest.fn(),
    groups: jest.fn(),
    instructors: jest.fn(),
    roster: jest.fn(),
    tick: jest.fn(),
    voidProof: jest.fn(),
  };
  const consents = {
    settings: jest.fn(),
    lists: jest.fn(),
    createList: jest.fn(),
    detail: jest.fn(),
    record: jest.fn(),
    ask: jest.fn(),
    close: jest.fn(),
    student: jest.fn(),
  };
  const controller = new ChecklistsController(instructions as never, consents as never);
  return { instructions, consents, controller };
}

/** Each route hands what it was given to the service that owns it, and answers what that answers. */
describe('ChecklistsController', () => {
  describe('delegation', () => {
    it('settings asks the consent service', async () => {
      const { consents, controller } = setup();
      const answer = Promise.resolve({ kvittens: true });
      consents.settings.mockReturnValue(answer);
      expect(controller.settings(user)).toBe(answer);
      expect(consents.settings).toHaveBeenCalledWith(user);
    });

    it('templates leaves out the retired ones unless includeRetired is exactly true', () => {
      const { instructions, controller } = setup();
      instructions.templates.mockReturnValue('answer');
      expect(controller.templates({}, user)).toBe('answer');
      expect(instructions.templates).toHaveBeenLastCalledWith(user, false);
      controller.templates({ includeRetired: false }, user);
      expect(instructions.templates).toHaveBeenLastCalledWith(user, false);
      controller.templates({ includeRetired: true }, user);
      expect(instructions.templates).toHaveBeenLastCalledWith(user, true);
    });

    it('createTemplate and updateTemplate pass the body, the id and the caller', () => {
      const { instructions, controller } = setup();
      instructions.createTemplate.mockReturnValue('created');
      instructions.updateTemplate.mockReturnValue('updated');
      const dto = { title: 'Cirkelsågen' };
      expect(controller.createTemplate(dto, user)).toBe('created');
      expect(instructions.createTemplate).toHaveBeenCalledWith(dto, user);
      const patch = { active: false };
      expect(controller.updateTemplate(ID, patch, user)).toBe('updated');
      expect(instructions.updateTemplate).toHaveBeenCalledWith(ID, patch, user);
    });

    it('groups and instructors pass the caller', () => {
      const { instructions, controller } = setup();
      instructions.groups.mockReturnValue('groups');
      instructions.instructors.mockReturnValue('instructors');
      expect(controller.groups(user)).toBe('groups');
      expect(instructions.groups).toHaveBeenCalledWith(user);
      expect(controller.instructors(user)).toBe('instructors');
      expect(instructions.instructors).toHaveBeenCalledWith(user);
    });

    it('roster passes the template from the path and the group from the query', () => {
      const { instructions, controller } = setup();
      instructions.roster.mockReturnValue('roster');
      expect(controller.roster(ID, { groupId: 'g-1' }, user)).toBe('roster');
      // Exactly these three: the screen's roster is not the sheet for paper.
      expect(instructions.roster).toHaveBeenCalledWith(ID, 'g-1', user);
      expect(instructions.roster.mock.calls[0]).toHaveLength(3);
    });

    it('rosterForPaper asks for the same roster for paper', () => {
      const { instructions, controller } = setup();
      instructions.roster.mockReturnValue('sheet');
      expect(controller.rosterForPaper(ID, { groupId: 'g-1' }, user)).toBe('sheet');
      expect(instructions.roster).toHaveBeenCalledTimes(1);
      expect(instructions.roster).toHaveBeenCalledWith(ID, 'g-1', user, true);
    });

    it('tick and voidProof pass the body, the id and the caller', () => {
      const { instructions, controller } = setup();
      instructions.tick.mockReturnValue('ticked');
      instructions.voidProof.mockReturnValue('voided');
      const dto = { templateId: ID, studentIds: ['p-1'] };
      expect(controller.tick(dto, user)).toBe('ticked');
      expect(instructions.tick).toHaveBeenCalledWith(dto, user);
      expect(controller.voidProof(ID, { reason: 'Fel elev' }, user)).toBe('voided');
      expect(instructions.voidProof).toHaveBeenCalledWith(ID, { reason: 'Fel elev' }, user);
    });

    it('lists and createList pass the caller first for the query, and the body first for the new list', () => {
      const { consents, controller } = setup();
      consents.lists.mockReturnValue('lists');
      consents.createList.mockReturnValue('created');
      const query = { classId: 'c-1', includeClosed: true };
      expect(controller.lists(query, user)).toBe('lists');
      expect(consents.lists).toHaveBeenCalledWith(user, query);
      const dto = { classId: 'c-1', title: 'Fotografering', body: 'Text' };
      expect(controller.createList(dto, user)).toBe('created');
      expect(consents.createList).toHaveBeenCalledWith(dto, user);
    });

    it('detailForPaper asks for the same list for paper', () => {
      const { consents, controller } = setup();
      consents.detail.mockReturnValue('sheet');
      expect(controller.detailForPaper(ID, user)).toBe('sheet');
      expect(consents.detail).toHaveBeenCalledTimes(1);
      expect(consents.detail).toHaveBeenCalledWith(ID, user, true);
    });

    it('detail, record, ask, close and student pass the id and the caller', () => {
      const { consents, controller } = setup();
      for (const name of ['detail', 'record', 'ask', 'close', 'student'] as const) consents[name].mockReturnValue(name);
      expect(controller.detail(ID, user)).toBe('detail');
      // Exactly these two: the screen's list is not the sheet for paper.
      expect(consents.detail).toHaveBeenCalledWith(ID, user);
      expect(consents.detail.mock.calls[0]).toHaveLength(2);
      const entries = { studentIds: ['p-1'], kind: 'GRANTED' as const };
      expect(controller.record(ID, entries, user)).toBe('record');
      expect(consents.record).toHaveBeenCalledWith(ID, entries, user);
      expect(controller.ask(ID, { studentIds: ['p-1'] }, user)).toBe('ask');
      expect(consents.ask).toHaveBeenCalledWith(ID, { studentIds: ['p-1'] }, user);
      expect(controller.close(ID, user)).toBe('close');
      expect(consents.close).toHaveBeenCalledWith(ID, user);
      expect(controller.student(ID, user)).toBe('student');
      expect(consents.student).toHaveBeenCalledWith(ID, user);
    });
  });

  describe('routing', () => {
    const proto = ChecklistsController.prototype as unknown as Record<string, object>;
    const routeOf = (name: string) => `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, proto[name]!) as RequestMethod]} ${Reflect.getMetadata(PATH_METADATA, proto[name]!) as string}`;

    it('serves the routes under /api/v1/checklists', () => {
      expect(Reflect.getMetadata(PATH_METADATA, ChecklistsController)).toBe('api/v1/checklists');
      expect(
        ['settings', 'templates', 'createTemplate', 'updateTemplate', 'groups', 'instructors', 'roster', 'rosterForPaper', 'tick', 'voidProof', 'lists', 'createList', 'detail', 'detailForPaper', 'record', 'ask', 'close', 'student'].map(routeOf),
      ).toEqual([
        'GET settings',
        'GET templates',
        'POST templates',
        'PATCH templates/:id',
        'GET groups',
        'GET instructors',
        'GET templates/:id/roster',
        'GET templates/:id/roster/print',
        'POST proofs',
        'POST proofs/:id/void',
        'GET consent-lists',
        'POST consent-lists',
        'GET consent-lists/:id',
        'GET consent-lists/:id/print',
        'POST consent-lists/:id/entries',
        'POST consent-lists/:id/ask',
        'POST consent-lists/:id/close',
        'GET students/:id',
      ]);
    });

    it('answers 200 and not 201 where nothing is created: a void and a close', () => {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto['voidProof']!)).toBe(200);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto['close']!)).toBe(200);
      for (const route of ['createTemplate', 'tick', 'createList', 'record', 'ask']) {
        expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto[route]!)).toBeUndefined();
      }
    });
  });

  describe('who may', () => {
    const proto = ChecklistsController.prototype as unknown as Record<string, object>;

    it('is for teachers and administrators under Drift, nobody else', () => {
      expect(Reflect.getMetadata(ROLES_KEY, ChecklistsController)).toEqual([Role.SCHOOL_ADMIN, Role.TEACHER]);
      expect(Reflect.getMetadata(AREA_KEY, ChecklistsController)).toEqual({ kind: 'area', areas: ['DRIFT'] });
    });

    it('keeps the writing of templates to administrators, and names no other route’s roles of its own', () => {
      for (const route of ['createTemplate', 'updateTemplate']) expect(Reflect.getMetadata(ROLES_KEY, proto[route]!)).toEqual([Role.SCHOOL_ADMIN]);
      for (const route of ['settings', 'templates', 'groups', 'instructors', 'roster', 'rosterForPaper', 'tick', 'voidProof', 'lists', 'createList', 'detail', 'detailForPaper', 'record', 'ask', 'close', 'student']) {
        expect(Reflect.getMetadata(ROLES_KEY, proto[route]!)).toBeUndefined();
      }
    });
  });

  describe('throttling', () => {
    const proto = ChecklistsController.prototype as unknown as Record<string, object>;

    it.each([
      ['tick', 30],
      ['record', 30],
      ['ask', 5],
    ])('lets one caller call %s %i times a minute', (route, limit) => {
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', proto[route]!)).toBe(limit);
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', proto[route]!)).toBe(60_000);
    });

    it.each(['settings', 'templates', 'createTemplate', 'updateTemplate', 'groups', 'instructors', 'roster', 'rosterForPaper', 'voidProof', 'lists', 'createList', 'detail', 'detailForPaper', 'close', 'student'])(
      'leaves %s at the general limit',
      (route) => {
        expect(Reflect.getMetadata('THROTTLER:LIMITdefault', proto[route]!)).toBeUndefined();
      },
    );

    it('asks the guardians no faster than Kvittens lets a request be written', () => {
      // Checklistor's ask goes through Kvittens' create, which is five a minute.
      const ack = AckController.prototype as unknown as Record<string, object>;
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', proto['ask']!)).toBe(Reflect.getMetadata('THROTTLER:LIMITdefault', ack['create']!));
    });
  });
});
