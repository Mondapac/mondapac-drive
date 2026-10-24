/**
 * The request header that names the Market of an HTTP request (ADR-0020 decision 3). The
 * tier in front of the API sets it and overwrites any value the client sent.
 */
export const MARKET_ID_HEADER = 'x-market-id';
