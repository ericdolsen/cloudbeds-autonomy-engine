const axios = require('axios');
const { logger } = require('./logger');

/**
 * Cloudbeds REST API wrapper
 * Automatically switches to MOCK data if the CLOUDBEDS_API_KEY is missing or set to MOCK_KEY.
 */
class CloudbedsAPI {
  constructor() {
    this.host = process.env.CLOUDBEDS_HOST || 'https://hotels.cloudbeds.com/api/v1.3';
    this.apiKey = process.env.CLOUDBEDS_API_KEY || 'MOCK_KEY';
  }

  // Helper to simulate network latency for mocks
  async _mockReturn(data, delayMs = 300) {
    return new Promise(resolve => setTimeout(() => resolve(data), delayMs));
  }

  // Pre-configured Axios client for real network requests
  _getClient() {
    return axios.create({
      baseURL: this.host,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Fetch reservation details by searching for name, phone, or reservation ID
   */
  async getReservation(query, mode) {
    logger.info(`[API CALL] GET /getReservation | query: ${query} | mode: ${mode}`);
    
    if (this.apiKey === 'MOCK_KEY') {
      // Mocking different behaviors for Last Name vs ID searches
      if (query && query.toLowerCase() === 'smith') {
         return this._mockReturn({
           success: true,
           data: {
             reservationId: "RD98273410",
             guestName: "Amanda Smith",
             status: "confirmed",
             phone: "555-827-8492"
           }
         });
      }

      // Default fallback mock
      return this._mockReturn({
        success: true,
        data: {
          reservationId: "JD10029384",
          status: "in_house",
          guestName: "John Doe",
          phone: "555-221-9988",
          balanceDue: 45.00,
          currency: "USD",
          roomType: "Standard Queen",
          startDate: "2026-04-10",
          endDate: "2026-04-12",
          tags: ["VIP"]
        }
      });
    }

    // REAL NETWORK CALL
    try {
      // 1. If the query looks like a purely alphabetical name instead of a Reservation ID
      if (/^[a-zA-Z\s]+$/.test(query) && query.length >= 2) {
          logger.info(`[API CALL] Delegating Name Search for "${query}" to /getReservations scan...`);
          // Grab reservations spanning the past week to next week to capture in-house and arriving guests
          const today = new Date().toISOString().split('T')[0];
          const past = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
          const future = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
          
          const resList = await this.getReservations(past, future);
          if (resList.success && resList.data) {
              const nameMatches = resList.data.filter(r => {
                 return (r.guestName && r.guestName.toLowerCase().includes(query.toLowerCase())) ||
                        (r.guestFirstName && r.guestFirstName.toLowerCase() === query.toLowerCase()) ||
                        (r.guestLastName && r.guestLastName.toLowerCase() === query.toLowerCase());
              });

              if (nameMatches.length > 0) {
                  const exactMatch = nameMatches.find(r => {
                     if (mode === 'checkin') {
                         return r.startDate === today;
                     } else if (mode === 'checkout') {
                         return r.endDate === today || r.status === 'checked_in';
                     }
                     return true;
                  });
                  
                  if (exactMatch) {
                      // Run strict lookup using the dynamically found ID to pull nested details like phone number
                      logger.info(`[API CALL] Name resolved to ID: ${exactMatch.reservationId || exactMatch.reservationID}`);
                      return await this.getReservation(exactMatch.reservationId || exactMatch.reservationID);
                  } else {
                      if (mode === 'checkin') {
                          const futureRes = nameMatches.find(r => r.startDate > today);
                          if (futureRes) {
                              return { success: false, message: `We found a reservation for you, but your check-in date is ${futureRes.startDate}. You can only check in on your arrival date.` };
                          }
                      }
                      return { success: false, message: "We found a reservation under your name, but it is not scheduled for today. Please see the front desk." };
                  }
              }
          }
          return { success: false, message: "Could not find an active reservation matching that name." };
      }

      // 2. Standard ID lookup
      const response = await this._getClient().get('/getReservation', {
        params: { reservationID: query }
      });
      return response.data;
    } catch (error) {
      logger.error(`getReservation failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Search for available rooms matching a criteria for given dates
   */
  async getUnassignedRooms(startDate, endDate) {
    logger.info(`[API CALL] GET /getUnassignedRooms | ${startDate} to ${endDate}`);
    
    if (this.apiKey === 'MOCK_KEY') {
      return this._mockReturn({
        success: true,
        data: [
          { roomId: "101", roomType: "Standard Queen", nightlyRate: 150 },
          { roomId: "204", roomType: "King Suite (with Tub)", nightlyRate: 195 }
        ]
      });
    }

    // REAL NETWORK CALL
    try {
      const response = await this._getClient().get('/getUnassignedRooms', {
        params: { startDate, endDate }
      });
      return response.data;
    } catch (error) {
      logger.error(`getUnassignedRooms failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Update a reservation's details (status, dates, room type)
   */
  async updateReservation(reservationId, updates) {
    logger.info(`[API CALL] PUT /putReservation [${reservationId}] | payload: ${JSON.stringify(updates)}`);
    
    if (this.apiKey === 'MOCK_KEY') {
      return this._mockReturn({
        success: true,
        message: "Reservation successfully updated."
      });
    }

    // REAL NETWORK CALL
    try {
      const payload = { reservationID: reservationId, ...updates };
      const response = await this._getClient().put('/putReservation', payload);
      return response.data;
    } catch (error) {
      logger.error(`updateReservation failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Charge the card on file for a specific amount
   */
  async postPayment(reservationId, amount) {
    logger.info(`[API CALL] POST /postPaymentActivity [${reservationId}] | Amount: $${amount}`);
    
    if (this.apiKey === 'MOCK_KEY') {
      return this._mockReturn({
        success: true,
        transactionId: "txn_893jd9283udj",
        message: "Payment processed successfully."
      });
    }

    // REAL NETWORK CALL
    try {
      const payload = { reservationID: reservationId, type: 'charge', amount };
      const response = await this._getClient().post('/postPaymentActivity', payload);
      return response.data;
    } catch (error) {
      logger.error(`postPayment failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Add a line item / charge to the guest's folio
   */
  async postFolioAdjustment(reservationId, amount, description) {
    logger.info(`[API CALL] POST /postFolioAdjustment [${reservationId}] | Amount: $${amount} | Desc: ${description}`);
    
    if (this.apiKey === 'MOCK_KEY') {
      return this._mockReturn({
        success: true,
        message: "Adjustment added to folio."
      });
    }

    // REAL NETWORK CALL
    try {
      const payload = { reservationID: reservationId, amount, description };
      const response = await this._getClient().post('/postFolioAdjustment', payload);
      return response.data;
    } catch (error) {
      logger.error(`postFolioAdjustment failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Fetch reservations with highly nested financial details for custom reporting.
   */
  async getReservationsWithRateDetails(startDate, endDate) {
    logger.info(`[API CALL] GET /getReservationsWithRateDetails | ${startDate} to ${endDate}`);
    
    if (this.apiKey === 'MOCK_KEY') {
      return this._mockReturn({
        success: true,
        data: [
          { reservationId: "R_01", startDate: startDate, endDate: endDate, status: "checked_in", source: "OTA (Booking.com)", total: 350.00 },
          { reservationId: "R_02", startDate: startDate, endDate: endDate, status: "no_show", source: "Direct", total: 150.00 },
          { reservationId: "R_03", startDate: startDate, endDate: endDate, status: "checked_in", source: "OTA (Expedia)", total: 420.00 },
          { reservationId: "R_04", startDate: startDate, endDate: endDate, status: "checked_in", source: "Direct", total: 80.00 }
        ]
      });
    }

    try {
      const response = await this._getClient().get('/getReservationsWithRateDetails', {
        params: { checkInFrom: startDate, checkInTo: endDate }
      });
      return response.data;
    } catch (error) {
      logger.error(`getReservationsWithRateDetails failed: ${error.message}`);
      return { success: false, data: [] };
    }
  }

  /**
   * Fetch House Count (Occupancy, Revenue) for a specific date
   */
  async getHouseCount(date) {
    logger.info(`[API CALL] GET /getHouseCount | ${date}`);
    if (this.apiKey === 'MOCK_KEY') {
      return this._mockReturn({ success: true, data: { occupiedRooms: 40, roomRevenue: 4200.50, adr: 105.01, revpar: 84.01 } });
    }
    try {
      const response = await this._getClient().get('/getHouseCount', { params: { date, propertyID: process.env.CLOUDBEDS_PROPERTY_ID }});
      return response.data;
    } catch (e) {
      logger.error(`getHouseCount failed: ${e.message}`);
      return { success: false, data: {} };
    }
  }

  /**
   * Fetch raw transaction ledger within a date range
   */
  async getTransactions(startDate, endDate) {
    logger.info(`[API CALL] GET /getTransactions | ${startDate} to ${endDate}`);
    if (this.apiKey === 'MOCK_KEY') {
      return this._mockReturn({ success: true, data: [] });
    }
    try {
      const response = await this._getClient().get('/getTransactions', { params: { startDate, endDate, type: 'all', propertyID: process.env.CLOUDBEDS_PROPERTY_ID }});
      return response.data;
    } catch (e) {
      logger.error(`getTransactions failed: ${e.message}`);
      return { success: false, data: [] };
    }
  }

  /**
   * Fetch standard reservations for activity tracking (Check-ins, Check-outs)
   */
  async getReservations(checkInFrom, checkInTo) {
    logger.info(`[API CALL] GET /getReservations | ${checkInFrom} to ${checkInTo}`);
    if (this.apiKey === 'MOCK_KEY') {
      return this._mockReturn({ success: true, data: [] });
    }
    try {
      const response = await this._getClient().get('/getReservations', { params: { checkInFrom, checkInTo, pageSize: 500, propertyID: process.env.CLOUDBEDS_PROPERTY_ID }});
      return response.data;
    } catch (e) {
      logger.error(`getReservations failed: ${e.message}`);
      return { success: false, data: [] };
    }
  }

  /**
   * Fetch a multi-day forecast for projected occupancy and revenue.
   */
  async getForecast(daysForward = 14) {
    logger.info(`[API CALL] GET /getForecast | +${daysForward} days`);
    
    // Cloudbeds has a GET /getDashboard or GET /getOccupancy endpoint, mocked here
    if (this.apiKey === 'MOCK_KEY') {
      return this._mockReturn([
        { date: "Tomorrow", occupancy: "82%", onTheBooksRev: "$2,400" },
        { date: "+2 Days", occupancy: "85%", onTheBooksRev: "$2,600" },
        { date: "+3 Days", occupancy: "60%", onTheBooksRev: "$1,800" },
        { date: "Next Weekend", occupancy: "95%", onTheBooksRev: "$4,200" }
      ]);
    }
    
    // REAL NETWORK CALL (Mapping to whichever endpoint client uses)
    return { error: "Live forecast endpoint not mapped yet." };
  }

  /**
   * Native Endpoint to email the fiscal document / invoice generated at checkout.
   */
  async emailFiscalDocument(documentId, emailAddress) {
    logger.info(`[API CALL] POST /emailFiscalDocument | DocID: ${documentId} to ${emailAddress}`);
    
    if (this.apiKey === 'MOCK_KEY') {
      return this._mockReturn({ success: true, message: "Email sent successfully." });
    }

    try {
      const response = await this._getClient().post('/emailFiscalDocument', { documentID: documentId, email: emailAddress });
      return response.data;
    } catch (error) {
      logger.error(`emailFiscalDocument failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // ==========================================
  // HOUSEKEEPING API
  // ==========================================

  /**
   * Pull all housekeeping inspections (used to find Dirty rooms globally)
   */
  async getHousekeepingStatus() {
    logger.info(`[API CALL] GET /housekeeping/v1/inspections`);
    
    if (this.apiKey === 'MOCK_KEY') {
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
      // Typically v1 or v2 depending on Cloudbeds PMS
      const response = await this._getClient().get(`/housekeeping/v1/inspections/${process.env.CLOUDBEDS_PROPERTY_ID}`);
      return response.data;
    } catch (error) {
      logger.error(`getHousekeepingStatus failed: ${error.message}`);
      return { success: false, data: [] };
    }
  }

  /**
   * Push assigned housekeeper mapping directly to the Cloudbeds dashboard.
   */
  async postHousekeepingAssignment(assignments) {
    logger.info(`[API CALL] POST /postHousekeepingAssignment | count: ${assignments.length}`);
    
    if (this.apiKey === 'MOCK_KEY') {
      return this._mockReturn({ success: true, message: "Housekeeping assignments posted to dashboard." });
    }

    try {
      // assignments format: [ { roomID: "101", housekeeperID: "HK_123" } ]
      const response = await this._getClient().post('/postHousekeepingAssignment', { assignments });
      return response.data;
    } catch (error) {
      logger.error(`postHousekeepingAssignment failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // ==========================================
  // WEBHOOK SUBSCRIPTIONS
  // ==========================================

  /**
   * Register a webhook subscription with Cloudbeds.
   * object: e.g. 'reservation', 'guest', 'housekeeping', 'night_audit'
   * action: e.g. 'created', 'status_changed', 'room_condition_changed', 'completed'
   * endpointUrl: public URL Cloudbeds will POST to
   */
  async postWebhook(object, action, endpointUrl) {
    logger.info(`[API CALL] POST /postWebhook | ${object}/${action} -> ${endpointUrl}`);

    if (this.apiKey === 'MOCK_KEY') {
      return this._mockReturn({ success: true, subscriptionID: `mock_sub_${object}_${action}` });
    }

    try {
      const response = await this._getClient().post('/postWebhook', {
        object,
        action,
        endpointUrl
      });
      return response.data;
    } catch (error) {
      logger.error(`postWebhook failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Subscribe to the full set of events the Autonomy Engine reacts to.
   * Idempotent on the Cloudbeds side (duplicate subscriptions return the existing one).
   */
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

  // ==========================================
  // NATIVE REGISTRATION / GUEST UPDATE
  // ==========================================

  /**
   * Update guest details (phone, email, address)
   */
  async putGuest(guestID, updates) {
    logger.info(`[API CALL] PUT /putGuest | guestID: ${guestID}`);
    if (this.apiKey === 'MOCK_KEY') {
      return this._mockReturn({ success: true });
    }
    try {
      const payload = {
          guestID: guestID,
          propertyID: process.env.CLOUDBEDS_PROPERTY_ID,
          ...updates
      };
      const response = await this._getClient().put('/putGuest', payload);
      return response.data;
    } catch (e) {
      logger.error(`putGuest failed: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  /**
   * Upload a document (like a signed registration card) to a reservation
   */
  async postReservationDocument(reservationID, base64Image, filename = "RegistrationCard.png") {
    logger.info(`[API CALL] POST /postReservationDocument | reservationID: ${reservationID}`);
    if (this.apiKey === 'MOCK_KEY') {
      return this._mockReturn({ success: true });
    }
    try {
      const buffer = Buffer.from(base64Image.replace(/^data:image\/\w+;base64,/, ""), 'base64');
      const blob = new Blob([buffer], { type: 'image/png' });
      
      const formData = new FormData();
      formData.append('reservationID', reservationID);
      if (process.env.CLOUDBEDS_PROPERTY_ID) {
          formData.append('propertyID', process.env.CLOUDBEDS_PROPERTY_ID);
      }
      formData.append('file', blob, filename);

      const response = await this._getClient().post('/postReservationDocument', formData, {
          headers: { 'Content-Type': 'multipart/form-data' }
      });
      return response.data;
    } catch (e) {
      logger.error(`postReservationDocument failed: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  // ==========================================
  // WHISTLE (Guest Experience) MESSAGE SENDING
  // ==========================================
  
  /**
   * Send a Text/Email to the guest via Whistle.
   * Whistle handles external comms instead of Cloudbeds direct.
   */
  async sendWhistleMessage(reservationId, messageText) {
    logger.info(`[WHISTLE API] POST /sendMessage [${reservationId}] | Text: ${messageText.substring(0, 30)}...`);
    
    // Fallback while we don't have Whistle integrated
    if (this.apiKey === 'MOCK_KEY' || !process.env.WHISTLE_API_KEY) {
      return this._mockReturn({
        success: true,
        message: "Whistle message successfully queued via Mock."
      });
    }

    // REAL NETWORK CALL (Placeholder for Whistle's exact API route)
    // const whistleAxios = axios.create({ baseURL: 'https://api.whistle.com/v1', headers: { ... } });
    // whistleAxios.post('/message', { ... });
  }

}

module.exports = { CloudbedsAPI };
