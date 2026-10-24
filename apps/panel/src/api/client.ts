// Browser-side calls to this panel's own relay (ADR-0034 decision 5: same origin only).

export interface ApiFailure {
  readonly status: number;
  readonly code: string;
  readonly details?: {
    readonly rule?: string;
    readonly retryAfterSeconds?: number;
    readonly fields?: readonly { readonly path: string; readonly code: string }[];
  };
}

export type ApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly body: T }
  | { readonly ok: false; readonly failure: ApiFailure };

export async function callApi<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  csrfToken?: string,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(csrfToken === undefined ? {} : { 'x-csrf-token': csrfToken }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return { ok: false, failure: { status: 0, code: 'network' } };
  }
  const parsed: unknown = await response.json().catch((): unknown => null);
  if (response.ok) return { ok: true, status: response.status, body: parsed as T };
  const failure = parsed as Partial<ApiFailure> | null;
  return {
    ok: false,
    failure: {
      status: response.status,
      code: typeof failure?.code === 'string' ? failure.code : 'unknown',
      ...(failure?.details === undefined ? {} : { details: failure.details }),
    },
  };
}
