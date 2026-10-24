import { API_KEY_PREFIX, RandomSessionTokens, SESSION_TOKEN_PREFIX } from './random-session-tokens';

describe('RandomSessionTokens', () => {
  const tokens = new RandomSessionTokens();

  it('gives a merchant API key its own prefix, unlike a session token', () => {
    const session = tokens.issue();
    const key = tokens.issue('api-key');
    expect(session.token.startsWith(SESSION_TOKEN_PREFIX)).toBe(true);
    expect(key.token.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(API_KEY_PREFIX).not.toBe(SESSION_TOKEN_PREFIX);
  });

  it('hashes both shapes the way they were stored, and refuses any other', () => {
    for (const issued of [tokens.issue(), tokens.issue('api-key')]) {
      expect(tokens.hashOf(issued.token)).toEqual(issued.tokenHash);
    }
    expect(tokens.hashOf(`mx1_${'A'.repeat(43)}`)).toBeNull();
    expect(tokens.hashOf('ms1_short')).toBeNull();
  });
});
