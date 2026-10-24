import { describe, expect, it } from 'vitest';
import { badgeCount, HEARD_NONE, laterNotice, shouldRing } from './notices.ts';

const ORDERS = new Set(['seller.order-paid']);
const OLD = '0190a000-0000-7000-8000-000000000001';
const NEW = '0190a000-0000-7000-8000-000000000002';
const order = (id: string) => ({ id, kind: 'seller.order-paid' });

describe('badgeCount', () => {
  it('shows nothing at 0, the count up to 99 and "99+" above', () => {
    expect(badgeCount(0)).toBe('');
    expect(badgeCount(-1)).toBe('');
    expect(badgeCount(1)).toBe('1');
    expect(badgeCount(99)).toBe('99');
    expect(badgeCount(100)).toBe('99+');
    expect(badgeCount(4000)).toBe('99+');
  });
});

describe('shouldRing', () => {
  it('rings for an order newer than the last one heard', () => {
    expect(shouldRing(order(NEW), OLD, ORDERS)).toBe(true);
    expect(shouldRing(order(NEW), HEARD_NONE, ORDERS)).toBe(true);
  });

  it('does not ring twice for the same notice, nor for an older one after a read', () => {
    expect(shouldRing(order(NEW), NEW, ORDERS)).toBe(false);
    expect(shouldRing(order(OLD), NEW, ORDERS)).toBe(false);
  });

  it('does not ring on the first poll of a device, for nothing, or for a silent kind', () => {
    expect(shouldRing(order(NEW), null, ORDERS)).toBe(false);
    expect(shouldRing(null, OLD, ORDERS)).toBe(false);
    expect(shouldRing({ id: NEW, kind: 'seller.stock-low' }, OLD, ORDERS)).toBe(false);
  });

  it('compares ids without regard to case', () => {
    expect(shouldRing(order(NEW.toUpperCase()), OLD, ORDERS)).toBe(true);
    expect(shouldRing(order(NEW.toUpperCase()), NEW, ORDERS)).toBe(false);
  });
});

describe('laterNotice', () => {
  it('keeps the later id, and a mark that sorts first when nothing was unread', () => {
    expect(laterNotice(NEW, OLD)).toBe(NEW);
    expect(laterNotice(OLD, NEW)).toBe(NEW);
    expect(laterNotice(null, OLD)).toBe(OLD);
    expect(laterNotice(NEW, null)).toBe(NEW);
    expect(laterNotice(null, null)).toBe(HEARD_NONE);
    expect(HEARD_NONE < OLD).toBe(true);
  });
});
