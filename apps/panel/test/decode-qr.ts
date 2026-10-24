import jsQR from 'jsqr';

/** Pixels drawn per QR module when the SVG path is rasterised for the decoder. */
const SCALE = 6;

/**
 * Rasterises the `SetupQr` SVG (one `M{x} {y}h1v1h-1z` square per dark module, on a viewBox that
 * already holds the quiet zone) and reads it back with a real QR decoder, as a phone camera would.
 * Returns the decoded text, or null when no symbol can be read.
 */
export function decodeSetupQr(svg: Element): string | null {
  const [, , width = 0, height = 0] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
  const pixels = new Uint8ClampedArray(width * SCALE * height * SCALE * 4).fill(255);
  const d = svg.querySelector('path')?.getAttribute('d') ?? '';
  for (const [, x, y] of d.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    for (let dy = 0; dy < SCALE; dy++) {
      for (let dx = 0; dx < SCALE; dx++) {
        const px = Number(x) * SCALE + dx;
        const py = Number(y) * SCALE + dy;
        const at = (py * width * SCALE + px) * 4;
        pixels[at] = pixels[at + 1] = pixels[at + 2] = 0;
      }
    }
  }
  return jsQR(pixels, width * SCALE, height * SCALE)?.data ?? null;
}
