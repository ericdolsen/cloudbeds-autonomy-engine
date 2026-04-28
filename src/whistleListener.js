const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { logger } = require('./logger');

class WhistleListener {
  constructor(autonomyAgent) {
    this.agent = autonomyAgent;
    this.host = process.env.CLOUDBEDS_UI_HOST || 'us2.cloudbeds.com';
    this.whistleUrl = process.env.CLOUDBEDS_WHISTLE_URL || `https://${this.host}/guest_experience/inbox`;
    this.isRunning = false;
    this.context = null;
    this.page = null;
    this._loggedOut = false;
    this._lastLoginWarnAt = 0;
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info(`[WHISTLE RPA] Starting headless browser to monitor Whistle Inbox at ${this.whistleUrl}...`);

    try {
      const userDataDir = path.join(__dirname, '..', '.cloudbeds_session');
      
      // Force-kill any lingering Chrome processes from previous aborted runs
      // that might be holding a lock on the user data directory.
      try {
          logger.info('[WHISTLE RPA] Cleaning up any zombie Chrome processes...');
          require('child_process').execSync('taskkill /IM chrome.exe /F /T', { stdio: 'ignore' });
      } catch (e) {
          // It will throw if no chrome.exe is found, which is fine.
      }

      // Clean up stale locks that cause Chrome to exit with code 0
      try { fs.rmSync(path.join(userDataDir, 'SingletonLock'), { force: true }); } catch (e) {}
      try { fs.rmSync(path.join(userDataDir, 'SingletonCookie'), { force: true }); } catch (e) {}
      try { fs.rmSync(path.join(userDataDir, 'lockfile'), { force: true }); } catch (e) {}
      
      this.context = await chromium.launchPersistentContext(userDataDir, { 
          executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          channel: 'chrome',
          headless: false, // Run headlessly? User might want to see it, or keep it hidden. Set to false for "-32000" position trick
          args: [
              '--disable-blink-features=AutomationControlled',
              '--window-size=1920,1080',
              '--disable-gpu',
              '--disable-software-rasterizer',
              '--disable-session-crashed-bubble',
              '--hide-crash-restore-bubble'
          ],
          ignoreDefaultArgs: ['--enable-automation']
      });

      await this.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.navigator.chrome = { runtime: {} };
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      });

