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
        logger.info(`[API CALL] Delegating search "${query}" to /getReservations scan...`);
        const today = new Date().toISOString().split('T')[0];
        const past = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
        const future = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

        const resList = await this.getReservations(past, future);
        if (resList.success && Array.isArray(resList.data)) {
          let matches = [];
          if (isName) {
            const needle = query.toLowerCase();
            matches = resList.data.filter(r =>
              (r.guestName && r.guestName.toLowerCase().includes(needle)) ||
              (r.guestFirstName && r.guestFirstName.toLowerCase() === needle) ||
              (r.guestLastName && r.guestLastName.toLowerCase() === needle)
            );
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

          if (matches.length > 0) {
            const exactMatch = matches.find(r => {
              if (mode === 'checkin') return r.startDate === today;
              if (mode === 'checkout') return r.endDate === today || r.status === 'checked_in';
              if (mode === 'print') return r.startDate === today || r.endDate === today || r.status === 'checked_in' || r.status === 'checked_out';
              return true;
            });

            if (exactMatch) {
              const id = exactMatch.reservationID || exactMatch.reservationId;
              logger.info(`[API CALL] Name resolved to ID: ${id}`);
              return await this.getReservationById(id);
            }

            if (mode === 'checkin') {
              const futureRes = matches.find(r => r.startDate > today);
              if (futureRes) {
                return { success: false, message: `We found a reservation for you, but your check-in date is ${futureRes.startDate}. You can only check in on your arrival date.` };
              }
            }
            return { success: false, message: "We found a reservation under your details, but it is not scheduled for today. Please see the front desk." };
          }
        }
        return { success: false, message: "Could not find an active reservation matching that name." };
      }

      return await this.getReservationById(query);
    } catch (error) {
      logger.error(`getReservation failed: ${error.message}`);
      return { success: false, error: error.message };
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
          includeGuestsDetails: 'true'
        }
      });
      return response.data;
    } catch (error) {
      logger.error(`getReservationById failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async getUnassignedRooms(startDate, endDate) {
    logger.info(`[API CALL] GET /getUnassignedRooms | ${startDate} to ${endDate}`);
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
      const response = await this._getClient().get('/getUnassignedRooms', {
        params: {
          startDate,
          endDate,
          ...(this.propertyID ? { propertyID: this.propertyID } : {})
        }
      });
      return response.data;
    } catch (error) {
      logger.error(`getUnassignedRooms failed: ${error.message}`);
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
      if (status === 'checked_in') {
        return { success: true, message: "Reservation is already checked in." };
      }
      if (status !== 'confirmed') {
        return { success: false, error: `Reservation must be 'confirmed' before check-in (current: ${status}).` };
      }
      const body = this._encodeForm({
        reservationID: reservationId,
        reservationStatus: 'checked_in'
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
    logger.info(`[API CALL] GET /getTransactions | ${startDate} to ${endDate}`);
    if (this._isMock()) {
      return this._mockReturn({ success: true, data: [] });
    }
    try {
      const collected = [];
      const pageSize = 100;
      let pageNumber = 1;
      while (true) {
        const response = await this._getClient().get('https://api.cloudbeds.com/api/v1.2/getTransactions', {
          params: {
            startDate,
            endDate,
            type: 'all',
            limit: pageSize,
            pageNumber: pageNumber,
            ...(this.propertyID ? { propertyID: this.propertyID } : {})
          }
        });
        const page = (response.data && response.data.data) ? response.data.data : [];
        collected.push(...page);
        if (page.length < pageSize) break;
        pageNumber++;
        await sleep(250);
      }
      
      // Normalize v1.2 properties to legacy names expected by the night audit script
      let mapped = collected;
      if (collected.length > 0) {
        mapped = collected.map(t => {
          let transactionAmount = parseFloat(t.amount || 0);
          if (t.transactionType === 'credit') {
            transactionAmount = -transactionAmount;
          }
          let type = '';
          if (t.transactionCategory === 'payment') type = 'Payment';
          else if (['custom_item', 'product', 'addon'].includes(t.transactionCategory)) type = 'Items & Services';

          let roomRevenueType = '';
          if (t.transactionCategory === 'rate') roomRevenueType = 'Room Rate';

          return {
            ...t,
            transactionDate: t.serviceDate || (t.transactionDateTime ? t.transactionDateTime.split(' ')[0] : ''),
            transactionAmount: transactionAmount,
            transactionType: type,
            roomRevenueType: roomRevenueType,
            transactionCodeDescription: t.description || '',
            transactionVoid: t.isDeleted,
            roomNumber: t.roomName || ''
          };
        });
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
      let offset = 0;
      while (true) {
        const response = await this._getClient().get('/getReservations', {
          params: {
            checkInFrom,
            checkInTo,
            includeGuestsDetails: 'true',
            limit: pageSize,
            offset: offset,
            ...(this.propertyID ? { propertyID: this.propertyID } : {})
          }
        });
        const page = (response.data && response.data.data) || [];
        collected.push(...page);
        if (page.length < pageSize) break;
        offset += pageSize;
        if (offset > 2000) break; // safety cap
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

  async getForecast(daysForward = 14) {
    logger.info(`[API CALL] GET /getForecast | +${daysForward} days`);
    if (this._isMock()) {
      return this._mockReturn([
        { date: "Tomorrow", occupancy: "82%", onTheBooksRev: "$2,400" },
        { date: "+2 Days", occupancy: "85%", onTheBooksRev: "$2,600" },
        { date: "+3 Days", occupancy: "60%", onTheBooksRev: "$1,800" },
        { date: "Next Weekend", occupancy: "95%", onTheBooksRev: "$4,200" }
      ]);
    }
    return { error: "Live forecast endpoint not mapped yet." };
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
