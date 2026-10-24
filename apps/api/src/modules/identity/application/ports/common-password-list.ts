/**
 * The checked-in list of common passwords (identity design 6.5 and 13: a data file, not a
 * package or a remote service). `isCommon` takes the NFKC, lower-cased form of the domain's
 * `comparablePassword`. A breached-password service is backlog (ADR-0018, consequences).
 */
export interface CommonPasswordList {
  isCommon(comparable: string): boolean;
}

/** Nest token of the {@link CommonPasswordList}. */
export const COMMON_PASSWORD_LIST = Symbol('COMMON_PASSWORD_LIST');
