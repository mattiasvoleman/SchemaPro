import { getAccessToken, getSupabase } from './supabase';
import { ApiError } from './api';
import { childListState, fetchChildren, scheduleChildren } from './children';

jest.mock('./supabase', () => ({ getAccessToken: jest.fn(), getSupabase: jest.fn() }));

/**
 * A guardian's children, through the real gateway client against a stubbed
 * fetch: what is pinned is the request the gateway receives, which reads the
 * links of the bearer's own guardian and records the read (Läslogg). Supabase
 * fails the test if asked; the app read GuardianStudents and the children's
 * Users rows itself until the read log needed every such read to pass the
 * gateway.
 */

const fetchMock = jest.fn();
const answer = (status: number, body?: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

beforeEach(() => {
  process.env['EXPO_PUBLIC_API_BASE_URL'] = 'https://api.example.test/';
  Object.defineProperty(global, 'fetch', { value: fetchMock, writable: true, configurable: true });
  fetchMock.mockReset();
  (getAccessToken as jest.Mock).mockResolvedValue('jwt-guardian');
  (getSupabase as jest.Mock).mockImplementation(() => {
    throw new Error('A guardian’s children are the gateway’s to answer, and to log.');
  });
});

describe('fetchChildren', () => {
  it('asks the gateway for the signed-in guardian’s children, and orders them Swedishly', async () => {
    // The gateway orders by link id: stable, and meaningless to a reader.
    fetchMock.mockResolvedValue(
      answer(200, [
        { linkId: 'link-1', id: 'c-2', firstName: 'Örjan', lastName: 'Elev', isActive: true, studentGroupId: 'g-7a' },
        { linkId: 'link-2', id: 'c-1', firstName: 'Åsa', lastName: 'Elev', isActive: true, studentGroupId: null },
        { linkId: 'link-3', id: 'c-4', firstName: 'Bo', lastName: 'Öberg', isActive: true, studentGroupId: null },
        { linkId: 'link-4', id: 'c-3', firstName: 'Bo', lastName: 'Andersson', isActive: false, studentGroupId: null },
      ]),
    );
    const children = await fetchChildren();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/api/v1/family/children', {
      method: 'GET',
      headers: { 'X-SchemaPro-Client': 'app', Authorization: 'Bearer jwt-guardian' },
    });
    expect(children.map((child) => `${child.firstName} ${child.lastName}`)).toEqual([
      'Bo Andersson',
      'Bo Öberg',
      'Åsa Elev',
      'Örjan Elev',
    ]);
    // A ChildRow, as the screens draw it: the group id is not carried along.
    expect(children[3]).toEqual({ linkId: 'link-1', id: 'c-2', firstName: 'Örjan', lastName: 'Elev', isActive: true });
    expect(getSupabase).not.toHaveBeenCalled();
  });

  it('answers no links with no children', async () => {
    fetchMock.mockResolvedValue(answer(200, []));
    await expect(fetchChildren()).resolves.toEqual([]);
  });

  it('throws the gateway’s refusal as it came, so the screen says a failure and not "no children"', async () => {
    fetchMock.mockResolvedValue(answer(403, { message: 'Forbidden resource' }));
    const error = await fetchChildren().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, message: 'Forbidden resource' });
  });
});

describe('the schedule tab’s children', () => {
  const child = (id: string, isActive: boolean) => ({ linkId: `l-${id}`, id, firstName: id, lastName: 'Elev', isActive });

  it('offers only children still at school: the gateway answers a departed pupil’s week with 404', () => {
    expect(scheduleChildren([child('a', false), child('b', true)]).map((c) => c.id)).toEqual(['b']);
  });

  it('says a failed read as a failure the reader can retry, never as "no children linked"', () => {
    expect(childListState({ loading: true, failed: false, count: 0 })).toBe('LOADING');
    expect(childListState({ loading: false, failed: true, count: 0 })).toBe('FAILED');
    expect(childListState({ loading: false, failed: false, count: 0 })).toBe('NONE');
    expect(childListState({ loading: false, failed: false, count: 2 })).toBe('READY');
    // A refresh that fails keeps the children already on screen.
    expect(childListState({ loading: false, failed: true, count: 2 })).toBe('READY');
  });
});
