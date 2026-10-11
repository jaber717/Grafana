// Adapters from the delivery orchestrator to the real channels.
import { sendMail } from './mail.mjs';
import { sendMessage, sendDocument } from './telegram.mjs';

// content: {from, subject, text, html, attachments:[{filename, contentType, data}]}; units are the recipient addresses.
export function emailBatch(smtpCfg, content) {
  return async (recipients) => {
    try {
      const r = await sendMail(smtpCfg, { ...content, to: recipients });
      return {
        done: r.accepted,
        failed: r.rejected.map((x) => ({ unit: x.address, transient: x.transient, error: `${x.code} ${x.text}` })),
      };
    } catch (e) {
      return { done: [], failed: recipients.map((unit) => ({ unit, transient: e.transient ?? true, error: e.message })) };
    }
  };
}

// content: {summaryHtml, documents:[{filename, data, caption}]}; units: 'summary' then 'doc:<filename>' in order.
// Order is preserved: after the first failure the remaining units are reported failed with the same cause, so a retry resumes in order.
export function telegramUnits(content) {
  return ['summary', ...content.documents.map((d) => `doc:${d.filename}`)];
}

export function telegramBatch(tgCfg, content, opts) {
  return async (pending) => {
    const done = [], failed = [];
    let stop = null;
    for (const unit of pending) {
      if (stop) { failed.push({ unit, transient: stop.transient, error: stop.error, retryAfterS: stop.retryAfterS }); continue; }
      try {
        if (unit === 'summary') await sendMessage(tgCfg, content.summaryHtml, opts);
        else await sendDocument(tgCfg, content.documents.find((d) => `doc:${d.filename}` === unit), opts);
        done.push(unit);
      } catch (e) {
        stop = { transient: e.transient ?? true, error: e.message, retryAfterS: e.retryAfterS };
        failed.push({ unit, ...stop });
      }
    }
    return { done, failed };
  };
}
