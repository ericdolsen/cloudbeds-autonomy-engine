require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

// Two separate Chrome user-data-dirs run side by side:
//
//   .cloudbeds_session          — held open by WhistleListener for the
//                                 lifetime of the server. Used for inbox
//                                 polling / SMS auto-replies.
//
//   .cloudbeds_payment_session  — used briefly by PaymentTerminal each
//                                 time a kiosk charge fires. Separate
//                                 because Chrome enforces single-instance-
//                                 per-profile, so it cannot share with
//                                 WhistleListener.
//
// Both need the operator logged into Cloudbeds. We handle them in sequence:
// open native Chrome on dir #1, wait for Enter, kill it, then dir #2.
const DIRS = [
  { name: '.cloudbeds_session', label: 'Whistle / inbox session' },
  { name: '.cloudbeds_payment_session', label: 'Stripe Terminal payment session' }
];

(async () => {
  console.log("==========================================");
  console.log("  CLOUDBEDS KIOSK - NATIVE CHROME LOGIN  ");
  console.log("==========================================");
  console.log("Since Okta bot protection is highly aggressive, we are launching");
  console.log("a completely standard, native Google Chrome window (no Playwright hooks).");
  console.log("Log into Cloudbeds and complete the 2FA flow normally.");
  console.log("");
  console.log(`This script sets up ${DIRS.length} session directories — one for the`);
  console.log("inbox listener and one for the kiosk payment terminal. You'll log");
  console.log("in once per directory, then the system reuses the cached cookies.");
  console.log("");

  const host = process.env.CLOUDBEDS_UI_HOST || 'us2.cloudbeds.com';

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

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  for (let i = 0; i < DIRS.length; i++) {
    const { name, label } = DIRS[i];
    const userDataDir = path.join(__dirname, '..', name);
    console.log(`\n[${i + 1}/${DIRS.length}] Setting up ${name} (${label})`);

    const skip = await ask(`Skip this directory? Type 's' to skip, otherwise press ENTER to launch Chrome: `);
    if (skip.trim().toLowerCase() === 's') {
      console.log(`Skipped ${name}.`);
      continue;
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

    await ask("\nWhen you've successfully logged in and see your dashboard, close the Chrome window and press ENTER here to continue...\n> ");

    console.log("Cleaning up background Chrome processes...");
    try { process.kill(chromeProcess.pid, 'SIGINT'); } catch (e) {}
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log(`Saved login for ${name}.`);
  }

  console.log("\n==========================================");
  console.log("  All session directories are ready.");
  console.log("==========================================");
  console.log("WhistleListener will use .cloudbeds_session/ on its next start.");
  console.log("PaymentTerminal will use .cloudbeds_payment_session/ on the next kiosk charge.");
  rl.close();
  process.exit(0);
})();
