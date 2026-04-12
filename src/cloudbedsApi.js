const axios = require('axios');
const { logger } = require('./logger');

/**
 * Cloudbeds REST API wrapper
 * Automatically switches to MOCK data if the CLOUDBEDS_API_KEY is missing or set to MOCK_KEY.
 */
class CloudbedsAPI {
  constructor() {
    // We strictly use v1.2 as v1.1 is deprecated
    this.host = process.env.CLOUDBEDS_HOST || 'https://hotels.cloudbeds.com/api/v1.2';
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
  async getReservation(query) {
    logger.info(`[API CALL] GET /getReservation | query: ${query}`);
    
    if (this.apiKey === 'MOCK_KEY') {
      return this._mockReturn({
        success: true,
        data: {
          reservationId: "JD10029384",
          status: "in_house",
          guestName: "John Doe",
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
      const response = await this._getClient().get('/getReservation', {
        params: { query }
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
