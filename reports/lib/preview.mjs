// PNG previews of each report page (headless Chromium screenshot of the same HTML that is printed to PDF).
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('chromium timed out')); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, err }); });
  });
}

export async function previewPages(html, outDir, { chromium, pages, prefix = 'page', scale = 1.5 }) {
  mkdirSync(outDir, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'rpt-prev-'));
  const files = [];
  try {
    for (let n = 1; n <= pages; n++) {
      const file = join(dir, `p${n}.html`);
      writeFileSync(file, html.replace('</head>', `<style>.page{display:none!important}.page:nth-of-type(${n}){display:flex!important}</style></head>`));
      const out = join(outDir, `${prefix}-${n}.png`);
      await run(chromium, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', `--force-device-scale-factor=${scale}`, '--window-size=1123,794', '--virtual-time-budget=4000', `--user-data-dir=${join(dir, 'u' + n)}`, `--screenshot=${out}`, 'file:///' + file.replace(/\\/g, '/').replace(/^\/+/, '')], 60000);
      if (!existsSync(out)) throw new Error(`no screenshot for page ${n}`);
      files.push(out);
    }
    return files;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
