import { schemeOf } from './scheme';

describe('schemeOf', () => {
  it('draws dark only when the phone says dark', () => {
    expect(schemeOf('dark')).toBe('dark');
    expect(schemeOf('light')).toBe('light');
  });

  it('draws light when the phone has no preference or no answer', () => {
    expect(schemeOf('unspecified')).toBe('light');
    expect(schemeOf(null)).toBe('light');
    expect(schemeOf(undefined)).toBe('light');
  });
});
