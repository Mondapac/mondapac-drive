import { argon2Sync } from 'node:crypto';
import {
  ARGON2ID_PARAMETERS,
  Argon2idPasswordHasher,
  BUSY_RETRY_AFTER_SECONDS,
  decodePhc,
  encodePhc,
  MAX_RUNNING_HASHES,
  MAX_WAITING_HASHES,
  PasswordHashFormatError,
  type Argon2Derive,
} from './argon2id-password-hasher';

const PASSWORD = 'lantern harbour biscuit';

describe('Argon2idPasswordHasher (identity design 6.5)', () => {
  // Real hashing: 64 MiB, t=3, a few hundred milliseconds each.
  const hasher = new Argon2idPasswordHasher();

  it('runs the RFC 9106 argon2id test vector on this Node version', () => {
    const tag = argon2Sync('argon2id', {
      message: Buffer.alloc(32, 0x01),
      nonce: Buffer.alloc(16, 0x02),
      secret: Buffer.alloc(8, 0x03),
      associatedData: Buffer.alloc(12, 0x04),
      memory: 32,
      passes: 3,
      parallelism: 4,
      tagLength: 32,
    });

    expect(tag.toString('hex')).toBe(
      '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659',
    );
  });

  it('hashes to a PHC argon2id string with the parameters of 6.5 and a fresh salt', async () => {
    const first = await hasher.hash(PASSWORD);
    const second = await hasher.hash(PASSWORD);

    expect(first.ok && first.value).toMatch(
      /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(first.ok && second.ok && first.value !== second.value).toBe(true);
    // The PHC string never holds the password; the data design CHECK accepts it.
    expect(first.ok && first.value).not.toContain(PASSWORD);
    expect(first.ok && first.value.length).toBeLessThanOrEqual(255);
  }, 30_000);

  it('verifies the right password and refuses a wrong one', async () => {
    const stored = await hasher.hash(PASSWORD);
    if (!stored.ok) throw new Error('hash refused');

    expect(await hasher.verify(PASSWORD, stored.value)).toEqual({
      ok: true,
      value: { matches: true, needsRehash: false },
    });
    expect(await hasher.verify(`${PASSWORD}!`, stored.value)).toEqual({
      ok: true,
      value: { matches: false, needsRehash: false },
    });
  }, 30_000);

  it('verifies a hash made with older parameters and asks for a re-hash', async () => {
    const salt = Buffer.alloc(16, 7);
    const older = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 };
    const tag = argon2Sync('argon2id', { message: PASSWORD, nonce: salt, ...older });
    const stored = encodePhc({ ...older, salt, tag });

    expect(await hasher.verify(PASSWORD, stored)).toEqual({
      ok: true,
      value: { matches: true, needsRehash: true },
    });
  });

  it('hashes and verifies the NFKC form of the password (Hassan L1)', async () => {
    // U+FB01 (the "fi" ligature) and U+00C5 composed: NFKC gives "fi" and the same U+00C5 that
    // "A" plus U+030A composes to.
    const typed = 'pro\uFB01le lantern A\u030Arbour';
    const stored = await hasher.hash(typed);
    if (!stored.ok) throw new Error('hash refused');

    expect(await hasher.verify('profile lantern \u00C5rbour', stored.value)).toEqual({
      ok: true,
      value: { matches: true, needsRehash: false },
    });
  }, 30_000);

  it('derives against a dummy hash with the current parameters when there is no account (HF12)', async () => {
    const calls: Parameters<Argon2Derive>[] = [];
    const derive: Argon2Derive = (message, nonce, parameters) => {
      calls.push([message, nonce, parameters]);
      return Promise.resolve(Buffer.alloc(parameters.tagLength, 1));
    };
    const counting = new Argon2idPasswordHasher(derive);
    const known = encodePhc({
      memory: ARGON2ID_PARAMETERS.memory,
      passes: ARGON2ID_PARAMETERS.passes,
      parallelism: ARGON2ID_PARAMETERS.parallelism,
      salt: Buffer.alloc(16, 9),
      tag: Buffer.alloc(32, 1),
    });

    const unknown = await counting.verify(PASSWORD, null);
    const real = await counting.verify(PASSWORD, known);

    // The same work: one derivation each, with the same parameters and a 16-byte salt.
    expect(calls).toHaveLength(2);
    expect(calls[0]![2]).toEqual(calls[1]![2]);
    expect(calls[0]![1]).toHaveLength(16);
    // The fake derivation "matches" both tags; only the real account may match.
    expect(real).toEqual({ ok: true, value: { matches: true, needsRehash: false } });
    expect(unknown).toEqual({ ok: true, value: { matches: false, needsRehash: false } });
  });

  it.each([
    [
      'another algorithm',
      '$argon2i$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0$dGFndGFndGFndGFndGFndGFn',
    ],
    ['another version', '$argon2id$v=16$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0$dGFndGFndGFndGFndGFndGFn'],
    [
      'excessive memory',
      '$argon2id$v=19$m=4194304,t=3,p=1$c2FsdHNhbHRzYWx0$dGFndGFndGFndGFndGFndGFn',
    ],
    [
      'excessive passes',
      '$argon2id$v=19$m=65536,t=99,p=1$c2FsdHNhbHRzYWx0$dGFndGFndGFndGFndGFndGFn',
    ],
    ['a short salt', '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$dGFndGFndGFndGFndGFndGFn'],
    ['not PHC at all', 'plain-text-password'],
  ])('refuses to verify against %s', async (_case, stored) => {
    expect(() => decodePhc(stored)).toThrow(PasswordHashFormatError);
    await expect(hasher.verify(PASSWORD, stored)).rejects.toThrow(PasswordHashFormatError);
  });

  describe('the queue (two running, sixteen waiting)', () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve));

    /** Releases held derivations until every call has settled; at most `rounds` rounds. */
    async function drain<T>(calls: Promise<T>[], release: () => void, rounds = 50): Promise<T[]> {
      let settled = 0;
      for (const call of calls) void call.finally(() => (settled += 1));
      for (let round = 0; round < rounds && settled < calls.length; round += 1) {
        release();
        await tick();
      }
      expect(settled).toBe(calls.length);
      return Promise.all(calls);
    }

    /** A derivation whose calls stay open until released. */
    function heldDerive(): { derive: Argon2Derive; started: () => number; release: () => void } {
      const pending: (() => void)[] = [];
      let started = 0;
      return {
        derive: () =>
          new Promise<Buffer>((resolve) => {
            started += 1;
            pending.push(() => resolve(Buffer.alloc(ARGON2ID_PARAMETERS.tagLength, 1)));
          }),
        started: () => started,
        release: () => {
          for (const resolve of pending.splice(0)) resolve();
        },
      };
    }

    it('answers request.busy at once to the seventeenth waiting call, and hashes nothing for it', async () => {
      const held = heldDerive();
      const queued = new Argon2idPasswordHasher(held.derive);

      const accepted = Array.from({ length: MAX_RUNNING_HASHES + MAX_WAITING_HASHES }, () =>
        queued.hash(PASSWORD),
      );
      await new Promise((resolve) => setImmediate(resolve));
      // Two run; sixteen wait.
      expect(held.started()).toBe(MAX_RUNNING_HASHES);

      const refused = await queued.hash(PASSWORD);
      expect(refused).toEqual({
        ok: false,
        error: { code: 'request.busy', retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS },
      });
      expect(held.started()).toBe(MAX_RUNNING_HASHES);

      // Releasing the running ones lets the waiting ones run, two at a time, until all are done.
      const results = await drain(accepted, held.release);
      expect(results.every((result) => result.ok)).toBe(true);
      expect(held.started()).toBe(MAX_RUNNING_HASHES + MAX_WAITING_HASHES);
    });

    it('accepts again once the queue has room, and verify shares the same queue', async () => {
      const held = heldDerive();
      const queued = new Argon2idPasswordHasher(held.derive);
      const stored = encodePhc({
        memory: 65_536,
        passes: 3,
        parallelism: 1,
        salt: Buffer.alloc(16, 2),
        tag: Buffer.alloc(32, 1),
      });

      const filled = Array.from({ length: MAX_RUNNING_HASHES + MAX_WAITING_HASHES }, () =>
        queued.hash(PASSWORD),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect((await queued.verify(PASSWORD, stored)).ok).toBe(false);

      await drain(filled, held.release);
      const later = queued.verify(PASSWORD, stored);
      await tick();
      held.release();
      expect(await later).toEqual({ ok: true, value: { matches: true, needsRehash: false } });
    });

    it('frees the slot when a derivation fails', async () => {
      let calls = 0;
      const failing = new Argon2idPasswordHasher(() => {
        calls += 1;
        return Promise.reject(new Error('derivation failed'));
      });

      for (let attempt = 0; attempt < MAX_RUNNING_HASHES + MAX_WAITING_HASHES + 3; attempt += 1) {
        await expect(failing.hash(PASSWORD)).rejects.toThrow('derivation failed');
      }
      expect(calls).toBe(MAX_RUNNING_HASHES + MAX_WAITING_HASHES + 3);
    });
  });
});
