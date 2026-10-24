import { assertShiftChange, canChangeShift, SHIFT_STATES, type ShiftState } from './shift';

describe('shift transitions', () => {
  const allowed: [ShiftState, ShiftState][] = [
    ['offline', 'online'],
    ['online', 'offline'],
    ['online', 'paused'],
    ['online', 'on_delivery'],
    ['paused', 'online'],
    ['paused', 'offline'],
    ['on_delivery', 'online'],
  ];

  it.each(allowed)('lets a courier go from %s to %s', (from, to) => {
    expect(canChangeShift(from, to)).toBe(true);
    expect(() => assertShiftChange(from, to)).not.toThrow();
  });

  const refused = SHIFT_STATES.flatMap((from) =>
    SHIFT_STATES.filter(
      (to) => to !== from && !allowed.some(([a, b]) => a === from && b === to),
    ).map((to) => [from, to] as [ShiftState, ShiftState]),
  );

  it.each(refused)('refuses %s to %s', (from, to) => {
    expect(canChangeShift(from, to)).toBe(false);
    expect(() => assertShiftChange(from, to)).toThrow(
      expect.objectContaining({ code: 'fleet.shift.transition-not-allowed' }) as Error,
    );
  });

  it('finishes a delivery before going offline or pausing', () => {
    expect(canChangeShift('on_delivery', 'offline')).toBe(false);
    expect(canChangeShift('on_delivery', 'paused')).toBe(false);
  });

  it('refuses an unknown state', () => {
    expect(() => assertShiftChange('online', 'asleep' as ShiftState)).toThrow(
      expect.objectContaining({ code: 'fleet.shift.unknown' }) as Error,
    );
  });
});
