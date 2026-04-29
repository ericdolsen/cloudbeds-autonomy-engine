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

    // Whistle's hashed inbox URL (#/inbox/guest-chat) lands on a channel
    // selector, NOT the conversation list. The body shows "Select a
    // conversation" plus a sidebar of channels (Guest, Housekeeping, etc.),
    // each with its own unread-count badge. We have to click the channel
    // row to actually load the conversation list — without that, no
    // "Unread" pills can ever appear because the list itself never renders.
    //
    // The unread-count badge uses a different Chakra class hash than the
    // "New"/"Beta" feature flags (numeric content vs. word content), so we
    // identify it by filtering chakra-badges to ones whose text is digits.
    const emptyState = await this.page.locator('text=/Select a conversation/i').first()
        .isVisible().catch(() => false);
    if (emptyState) {
        const channelCountBadge = this.page.locator('span.chakra-badge:visible')
            .filter({ hasText: /^\s*\d+\s*$/ })
            .first();
        if (await channelCountBadge.isVisible().catch(() => false)) {
            const channelRow = channelCountBadge.locator(
                'xpath=ancestor::*[self::a or self::button or @role="button" or @onclick or @tabindex][1]'
            );
            if ((await channelRow.count()) > 0) {
                logger.info('[WHISTLE RPA] Inbox is on the channel selector ("Select a conversation"); clicking the channel with unread count to load the conversation list.');
                await channelRow.first().click();
                await this.page.waitForTimeout(2500);
            }
        }
    }

    // Whistle's "Unread" pill is a red Chakra badge. Earlier attempts targeted
    // span.chakra-badge filtered by hasText, but that failed to match in
    // practice — likely because the visible text is rendered via a CSS pseudo-
    // element, nested wrapper, or a non-textContent mechanism. getByText with
    // exact: true is structure-agnostic: it matches any element whose
    // accessible text is exactly "Unread", regardless of class hash or nesting.
    let targetContext = null;
    let unreadIndicator = null;
    const debugRpa = process.env.WHISTLE_RPA_DEBUG === 'true';

    for (const frame of this.page.frames()) {
        const candidates = frame.getByText('Unread', { exact: true });
        const total = await candidates.count().catch(() => 0);

        if (debugRpa) {
            const sampleBadges = frame.locator('span.chakra-badge');
            const badgeCount = await sampleBadges.count().catch(() => 0);
            const sampleTexts = [];
            for (let i = 0; i < Math.min(badgeCount, 10); i++) {
                const t = await sampleBadges.nth(i).innerText().catch(() => '');
                sampleTexts.push(t.replace(/\s+/g, ' ').substring(0, 24));
            }
            logger.info(`[WHISTLE RPA DEBUG] frame=${frame.url().substring(0, 80)} unreadTextMatches=${total} chakraBadges=${badgeCount} sample=${JSON.stringify(sampleTexts)}`);

            // Deep scan: getByText returns 0 even when "Unread" pills are
            // visible, which means the label is rendered via something
            // Playwright's text engine can't see (CSS ::before content, SVG
            // <text>, or a non-textContent mechanism). Walk the whole DOM and
            // log every visible element where textContent OR className OR
            // aria-label OR a CSS ::before/::after `content` includes "unread".
            // The output identifies the exact tag/class to target.
            const findings = await frame.evaluate(() => {
                const out = { textHits: [], classHits: [], ariaHits: [], pseudoHits: [] };
                const all = document.querySelectorAll('body *');
                for (const el of all) {
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    const direct = Array.from(el.childNodes)
                        .filter(n => n.nodeType === Node.TEXT_NODE)
                        .map(n => n.textContent.trim())
                        .join(' ');
                    if (/unread/i.test(direct) && direct.length < 60) {
                        out.textHits.push({
                            tag: el.tagName.toLowerCase(),
                            cls: String(el.className || '').substring(0, 60),
                            text: direct.substring(0, 40),
                        });
                    }
                    const cls = String(el.className || '');
                    if (/unread/i.test(cls)) {
                        out.classHits.push({ tag: el.tagName.toLowerCase(), cls: cls.substring(0, 60) });
                    }
                    const aria = el.getAttribute('aria-label') || '';
                    if (/unread/i.test(aria)) {
                        out.ariaHits.push({ tag: el.tagName.toLowerCase(), aria: aria.substring(0, 40) });
                    }
                    try {
                        const before = window.getComputedStyle(el, '::before').content || '';
                        const after = window.getComputedStyle(el, '::after').content || '';
                        if (/unread/i.test(before) || /unread/i.test(after)) {
                            out.pseudoHits.push({
                                tag: el.tagName.toLowerCase(),
                                cls: cls.substring(0, 60),
                                before: before.substring(0, 30),
                                after: after.substring(0, 30),
                            });
                        }
                    } catch (e) { /* getComputedStyle can throw on detached nodes */ }
                    if (out.textHits.length + out.classHits.length + out.ariaHits.length + out.pseudoHits.length >= 20) break;
                }
                return out;
            }).catch((e) => ({ textHits: [], classHits: [], ariaHits: [], pseudoHits: [], err: String(e).substring(0, 80) }));
            logger.info(`[WHISTLE RPA DEBUG] unreadFinder=${JSON.stringify(findings).substring(0, 1200)}`);

            // The unreadFinder returned all-empty hits, meaning "Unread" is
            // not present in the bot's live DOM. Either (a) the bot's Chrome
            // is showing a different inbox view than the user's regular
            // browser (e.g. Whistle auto-marks messages as read when the
            // inbox is the active view), or (b) the pills we saw in the
            // screenshot are NOT chakra-badge elements at all and the four
            // visible badges are the small icon chips next to names.
            //
            // This pageScan resolves both: it dumps the body's visible text
            // (so we can see whether "Unread"/"Replied"/"Error" appear at
            // all) plus the outerHTML of each chakra-badge so we can identify
            // what they actually are.
            const pageScan = await frame.evaluate(() => {
                const body = document.body;
                const innerText = body ? (body.innerText || '').replace(/\s+/g, ' ').trim() : '';
                const sample = innerText.substring(0, 600);
                const hasUnread = /unread/i.test(innerText);
                const hasReplied = /replied/i.test(innerText);
                const hasError = /\berror\b/i.test(innerText);
                const badges = Array.from(document.querySelectorAll('span.chakra-badge'))
                    .slice(0, 8)
                    .map(el => ({
                        outer: el.outerHTML.substring(0, 180),
                        text: (el.textContent || '').trim().substring(0, 30),
                    }));
                return { sample, hasUnread, hasReplied, hasError, badges };
            }).catch(e => ({ err: String(e).substring(0, 80) }));
            logger.info(`[WHISTLE RPA DEBUG] pageScan=${JSON.stringify(pageScan).substring(0, 1500)}`);
        }

        for (let i = 0; i < total; i++) {
            const el = candidates.nth(i);
            if (await el.isVisible().catch(() => false)) {
                targetContext = frame;
                unreadIndicator = el;
                break;
            }
        }
        if (unreadIndicator) break;
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

    // After clicking the unread row, the URL hash changes immediately to
    // .../guest-chat/<convId>, but the right-pane chat content takes a
    // moment to render. The reliable signal that the chat is actually
    // loaded is the compose textbox becoming visible. Anchoring on the
    // compose input also gives us a precise locator for the chat panel —
    // scraping the whole frame returns the conversation list (sidebar)
    // because that's what dominates the early DOM.
    const composeInput = targetContext.getByPlaceholder(/type your message|type a message|reply|message/i).first();
    try {
        await composeInput.waitFor({ state: 'visible', timeout: 8000 });
    } catch (e) {
        logger.warn(`[WHISTLE RPA] Compose box did not appear within 8s after opening conversation; skipping cycle. URL: ${this.page.url()}`);
        await this.page.waitForTimeout(2000);
        return;
    }

    // Scrape the chat panel only — walk up from the input to its enclosing
    // section/region/main. Without this, scraping a generic [class*="chat"]
    // fallback pulls in the sidebar's 30+ conversation rows and the engine
    // sees the conversation list instead of the actual messages.
    let textToProcess = '';
    const chatPanel = composeInput.locator(
        'xpath=ancestor::*[self::section or self::main or @role="region" or @role="main" or contains(@class,"thread") or contains(@class,"conversation-detail") or contains(@class,"chat-detail") or contains(@class,"messageList")][1]'
    );
    if ((await chatPanel.count()) > 0) {
        textToProcess = await chatPanel.first().innerText().catch(() => '');
    }
    if (!textToProcess) {
        // Fallback: grab the input's parent panel a few levels up — still
        // anchored on the input so we don't grab the entire frame.
        textToProcess = await composeInput.locator('xpath=ancestor::*[4]').innerText().catch(() => '');
    }

    if (!textToProcess) {
       logger.warn(`[WHISTLE RPA] Could not extract text from the chat area.`);
       return;
    }

    // Recency guard: don't auto-reply to a thread whose latest activity is
    // older than RECENCY_CUTOFF. Protects against an outage backlog (e.g.
    // server was offline for 4 hours; the agent should NOT wake up and
    // mass-reply to every guest who messaged during the downtime).
    const cutoffMs = Number(process.env.WHISTLE_RECENCY_CUTOFF_MS) || 60 * 60 * 1000;
    const latestActivityAt = this._extractLatestTimestamp(textToProcess);
    if (latestActivityAt) {
        const ageMs = Date.now() - latestActivityAt;
        if (ageMs > cutoffMs) {
            const ageMin = Math.round(ageMs / 60000);
            const cutoffMin = Math.round(cutoffMs / 60000);
            logger.warn(`[WHISTLE RPA] Latest message is ${ageMin}min old (>${cutoffMin}min cutoff); skipping auto-reply. A human should respond.`);
            await this.page.waitForTimeout(5000);
            return;
        }
    } else if (debugRpa) {
        logger.info(`[WHISTLE RPA DEBUG] No timestamp parsed from chat text; skipping recency guard for this thread.`);
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

    // Reuse the composeInput we already located and waited on — guarantees
    // we type into the right pane's textbox, not some other text field
    // elsewhere on the page.
    if (await composeInput.isVisible().catch(() => false)) {
        await composeInput.fill(aiResponseText);

        // Send button is labeled "Send" (icon + text) in the bottom-right.
        const sendBtn = targetContext.getByRole('button', { name: /^\s*send\s*$/i }).first();
        if (await sendBtn.isVisible().catch(() => false)) {
            await sendBtn.click();
            logger.info(`[WHISTLE RPA] Successfully sent response!`);
        } else {
            await composeInput.press('Enter');
            logger.info(`[WHISTLE RPA] Successfully sent response via Enter key!`);
        }
    } else {
        logger.warn(`[WHISTLE RPA] Could not find the input text area to type the response.`);
    }

    await this.page.waitForTimeout(5000);
  }

  /**
   * Best-effort parser for the most recent timestamp in a Whistle chat scrape.
   * Whistle renders timestamps in a few flavors:
   *   - Today only:        "1:25 PM", "11:39 AM"
   *   - With month/day:    "Apr 25 8:46 AM", "Apr 25, 2026 8:46 AM"
   *   - Date headers:      "April 25, 2026"
   * Returns the latest parseable timestamp as ms-since-epoch, or null if
   * nothing parseable was found. Errs on the side of returning null rather
   * than a wrong date — null disables the recency guard for that thread,
   * which is the safer default than incorrectly skipping a fresh message.
   */
  _extractLatestTimestamp(text) {
    if (!text) return null;
    const todayPrefix = new Date().toDateString(); // e.g. "Tue Apr 28 2026"
    const candidates = [];

    // Combined pattern: optional month/day prefix, then HH:MM AM/PM.
    const rx = /(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?\s+)?\d{1,2}:\d{2}\s*(?:AM|PM)/gi;
    const matches = text.match(rx) || [];
    for (const raw of matches) {
        const m = raw.trim();
        let parsed = Date.parse(m);
        if (isNaN(parsed)) {
            // Bare time like "1:25 PM" — assume today.
            parsed = Date.parse(`${todayPrefix} ${m}`);
        }
        if (!isNaN(parsed)) {
            candidates.push(parsed);
        }
    }

    if (!candidates.length) return null;
    return Math.max(...candidates);
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
