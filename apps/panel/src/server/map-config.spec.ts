import { describe, expect, it } from 'vitest';
import { parseMapCenters, parseMapConfig } from './map-config.ts';

const style = 'https://tiles.example.com/maps/streets/style.json?key=k';

describe('map configuration', () => {
  it('has no base map and no centers when nothing is set', () => {
    expect(parseMapConfig({})).toEqual({ styleUrl: null, origins: [], centers: {}, zoom: 11 });
  });

  it('reads a center for each Market, AU and ZZ alike, and the style origins', () => {
    const config = parseMapConfig({
      PANEL_MAP_STYLE_URL: style,
      PANEL_MAP_CENTERS: 'AU:-27.4698,153.0251;ZZ:35.6812,139.7671',
      PANEL_MAP_ORIGINS: 'https://glyphs.example.com, https://tiles.example.com',
      PANEL_MAP_ZOOM: '12',
    });
    expect(config).toEqual({
      styleUrl: style,
      origins: ['https://tiles.example.com', 'https://glyphs.example.com'],
      centers: { AU: { lat: -27.4698, lng: 153.0251 }, ZZ: { lat: 35.6812, lng: 139.7671 } },
      zoom: 12,
    });
  });

  it('allows no origin without a style, so the CSP stays as it was', () => {
    expect(
      parseMapConfig({
        PANEL_MAP_ORIGINS: 'https://glyphs.example.com',
        PANEL_MAP_CENTERS: 'ZZ:1,2',
      }).origins,
    ).toEqual([]);
  });

  it('refuses a plain-http style or origin and a bad zoom', () => {
    expect(() =>
      parseMapConfig({ PANEL_MAP_STYLE_URL: 'http://tiles.example.com/s.json' }),
    ).toThrow(/https/);
    expect(() =>
      parseMapConfig({ PANEL_MAP_STYLE_URL: style, PANEL_MAP_ORIGINS: 'http://a.example.com' }),
    ).toThrow(/https/);
    expect(() => parseMapConfig({ PANEL_MAP_ZOOM: '30' })).toThrow(/PANEL_MAP_ZOOM/);
  });

  it('refuses an origin that would add a CSP directive or a wildcard', () => {
    for (const bad of [
      'https://a;script-src*',
      'https://*.example.com',
      'https://u:p@tiles.example.com',
    ]) {
      expect(() => parseMapConfig({ PANEL_MAP_STYLE_URL: bad }), bad).toThrow(/plain https host/);
      expect(
        () => parseMapConfig({ PANEL_MAP_STYLE_URL: style, PANEL_MAP_ORIGINS: bad }),
        bad,
      ).toThrow(/plain https host/);
    }
  });

  it('refuses a malformed center', () => {
    expect(() => parseMapCenters('au:1,2')).toThrow();
    expect(() => parseMapCenters('AU:91,2')).toThrow();
    expect(() => parseMapCenters('AU:1;2')).toThrow();
  });
});
