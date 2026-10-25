import { fireEvent, render, screen } from '@testing-library/react-native';
import { SlideToConfirm } from '../src/ui/SlideToConfirm';
import { darkPalette, lightPalette, type Palette } from '../src/ui/theme';

const activate = { nativeEvent: { actionName: 'activate' } };

describe('slide to confirm', () => {
  it('ignores a tap and confirms on the activate action', async () => {
    const onConfirm = jest.fn();
    await render(<SlideToConfirm label="Picked up" onConfirm={onConfirm} />);
    const control = screen.getByRole('button', { name: 'Picked up' });
    await fireEvent.press(control);
    expect(onConfirm).not.toHaveBeenCalled();
    await fireEvent(control, 'accessibilityAction', activate);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('does nothing while disabled or busy', async () => {
    const onConfirm = jest.fn();
    await render(<SlideToConfirm label="Accept" onConfirm={onConfirm} disabled />);
    const control = screen.getByRole('button', { name: 'Accept' });
    expect(control).toBeDisabled();
    await fireEvent(control, 'accessibilityAction', activate);
    await render(<SlideToConfirm label="Accept" onConfirm={onConfirm} busy />);
    await fireEvent(
      screen.getByRole('button', { name: 'Accept' }),
      'accessibilityAction',
      activate,
    );
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

/** WCAG 2.1 contrast ratio of two #RRGGBB colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

describe.each([
  ['light', lightPalette],
  ['dark', darkPalette],
] as const)('the %s palette', (_, palette: Palette) => {
  // Text a courier must read at a glance, in sun or at night: WCAG AA (4.5:1) at least.
  it.each([
    ['text', 'background'],
    ['text', 'surface'],
    ['text', 'raised'],
    ['muted', 'surface'],
    ['muted', 'background'],
    ['primaryText', 'primary'],
    ['heroText', 'hero'],
    ['heroMuted', 'hero'],
    ['danger', 'dangerSurface'],
    ['warning', 'warningSurface'],
    ['success', 'successSurface'],
    ['cold', 'coldSurface'],
    ['coldStripText', 'coldStrip'],
  ] as const)('%s on %s is readable', (fore, back) => {
    expect(contrast(palette[fore], palette[back])).toBeGreaterThanOrEqual(4.5);
  });
});
