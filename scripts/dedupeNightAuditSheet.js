/**
 * One-shot dedupe of the NightAuditData Google Sheet.
 *
 * The night audit's read-side fix (`nightAuditReport.getTransactionsFromSheets`)
 * collapses duplicates in memory at report time, but the underlying sheet may
 * still hold the duplicate rows from earlier double-writes. This script reads
 * the entire tab, dedupes by:
 *   1. transactionID (column M, position 12) when present, OR
 *   2. a content composite of the visible columns A-I (the same key the
 *      read-side dedup uses), and rewrites the tab with the deduped rows.
 *
 * Usage:
 *   node scripts/dedupeNightAuditSheet.js [--apply]
 *
 * Without --apply this is a DRY RUN: it prints what would be removed but
 * does not modify the sheet. Pass --apply to actually rewrite it.
 *
 * Requires the same env vars as the main server:
 *   GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY,
 *   GOOGLE_SHEET_TAB_TRANSACTIONS (optional, default: NightAuditData)
 */

require('dotenv').config();

const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1L_y5a7nNvhaEqpt6VWGvtS3RuoBPFcSRAc9fJz3jqdw';
const TAB = process.env.GOOGLE_SHEET_TAB_TRANSACTIONS || 'NightAuditData';

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : null;
  if (!email || !key) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY');
  }
  return new google.auth.GoogleAuth({
    credentials: { client_email: email, private_key: key },
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
}

function dedupKey(row) {
  // Column M (index 12) holds the real transactionID for rows written after
  // the dedup-ID column was added. Older rows have '-' or are missing the column.
  const realId = row[12] && row[12] !== '-' ? row[12] : null;
  if (realId) return realId;
  // Legacy: composite of columns A-I (date, txnDate, amount, type, rvType,
  // description, room, reservation, void). Matches getTransactionsFromSheets.
  return 'legacy|' + [row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8]]
    .map(v => v === undefined ? '' : v).join('|');
}

async function main() {
  const apply = process.argv.includes('--apply');

  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  console.log(`Reading ${TAB} from spreadsheet ${SHEET_ID}...`);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A:Z`
  });
  const rows = res.data.values || [];
  if (rows.length === 0) {
    console.log('Sheet is empty — nothing to do.');
    return;
  }

  // Treat the first row as a header and pass it through unchanged unless it
  // happens to be data (no header row present yet). Heuristic: if column B of
  // row 1 looks like a YYYY-MM-DD date, there's no header.
  const looksLikeData = (r) => /^\d{4}-\d{2}-\d{2}$/.test(r && r[1] || '');
  const header = looksLikeData(rows[0]) ? null : rows[0];
  const dataRows = header ? rows.slice(1) : rows;

  const seen = new Map();
  const dupRows = [];
  for (const r of dataRows) {
    if (!r[1] || r[1] === '-') {
      // NO_TRANSACTIONS_FOUND placeholder rows or blank lines — keep as-is
      // by giving them a unique key so they survive dedup.
      seen.set(`pass-through-${seen.size}`, r);
      continue;
    }
    const key = dedupKey(r);
    if (seen.has(key)) {
      dupRows.push({ key, row: r });
    } else {
      seen.set(key, r);
    }
  }

  console.log(`Total data rows:   ${dataRows.length}`);
  console.log(`Unique rows kept:  ${seen.size}`);
  console.log(`Duplicates found:  ${dupRows.length}`);

  if (dupRows.length === 0) {
    console.log('Nothing to dedupe.');
    return;
  }

  // Show a sample of what would be dropped, grouped by date.
  const dropByDate = new Map();
  for (const d of dupRows) {
    const date = d.row[1] || '(unknown)';
    dropByDate.set(date, (dropByDate.get(date) || 0) + 1);
  }
  console.log('\nDuplicates by transactionDate:');
  for (const [date, count] of [...dropByDate.entries()].sort()) {
    console.log(`  ${date}  ×${count}`);
  }

  if (!apply) {
    console.log('\nDRY RUN — re-run with --apply to rewrite the sheet.');
    return;
  }

  // Rewrite: clear the tab and write back header + deduped rows.
  const finalRows = Array.from(seen.values());
  const writeRows = header ? [header, ...finalRows] : finalRows;

  console.log(`\nClearing range ${TAB}!A:Z...`);
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A:Z`
  });

  console.log(`Writing ${writeRows.length} rows back...`);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A1`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: writeRows }
  });

  console.log(`Done. Removed ${dupRows.length} duplicates.`);
}

main().catch(e => {
  console.error('Failed:', e.message);
  process.exit(1);
});
