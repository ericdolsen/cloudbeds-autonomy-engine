const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'reservations_cache.json');

class ReservationCache {
  constructor() {
    this.cache = new Map(); // reservationId -> Full Reservation Data
    this._loadFromDisk();
  }

  _loadFromDisk() {
    try {
      if (fs.existsSync(CACHE_FILE)) {
        const data = fs.readFileSync(CACHE_FILE, 'utf-8');
        const list = JSON.parse(data);
        for (const item of list) {
          const id = item.reservationID || item.reservationId;
          if (id) this.cache.set(id, item);
        }
        logger.info(`[CACHE] Loaded ${this.cache.size} reservations from local disk.`);
      }
    } catch (e) {
      logger.error(`[CACHE] Failed to load cache from disk: ${e.message}`);
    }
  }

  _saveToDisk() {
    try {
      const data = Array.from(this.cache.values());
      const dir = path.dirname(CACHE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      logger.error(`[CACHE] Failed to save cache to disk: ${e.message}`);
    }
  }

  /**
   * Initializes the cache by fetching recent and future reservations from Cloudbeds.
   */
  async syncFromCloudbeds(cloudbedsApi) {
    logger.info(`[CACHE] Starting background sync from Cloudbeds...`);
    try {
      const past = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
      const future = new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0];
      
      const resList = await cloudbedsApi.getReservations(past, future);
      if (resList.success && Array.isArray(resList.data)) {
        let added = 0;
        for (const r of resList.data) {
          const id = r.reservationID || r.reservationId;
          if (id) {
            this.cache.set(id, r);
            added++;
          }
        }
        this._saveToDisk();
        logger.info(`[CACHE] Background sync complete. Updated ${added} active reservations.`);
      }
    } catch (e) {
      logger.error(`[CACHE] Background sync failed: ${e.message}`);
    }
  }

  /**
   * Called via webhook when a reservation is updated.
   */
  async updateReservation(reservationId, cloudbedsApi) {
    try {
      const resData = await cloudbedsApi.getReservationById(reservationId);
      if (resData.success && resData.data) {
        const id = resData.data.reservationID || resData.data.reservationId;
        this.cache.set(id, resData.data);
        this._saveToDisk();
        logger.info(`[CACHE] Real-time update for ${id} applied to local cache.`);
        return true;
      }
    } catch (e) {
      logger.error(`[CACHE] Failed to fetch updated reservation ${reservationId}: ${e.message}`);
    }
    return false;
  }

  getReservationById(reservationId) {
    return this.cache.get(reservationId) || null;
  }

  /**
   * Cloudbeds returns multi-room bookings as one parent reservation plus
   * suffixed siblings: "42JVT4PXTB", "42JVT4PXTB-2", ..., "42JVT4PXTB-17".
   * The parent has no suffix; siblings always end in `-\d+`. There's no
   * explicit parentReservationID field in the API response, so we have
   * to derive the group key from the ID itself.
   */
  _parentPrefix(reservationId) {
    if (!reservationId) return null;
    return String(reservationId).replace(/-\d+$/, '');
  }

  /**
   * Return every cached reservation that shares a parent prefix with the
   * given ID, including the input itself if present. Used by the kiosk's
   * multi-room chooser. Caller is responsible for any further filtering
   * (today-only, status, etc.).
   */
  findSiblings(reservationId) {
    const prefix = this._parentPrefix(reservationId);
    if (!prefix) return [];
    const results = [];
    for (const r of this.cache.values()) {
      const id = r.reservationID || r.reservationId;
      if (!id) continue;
      if (this._parentPrefix(id) === prefix) results.push(r);
    }
    return results;
  }

  /**
   * Match a name needle against a reservation's primary guest fields
   * AND every entry in its guestList. The list-level check matters for
   * multi-room bookings where Aunt Sue is the parent's main guest but
   * each sub-reservation has its own guest profile attached — Nephew
   * Joe should still find his room by typing "Smith".
   */
  _reservationMatchesName(r, needle) {
    if ((r.guestName && r.guestName.toLowerCase().includes(needle)) ||
        (r.guestFirstName && r.guestFirstName.toLowerCase() === needle) ||
        (r.guestLastName && r.guestLastName.toLowerCase() === needle)) {
      return true;
    }
    if (r.guestList && typeof r.guestList === 'object') {
      for (const g of Object.values(r.guestList)) {
        if (!g) continue;
        if ((g.guestName && g.guestName.toLowerCase().includes(needle)) ||
            (g.guestFirstName && g.guestFirstName.toLowerCase() === needle) ||
            (g.guestLastName && g.guestLastName.toLowerCase() === needle)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Instantly queries the local cache by name or phone.
   */
  search(query, mode) {
    const isName = /^[a-zA-Z\s'\-]+$/.test(query) && query.length >= 2;
    const isPhone = /^\+?[\d\s\-\(\)]{7,20}$/.test(query) && query.replace(/[^\d]/g, '').length >= 4;

    if (!isName && !isPhone) {
      return null;
    }

    const today = new Date().toISOString().split('T')[0];
    let matches = [];

    const allReservations = Array.from(this.cache.values());

    if (isName) {
      const needle = query.trim().toLowerCase();
      matches = allReservations.filter(r => this._reservationMatchesName(r, needle));
    } else if (isPhone) {
      const needle = query.replace(/[^\d]/g, '');
      matches = allReservations.filter(r => {
        if (!r.guestList) return false;
        return Object.values(r.guestList).some(g => {
          const cell = g.guestCellPhone ? g.guestCellPhone.toString().replace(/[^\d]/g, '') : '';
          const phone = g.guestPhone ? g.guestPhone.toString().replace(/[^\d]/g, '') : '';
          return (cell && cell.includes(needle)) || (phone && phone.includes(needle));
        });
      });
    }

    if (matches.length > 0) {
      // Diagnostic: log every match the cache produced for this query so we
      // can tell, when a kiosk lookup fails, whether the cache is missing
      // a brand-new reservation or just has stale entries for the same name.
      const matchSummary = matches
        .slice(0, 6)
        .map(r => `${r.reservationID || r.reservationId}/${r.startDate || '?'}`)
        .join(', ');
      logger.info(`[CACHE SEARCH] query="${query}" mode=${mode} today=${today} matches=${matches.length} [${matchSummary}${matches.length > 6 ? ', …' : ''}]`);

      // Find the most relevant match for today
      const exactMatch = matches.find(r => {
        if (mode === 'checkin') return r.startDate === today;
        if (mode === 'checkout') return r.endDate === today || r.status === 'checked_in';
        if (mode === 'print') return r.startDate === today || r.endDate === today || r.status === 'checked_in' || r.status === 'checked_out';
        return true;
      });

      if (exactMatch) {
        return { success: true, data: exactMatch };
      }

      if (mode === 'checkin') {
        const futureRes = matches.find(r => r.startDate > today);
        if (futureRes) {
          return { success: false, message: `We found a reservation for you, but your check-in date is ${futureRes.startDate}. You can only check in on your arrival date.` };
        }
      }
      return { success: false, message: "We found a reservation under your details, but it is not scheduled for today. Please see the front desk." };
    }

    return { success: false, message: "Could not find an active reservation matching that name." };
  }
}

// Export as a singleton
const reservationCache = new ReservationCache();
module.exports = { reservationCache };
