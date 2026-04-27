/**
 * Historical backfill for the NightAuditData Google Sheet.
 *
 * Pulls transactions a month at a time from Cloudbeds, splits each month's
 * results into per-day buckets, and appends them to the sheet. Designed for
 * one-shot historical pulls (e.g. start-of-2025 through yesterday) without
 * tripping rate limits.
 *
 * Key properties:
 *   - Chunks by month (Cloudbeds /transactions paginates internally) so a
 *     16-month pull is ~16 API calls, not 480.
 *   - Pre-fetches reservation profiles in monthly sweeps via /getReservations
 *     so the per-row "checkIn / checkOut / groupName" lookups are batch-served
 *     from cache instead of hammering /getReservation one ID at a time.
 *   - Resumable: appendTransactionsToSheets dedupes against the existing
 *     transactionID column, so re-running after a crash just fills the gap.
 *
 * Usage:
 *   node scripts/backfillHistory.js                                 # 2025-01-01 → yesterday
 *   node scripts/backfillHistory.js --from 2025-01-01 --to 2025-06-30
 *   node scripts/backfillHistory.js 90                              # legacy: last 90 days
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

function parseArgs(argv) {
  // Legacy single-arg form: a bare integer means "last N days".
  if (argv.length === 1 && /^\d+$/.test(argv[0])) {
    const days = parseInt(argv[0], 10);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const from = new Date(today); from.setDate(today.getDate() - days);
    const to = new Date(today); to.setDate(today.getDate() - 1);
    return { from, to };
  }

  let from = null, to = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') from = new Date(argv[++i] + 'T00:00:00');
    else if (argv[i] === '--to') to = new Date(argv[++i] + 'T00:00:00');
  }

  if (!from) from = new Date('2025-01-01T00:00:00');
  if (!to) {
    to = new Date(); to.setHours(0, 0, 0, 0);
    to.setDate(to.getDate() - 1); // default through yesterday
  }
  if (isNaN(from) || isNaN(to) || from > to) {
    console.error('Usage: node scripts/backfillHistory.js [--from YYYY-MM-DD] [--to YYYY-MM-DD]');
    console.error('   or: node scripts/backfillHistory.js <days>');
    process.exit(1);
  }
  return { from, to };
}

function monthChunks(from, to) {
  // Yields [chunkStart, chunkEnd] tuples that tile [from, to] inclusive on
  // calendar-month boundaries. The first/last chunks may be partial months.
  const chunks = [];
  let cursor = new Date(from);
  while (cursor <= to) {
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const chunkStart = new Date(cursor);
    const chunkEnd = monthEnd > to ? new Date(to) : monthEnd;
    chunks.push([chunkStart, chunkEnd]);
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return chunks;
}

async function main() {
  const { from, to } = parseArgs(process.argv.slice(2));
  const api = new CloudbedsAPI();
  const report = new NightAuditReport(api);
  const ymd = d => report.toYMD(d);

  const chunks = monthChunks(from, to);
  logger.info(`[BACKFILL] Window: ${ymd(from)} → ${ymd(to)} (${chunks.length} monthly chunks, tab="${report.transactionsTab}").`);

  const sharedCache = {};
  let totalTxns = 0, totalAppended = 0, errorCount = 0;

  for (let i = 0; i < chunks.length; i++) {
    const [cs, ce] = chunks[i];
    const csYMD = ymd(cs);
    const ceYMD = ymd(ce);
    logger.info(`[BACKFILL] Chunk ${i + 1}/${chunks.length}: ${csYMD} → ${ceYMD}`);

    try {
      // 1. Pre-warm the reservation profile cache for this month with a
      //    single paginated /getReservations sweep. This converts
      //    appendTransactionsToSheets from O(unique reservations) live calls
      //    into O(1) cached lookups for the whole month.
      const resPage = await api.getReservations(csYMD, ceYMD);
      if (resPage.success) {
        for (const r of (resPage.data || [])) {
          if (!r.reservationID || sharedCache[r.reservationID]) continue;
          sharedCache[r.reservationID] = {
            checkIn: r.startDate || '-',
            checkOut: r.endDate || '-',
            groupName: r.companyName || r.allotmentBlockCode || '-'
          };
        }
      }

      // 2. Pull all transactions for the chunk in one API call (the
      //    Cloudbeds endpoint paginates internally).
      const result = await api.getTransactions(csYMD, ceYMD);
      const txns = result.data || [];
      totalTxns += txns.length;
      logger.info(`[BACKFILL] Chunk ${csYMD}..${ceYMD}: ${txns.length} transactions fetched.`);

      // 3. Bucket by transactionDate so each day still gets its own append
      //    (matters for column A bookkeeping and for the "no transactions"
      //    placeholder rows on quiet days).
      const byDay = new Map();
      for (let d = new Date(cs); d <= ce; d.setDate(d.getDate() + 1)) {
        byDay.set(ymd(d), []);
      }
      for (const t of txns) {
        const day = t.transactionDate;
        if (byDay.has(day)) byDay.get(day).push(t);
      }

      // 4. Append day by day. The dedupe inside appendTransactionsToSheets
      //    means re-running this script on an overlapping window is safe.
      for (const [day, dayTxns] of byDay) {
        await report.appendTransactionsToSheets(dayTxns, day, sharedCache);
        totalAppended += dayTxns.length;
        await sleep(200); // gentle pace for Sheets quota (60 req/min default)
      }

    } catch (e) {
      logger.error(`[BACKFILL] Chunk ${csYMD}..${ceYMD}: FAILED — ${e.message}`);
      errorCount++;
    }

    // Cloudbeds sustained rate limit is ~5 req/sec; 750ms between chunks is
    // very conservative and leaves headroom for the per-page sleeps inside
    // getTransactions/getReservations.
    if (i < chunks.length - 1) await sleep(750);
  }

  logger.info(`[BACKFILL] Done. Pulled ${totalTxns} transactions across ${chunks.length} chunks; ${totalAppended} considered for append (duplicates skipped at write time). ${errorCount} chunk error(s).`);
  if (errorCount > 0) {
    logger.warn('[BACKFILL] Some chunks failed. Re-run with the same flags — already-written rows will dedupe automatically.');
    process.exit(1);
  }
}

main().catch(e => {
  logger.error(`[BACKFILL] Fatal: ${e.message}`);
  process.exit(1);
});
