import qrcode from 'qrcode-generator';

/** Quiet zone around the symbol, in modules (the QR standard asks for four). */
const QUIET = 4;

/**
 * The authenticator key as a QR code, drawn in the browser from the otpauth URI as plain SVG
 * elements (no HTML string, no image request, nothing leaves the page). It sits on the QR plate token
 * (white in both themes) with the darkest fixed token for the modules, because scanners need
 * dark modules on a light ground whatever the theme.
 */
export function SetupQr({
  uri,
  label,
  intro,
  fallback,
}: {
  readonly uri: string;
  readonly label: string;
  readonly intro: string;
  readonly fallback: string;
}) {
  let rows: boolean[][];
  try {
    const code = qrcode(0, 'M');
    // The library reads one byte per character, so hand it the UTF-8 bytes (a non-ASCII issuer
    // or label then reaches the authenticator app unchanged).
    code.addData(String.fromCharCode(...new TextEncoder().encode(uri)), 'Byte');
    code.make();
    const size = code.getModuleCount();
    rows = Array.from({ length: size }, (_, r) =>
      Array.from({ length: size }, (_, c) => code.isDark(r, c)),
    );
  } catch {
    return null;
  }
  const size = rows.length + QUIET * 2;
  const path = rows
    .flatMap((row, r) =>
      row.flatMap((dark, c) => (dark ? [`M${c + QUIET} ${r + QUIET}h1v1h-1z`] : [])),
    )
    .join('');
  return (
    <>
      <p className="text-sm text-fg-secondary">{intro}</p>
      <div className="self-start rounded-md p-2" style={{ background: 'var(--mp-color-bg-qr)' }}>
        <svg
          role="img"
          aria-label={label}
          viewBox={`0 0 ${size} ${size}`}
          shapeRendering="crispEdges"
          className="aspect-square w-64 max-w-full"
          data-testid="setup-qr"
        >
          <path d={path} style={{ fill: 'var(--mp-color-bg-auth-showcase-admin)' }} />
        </svg>
      </div>
      <p className="text-sm text-fg-secondary">{fallback}</p>
    </>
  );
}
