import { Ss12000SourceError, sourceErrorCode, sqlStateOf } from './errors';

describe('the module\'s errors', () => {
  it('answers a source error by its code and anything else as SS12000_UNEXPECTED, never by a message', () => {
    expect(sourceErrorCode(new Ss12000SourceError('SS12000_HTTP_404', 404))).toBe('SS12000_HTTP_404');
    expect(sourceErrorCode(new Error('the provider said: secret=abc'))).toBe('SS12000_UNEXPECTED');
    expect(new Ss12000SourceError('SS12000_TIMEOUT').message).toBe('SS12000_TIMEOUT');
  });

  it('reads a SQLSTATE from the adapter\'s cause, else from the rendered message', () => {
    expect(sqlStateOf({ meta: { driverAdapterError: { cause: { originalCode: '55P03' } } } })).toBe('55P03');
    expect(sqlStateOf({ message: 'Raw query failed. Code: `SS403`. Message: `refused`' })).toBe('SS403');
    expect(sqlStateOf({ message: 'nothing here' })).toBeUndefined();
    expect(sqlStateOf(null)).toBeUndefined();
    expect(sqlStateOf('55P03')).toBeUndefined();
  });
});
