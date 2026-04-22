require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  console.log("==========================================");
  console.log("  CLOUDBEDS KIOSK - 2FA LOGIN SETUP  ");
  console.log("==========================================");
  console.log("Launching visible browser...");
  console.log("Please log into Cloudbeds and complete any 2FA or email code requirements.");
  console.log("Once you are fully logged in and see the dashboard, simply close the browser window.");
  
  const userDataDir = path.join(__dirname, '..', '.cloudbeds_session');
  
  const context = await chromium.launchPersistentContext(userDataDir, { 
    headless: false,
    viewport: null
  });
  
  const page = await context.newPage();
  
  const host = process.env.CLOUDBEDS_UI_HOST || 'hotels.cloudbeds.com';
  await page.goto(`https://${host}/login`);

  console.log("\nWaiting for you to log in... (Close the browser when finished)");
  
  // Wait for the browser to be closed by the user
  await new Promise(resolve => context.on('close', resolve));
  
  console.log("\nSession saved securely to .cloudbeds_session !");
  console.log("The Autonomy Engine will now use this saved session to bypass 2FA when running in the background.");
  process.exit(0);
})();
