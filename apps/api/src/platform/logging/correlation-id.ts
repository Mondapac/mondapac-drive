/**
 * Header that carries the correlation id on responses. The API always generates the id
 * (ADR-0020 decision 8); a caller's value of this header is never the id of the request.
 */
export const CORRELATION_ID_HEADER = 'x-correlation-id';
