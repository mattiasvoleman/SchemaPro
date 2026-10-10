import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestTls } from './test-tls';

/**
 * A local SS12000 2.1.0 provider for the consumer's tests — never a real IST
 * or Edlevo host. node:https on 127.0.0.1 with the test CA (test-tls.ts),
 * no dependency.
 *
 * It speaks S1 (SIS TK450, openapi_ss12000_version2_1_0.yaml) as the consumer
 * uses it: GET /organisations[/{id}], /persons (relationship.organisation,
 * relationship.entity.type enrolment | duty | responsibleFor.enrolment,
 * relationship.endDate.onOrAfter, meta.modified.after), /groups
 * (organisation[], groupType[], endDate.onOrAfter, meta.modified.after),
 * /duties (organisation, endDate.onOrAfter, meta.modified.after),
 * /deletedEntities (after, entities[]) and POST /persons/lookup {ids} — the
 * last answering S1's bare PersonsExpandedArray. Lists page for real: the
 * first request carries the filters and `limit`, the next ones `pageToken`
 * (opaque) and `limit` only; a pageToken WITH another filter is a 400, as S1
 * says. A token endpoint does OAuth2 client credentials, Basic or form, as
 * IST's does.
 *
 * Scripted faults (`faults`), each a test: a 401 once (the token refresh),
 * 429 with Retry-After, 503, 500, a slow answer, truncated JSON, an oversized
 * body, a redirect to another host, a page loop, 400 to meta.modified.after,
 * to responsibleFor.enrolment and to the lookup. And on purpose: the token
 * endpoint's refusal ECHOES the client secret it was sent, so a test can
 * assert that nothing the far side says reaches a response, a run row or a
 * log line.
 */

export type Json = Record<string, unknown>;

export interface MockWorld {
  organisations: Json[];
  persons: Json[];
  groups: Json[];
  duties: Json[];
  deleted: { persons: string[]; groups: string[]; duties: string[] };
}

export interface MockFaults {
  unauthorizedOnce?: boolean;
  tooManyOnce?: { retryAfterSeconds?: number };
  unavailableTimes?: number;
  serverError?: boolean;
  slowMs?: number;
  truncatedJson?: boolean;
  oversizedBytes?: number;
  redirect?: boolean;
  pageLoop?: boolean;
  refuseModifiedAfter?: boolean;
  refuseResponsibleFor?: boolean;
  refuseLookup?: boolean;
  /** /persons answers no one at all (a scope changed at the provider). */
  emptyPersons?: boolean;
}

export interface MockRequest {
  method: string;
  path: string;
  query: Array<[string, string]>;
  authorization: string | undefined;
  clientCertificate: boolean;
}

export const MOCK_BASE_PATH = '/ss12000v2-api/source/SE00100/v2.0';

export class MockSs12000Provider {
  world: MockWorld = { organisations: [], persons: [], groups: [], duties: [], deleted: { persons: [], groups: [], duties: [] } };
  faults: MockFaults = {};
  readonly requests: MockRequest[] = [];
  tokensIssued = 0;
  private server: Server | null = null;
  private readonly tokens = new Set<string>();
  private readonly pages = new Map<string, { items: unknown[]; offset: number }>();
  port = 0;

  constructor(
    private readonly tls: TestTls,
    readonly client: { id: string; secret: string },
    private readonly options: { requireClientCert?: boolean; staticBearer?: string } = {},
  ) {}

  get baseUrl(): string {
    return `https://127.0.0.1:${this.port}${MOCK_BASE_PATH}`;
  }

  get tokenUrl(): string {
    return `https://127.0.0.1:${this.port}/connect/token`;
  }

