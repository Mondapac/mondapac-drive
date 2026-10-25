/** A refusal of one seed request: the route, the status and the answer's error code. */
export class SeedRequestError extends Error {
  override readonly name = 'SeedRequestError';
  constructor(
    readonly route: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`${route} answered ${status}${code === null ? '' : ` ${code}`}`);
  }
}

/** A 429 with its Retry-After, waited out by {@link SeedHttp.send}. */
class SeedThrottledError extends Error {
  override readonly name = 'SeedThrottledError';
  constructor(readonly retryAfterSeconds: number) {
    super(`throttled for ${retryAfterSeconds} s`);
  }
}

export interface SeedResponse<T> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

/**
 * The seed's HTTP client for one Market of the API it booted: every step goes through the real
 * routes, guards and use cases, as the panel, the marketplace and the courier app call them.
 * Error messages carry the route and the code only, never a body (tokens, keys, addresses).
 */
export class SeedHttp {
  constructor(
    private readonly baseUrl: string,
    private readonly marketId: string,
  ) {}

  async send<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    headers: Readonly<Record<string, string>>,
    body?: object | FormData,
    accept: readonly number[] = [200, 201, 204],
  ): Promise<SeedResponse<T>> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.#once<T>(method, path, headers, body, accept);
      } catch (error) {
        // The per-origin limit of anonymous identity routes counts every Market of the stack, so
        // a second seed within a minute waits for the window, as the app does on Retry-After.
        if (!(error instanceof SeedThrottledError) || attempt >= 3) throw error;
        process.stderr.write(`dev-seed: throttled, waiting ${error.retryAfterSeconds} s\n`);
        await new Promise((resolve) => setTimeout(resolve, error.retryAfterSeconds * 1000));
      }
    }
  }

  async #once<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    headers: Readonly<Record<string, string>>,
    body: object | FormData | undefined,
    accept: readonly number[],
  ): Promise<SeedResponse<T>> {
    const form = body instanceof FormData;
    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: {
        'x-market-id': this.marketId,
        'user-agent': 'mondapac-drive-dev-seed',
        ...(body === undefined || form ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed: unknown = text.length > 0 ? safeJson(text) : null;
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after') ?? '60');
      throw new SeedThrottledError(
        Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), 120) : 60,
      );
    }
    if (!accept.includes(response.status)) {
      const code =
        parsed !== null && typeof parsed === 'object' && 'code' in parsed
          ? String(parsed.code)
          : null;
      throw new SeedRequestError(
        `${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`,
        response.status,
        code,
      );
    }
    return { status: response.status, body: parsed as T, headers: response.headers };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
