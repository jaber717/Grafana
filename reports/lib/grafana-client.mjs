// Grafana access for the report job: query execution (/api/ds/query) and panel rendering (/render/d-solo). Dependency-free.
// Credentials: a service-account token read from a file (GRAFANA_TOKEN_FILE) - never on a command line, never logged.
// The token needs Viewer rights on the "NOC / Daily Reports" folder and query rights on the two datasources; nothing else.
import { readFileSync } from 'node:fs';

export class GrafanaError extends Error {
  constructor(msg, { status = null, transient = false } = {}) { super(msg); this.name = 'GrafanaError'; this.status = status; this.transient = transient; }
}

export function framesToRows(result) {
  const rows = [];
  for (const f of result?.frames || []) {
    const names = f.schema.fields.map((x) => x.name);
    const n = f.data.values[0]?.length || 0;
    for (let i = 0; i < n; i++) {
      const r = {};
      names.forEach((nm, c) => { r[nm] = f.data.values[c][i]; });
      rows.push(r);
    }
  }
  return rows;
}

export class Grafana {
  constructor({ url, token = null, tokenFile = null, user = null, password = null, orgId = 1, timeoutMs = 60000 }) {
    this.url = url.replace(/\/$/, '');
    this.orgId = orgId;
    this.timeoutMs = timeoutMs;
    const tok = token || (tokenFile ? readFileSync(tokenFile, 'utf8').trim() : null);
    if (tok) this.auth = `Bearer ${tok}`;
    else if (user) this.auth = 'Basic ' + Buffer.from(`${user}:${password ?? ''}`).toString('base64');
    else throw new GrafanaError('no Grafana credentials: set GRAFANA_TOKEN_FILE');
  }

  async #fetch(method, path, body, accept = 'application/json') {
    let res;
    try {
      res = await fetch(this.url + path, {
        method, headers: { Authorization: this.auth, Accept: accept, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new GrafanaError(`${method} ${path.split('?')[0]}: ${e.message}`, { transient: true });
    }
    return res;
  }

  async json(method, path, body) {
    const res = await this.#fetch(method, path, body);
    const text = await res.text();
    if (!res.ok) throw new GrafanaError(`${method} ${path.split('?')[0]} -> ${res.status} ${text.slice(0, 240)}`, { status: res.status, transient: res.status >= 500 || res.status === 429 });
    return text ? JSON.parse(text) : null;
  }

  // queries: [{refId, datasource:{uid,type}, ...plugin fields}] -> {refId: [rows]}. A failed query throws: no silent empty result.
  async query(queries, { fromMs, toMs }) {
    const out = await this.json('POST', '/api/ds/query', { queries: queries.map((q) => ({ intervalMs: 300000, maxDataPoints: 1000, ...q })), from: String(fromMs), to: String(toMs) });
    const rows = {};
    for (const [ref, r] of Object.entries(out.results || {})) {
      if (r.error) throw new GrafanaError(`query ${ref}: ${String(r.error).slice(0, 300)}`, { transient: false });
      rows[ref] = framesToRows(r);
    }
    return rows;
  }

  // Panel image rendered by Grafana's image renderer. width/height in px; scale = device pixel ratio for crisp print output.
  async renderPanel({ uid, panelId, fromMs, toMs, width, height, tz = 'Asia/Riyadh', theme = 'light', scale = 2, timeoutS = 90 }) {
    const q = new URLSearchParams({ orgId: String(this.orgId), panelId: String(panelId), from: String(fromMs), to: String(toMs), width: String(width), height: String(height), tz, theme, scale: String(scale), timeout: String(timeoutS) });
    const res = await this.#fetch('GET', `/render/d-solo/${uid}/_?${q}`, undefined, 'image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok) throw new GrafanaError(`render panel ${panelId}: HTTP ${res.status} ${buf.toString('utf8', 0, 200)}`, { status: res.status, transient: res.status >= 500 });
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new GrafanaError(`render panel ${panelId}: response is not a PNG`);
    return buf;
  }

  async health() {
    return this.json('GET', '/api/health');
  }
}
