// Reports the built bundle (gzip sizes, as served) and fails if the first-load JavaScript passes
// its budget. Run after `vite build`: npm run size -w web
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_KB = 125; // first-load JS, gzipped (119.5 kB when set)
const dir = new URL('../dist/assets/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const kb = (n) => (n / 1024).toFixed(1);

const html = readFileSync(join(dir, '..', 'index.html'), 'utf8');
const files = readdirSync(dir).map((name) => {
  const buf = readFileSync(join(dir, name));
  const gz = /\.(js|css|svg)$/.test(name) ? gzipSync(buf, { level: 9 }).length : statSync(join(dir, name)).size;
  return { name, raw: buf.length, gz, initial: html.includes(name) };
});

const js = files.filter((f) => f.name.endsWith('.js')).sort((a, b) => b.gz - a.gz);
const initialJs = js.filter((f) => f.initial).reduce((s, f) => s + f.gz, 0);
const css = files.filter((f) => f.name.endsWith('.css')).reduce((s, f) => s + f.gz, 0);
const fonts = files.filter((f) => f.name.endsWith('.woff2'));

const rows = js.map((f) => `| ${f.name} | ${f.initial ? 'first load' : 'on demand'} | ${kb(f.raw)} | ${kb(f.gz)} |`);
process.stdout.write(
  '### Web bundle\n\n| file | loaded | raw kB | gzip kB |\n|---|---|---|---|\n' +
    `${rows.join('\n')}\n\n` +
    `First-load JS: **${kb(initialJs)} kB gzipped** (budget ${BUDGET_KB} kB). CSS: ${kb(css)} kB gzipped. ` +
    `Fonts: ${fonts.length} woff2 files, fetched per script/weight as needed by unicode-range.\n`,
);
if (initialJs / 1024 > BUDGET_KB) {
  process.stderr.write(`First-load JS ${kb(initialJs)} kB is over the ${BUDGET_KB} kB budget\n`);
  process.exit(1);
}
