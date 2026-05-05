const axios = require('axios');
const { logger } = require('./logger');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Cloudbeds REST API wrapper
 * Falls back to mock data when CLOUDBEDS_API_KEY is unset or 'MOCK_KEY'.
 *
 * The Cloudbeds PMS API expects POST/PUT bodies as application/x-www-form-urlencoded,
 * NOT JSON. All write helpers go through _encodeForm().
 */
class CloudbedsAPI {
  constructor() {
    this.host = process.env.CLOUDBEDS_HOST || 'https://hotels.cloudbeds.com/api/v1.3';
    this.apiKey = process.env.CLOUDBEDS_API_KEY || 'MOCK_KEY';
    this.propertyID = process.env.CLOUDBEDS_PROPERTY_ID || null;
  }

  async _mockReturn(data, delayMs = 300) {
    return new Promise(resolve => setTimeout(() => resolve(data), delayMs));
  }

  _getClient() {
    return axios.create({
      baseURL: this.host,
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });
  }

  /**
   * Convert a plain object to URLSearchParams, skipping nullish values.
   * Attaches propertyID automatically when the env var is set.
   */
  _encodeForm(data, { attachProperty = true } = {}) {
    const params = new URLSearchParams();
    if (attachProperty && this.propertyID && !('propertyID' in data)) {
      params.append('propertyID', this.propertyID);
    }
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined || v === null) continue;
      params.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    return params;
  }

  _formHeaders() {
    return { 'Content-Type': 'application/x-www-form-urlencoded' };
  }

  _isMock() {
    return this.apiKey === 'MOCK_KEY';
  }

  /**
   * Fetch reservation details by searching for name, phone, or reservation ID.
   * When a name is supplied we fall back to a getReservations scan.
   */
  async getReservation(query, mode) {
    logger.info(`[API CALL] GET /getReservation | query: ${query} | mode: ${mode}`);

    if (this._isMock()) {
      if (query && query.toLowerCase() === 'smith') {
        return this._mockReturn({
          success: true,
          data: {
            reservationID: "RD98273410",
            guestName: "Amanda Smith",
            status: "confirmed",
            guestList: {
              "g_1": { isMainGuest: true, guestCellPhone: "5558278492", guestEmail: "amanda@example.com" }
            }
          }
        });
      }

      return this._mockReturn({
        success: true,
        data: {
          reservationID: "JD10029384",
          status: "checked_in",
          guestName: "John Doe",
          balanceDue: 45.00,
          currency: "USD",
          roomType: "Standard Queen",
          startDate: "2026-04-10",
          endDate: "2026-04-12",
          guestList: {
            "g_1": { isMainGuest: true, guestCellPhone: "5552219988", guestEmail: "john@example.com" }
          },
          tags: ["VIP"]
        }
      });
    }

    try {
      const isName = /^[a-zA-Z\s'\-]+$/.test(query) && query.length >= 2;
      const isPhone = /^\+?[\d\s\-\(\)]{7,20}$/.test(query) && query.replace(/[^\d]/g, '').length >= 4; // allow last 4 or full

      if (isName || isPhone) {
        logger.info(`[API CALL] Delegating search "${query}" to fast local ReservationCache...`);
        const { reservationCache } = require('./reservationCache');

        // 1. Check local cache (we still want this for useful error messages even if we bypass it for success)
        let cacheResult = null;
        if (reservationCache.cache.size > 0) {
          cacheResult = reservationCache.search(query, mode);
        }

        // For check-ins, ALWAYS pull live data first to ensure we have ALL siblings
        // of a multi-room group. If we just relied on a partial cache hit, the 
        // multi-room chooser wouldn't trigger for the missing rooms.
        if (mode === 'checkin') {
          logger.info(`[API CALL] Forcing live query for check-in to guarantee multi-room sibling sync.`);
          const liveResult = await this._searchLiveForCheckin({ query, mode, isName, isPhone });
          if (liveResult && liveResult.success && liveResult.data) {
            const id = liveResult.data.reservationID || liveResult.data.reservationId;
            if (id) {
              reservationCache.cache.set(id, liveResult.data);
              logger.info(`[CACHE] Primed with live result ${id}.`);
            }
            return liveResult;
          }
        } else if (cacheResult && cacheResult.success) {
          return cacheResult;
        }

        // 2. Cache miss or non-checkin. Fall back to live query if we haven't already.
        if (mode !== 'checkin') {
          logger.info(`[API CALL] Cache miss — checking live Cloudbeds.`);
          const liveResult = await this._searchLiveForCheckin({ query, mode, isName, isPhone });
          if (liveResult && liveResult.success && liveResult.data) {
            const id = liveResult.data.reservationID || liveResult.data.reservationId;
            if (id) {
              reservationCache.cache.set(id, liveResult.data);
              logger.info(`[CACHE] Primed with live result ${id}.`);
            }
            return liveResult;
          }
        }

        // 3. Both layers missed. Prefer the cache's specific message if it
        //    had one (e.g. "your check-in is on 5/1") — it's more useful to
        //    the guest than a generic "not found".
        if (cacheResult) return cacheResult;
        return { success: false, message: "Could not find an active reservation matching that name." };
      }

      // If it's not a name or phone, it's a direct ID lookup (like a QR code or exact res string)
      return await this.getReservationById(query);
    } catch (error) {
      logger.error(`getReservation failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Live-API fallback for the kiosk lookup path. Used when the local cache
   * either is empty (cold boot) or has no current-day match (stale cache —
   * a reservation was created today but the webhook hasn't propagated yet).
   * Scoped to today's date range to keep the call cheap; on success we
   * return the full reservation record so the caller can prime the cache.
   */
  async _searchLiveForCheckin({ query, mode, isName, isPhone }) {
    const today = new Date().toISOString().split('T')[0];
    try {
      const resList = await this.getReservations(today, today);
      if (!resList || !resList.success || !Array.isArray(resList.data)) return null;

      // Prime the cache with the full today list. This matters for multi-
      // room bookings: the kiosk identify route calls reservationCache
      // .findSiblings(...) to build the chooser, which only works if every
      // sibling is in the cache. Priming ALL of today's records (not just
      // the matched one) ensures sub-reservations booked together show up
      // together in the chooser even if no webhook fired.
      try {
        const { reservationCache } = require('./reservationCache');
        for (const r of resList.data) {
          const id = r.reservationID || r.reservationId;
          if (id) reservationCache.cache.set(id, r);
        }
      } catch (e) { /* non-fatal: priming is an optimization */ }

      let matches = [];
      if (isName) {
        const needle = query.trim().toLowerCase();
        const matchesName = (r) => {
          if ((r.guestName && r.guestName.toLowerCase().includes(needle)) ||
              (r.guestFirstName && r.guestFirstName.toLowerCase() === needle) ||
              (r.guestLastName && r.guestLastName.toLowerCase() === needle)) return true;
          // Multi-room bookings: each sub-reservation may carry its own
          // guest profile in guestList. Match those too so a guest who
          // shows up under their own name finds their sub-reservation
          // even when the parent's main guestName is the booker.
          if (r.guestList && typeof r.guestList === 'object') {
            for (const g of Object.values(r.guestList)) {
              if (!g) continue;
              if ((g.guestName && g.guestName.toLowerCase().includes(needle)) ||
                  (g.guestFirstName && g.guestFirstName.toLowerCase() === needle) ||
                  (g.guestLastName && g.guestLastName.toLowerCase() === needle)) return true;
            }
          }
          return false;
        };
        matches = resList.data.filter(matchesName);
      } else if (isPhone) {
        const needle = query.replace(/[^\d]/g, '');
        matches = resList.data.filter(r => {
          if (!r.guestList) return false;
          return Object.values(r.guestList).some(g => {
            const cell = g.guestCellPhone ? g.guestCellPhone.toString().replace(/[^\d]/g, '') : '';
            const phone = g.guestPhone ? g.guestPhone.toString().replace(/[^\d]/g, '') : '';
            return (cell && cell.includes(needle)) || (phone && phone.includes(needle));
          });
        });
      }

      if (matches.length === 0) return null;

      // For check-in mode, narrow to today's arrivals; for everything else
      // accept any match the live query returned.
      const exactMatch = matches.find(r => {
        if (mode === 'checkin') return r.startDate === today;
        if (mode === 'checkout') return r.endDate === today || r.status === 'checked_in';
        if (mode === 'print') return r.startDate === today || r.endDate === today || r.status === 'checked_in' || r.status === 'checked_out';
        return true;
      });
      if (!exactMatch) return null;

      const id = exactMatch.reservationID || exactMatch.reservationId;
      logger.info(`[API CALL] Live-API resolved "${query}" to ${id}.`);
      return await this.getReservationById(id);
    } catch (e) {
      logger.warn(`[API CALL] Live fallback failed: ${e.message}`);
      return null;
    }
  }

  async getReservationById(reservationID) {
    if (this._isMock()) {
      return this.getReservation(reservationID);
    }
    try {
      const response = await this._getClient().get('/getReservation', {
        params: {
          reservationID,
          ...(this.propertyID ? { propertyID: this.propertyID } : {}),
          includeGuestsDetails: 'true',
          // Surface the customFields array (e.g. portal_doorcode from
          // the Goki/Portal lock integration) so the agent can read
          // door codes for guests who report lock issues.
          includeCustomFields: 'true'
        }
      });
      return response.data;
    } catch (error) {
      logger.error(`getReservationById failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Pull a single custom-field value off a reservation by its shortcode
   * (e.g. 'portal_doorcode'). Returns null if the reservation has no
   * customFields array, no matching entry, or an empty value.
   */
  extractCustomField(reservationData, shortcode) {
    if (!reservationData || !shortcode) return null;
    const fields = reservationData.customFields;
    if (!Array.isArray(fields)) return null;
    const match = fields.find(f => f && (
      f.customFieldShortcode === shortcode ||
      f.customFieldName === shortcode ||
      f.shortcode === shortcode
    ));
    if (!match) return null;
    const value = match.customFieldValue || match.value || '';
    return value && value.toString().trim() ? value.toString().trim() : null;
  }

  /**
   * Parse Portal/Goki's portal_doorcode field into structured pairs.
   * Portal writes a single string like:
   *   "Jose Emigdio 215: 1618, 204: 4538"
   * for multi-room bookings, with each room+code separated by a comma.
   * The guest name prefix is ignored — we match `<roomNum>: <code>`
   * patterns and return them in the order they appear.
   *
   * Returns: [{ room: '215', code: '1618' }, { room: '204', code: '4538' }]
   * Empty array on null/empty/unrecognized input.
   */
  parseDoorCodes(rawValue) {
    if (!rawValue) return [];
    const re = /(\d{1,4})\s*[:\-]\s*(\d{3,8})/g;
    const out = [];
    let m;
    while ((m = re.exec(rawValue))) {
      out.push({ room: m[1], code: m[2] });
    }
    return out;
  }

  async getUnassignedRooms(startDate, endDate) {
    logger.info(`[API CALL] getUnassignedRooms (Synthesized) | ${startDate} to ${endDate}`);
    if (this._isMock()) {
      return this._mockReturn({
        success: true,
        data: [
          { roomId: "101", roomType: "Standard Queen", nightlyRate: 150 },
          { roomId: "204", roomType: "King Suite (with Tub)", nightlyRate: 195 }
        ]
      });
    }
    try {
      // 1. Get all physical rooms
      const roomsRes = await this._getClient().get('/getRooms', {
        params: this.propertyID ? { propertyID: this.propertyID } : {}
      });
      const allRooms = (roomsRes.data && roomsRes.data.data && roomsRes.data.data[0] && roomsRes.data.data[0].rooms) ? roomsRes.data.data[0].rooms : [];

      // 2. Get all reservations intersecting these dates
      const resData = await this.getReservations(startDate, endDate);
      const activeReservations = resData.success ? resData.data : [];

      // 3. Find rooms that are assigned
      const assignedRoomIDs = new Set();
      activeReservations.forEach(r => {
        if (r.status === 'canceled' || r.status === 'no_show') return;
        if (r.guestList) {
          Object.values(r.guestList).forEach(guest => {
            if (guest.rooms && Array.isArray(guest.rooms)) {
              guest.rooms.forEach(rm => {
                assignedRoomIDs.add(rm.roomID);
              });
            }
          });
        }
      });

      // 4. Filter to unassigned rooms
      const unassigned = allRooms.filter(room => !assignedRoomIDs.has(room.roomID)).map(r => ({
        roomName: r.roomName, // human-readable name, e.g. "204"
        roomId: r.roomID,     // actual cloudbeds ID needed for assignment, e.g. "12676007973093-5"
        roomTypeID: r.roomTypeID,
        roomType: r.roomTypeName,
        doorlockID: r.doorlockID || ''
      }));

      return { success: true, data: unassigned };
    } catch (error) {
      logger.error(`getUnassignedRooms failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * POST /postRoomAssign — explicitly assigns a room to a reservation.
   */
  async assignRoom(reservationId, newRoomID, roomTypeID) {
    logger.info(`[API CALL] POST /postRoomAssign [${reservationId}] | newRoomID: ${newRoomID} | roomTypeID: ${roomTypeID}`);
    if (this._isMock()) {
      return this._mockReturn({ success: true, message: "Room assigned." });
    }
    try {
      let oldRoomID = undefined;
      const resData = await this.getReservationById(reservationId);
      const guestList = resData && resData.data ? resData.data.guestList : (resData ? resData.guestList : null);
      if (guestList) {
        Object.values(guestList).forEach(g => {
           if (g.rooms && g.rooms.length > 0 && g.rooms[0].roomID) {
               oldRoomID = g.rooms[0].roomID;
           }
        });
      }

      const payload = { reservationID: reservationId, newRoomID };
      if (oldRoomID) {
         payload.oldRoomID = oldRoomID;
      } else if (roomTypeID) {
         payload.roomTypeID = roomTypeID;
      }

      const body = this._encodeForm(payload);
      const response = await this._getClient().post('/postRoomAssign', body, { headers: this._formHeaders() });
      return response.data;
    } catch (error) {
      logger.error(`assignRoom failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * PUT /putReservation — update reservation fields (dates, room, status).
   * Note: Cloudbeds permits status transitions to confirmed, checked_out,
   * canceled, no_show via this endpoint. For check-in use checkInReservation().
   */
  async updateReservation(reservationId, updates) {
    logger.info(`[API CALL] PUT /putReservation [${reservationId}] | payload: ${JSON.stringify(updates)}`);
    if (this._isMock()) {
      return this._mockReturn({ success: true, message: "Reservation updated." });
    }
    try {
      const body = this._encodeForm({ reservationID: reservationId, ...updates });
      const response = await this._getClient().put('/putReservation', body, { headers: this._formHeaders() });
      return response.data;
    } catch (error) {
      logger.error(`updateReservation failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Move a reservation into the checked_in state. Cloudbeds only permits this
   * transition from `confirmed`; we guard for that and surface a clear error.
   */
  async checkInReservation(reservationId) {
    logger.info(`[API CALL] CHECK-IN [${reservationId}]`);
    if (this._isMock()) {
      return this._mockReturn({ success: true, message: "Reservation checked in." });
    }
    try {
      const existing = await this.getReservationById(reservationId);
      if (!existing.success || !existing.data) {
        return { success: false, error: "Reservation not found." };
      }
      const status = existing.data.status;
      const balance = parseFloat(existing.data.balance || 0);

      if (status === 'checked_in') {
        return { success: true, message: "Reservation is already checked in." };
      }
      if (status !== 'confirmed') {
        return { success: false, error: `Reservation must be 'confirmed' before check-in (current: ${status}).` };
      }

      if (balance > 5.00) {
        return { 
          success: false, 
          error: `CRITICAL STOP: Cannot check in reservation ${reservationId} because it still has an outstanding balance of $${balance.toFixed(2)}. You MUST collect payment via chargePhysicalTerminal first, or escalate to the front desk.` 
        };
      }

      const body = this._encodeForm({
        reservationID: reservationId,
        status: 'checked_in'
      });
      const response = await this._getClient().put('/putReservation', body, { headers: this._formHeaders() });
      return response.data;
    } catch (error) {
      logger.error(`checkInReservation failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * POST /postPayment — add a payment to a reservation folio.
   * type must be one of: credit, debit, cash, check.
   */
  async postPayment(reservationId, amount, { type = 'credit', description = 'Kiosk payment' } = {}) {
    logger.info(`[API CALL] POST /postPayment [${reservationId}] | Amount: $${amount} | Type: ${type}`);
    if (this._isMock()) {
      return this._mockReturn({ success: true, transactionID: "txn_mock_001", message: "Payment processed." });
    }
    try {
      const body = this._encodeForm({ reservationID: reservationId, amount, type, description });
      const response = await this._getClient().post('/postPayment', body, { headers: this._formHeaders() });
      return response.data;
    } catch (error) {
      logger.error(`postPayment failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * POST /postCustomItem — add a line item / charge to the guest's folio.
   * Cloudbeds requires appItemID so repeat posts de-duplicate; we default
   * it to a stable slug derived from the description.
   */
  async postCustomItem(reservationId, amount, description, { appItemID } = {}) {
    logger.info(`[API CALL] POST /postCustomItem [${reservationId}] | Amount: $${amount} | Desc: ${description}`);
    if (this._isMock()) {
      return this._mockReturn({ success: true, message: "Charge added to folio." });
    }
    try {
      const slug = appItemID || `autonomy_${description.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}`;
      const body = this._encodeForm({
        reservationID: reservationId,
        appItemID: slug,
        name: description,
        description,
        subtotal: amount,
        quantity: 1
      });
      const response = await this._getClient().post('/postCustomItem', body, { headers: this._formHeaders() });
      return response.data;
    } catch (error) {
      logger.error(`postCustomItem failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // Back-compat alias for existing callers
  async postFolioAdjustment(reservationId, amount, description) {
    return this.postCustomItem(reservationId, amount, description);
  }

  /**
   * POST /postAdjustment — apply a discount or surcharge against an existing
   * folio line (room rate, tax, fee, or item). Sign convention is INVERTED
   * vs. postCustomItem: positive `amount` discounts the line by that much,
   * negative `amount` adds an extra charge. This means a single call handles
   * both balance-due and credit reservations when you pass `amount = balance`.
   *
   * Required: reservationID, amount.
   * Targeting (pass via `extras`): subReservationID or roomID for multi-room
   * bookings, plus whatever ID or category the property uses to identify the
   * specific line — Cloudbeds varies by version (e.g., taxID, itemID, type).
   * The probe script (scripts/probeTaxLine.js) discovers these per-property.
   */
  async postAdjustment(reservationID, amount, extras = {}) {
    logger.info(`[API CALL] POST /postAdjustment [${reservationID}] | Amount: ${amount} | Extras: ${JSON.stringify(extras)}`);
    if (this._isMock()) {
      return this._mockReturn({ success: true, message: 'Adjustment posted (mock).' });
    }
    try {
      const body = this._encodeForm({ reservationID, amount, ...extras });
      const response = await this._getClient().post('/postAdjustment', body, { headers: this._formHeaders() });
      return response.data;
    } catch (error) {
      // Surface full body so callers can see validation field details, not
      // just the top-level message. Cloudbeds often includes a per-field
      // breakdown that's invaluable for figuring out the right param shape.
      const body = error.response?.data;
      logger.error(`postAdjustment failed: ${error.message} | body=${JSON.stringify(body)}`);
      return {
        success: false,
        error: body?.message || error.message,
        responseBody: body,
      };
    }
  }

  /**
   * POST /postCharge — record a charge against a reservation. Kept as a
   * fallback for cases where postAdjustment cannot be used (e.g., property
   * configurations that reject negative amounts on adjustments).
   * Primary path is postAdjustment.
   */
  async postCharge(reservationID, amount, extras = {}) {
    logger.info(`[API CALL] POST /postCharge [${reservationID}] | Amount: ${amount} | Extras: ${JSON.stringify(extras)}`);
    if (this._isMock()) {
      return this._mockReturn({ success: true, message: 'Charge posted (mock).' });
    }
    try {
      const body = this._encodeForm({ reservationID, amount, ...extras });
      const response = await this._getClient().post('/postCharge', body, { headers: this._formHeaders() });
      return response.data;
    } catch (error) {
      logger.error(`postCharge failed: ${error.message}`);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Fetch reservations with highly nested financial details for custom reporting.
   */
  async getReservationsWithRateDetails(startDate, endDate) {
    logger.info(`[API CALL] GET /getReservationsWithRateDetails | ${startDate} to ${endDate}`);
    if (this._isMock()) {
      return this._mockReturn({
        success: true,
        data: [
          { reservationID: "R_01", startDate, endDate, status: "checked_in", source: "OTA (Booking.com)", total: 350.00 },
          { reservationID: "R_02", startDate, endDate, status: "no_show", source: "Direct", total: 150.00 },
          { reservationID: "R_03", startDate, endDate, status: "checked_in", source: "OTA (Expedia)", total: 420.00 },
          { reservationID: "R_04", startDate, endDate, status: "checked_in", source: "Direct", total: 80.00 }
        ]
      });
    }
    try {
      const response = await this._getClient().get('/getReservationsWithRateDetails', {
        params: {
          checkInFrom: startDate,
          checkInTo: endDate,
          ...(this.propertyID ? { propertyID: this.propertyID } : {})
        }
      });
      return response.data;
    } catch (error) {
      logger.error(`getReservationsWithRateDetails failed: ${error.message}`);
      return { success: false, data: [] };
    }
  }

  /**
   * Determines if a reservation is "Channel Collect" (OTA collects payment)
   * Uses the hidden source.paymentCollect property from getReservationsWithRateDetails.
   */
  async isChannelCollect(reservationId) {
    if (this._isMock()) return false;
    try {
      // First fetch the reservation dates
      const resData = await this.getReservationById(reservationId);
      if (!resData || !resData.success || !resData.data) return false;

      const r = resData.data;
      const startDate = r.startDate || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
      const endDate = r.endDate || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      const paymentType = (r.paymentType || '').toString().toLowerCase();

      // If Cloudbeds explicitly provides the legacy Channel Collect flag
      if (paymentType === 'channel_collect' || paymentType === 'cc') {
        return true;
      }

      // Fetch extended details to access the hidden source.paymentCollect property
      const extendedData = await this.getReservationsWithRateDetails(startDate, endDate);
      if (extendedData && extendedData.success && Array.isArray(extendedData.data)) {
        const extendedRes = extendedData.data.find(res => res.reservationID === reservationId);
        if (extendedRes && extendedRes.source && extendedRes.source.paymentCollect) {
          if (extendedRes.source.paymentCollect === 'collect') return true;
          if (extendedRes.source.paymentCollect === 'hotel') return false;
        }
      }

      // Fallback legacy checks
      const sourceLegacy = (r.source || '').toString().toLowerCase();
      let guestEmail = r.guestEmail || '';
      if (r.guestList) {
        const guests = Object.values(r.guestList);
        const mg = guests.find(g => g.isMainGuest) || guests[0];
        if (mg && mg.guestEmail) guestEmail = mg.guestEmail;
      }
      guestEmail = guestEmail.toLowerCase();
      
      const isMaskedEmail = guestEmail.includes('expediapartnercentral.com') || guestEmail.includes('guest.booking.com') || guestEmail.includes('agoda.com');
      
      if (isMaskedEmail || sourceLegacy.includes('collect')) {
        return true;
      }
      
      return false;
    } catch (e) {
      // logger.warn is not guaranteed to be defined in cloudbedsApi.js context directly, use console or assume logger is global
      console.warn(`[API] isChannelCollect check failed for ${reservationId}: ${e.message}`);
      return false;
    }
  }

  /**
   * GET /getDashboard — aggregate house metrics (occupancy, ADR, RevPAR, revenue)
   * for a specific date. Returns a normalized { occupiedRooms, roomRevenue, adr,
   * revpar } shape so callers don't need to know about the raw Cloudbeds field
   * names. Name kept as getHouseCount for back-compat with existing callers.
   */
  async getHouseCount(date) {
    logger.info(`[API CALL] GET /getDashboard | ${date}`);
    if (this._isMock()) {
      return this._mockReturn({ success: true, data: { occupiedRooms: 40, roomRevenue: 4200.50, adr: 105.01, revpar: 84.01 } });
    }
    try {
      const response = await this._getClient().get('/getDashboard', {
        params: { date, ...(this.propertyID ? { propertyID: this.propertyID } : {}) }
      });
      const raw = response.data && response.data.data ? response.data.data : {};
      // Cloudbeds returns keys under nested `occupancy` / `revenue` objects
      // depending on property type. Flatten to the shape the rest of the app
      // already expects.
      const occ = raw.occupancy || {};
      const rev = raw.revenue || raw.roomRevenue || {};
      const normalized = {
        occupiedRooms: raw.occupiedRooms ?? occ.occupiedRooms ?? occ.roomsSold ?? 0,
        totalRooms:    raw.totalRooms    ?? occ.totalRooms    ?? 0,
        roomRevenue:   raw.roomRevenue   ?? rev.roomRevenue   ?? rev.total ?? 0,
        adr:           raw.adr           ?? occ.adr           ?? 0,
        revpar:        raw.revpar        ?? occ.revpar        ?? 0
      };
      return { success: true, data: normalized };
    } catch (e) {
      logger.error(`getHouseCount (getDashboard) failed: ${e.message}`);
      return { success: false, data: {} };
    }
  }

  async getTransactions(startDate, endDate) {
    logger.info(`[API CALL] POST /accounting/v1.0/transactions | ${startDate} to ${endDate}`);
    if (this._isMock()) {
      return this._mockReturn({ success: true, data: [] });
    }
    try {
      const collected = [];
      const pageSize = 100;
      let pageToken = null;
      while (true) {
        const response = await this._getClient().post('https://api.cloudbeds.com/accounting/v1.0/transactions', {
          limit: pageSize,
          pageToken: pageToken,
          filters: {
            and: [
              { operator: 'greater_than_or_equal', field: 'service_date', value: startDate },
              { operator: 'less_than_or_equal', field: 'service_date', value: endDate }
            ]
          }
        }, {
          headers: {
            'Content-Type': 'application/json',
            ...(this.propertyID ? { 'X-PROPERTY-ID': this.propertyID } : {})
          }
        });
        const page = (response.data && response.data.transactions) ? response.data.transactions : [];
        collected.push(...page);
        pageToken = response.data ? response.data.nextPageToken : null;
        if (!pageToken) break;
        await sleep(150); // Be nice to rate limits
      }
      
      let mapped = collected;
      if (collected.length > 0) {
        mapped = collected.map(t => {
          const code = t.internalTransactionCode || '';
          const transactionAmount = parseFloat(t.amount || 0);
          
          let type = '';
          if (code.startsWith('9')) type = 'Payment';
          else if (code.startsWith('2') || code.startsWith('3') || code.startsWith('4')) type = 'Items & Services';

          let transactionCategory = '';
          if (code.startsWith('1')) transactionCategory = 'rate';
          else if (code.startsWith('8')) transactionCategory = 'tax';
          else if (code.startsWith('9')) transactionCategory = 'payment';
          else transactionCategory = 'custom_item';

          if (code.endsWith('A')) transactionCategory = 'adjustment';

          let roomRevenueType = '';
          if (code.startsWith('1') && !code.endsWith('V') && !code.endsWith('A')) roomRevenueType = 'Room Rate';
          if (t.description === 'Room Revenue - Manual') roomRevenueType = 'Room Rate';

          return {
            ...t,
            transactionDate: t.serviceDate || (t.transactionDatetime ? t.transactionDatetime.split('T')[0] : ''),
            transactionAmount: transactionAmount,
            transactionType: type,
            roomRevenueType: roomRevenueType,
            transactionCategory: transactionCategory,
            transactionCodeDescription: t.description || '',
            transactionVoid: code.endsWith('V'),
            // Per-room sub-reservation ID. Multi-room reservations share one
            // sourceId (the parent reservation) but have distinct subSourceId
            // per room. Room-night counters MUST key on subSourceId or
            // multi-room bookings collapse into a single night.
            subSourceId: t.subSourceId || '',
            // Kept for backwards-compat with existing sheet rows; new
            // computations prefer subSourceId.
            roomNumber: t.sourceId || '',
            reservationID: t.sourceId || '',
            internalTransactionCode: code,
            transactionID: t.id || ''
          };
        }).filter(t => t.transactionDate >= startDate && t.transactionDate <= endDate);
      }
      return { success: true, data: mapped };
    } catch (e) {
      logger.error(`getTransactions failed: ${e.message}`);
      return { success: false, data: [] };
    }
  }

  /**
   * Fetch reservations within a date range, auto-paginating (limit max 100).
   */
  async getReservations(checkInFrom, checkInTo) {
    logger.info(`[API CALL] GET /getReservations | ${checkInFrom} to ${checkInTo}`);
    if (this._isMock()) {
      return this._mockReturn({ success: true, data: [] });
    }
    try {
      const collected = [];
      const pageSize = 100;
      let pageIndex = 1;
      while (true) {
        const response = await this._getClient().get('/getReservations', {
          params: {
            checkInFrom,
            checkInTo,
            includeGuestsDetails: 'true',
            // Cloudbeds returns a "lite" reservation by default — no
            // dailyRates, no roomTotal, no subtotal. These flags pull the
            // full rate breakdown into each reservation so forecast/BoB
            // revenue can use real per-night rates instead of falling back
            // to balance / total guesses.
            includeAllRates: 'true',
            includeRoomRates: 'true',
            includeRateBreakdown: 'true',
            limit: pageSize,
            pageNumber: pageIndex,
            ...(this.propertyID ? { propertyID: this.propertyID } : {})
          }
        });
        const page = (response.data && response.data.data) || [];
        collected.push(...page);
        if (page.length < pageSize) break;
        pageIndex++;
        // 200 pages × 100/page = 20k reservations — enough for YTD plus a
        // 31-day lookback at busy properties. Bumped from 100 because the
        // 16-month historical backfill was hitting the cap.
        if (pageIndex > 200) {
          logger.warn(`getReservations: hit 200-page safety cap (${collected.length} records); window may be truncated.`);
          break;
        }
        await sleep(250);
      }
      return { success: true, data: collected };
    } catch (e) {
      logger.error(`getReservations failed: ${e.message}`);
      return { success: false, data: [] };
    }
  }

  /**
   * Resolve a phone number to the guest's most-relevant active reservation.
   * Scans a past/future window and filters by last-N-digit match so international
   * prefixes, formatting, and partial-match variations all normalize.
   * Returns in_house reservations first, then confirmed/arriving, then anything else.
   */
  async getReservationsByPhone(phone, { lookbackDays = 7, lookaheadDays = 60 } = {}) {
    logger.info(`[API CALL] getReservationsByPhone: ${phone}`);
    const digits = String(phone).replace(/[^0-9]/g, '');
    if (!digits) return { success: false, data: [] };

    if (this._isMock()) {
      if (digits.endsWith('9988')) {
        return this._mockReturn({ success: true, data: [{
          reservationID: "JD10029384", status: "checked_in", guestName: "John Doe",
          startDate: "2026-04-10", endDate: "2026-04-12"
        }]});
      }
      return this._mockReturn({ success: true, data: [] });
    }

    const past   = new Date(Date.now() - lookbackDays * 86400000).toISOString().split('T')[0];
    const future = new Date(Date.now() + lookaheadDays * 86400000).toISOString().split('T')[0];
    const list = await this.getReservations(past, future);
    if (!list.success || !Array.isArray(list.data)) return { success: false, data: [] };

    const needle = digits.slice(-10); // match on the last 10 digits to ignore country/area-code variance
    const matches = list.data.filter(r => {
      if (!r.guestList) return false;
      return Object.values(r.guestList).some(g => {
        const gp = String(g.guestCellPhone || g.guestPhone || '').replace(/[^0-9]/g, '');
        if (!gp) return false;
        const tail = gp.slice(-10);
        return gp === digits || tail === needle || tail.endsWith(needle) || needle.endsWith(tail);
      });
    });

    const rank = s => (s === 'checked_in' ? 0 : s === 'confirmed' ? 1 : 2);
    matches.sort((a, b) => rank(a.status) - rank(b.status));
    return { success: true, data: matches };
  }

  /**
   * Synthesize a per-day forecast (OCC %, ADR, RevPAR, Room Revenue) by
   * pulling reservations whose stays overlap the next `daysForward` nights and
   * distributing each reservation's room total evenly across its nights.
   *
   * Cloudbeds doesn't expose a first-class daily-forecast endpoint, so this
   * method composes one from /getReservations + /getRooms.
   */
  async getForecast(daysForward = 14) {
    logger.info(`[API CALL] getForecast (synthesized) | +${daysForward} days`);
    if (this._isMock()) {
      const today = new Date();
      const days = [];
      for (let i = 0; i < daysForward; i++) {
        const d = new Date(today.getTime() + i * 86400000);
        days.push({
          date: d.toISOString().slice(0,10),
          occupiedRooms: 30 + (i % 7),
          occupancy: 0.6,
          roomRevenue: 3000 + i * 50,
          adr: 100,
          revpar: 60
        });
      }
      return this._mockReturn({ success: true, data: { forecast: days, totalRooms: 50 } });
    }

    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const end = new Date(start.getTime() + daysForward * 86400000);
    const toYMD = d => d.toISOString().slice(0, 10);

    const totalRooms = await this._resolveTotalRooms();
    const buckets = {};
    for (let i = 0; i < daysForward; i++) {
      buckets[toYMD(new Date(start.getTime() + i * 86400000))] = { occupiedRooms: 0, roomRevenue: 0 };
    }

    const reservations = await this._collectStaysInRange(start, end);
    for (const stay of reservations) {
      const rc = stay.roomCount || 1;
      stay.nights.forEach((ymd, i) => {
        if (buckets[ymd]) {
          buckets[ymd].occupiedRooms += rc;
          buckets[ymd].roomRevenue += stay.nightlyRevenue[i] || 0;
        }
      });
    }

    const forecast = Object.keys(buckets).sort().map(date => {
      const b = buckets[date];
      return {
        date,
        occupiedRooms: b.occupiedRooms,
        occupancy: totalRooms > 0 ? b.occupiedRooms / totalRooms : 0,
        roomRevenue: Math.round(b.roomRevenue * 100) / 100,
        adr: b.occupiedRooms > 0 ? Math.round((b.roomRevenue / b.occupiedRooms) * 100) / 100 : 0,
        revpar: totalRooms > 0 ? Math.round((b.roomRevenue / totalRooms) * 100) / 100 : 0
      };
    });
    return { success: true, data: { forecast, totalRooms } };
  }

  /**
   * Business on the books for a calendar month.
   * Returns confirmed/in-house room nights and revenue for the requested
   * month, including past nights (actuals) plus future nights (on the books).
   * `monthOffset` 0 = current month, 1 = next month, -1 = previous month.
   */
  async getBusinessOnBooks(monthOffset = 0) {
    logger.info(`[API CALL] getBusinessOnBooks | monthOffset=${monthOffset}`);
    if (this._isMock()) {
      return this._mockReturn({
        success: true,
        data: {
          monthStart: '2026-04-01', monthEnd: '2026-04-30',
          roomNights: 850, roomRevenue: 94500,
          occupancy: 0.5667, adr: 111.18, revpar: 63.00, totalRooms: 50
        }
      });
    }

    const today = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + monthOffset + 1, 0);
    const toYMD = d => d.toISOString().slice(0, 10);

    const totalRooms = await this._resolveTotalRooms();
    // +1 day boundary so checkouts on the last of the month are captured
    const reservations = await this._collectStaysInRange(monthStart, new Date(monthEnd.getTime() + 86400000));

    const startYMD = toYMD(monthStart);
    const endYMD = toYMD(monthEnd);
    let roomNights = 0, roomRevenue = 0;
    for (const stay of reservations) {
      const rc = stay.roomCount || 1;
      stay.nights.forEach((ymd, i) => {
        if (ymd >= startYMD && ymd <= endYMD) {
          roomNights += rc;
          roomRevenue += stay.nightlyRevenue[i] || 0;
        }
      });
    }

    const monthDays = Math.round((monthEnd.getTime() - monthStart.getTime()) / 86400000) + 1;
    return {
      success: true,
      data: {
        monthStart: startYMD,
        monthEnd: endYMD,
        roomNights,
        roomRevenue: Math.round(roomRevenue * 100) / 100,
        occupancy: totalRooms > 0 ? roomNights / (totalRooms * monthDays) : 0,
        adr: roomNights > 0 ? Math.round((roomRevenue / roomNights) * 100) / 100 : 0,
        revpar: totalRooms > 0 ? Math.round((roomRevenue / (totalRooms * monthDays)) * 100) / 100 : 0,
        totalRooms
      }
    };
  }

  // Resolve the property's total room count via /getRooms with an env override.
  // Cloudbeds /getRooms paginates with a default page size of 20 and returns
  // a top-level `total` field carrying the true physical room count across
  // all pages. We trust `total` first; only fall back to summing rooms[] if
  // the response shape predates that field.
  async _resolveTotalRooms() {
    const envOverride = parseInt(process.env.TOTAL_ROOMS || 0, 10);
    if (envOverride > 0) return envOverride;
    try {
      const res = await this._getClient().get('/getRooms', {
        params: { ...(this.propertyID ? { propertyID: this.propertyID } : {}), pageSize: 200 }
      });

      // Authoritative: `total` is the cross-page count. Trust it when present.
      const headlineTotal = parseInt(res.data?.total || 0, 10);
      if (headlineTotal > 0) return headlineTotal;

      // Legacy shape fallbacks for older responses:
      //   (a) Multiple data[] entries, each is a roomType with a rooms[] array.
      //   (b) Single data[0] with rooms[] of every physical room across all types.
      //   (c) Single data[0] with rooms[] = roomTypes, each carrying a quantity.
      const data = res.data?.data || [];
      let total = data.reduce((sum, t) => sum + ((t.rooms && t.rooms.length) || 0), 0);
      if (total > 0) {
        const qtyTotal = data.reduce((sum, t) => {
          const nested = (t.rooms || []).reduce((s, r) => s + parseInt(r.roomTypeQuantity || r.quantity || 0, 10), 0);
          return sum + nested;
        }, 0);
        if (qtyTotal > total) total = qtyTotal;
        return total;
      }
      total = data.reduce((sum, t) => sum + parseInt(t.roomTypeQuantity || t.quantity || 0, 10), 0);
      if (total > 0) return total;

      logger.warn(`_resolveTotalRooms: /getRooms returned an unrecognized shape. Set TOTAL_ROOMS=<your physical room count> in .env to override.`);
    } catch (e) {
      logger.warn(`_resolveTotalRooms: /getRooms failed (${e.message}); set TOTAL_ROOMS in .env. Falling back to 50.`);
    }
    return 50;
  }

  // Pull reservations whose stay overlaps the window and expand each into a
  // per-night list with the matching room rate. Forecast/BoB consumers care
  // about *room revenue* only — Cloudbeds returns dailyRates per stay-night,
  // which aligns 1:1 with how MTD/YTD historical room revenue is measured
  // (transactions where roomRevenueType === 'Room Rate').
  //
  // Status filter is intentionally narrow: only confirmed/in-house/checked-out
  // count as "on the books." Pending/held/unconfirmed bookings get excluded
  // because they can vanish without notice and would inflate the forecast.
  async _collectStaysInRange(windowStart, windowEnd) {
    const toYMD = d => d.toISOString().slice(0, 10);
    const lookback = new Date(windowStart.getTime() - 31 * 86400000);
    const list = await this.getReservations(toYMD(lookback), toYMD(windowEnd));
    if (!list.success) return [];

    const ON_BOOK_STATUSES = new Set(['confirmed', 'checked_in', 'checked_out', 'in_house']);
    const stays = [];
    let zeroRevenueStays = 0;
    let firstZeroSampleLogged = false;
    let detailFetches = 0;
    let detailRescues = 0;

    for (const r of (list.data || [])) {
      const status = (r.status || '').toLowerCase();
      if (!ON_BOOK_STATUSES.has(status)) continue;

      const sd = r.startDate;
      const ed = r.endDate;
      if (!sd || !ed) continue;
      const startMs = new Date(sd + 'T00:00:00Z').getTime();
      const endMs = new Date(ed + 'T00:00:00Z').getTime();
      if (!(endMs > startMs)) continue;
      const nightsCount = Math.max(1, Math.round((endMs - startMs) / 86400000));

      let roomCount = 1;
      if (r.guestList) {
        let subRooms = 0;
        Object.values(r.guestList).forEach(g => {
          if (Array.isArray(g.rooms)) subRooms += g.rooms.length;
        });
        if (subRooms > 1) roomCount = subRooms;
      }

      let dailyRatesMap = this._normalizeDailyRates(r.dailyRates);
      let perNightFallback = this._estimatePerNightRevenue(r, nightsCount);

      // The /getReservations listing endpoint returns a "lite" payload that
      // omits dailyRates/roomTotal/subtotal entirely on most accounts. When
      // the listing produced no usable rate signal AND we'd otherwise emit
      // zero revenue (typically: prepaid stays where balance has dropped to 0),
      // fall through to /getReservation singular which does carry rate detail.
      // Cached per reservationID for the request lifetime so a BoB recompute
      // doesn't hammer the API.
      const noRateSignal = Object.keys(dailyRatesMap).length === 0 && perNightFallback === 0;
      if (noRateSignal && r.reservationID) {
        const detail = await this._fetchReservationDetail(r.reservationID);
        if (detail) {
          detailFetches++;
          const detailRooms = (detail.assigned?.length || 0) + (detail.unassigned?.length || 0);
          if (detailRooms > 0) roomCount = detailRooms;
          
          // The /getReservation singular payload nests dailyRates/roomTotal
          // inside detail.assigned[] and detail.unassigned[] (one entry per
          // room of the reservation), NOT at the top level. Walk both arrays
          // and sum per-night rates so multi-room bookings get full revenue.
          const detailDailyRates = this._collectDailyRatesFromDetail(detail);
          if (Object.keys(detailDailyRates).length > 0) {
            dailyRatesMap = detailDailyRates;
            detailRescues++;
          } else {
            // Fall back to the nested or balanceDetailed numbers.
            const detailPerNight = this._estimatePerNightRevenueFromDetail(detail, nightsCount);
            if (detailPerNight > 0) {
              perNightFallback = detailPerNight;
              detailRescues++;
            } else {
              // Last resort: try the legacy estimator on the detail object
              // itself in case Cloudbeds added a top-level alias on this
              // account.
              const legacy = this._estimatePerNightRevenue(detail, nightsCount);
              if (legacy > 0) {
                perNightFallback = legacy;
                detailRescues++;
              }
            }
          }
        }
      }

      const nights = [];
      const nightlyRevenue = [];
      for (let i = 0; i < nightsCount; i++) {
        const ymd = toYMD(new Date(startMs + i * 86400000));
        nights.push(ymd);
        const rate = dailyRatesMap[ymd];
        nightlyRevenue.push(rate != null ? rate : perNightFallback);
      }

      // Diagnostic: surface the first zero-revenue stay's keys so the user
      // can see exactly which fields Cloudbeds populated for their property.
      // Solves the "forecast and BoB show $0" mystery without needing a
      // separate debug script.
      if (nightlyRevenue.every(v => !v)) {
        zeroRevenueStays++;
        if (!firstZeroSampleLogged) {
          firstZeroSampleLogged = true;
          const sampleKeys = Object.keys(r).slice(0, 40).join(', ');
          const moneyHints = ['total', 'subtotal', 'subTotal', 'roomTotal', 'roomSubtotal',
                              'grandTotal', 'taxesTotal', 'feesTotal', 'paid', 'balance']
            .map(k => `${k}=${r[k]}`).join(' | ');
          logger.warn(`[STAYS] Reservation ${r.reservationID} produced zero per-night revenue. Available keys: ${sampleKeys}`);
          logger.warn(`[STAYS] Money-hint fields: ${moneyHints}`);
        }
      }

      stays.push({ reservationID: r.reservationID, nights, nightlyRevenue, status, roomCount });
    }

    if (detailFetches > 0) {
      logger.info(`[STAYS] /getReservation detail fallback fetched ${detailFetches} reservations, ${detailRescues} produced revenue.`);
    }
    if (zeroRevenueStays > 0) {
      logger.warn(`[STAYS] ${zeroRevenueStays}/${stays.length} stays still zero-revenue after detail fallback. If forecast/BoB still look low, set FORECAST_REVENUE_FIELD or chase comp/block detection.`);
    }
    return stays;
  }

  // Per-reservation detail cache. /getReservation (singular) returns the
  // full payload Cloudbeds withholds from the listing endpoint, including
  // dailyRates and roomTotal. Cache TTL is short enough to refresh during
  // a long-running cron but long enough that back-to-back BoB recomputes
  // don't double-fetch.
  async _fetchReservationDetail(reservationID) {
    if (!this._detailCache) this._detailCache = new Map();
    const cached = this._detailCache.get(reservationID);
    const now = Date.now();
    const TTL_MS = 5 * 60 * 1000;
    if (cached && (now - cached.fetchedAt) < TTL_MS) {
      return cached.data;
    }
    try {
      // Be gentle on the rate limit — detail calls happen in a tight loop
      // when a forecast or BoB recompute is iterating hundreds of stays.
      await sleep(100);
      const res = await this.getReservationById(reservationID);
      const data = res && res.success ? res.data : null;
      this._detailCache.set(reservationID, { data, fetchedAt: now });
      return data;
    } catch (e) {
      logger.warn(`_fetchReservationDetail(${reservationID}) failed: ${e.message}`);
      this._detailCache.set(reservationID, { data: null, fetchedAt: now });
      return null;
    }
  }

  // /getReservation (singular) nests dailyRates inside detail.assigned[] and
  // detail.unassigned[] — one entry per physical/virtual room on the
  // reservation. For a single-room booking the array has one entry with one
  // dailyRates list; for multi-room it has multiple, and per-night revenue
  // is the sum across rooms. This helper collapses both arrays into a
  // YMD->amount map the existing dailyRatesMap consumer expects.
  _collectDailyRatesFromDetail(detail) {
    const map = {};
    const rooms = [...(detail.assigned || []), ...(detail.unassigned || [])];
    for (const room of rooms) {
      const ratesPerNight = this._normalizeDailyRates(room.dailyRates);
      for (const [ymd, rate] of Object.entries(ratesPerNight)) {
        map[ymd] = (map[ymd] || 0) + rate;
      }
    }
    return map;
  }

  // Detail-only fallback when nested dailyRates aren't usable. Pulls from
  // the structures the singular endpoint actually populates:
  //   - balanceDetailed.subTotal — net of taxes/fees, populated even pre-payment
  //   - sum of room.roomTotal across detail.assigned/unassigned
  // Both are net (not gross), so they align with how MTD/YTD measure room
  // revenue. Falls through to balanceDetailed.grandTotal (gross) only as a
  // last resort because that includes taxes/fees.
  _estimatePerNightRevenueFromDetail(detail, nightsCount) {
    if (nightsCount <= 0) return 0;

    if (detail.balanceDetailed && detail.balanceDetailed.subTotal != null) {
      const sub = parseFloat(detail.balanceDetailed.subTotal);
      if (Number.isFinite(sub) && sub > 0) return sub / nightsCount;
    }

    const rooms = [...(detail.assigned || []), ...(detail.unassigned || [])];
    let roomTotalSum = 0;
    for (const room of rooms) {
      const v = parseFloat(room.roomTotal || 0);
      if (Number.isFinite(v) && v > 0) roomTotalSum += v;
    }
    if (roomTotalSum > 0) return roomTotalSum / nightsCount;

    if (detail.balanceDetailed && detail.balanceDetailed.grandTotal != null) {
      const gross = parseFloat(detail.balanceDetailed.grandTotal);
      if (Number.isFinite(gross) && gross > 0) return gross / nightsCount;
    }

    return 0;
  }

  // Best-effort net per-night room revenue when dailyRates is missing. Tries
  // every Cloudbeds field name we've seen in the wild before giving up — and
  // crucially uses r.total as a last-ditch fallback (with tax included) so a
  // missing subtotal/roomTotal doesn't zero out the whole forecast. Better to
  // report 5-15% high than to report nothing.
  _estimatePerNightRevenue(r, nightsCount) {
    if (nightsCount <= 0) return 0;

    // Optional explicit override if the user discovers a field that works.
    const override = process.env.FORECAST_REVENUE_FIELD;
    if (override && r[override] != null) {
      const v = parseFloat(r[override]);
      if (Number.isFinite(v) && v > 0) return v / nightsCount;
    }

    // Preferred: any of the room-level totals (already net of tax/fees).
    const roomLevelTotals = ['roomTotal', 'roomSubtotal', 'roomsSubtotal', 'roomCharge', 'roomCharges'];
    for (const k of roomLevelTotals) {
      const v = parseFloat(r[k] || 0);
      if (v > 0) return v / nightsCount;
    }

    // Synthesize: subtotal − taxes − fees. Cloudbeds varies field casing.
    const subtotalKeys = ['subtotal', 'subTotal', 'sub_total', 'subtotalAmount'];
    const taxesKeys    = ['taxesTotal', 'taxTotal', 'taxes_total', 'tax', 'totalTaxes'];
    const feesKeys     = ['feesTotal', 'feeTotal', 'fees_total', 'fees', 'totalFees'];
    const pickNumber = (obj, keys) => {
      for (const k of keys) {
        if (obj[k] == null) continue;
        const v = parseFloat(obj[k]);
        if (Number.isFinite(v)) return v;
      }
      return null;
    };
    const subtotal = pickNumber(r, subtotalKeys);
    if (subtotal != null && subtotal > 0) {
      const taxes = pickNumber(r, taxesKeys) || 0;
      const fees  = pickNumber(r, feesKeys)  || 0;
      const net = subtotal - taxes - fees;
      if (net > 0) return net / nightsCount;
    }

    // Last-ditch: r.total (gross — includes tax/fees). Inflates by ~10–15%
    // but beats zeroing out the entire forecast.
    const totalKeys = ['total', 'grandTotal', 'totalAmount'];
    for (const k of totalKeys) {
      const v = parseFloat(r[k] || 0);
      if (v > 0) return v / nightsCount;
    }

    return 0;
  }

  // Cloudbeds returns dailyRates as either an object keyed by YYYY-MM-DD or as
  // an array of { date, rate } records depending on endpoint. Normalize both
  // shapes to a YMD->amount map so callers don't have to care.
  _normalizeDailyRates(dailyRates) {
    const out = {};
    if (!dailyRates) return out;
    if (Array.isArray(dailyRates)) {
      for (const entry of dailyRates) {
        if (!entry) continue;
        const ymd = entry.date || entry.serviceDate || entry.day;
        const amt = parseFloat(entry.rate ?? entry.amount ?? entry.value ?? 0);
        if (ymd && Number.isFinite(amt)) out[ymd] = amt;
      }
    } else if (typeof dailyRates === 'object') {
      for (const [ymd, val] of Object.entries(dailyRates)) {
        const amt = parseFloat(typeof val === 'object' ? (val.rate ?? val.amount ?? val.value ?? 0) : val);
        if (Number.isFinite(amt)) out[ymd] = amt;
      }
    }
    return out;
  }

  /**
   * GET /getReservationInvoiceInformation — fetch fiscal document info
   * (used to pull documentID before emailing a guest their invoice).
   */
  async getReservationInvoiceInformation(reservationId) {
    logger.info(`[API CALL] GET /getReservationInvoiceInformation [${reservationId}]`);
    if (this._isMock()) {
      return this._mockReturn({ success: true, data: { documentID: `MOCK_DOC_${reservationId}` } });
    }
    try {
      const response = await this._getClient().get('/getReservationInvoiceInformation', {
        params: { reservationID: reservationId, ...(this.propertyID ? { propertyID: this.propertyID } : {}) }
      });
      return response.data;
    } catch (error) {
      logger.error(`getReservationInvoiceInformation failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Email a guest's fiscal document / invoice.
   * NOTE: endpoint availability depends on Cloudbeds account configuration.
   */
  async emailFiscalDocument(documentId, emailAddress) {
    logger.info(`[API CALL] POST /emailFiscalDocument | DocID: ${documentId} to ${emailAddress}`);
    if (this._isMock()) {
      return this._mockReturn({ success: true, message: "Email sent." });
    }
    try {
      const body = this._encodeForm({ documentID: documentId, email: emailAddress });
      const response = await this._getClient().post('/emailFiscalDocument', body, { headers: this._formHeaders() });
      return response.data;
    } catch (error) {
      logger.error(`emailFiscalDocument failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Download a guest's fiscal document / invoice as a PDF.
   */
  async downloadFiscalDocument(documentId) {
    logger.info(`[API CALL] GET /downloadFiscalDocument | DocID: ${documentId}`);
    if (this._isMock()) {
      return { success: false, error: "Cannot download physical PDF in mock mode." };
    }
    try {
      const response = await this._getClient().get('/downloadFiscalDocument', {
        params: { documentID: documentId, ...(this.propertyID ? { propertyID: this.propertyID } : {}) },
        responseType: 'arraybuffer'
      });
      return { success: true, data: response.data };
    } catch (error) {
      logger.error(`downloadFiscalDocument failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // ==========================================
  // HOUSEKEEPING API
  // ==========================================

  async getHousekeepingStatus() {
    logger.info(`[API CALL] GET /getHousekeepingStatus`);
    if (this._isMock()) {
      return this._mockReturn({
        success: true,
        data: [
          { roomID: "113", roomCondition: "dirty", reservationCondition: "checkout" },
          { roomID: "116", roomCondition: "dirty", reservationCondition: "stay_over" },
          { roomID: "204", roomCondition: "dirty", reservationCondition: "checkout" },
          { roomID: "207", roomCondition: "clean", reservationCondition: "stay_over" },
          { roomID: "305", roomCondition: "dirty", reservationCondition: "checkin" },
          { roomID: "312", roomCondition: "dirty", reservationCondition: "checkout" }
        ]
      });
    }
    try {
      const response = await this._getClient().get('https://api.cloudbeds.com/api/v1.2/getHousekeepingStatus', {
        params: { ...(this.propertyID ? { propertyID: this.propertyID } : {}) }
      });
      return response.data;
    } catch (error) {
      logger.error(`getHousekeepingStatus failed: ${error.message}`);
      return { success: false, data: [] };
    }
  }

  async postHousekeepingAssignment(assignments) {
    logger.info(`[API CALL] POST /postHousekeepingAssignment | count: ${assignments.length}`);
    if (this._isMock()) {
      return this._mockReturn({ success: true, message: "Housekeeping assignments posted." });
    }
    try {
      const body = this._encodeForm({ assignments: JSON.stringify(assignments) });
      const response = await this._getClient().post('/postHousekeepingAssignment', body, { headers: this._formHeaders() });
      return response.data;
    } catch (error) {
      logger.error(`postHousekeepingAssignment failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // ==========================================
  // WEBHOOK SUBSCRIPTIONS
  // ==========================================

  async postWebhook(object, action, endpointUrl) {
    logger.info(`[API CALL] POST /postWebhook | ${object}/${action} -> ${endpointUrl}`);
    if (this._isMock()) {
      return this._mockReturn({ success: true, subscriptionID: `mock_sub_${object}_${action}` });
    }
    try {
      const body = this._encodeForm({ object, action, endpointUrl }, { attachProperty: false });
      const response = await this._getClient().post('/postWebhook', body, { headers: this._formHeaders() });
      return response.data;
    } catch (error) {
      logger.error(`postWebhook failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async registerAllWebhooks(endpointUrl) {
    const events = [
      ['reservation', 'created'],
      ['reservation', 'status_changed'],
      ['reservation', 'dates_changed'],
      ['reservation', 'accommodation_status_changed'],
      ['reservation', 'accommodation_changed'],
      ['reservation', 'deleted'],
      ['guest', 'created'],
      ['guest', 'details_changed'],
      ['housekeeping', 'room_condition_changed'],
      ['night_audit', 'completed']
    ];

    const results = [];
    for (const [object, action] of events) {
      results.push({ event: `${object}/${action}`, result: await this.postWebhook(object, action, endpointUrl) });
    }
    return results;
  }

  /**
   * GET /getWebhooks — list current webhook subscriptions for the property.
   */
  async getWebhooks() {
    logger.info(`[API CALL] GET /getWebhooks`);
    if (this._isMock()) {
      return this._mockReturn({ success: true, data: [] });
    }
    try {
      const response = await this._getClient().get('/getWebhooks', {
        params: { ...(this.propertyID ? { propertyID: this.propertyID } : {}) }
      });
      return response.data;
    } catch (error) {
      logger.error(`getWebhooks failed: ${error.message}`);
      return { success: false, data: [], error: error.message };
    }
  }

  /**
   * DELETE /deleteWebhook — remove a single subscription by its Cloudbeds subscriptionID.
   */
  async deleteWebhook(subscriptionID) {
    logger.info(`[API CALL] DELETE /deleteWebhook | id=${subscriptionID}`);
    if (this._isMock()) {
      return this._mockReturn({ success: true });
    }
    try {
      const body = this._encodeForm({ subscriptionID }, { attachProperty: false });
      // Cloudbeds accepts deleteWebhook over POST with the id in the body.
      const response = await this._getClient().post('/deleteWebhook', body, { headers: this._formHeaders() });
      return response.data;
    } catch (error) {
      logger.error(`deleteWebhook failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }


  // ==========================================
  // GUEST PROFILE / REGISTRATION
  // ==========================================

  /**
   * PUT /putGuest — update guest profile fields.
   * Accepts Cloudbeds-native field names directly (guestEmail, guestCellPhone,
   * guestAddress1, guestCity, guestState, guestZip, guestCountry, ...).
   */
  async putGuest(guestID, updates) {
    logger.info(`[API CALL] PUT /putGuest | guestID: ${guestID}`);
    if (this._isMock()) {
      return this._mockReturn({ success: true });
    }
    try {
      const body = this._encodeForm({ guestID, ...updates });
      const response = await this._getClient().put('/putGuest', body, { headers: this._formHeaders() });
      return response.data;
    } catch (e) {
      logger.error(`putGuest failed: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  /**
   * POST /postReservationDocument — upload a file (signed reg card).
   * axios will set the multipart boundary automatically when we omit Content-Type.
   */
  async postReservationDocument(reservationID, base64Image, filename = "RegistrationCard.png") {
    logger.info(`[API CALL] POST /postReservationDocument | reservationID: ${reservationID}`);
    if (this._isMock()) {
      return this._mockReturn({ success: true });
    }
    try {
      const buffer = Buffer.from(base64Image.replace(/^data:image\/\w+;base64,/, ""), 'base64');
      const blob = new Blob([buffer], { type: 'image/png' });

      const formData = new FormData();
      formData.append('reservationID', reservationID);
      if (this.propertyID) formData.append('propertyID', this.propertyID);
      formData.append('documentType', 'registration_card');
      formData.append('documentFile', blob, filename);

      // NOTE: do NOT set Content-Type here; axios + FormData must generate the
      // multipart boundary themselves.
      const response = await this._getClient().post('/postReservationDocument', formData);
      return response.data;
    } catch (e) {
      logger.error(`postReservationDocument failed: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  // ==========================================
  // WHISTLE (Guest Experience) MESSAGE SENDING
  // ==========================================

  async sendWhistleMessage(reservationId, messageText) {
    logger.info(`[WHISTLE API] POST /sendMessage [${reservationId}] | Text: ${messageText.substring(0, 30)}...`);
    if (this._isMock() || !process.env.WHISTLE_API_KEY) {
      return this._mockReturn({ success: true, message: "Whistle message queued via mock." });
    }
    // Real Whistle integration pending vendor keys.
  }
}

module.exports = { CloudbedsAPI };
