// @vitest-environment jsdom
import { Menu } from '@mondapac-drive/ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(cleanup);

describe('Menu inside a table box', () => {
  it('draws the open list outside the scrolling box, so the box cannot clip it', () => {
    const { container } = render(
      <div data-testid="box" className="overflow-x-auto">
        <Menu
          label="Actions for Ada"
          items={[{ id: 'a', label: 'Change role', onSelect: () => {} }]}
        />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Ada' }));
    const list = screen.getByRole('menu');
    expect(container.contains(list)).toBe(false);
    expect(list.parentElement).toBe(document.body);
    expect(list.style.position).toBe('fixed');
  });
});
