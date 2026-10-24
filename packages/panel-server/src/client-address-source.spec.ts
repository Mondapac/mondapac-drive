import { describe, expect, it } from 'vitest';
import { parseClientAddressSource } from './client-address-source.ts';

const edge = {
  CLIENT_ADDRESS_SOURCE: 'edge',
  EDGE_CIDRS: '127.0.0.0/16',
  EDGE_CLIENT_ADDRESS_HEADER: 'cf-connecting-ip',
};

describe('parseClientAddressSource', () => {
  it('accepts socket alone and a complete edge setting', () => {
    expect(parseClientAddressSource({ CLIENT_ADDRESS_SOURCE: 'socket' })).toEqual({
      mode: 'socket',
    });
    expect(parseClientAddressSource(edge)).toMatchObject({
      mode: 'edge',
      header: 'cf-connecting-ip',
    });
  });

  it.each<[string, Record<string, string>]>([
    ['missing source', {}],
    ['unknown source', { CLIENT_ADDRESS_SOURCE: 'proxy' }],
    ['socket with EDGE_CIDRS', { CLIENT_ADDRESS_SOURCE: 'socket', EDGE_CIDRS: '127.0.0.0/16' }],
    [
      'socket with a header',
      { CLIENT_ADDRESS_SOURCE: 'socket', EDGE_CLIENT_ADDRESS_HEADER: 'x-a' },
    ],
    ['edge without CIDRs', { ...edge, EDGE_CIDRS: '' }],
    ['edge without header', { ...edge, EDGE_CLIENT_ADDRESS_HEADER: '' }],
    ['/8 range', { ...edge, EDGE_CIDRS: '10.0.0.0/8' }],
    ['0.0.0.0/0', { ...edge, EDGE_CIDRS: '0.0.0.0/0' }],
    ['::/0', { ...edge, EDGE_CIDRS: '::/0' }],
    ['host bits', { ...edge, EDGE_CIDRS: '127.0.0.1/16' }],
    ['mapped range', { ...edge, EDGE_CIDRS: '::ffff:127.0.0.0/112' }],
    ['no prefix', { ...edge, EDGE_CIDRS: '127.0.0.1' }],
    ['upper-case header', { ...edge, EDGE_CLIENT_ADDRESS_HEADER: 'CF-Connecting-IP' }],
    ['header with space', { ...edge, EDGE_CLIENT_ADDRESS_HEADER: 'cf ip' }],
    ...[
      'x-forwarded-for',
      'forwarded',
      'x-client-address',
      'x-drive-client-address',
      'x-market-id',
    ].map((name): [string, Record<string, string>] => [
      `header ${name}`,
      { ...edge, EDGE_CLIENT_ADDRESS_HEADER: name },
    ]),
  ])('refuses %s', (_name, env) => {
    expect(() => parseClientAddressSource(env)).toThrow();
  });
});
