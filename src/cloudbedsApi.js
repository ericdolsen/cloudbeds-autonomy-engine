const { logger } = require('./logger');

/**
 * Cloudbeds REST API wrapper (Mocked version for local development)
 * This file contains the endpoints necessary for the Autonomy Engine to function.
 */
class CloudbedsAPI {
  constructor() {
    this.host = process.env.CLOUDBEDS_HOST || 'api.cloudbeds.com';
    this.apiKey = process.env.CLOUDBEDS_API_KEY || 'MOCK_KEY';
  }

  // Helper to simulate network latency
  async _mockReturn(data, delayMs = 300) {
    return new Promise(resolve => setTimeout(() => resolve(data), delayMs));
  }

  /**
   * Fetch reservation details by searching for name, phone, or reservation ID
   */
  async getReservation(query) {
    logger.info(`[API CALL] GET /api/v1.2/getReservation with query: ${query}`);
    // MOCK RESPONSE
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

  /**
   * Search for available rooms matching a criteria for given dates
   */
  async getUnassignedRooms(startDate, endDate) {
    logger.info(`[API CALL] GET /api/v1.2/getUnassignedRooms from ${startDate} to ${endDate}`);
    return this._mockReturn({
      success: true,
      data: [
        { roomId: "101", roomType: "Standard Queen", nightlyRate: 150 },
        { roomId: "204", roomType: "King Suite (with Tub)", nightlyRate: 195 }
      ]
    });
  }

  /**
   * Update a reservation's details (status, dates, room type)
   */
  async updateReservation(reservationId, updates) {
    logger.info(`[API CALL] PUT /api/v1.2/putReservation [${reservationId}] | payload: ${JSON.stringify(updates)}`);
    return this._mockReturn({
      success: true,
      message: "Reservation successfully updated."
    });
  }

  /**
   * Charge the card on file for a specific amount
   */
  async postPayment(reservationId, amount) {
    logger.info(`[API CALL] POST /api/v1.2/postPaymentActivity [${reservationId}] | Amount: $${amount}`);
    return this._mockReturn({
      success: true,
      transactionId: "txn_893jd9283udj",
      message: "Payment processed successfully."
    });
  }

  /**
   * Add a line item / charge to the guest's folio
   */
  async postFolioAdjustment(reservationId, amount, description) {
    logger.info(`[API CALL] POST /api/v1.2/postFolioAdjustment [${reservationId}] | Amount: $${amount} | Desc: ${description}`);
    return this._mockReturn({
      success: true,
      message: "Adjustment added to folio."
    });
  }
}

module.exports = { CloudbedsAPI };
