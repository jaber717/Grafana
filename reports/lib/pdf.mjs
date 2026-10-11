// HTML -> PDF with headless Chromium (the browser inside the pinned grafana-image-renderer image, or a local Chromium/Chrome/Edge).
// Also verifies the layout: no page may overflow its fixed A4 box (cropped content) and the page count must match the design.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHECK_SCRIPT = `<script>
window.addEventListener('load',function(){var bad=[];document.querySelectorAll('.page').forEach(function(p,i){
 if(p.scrollHeight>p.clientHeight+1||p.scrollWidth>p.clientWidth+1)bad.push('page '+(i+1)+' overflows by '+(p.scrollHeight-p.clientHeight)+'px');
 p.querySelectorAll('.card,.sec,.kpi').forEach(function(c){var r=c.getBoundingClientRect(),q=p.getBoundingClientRect();
  if(r.right>q.right+1||r.bottom>q.bottom+1)bad.push('page '+(i+1)+': a block extends beyond the page')});});
 document.body.setAttribute('data-layout',bad.length?'BAD '+bad.join('; '):'OK');});</script>`;

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`chromium timed out after ${timeoutMs} ms`)); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

const FLAGS = ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1', '--no-pdf-header-footer', '--disable-dev-shm-usage', '--font-render-hinting=none'];

// opts.chromium: path to the binary; opts.wrap: optional function(args)->{bin,args} to run it elsewhere (e.g. a container).
export async function htmlToPdf(html, outPath, { chromium, expectedPages, timeoutMs = 120000, keepHtml = null } = {}) {
  if (!chromium) throw new Error('no Chromium configured (set CHROMIUM_BIN)');
  const dir = mkdtempSync(join(tmpdir(), 'rpt-pdf-'));
  try {
    const file = join(dir, 'report.html');
    writeFileSync(file, html.replace('</body>', `${CHECK_SCRIPT}</body>`));
    if (keepHtml) writeFileSync(keepHtml, html);
    const url = 'file:///' + file.replace(/\\/g, '/').replace(/^\/+/, '');
    const profile = join(dir, 'profile');
    const dom = await run(chromium, [...FLAGS, `--user-data-dir=${profile}`, '--virtual-time-budget=4000', '--dump-dom', url], timeoutMs);
    const m = dom.out.match(/data-layout="([^"]*)"/);
    if (!m) throw new Error(`layout check did not run: ${dom.err.slice(0, 300)}`);
    if (m[1] !== 'OK') throw new Error(`layout check failed: ${m[1]}`);
    const pdf = await run(chromium, [...FLAGS, `--user-data-dir=${profile}`, `--print-to-pdf=${outPath}`, '--virtual-time-budget=4000', url], timeoutMs);
    if (!existsSync(outPath)) throw new Error(`chromium produced no PDF: ${pdf.err.slice(0, 300)}`);
    const buf = readFileSync(outPath);
    if (buf.subarray(0, 5).toString() !== '%PDF-') throw new Error('output is not a PDF');
    const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    if (expectedPages != null && pages !== expectedPages) throw new Error(`PDF has ${pages} pages, expected ${expectedPages}`);
    return { pages, bytes: buf.length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function findLocalChromium() {
  const c = [process.env.CHROMIUM_BIN, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  return c.find((p) => p && existsSync(p)) || null;
}
