require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

(async () => {
  console.log("==========================================");
  console.log("  CLOUDBEDS KIOSK - NATIVE CHROME LOGIN  ");
  console.log("==========================================");
  console.log("Since Okta bot protection is highly aggressive, we are launching");
  console.log("a completely standard, native Google Chrome window (no Playwright hooks).");
  console.log("Log into Cloudbeds and complete the 2FA flow normally.");
  console.log("");

  const userDataDir = path.join(__dirname, '..', '.cloudbeds_session');
  const host = process.env.CLOUDBEDS_UI_HOST || 'hotels.cloudbeds.com';

  // Find Chrome installation path (Windows standard paths)
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ];

  let chromeExe = null;
  for (const p of chromePaths) {
    if (fs.existsSync(p)) {
      chromeExe = p;
      break;
    }
  }

  if (!chromeExe) {
    console.error("Could not find Google Chrome installed on this system.");
    console.error("Please ensure standard Google Chrome is installed, or adjust the paths in scripts/setupLogin.js");
    process.exit(1);
  }

  console.log("Launching Native Chrome...");
  const chromeProcess = spawn(chromeExe, [
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    `https://${host}/login`
  ], {
    detached: true,
    stdio: 'ignore'
  });

  chromeProcess.unref();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("\nWhen you have successfully logged in and see your dashboard, close the Chrome window and press ENTER here to finish...\n> ", () => {
    console.log("\nSession natively saved to .cloudbeds_session/");
    console.log("The Autonomy Engine will now use this physical Chrome profile for headless operations.");
    rl.close();
    process.exit(0);
  });
})();
