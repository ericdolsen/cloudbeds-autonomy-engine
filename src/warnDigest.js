const nodemailer = require('nodemailer');
const { logger } = require('./logger');

/**
 * Buffers WARN and ERROR log lines and emails the operator a digest every
 * N minutes. Avoids spamming an inbox with one email per retry; instead a
 * single periodic summary lets the operator skim what went wrong without
 * watching the program log live.
 *
 * Configuration (all optional — module is a no-op when missing):
 *   ALERT_EMAIL_RECIPIENTS  comma-separated list of email addresses
 *   ALERT_EMAIL_INTERVAL_MIN  digest cadence (default 15)
 *   SMTP_USER, SMTP_PASS    Gmail credentials (already used for receipts)
 *   SMTP_ALIAS, SMTP_REPLY_TO  optional From / Reply-To overrides
 */
function startWarnDigest() {
  const recipients = (process.env.ALERT_EMAIL_RECIPIENTS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (recipients.length === 0) {
    logger.info('[WARN DIGEST] ALERT_EMAIL_RECIPIENTS not set — operator email digest disabled.');
    return;
  }
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    logger.warn('[WARN DIGEST] SMTP_USER/SMTP_PASS not set — operator email digest disabled.');
    return;
  }

  const intervalMin = Math.max(1, Number(process.env.ALERT_EMAIL_INTERVAL_MIN) || 15);
  const buffer = []; // { ts, level, message }

  // Collect every WARN/ERROR line emitted while this digester is alive.
  logger.subscribe((level, message) => {
    if (level !== 'WARN' && level !== 'ERROR') return;
    // Don't re-buffer lines from the digester itself or the alert hub
    // (the alert hub already has its own delivery via the /alerts page).
    if (typeof message === 'string' && (message.startsWith('[WARN DIGEST]') || message.startsWith('[ALERT HUB]'))) return;
    buffer.push({ ts: new Date().toISOString(), level, message: String(message).substring(0, 1000) });
    // Cap so a runaway WARN loop can't OOM the process.
    if (buffer.length > 500) buffer.splice(0, buffer.length - 500);
  });

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  async function flush() {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    const errs = batch.filter(b => b.level === 'ERROR').length;
    const warns = batch.filter(b => b.level === 'WARN').length;

    const subject = `[Gateway Park] ${errs} error${errs === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'} in last ${intervalMin}m`;
    const lines = batch.map(b => `[${b.ts}] [${b.level}] ${b.message}`).join('\n');
    const body = `Operator digest from the autonomy engine.\n\nThe following WARN/ERROR log lines were emitted in the last ${intervalMin} minutes:\n\n${lines}\n\n— Auto-generated; reply not monitored.`;

    try {
      await transporter.sendMail({
        from: process.env.SMTP_ALIAS || process.env.SMTP_USER,
        replyTo: process.env.SMTP_REPLY_TO || process.env.SMTP_USER,
        to: recipients.join(','),
        subject,
        text: body
      });
      logger.info(`[WARN DIGEST] Sent digest to ${recipients.length} recipient(s): ${errs} errors, ${warns} warnings.`);
    } catch (err) {
      // Re-buffer the batch so the next interval gets a chance. Log via
      // console.error directly so we don't recurse through our own tap.
      console.error('[WARN DIGEST] Failed to send digest:', err.message);
      buffer.unshift(...batch);
    }
  }

  const handle = setInterval(flush, intervalMin * 60 * 1000);
  // Don't pin Node's event loop to the digest interval at shutdown.
  if (handle.unref) handle.unref();
  logger.info(`[WARN DIGEST] Operator digest enabled — every ${intervalMin}m to ${recipients.length} recipient(s).`);
}

module.exports = { startWarnDigest };
