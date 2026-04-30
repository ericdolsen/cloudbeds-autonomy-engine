const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { logger } = require('./logger');
const { VisionClicker } = require('./visionClicker');

// PaymentTerminal owns a long-lived Chrome instance dedicated to the kiosk's
// Stripe Terminal (WisePOS E) charge flow. Mirrors WhistleListener's lifecycle:
// launch once at server boot, keep the browser context alive for the process
// lifetime, hand out a fresh page per charge. This eliminates the 2-4s Chrome
// cold-start that used to be paid on every kiosk visit.
//
// Runs headed by default (the host is a single-purpose box that nobody else
// uses) and falls back to true headless if a headed launch can't acquire a
// window — that fallback path is slower on initial SPA bootstrap but keeps
// charges flowing without operator intervention.
class PaymentTerminal {
  constructor() {
    this.uiHost = process.env.CLOUDBEDS_UI_HOST || 'us2.cloudbeds.com';
    this.propertyId = process.env.CLOUDBEDS_PROPERTY_ID;
    this.email = process.env.CLOUDBEDS_EMAIL;
    this.password = process.env.CLOUDBEDS_PASSWORD;
    this.context = null;
    // Single long-lived "warm page" sitting on the Cloudbeds dashboard.
    // Each charge navigates this same page to the reservation URL via SPA
    // hash routing — no Chrome cold-start, no full SPA bootstrap, just a
    // route change. After the charge it goes back to the dashboard ready
    // for the next one.
    this.warmPage = null;
    // Dedup concurrent start() calls — if two callers race, only one
    // actual launch happens; the second awaits the first's promise.
    this._startPromise = null;
    this._userDataDir = path.join(__dirname, '..', '.cloudbeds_payment_session');
  }

  /**
   * Pre-warm the browser: launch Chrome on the dedicated user-data-dir,
   * navigate to the Cloudbeds dashboard, and run the auto-login flow if
   * the cached session has expired. Idempotent — safe to call from server
   * boot or lazily from chargePhysicalTerminal if start() was skipped.
   */
  async start() {
    if (this.context) return;
    if (this._startPromise) return this._startPromise;
    this._startPromise = this._launch();
    try {
      await this._startPromise;
    } finally {
      this._startPromise = null;
    }
  }

