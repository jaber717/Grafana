// Report job settings from an env file (KEY=VALUE). Rules:
//  - secrets (Grafana token, SMTP password, Telegram bot token) are read from FILES named by *_FILE keys, never from the env file itself;
//  - e-mail and Telegram are OFF unless explicitly enabled, and an enabled channel with missing settings is a configuration error;
//  - every problem is collected so `check-config` can show them all at once.
import { readFileSync, existsSync, statSync } from 'node:fs';

export function parseEnv(text) {
  const out = {};
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m) throw new Error(`settings line ${i + 1}: expected KEY=VALUE`);
    let v = m[2].trim();
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  });
  return out;
}

const KNOWN = new Set(['GRAFANA_URL', 'GRAFANA_TOKEN_FILE', 'INTERFACES_FILE', 'OUTPUT_DIR', 'STATE_DIR', 'LOG_FILE', 'CHROMIUM_CMD', 'REPORT_KINDS',
  'EMAIL_ENABLED', 'EMAIL_FROM', 'EMAIL_TO', 'EMAIL_SUBJECT_PREFIX', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURITY', 'SMTP_USER', 'SMTP_PASSWORD_FILE', 'SMTP_TLS_CA_FILE',
  'TELEGRAM_ENABLED', 'TELEGRAM_API_BASE', 'TELEGRAM_BOT_TOKEN_FILE', 'TELEGRAM_CHAT_ID',
  'SCOPES_FILE', 'REPORT_SCOPE', 'RETRY_ATTEMPTS', 'RETRY_BASE_SECONDS', 'RETRY_MAX_SECONDS', 'NOTIFY_ON_FAILURE', 'RENDER_TIMEOUT_SECONDS', 'PUBLIC_GRAFANA_URL', 'RETENTION_DAYS']);

const bool = (v, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v, d) => (v == null || v === '' ? d : Number.parseInt(v, 10));
const ADDR = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const FROM = /^(?:[^<>]+<)?[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+>?$/;

export function validateSettings(env, { fs = { readFileSync, existsSync, statSync } } = {}) {
  const problems = [], warnings = [];
  for (const k of Object.keys(env)) if (!KNOWN.has(k)) warnings.push(`unknown setting ${k} (ignored)`);
  const need = (k) => { if (!env[k]) problems.push(`${k} is required`); return env[k]; };
  const secret = (k, label) => {
    const f = env[k];
    if (!f) { problems.push(`${k} is required (${label})`); return null; }
    if (!fs.existsSync(f)) { problems.push(`${k}: ${f} does not exist`); return null; }
    try {
      const mode = fs.statSync(f).mode & 0o077;
      if (mode && process.platform !== 'win32') warnings.push(`${k}: ${f} is readable by group/others (chmod 600)`);
      const v = fs.readFileSync(f, 'utf8').trim();
      if (!v) problems.push(`${k}: ${f} is empty`);
      return v || null;
    } catch (e) { problems.push(`${k}: cannot read ${f}: ${e.message}`); return null; }
  };
  const s = {
    grafana: { url: (need('GRAFANA_URL') || '').replace(/\/$/, ''), token: secret('GRAFANA_TOKEN_FILE', 'Grafana service-account token') },
    interfacesFile: need('INTERFACES_FILE'),
    outputDir: env.OUTPUT_DIR || '/var/lib/grafana-report/out',
    stateDir: env.STATE_DIR || '/var/lib/grafana-report/state',
    logFile: env.LOG_FILE || null,
    chromiumCmd: need('CHROMIUM_CMD'),
    scopesFile: env.SCOPES_FILE || null,
    scope: env.REPORT_SCOPE || null,
    kinds: (env.REPORT_KINDS || 'netflow,interface,health').split(',').map((x) => x.trim()).filter(Boolean),
    retry: { attempts: int(env.RETRY_ATTEMPTS, 4), baseMs: int(env.RETRY_BASE_SECONDS, 30) * 1000, maxMs: int(env.RETRY_MAX_SECONDS, 600) * 1000 },
    renderTimeoutS: int(env.RENDER_TIMEOUT_SECONDS, 90),
    retentionDays: int(env.RETENTION_DAYS, 45),
    notifyOnFailure: bool(env.NOTIFY_ON_FAILURE, true),
    publicGrafanaUrl: env.PUBLIC_GRAFANA_URL || null,
    email: { enabled: bool(env.EMAIL_ENABLED), from: env.EMAIL_FROM || '', to: [], subjectPrefix: env.EMAIL_SUBJECT_PREFIX || 'Daily Network Reports',
      smtp: { host: env.SMTP_HOST || '', port: int(env.SMTP_PORT, 25), security: env.SMTP_SECURITY || 'none', username: env.SMTP_USER || null, password: null, tlsCa: env.SMTP_TLS_CA_FILE || null } },
    telegram: { enabled: bool(env.TELEGRAM_ENABLED), apiBase: env.TELEGRAM_API_BASE || 'https://api.telegram.org', token: null, chatId: env.TELEGRAM_CHAT_ID || '' },
  };
  for (const k of s.kinds) if (!['netflow', 'interface', 'health'].includes(k)) problems.push(`REPORT_KINDS: unknown report '${k}' (netflow, interface, health)`);
  if (!s.kinds.length) problems.push('REPORT_KINDS is empty');
  if (s.scopesFile && !fs.existsSync(s.scopesFile)) problems.push(`SCOPES_FILE: ${s.scopesFile} does not exist`);
  if (s.grafana.url && !/^https?:\/\//.test(s.grafana.url)) problems.push('GRAFANA_URL must start with http:// or https://');
  if (s.retry.attempts < 1 || s.retry.attempts > 10) problems.push('RETRY_ATTEMPTS must be 1..10');
  if (s.email.enabled) {
    if (!s.email.smtp.host) problems.push('SMTP_HOST is required when EMAIL_ENABLED=true');
    if (!FROM.test(s.email.from)) problems.push('EMAIL_FROM must be an address (or "Name <address>")');
    s.email.to = (env.EMAIL_TO || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!s.email.to.length) problems.push('EMAIL_TO must list at least one recipient when EMAIL_ENABLED=true');
    for (const a of s.email.to) if (!ADDR.test(a)) problems.push(`EMAIL_TO: '${a}' is not a valid address`);
    if (new Set(s.email.to.map((x) => x.toLowerCase())).size !== s.email.to.length) problems.push('EMAIL_TO lists the same recipient twice');
    if (!['none', 'starttls', 'tls'].includes(s.email.smtp.security)) problems.push('SMTP_SECURITY must be none, starttls or tls');
    if (s.email.smtp.username) s.email.smtp.password = secret('SMTP_PASSWORD_FILE', 'SMTP password');
    if (s.email.smtp.username && s.email.smtp.security === 'none') problems.push('SMTP_USER is set but SMTP_SECURITY=none: credentials are never sent unencrypted');
  }
  if (s.telegram.enabled) {
    s.telegram.token = secret('TELEGRAM_BOT_TOKEN_FILE', 'Telegram bot token');
    if (!s.telegram.chatId) problems.push('TELEGRAM_CHAT_ID is required when TELEGRAM_ENABLED=true');
    if (!/^https?:\/\//.test(s.telegram.apiBase)) problems.push('TELEGRAM_API_BASE must start with http:// or https://');
  }
  return { settings: s, problems, warnings };
}

export function loadSettings(path) {
  const r = validateSettings(parseEnv(readFileSync(path, 'utf8')));
  if (r.problems.length) throw Object.assign(new Error(`invalid settings in ${path}:\n  - ${r.problems.join('\n  - ')}`), { problems: r.problems });
  return r;
}
