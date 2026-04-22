const { chromium } = require('playwright');
const { logger } = require('./logger');

class PaymentTerminal {
  constructor() {
    this.host = process.env.CLOUDBEDS_HOST || 'us2.cloudbeds.com';
    this.propertyId = process.env.CLOUDBEDS_PROPERTY_ID;
    this.email = process.env.CLOUDBEDS_EMAIL;
    this.password = process.env.CLOUDBEDS_PASSWORD;
  }

  async chargePhysicalTerminal(reservationId, amount, terminalName) {
    if (!this.email || !this.password) {
      throw new Error("CLOUDBEDS_EMAIL and CLOUDBEDS_PASSWORD are required in .env for Playwright terminal access.");
    }

    logger.info(`[STRIPE TERMINAL] Firing up headless browser for WisePOS E...`);
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();

      // 1. Login
      logger.info(`[STRIPE TERMINAL] Logging into Cloudbeds...`);
      await page.goto(`https://${this.host}/login`, { waitUntil: 'domcontentloaded' });
      await page.fill('input[name="user_email"]', this.email);
      await page.fill('input[name="user_password"]', this.password);
      await page.click('button[type="submit"]');
      await page.waitForURL(`https://${this.host}/connect/*`, { timeout: 15000 });

      // 2. Navigate straight to the reservation folio
      logger.info(`[STRIPE TERMINAL] Navigating to reservation ${reservationId}...`);
      await page.goto(`https://${this.host}/connect/${this.propertyId}#/reservations/${reservationId}`, { waitUntil: 'networkidle' });
      
      // 3. Click "Add Payment"
      logger.info(`[STRIPE TERMINAL] Triggering 'Add Payment'...`);
      await page.click('button:has-text("Add Payment")');
      
      // 4. Select the Terminal from dropdown
      // Cloudbeds Payments usually uses a custom react-select or select element for the payment method
      await page.click('div.payment-method-dropdown'); // Adjust selector based on actual Cloudbeds UI
      await page.click(`text="${terminalName}"`);
      
      // 5. Enter Amount
      await page.fill('input[name="payment_amount"]', amount.toString()); // Adjust selector
      
      // 6. Click "Charge"
      logger.info(`[STRIPE TERMINAL] Sending $${amount} to ${terminalName}. Waiting for guest to tap/insert card...`);
      await page.click('button:has-text("Charge")');
      
      // 7. Wait for Success Toast/Modal
      // A physical card transaction can take 15-30 seconds depending on the guest.
      await page.waitForSelector('text="Payment successful"', { timeout: 60000 });

      logger.info(`[STRIPE TERMINAL] Transaction successful!`);
      await browser.close();
      return { success: true, message: `Payment of $${amount} successfully captured via physical chip inserted at ${terminalName}.` };
    } catch (e) {
      logger.error(`[STRIPE TERMINAL] Failed to process physical charge: ${e.message}`);
      if (browser) await browser.close();
      throw e;
    }
  }
}

module.exports = { PaymentTerminal };
