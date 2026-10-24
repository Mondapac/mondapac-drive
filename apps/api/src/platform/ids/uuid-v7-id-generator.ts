import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { parseId, uuidV7 } from '@mondapac-drive/shared-kernel';
import type { Clock, Id, IdGenerator } from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../clock/clock.module';

/**
 * The production IdGenerator (platform-foundations 3.1): a version 7 UUID from the injected
 * Clock's time and 10 random bytes of `node:crypto`. Ids are ordered by millisecond only;
 * nothing may rely on their order inside one millisecond.
 */
@Injectable()
export class UuidV7IdGenerator implements IdGenerator {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  next<K extends string>(): Id<K> {
    const id = parseId<K>(uuidV7(this.clock.now().epochMilliseconds, randomBytes(10)));
    // The kernel's layout always parses; a failure here is a defect, never a caller's input.
    if (!id.ok) throw new Error('UuidV7IdGenerator produced an id that parseId refuses');
    return id.value;
  }
}
