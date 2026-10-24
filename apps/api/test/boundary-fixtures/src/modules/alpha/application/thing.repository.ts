// The repository port of the fixture module (a `*.repository.ts` file in application/).
export interface ThingRepository {
  find(id: string): Promise<string | null>;
}