  async start(): Promise<void> {
    this.server = createServer(
      {
        cert: this.tls.serverCert,
        key: this.tls.serverKey,
        ca: this.tls.ca,
        requestCert: this.options.requireClientCert === true,
        rejectUnauthorized: this.options.requireClientCert === true,
      },
      (req, res) => void this.handle(req, res),
    );
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  dataRequests(path?: string): MockRequest[] {
    return this.requests.filter((r) => r.path.startsWith(MOCK_BASE_PATH) && (!path || r.path === `${MOCK_BASE_PATH}${path}`));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `https://127.0.0.1:${this.port}`);
    const body = await readBody(req);
    const socket = req.socket as { authorized?: boolean; getPeerCertificate?: () => { subject?: unknown } };
    this.requests.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      query: [...url.searchParams.entries()],
      authorization: req.headers.authorization,
      clientCertificate: Boolean(socket.authorized),
    });
    if (url.pathname === '/connect/token') return this.token(req, body, res);
    if (!url.pathname.startsWith(MOCK_BASE_PATH)) return send(res, 404, null);

    const auth = req.headers.authorization ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!this.tokens.has(bearer) && bearer !== this.options.staticBearer) return send(res, 401, { code: 'UNAUTHENTICATED', message: 'no' });
    if (this.faults.unauthorizedOnce) {
      this.faults.unauthorizedOnce = false;
      this.tokens.delete(bearer);
      return send(res, 401, { code: 'UNAUTHENTICATED', message: 'expired' });
    }
    if (this.faults.tooManyOnce) {
      const { retryAfterSeconds } = this.faults.tooManyOnce;
      this.faults.tooManyOnce = undefined;
      res.setHeader('retry-after', String(retryAfterSeconds ?? 0));
      return send(res, 429, { code: 'TOO_MANY', message: 'slow down' });
    }
    if ((this.faults.unavailableTimes ?? 0) > 0) {
      this.faults.unavailableTimes! -= 1;
      return send(res, 503, { code: 'TOO_LARGE', message: 'Svaret är förstort' });
    }
    if (this.faults.serverError) return send(res, 500, { code: 'ERROR', message: 'boom' });
    if (this.faults.slowMs) await new Promise((resolve) => setTimeout(resolve, this.faults.slowMs).unref());
    if (this.faults.redirect) {
      res.setHeader('location', 'https://example.invalid/steal');
      return send(res, 302, null);
    }
    if (this.faults.truncatedJson) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end('{"data": [');
    }
    if (this.faults.oversizedBytes) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(`{"data": [], "pad": "${'x'.repeat(this.faults.oversizedBytes)}"}`);
    }

    const path = url.pathname.slice(MOCK_BASE_PATH.length);
    const q = url.searchParams;
    if (req.method === 'POST' && path === '/persons/lookup') {
      if (this.faults.refuseLookup) return send(res, 403, { code: 'FORBIDDEN', message: 'no lookup' });
      const ids = new Set(((JSON.parse(body || '{}') as { ids?: string[] }).ids ?? []).map((id) => id.toLowerCase()));
      return send(res, 200, this.world.persons.filter((p) => ids.has(String(p['id']).toLowerCase())));
    }
    if (req.method !== 'GET') return send(res, 405, null);

    const organisation = /^\/organisations\/([^/]+)$/.exec(path);
    if (organisation) {
      const found = this.world.organisations.find((o) => o['id'] === decodeURIComponent(organisation[1]!));
      return found ? send(res, 200, found) : send(res, 404, null);
    }

    if (q.has('pageToken')) {
      if ([...q.keys()].some((key) => key !== 'pageToken' && key !== 'limit')) {
        return send(res, 400, { code: 'INVALID_FILTER', message: 'pageToken with a filter' });
      }
      const state = this.pages.get(q.get('pageToken')!);
      if (!state) return send(res, 400, { code: 'INVALID_FILTER', message: 'unknown pageToken' });
      return this.page(res, state.items, state.offset, Number(q.get('limit') ?? 1000), q.get('pageToken')!);
    }

    if (q.has('meta.modified.after') && this.faults.refuseModifiedAfter) {
      return send(res, 400, { code: 'INVALID_FILTER', message: 'meta.modified.after' });
    }
    const after = q.get('meta.modified.after');
    const changed = (item: Json) => !after || String((item['meta'] as Json | undefined)?.['modified'] ?? '') > after;
    const limit = Number(q.get('limit') ?? 1000);

    switch (path) {
      case '/organisations': {
        const types = q.getAll('type');
        return this.page(res, this.world.organisations.filter((o) => types.length === 0 || types.includes(String(o['organisationType']))), 0, limit);
      }
      case '/persons': {
        if (this.faults.emptyPersons) return this.page(res, [], 0, limit);
        const type = q.get('relationship.entity.type');
        const org = q.get('relationship.organisation');
        const onOrAfter = q.get('relationship.endDate.onOrAfter');
        if (type === 'responsibleFor.enrolment' && this.faults.refuseResponsibleFor) {
          return send(res, 400, { code: 'INVALID_FILTER', message: 'responsibleFor.enrolment' });
        }
        const open = (end: unknown) => !onOrAfter || end === undefined || end === null || String(end) >= onOrAfter;
        const enrolled = (p: Json) =>
          ((p['enrolments'] as Json[] | undefined) ?? []).some((e) => (e['enroledAt'] as Json)['id'] === org && open(e['endDate']));
        let items: Json[];
        if (type === 'enrolment') items = this.world.persons.filter(enrolled);
        else if (type === 'duty') {
          const holders = new Set(
            this.world.duties.filter((d) => (d['dutyAt'] as Json)['id'] === org && open(d['endDate'])).map((d) => (d['person'] as Json | undefined)?.['id']),
          );
          items = this.world.persons.filter((p) => holders.has(p['id']));
        } else if (type === 'responsibleFor.enrolment') {
          const guardians = new Set(
            this.world.persons.filter(enrolled).flatMap((p) => ((p['responsibles'] as Json[] | undefined) ?? []).map((r) => (r['person'] as Json)['id'])),
          );
          items = this.world.persons.filter((p) => guardians.has(p['id']));
        } else items = this.world.persons;
        return this.page(res, items.filter(changed), 0, limit);
      }
      case '/groups': {
        const orgs = q.getAll('organisation');
        const types = q.getAll('groupType');
        const onOrAfter = q.get('endDate.onOrAfter');
        const items = this.world.groups.filter(
          (g) =>
            (orgs.length === 0 || orgs.includes(String((g['organisation'] as Json)['id']))) &&
            (types.length === 0 || types.includes(String(g['groupType']))) &&
            (!onOrAfter || g['endDate'] === undefined || String(g['endDate']) >= onOrAfter) &&
            changed(g),
        );
        return this.page(res, items, 0, limit);
      }
      case '/duties': {
        const org = q.get('organisation');
        const onOrAfter = q.get('endDate.onOrAfter');
        const items = this.world.duties.filter(
          (d) =>
            (!org || (d['dutyAt'] as Json)['id'] === org) &&
            (!onOrAfter || d['endDate'] === undefined || String(d['endDate']) >= onOrAfter) &&
            changed(d),
        );
        return this.page(res, items, 0, limit);
      }
      case '/deletedEntities': {
        const entities = q.getAll('entities');
        const data: Json = {};
        if (entities.includes('Person')) data['persons'] = this.world.deleted.persons;
        if (entities.includes('Group')) data['groups'] = this.world.deleted.groups;
        if (entities.includes('Duty')) data['duties'] = this.world.deleted.duties;
        return send(res, 200, { data, pageToken: null });
      }
      default:
        return send(res, 404, null);
    }
  }

  private page(res: ServerResponse, items: unknown[], offset: number, limit: number, previous?: string): void {
    const slice = items.slice(offset, offset + limit);
    let pageToken: string | null = null;
    if (this.faults.pageLoop && previous) pageToken = previous;
    else if (this.faults.pageLoop) {
      pageToken = randomBytes(8).toString('hex');
      this.pages.set(pageToken, { items, offset });
    } else if (offset + limit < items.length) {
      pageToken = randomBytes(8).toString('hex');
      this.pages.set(pageToken, { items, offset: offset + limit });
    }
    send(res, 200, { data: slice, pageToken });
  }

  private token(req: IncomingMessage, body: string, res: ServerResponse): void {
    const form = new URLSearchParams(body);
    let id = form.get('client_id');
    let secret = form.get('client_secret');
    const auth = req.headers.authorization;
    if (auth?.startsWith('Basic ')) {
      const [rawId, rawSecret] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
      id = decodeURIComponent(rawId ?? '');
      secret = decodeURIComponent(rawSecret ?? '');
    }
    if (form.get('grant_type') !== 'client_credentials' || id !== this.client.id || secret !== this.client.secret) {
      // Echoes what it was sent, secret included, as a careless server would.
      return send(res, 400, { error: 'invalid_client', error_description: `unknown client ${id} with secret ${secret}` });
    }
    const token = `mock-token-${randomBytes(12).toString('hex')}`;
    this.tokens.add(token);
    this.tokensIssued++;
    send(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 3600 });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (body === null) {
    res.writeHead(status, { date: new Date().toUTCString() });
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', date: new Date().toUTCString() });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// S1-shaped fixtures
// ---------------------------------------------------------------------------

/** A day relative to today (UTC), so the fixtures stay current whenever the suite runs. */
export function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

const META = { created: '2026-08-01T08:00:00+02:00', modified: '2026-08-01T08:00:00+02:00' };

export function s1Organisation(id: string, displayName: string, schoolUnitCode = '12345678'): Json {
  return { id, meta: META, displayName, organisationType: 'Skolenhet', schoolUnitCode, schoolTypes: ['GR'] };
}

export function s1Pupil(
  id: string,
  given: string,
  family: string,
  email: string,
  organisationId: string,
  options: { schoolYear?: number; startDate?: string; endDate?: string; responsibles?: Array<{ id: string; relationType?: string; securityMarking?: string }>; securityMarking?: string; modified?: string } = {},
): Json {
  return {
    id,
    meta: { ...META, modified: options.modified ?? META.modified },
    givenName: given,
    familyName: family,
    // Present at the source, never kept by the consumer.
    civicNo: { value: '201001012384', nationality: 'SE' },
    birthDate: '2010-01-01',
    sex: 'Kvinna',
    addresses: [{ type: 'Folkbokföring', streetAddress: 'Hemliga vägen 1', postalCode: '11111', locality: 'Ort' }],
    phoneNumbers: [{ value: '070-0000000', type: 'Mobil' }],
    securityMarking: options.securityMarking ?? 'Ingen',
    personStatus: 'Aktiv',
    emails: [{ value: email, type: 'Skola elev' }],
    enrolments: [
      {
        enroledAt: { id: organisationId },
        schoolYear: options.schoolYear ?? 7,
        schoolType: 'GR',
        startDate: options.startDate ?? isoDay(-60),
        ...(options.endDate ? { endDate: options.endDate } : {}),
      },
    ],
    responsibles: (options.responsibles ?? []).map((r) => ({
      person: { id: r.id, ...(r.securityMarking ? { securityMarking: r.securityMarking } : {}) },
      relationType: r.relationType ?? 'Vårdnadshavare',
    })),
  };
}

export function s1Adult(id: string, given: string, family: string, email: string, emailType: 'Privat' | 'Skola personal', modified?: string): Json {
  return {
    id,
    meta: { ...META, modified: modified ?? META.modified },
    givenName: given,
    familyName: family,
    civicNo: { value: '198001012381' },
    securityMarking: 'Ingen',
    personStatus: 'Aktiv',
    emails: [{ value: email, type: emailType }],
  };
}

export function s1Group(
  id: string,
  displayName: string,
  groupType: 'Klass' | 'Undervisning',
  organisationId: string,
  members: string[],
  options: { startDate?: string; endDate?: string; modified?: string } = {},
): Json {
  return {
    id,
    meta: { ...META, modified: options.modified ?? META.modified },
    displayName,
    startDate: options.startDate ?? isoDay(-60),
    ...(options.endDate !== undefined ? { endDate: options.endDate } : { endDate: isoDay(200) }),
    groupType,
    schoolType: 'GR',
    organisation: { id: organisationId },
    groupMemberships: members.map((personId) => ({ person: { id: personId }, startDate: options.startDate ?? isoDay(-60) })),
  };
}

export function s1Duty(id: string, personId: string, organisationId: string, dutyRole = 'Lärare', options: { endDate?: string; modified?: string } = {}): Json {
  return {
    id,
    meta: { ...META, modified: options.modified ?? META.modified },
    person: { id: personId },
    dutyAt: { id: organisationId },
    dutyRole,
    // HR figures at the source, never read into storage.
    dutyPercent: 80,
    hoursPerYear: 1440,
    signature: 'ABCD',
    startDate: isoDay(-70),
    ...(options.endDate ? { endDate: options.endDate } : {}),
  };
}
