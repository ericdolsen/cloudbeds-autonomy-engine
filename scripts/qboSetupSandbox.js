#!/usr/bin/env node
/**
 * One-time bootstrap for a fresh QBO Sandbox: creates every account
 * + class the integration expects, so postDayToQbo() doesn't throw
 * "QBO chart has no account with AcctNum=4000".
 *
 * Sandbox companies come pre-loaded with a generic chart that doesn't
 * use Gateway Park's account numbers. Production already has the
 * right chart and doesn't need this — only run this against sandbox.
 *
 * Idempotent. Safe to re-run; it queries each account/class first and
 * only creates ones that aren't already there.
 *
 * Prerequisites (set in .env, then `node scripts/qboConnect.js`):
 *   QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REFRESH_TOKEN, QBO_REALM_ID
 *   QBO_ENVIRONMENT=sandbox     (script refuses to run against production)
 *
 * Usage:
 *   node scripts/qboSetupSandbox.js
 *
 * Notes:
 *   - QBO requires "Track classes" be enabled in the sandbox company's
 *     Account and Settings → Advanced → Categories before classes can
 *     be created via the API. If it's not enabled the script will say
 *     so and skip the class step (accounts still get created).
 *   - Accounts Receivable (1200) is created here even though the QBO
 *     sandbox ships with a default A/R — the default has no AcctNum,
 *     so the integration's AcctNum lookup wouldn't find it. Creating
 *     a custom 1200 A/R alongside the default is allowed by QBO.
 */
'use strict';

require('dotenv').config();
const { QuickBooks } = require('../src/quickbooks');
const { ACCT, CLS } = require('../src/qboMapping');

// Account specs — keys are AcctNum, values describe how QBO should
// classify the account. Aligns with Gateway Park's USALI chart per the
// bookkeeper's spec.
const ACCOUNT_SPECS = {
  // Revenue (Income type)
  [ACCT.ROOM_REVENUE]:       { name: 'Room Revenue - Transient',          type: 'Income',                  subType: 'SalesOfProductIncome' },
  [ACCT.NO_SHOW_REVENUE]:    { name: 'No-Show Revenue',                   type: 'Income',                  subType: 'SalesOfProductIncome' },
  [ACCT.CANCEL_FEES]:        { name: 'Cancellation Fees',                 type: 'Income',                  subType: 'SalesOfProductIncome' },
  [ACCT.PET_FEES]:           { name: 'Pet Fees',                          type: 'Income',                  subType: 'SalesOfProductIncome' },
  [ACCT.DAMAGE_FEES]:        { name: 'Damage / Cleaning Fees',            type: 'Income',                  subType: 'SalesOfProductIncome' },
  [ACCT.ALLOWANCES_REFUNDS]: { name: 'Allowances & Adjustments - Rooms',  type: 'Income',                  subType: 'DiscountsRefundsGiven' },
  [ACCT.MISC_REVENUE]:       { name: 'Miscellaneous Revenue',             type: 'Income',                  subType: 'OtherPrimaryIncome' },

  // Tax liability (Other Current Liability)
  [ACCT.SALES_TAX_PAYABLE]:  { name: 'Sales Tax Payable - South Dakota',  type: 'Other Current Liability', subType: 'OtherCurrentLiabilities' },
  [ACCT.TOURISM_TAX]:        { name: 'SD Tourism Tax Payable',            type: 'Other Current Liability', subType: 'OtherCurrentLiabilities' },

  // Payment / clearing (Other Current Asset)
  [ACCT.STRIPE_CLEARING]:    { name: 'Stripe Clearing',                   type: 'Other Current Asset',     subType: 'OtherCurrentAssets' },
  [ACCT.OTA_CLEARING]:       { name: 'OTA Channel-Collect Clearing',      type: 'Other Current Asset',     subType: 'OtherCurrentAssets' },
  [ACCT.CASH_CLEARING]:      { name: 'Cash Clearing',                     type: 'Other Current Asset',     subType: 'OtherCurrentAssets' },

  // Accounts Receivable. QBO ships a default A/R but it has no AcctNum
  // and the integration's lookup is by AcctNum, so we create a custom
  // 1200 A/R that's reachable from the mapping.
  [ACCT.AR]:                 { name: 'Accounts Receivable',               type: 'Accounts Receivable',     subType: 'AccountsReceivable' }
};

