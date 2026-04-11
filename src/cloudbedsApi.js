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