  async _launch() {
    logger.info(`[STRIPE TERMINAL] Pre-warming Chrome on ${path.basename(this._userDataDir)} ...`);

    // If a prior run crashed, an actual chrome.exe process may still be
    // alive holding this profile — Singleton* file cleanup alone doesn't
    // help because the lock isn't filesystem-only. Target-kill any
    // zombie chrome.exe whose command line references THIS dir; doesn't
    // touch the operator's Chrome or WhistleListener's profile.
    const { killChromesUsingDir, logChromeLandscape } = require('./chromeCleanup');
    logChromeLandscape('[STRIPE TERMINAL]');
    killChromesUsingDir(path.basename(this._userDataDir));
    try { fs.rmSync(path.join(this._userDataDir, 'SingletonLock'), { force: true }); } catch (e) {}
    try { fs.rmSync(path.join(this._userDataDir, 'SingletonCookie'), { force: true }); } catch (e) {}
    try { fs.rmSync(path.join(this._userDataDir, 'lockfile'), { force: true }); } catch (e) {}

    try {
      const launchOpts = {
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        channel: 'chrome',
        headless: false,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--window-size=1920,1080',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-session-crashed-bubble',
          '--hide-crash-restore-bubble'
        ],
        ignoreDefaultArgs: ['--enable-automation']
      };
      // Retry the launch a few times — Chrome occasionally exits with
      // code 0 on the first attempt ("Opening in existing browser
      // session") even after the targeted kill, surfacing as Playwright's
      // "Browser window not found". A short pause + re-kill + retry
      // usually clears it. If all headed attempts still fail (e.g. the
      // Windows session can't materialize a window for some reason), we
      // fall back once to true headless — slower for SPA bootstrap but
      // doesn't need an interactive desktop.
      let lastErr;
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          this.context = await chromium.launchPersistentContext(this._userDataDir, launchOpts);
          break;
        } catch (e) {
          lastErr = e;
          logger.warn(`[STRIPE TERMINAL] Launch attempt ${attempt}/4 failed: ${e.message.substring(0, 120)}`);
          if (attempt < 4) {
            killChromesUsingDir(path.basename(this._userDataDir));
            await new Promise(r => setTimeout(r, attempt * 1500));
          }
        }
      }
      if (!this.context) {
        logger.warn(`[STRIPE TERMINAL] All headed launches failed; falling back to true headless.`);
        killChromesUsingDir(path.basename(this._userDataDir));
        try { fs.rmSync(path.join(this._userDataDir, 'SingletonLock'), { force: true }); } catch (e) {}
        try { fs.rmSync(path.join(this._userDataDir, 'SingletonCookie'), { force: true }); } catch (e) {}
        try {
          this.context = await chromium.launchPersistentContext(this._userDataDir, { ...launchOpts, headless: true });
          logger.info(`[STRIPE TERMINAL] Headless fallback succeeded.`);
        } catch (e) {
          throw lastErr;
        }
      }

      await this.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.navigator.chrome = { runtime: {} };
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      });

      // Pre-navigate the long-lived warm page to the dashboard so the SPA
      // shell is parsed, the session is refreshed (or auto-login ran), and
      // every subsequent charge can hash-route into the reservation
      // without paying for a full bootstrap.
      this.warmPage = await this.context.newPage();
      const propertyPath = this.propertyId ? `${this.propertyId}` : '';
      const dashboardUrl = `https://${this.uiHost}/connect/${propertyPath}`;
      await this.warmPage.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.warmPage.waitForTimeout(3000);

      if (this._isLoginPage(this.warmPage.url())) {
        if (this.email && this.password) {
          logger.info(`[STRIPE TERMINAL] Pre-warm hit login page; running auto-login.`);
          await this._performLogin(this.warmPage);
        } else {
          logger.warn(`[STRIPE TERMINAL] Pre-warm hit login page and CLOUDBEDS_EMAIL/PASSWORD are not set. Run scripts/setupLogin.js to log in manually; charges will retry on demand.`);
        }
      }
      logger.info(`[STRIPE TERMINAL] Browser pre-warmed. Final URL: ${this.warmPage.url().substring(0, 80)}`);
    } catch (e) {
      logger.error(`[STRIPE TERMINAL] Pre-warm failed: ${e.message}`);
      if (this.context) {
        try { await this.context.close(); } catch {}
      }
      this.context = null;
    }
  }

  async stop() {
    if (this.context) {
      try { await this.context.close(); } catch (e) {}
      this.context = null;
      this.warmPage = null;
      logger.info(`[STRIPE TERMINAL] Browser stopped.`);
    }
  }

  _isLoginPage(url) {
    return url.includes('login') || url.includes('signin') || url.includes('okta');
  }

  async _performLogin(page) {
    // Okta has shipped multiple input names for the email field — accept
    // every variation we've seen so a UI revision doesn't break us.
    const emailSelector = 'input[name="email"], input[name="user_email"], input[name="identifier"], input[name="username"], input[type="email"]';
    await page.waitForSelector(emailSelector, { timeout: 30000 });
    const newEmailInput = await page.$('input[name="email"], input[name="identifier"], input[name="username"], input[type="email"]:not([name="user_email"])');

    if (newEmailInput) {
      await newEmailInput.fill(this.email);
      await page.click('button[type="submit"], input[type="submit"]');

      await page.waitForURL('**/authorize**', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);

      const idInput = await page.$('input[name="identifier"]');
      if (idInput) {
        await page.click('input[type="submit"], button[type="submit"]');
        await page.waitForTimeout(2000);
      }

      await page.fill('input[name="credentials.passcode"]', this.password);
      await page.click('input[type="submit"], button[type="submit"]');
    } else {
      // Legacy non-Okta flow
      await page.fill('input[name="user_email"]', this.email);
      await page.fill('input[name="user_password"]', this.password);
      await page.click('button[type="submit"]');
    }

    await page.waitForURL(`https://${this.uiHost}/connect/*`, { timeout: 15000 })
      .catch(() => logger.warn('[STRIPE TERMINAL] Login redirect took too long, proceeding anyway...'));
  }

  async chargePhysicalTerminal(reservationId, amount, terminalName) {
    if (!this.email || !this.password) {
      throw new Error("CLOUDBEDS_EMAIL and CLOUDBEDS_PASSWORD are required in .env for Playwright terminal access.");
    }

    // Lazy-start in case server boot skipped the pre-warm (e.g. earlier
    // crash) or the context closed itself unexpectedly.
    if (!this.context) {
      logger.info(`[STRIPE TERMINAL] No pre-warmed browser available; starting on-demand.`);
      await this.start();
    }
    if (!this.context) {
      throw new Error('Payment terminal browser is not available. Check CLOUDBEDS_UI_HOST, Chrome installation, and that scripts/setupLogin.js has been run for .cloudbeds_payment_session.');
    }

    logger.info(`[STRIPE TERMINAL] Charging $${amount} on ${terminalName} for ${reservationId}`);
    // Reuse the long-lived warm page if available — its SPA shell is
    // already booted, so navigating to the reservation hash is just a
    // route change, not a full reload. Open a fresh page only as a
    // fallback if the warm page was somehow lost.
    let page = this.warmPage;
    let usingWarmPage = !!page && !page.isClosed();
    if (!usingWarmPage) {
      page = await this.context.newPage();
      this.warmPage = page;
      usingWarmPage = true;
    }

    try {
      const vision = new VisionClicker(page);
      const propertyPath = this.propertyId ? `${this.propertyId}` : '';
      const dashboardUrl = `https://${this.uiHost}/connect/${propertyPath}#/dashboard`;

      let navigatedToReservation = false;
      const explicitUrl = `https://${this.uiHost}/connect/${propertyPath}#/reservations/r${reservationId}`;

      logger.info(`[STRIPE TERMINAL] Jumping straight to URL using alphanumeric prefix: ${explicitUrl}`);
      await page.goto(explicitUrl);
      await page.waitForTimeout(2000);
      
      if (this._isLoginPage(page.url())) {
        logger.info(`[STRIPE TERMINAL] Session expired mid-flight; re-logging in.`);
        await this._performLogin(page);
        await page.goto(explicitUrl);
        await page.waitForTimeout(2000);
      }
      navigatedToReservation = true;

      // Make sure the SPA actually routed to the reservation DETAIL view
      // and not the reservations LIST. The detail view exposes a Folio
      // role=tab; the list only has a Folio <th> column header. Without
      // this guard, the click below would resolve to the wrong element
      // and time out for ~60s.
      // Wait for the reservation detail view to render. The Folio tab is
      // a Bootstrap-style anchor (<a data-toggle="tab" href="#rs-folio-tab">),
      // NOT a WAI-ARIA role="tab" — Cloudbeds uses pre-ARIA Bootstrap tabs.
      // role:'link' with the exact accessible name 'Folio' skips both the
      // <th>Folio</th> on the reservations list view AND the hidden
      // Handlebars source template ({{{lang 'reservation/ResFolio_folio'}}}
      // ) that sits in the page waiting to be interpolated. The data-hook
      // attribute is the most stable selector if Cloudbeds ever renames
      // the visible string.
      const folioLink = page.getByRole('link', { name: 'Folio', exact: true });
      logger.info(`[STRIPE TERMINAL] Waiting for reservation detail view to load...`);
      try {
        await folioLink.waitFor({ state: 'visible', timeout: 15000 });
      } catch (e) {
        logger.warn(`[STRIPE TERMINAL] Folio tab didn't appear within 15s. URL: ${page.url()}. Re-navigating in case the SPA lost the hash route.`);
        await page.goto(explicitUrl);
        await page.waitForTimeout(3000);
        await folioLink.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      }

      // Switch to Folio tab
      logger.info(`[STRIPE TERMINAL] Switching to Folio tab...`);
      try {
        await folioLink.click({ timeout: 5000 });
      } catch (e) {
        // Fallback: target by data-hook="folio-tab", filtered to visible
        // so we skip the hidden Handlebars template that shares the
        // attribute. The data-hook is the API contract Cloudbeds uses
        // for QA selectors and is the most stable identifier here.
        logger.warn(`[STRIPE TERMINAL] Folio link click failed by accessible name; falling back to data-hook locator. ${e.message.substring(0, 80)}`);
        await page.locator('a[data-hook="folio-tab"]:visible').first().click({ timeout: 5000 });
      }
      await page.waitForTimeout(1000);

      // Click "ADD/REFUND PAYMENT" then "Add Payment"
      // The Folio toolbar's ADD/REFUND PAYMENT is a Bootstrap-era button;
      // the dropdown's "Add Payment" entry is `<a class="add-payment-btn-new">`
      // (per DOM dump line 21017). Two unrelated bulk-action menus on
      // other views also have an "Add Payment" link, so the legacy
      // text='Add Payment' .first() locator could land on the wrong one
      // when the page has the bulk dropdown open. Class-based selector
      // disambiguates and skips the hidden Handlebars template that has
      // the same text but no class.
      logger.info(`[STRIPE TERMINAL] Triggering 'Add Payment'...`);
      try {
        await page.locator('text=/ADD\\/REFUND PAYMENT/i').click({ timeout: 5000 });
      } catch (e) {
        logger.warn(`[STRIPE TERMINAL] Selector for 'ADD/REFUND PAYMENT' missed; falling back to vision lane.`);
        await vision.click("the 'ADD/REFUND PAYMENT' button on the folio toolbar");
      }
      try {
        await page.locator('a.add-payment-btn-new:visible').first().click({ timeout: 5000 });
      } catch (e) {
        logger.warn(`[STRIPE TERMINAL] Class-based 'Add Payment' selector missed; falling back to vision lane. ${e.message.substring(0, 80)}`);
        await vision.click("the 'Add Payment' menu item that appeared after clicking ADD/REFUND PAYMENT");
      }
      await page.waitForTimeout(1500);

      // Select "Terminal" payment method
      logger.info(`[STRIPE TERMINAL] Selecting 'Terminal' as payment method...`);
      await page.locator('text="Payment method"').locator('..').click();
      await page.keyboard.type('Terminal');
      await page.waitForTimeout(500);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1000);

      // Click Process Payment.
      // The button on the new Chakra-based payment side panel is
      // `<button type="button" class="chakra-button ...">Process Payment</button>`.
      // The text-based locator was matching legacy Bootstrap anchors
      // (`<a class="payment-processing-btns">Process Payment`) elsewhere
      // on the page that aren't clickable when the Chakra modal is open;
      // .first() landed on those, .click() timed out, and the vision-lane
      // fallback got confused (it kept clicking the Terminal dropdown
      // again). Role-based selector targets only the actual Chakra
      // button — Chakra Buttons render with role=button correctly.
      logger.info(`[STRIPE TERMINAL] Sending $${amount} to ${terminalName}. Waiting for guest to tap/insert card...`);
      try {
        await page.getByRole('button', { name: 'Process Payment', exact: true }).click({ timeout: 5000 });
      } catch (e) {
        logger.warn(`[STRIPE TERMINAL] Role-based 'Process Payment' selector missed; falling back to Chakra class locator. ${e.message.substring(0, 80)}`);
        try {
          await page.locator('button.chakra-button:visible', { hasText: 'Process Payment' }).first().click({ timeout: 5000 });
        } catch (e2) {
          logger.warn(`[STRIPE TERMINAL] Chakra class fallback also missed; falling back to vision lane. ${e2.message.substring(0, 80)}`);
          await vision.click("the 'Process Payment' confirmation button on the side panel");
        }
      }

      await page.waitForSelector('text="Choose terminal"', { timeout: 10000 });
      // The reader options are Chakra radios — `<label class="chakra-radio">
      // ... <span class="chakra-radio__label">Reader 1</span></label>`. The
      // visible label is a span, not the clickable target; clicking the
      // bare text was working accidentally because Playwright walks up to
      // the clickable ancestor, but role-based is the contract Chakra
      // actually exposes and is what we want when there are multiple
      // tablets in play (Reader 1, Reader 2). exact:true rules out a
      // partial match like "Reader 12" if Cloudbeds ever introduces it.
      try {
        await page.getByRole('radio', { name: terminalName, exact: true }).click({ timeout: 5000 });
      } catch (e) {
        // Fallback to the visible label span — same target Playwright
        // would walk up from, but explicit so we don't depend on the
        // text-locator's ambiguity.
        logger.warn(`[STRIPE TERMINAL] Role-based '${terminalName}' radio missed; falling back to label span. ${e.message.substring(0, 80)}`);
        await page.locator('span.chakra-radio__label:visible', { hasText: terminalName }).first().click({ timeout: 5000 });
      }

      logger.info(`[STRIPE TERMINAL] Waiting for physical card read on ${terminalName}...`);
      await page.waitForSelector('text="Now processing with terminal"', { state: 'visible', timeout: 10000 }).catch(() => {});
      await page.waitForSelector('text="Now processing with terminal"', { state: 'hidden', timeout: 90000 });

      logger.info(`[STRIPE TERMINAL] Transaction successful!`);
      await page.waitForTimeout(5000);

      // Park the warm page back on the dashboard so the next charge has
      // a fresh, settled SPA state to hash-route from. Don't close it.
      try {
        const propertyPath = this.propertyId ? `${this.propertyId}` : '';
        await page.goto(`https://${this.uiHost}/connect/${propertyPath}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (parkErr) {
        logger.warn(`[STRIPE TERMINAL] Could not park warm page back at dashboard: ${parkErr.message}`);
      }

      return { success: true, message: 'Terminal charge requested' };
    } catch (e) {
      logger.error(`[STRIPE TERMINAL] Failed to process physical charge: ${e.message}`);
      // Don't close the warm page on failure — keep it alive for the
      // next attempt. BUT: if the failure left a Chakra modal open
      // (very common when the click chain breaks mid-Add-Payment),
      // the next charge's Folio click gets blocked by
      // `<div class="chakra-modal__content-container"> ... intercepts
      // pointer events`. Best-effort cleanup so the retry has a clean
      // page: press Escape to dismiss the modal, then park the warm
      // page back at the dashboard URL so the next charge starts fresh.
      try {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
        await page.keyboard.press('Escape').catch(() => {}); // some Chakra modals nest
        const propertyPath = this.propertyId ? `${this.propertyId}` : '';
        await page.goto(`https://${this.uiHost}/connect/${propertyPath}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch (cleanupErr) {
        logger.warn(`[STRIPE TERMINAL] Post-failure modal cleanup failed: ${cleanupErr.message.substring(0, 120)}`);
      }
      throw e;
    }
  }
}

module.exports = { PaymentTerminal };
