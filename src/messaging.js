const axios = require('axios');
const { logger } = require('./logger');

/**
 * Provider-neutral outbound messaging client.
 *
 * Set MESSAGING_PROVIDER=twilio | whistle | none (default: none, which logs
 * what would have been sent but doesn't actually deliver — safe for dev).
 *
 * Twilio env vars:   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
 * Whistle env vars:  WHISTLE_API_KEY, WHISTLE_API_BASE (optional)
 */
class MessagingClient {
  constructor() {
    this.provider = (process.env.MESSAGING_PROVIDER || 'none').toLowerCase();
  }

  async send(toPhone, text) {
    if (!toPhone || !text) {
      logger.warn('[MESSAGING] send called without phone or text; skipping.');
      return { success: false, error: 'Missing phone or text' };
    }

    const clean = String(toPhone).replace(/[^\d+]/g, '');
    logger.info(`[MESSAGING] provider=${this.provider} to=${clean} (${text.length} chars)`);

    switch (this.provider) {
      case 'twilio':  return this._sendTwilio(clean, text);
      case 'whistle': return this._sendWhistle(clean, text);
      case 'none':
      default:
        logger.warn(`[MESSAGING] No provider configured. Dry-run: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
        return { success: true, dryRun: true };
    }
  }

  async _sendTwilio(to, body) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM;
    if (!sid || !token || !from) {
      logger.error('[MESSAGING] Twilio credentials incomplete; cannot send.');
      return { success: false, error: 'Twilio not configured' };
    }
    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
      const form = new URLSearchParams({ To: to, From: from, Body: body });
      const resp = await axios.post(url, form, {
        auth: { username: sid, password: token },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      return { success: true, sid: resp.data.sid };
    } catch (e) {
      logger.error(`[MESSAGING] Twilio send failed: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  async _sendWhistle(to, body) {
    const key = process.env.WHISTLE_API_KEY;
    const base = process.env.WHISTLE_API_BASE || 'https://api.whistle.com/v1';
    if (!key) {
      logger.error('[MESSAGING] WHISTLE_API_KEY missing; cannot send.');
      return { success: false, error: 'Whistle not configured' };
    }
    try {
      const resp = await axios.post(`${base}/messages`, { to, body, channel: 'sms' }, {
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }
      });
      return { success: true, id: resp.data && resp.data.id };
    } catch (e) {
      logger.error(`[MESSAGING] Whistle send failed: ${e.message}`);
      return { success: false, error: e.message };
    }
  }
}

module.exports = { MessagingClient };
