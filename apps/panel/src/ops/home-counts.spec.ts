import { describe, expect, it } from 'vitest';
import messages from '../../messages/en.json';
import { COUNT_READS, cardHref, countReadsFor } from './home-counts.ts';

const read = (id: string) => {
  const found = COUNT_READS.find((r) => r.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};

describe('Home figures', () => {
  it('reads only the lists the session holds the key of', () => {
    const ids = countReadsFor(new Set(['fleet.courier.view'])).map((r) => r.id);
    expect(ids).toEqual(['fleet-applicants', 'fleet-documents']);
    expect(countReadsFor(new Set())).toEqual([]);
  });

  it('counts a page and says when more pages exist', () => {
    expect(read('deliveries-waiting').count({ items: [{}, {}], next: null })).toEqual({
      count: 2,
      hasMore: false,
    });
    expect(read('fleet-applicants').count({ items: [{}], next: 'abc' })).toEqual({
      count: 1,
      hasMore: true,
    });
    expect(read('payout-lines').count({ lines: [{}, {}, {}] })).toEqual({
      count: 3,
      hasMore: false,
    });
    expect(read('dead-webhooks').count({ calls: [] })).toEqual({ count: 0, hasMore: false });
  });

  it('counts the deliveries a dispatcher must look at among the latest page', () => {
    const body = {
      items: [
        { status: 'DELIVERY_FAILED' },
        { status: 'DISPATCHING', exception: 'dispatch-exhausted' },
        { status: 'PICKED_UP', exception: null },
        { status: 'DELIVERED' },
      ],
      next: 'abc',
    };
    expect(read('deliveries-attention').count(body)).toEqual({ count: 2, hasMore: true });
  });

  it('adds up the documents to review across the page of couriers', () => {
    const body = { items: [{ documentsToReview: 2 }, { documentsToReview: 0 }, {}], next: null };
    expect(read('fleet-documents').count(body)).toEqual({ count: 2, hasMore: false });
  });

  it('links a card only to a page the session has in its nav', () => {
    const nav = new Set(['/', '/deliveries', '/payouts']);
    expect(cardHref(read('deliveries-waiting'), nav)).toBe('/deliveries?show=waiting');
    expect(cardHref(read('dead-webhooks'), nav)).toBeNull();
    expect(cardHref(read('fleet-applicants'), nav)).toBeNull();
  });

  it('has a label and a scope for every figure', () => {
    const texts: Record<string, unknown> = messages['home-now'];
    for (const r of COUNT_READS) {
      const text = texts[r.id] as { label?: unknown; scope?: unknown } | undefined;
      expect(typeof text?.label, r.id).toBe('string');
      expect(typeof text?.scope, r.id).toBe('string');
    }
  });
});
