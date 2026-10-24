/** The reason a raw read call was refused before it reached the database. No value in it. */
export type RawReadRefusal =
  | 'unknown-statement'
  | 'wrong-module'
  | 'no-open-unit'
  | 'read-write-unit'
  | 'params-malformed'
  | 'array-too-long'
  | 'group-length-mismatch'
  | 'row-invalid'
  | 'not-an-array';

/** A raw read that was refused; the message holds the statement id and the reason only. */
export class RawReadRefusedError extends Error {
  constructor(
    readonly statementId: string,
    readonly reason: RawReadRefusal,
  ) {
    super(`raw read ${statementId} refused: ${reason}`);
    this.name = 'RawReadRefusedError';
  }
}

/** The database failed the statement; carries the SQLSTATE and never the driver's message. */
export class RawReadFailedError extends Error {
  constructor(
    readonly statementId: string,
    readonly sqlState: string | null,
  ) {
    super(`raw read ${statementId} failed${sqlState === null ? '' : `: ${sqlState}`}`);
    this.name = 'RawReadFailedError';
  }
}
