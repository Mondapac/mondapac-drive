// @vitest-environment node
// The responsive standard of the admin panel: a source check that no table can widen the page,
// and that the buttons and links of the operations screens are 48px tall (min-h-12).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === 'node_modules' || name === '.next' ? [] : sourceFiles(path);
    }
    return path.endsWith('.tsx') && !path.endsWith('.spec.tsx') ? [path] : [];
  });
}

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('admin tables', () => {
  it('sit inside a scroll container, so a wide table never widens the page', () => {
    const roots = [join(__dirname, '../src'), join(__dirname, '../app')];
    const offenders = roots.flatMap(sourceFiles).filter((file) => {
      const text = readFileSync(file, 'utf8');
      return text.includes('<table') && !text.includes('overflow-x-auto');
    });
    expect(offenders).toEqual([]);
  });
});

describe('operations screens (Drive)', () => {
  const files = [
    'app/(shell)/deliveries/page.tsx',
    'app/(shell)/deliveries/[deliveryId]/page.tsx',
    'app/(shell)/merchants/page.tsx',
    'app/(shell)/merchants/[merchantId]/page.tsx',
    'app/(shell)/couriers/page.tsx',
    'app/(shell)/live-map/page.tsx',
    'app/(shell)/payouts/page.tsx',
    'app/(shell)/payouts/couriers/[courierId]/page.tsx',
    'src/payouts/lines-table.tsx',
    'src/payouts/balance-view.tsx',
    'src/payouts/adjustment-button.tsx',
    'src/live-map/live-map.tsx',
    'src/live-map/map-canvas.tsx',
    'src/deliveries/deliveries-table.tsx',
    'src/deliveries/delivery-detail.tsx',
    'src/deliveries/dispatch-panel.tsx',
    'src/merchants/merchants-table.tsx',
    'src/merchants/keys-table.tsx',
    'src/merchants/issue-key-button.tsx',
    'src/couriers/couriers-table.tsx',
    'src/ops/action-button.tsx',
    'src/ops/form-button.tsx',
  ];

  it('use no fixed pixel width', () => {
    for (const file of files) {
      expect(read(file), file).not.toMatch(/\bw-\[\d+px\]|\bmin-w-\[\d+px\]|width:\s*\d+px/);
    }
  });

  it('give every text link a 48px touch target', () => {
    // The shared Button and LinkButton are 48px high (--mp-size-control); a text link needs
    // min-h-12 itself.
    for (const file of files) {
      for (const link of read(file).match(/<a\b[^>]*>/gs) ?? []) {
        expect(link, `${file}: ${link}`).toContain('min-h-12');
      }
    }
  });

  it('put every confirmation on the shared Dialog, which stacks its actions on phones', () => {
    for (const file of ['src/ops/action-button.tsx', 'src/ops/form-button.tsx']) {
      expect(read(file)).toContain('<Dialog');
    }
    const dialog = readFileSync(
      join(__dirname, '../../../packages/ui/src/overlay/dialog.tsx'),
      'utf8',
    );
    expect(dialog).toContain('flex-col-reverse');
  });
});
