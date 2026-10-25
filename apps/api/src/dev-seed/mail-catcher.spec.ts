import { linkTokenOf, SeedMailCatcher } from './mail-catcher';

describe('linkTokenOf', () => {
  it('reads the token from the fragment or the query of the first link', () => {
    expect(linkTokenOf('Accept: https://p.test/accept#mi1_abc-DEF\n')).toBe('mi1_abc-DEF');
    expect(linkTokenOf('https://p.test/accept#token=mi1_x&y=1')).toBe('mi1_x');
    expect(linkTokenOf('https://p.test/reset?ref=mail&token=t1')).toBe('t1');
    expect(linkTokenOf('no link here')).toBeNull();
    expect(linkTokenOf('https://p.test/sign-in')).toBeNull();
  });
});

describe('SeedMailCatcher', () => {
  it("answers Mailpit's send interface and finds the newest link of a recipient", async () => {
    const catcher = await SeedMailCatcher.start();
    try {
      const send = (to: string, text: string) =>
        fetch(`${catcher.url}/api/v1/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ To: [{ Email: to }], Subject: 'Invitation', Text: text }),
        });
      expect((await send('A@Example.com', 'https://p.test/a#first')).status).toBe(200);
      await send('a@example.com', 'https://p.test/a#second');
      await send('b@example.com', 'https://p.test/b#other');
      expect(await catcher.linkTokenFor('a@example.com')).toBe('second');
      expect((await fetch(`${catcher.url}/elsewhere`)).status).toBe(404);
      await expect(catcher.linkTokenFor('c@example.com', 300)).rejects.toThrow(
        'no link mail reached c@example.com in time',
      );
    } finally {
      await catcher.close();
    }
  });
});
