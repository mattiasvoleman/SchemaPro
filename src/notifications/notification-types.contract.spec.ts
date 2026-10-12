import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NEVER_EXTERNAL, NOTIFICATION_TYPES, TYPES_BY_ROLE } from './notification-types';
import type { NotificationKind } from './notifications.service';
import { PUSH_TEMPLATES, pushKindOf } from './push-messages';

/**
 * EVERY NOTICE TYPE, EVERYWHERE IT IS SHOWN.
 *
 * A type is one enum value and six places beyond the gateway's writer: the
 * migration that adds it, its push text in Swedish and English, the web
 * bell's and the app's inbox sentence, and its switch in both settings
 * lists, in both languages. None of them is reached by a call graph, and a
 * place left out fails quietly: the bell prints nothing, the app its generic
 * "Notis", the settings a raw key. Three types were added at once in
 * 20261018090000; this reads every place for every value of the enum.
 */

const ROOT = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const ENUM: string[] = (() => {
  const block = /enum NotificationType \{([^}]*)\}/.exec(read('prisma/schema.prisma'))![1]!;
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('///'));
})();

const OFFERED = [...new Set(Object.values(TYPES_BY_ROLE).flat())];

describe('notification types across the gateway, the web and the app', () => {
  it('the gateway knows exactly the enum, and a migration adds every value', () => {
    expect(ENUM.length).toBeGreaterThanOrEqual(12);
    expect([...NOTIFICATION_TYPES].sort()).toEqual([...ENUM].sort());
    const migrations = readdirSync(join(ROOT, 'prisma', 'migrations'))
      .filter((dir) => !dir.endsWith('.toml'))
      .map((dir) => read(`prisma/migrations/${dir}/migration.sql`))
      .filter((sql) => sql.includes('"NotificationType"'))
      .join('\n');
    for (const type of ENUM) expect([type, migrations.includes(`'${type}'`)]).toEqual([type, true]);
  });

  it.each(ENUM)('%s has a push text in Swedish and English, unless it never leaves the inbox', (type) => {
    const kind = type as NotificationKind;
    if (NEVER_EXTERNAL.has(kind)) {
      expect(pushKindOf(kind, {})).toBeNull();
      return;
    }
    for (const meta of [{}, { cover: true }, { reversed: true }]) {
      const pushKind = pushKindOf(kind, meta)!;
      expect(PUSH_TEMPLATES.sv[pushKind]).toBeDefined();
      expect(PUSH_TEMPLATES.en[pushKind]).toBeDefined();
    }
  });

  it.each(ENUM)('%s is a sentence in the web bell and in the app’s inbox', (type) => {
    const bell = read('web/components/layout/notification-bell.tsx');
    const app = read('mobile/src/services/notificationText.ts');
    expect(bell).toContain(`| "${type}"`);
    expect(bell).toContain(`case "${type}"`);
    expect(read('mobile/src/types/index.ts')).toContain(`| '${type}'`);
    expect(app).toContain(`case '${type}'`);
  });

  it.each(OFFERED)('%s has its switch labelled on the web and in the app, in both languages', (type) => {
    expect(read('web/lib/notification-preferences-queries.ts')).toContain(`| "${type}"`);
    for (const language of ['sv', 'en']) {
      const web = JSON.parse(read(`web/messages/${language}.json`)) as { notificationSettings: { types: Record<string, unknown> } };
      expect([language, typeof web.notificationSettings.types[type]]).toEqual([language, 'string']);
      expect(read(`mobile/src/i18n/${language}.ts`)).toMatch(new RegExp(`\\n\\s+${type}: '`));
    }
  });
});
