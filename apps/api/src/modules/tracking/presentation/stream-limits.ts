/** Open live channels per tracking token, per API instance (security review of tracking, M2). */
export const MAX_STREAMS_PER_TOKEN = 3;
/** Open live channels of every token together, per API instance. */
export const MAX_STREAMS_PER_INSTANCE = 2000;

/**
 * Counts the open tracking-page streams of this process, so one link (every customer has one)
 * cannot hold thousands of polling connections. A stream takes a slot when it opens and gives
 * it back when it closes, however it closes.
 */
export class StreamLimits {
  readonly #perToken = new Map<string, number>();
  #total = 0;

  constructor(
    private readonly perToken = MAX_STREAMS_PER_TOKEN,
    private readonly perInstance = MAX_STREAMS_PER_INSTANCE,
  ) {}

  /** A release function, or undefined when the token or the instance is at its limit. */
  acquire(token: string): (() => void) | undefined {
    const open = this.#perToken.get(token) ?? 0;
    if (open >= this.perToken || this.#total >= this.perInstance) return undefined;
    this.#perToken.set(token, open + 1);
    this.#total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#total -= 1;
      const left = (this.#perToken.get(token) ?? 1) - 1;
      if (left <= 0) this.#perToken.delete(token);
      else this.#perToken.set(token, left);
    };
  }

  get open(): number {
    return this.#total;
  }
}
