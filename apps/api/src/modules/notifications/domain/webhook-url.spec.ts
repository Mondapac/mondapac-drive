import { isPublicAddress, maskedWebhookUrl, parseWebhookUrl } from './webhook-url';

describe('webhook URL rules (SSRF)', () => {
  it.each([
    'https://hooks.example.com/drive',
    'https://hooks.example.com:8443/drive?merchant=1',
    'https://93.184.216.34/hook',
    'https://[2606:4700::1111]/hook',
  ])('accepts %s', (url) => {
    expect(parseWebhookUrl(url).ok).toBe(true);
  });

  it.each([
    ['http://hooks.example.com/drive', 'webhook-url.not-https'],
    ['ftp://hooks.example.com/drive', 'webhook-url.not-https'],
    ['https://user:pass@hooks.example.com/', 'webhook-url.credentials'],
    ['https://hooks.example.com/#frag', 'webhook-url.invalid'],
    ['not a url', 'webhook-url.invalid'],
    [' https://hooks.example.com/', 'webhook-url.invalid'],
    [`https://example.com/${'a'.repeat(2048)}`, 'webhook-url.invalid'],
    ['https://hooks.example.com:22/', 'webhook-url.port'],
    ['https://hooks.example.com:6379/', 'webhook-url.port'],
    ['https://localhost/hook', 'webhook-url.private-host'],
    ['https://api.localhost/hook', 'webhook-url.private-host'],
    ['https://printer.local/hook', 'webhook-url.private-host'],
    ['https://db.internal/hook', 'webhook-url.private-host'],
    ['https://router.home.arpa/hook', 'webhook-url.private-host'],
    ['https://intranet/hook', 'webhook-url.private-host'],
    ['https://127.0.0.1/hook', 'webhook-url.private-host'],
    ['https://10.0.0.8/hook', 'webhook-url.private-host'],
    ['https://169.254.169.254/latest/meta-data', 'webhook-url.private-host'],
    ['https://0x7f.1/hook', 'webhook-url.private-host'],
    ['https://2130706433/hook', 'webhook-url.private-host'],
    ['https://[::1]/hook', 'webhook-url.private-host'],
    ['https://[::ffff:127.0.0.1]/hook', 'webhook-url.private-host'],
    ['https://[fd00::1]/hook', 'webhook-url.private-host'],
  ])('refuses %s', (url, code) => {
    expect(parseWebhookUrl(url)).toEqual({ ok: false, error: code });
  });
});

describe('public address check (each resolved address)', () => {
  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '1.1.1.1',
    '2606:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
  ])('lets %s through', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fe80::1',
    'fe80::1%eth0',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:10.0.0.1',
    '::ffff:a00:1',
    '::ffff:169.254.169.254',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::',
    '2001:db8::1',
    '2001::1',
    'not-an-address',
    '1.2.3',
    '01.2.3.4',
  ])('stops %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it('checks the IPv4 inside a 6to4 address as IPv4', () => {
    expect(isPublicAddress('2002:0808:0808::1')).toBe(true);
  });
});

describe('masked webhook URL (what an operator sees)', () => {
  it('masks the query, which may carry the receiver token, and keeps the rest', () => {
    expect(maskedWebhookUrl('https://hooks.example.com/drive?token=XYZ&a=1')).toBe(
      'https://hooks.example.com/drive?…',
    );
    expect(maskedWebhookUrl('https://hooks.example.com/drive')).toBe(
      'https://hooks.example.com/drive',
    );
  });
});
