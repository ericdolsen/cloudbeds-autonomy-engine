const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

/**
 * AlertHub — central sink for `alertFrontDesk` escalations and any
 * server-side fail-path that needs immediate staff attention.
 *
 * Holds the set of un-acknowledged alerts and broadcasts changes via
 * Socket.IO to the `alerts` room. The /alerts page joins that room and
 * renders + chimes on `alert:new`, dismisses on `alert:ack`.
 *
 * Two reliability features:
 *
 *   1. Persistence. The active list is mirrored to data/active_alerts.json
 *      on every publish/ack, and rehydrated on boot. A restart no longer
 *      silently wipes alerts that staff hasn't acked yet.
 *
 *   2. Dedupe / coalesce. If the same urgency + message (first 80 chars
 *      after a light normalization) fires again within DEDUPE_WINDOW_MS,
 *      we increment the existing alert's `count` and `lastSeenAt`
 *      instead of creating a fresh row. This keeps a stuck condition
 *      (door-code resync failing every 30s, etc.) from drowning the
 *      console while still letting staff see the cadence.
 *
 * Acknowledgment is global: one click on any device removes the alert
 * everywhere and clears its fingerprint so the next firing is a fresh
 * row.
 */

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE_PATH = path.join(DATA_DIR, 'active_alerts.json');
const DEDUPE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function _fingerprint(urgency, message) {
  const norm = (message || '')
    .toString()
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 80)
    .toLowerCase();
  return `${(urgency || 'high').toLowerCase()}::${norm}`;
}

class AlertHub {
  constructor(io) {
    this.io = io;
    this.active = new Map();            // id -> alert
    this._fingerprintIndex = new Map(); // fingerprint -> id
    this._nextId = 1;
    this._loadFromDisk();
  }

  _loadFromDisk() {
    try {
      if (!fs.existsSync(FILE_PATH)) return;
      const raw = fs.readFileSync(FILE_PATH, 'utf8');
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      let maxId = 0;
      for (const a of parsed) {
        if (!a || !a.id || !a.message) continue;
        // Backfill fields that older serialized rows may not have so the
        // alerts.html render path doesn't NaN on a freshly upgraded box.
        if (typeof a.count !== 'number' || a.count < 1) a.count = 1;
        if (typeof a.lastSeenAt !== 'number') a.lastSeenAt = a.createdAt || Date.now();
        this.active.set(a.id, a);
        this._fingerprintIndex.set(_fingerprint(a.urgency, a.message), a.id);
        const n = parseInt(a.id, 10);
        if (Number.isFinite(n) && n > maxId) maxId = n;
      }
      this._nextId = maxId + 1;
      if (this.active.size > 0) {
        logger.info(`[ALERT HUB] Rehydrated ${this.active.size} unacked alert${this.active.size === 1 ? '' : 's'} from ${path.basename(FILE_PATH)}.`);
      }
    } catch (e) {
      logger.warn(`[ALERT HUB] Could not load active alerts from disk (${e.message}); starting empty.`);
    }
  }

  _persist() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const list = Array.from(this.active.values());
      fs.writeFileSync(FILE_PATH, JSON.stringify(list), 'utf8');
    } catch (e) {
      logger.warn(`[ALERT HUB] Failed to persist active alerts: ${e.message}`);
    }
  }

  publish({ urgency, issueDescription }) {
    const norm = ((urgency || 'high') + '').toLowerCase();
    const message = (issueDescription || 'Untitled alert').toString();
    const fp = _fingerprint(norm, message);
    const now = Date.now();

    // Coalesce onto an existing unacked alert with the same fingerprint
    // if it was last seen within the dedupe window. We re-emit `alert:new`;
    // the page treats existing IDs as updates and skips chiming.
    const existingId = this._fingerprintIndex.get(fp);
    if (existingId) {
      const existing = this.active.get(existingId);
      if (existing && (now - (existing.lastSeenAt || existing.createdAt)) < DEDUPE_WINDOW_MS) {
        existing.count = (existing.count || 1) + 1;
        existing.lastSeenAt = now;
        this._persist();
        if (this.io) this.io.to('alerts').emit('alert:new', existing);
        logger.warn(`[ALERT HUB] ${norm.toUpperCase()} (x${existing.count}): ${message.substring(0, 200)}`);
        return existing;
      }
      // Stale fingerprint (existing alert was acked or expired). Drop it
      // and fall through to fresh-alert creation below.
      this._fingerprintIndex.delete(fp);
    }

    const alert = {
      id: String(this._nextId++),
      urgency: norm,
      message,
      createdAt: now,
      lastSeenAt: now,
      count: 1
    };
    this.active.set(alert.id, alert);
    this._fingerprintIndex.set(fp, alert.id);
    this._persist();
    if (this.io) this.io.to('alerts').emit('alert:new', alert);
    logger.warn(`[ALERT HUB] ${norm.toUpperCase()}: ${message.substring(0, 200)}`);
    return alert;
  }

  ack(id) {
    const alert = this.active.get(id);
    if (!alert) return false;
    this.active.delete(id);
    // Drop the fingerprint mapping so the next firing of this condition
    // creates a fresh alert rather than silently adding to a count nobody
    // is watching.
    for (const [fp, alertId] of this._fingerprintIndex.entries()) {
      if (alertId === id) {
        this._fingerprintIndex.delete(fp);
        break;
      }
    }
    this._persist();
    if (this.io) this.io.to('alerts').emit('alert:ack', { id });
    logger.info(`[ALERT HUB] Acked ${alert.urgency.toUpperCase()}: ${alert.message.substring(0, 80)}`);
    return true;
  }

  listActive() {
    return Array.from(this.active.values()).sort((a, b) => b.createdAt - a.createdAt);
  }
}

module.exports = { AlertHub };