// Class specs (just names; QBO assigns IDs).
const CLASS_NAMES = [CLS.ROOMS, CLS.OTHER_OP, CLS.MISC];

(async () => {
  const qbo = new QuickBooks();
  if (!qbo.isConfigured()) {
    console.error('ERROR: QBO env vars not all set. Run scripts/qboConnect.js first.');
    process.exit(1);
  }
  if (qbo.env !== 'sandbox') {
    console.error(`REFUSING to run against environment "${qbo.env}". This script only targets sandbox.`);
    console.error('Production should already have the chart of accounts set up by the bookkeeper.');
    process.exit(1);
  }

  console.log(`\n=== QBO Sandbox Setup — realm ${qbo.realmId} ===\n`);

  // ─── Accounts ───────────────────────────────────────────────────────
  console.log('Loading existing chart of accounts...');
  const existing = await qbo.query("SELECT Id, AcctNum, Name FROM Account WHERE Active = true MAXRESULTS 1000");
  const existingByNum = new Map();
  for (const a of existing.Account || []) {
    if (a.AcctNum) existingByNum.set(String(a.AcctNum), a);
  }
  console.log(`  Found ${existingByNum.size} accounts with AcctNum already in chart.\n`);

  let created = 0, skipped = 0, failed = 0;
  for (const [acctNum, spec] of Object.entries(ACCOUNT_SPECS)) {
    const existing = existingByNum.get(acctNum);
    if (existing) {
      console.log(`  SKIP  ${acctNum}  ${spec.name}   (already exists as Id ${existing.Id} "${existing.Name}")`);
      skipped++;
      continue;
    }
    const payload = {
      Name: spec.name,
      AcctNum: acctNum,
      AccountType: spec.type,
      AccountSubType: spec.subType
    };
    try {
      const data = await qbo._post('/account', payload);
      const id = data.Account && data.Account.Id;
      console.log(`  CREATE  ${acctNum}  ${spec.name}   → Id ${id}`);
      created++;
    } catch (e) {
      console.error(`  FAIL  ${acctNum}  ${spec.name}   → ${e.message}`);
      failed++;
    }
  }
  console.log(`\nAccounts: ${created} created, ${skipped} skipped, ${failed} failed.\n`);

  // ─── Classes ────────────────────────────────────────────────────────
  console.log('Loading existing classes...');
  let existingClasses;
  try {
    existingClasses = await qbo.query('SELECT Id, Name FROM Class WHERE Active = true MAXRESULTS 200');
  } catch (e) {
    console.error(`Could not query classes: ${e.message}`);
    console.error(`If you see "ValidationFault" mentioning class tracking, enable it in QBO:`);
    console.error(`  Settings (gear icon) → Account and Settings → Advanced → Categories → Track classes (ON).`);
    console.error(`Then re-run this script.\n`);
    process.exit(failed > 0 ? 1 : 0);
  }
  const existingClassByName = new Map();
  for (const c of existingClasses.Class || []) {
    if (c.Name) existingClassByName.set(c.Name.toLowerCase(), c);
  }
  console.log(`  Found ${existingClassByName.size} classes already in QBO.\n`);

  let cCreated = 0, cSkipped = 0, cFailed = 0;
  for (const name of CLASS_NAMES) {
    const exists = existingClassByName.get(name.toLowerCase());
    if (exists) {
      console.log(`  SKIP  Class "${name}"   (Id ${exists.Id})`);
      cSkipped++;
      continue;
    }
    try {
      const data = await qbo._post('/class', { Name: name });
      const id = data.Class && data.Class.Id;
      console.log(`  CREATE  Class "${name}"   → Id ${id}`);
      cCreated++;
    } catch (e) {
      console.error(`  FAIL  Class "${name}"   → ${e.message}`);
      console.error(`         (If this says class tracking isn't enabled, turn it on in QBO settings and re-run.)`);
      cFailed++;
    }
  }
  console.log(`\nClasses: ${cCreated} created, ${cSkipped} skipped, ${cFailed} failed.\n`);

  if (failed > 0 || cFailed > 0) {
    console.error('One or more steps failed — fix the errors above and re-run. The script is idempotent so the successful steps won\'t duplicate.');
    process.exit(1);
  }
  console.log('Done. Sandbox chart is now aligned with the integration mapping.');
  console.log('Restart the engine and try "Post Day to QuickBooks" again.\n');
})().catch(e => {
  console.error(`\nFATAL: ${e.message}`);
  process.exit(1);
});
