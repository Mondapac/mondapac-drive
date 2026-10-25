import { readFileSync } from 'node:fs';
import path from 'node:path';
import { documentApplies, type SeedDocumentRule } from './seed-market';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const documentsOf = (file: string) =>
  (
    JSON.parse(readFileSync(path.join(REPO_ROOT, file), 'utf8')) as {
      fleet: { documents: SeedDocumentRule[] };
    }
  ).fleet.documents;

describe('documentApplies', () => {
  it.each([
    ['AU', 'config/markets/AU.json'],
    ['ZZ', 'test/fixtures/markets/ZZ.json'],
  ])('asks a cold-chain contractor with a van for every %s document of that case', (_, file) => {
    const documents = documentsOf(file);
    const asked = documents.filter((rule) => documentApplies(rule, 'van'));
    expect(asked.length).toBeGreaterThan(0);
    // Employee-only documents and documents of other vehicles are never uploaded.
    for (const rule of documents) {
      const employeeOnly =
        rule.employmentTypes !== undefined && !rule.employmentTypes.includes('contractor');
      const otherVehicle = rule.vehicleTypes !== undefined && !rule.vehicleTypes.includes('van');
      expect(asked.includes(rule)).toBe(!employeeOnly && !otherVehicle);
    }
  });

  it('skips a document of another vehicle type or an employee-only one', () => {
    const base = { coldChainOnly: false, perVehicle: false, expires: false };
    expect(documentApplies({ ...base, type: 'x', vehicleTypes: ['car'] }, 'van')).toBe(false);
    expect(documentApplies({ ...base, type: 'x', employmentTypes: ['employee'] }, 'van')).toBe(
      false,
    );
    expect(documentApplies({ ...base, type: 'x', coldChainOnly: true }, 'van')).toBe(true);
  });
});

describe('seed data files', () => {
  it.each(['AU', 'ZZ'])('%s names a service area with an enabled delivery postcode', (code) => {
    const data = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'scripts/dev-seed/markets', `${code}.json`), 'utf8'),
    ) as { serviceAreaCode: string; pickup: { postcode: string }; dropoffs: unknown[] };
    const areasFile =
      code === 'AU' ? 'config/service-areas/AU.json' : 'test/fixtures/service-areas/ZZ.json';
    const areas = (
      JSON.parse(readFileSync(path.join(REPO_ROOT, areasFile), 'utf8')) as {
        areas: { code: string; deliveryEnabled: boolean }[];
      }
    ).areas;
    expect(areas.find((area) => area.code === data.serviceAreaCode)?.deliveryEnabled).toBe(true);
    expect(data.dropoffs.length).toBeGreaterThan(0);
  });
});
