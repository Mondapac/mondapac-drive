import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { err, ok, type Result } from '@mondapac-drive/shared-kernel';
import type {
  PasswordHasher,
  PasswordHasherBusy,
  PasswordVerification,
} from '../../application/ports/password-hasher';

/** The parameters of identity design 6.5 (Hassan): argon2id, 64 MiB, t=3, p=1, 16 + 32 bytes. */
export const ARGON2ID_PARAMETERS = Object.freeze({
  /** KiB. */
  memory: 65_536,
  passes: 3,
  parallelism: 1,
  saltLength: 16,
  tagLength: 32,
});

/** At most two hashes at once per process: the libuv pool has four threads (identity 6.5). */
export const MAX_RUNNING_HASHES = 2;
/** At most sixteen waiting; the seventeenth waiting call is refused with `request.busy`. */
export const MAX_WAITING_HASHES = 16;
/** The wait announced with `request.busy`. */
export const BUSY_RETRY_AFTER_SECONDS = 1;

const BUSY: PasswordHasherBusy = Object.freeze({
  code: 'request.busy',
  retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS,
});

/**
 * The one form of a password that is hashed and verified (Hassan L1; identity design 6.5): its
 * Unicode NFKC form, the form whose length the rules count (NIST SP 800-63B-4).
 */
export function hashInput(plain: string): string {
  return plain.normalize('NFKC');
}

/** Upper bounds for parameters read from a stored hash, so a bad row cannot exhaust memory. */
const STORED_LIMITS = Object.freeze({ memory: 262_144, passes: 10, parallelism: 4 });
const ARGON2_VERSION = 19;

/** The derivation, injectable so a test can hold calls open to fill the queue. */
export type Argon2Derive = (
  message: string,
  nonce: Buffer,
  parameters: { memory: number; passes: number; parallelism: number; tagLength: number },
) => Promise<Buffer>;

const nodeDerive: Argon2Derive = (message, nonce, parameters) =>
  new Promise((resolve, reject) => {
    argon2('argon2id', { message, nonce, ...parameters }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });

/** A stored hash that is not a PHC argon2id string this adapter can verify. Carries no value. */
export class PasswordHashFormatError extends Error {
  override readonly name = 'PasswordHashFormatError';
  constructor() {
    super('The stored password hash is not a supported PHC argon2id string');
  }
}

interface PhcHash {
  readonly memory: number;
  readonly passes: number;
  readonly parallelism: number;
  readonly salt: Buffer;
  readonly tag: Buffer;
}

// PHC strings use standard base64 without padding.
const b64 = (bytes: Buffer): string => bytes.toString('base64').replace(/=+$/, '');
const PHC = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/** Encodes a PHC string: `$argon2id$v=19$m=65536,t=3,p=1$<salt>$<tag>`. */
export function encodePhc(hash: PhcHash): string {
  return (
    `$argon2id$v=${ARGON2_VERSION}$m=${hash.memory},t=${hash.passes},p=${hash.parallelism}` +
    `$${b64(hash.salt)}$${b64(hash.tag)}`
  );
}

/** Decodes a PHC argon2id string, or throws {@link PasswordHashFormatError}. */
export function decodePhc(stored: string): PhcHash {
  const match = PHC.exec(stored);
  if (match === null) throw new PasswordHashFormatError();
  const [version, memory, passes, parallelism] = match.slice(1, 5).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const salt = Buffer.from(match[5]!, 'base64');
  const tag = Buffer.from(match[6]!, 'base64');
  if (
    version !== ARGON2_VERSION ||
    !(memory >= 8 * parallelism && memory <= STORED_LIMITS.memory) ||
    !(passes >= 1 && passes <= STORED_LIMITS.passes) ||
    !(parallelism >= 1 && parallelism <= STORED_LIMITS.parallelism) ||
    salt.length < 8 ||
    tag.length < 16 ||
    tag.length > 64
  ) {
    throw new PasswordHashFormatError();
  }
  return { memory, passes, parallelism, salt, tag };
}

/**
 * The one {@link PasswordHasher} adapter (identity design 6.5): argon2id through Node's
 * built-in `crypto.argon2` (stable from 24.19, the minimum is 24.20.0: ADR-0021 decision 3),
 * with a PHC encoding of ours. No pepper.
 *
 * A process runs at most {@link MAX_RUNNING_HASHES} derivations at once; up to
 * {@link MAX_WAITING_HASHES} more wait in order; any call beyond that is answered `request.busy`
 * at once, without hashing. Verification compares in constant time and reports a hash made
 * with other parameters, to be replaced at the next successful sign-in.
 *
 * Both `hash` and `verify` derive from {@link hashInput} (NFKC). With no stored hash, `verify`
 * derives against a dummy PHC string with the current parameters, a random salt and a random
 * tag, made once per process, and answers no match: the same work as for a real account (HF12).
 */
export class Argon2idPasswordHasher implements PasswordHasher {
  #running = 0;
  readonly #waiting: (() => void)[] = [];
  readonly #dummy: string;

  constructor(private readonly derive: Argon2Derive = nodeDerive) {
    const { memory, passes, parallelism, saltLength, tagLength } = ARGON2ID_PARAMETERS;
    this.#dummy = encodePhc({
      memory,
      passes,
      parallelism,
      salt: randomBytes(saltLength),
      tag: randomBytes(tagLength),
    });
  }

  async hash(plain: string): Promise<Result<string, PasswordHasherBusy>> {
    const salt = randomBytes(ARGON2ID_PARAMETERS.saltLength);
    const { memory, passes, parallelism, tagLength } = ARGON2ID_PARAMETERS;
    const message = hashInput(plain);
    const tag = await this.limited(() =>
      this.derive(message, salt, { memory, passes, parallelism, tagLength }),
    );
    if (tag === null) return err(BUSY);
    return ok(encodePhc({ memory, passes, parallelism, salt, tag }));
  }

  async verify(
    plain: string,
    stored: string | null,
  ): Promise<Result<PasswordVerification, PasswordHasherBusy>> {
    const known = stored !== null;
    const phc = decodePhc(stored ?? this.#dummy);
    const message = hashInput(plain);
    const tag = await this.limited(() =>
      this.derive(message, phc.salt, {
        memory: phc.memory,
        passes: phc.passes,
        parallelism: phc.parallelism,
        tagLength: phc.tag.length,
      }),
    );
    if (tag === null) return err(BUSY);
    const equal = tag.length === phc.tag.length && timingSafeEqual(tag, phc.tag);
    // Never a match against the dummy, whatever was typed.
    const matches = known && equal;
    const needsRehash =
      phc.memory !== ARGON2ID_PARAMETERS.memory ||
      phc.passes !== ARGON2ID_PARAMETERS.passes ||
      phc.parallelism !== ARGON2ID_PARAMETERS.parallelism ||
      phc.salt.length !== ARGON2ID_PARAMETERS.saltLength ||
      phc.tag.length !== ARGON2ID_PARAMETERS.tagLength;
    return ok({ matches, needsRehash });
  }

  /** Runs `work` within the limits, or answers null when the queue is full. */
  private async limited(work: () => Promise<Buffer>): Promise<Buffer | null> {
    if (this.#running >= MAX_RUNNING_HASHES) {
      if (this.#waiting.length >= MAX_WAITING_HASHES) return null;
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    } else {
      this.#running += 1;
    }
    try {
      return await work();
    } finally {
      // Hand the slot to the next waiting call, or free it.
      const next = this.#waiting.shift();
      if (next === undefined) this.#running -= 1;
      else next();
    }
  }
}
