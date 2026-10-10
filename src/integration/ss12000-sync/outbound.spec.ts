import { addressIsAllowed, originOf, v6Bytes, vetHost, vetSourceUrl } from './outbound';
import { Ss12000SourceError } from './errors';

const strict = { allowLoopback: false };

describe('outbound safety (SSRF)', () => {
  describe('vetSourceUrl', () => {
    it.each([
      'https://api.ist.com/ss12000v2-api/source/SE00100/v2.0',
      'https://edlevo.kommun.se:8443/ss12000/v2.0',
      'https://[2001:4860::1]/v2.0',
    ])('accepts %s', (url) => {
      expect(vetSourceUrl(url, 'base')).not.toBeNull();
    });

    it.each([
      ['http, not https', 'http://api.ist.com/v2.0'],
      ['userinfo in the authority', 'https://user:pw@api.ist.com/v2.0'],
      ['a bare @ in the authority', 'https://user@api.ist.com/v2.0'],
      ['a query', 'https://api.ist.com/v2.0?token=x'],
      ['a fragment', 'https://api.ist.com/v2.0#x'],
      ['a trailing slash', 'https://api.ist.com/v2.0/'],
      ['whitespace', 'https://api.ist.com/v 2.0'],
      ['no host', 'https:///v2.0'],
      ['another scheme', 'ftp://api.ist.com/v2.0'],
    ])('refuses %s', (_label, url) => {
      expect(vetSourceUrl(url, 'base')).toBeNull();
    });

    it('allows a token URL with a trailing slash, never with a query', () => {
      expect(vetSourceUrl('https://skolid.se/connect/token/', 'token')).not.toBeNull();
      expect(vetSourceUrl('https://skolid.se/connect/token?client_secret=x', 'token')).toBeNull();
    });

    it('binds by origin: scheme, host and port', () => {
      expect(originOf('https://skolid.se/connect/token')).toBe('https://skolid.se');
      expect(originOf('https://skolid.se:8443/x')).toBe('https://skolid.se:8443');
    });
  });

  describe('addressIsAllowed', () => {
    it.each([
      '0.0.0.0', '0.1.2.3', '10.1.2.3', '100.64.0.1', '100.127.255.255', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
      '192.0.0.8', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250',
      '240.0.0.1', '255.255.255.255',
    ])('refuses IPv4 %s', (address) => {
      expect(addressIsAllowed(address, strict)).toBe(false);
    });

    it.each([
      '::', '::1', 'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'fec0::1', 'ff02::1', '2001:db8::1', '100::1', '64:ff9b:1::1',
      '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '64:ff9b::10.0.0.1',
    ])('refuses IPv6 %s (including mapped and NAT64 private addresses)', (address) => {
      expect(addressIsAllowed(address, strict)).toBe(false);
    });

    it.each(['8.8.8.8', '193.10.4.5', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808'])('allows public %s', (address) => {
      expect(addressIsAllowed(address, strict)).toBe(true);
    });

    it('allows loopback only under the test override, and nothing else private with it', () => {
      expect(addressIsAllowed('127.0.0.1', { allowLoopback: true })).toBe(true);
      expect(addressIsAllowed('::1', { allowLoopback: true })).toBe(true);
      expect(addressIsAllowed('10.0.0.1', { allowLoopback: true })).toBe(false);
      expect(addressIsAllowed('169.254.169.254', { allowLoopback: true })).toBe(false);
    });

    it('refuses what is not an address at all', () => {
      expect(addressIsAllowed('localhost', strict)).toBe(false);
      expect(addressIsAllowed('1.2.3', strict)).toBe(false);
    });
  });

  it('expands IPv6 forms, a trailing dotted quad and a zone', () => {
    expect(v6Bytes('::1')).toEqual([...Array<number>(15).fill(0), 1]);
    expect(v6Bytes('::ffff:1.2.3.4')?.slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4]);
    expect(v6Bytes('fe80::1%en0')?.[0]).toBe(0xfe);
    expect(v6Bytes('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(v6Bytes('1::2::3')).toBeNull();
  });

  describe('vetHost', () => {
    it('refuses a host when ANY address it resolves to is private (a split answer)', async () => {
      const resolve = jest.fn(async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ]);
      await expect(vetHost('api.example', strict, resolve)).rejects.toEqual(new Ss12000SourceError('SS12000_ADDRESS_REFUSED'));
    });

    it('refuses *.railway.internal-style answers (IPv6 ULA)', async () => {
      await expect(vetHost('db.railway.internal', strict, async () => [{ address: 'fd12:3456::2', family: 6 }])).rejects.toThrow(
        'SS12000_ADDRESS_REFUSED',
      );
    });

    it('answers the first vetted address, to which the connection is then pinned', async () => {
      const resolve = jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
      await expect(vetHost('example.com', strict, resolve)).resolves.toEqual({ address: '93.184.216.34', family: 4 });
      expect(resolve).toHaveBeenCalledTimes(1);
    });

    it('vets an IP literal without asking DNS', async () => {
      const resolve = jest.fn();
      await expect(vetHost('169.254.169.254', strict, resolve)).rejects.toThrow('SS12000_ADDRESS_REFUSED');
      await expect(vetHost('[::1]', strict, resolve)).rejects.toThrow('SS12000_ADDRESS_REFUSED');
      expect(resolve).not.toHaveBeenCalled();
    });

    it('turns a DNS failure or an empty answer into a code', async () => {
      await expect(vetHost('nx.example', strict, async () => Promise.reject(new Error('ENOTFOUND')))).rejects.toThrow('SS12000_DNS_FAILED');
      await expect(vetHost('empty.example', strict, async () => [])).rejects.toThrow('SS12000_DNS_FAILED');
    });
  });
});
