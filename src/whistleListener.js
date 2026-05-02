const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { logger } = require('./logger');

// Booking.com / Expedia / etc forward guest messages into Whistle but
// explicitly say "any reply through any other channel will not be
// recorded". If the model composes an SMS reply to one of these, it
// goes into Whistle and the guest never sees it (the OTA's extranet
// is the only channel that's actually delivered). The model can't
// reliably notice this from inside a 1000+ char raw scrape, so we
// gate at the ingest layer.
const OTA_PREFIX_RE = /\bfrom\s+(booking\.?com|expedia|hotels\.com|agoda|airbnb|priceline|orbitz|travelocity|kayak|trivago)\s*[:\-]/i;
const OTA_MARKER_RE = /(will not be recorded|respond via the extranet|respond.*?in the extranet|via the (?:partner|booking) (?:site|portal|extranet)|via your extranet)/i;
const OTA_DISPLAY_NAMES = {
  'booking.com': 'Booking.com',
  'bookingcom':  'Booking.com',
  'booking':     'Booking.com',
  'expedia':     'Expedia',
  'hotels.com':  'Hotels.com',
  'agoda':       'Agoda',
  'airbnb':      'Airbnb',
  'priceline':   'Priceline',
  'orbitz':      'Orbitz',
  'travelocity': 'Travelocity',
  'kayak':       'Kayak',
  'trivago':     'Trivago'
};

