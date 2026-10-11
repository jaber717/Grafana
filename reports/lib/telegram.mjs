// Telegram Bot API client (sendMessage / sendDocument). Production-compatible: the base URL is configurable only so tests can point
// it at a local mock (default https://api.telegram.org). The bot token comes from a file; it is never logged - errors are scrubbed.
export class TelegramError extends Error {
  constructor(message, { status = null, transient = true, retryAfterS = null } = {}) { super(message); this.name = 'TelegramError'; this.status = status; this.transient = transient; this.retryAfterS = retryAfterS; }
}

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function call(cfg, method, body, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const base = (cfg.apiBase || 'https://api.telegram.org').replace(/\/$/, '');
  const url = `${base}/bot${cfg.token}/${method}`;
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new TelegramError(`${method}: network error: ${String(e.message).split(cfg.token).join('<token>')}`, { transient: true });
  }
  let j = null;
  try { j = await res.json(); } catch { /* non-JSON body */ }
  if (res.ok && j?.ok) return j.result;
  const status = res.status;
  const desc = String(j?.description || res.statusText || 'error').split(cfg.token).join('<token>');
  const retryAfterS = j?.parameters?.retry_after ?? (Number(res.headers.get('retry-after')) || null);
  // 429 and 5xx are transient; 400 (bad request / chat not found), 401 (bad token), 403 (blocked / no rights) never succeed on retry
  const transient = status === 429 || status >= 500;
  throw new TelegramError(`${method}: HTTP ${status} ${desc}`, { status, transient, retryAfterS });
}

const form = (fields) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) if (v !== undefined) f.append(k, v); return f; };

export function sendMessage(cfg, text, opts) {
  if (text.length > 4096) throw new TelegramError('message longer than the 4096 character Telegram limit', { transient: false });
  return call(cfg, 'sendMessage', form({ chat_id: cfg.chatId, text, parse_mode: 'HTML', disable_web_page_preview: 'true' }), opts);
}

export function sendDocument(cfg, { filename, data, caption }, opts) {
  if (caption && caption.length > 1024) throw new TelegramError('caption longer than the 1024 character limit', { transient: false });
  const f = form({ chat_id: cfg.chatId, caption, parse_mode: caption ? 'HTML' : undefined });
  f.append('document', new Blob([data], { type: 'application/pdf' }), filename);
  return call(cfg, 'sendDocument', f, opts);
}
