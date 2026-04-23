require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const readline = require('readline');

(async () => {
  console.log("==========================================");
  console.log("  CLOUDBEDS KIOSK - 2FA LOGIN SETUP  ");
  console.log("==========================================");
  console.log("Launching a visible browser window...");
  console.log("Log into Cloudbeds and complete any 2FA / email-code prompts.");
  console.log("");

  const userDataDir = path.join(__dirname, '..', '.cloudbeds_session');
  const host = process.env.CLOUDBEDS_UI_HOST || 'hotels.cloudbeds.com';

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: null
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto(`https://${host}/login`);

  // Three independent exit paths (whichever happens first wins):
  //  1. The browser URL reaches /connect/ (i.e. dashboard — login succeeded).
  //  2. User presses ENTER in the terminal.
  //  3. User closes the browser window entirely (browser 'disconnected').
  // Any of these triggers a clean close → the persistent context flushes
  // cookies to disk, and the script exits.

  let done = false;
  const finish = async (reason) => {
    if (done) return;
    done = true;
    console.log(`\n✓ Detected: ${reason}`);
    console.log("Saving session to .cloudbeds_session/ ...");
    try {
      // Give cookies / localStorage a moment to settle before we close.
      await new Promise(r => setTimeout(r, 1500));
      await context.close();
    } catch (_) { /* context may already be closed */ }
    console.log("Session saved. The Autonomy Engine will use this to bypass 2FA.");
    process.exit(0);
  };

  // Path 1: URL watcher (polls every 1s for a post-login URL)
  const urlPoll = setInterval(async () => {
    try {
      const pages = context.pages();
      for (const p of pages) {
        const url = p.url();
        if (url.includes('/connect/') || url.includes('/dashboard')) {
          clearInterval(urlPoll);
          console.log(`\n✓ Detected logged-in URL: ${url}`);
          console.log("Press ENTER in this terminal to save the session and exit.");
          console.log("(or just close the browser window)");
          return;
        }
      }
    } catch (_) { /* page may have navigated */ }
  }, 1000);

  // Path 2: Wait for ENTER in terminal
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("\nWhen you're finished logging in, press ENTER here (or close the browser window)...\n> ", () => {
    rl.close();
    clearInterval(urlPoll);
    finish('ENTER pressed in terminal');
  });

  // Path 3: Browser closed manually
  const browser = context.browser();
  if (browser) {
    browser.on('disconnected', () => {
      clearInterval(urlPoll);
      rl.close();
      finish('browser window closed');
    });
  }
  context.on('close', () => {
    clearInterval(urlPoll);
    rl.close();
    finish('browser context closed');
  });
})();
