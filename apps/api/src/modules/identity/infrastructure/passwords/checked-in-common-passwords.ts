import type { CommonPasswordList } from '../../application/ports/common-password-list';
import { COMMON_PASSWORDS } from './common-passwords.data';

/** The {@link CommonPasswordList} over the checked-in data file, as a set built once. */
export class CheckedInCommonPasswords implements CommonPasswordList {
  readonly #entries: ReadonlySet<string>;

  constructor(entries: readonly string[] = COMMON_PASSWORDS) {
    this.#entries = new Set(entries);
  }

  isCommon(comparable: string): boolean {
    return this.#entries.has(comparable);
  }
}