      this.page = await this.context.newPage();
      // domcontentloaded, not networkidle: Cloudbeds keeps long-poll/WebSocket
      // connections open indefinitely, so 'networkidle' never fires and times
      // out at 30s. domcontentloaded returns as soon as the SPA shell is up;
      // the polling loop then waits for the inbox to hydrate on its own.
      await this.page.goto(this.whistleUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

      this._startPollingLoop();

    } catch (err) {
      logger.error(`[WHISTLE RPA] Failed to start listener: ${err.message}`);
      this.isRunning = false;
      if (this.context) await this.context.close();
    }
  }

  async _startPollingLoop() {
    logger.info(`[WHISTLE RPA] Polling loop started.`);
    while (this.isRunning) {
      try {
        await this._pollForMessages();
      } catch (err) {
        logger.error(`[WHISTLE RPA] Error during polling cycle: ${err.message}`);
      }
      // Back off to 60s when logged out — there's no point polling the OAuth
      // page every 10s, and the warning spam fills the log.
      const cooldownMs = this._loggedOut ? 60000 : 10000;
      await new Promise(resolve => setTimeout(resolve, cooldownMs));
    }
  }

  async _pollForMessages() {
    if (!this.page) return;

    const currentUrl = this.page.url();
    if (currentUrl.includes('login') || currentUrl.includes('auth')) {
        this._loggedOut = true;
        // Rate-limit to once every 5 minutes — without this, the warning
        // (which includes the full OAuth URL) fires on every poll and
        // dominates the log file.
        const now = Date.now();
        if (now - this._lastLoginWarnAt > 5 * 60 * 1000) {
          this._lastLoginWarnAt = now;
          logger.warn(`[WHISTLE RPA] Cloudbeds session expired — browser is on the OAuth login page. Log in manually in the visible Chrome window; cookies will persist in .cloudbeds_session/ for next time. URL: ${currentUrl.substring(0, 120)}`);
        }
        return;
    }
    if (this._loggedOut) {
      logger.info('[WHISTLE RPA] Login restored — resuming normal polling cadence.');
      this._loggedOut = false;
    }

    // Whistle uses Chakra UI. The unread badge is `span.chakra-badge` with the
    // exact text "Unread" (red pill, #F3565D). Other badges in the same list
    // say "Replied" / "Error" / "Delivered" / "SMS" / "@" — so we MUST filter
    // by text, otherwise .first() returns a non-unread badge (or a hidden one
    // from somewhere else in the DOM) and isVisible() fails silently.
    // The `:visible` pseudo skips off-screen / display:none badges that exist
    // in the DOM but aren't actually rendered.
    let targetContext = null;
    let unreadIndicator = null;

    for (const frame of this.page.frames()) {
        const indicator = frame
            .locator('span.chakra-badge:visible', { hasText: /^\s*unread\s*$/i })
            .first();
        const isVis = await indicator.isVisible().catch(() => false);
        if (isVis) {
            targetContext = frame;
            unreadIndicator = indicator;
            break;
        }
    }

    if (!unreadIndicator) {
        // Just quietly wait
        return;
    }

    logger.info(`[WHISTLE RPA] Unread message detected! Extracting...`);

    // The badge is a small span inside the conversation row. Clicking the badge
    // itself doesn't always trigger the row's onClick — walk up to the nearest
    // clickable ancestor (button / link / role=button / row with onclick).
    const clickableRow = unreadIndicator.locator(
        'xpath=ancestor::*[self::a or self::button or @role="button" or @role="listitem" or @role="link" or @onclick or @tabindex][1]'
    );
    if ((await clickableRow.count()) > 0) {
        await clickableRow.first().click();
    } else {
        await unreadIndicator.click();
    }
    await this.page.waitForTimeout(2000); // Wait for chat to load

    let textToProcess = '';
    const chatRegion = targetContext.getByRole('region', { name: /chat|messages|conversation/i }).first();
    if (await chatRegion.isVisible().catch(() => false)) {
        textToProcess = await chatRegion.innerText();
    } else {
        // Fallbacks, ordered most-specific to least: Chakra/Whistle conversation
        // panels, then generic main element. We anchor on the input we just
        // located if everything else fails, by walking up to its panel.
        const fallback = targetContext.locator(
            '[class*="conversation"], [class*="chat"], [class*="messages"], main, [role="main"]'
        ).first();
        if (await fallback.isVisible().catch(() => false)) {
            textToProcess = await fallback.innerText();
        }
    }

    if (!textToProcess) {
       logger.warn(`[WHISTLE RPA] Could not extract text from the chat area.`);
       return;
    }

    logger.info(`[WHISTLE RPA] Sending extracted chat to Autonomy Engine...`);
    
    const agentPrompt = `
You are reading a raw scrape of an SMS chat window. 
Identify the guest's latest message and generate a helpful, concise SMS response.
Do not include any formatting or markdown in your response, just the raw text you want to send.

Raw Chat UI Text:
${textToProcess.substring(0, 1500)}
    `;

    let aiResponseText = "";
    try {
        // processIncomingMessage expects an object with source and text, and optionally uses tools. 
        // We bypass the JSON payload constraint by sending it as raw text and instructing the engine to just reply.
        const engineResult = await this.agent.processIncomingMessage({
            source: 'whistle_rpa',
            text: agentPrompt
        });
        
        // Assume engineResult is a string, or contains the final output string.
        aiResponseText = typeof engineResult === 'string' ? engineResult : JSON.stringify(engineResult);
        
        // Sanitize the response (remove quotes or thought blocks if Gemini leaks them)
        aiResponseText = aiResponseText.replace(/`/g, '').trim();

    } catch(err) {
        logger.error(`[WHISTLE RPA] Autonomy Engine failed to generate response: ${err.message}`);
        aiResponseText = "Sorry, our automated system is experiencing issues. A human will be with you shortly.";
    }

    logger.info(`[WHISTLE RPA] Injecting AI response into UI...`);
    
    // Whistle's compose box has placeholder "Type your message..." — match the
    // exact phrase first, then fall back to broader patterns in case the UI
    // copy changes.
    let inputArea = targetContext.getByPlaceholder(/type your message/i).first();
    if (!(await inputArea.isVisible().catch(() => false))) {
        inputArea = targetContext.getByPlaceholder(/type a message|reply|message/i).first();
    }
    if (await inputArea.isVisible().catch(() => false)) {
        await inputArea.fill(aiResponseText);

        // Send button is labeled "Send" (icon + text) in the bottom-right.
        const sendBtn = targetContext.getByRole('button', { name: /^\s*send\s*$/i }).first();
        if (await sendBtn.isVisible().catch(() => false)) {
            await sendBtn.click();
            logger.info(`[WHISTLE RPA] Successfully sent response!`);
        } else {
            await inputArea.press('Enter');
            logger.info(`[WHISTLE RPA] Successfully sent response via Enter key!`);
        }
    } else {
        logger.warn(`[WHISTLE RPA] Could not find the input text area to type the response.`);
    }

    await this.page.waitForTimeout(5000);
  }

  async stop() {
    this.isRunning = false;
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    logger.info(`[WHISTLE RPA] Listener stopped.`);
  }
}

module.exports = { WhistleListener };
