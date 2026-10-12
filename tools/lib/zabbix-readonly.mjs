// Read-only Zabbix JSON-RPC client for the LAB tools (token from an env file kept outside Git, TLS always verified). Never prints the token.
import { readFileSync } from 'node:fs';
import https from 'node:https';

export function connect() {
  // credentials: ZABBIX_ENV_FILE (KEY=VALUE file with ZABBIX_API_URL / ZABBIX_API_TOKEN, kept outside Git) or ZABBIX_URL + ZABBIX_TOKEN_FILE. Never printed.
  // TLS is always verified: ZABBIX_CA_FILE = the LAB's (self-signed / private) certificate chain in PEM.
  const envf = {};
  if (process.env.ZABBIX_ENV_FILE) for (const l of readFileSync(process.env.ZABBIX_ENV_FILE, "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_]+)=(.*)$/); if (m) envf[m[1]] = m[2].trim(); }
  const url = envf.ZABBIX_API_URL || process.env.ZABBIX_URL;
  const token = envf.ZABBIX_API_TOKEN || (process.env.ZABBIX_TOKEN_FILE ? readFileSync(process.env.ZABBIX_TOKEN_FILE, 'utf8').trim() : null);
  if (!url || !token) { console.error('set ZABBIX_ENV_FILE, or ZABBIX_URL and ZABBIX_TOKEN_FILE (read-only token)'); process.exit(1); }
  const ca = process.env.ZABBIX_CA_FILE ? readFileSync(process.env.ZABBIX_CA_FILE) : undefined;
  let seq = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: ++seq });
    const r = https.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname, ca, timeout: 60000, headers: { 'Content-Type': 'application/json-rpc', Authorization: `Bearer ${token}`, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let t = ''; res.on('data', (d) => (t += d));
      res.on('end', () => { try { const j = JSON.parse(t); j.error ? reject(new Error(`${method}: ${j.error.message} ${j.error.data || ''}`)) : resolve(j.result); } catch (e) { reject(e); } });
    });
    r.on('error', reject); r.write(body); r.end();
  });
  
    return { call, url };
}
