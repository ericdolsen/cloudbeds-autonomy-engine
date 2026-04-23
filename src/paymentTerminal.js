const { chromium } = require('playwright');
const path = require('path');
const { logger } = require('./logger');

class PaymentTerminal {
  constructor() {
    this.host = process.env.CLOUDBEDS_UI_HOST || 'hotels.cloudbeds.com';
    this.propertyId = process.env.CLOUDBEDS_PROPERTY_ID;
    this.email = process.env.CLOUDBEDS_EMAIL;
    this.password = process.env.CLOUDBEDS_PASSWORD;
  }

  async chargePhysicalTerminal(reservationId, amount, terminalName) {
    if (!this.email || !this.password) {
      throw new Error("CLOUDBEDS_EMAIL and CLOUDBEDS_PASSWORD are required in .env for Playwright terminal access.");
    }

    logger.info(`[STRIPE TERMINAL] Firing up headless browser for WisePOS E...`);
    let context;
    try {
      const userDataDir = path.join(__dirname, '..', '.cloudbeds_session');
      context = await chromium.launchPersistentContext(userDataDir, { 
          channel: 'chrome',
          headless: true,
          args: ['--disable-blink-features=AutomationControlled'],
          ignoreDefaultArgs: ['--enable-automation']
      });

      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.navigator.chrome = { runtime: {} };
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      });

      const page = await context.newPage();
      
      // 1. Navigate straight to the reservation folio to check if we're already logged in
      logger.info(`[STRIPE TERMINAL] Checking session status / logging into Cloudbeds...`);
      const propertyPath = this.propertyId ? `${this.propertyId}` : '';
      const uiHost = process.env.CLOUDBEDS_UI_HOST || 'us2.cloudbeds.com'; // Default to us2 as requested
      const targetUrl = `https://${uiHost}/connect/${propertyPath}#/reservations/${reservationId}`;
      await page.goto(targetUrl);
      
      // Wait for SPA to either load the reservation or redirect to login
      await page.waitForTimeout(3000);
      
      // Check if we got redirected to login
      if (page.url().includes('login') || page.url().includes('signin')) {
          // Handle either the old login form or the new Okta SSO login form
      await page.waitForSelector('input[name="email"], input[name="user_email"]', { timeout: 15000 });
      const newEmailInput = await page.$('input[name="email"]');
      
      if (newEmailInput) {
          // New Okta Flow
          await page.fill('input[name="email"]', this.email);
          await page.click('button[type="submit"]');
          
          await page.waitForURL('**/authorize**', { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(2000);
          
          // Sometimes Okta asks to confirm the identifier first
          const idInput = await page.$('input[name="identifier"]');
          if (idInput) {
              await page.click('input[type="submit"], button[type="submit"]');
              await page.waitForTimeout(2000);
          }
          
          await page.fill('input[name="credentials.passcode"]', this.password);
          await page.click('input[type="submit"], button[type="submit"]');
      } else {
          // Legacy flow
          await page.fill('input[name="user_email"]', this.email);
          await page.fill('input[name="user_password"]', this.password);
          await page.click('button[type="submit"]');
      }

      // Wait for the connect dashboard to be loaded
      await page.waitForURL(`https://${this.host}/connect/*`, { timeout: 15000 }).catch(() => logger.warn('[STRIPE TERMINAL] Login redirect took too long, proceeding anyway...'));
      } // CLOSE THE IF BLOCK HERE

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
      await page.waitForTimeout(5000);
      await context.close();
      
      return { success: true, message: 'Terminal charge requested' };
    } catch (e) {
      logger.error(`[STRIPE TERMINAL] Failed to process physical charge: ${e.message}`);
      if (context) await context.close();
      throw e;
    }
  }
}

module.exports = { PaymentTerminal };
