import type { ThingRepository } from '../application/thing.repository';

// Allowed: infrastructure implements the repository port of application/.
export class PrismaThingRepository implements ThingRepository {
  find(): Promise<string | null> {
    return Promise.resolve(null);
  }
}
