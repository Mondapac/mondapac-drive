import { VEHICLE_TYPES as MARKET_VEHICLE_TYPES } from '../../../platform/market-config/market-config';
import { nextId } from '../../../../test/support/fleet-markets';
import { carriesColdChain, newVehicle, normalisePlate, VEHICLE_TYPES } from './vehicle';

const input = {
  id: nextId<'Vehicle'>(),
  type: 'car' as const,
  plate: 'abc 12-3',
  maxWeightGrams: 50_000,
  maxVolumeLitres: 300,
  coldBox: 'insulated' as const,
};

describe('vehicles', () => {
  it('uses the same vehicle types as delivery and the Market rate cards', () => {
    expect(VEHICLE_TYPES).toEqual(MARKET_VEHICLE_TYPES);
  });

  it('stores the plate in upper case without spaces or dashes, and starts active', () => {
    expect(normalisePlate(' ab-c 1 ')).toBe('ABC1');
    expect(newVehicle(input)).toEqual({ ...input, plate: 'ABC123', active: true });
  });

  it('needs a plate for a motor vehicle but not for a bicycle', () => {
    const noPlate = { ...input, plate: undefined };
    expect(() => newVehicle(noPlate)).toThrow(
      expect.objectContaining({ code: 'fleet.vehicle.plate-required' }) as Error,
    );
    expect(newVehicle({ ...noPlate, type: 'bicycle' }).plate).toBeUndefined();
  });

  it.each([
    ['a plate with other characters', { plate: 'AB*1' }, 'fleet.vehicle.plate-invalid'],
    ['a plate too long', { plate: 'ABCDEFGHIJK' }, 'fleet.vehicle.plate-invalid'],
    ['no weight', { maxWeightGrams: 0 }, 'fleet.vehicle.capacity-invalid'],
    ['a fractional volume', { maxVolumeLitres: 1.5 }, 'fleet.vehicle.capacity-invalid'],
    ['an unknown type', { type: 'drone' }, 'fleet.vehicle.type-unknown'],
    ['an unknown box', { coldBox: 'cooler' }, 'fleet.vehicle.cold-box-unknown'],
  ])('refuses %s', (_case, overrides, code) => {
    expect(() => newVehicle({ ...input, ...(overrides as object) })).toThrow(
      expect.objectContaining({ code }) as Error,
    );
  });

  it('carries cold chain only with an insulated or refrigerated box', () => {
    expect(carriesColdChain(newVehicle({ ...input, coldBox: 'none' }))).toBe(false);
    expect(carriesColdChain(newVehicle({ ...input, coldBox: 'insulated' }))).toBe(true);
    expect(carriesColdChain(newVehicle({ ...input, coldBox: 'refrigerated' }))).toBe(true);
  });
});
