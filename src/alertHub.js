const { logger } = require('./logger');

/**
 * AlertHub — central sink for `alertFrontDesk` escalations.
 *
 * Holds the set of un-acknowledged alerts in memory and broadcasts changes
 * via Socket.IO to the `alerts` room. The /alerts page joins that room and
 * renders + chimes on `alert:new`, dismisses on `alert:ack`.
 *
 * Acknowledgment is global: one click on any device removes the alert
 * everywhere. Restart wipes the active list (the program log keeps the
 * trail).
 */
class AlertHub {
  constructor(io) {
    this.io = io;
    this.active = new Map(); // id -> alert
    this._nextId = 1;
  }

  publish({ urgency, issueDescription }) {
    const alert = {
      id: String(this._nextId++),
      urgency: ((urgency || 'high') + '').toLowerCase(),
      message: (issueDescription || 'Untitled alert').toString(),
      createdAt: Date.now()
    };
    this.active.set(alert.id, alert);
    if (this.io) this.io.to('alerts').emit('alert:new', alert);
    logger.warn(`[ALERT HUB] ${alert.urgency.toUpperCase()}: ${alert.message.substring(0, 200)}`);
    return alert;
  }

  ack(id) {
    const alert = this.active.get(id);
    if (!alert) return false;
    this.active.delete(id);
    if (this.io) this.io.to('alerts').emit('alert:ack', { id });
    logger.info(`[ALERT HUB] Acked ${alert.urgency.toUpperCase()}: ${alert.message.substring(0, 80)}`);
    return true;
  }

  listActive() {
    return Array.from(this.active.values()).sort((a, b) => b.createdAt - a.createdAt);
  }
}

module.exports = { AlertHub };
