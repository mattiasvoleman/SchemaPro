import { en } from './en';
import { translatorFor } from './index';
import { sv } from './sv';
import { translate, type Messages } from './translate';

describe('translate', () => {
  const messages = sv as unknown as Messages;

  it('reads a nested key and fills its placeholders', () => {
    expect(translate(messages, 'childSchedule.title', { name: 'Alva' })).toBe('Schema för Alva');
    expect(translate(messages, 'attendance.recorded', { done: 3, total: 25 })).toBe('3 av 25 registrerade');
  });

  it('picks _one for exactly one and _other otherwise, in both languages', () => {
    expect(translate(messages, 'notifications.unread', { count: 1 })).toBe('1 oläst');
    expect(translate(messages, 'notifications.unread', { count: 0 })).toBe('0 olästa');
    expect(translate(messages, 'notifications.unread', { count: 2 })).toBe('2 olästa');
    expect(translate(en, 'attendance.incompleteBody', { count: 1 })).toMatch(/^1 student still needs/);
    expect(translate(en, 'attendance.incompleteBody', { count: 4 })).toMatch(/^4 students still need/);
  });

  it('answers a missing key with the key, and leaves an unfilled placeholder as written', () => {
    expect(translate(messages, 'no.such.key')).toBe('no.such.key');
    expect(translate(messages, 'childSchedule.title', {})).toBe('Schema för {name}');
    expect(translate(messages, 'childSchedule')).toBe('childSchedule');
  });

  it('never reads a placeholder off Object.prototype', () => {
    expect(translate(messages, 'childSchedule.title', { other: 'x' })).toBe('Schema för {name}');
  });

  it('binds a language for code outside React', () => {
    expect(translatorFor('sv')('tabs.settings')).toBe('Inställningar');
    expect(translatorFor('en')('tabs.settings')).toBe('Settings');
  });
});
