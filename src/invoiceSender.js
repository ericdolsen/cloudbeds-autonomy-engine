const path = require('path');
const fs = require('fs');
const { logger } = require('./logger');

require('dotenv').config();

class InvoiceSender {
  constructor(visionAgent) {
    this.vision = visionAgent;
    this.host = process.env.CLOUDBEDS_HOST || 'us2.cloudbeds.com';
    this.propertyId = process.env.CLOUDBEDS_PROPERTY_ID;
  }

  /**
   * Full vision-guided flow:
   * 1. Navigate to dashboard
   * 2. Use search bar to find reservation by confirmation number
   * 3. Click the search result
   * 4. Click ACTIONS button
   * 5. Click "Email Invoice" from dropdown
   * 6. Click "EMAIL INVOICE" button in the confirmation modal
   */
  async sendInvoice(page, reservationId) {
    logger.info(`=== Starting invoice send for reservation: ${reservationId} ===`);

    // Pre-Step: Navigate to Dashboard to ensure side-panel URL trick works
    const dashboardUrl = `https://${this.host}/connect/${this.propertyId}#/dashboard`;
    logger.info(`Navigating to dashboard before searching: ${dashboardUrl}`);
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Step 1: Search for the reservation
    logger.info(`Step 1: Searching for reservation ${reservationId}...`);

    let searchClicked = false;
    const searchSelectors = [
      'input[placeholder*="Search" i]',
      'input[placeholder*="reservation" i]',
      '[role="search"] input',
      '[role="searchbox"]',
      'input[type="search"]',
    ];
    for (const sel of searchSelectors) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          await el.click();
          searchClicked = true;
          logger.info(`Clicked search bar via selector: ${sel}`);
          break;
        }
      } catch (e) { continue; }
    }

    if (!searchClicked) {
      // Fall back to vision
      await this.visionStep(page, 'Find and click the search bar at the top of the page. It is an input field that says "Search reservations, guests, and more".', {
        reservationId,
        step: 'click search bar',
      });
    }

    await page.waitForTimeout(500);
    await page.keyboard.type(reservationId, { delay: 80 });

    logger.info('Waiting for search results to load...');
    await page.waitForTimeout(3000);

    // Step 2: Click the search result to open the side panel
    logger.info('Step 2: Clicking search result...');

    await this.visionStep(page, `A search dropdown menu should be visible below the search bar. Click the exact search result or link containing the reservation ID ${reservationId}. Do NOT click the search bar itself, and do NOT press Enter. Click the item in the dropdown list.`, {
      reservationId,
      step: 'click search result dropdown',
    });

    await page.waitForTimeout(3000);

    // Step 3: Extract the internal reservation ID from the modified URL
    logger.info('Step 3: Extracting internal reservation ID from the updated URL...');
    let navigatedToReservation = false;
    let currentUrl = page.url();
    
    // Cloudbeds side panel appends ?reservationId=INTERNAL_NUMBER to the URL
    const match = currentUrl.match(/reservation[iI]d=(\d+)/);
    
    if (match && match[1]) {
      const internalId = match[1];
      logger.info(`Found internal numeric reservation ID: ${internalId}`);
      
      const targetUrl = `https://${this.host}/connect/${this.propertyId}#/reservations/${internalId}`;
      logger.info(`Navigating directly to explicit reservation page: ${targetUrl}`);
      
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
      navigatedToReservation = true;
    } else {
      logger.warn(`Could not find reservationId in URL: ${currentUrl}.`);
    }

    if (!navigatedToReservation) {
      logger.warn('Could not implicitly navigate to full reservation page — attempting ACTIONS anyway.');
    }

    // Step 3: Click ACTIONS button
    logger.info('Step 3: Clicking ACTIONS button...');
    await this.visionStep(page, 'Click the "ACTIONS" button. It is typically a blue button in the top-right area of the reservation page.', {
      reservationId,
      step: 'click ACTIONS',
    });
    await page.waitForTimeout(1500);

    // Step 4: Click "Email Invoice" from dropdown
    logger.info('Step 4: Clicking "Email Invoice" in dropdown...');
    await this.visionStep(page, 'A dropdown menu is now showing. Click "Email Invoice" — it should be near the top of the menu, under an "INVOICE" section. Do NOT click "Email Folio" — only "Email Invoice".', {
      reservationId,
      step: 'click Email Invoice',
    });
    await page.waitForTimeout(2000);

    // Step 5: Click the EMAIL INVOICE confirmation button in the modal
    logger.info('Step 5: Confirming — clicking EMAIL INVOICE button...');
    await this.visionStep(page, 'A confirmation modal/dialog is now showing. Click the blue "EMAIL INVOICE" button to confirm sending the invoice. The guest email should already be pre-selected as the recipient.', {
      reservationId,
      step: 'click EMAIL INVOICE confirm',
    });
    await page.waitForTimeout(2000);

    logger.info(`=== Invoice sent for reservation ${reservationId}! ===`);
  }

  /**
   * Run a single vision-guided step with retries.
   * Takes a screenshot, asks Claude what to do, executes the action.
   */
  async visionStep(page, task, context, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const analysis = await this.vision.analyzeScreen(page, task, context);

        if (analysis.action === 'success') {
          logger.info(`Step complete: ${analysis.reason}`);
          return;
        }

        if (analysis.action === 'error') {
          logger.error(`Vision error on step "${context.step}": ${analysis.reason}`);
          if (attempt < maxRetries - 1) {
            logger.info(`Retrying step (attempt ${attempt + 2}/${maxRetries})...`);
            await page.waitForTimeout(2000);
            continue;
          }
          throw new Error(`Step "${context.step}" failed: ${analysis.reason}`);
        }

        const executed = await this.vision.executeAction(page, analysis);

        if (executed) {
          return; // Action succeeded
        }

        // Action failed to execute — retry
        if (attempt < maxRetries - 1) {
          logger.warn(`Could not execute action on step "${context.step}", retrying...`);
          await page.waitForTimeout(2000);
        }
      } catch (error) {
        if (error.message.includes('Step "') && error.message.includes('" failed')) {
          throw error; // Re-throw vision errors
        }
        logger.error(`Error during step "${context.step}":`, error.message);
        if (attempt < maxRetries - 1) {
          await page.waitForTimeout(2000);
        }
      }
    }

    // Save debug screenshot on final failure
    await this.saveDebugScreenshot(page, context.reservationId, context.step);
    throw new Error(`Step "${context.step}" failed after ${maxRetries} attempts`);
  }

  async saveDebugScreenshot(page, reservationId, step) {
    try {
      const screenshotDir = path.join(__dirname, '..', 'screenshots');
      if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
      const safeName = step.replace(/[^a-z0-9]/gi, '-');
      const screenshotPath = path.join(screenshotDir, `${safeName}-${reservationId}-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      logger.info(`Debug screenshot saved: ${screenshotPath}`);
    } catch (e) {
      logger.error('Failed to save screenshot:', e.message);
    }
  }
}

module.exports = { InvoiceSender };
