import { DEMO, isDemoAddress, isReservedDomain, judgeDatabase, judgeDemoSchool, refusalText, type SchoolFacts } from './demo-guard';

/** The demo school as the seed makes it, as far as the guard looks: its name, its people at the demo's domain, and nothing tied to it. */
const demo = (overrides: Partial<SchoolFacts> = {}): SchoolFacts => ({
  slug: DEMO.slug,
  name: DEMO.name,
  emails: ['admin@demo-skola.example.com', 'anna.lindqvist@demo-skola.example.com', 'elsa.berg.7a@demo-skola.example.com'],
  huvudmanTies: 0,
  otherSchoolTies: 0,
  ...overrides,
});

describe('isDemoAddress', () => {
  it.each([
    'admin@demo-skola.example.com',
    'ADMIN@Demo-Skola.Example.COM',
    'a@demo-skola.example.com',
    'name+tag@demo-skola.example.com',
    'first.last@demo-skola.example.com',
  ])('is %s', (email) => {
    expect(isDemoAddress(email)).toBe(true);
  });

  it.each([
    ['another domain', 'anna@gmail.com'],
    ['a subdomain of the demo\'s', 'x@evil.demo-skola.example.com'],
    ['the demo\'s domain as a start', 'x@demo-skola.example.com.evil.org'],
    ['a domain that ends as the demo\'s does', 'x@xdemo-skola.example.com'],
    ['example.com itself', 'x@example.com'],
    ['no at', 'demo-skola.example.com'],
    ['nothing before the at', '@demo-skola.example.com'],
    ['two ats', 'a@b@demo-skola.example.com'],
    ['the domain in the local part', 'demo-skola.example.com@gmail.com'],
    ['an empty string', ''],
    ['a trailing space', 'x@demo-skola.example.com '],
    ['a trailing dot', 'x@demo-skola.example.com.'],
  ])('is not %s', (_label, email) => {
    expect(isDemoAddress(email)).toBe(false);
  });

  it('follows the domain it is given', () => {
    expect(isDemoAddress('x@probe.example.com', 'probe.example.com')).toBe(true);
    expect(isDemoAddress('x@demo-skola.example.com', 'probe.example.com')).toBe(false);
  });
});

describe('judgeDemoSchool', () => {
  it('lets the school the seed makes be reset', () => {
    expect(judgeDemoSchool(demo())).toBeNull();
  });

  it('refuses a school with the demo\'s slug and a real person: the name is what a person types, the address is not', () => {
    expect(judgeDemoSchool(demo({ emails: [...demo().emails, 'rektor@kommun.se'] }))).toEqual({ code: 'PEOPLE_OUTSIDE_THE_DEMO', count: 1 });
  });

  it('counts every person outside the demo, so that the refusal says how many and not who', () => {
    const facts = demo({ emails: ['admin@demo-skola.example.com', 'a@gmail.com', 'b@school.se', 'c@hotmail.com'] });
    expect(judgeDemoSchool(facts)).toEqual({ code: 'PEOPLE_OUTSIDE_THE_DEMO', count: 3 });
  });

  it('refuses a school whose people are all real, whatever it is called', () => {
    expect(judgeDemoSchool(demo({ emails: ['a@kommun.se', 'b@kommun.se'] }))).toEqual({ code: 'PEOPLE_OUTSIDE_THE_DEMO', count: 2 });
  });

  it.each([
    ['another slug', { slug: 'riktiga-skolan' }],
    ['another name', { name: 'Riktiga skolan' }],
    ['a name with another case', { name: 'demo skola' }],
    ['a slug with another case', { slug: 'Demo-Skola' }],
    ['both another', { slug: 'x', name: 'X' }],
  ] as Array<[string, Partial<SchoolFacts>]>)('refuses %s, before it looks at anybody', (_label, overrides) => {
    expect(judgeDemoSchool(demo({ ...overrides, emails: ['a@gmail.com'] }))).toEqual({ code: 'NOT_THE_DEMO_SCHOOL' });
  });

  it('refuses an empty school: nobody in it proves nothing', () => {
    expect(judgeDemoSchool(demo({ emails: [] }))).toEqual({ code: 'NO_PEOPLE' });
  });

  it('refuses a school a huvudman owns, asks for or has in its history', () => {
    expect(judgeDemoSchool(demo({ huvudmanTies: 3 }))).toEqual({ code: 'TIED_TO_A_HUVUDMAN', count: 3 });
  });

  it('refuses a school tied to another school, because a delete cascades to the other end: by one row as by two', () => {
    expect(judgeDemoSchool(demo({ otherSchoolTies: 1 }))).toEqual({ code: 'TIED_TO_ANOTHER_SCHOOL', count: 1 });
    expect(judgeDemoSchool(demo({ otherSchoolTies: 2 }))).toEqual({ code: 'TIED_TO_ANOTHER_SCHOOL', count: 2 });
  });

  it('gives the reasons in the order a person would ask them', () => {
    const everything = { slug: 'x', emails: ['a@gmail.com'], huvudmanTies: 1, otherSchoolTies: 1 };
    expect(judgeDemoSchool(demo(everything))).toEqual({ code: 'NOT_THE_DEMO_SCHOOL' });
    expect(judgeDemoSchool(demo({ ...everything, slug: DEMO.slug }))).toEqual({ code: 'PEOPLE_OUTSIDE_THE_DEMO', count: 1 });
    expect(judgeDemoSchool(demo({ huvudmanTies: 1, otherSchoolTies: 1 }))).toEqual({ code: 'TIED_TO_A_HUVUDMAN', count: 1 });
  });

  it('judges a school against the spec it is given, not the demo\'s', () => {
    const spec = { slug: 'probe-demo', name: 'Probe demo', domain: 'probe-demo.example.com' };
    const facts = { slug: 'probe-demo', name: 'Probe demo', emails: ['a@probe-demo.example.com'], huvudmanTies: 0, otherSchoolTies: 0 };
    expect(judgeDemoSchool(facts, spec)).toBeNull();
    expect(judgeDemoSchool(facts)).toEqual({ code: 'NOT_THE_DEMO_SCHOOL' });
    expect(judgeDemoSchool({ ...facts, emails: ['a@demo-skola.example.com'] }, spec)).toEqual({ code: 'PEOPLE_OUTSIDE_THE_DEMO', count: 1 });
  });
});

