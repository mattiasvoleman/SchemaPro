import { appIdentity, currentApp } from './appIdentity';

let mockExpoConfig: unknown = null;
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return mockExpoConfig;
    },
  },
}));

const RASTRA = { id: 'rastra', name: 'Rastra', otherName: 'Rastra vårdnadshavare' };
const GUARDIAN = { id: 'vardnadshavare', name: 'Rastra vårdnadshavare', otherName: 'Rastra' };

describe('appIdentity', () => {
  it('reads the build’s app from extra.app, and its label from the name under the icon', () => {
    mockExpoConfig = { name: 'Rastra', extra: { app: RASTRA, eas: { projectId: 'p' } } };
    expect(appIdentity()).toEqual({ ...RASTRA, label: 'Rastra' });
    expect(currentApp()).toBe('rastra');
    mockExpoConfig = { name: 'Rastra vårdnadshavare Test', extra: { app: GUARDIAN } };
    expect(appIdentity()).toEqual({ ...GUARDIAN, label: 'Rastra vårdnadshavare Test' });
    expect(currentApp()).toBe('vardnadshavare');
  });

  it('falls back to the store name when the config has no name', () => {
    mockExpoConfig = { extra: { app: GUARDIAN } };
    expect(appIdentity()?.label).toBe('Rastra vårdnadshavare');
  });

  it.each([
    ['no config', null],
    ['no extra', {}],
    ['no app', { extra: { eas: { projectId: 'p' } } }],
    ['the app as a bare id', { extra: { app: 'rastra' } }],
    ['an unknown app', { extra: { app: { ...RASTRA, id: 'schemapro' } } }],
    ['a differently cased one', { extra: { app: { ...RASTRA, id: 'Rastra' } } }],
    ['no names', { extra: { app: { id: 'rastra' } } }],
  ])('is null for %s, so the gate admits nobody', (_case, config) => {
    mockExpoConfig = config;
    expect(appIdentity()).toBeNull();
    expect(currentApp()).toBeNull();
  });
});