function detectOtaExtranetWrapper(text) {
  if (!text) return null;
  const otaMatch = text.match(OTA_PREFIX_RE);
  const hasMarker = OTA_MARKER_RE.test(text);
  if (!otaMatch && !hasMarker) return null;
  const rawOta = otaMatch ? otaMatch[1].toLowerCase() : 'ota';
  const ota = OTA_DISPLAY_NAMES[rawOta] || 'OTA';
  const snippet = text.replace(/\s+/g, ' ').trim().substring(0, 240);
  return { ota, snippet };
}

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
    // Per-conversation duplicate-reply guard. Whistle does NOT auto-mark a
    // conversation as read after the bot sends a reply via the contenteditable
    // — the sidebar's "Unread" badge stays on for the same row through the
    // next polling cycle. Without this guard, every cycle re-fires the same
    // engine call against the same chat (now including our own reply) and the
    // bot would reply repeatedly to one guest message. Map of url → wall-clock
    // ms of the last successful send; skip the cycle if the parsed latest
    // chat-content timestamp is older than that.
    this._lastReplyAtByUrl = new Map();
    // Per-URL flag: have we already logged the "already replied; skipping"
    // notice for the most-recent reply on this conversation? If yes,
    // subsequent skips on the same reply go to debug only — without this
    // we'd flood the log with one identical line every ~13s as long as
    // the same stuck thread is being re-detected. Reset to false in
    // _lastReplyAtByUrl.set(...) so the FIRST skip after each new reply
    // is still visible at INFO.
    this._skipLoggedForReplyAt = new Map();
    // Circuit breaker: once true, the listener stops clicking unread rows.
    // Clicking marks the conversation as read in Whistle, so if we can't
    // actually compose+send a reply we silently consume the unread state
    // and the guest never hears back. Tripped after the first compose
    // failure and only reset by restarting the process — by design, so a
    // human investigates before we touch more guest threads.
    this._composeBlocked = false;
  }

  // Server-side alert publisher. Used for fail-paths where we don't want
  // to depend on the model remembering to call alertFrontDesk after a
  // friendly reply (which it sometimes silently skips). Safe-guarded so
  // a misconfigured agent reference never throws.
  _alert(urgency, issueDescription) {
    try {
      const hub = this.agent && this.agent.engine && this.agent.engine.alertHub;
      if (!hub || typeof hub.publish !== 'function') return;
      hub.publish({ urgency, issueDescription });
    } catch (e) {
      logger.warn(`[WHISTLE RPA] Could not publish alert: ${e.message}`);
    }
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info(`[WHISTLE RPA] Starting headless browser to monitor Whistle Inbox at ${this.whistleUrl}...`);

    try {
      const userDataDir = path.join(__dirname, '..', '.cloudbeds_session');

      // Targeted PowerShell kill: scrubs only chrome.exe processes whose
      // command line references THIS user-data-dir, so the operator's
      // Chrome and PaymentTerminal's profile are untouched.
      const { killChromesUsingDir, logChromeLandscape } = require('./chromeCleanup');
      logChromeLandscape('[WHISTLE RPA]');
      killChromesUsingDir(path.basename(userDataDir));
      try { fs.rmSync(path.join(userDataDir, 'SingletonLock'), { force: true }); } catch (e) { logger.warn(`[WHISTLE RPA] Could not remove SingletonLock: ${e.message}`); }
      try { fs.rmSync(path.join(userDataDir, 'SingletonCookie'), { force: true }); } catch (e) { logger.warn(`[WHISTLE RPA] Could not remove SingletonCookie: ${e.message}`); }
      try { fs.rmSync(path.join(userDataDir, 'lockfile'), { force: true }); } catch (e) { logger.warn(`[WHISTLE RPA] Could not remove lockfile: ${e.message}`); }

      // Chrome occasionally exits with code 0 on the first attempt
      // ("Opening in existing browser session") even after the targeted
      // kill, surfacing as Playwright's "Browser window not found". Retry
      // with re-kill between attempts. If all headed launches fail (e.g.
      // the Windows session can't materialize a window), fall back once
      // to true headless.
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
      let lastErr;
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          this.context = await chromium.launchPersistentContext(userDataDir, launchOpts);
          break;
        } catch (e) {
          lastErr = e;
          logger.warn(`[WHISTLE RPA] Launch attempt ${attempt}/4 failed: ${e.message.substring(0, 120)}`);
          if (attempt < 4) {
            killChromesUsingDir(path.basename(userDataDir));
            await new Promise(r => setTimeout(r, attempt * 1500));
          }
        }
      }
      if (!this.context) {
        logger.warn(`[WHISTLE RPA] All headed launches failed; falling back to true headless.`);
        killChromesUsingDir(path.basename(userDataDir));
        try { fs.rmSync(path.join(userDataDir, 'SingletonLock'), { force: true }); } catch (e) { logger.warn(`[WHISTLE RPA] Could not remove SingletonLock: ${e.message}`); }
        try { fs.rmSync(path.join(userDataDir, 'SingletonCookie'), { force: true }); } catch (e) { logger.warn(`[WHISTLE RPA] Could not remove SingletonCookie: ${e.message}`); }
        try { fs.rmSync(path.join(userDataDir, 'lockfile'), { force: true }); } catch (e) { logger.warn(`[WHISTLE RPA] Could not remove lockfile: ${e.message}`); }
        try {
          this.context = await chromium.launchPersistentContext(userDataDir, { ...launchOpts, headless: true });
          logger.info(`[WHISTLE RPA] Headless fallback succeeded.`);
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

      this.page = await this.context.newPage();
      // domcontentloaded, not networkidle: Cloudbeds keeps long-poll
      // connections open so 'networkidle' never fires.
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
        const wasLoggedOut = this._loggedOut;
        this._loggedOut = true;
        // Rate-limit to once every 5 minutes — without this, the warning
        // (which includes the full OAuth URL) fires on every poll and
        // dominates the log file.
        const now = Date.now();
        if (now - this._lastLoginWarnAt > 5 * 60 * 1000) {
          this._lastLoginWarnAt = now;
          logger.warn(`[WHISTLE RPA] Cloudbeds session expired — browser is on the OAuth login page. Log in manually in the visible Chrome window; cookies will persist in .cloudbeds_session/ for next time. URL: ${currentUrl.substring(0, 120)}`);
        }
        // Fire ONE alert on the transition into the logged-out state.
        // Subsequent polls won't re-alert (alertHub coalesces the same
        // message anyway, but skipping the call avoids log spam).
        if (!wasLoggedOut) {
          this._alert('high', 'Whistle RPA is at the Cloudbeds OAuth login page — guest messages are being read but no replies are going out. Log in manually in the visible Chrome window to restore.');
        }
        return;
    }
    if (this._loggedOut) {
      logger.info('[WHISTLE RPA] Login restored — resuming normal polling cadence.');
      this._loggedOut = false;
    }

    if (!this._hasDumpedDom) {
      this._hasDumpedDom = true;
      const fs = require('fs');
      let i = 0;
      for (const frame of this.page.frames()) {
        try {
          fs.writeFileSync(`cloudbeds_whistle_dump_frame_${i}.html`, await frame.content());
          i++;
        } catch (e) {
          logger.warn(`Could not dump frame ${i}: ${e.message}`);
        }
      }
      logger.info(`[WHISTLE RPA] Dumped ${i} frames to cloudbeds_whistle_dump_frame_*.html for analysis.`);
    }

    // Whistle's inbox sidebar is a Chakra accordion; the "Guest" row is a
    // <button class="chakra-accordion__button"> whose aria-expanded
    // attribute reflects whether its conversation list is open. If we
    // land on the inbox with Guest collapsed, the conversation list is
    // hidden and Unread badges aren't reachable downstream, so expand it.
    //
    // Previously we gated this on "Select a conversation" AND a visible
    // "Housekeeping" header, but those signals weren't reliable across
    // every transient state Whistle leaves the inbox in. The accordion's
    // own aria-expanded is the source of truth.
    const debugRpa = process.env.WHISTLE_RPA_DEBUG === 'true';
    const guestAccordion = this.page
        .locator('button.chakra-accordion__button', { hasText: /^Guest$/ })
        .first();

    const guestExpanded = await guestAccordion
        .getAttribute('aria-expanded')
        .catch(() => null);

    if (guestExpanded === 'false') {
        if (debugRpa) {
            logger.info('[WHISTLE RPA] Guest accordion is collapsed; clicking to expand.');
        }
        await guestAccordion.click().catch(() => {});
        // Wait for the expand state to flip; bail after 3s if it doesn't
        // so we don't block the polling cycle on a stuck DOM.
        await this.page
            .waitForFunction(
                () => {
                    const btns = document.querySelectorAll('button.chakra-accordion__button');
                    for (const b of btns) {
                        if (b.textContent && b.textContent.trim() === 'Guest') {
                            return b.getAttribute('aria-expanded') === 'true';
                        }
                    }
                    return false;
                },
                null,
                { timeout: 3000 }
            )
            .catch(() => {});
    } else if (guestExpanded === null) {
        // Accordion not found — could mean the inbox hasn't hydrated yet,
        // or Whistle restructured the sidebar. Fall back to the legacy
        // numeric-badge channel-row click so we still have a way to load
        // conversations on layouts that don't use chakra-accordion.
        const channelCountBadge = this.page.locator('span.chakra-badge:visible')
            .filter({ hasText: /^\s*\d+\s*$/ })
            .first();
        if (await channelCountBadge.isVisible().catch(() => false)) {
            const channelRow = channelCountBadge.locator(
                'xpath=ancestor::*[self::a or self::button or @role="button" or @onclick or @tabindex][1]'
            );
            if ((await channelRow.count()) > 0) {
                if (debugRpa) {
                    logger.info('[WHISTLE RPA] Guest accordion not found; falling back to numeric-badge channel pick.');
                }
                await channelRow.first().click().catch(() => {});
                await this.page.waitForTimeout(2500);
            }
        }
    }

    // getByText('Unread', exact:true) is structure-agnostic; class-based
    // selectors didn't match because the badge text is rendered via CSS.
    let targetContext = null;
    let unreadIndicator = null;

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

    // SAFETY: opening a conversation marks it as read in Whistle. If a
    // prior cycle already failed to find the compose box, refuse to click
    // any more unread rows — otherwise we silently consume guest unread
    // state without ever replying. Reset by restarting the process; by
    // design, so a human investigates first.
    if (this._composeBlocked) {
        logger.warn(`[WHISTLE RPA] Skipping unread row click — compose box has not been located on this build, and clicking would mark the conversation read without sending a reply. Fix the compose selector and restart.`);
        return;
    }

    if (debugRpa) {
        logger.info(`[WHISTLE RPA] Unread message detected! Extracting...`);
    }

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
    //
    // Whistle's compose is a Slate/ProseMirror-style contenteditable div
    // with role="textbox" — NOT a native input or textarea. There's no
    // placeholder attribute (the "Type your message…" hint is rendered
    // via CSS), which is why every previous getByPlaceholder attempt
    // failed silently. The diagnostic dump confirmed exactly one such
    // element exists on the page.
    const composeInput = targetContext.locator('div[contenteditable="true"][role="textbox"]').first();
    try {
        await composeInput.waitFor({ state: 'visible', timeout: 8000 });
    } catch (e) {
        logger.warn(`[WHISTLE RPA] Compose box did not appear within 8s after opening conversation; skipping cycle. URL: ${this.page.url()}`);
        // Trip the circuit breaker so further cycles don't keep clicking
        // and silently marking unreads as read.
        const wasBlocked = this._composeBlocked;
        this._composeBlocked = true;
        if (!wasBlocked) {
          this._alert('critical', 'Whistle compose box did not appear after opening a conversation. The reply path is blocked — guest messages are being read but no responses can be sent. Restart the engine after confirming the Cloudbeds Whistle UI is healthy.');
        }
        // Dump everything that could help locate the compose box: all
        // input/textarea/contenteditable/role=textbox elements with their
        // placeholders + body innerText length and the section past the
        // sidebar (which we've been missing in the 600-char sample).
        await this._dumpComposeFailure(targetContext);
        await this.page.waitForTimeout(2000);
        return;
    }

    // The compose box renders BEFORE Whistle finishes hydrating the chat
    // bubbles — the right pane sits as Chakra skeleton placeholders for
    // up to ~1.5s. Scraping in that window dispatches blank-panel garbage
    // to the engine AND consumes the unread badge (because the click
    // already fired). Real message bubbles always render a HH:MM AM/PM
    // timestamp; skeletons never do, so we poll the chat-panel ancestor
    // until at least one timestamp-shaped token appears. Continues anyway
    // on timeout so a chat that genuinely has no timestamp (extremely
    // rare) still gets a chance.
    try {
        await targetContext.waitForFunction(() => {
            const compose = document.querySelector('div[contenteditable="true"][role="textbox"]');
            if (!compose) return false;
            let el = compose.parentElement;
            while (el && el !== document.body) {
                const text = (el.innerText || '').trim();
                if (text.length > 100 && /\d{1,2}:\d{2}\s*(AM|PM)/i.test(text)) {
                    return true;
                }
                el = el.parentElement;
            }
            return false;
        }, { timeout: 4000, polling: 250 });
    } catch (e) {
        logger.warn(`[WHISTLE RPA] Chat panel did not show a parseable timestamp within 4s after compose appeared; scrape may catch a skeleton. URL: ${this.page.url()}`);
    }

    // Scrape the chat content. Two-pronged approach:
    //   1) Walk up from the compose input through ancestors and pick the
    //      smallest non-trivial one (between 100 and 4000 chars). The chat
    //      panel typically has a fraction of the body's text — the whole
    //      body includes the sidebar list, while the chat-only ancestor
    //      doesn't.
    //   2) Fall back to body.innerText sliced 1500 chars before "Type your
    //      message…" if the ancestor walk doesn't yield anything sensible.
    let textToProcess = '';
    try {
        textToProcess = await composeInput.evaluate((input) => {
            let el = input.parentElement;
            const candidates = [];
            while (el && el !== document.body) {
                const text = (el.innerText || '').trim();
                if (text.length > 100 && text.length < 4000) {
                    candidates.push({ len: text.length, text });
                }
                el = el.parentElement;
            }
            if (!candidates.length) return '';
            // Pick the largest ancestor that's still smaller than 4000 chars
            // — that's the chat panel including header + bubbles, but not
            // the whole-page innerText that includes the sidebar list.
            candidates.sort((a, b) => b.len - a.len);
            return candidates[0].text;
        }).catch(() => '');
    } catch (e) { /* fall through to body slice */ }

    if (!textToProcess) {
        const bodyText = await targetContext.locator('body').innerText().catch(() => '');
        if (bodyText) {
            const composeMarker = bodyText.search(/type your message|type a message/i);
            if (composeMarker > 0) {
                const start = Math.max(0, composeMarker - 1500);
                textToProcess = bodyText.substring(start, composeMarker).trim();
            }
        }
    }

    if (!textToProcess) {
       logger.warn(`[WHISTLE RPA] Could not extract text from the chat area.`);
       return;
    }

    // Quality check: when the scrape grabs the sidebar conversation list
    // instead of the actual chat, it's full of "Replied"/"Read"/"Error"/
    // "Unread" status tokens (one per sidebar row). The real chat content
    // never has more than 1-2 of those. If we see 5+ status pills AND
    // can't parse a recent timestamp, the scrape is bad — bail rather
    // than dispatch garbage to the engine and reply with nonsense.
    const statusPillCount = (textToProcess.match(/\b(Replied|Read|Error|Unread)\b/g) || []).length;

    // Recency guard: don't auto-reply to a thread whose latest activity is
    // older than RECENCY_CUTOFF. Protects against an outage backlog (e.g.
    // server was offline for 4 hours; the agent should NOT wake up and
    // mass-reply to every guest who messaged during the downtime).
    const cutoffMs = Number(process.env.WHISTLE_RECENCY_CUTOFF_MS) || 60 * 60 * 1000;
    const latestActivityAt = this._extractLatestTimestamp(textToProcess);

    if (statusPillCount >= 5 && !latestActivityAt) {
        logger.warn(`[WHISTLE RPA] Scrape looks like the sidebar conversation list (${statusPillCount} status pills, no parseable timestamp); skipping rather than dispatching garbage. URL: ${this.page.url()}`);
        return;
    }

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

    // Duplicate-reply guard. Whistle's sidebar keeps showing "Unread" for
    // the same row even after we send a reply, so the next cycle would
    // re-detect, re-scrape (now with our own reply included), and dispatch
    // the engine again. Skip if the latest chat-content timestamp is older
    // than wall clock at the moment we last sent a reply on this URL.
    const convUrl = this.page.url();
    const lastReplyAt = this._lastReplyAtByUrl.get(convUrl);
    if (lastReplyAt && latestActivityAt && latestActivityAt < lastReplyAt) {
        const ageSec = Math.round((Date.now() - lastReplyAt) / 1000);
        // Only log this at INFO once per reply — subsequent re-detects
        // of the same already-handled conversation go to debug. Without
        // this the log fills with ~80 identical lines for any thread
        // that lingers between the bot's reply and Whistle's read-state
        // catching up.
        const alreadyLogged = this._skipLoggedForReplyAt.get(convUrl) === lastReplyAt;
        if (!alreadyLogged) {
            logger.info(`[WHISTLE RPA] Already replied to this conversation ${ageSec}s ago and no newer guest activity since; skipping to avoid duplicate replies. (Further skips on this reply suppressed.)`);
            this._skipLoggedForReplyAt.set(convUrl, lastReplyAt);
        } else if (debugRpa) {
            logger.info(`[WHISTLE RPA] Already replied ${ageSec}s ago; still skipping.`);
        }
        await this.page.waitForTimeout(2000);
        return;
    }

    // Last-mile guard against OTA-extranet wrappers (Booking.com / Expedia
    // / etc). These are guest messages forwarded into Whistle that
    // explicitly say replies sent through any other channel will not be
    // recorded. The model has no reliable way to detect this from inside
    // the scrape, and replying via Whistle is worse than not replying —
    // it implies to the operator that the guest was answered when they
    // weren't. Detect, alert staff to respond on the extranet, and skip
    // this cycle so we don't compose anything misleading.
    const otaWrap = detectOtaExtranetWrapper(textToProcess);
    if (otaWrap) {
      logger.warn(`[WHISTLE RPA] Detected ${otaWrap.ota} extranet wrapper — skipping engine reply, alerting staff to respond on the extranet.`);
      this._alert('high', `${otaWrap.ota} extranet message — staff must respond via the extranet (any reply sent through Whistle will not be delivered to the guest). Snippet: "${otaWrap.snippet}"`);
      // Stamp the conversation as "replied" so the next polling cycle's
      // duplicate-reply guard skips it instead of looping back here on
      // the same unread thread.
      this._lastReplyAtByUrl.set(convUrl, Date.now());
      await this.page.waitForTimeout(2000);
      return;
    }

    logger.info(`[WHISTLE RPA] Sending extracted chat to Autonomy Engine...`);

    const agentPrompt = `
You are reading a raw scrape of an SMS chat window.
Identify the guest's latest message and generate a helpful, concise SMS response.
Do not include any formatting or markdown in your response, just the raw text you want to send.

Raw Chat UI Text:
${textToProcess}
    `;

    let aiResponseText = "";
    try {
        // processIncomingMessage expects an object with source and text, and optionally uses tools.
        // We bypass the JSON payload constraint by sending it as raw text and instructing the engine to just reply.
        const engineResult = await this.agent.processIncomingMessage({
            source: 'whistle_rpa',
            text: agentPrompt
        });

        // processIncomingMessage returns { agent_response: <string> }.
        // Pull that field — never JSON.stringify the envelope (we'd send
        // the literal {"agent_response":"..."} text to the guest).
        if (typeof engineResult === 'string') {
            aiResponseText = engineResult;
        } else if (engineResult && typeof engineResult.agent_response === 'string') {
            aiResponseText = engineResult.agent_response;
        } else {
            // Unexpected shape — most commonly { success: true,
            // agent_response: undefined } when the engine ran a tool but
            // produced no follow-up text. Don't coerce: String({...}) yields
            // the literal "[object Object]" which we'd then SMS to the guest.
            // Set empty and let the empty-response guard below skip the send.
            aiResponseText = '';
        }

        // Sanitize the response (remove backticks/thought blocks if Gemini leaks them).
        aiResponseText = aiResponseText.replace(/`/g, '').trim();

    } catch(err) {
        logger.error(`[WHISTLE RPA] Autonomy Engine failed to generate response: ${err.message}`);
        // Do NOT send a canned "experiencing issues" reply to the guest.
        // The conversation is already marked read (the click did that),
        // so a human will see it next time they open the inbox. A real
        // apology message confuses guests and looks worse than silence.
        aiResponseText = '';
    }

    if (!aiResponseText || aiResponseText.length < 2) {
        logger.warn(`[WHISTLE RPA] Engine returned empty/unusable response; skipping fill+send. The thread is marked read; a human should follow up.`);
        await this.page.waitForTimeout(2000);
        // Nav back to inbox root so the next poll starts fresh. Without
        // it the page stays on this dead conversation, the Unread-row
        // re-click gets short-circuited by the SPA router, and every
        // subsequent cycle keeps scraping stale content.
        try {
            await this.page.goto(this.whistleUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await this.page.waitForTimeout(1500);
        } catch (e) {
            logger.warn(`[WHISTLE RPA] Post-empty nav back to inbox root failed: ${e.message.substring(0, 120)}`);
        }
        return;
    }

    logger.info(`[WHISTLE RPA] Injecting AI response into UI...`);

    // Reuse the composeInput we already located and waited on — guarantees
    // we type into the right pane's textbox, not some other text field
    // elsewhere on the page.
    if (await composeInput.isVisible().catch(() => false)) {
        // Whistle's compose is a Slate/ProseMirror contenteditable, not a
        // native input. .fill() doesn't always trigger the editor's input
        // events; click-to-focus + pressSequentially mimics real typing
        // and reliably populates rich-text editors.
        await composeInput.click();
        try {
            await composeInput.fill(aiResponseText);
        } catch (e) {
            // .fill() can refuse to act on contenteditable in some
            // Playwright/Chromium combos. Type the text instead.
            await composeInput.pressSequentially(aiResponseText, { delay: 5 });
        }

        // Send button is labeled "Send" (icon + text) in the bottom-right.
        const sendBtn = targetContext.getByRole('button', { name: /^\s*send\s*$/i }).first();
        if (await sendBtn.isVisible().catch(() => false)) {
            await sendBtn.click();
            this._lastReplyAtByUrl.set(convUrl, Date.now());
            logger.info(`[WHISTLE RPA] Successfully sent response!`);
        } else {
            await composeInput.press('Enter');
            this._lastReplyAtByUrl.set(convUrl, Date.now());
            logger.info(`[WHISTLE RPA] Successfully sent response via Enter key!`);
        }
    } else {
        logger.warn(`[WHISTLE RPA] Could not find the input text area to type the response.`);
    }

    await this.page.waitForTimeout(5000);

    // Navigate back to the inbox root so the next poll cycle re-fetches
    // fresh chat content. Without this, the page stays on the conversation
    // URL we just replied to. When a guest follows up, the sidebar gets
    // a new "Unread" badge and the bot clicks it — but Whistle's React
    // router short-circuits because the URL is already that conversation,
    // so the right pane doesn't re-mount and we keep scraping the SAME
    // pre-reply chat content. The recency dedup then correctly identifies
    // "no newer guest activity since our reply" and the bot ignores the
    // follow-up forever. Forcing the URL back to the inbox root makes
    // the next conversation click a real route change → fresh fetch.
    try {
        await this.page.goto(this.whistleUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this.page.waitForTimeout(1500);
    } catch (e) {
        logger.warn(`[WHISTLE RPA] Post-reply nav back to inbox root failed: ${e.message.substring(0, 120)}`);
    }
  }

  /**
   * Dump every signal that could help identify the compose box. Called
   * once when the placeholder-based locator fails to find a textbox after
   * opening a conversation. Reports:
   *   - all <input>, <textarea>, [contenteditable], and [role="textbox"]
   *     elements with their placeholder, aria-label, name, and tag
   *   - body innerText length + a sample from the middle of the document
   *     (the existing 600-char head sample only shows the sidebar list)
   *   - all <button> elements containing "send" in their text or
   *     aria-label, so we can verify the Send button selector too
   */
  async _dumpComposeFailure(frame) {
    try {
        const findings = await frame.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll(
                'input, textarea, [contenteditable="true"], [role="textbox"]'
            )).map(el => ({
                tag: el.tagName.toLowerCase(),
                type: el.getAttribute('type') || null,
                placeholder: el.getAttribute('placeholder') || null,
                ariaLabel: el.getAttribute('aria-label') || null,
                name: el.getAttribute('name') || null,
                role: el.getAttribute('role') || null,
                contentEditable: el.getAttribute('contenteditable') || null,
                cls: String(el.className || '').substring(0, 60),
                visible: !!(el.offsetParent || el.tagName === 'BODY'),
            }));
            const sendButtons = Array.from(document.querySelectorAll('button'))
                .filter(b => /send/i.test((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')))
                .slice(0, 8)
                .map(b => ({
                    text: (b.textContent || '').trim().substring(0, 30),
                    ariaLabel: b.getAttribute('aria-label') || null,
                    cls: String(b.className || '').substring(0, 60),
                    visible: !!b.offsetParent,
                }));
            const innerText = (document.body && document.body.innerText) || '';
            return {
                inputs,
                sendButtons,
                bodyInnerTextLength: innerText.length,
                bodyMidSample: innerText.substring(1500, 2500),
                bodyTailSample: innerText.substring(Math.max(0, innerText.length - 600)),
            };
        });
        logger.warn(`[WHISTLE RPA DEBUG] composeFailure inputs=${JSON.stringify(findings.inputs).substring(0, 1200)}`);
        logger.warn(`[WHISTLE RPA DEBUG] composeFailure sendButtons=${JSON.stringify(findings.sendButtons).substring(0, 600)}`);
        logger.warn(`[WHISTLE RPA DEBUG] composeFailure bodyLen=${findings.bodyInnerTextLength} mid=${JSON.stringify(findings.bodyMidSample).substring(0, 600)}`);
        logger.warn(`[WHISTLE RPA DEBUG] composeFailure tail=${JSON.stringify(findings.bodyTailSample).substring(0, 600)}`);
    } catch (e) {
        logger.error(`[WHISTLE RPA DEBUG] composeFailure dump itself failed: ${e.message}`);
    }
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
    const now = new Date();
    const currentYear = now.getFullYear();
    const todayPrefix = now.toDateString(); // e.g. "Tue Apr 28 2026"
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
            // V8's Date.parse defaults missing years to 2001 (e.g. "Apr 28
            // 8:21 PM" -> Apr 28, 2001). That made every chat timestamp
            // look ~25 years old and the recency guard tripped on every
            // poll. If the parsed year is more than 1 year from now,
            // normalize to the current year — but if that pushes the
            // result more than a day into the future (e.g., a Dec date
            // parsed in early Jan), fall back to last year.
            const dt = new Date(parsed);
            if (Math.abs(dt.getFullYear() - currentYear) > 1) {
                dt.setFullYear(currentYear);
                let adjusted = dt.getTime();
                if (adjusted > now.getTime() + 24 * 60 * 60 * 1000) {
                    dt.setFullYear(currentYear - 1);
                    adjusted = dt.getTime();
                }
                parsed = adjusted;
            }
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