describe('isReservedDomain', () => {
  it.each([
    'example.com',
    'EXAMPLE.ORG',
    'example.net',
    'kommun.example.org',
    'demo-skola.example.com',
    'a.b.c.example.com',
    'school.test',
    'example.invalid',
    'hem.example',
    'db.localhost',
    'test',
    'invalid',
  ])('is %s', (domain) => {
    expect(isReservedDomain(domain)).toBe(true);
  });

  it.each([
    ['a real mail provider', 'gmail.com'],
    ['a school domain', 'skola.stockholm.se'],
    ['the reserved name as the start of another', 'example.com.evil.org'],
    ['the reserved name as the end of a word', 'notexample.com'],
    ['the reserved name with a prefix in the label', 'xexample.org'],
    ['example with another top domain', 'example.co'],
    ['example with a longer top domain', 'example.comm'],
    ['example as a name on a real top domain', 'example.se'],
    ['test as the start of a real domain', 'test.com'],
    ['a real domain ending in a reserved word', 'invalid.se'],
    ['an empty domain', ''],
    ['a domain with an empty label', 'a..example.com'],
    ['a trailing dot', 'example.com.'],
    ['a leading dot', '.example.com'],
    ['a top domain alone that is not reserved', 'com'],
  ])('is not %s', (_label, domain) => {
    expect(isReservedDomain(domain)).toBe(false);
  });
});

describe('judgeDatabase', () => {
  it('lets a demo school be made in a database with no school', () => {
    expect(judgeDatabase([])).toBeNull();
  });

  it('lets it be made where every school is a made-up one, however many there are', () => {
    expect(judgeDatabase([{ domains: ['demo-skola.example.com'] }, { domains: ['example.invalid', 'kommun.example.org'] }, { domains: ['x.test'] }])).toBeNull();
  });

  it('refuses a database with one school that has one person at a real address, and counts the schools and not the people', () => {
    expect(judgeDatabase([{ domains: ['demo-skola.example.com'] }, { domains: ['example.invalid', 'gmail.com'] }])).toEqual({ code: 'DATABASE_HAS_A_REAL_SCHOOL', count: 1 });
    expect(judgeDatabase([{ domains: ['gmail.com', 'hotmail.com'] }, { domains: ['kommun.se'] }, { domains: ['example.com'] }])).toEqual({ code: 'DATABASE_HAS_A_REAL_SCHOOL', count: 2 });
  });

  it('does not count a school with nobody in it: it holds no personal data', () => {
    expect(judgeDatabase([{ domains: [] }, { domains: ['example.com'] }])).toBeNull();
  });

  it('counts a look-alike as real', () => {
    expect(judgeDatabase([{ domains: ['example.com.evil.org'] }])).toEqual({ code: 'DATABASE_HAS_A_REAL_SCHOOL', count: 1 });
    expect(judgeDatabase([{ domains: [''] }])).toEqual({ code: 'DATABASE_HAS_A_REAL_SCHOOL', count: 1 });
  });
});

describe('refusalText', () => {
  it('names a count and never an address, a name or an id', () => {
    for (const refusal of [
      { code: 'NOT_THE_DEMO_SCHOOL' as const },
      { code: 'NO_PEOPLE' as const },
      { code: 'PEOPLE_OUTSIDE_THE_DEMO' as const, count: 1 },
      { code: 'PEOPLE_OUTSIDE_THE_DEMO' as const, count: 4 },
      { code: 'TIED_TO_A_HUVUDMAN' as const, count: 2 },
      { code: 'TIED_TO_ANOTHER_SCHOOL' as const, count: 1 },
      { code: 'DATABASE_HAS_A_REAL_SCHOOL' as const, count: 1 },
      { code: 'DATABASE_HAS_A_REAL_SCHOOL' as const, count: 2 },
    ]) {
      const text = refusalText(refusal);
      expect(text).toMatch(/[Ii]ngenting är (raderat|skapat)/);
      expect(text).not.toMatch(/[\w.+-]+@(?!demo-skola\.example\.com)[\w.-]+/);
    }
  });

  it('counts the schools of a database in the singular and the plural', () => {
    expect(refusalText({ code: 'DATABASE_HAS_A_REAL_SCHOOL', count: 1 })).toContain('1 skola med personer');
    expect(refusalText({ code: 'DATABASE_HAS_A_REAL_SCHOOL', count: 3 })).toContain('3 skolor med personer');
  });

  it('counts in the singular and the plural', () => {
    expect(refusalText({ code: 'PEOPLE_OUTSIDE_THE_DEMO', count: 1 })).toContain('1 person i skolan har');
    expect(refusalText({ code: 'PEOPLE_OUTSIDE_THE_DEMO', count: 4 })).toContain('4 personer i skolan har');
  });
});
