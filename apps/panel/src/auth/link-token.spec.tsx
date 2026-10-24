// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useLinkToken } from './link-token.ts';

function Probe() {
  const link = useLinkToken();
  return <p data-testid="state">{link.state === 'present' ? `token:${link.token}` : link.state}</p>;
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('useLinkToken', () => {
  it('reads the fragment and removes it from the address bar', () => {
    window.history.replaceState(null, '', '/reset-password?x=1#abc123');
    render(<Probe />);
    expect(screen.getByTestId('state').textContent).toBe('token:abc123');
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?x=1');
  });

  it('still has the token when effects run twice (StrictMode in development)', () => {
    window.history.replaceState(null, '', '/reset-password#abc123');
    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    expect(screen.getByTestId('state').textContent).toBe('token:abc123');
  });

  it('reports a missing token when there is no fragment', () => {
    render(<Probe />);
    expect(screen.getByTestId('state').textContent).toBe('missing');
  });
});
