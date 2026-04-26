const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { logger } = require('./logger');

class WhistleListener {
  constructor(autonomyAgent) {
    this.agent = autonomyAgent;
    this.host = process.env.CLOUDBEDS_UI_HOST || 'hotels.cloudbeds.com';
    this.whistleUrl = process.env.CLOUDBEDS_WHISTLE_URL || `https://${this.host}/guest_experience/inbox`;
    this.isRunning = false;
    this.context = null;
    this.page = null;
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info(`[WHISTLE RPA] Starting headless browser to monitor Whistle Inbox at ${this.whistleUrl}...`);

    try {
      const userDataDir = path.join(__dirname, '..', '.cloudbeds_session');
      
      // Clean up stale locks that cause Chrome to exit with code 0
      try { fs.rmSync(path.join(userDataDir, 'SingletonLock'), { force: true }); } catch (e) {}
      try { fs.rmSync(path.join(userDataDir, 'SingletonCookie'), { force: true }); } catch (e) {}
      
      this.context = await chromium.launchPersistentContext(userDataDir, { 
          executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          channel: 'chrome',
          headless: false, // Run headlessly? User might want to see it, or keep it hidden. Set to false for "-32000" position trick
          args: [
              '--disable-blink-features=AutomationControlled',
              '--window-position=-32000,-32000',
              '--window-size=1920,1080',
              '--disable-gpu',
              '--disable-software-rasterizer'
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
      await this.page.goto(this.whistleUrl, { waitUntil: 'networkidle' });
      
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
      // Wait 10 seconds before next poll
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }

  async _pollForMessages() {
    if (!this.page) return;

    // Use flexible semantic locators to find unread messages
    const unreadIndicator = this.page.locator('[aria-label*="unread" i], .unread, [class*="unread" i]').first();
    
    const isUnread = await unreadIndicator.isVisible().catch(() => false);
    if (!isUnread) {
        return; // No new messages
    }

    logger.info(`[WHISTLE RPA] Unread message detected! Extracting...`);
    
    // Click the unread thread
    await unreadIndicator.click();
    await this.page.waitForTimeout(2000); // Wait for chat to load

    const chatRegion = this.page.getByRole('region', { name: /chat|messages|conversation/i }).first();
    let textToProcess = '';
    
    if (await chatRegion.isVisible()) {
        textToProcess = await chatRegion.innerText();
    } else {
        textToProcess = await this.page.locator('main, [role="main"], .chat-container, .messages-list').first().innerText();
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
    
    const inputArea = this.page.getByPlaceholder(/type a message|reply|message/i).first();
    if (await inputArea.isVisible()) {
        await inputArea.fill(aiResponseText);
        
        const sendBtn = this.page.getByRole('button', { name: /send/i }).first();
        if (await sendBtn.isVisible()) {
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
