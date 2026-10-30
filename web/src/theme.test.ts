import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Paths, not URLs: under jsdom, URL is jsdom's own and node:fs refuses it.
const css = readFileSync(join(import.meta.dirname, 'index.css'), 'utf8');
const script = readFileSync(join(import.meta.dirname, '..', 'public', 'theme.js'), 'utf8');

function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in index.css`);
  const block = css.slice(start, css.indexOf('}', start));
  const pairs: [string, string][] = [...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1] ?? '', m[2] ?? '']);
  return Object.fromEntries(pairs);
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

// [foreground, background, minimum]: 4.5 for text (WCAG 1.4.3), 3 for what isn't text (1.4.11).
const PAIRS: [string, string, number][] = [
  ['ink', 'page', 4.5], ['ink', 'sheet', 4.5], ['ink', 'field', 4.5],
  ['muted', 'page', 4.5], ['muted', 'sheet', 4.5], ['muted', 'field', 4.5],
  ['band-ink', 'band', 4.5], // the header, its Settle up button and the offline ring
  ['accent-ink', 'accent', 4.5],
  ['owe', 'page', 4.5], ['owed', 'page', 4.5], ['owe', 'danger-bg', 4.5], ['stamp', 'page', 4.5],
  ['live', 'band', 3], ['thread', 'band', 3], // the Live and Connecting dots
  ['field-line', 'page', 3], ['field-line', 'field', 3],
  ['focus', 'page', 3], ['band-ink', 'band', 3], // focus rings: on the page, and on the band (index.css)
];

describe.each([['light', ':root'], ['dark', ':root[data-theme="dark"]']])('the %s theme', (_, selector) => {
  const t = { ...tokens(':root'), ...tokens(selector) };
  it.each(PAIRS)('%s on %s has contrast of at least %s', (fg, bg, min) => {
    expect(t[fg], `--${fg}`).toBeDefined();
    expect(t[bg], `--${bg}`).toBeDefined();
    expect(contrast(t[fg] ?? '', t[bg] ?? '')).toBeGreaterThanOrEqual(min);
  });
});

describe('public/theme.js', () => {
  let systemDark = false;
  const listeners: (() => void)[] = [];
  // The file exactly as served: a classic script, not a module, so it can't be imported.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = () => { (new Function(script) as () => void)(); };
  const html = () => document.documentElement.dataset;

  beforeEach(() => {
    systemDark = false;
    listeners.length = 0;
    localStorage.clear();
    document.head.innerHTML = '<meta name="theme-color" content="">';
    window.matchMedia = (() => ({
      get matches() { return systemDark; },
      addEventListener: (_: string, f: () => void) => { listeners.push(f); },
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => { delete html().theme; delete html().themeChoice; vi.restoreAllMocks(); });

  it('follows the device by default, and its changes', () => {
    run();
    expect([html().themeChoice, html().theme]).toEqual(['system', 'light']);
    systemDark = true;
    listeners.forEach((f) => { f(); });
    expect(html().theme).toBe('dark');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#6e0c1f');
  });

  it('keeps a chosen theme, over the device and across loads', () => {
    run();
    window.hisaabTheme?.set('dark');
    expect(localStorage.getItem('hisaab-theme')).toBe('dark');
    systemDark = false;
    listeners.forEach((f) => { f(); });
    expect(html().theme).toBe('dark');
    run(); // the next page load
    expect([html().themeChoice, html().theme]).toEqual(['dark', 'dark']);
    window.hisaabTheme?.set('system');
    expect(localStorage.getItem('hisaab-theme')).toBeNull();
    expect(html().theme).toBe('light');
  });

  it('ignores a stored value it does not know', () => {
    localStorage.setItem('hisaab-theme', 'purple');
    run();
    expect(html().themeChoice).toBe('system');
  });

  it('still works when storage is blocked', () => {
    const blocked = () => { throw new Error('blocked'); };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
    systemDark = true;
    run();
    expect(html().theme).toBe('dark');
    window.hisaabTheme?.set('light');
    expect(html().theme).toBe('light');
  });
});
