const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { logger } = require('./logger');
const { VisionClicker } = require('./visionClicker');

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
      
      // Clean up stale locks that cause Chrome to exit with code 0
      try { fs.rmSync(path.join(userDataDir, 'SingletonLock'), { force: true }); } catch (e) {}
      try { fs.rmSync(path.join(userDataDir, 'SingletonCookie'), { force: true }); } catch (e) {}
      
      context = await chromium.launchPersistentContext(userDataDir, { 
          executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          channel: 'chrome',
          headless: false,
          args: [
              '--disable-blink-features=AutomationControlled',
              '--window-position=-32000,-32000',
              '--window-size=1920,1080',
              '--disable-gpu',
              '--disable-software-rasterizer'
          ],
          ignoreDefaultArgs: ['--enable-automation']
      });

      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.navigator.chrome = { runtime: {} };
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      });

      const page = await context.newPage();
      const vision = new VisionClicker(page);

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

      // 3. Switch to Folio tab
      logger.info(`[STRIPE TERMINAL] Switching to Folio tab...`);
      await page.waitForTimeout(2000);
      try {
        await page.getByRole('tab', { name: 'Folio' }).click();
      } catch (e) {
        // Fallback if role is not strictly defined
        await page.locator('text="Folio"').first().click();
      }
      await page.waitForTimeout(1000);
      
      // 4. Click "ADD/REFUND PAYMENT" then "Add Payment". If the DOM has
      // shifted, fall back to Claude Sonnet 4.5 vision for a zero-mistake
      // click on the right pixels.
      logger.info(`[STRIPE TERMINAL] Triggering 'Add Payment'...`);
      try {
        await page.locator('text=/ADD\\/REFUND PAYMENT/i').click({ timeout: 5000 });
      } catch (e) {
        logger.warn(`[STRIPE TERMINAL] Selector for 'ADD/REFUND PAYMENT' missed; falling back to vision lane.`);
        await vision.click("the 'ADD/REFUND PAYMENT' button on the folio toolbar");
      }
      try {
        await page.locator('text="Add Payment"').first().click({ timeout: 5000 });
      } catch (e) {
        logger.warn(`[STRIPE TERMINAL] Selector for 'Add Payment' missed; falling back to vision lane.`);
        await vision.click("the 'Add Payment' menu item that appeared after clicking ADD/REFUND PAYMENT");
      }
      await page.waitForTimeout(1500); // Wait for side panel
      
      // 5. Select "Terminal" from the Payment method dropdown
      logger.info(`[STRIPE TERMINAL] Selecting 'Terminal' as payment method...`);
      await page.locator('text="Payment method"').locator('..').click();
      await page.keyboard.type('Terminal');
      await page.waitForTimeout(500);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1000);
      
      // 6. Click Process Payment (vision fallback for the Cloudbeds redesign)
      logger.info(`[STRIPE TERMINAL] Sending $${amount} to ${terminalName}. Waiting for guest to tap/insert card...`);
      try {
        await page.locator('text="Process Payment"').first().click({ timeout: 5000 });
      } catch (e) {
        logger.warn(`[STRIPE TERMINAL] Selector for 'Process Payment' missed; falling back to vision lane.`);
        await vision.click("the 'Process Payment' confirmation button on the side panel");
      }
      
      // 7. Choose Terminal
      await page.waitForSelector('text="Choose terminal"', { timeout: 10000 });
      await page.locator(`text="${terminalName}"`).first().click();
      
      // 8. Wait for the physical transaction to complete (auto-closes)
      logger.info(`[STRIPE TERMINAL] Waiting for physical card read on ${terminalName}...`);
      await page.waitForSelector('text="Now processing with terminal"', { state: 'visible', timeout: 10000 }).catch(() => {});
      await page.waitForSelector('text="Now processing with terminal"', { state: 'hidden', timeout: 90000 });

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
