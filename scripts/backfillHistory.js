/**
 * One-time historical backfill for the NightAuditData Google Sheet.
 *
 * Pulls transactions day-by-day from Cloudbeds and appends each day's rows
 * to the sheet, building the historical database the nightly report depends on.
 *
 * Usage:
 *   node scripts/backfillHistory.js [days]
 *
 * Examples:
 *   node scripts/backfillHistory.js 30    # last 30 days (default)
 *   node scripts/backfillHistory.js 90    # last 90 days
 *
 * Requires the same env vars as the main server:
 *   CLOUDBEDS_API_KEY, CLOUDBEDS_PROPERTY_ID,
 *   GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY,
 *   GOOGLE_SHEET_TAB_TRANSACTIONS (optional, default: NightAuditData)
 */

require('dotenv').config();

const { CloudbedsAPI } = require('../src/cloudbedsApi');
const { NightAuditReport } = require('../src/nightAuditReport');
const { logger } = require('../src/logger');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const days = parseInt(process.argv[2] || '30', 10);
  if (isNaN(days) || days < 1) {
    console.error('Usage: node scripts/backfillHistory.js [days]');
    process.exit(1);
  }

  const api = new CloudbedsAPI();
  const report = new NightAuditReport(api);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  logger.info(`[BACKFILL] Starting ${days}-day backfill into tab "${report.transactionsTab}"...`);

  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  for (let i = days; i >= 1; i--) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    const dateStr = report.toYMD(date);

    try {
      logger.info(`[BACKFILL] Fetching ${dateStr} (${days - i + 1}/${days})...`);
      const result = await api.getTransactions(dateStr, dateStr);
      const txns = result.data || [];

      if (txns.length === 0) {
        logger.info(`[BACKFILL] ${dateStr}: no transactions found — writing placeholder row.`);
      } else {
        logger.info(`[BACKFILL] ${dateStr}: ${txns.length} transactions fetched.`);
      }

      await report.appendTransactionsToSheets(txns, dateStr);
      successCount++;
    } catch (e) {
      logger.error(`[BACKFILL] ${dateStr}: FAILED — ${e.message}`);
      errorCount++;
    }

    // Respect Cloudbeds rate limits (~1 req/sec sustained is safe)
    if (i > 1) await sleep(600);
  }

  logger.info(`[BACKFILL] Done. ${successCount} days written, ${errorCount} errors, ${skipCount} skipped.`);
  if (errorCount > 0) {
    logger.warn('[BACKFILL] Some days failed. Re-run with a smaller range or check credentials.');
    process.exit(1);
  }
}

main().catch(e => {
  logger.error(`[BACKFILL] Fatal: ${e.message}`);
  process.exit(1);
});
