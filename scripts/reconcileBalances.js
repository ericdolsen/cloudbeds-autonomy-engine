/**
 * Tax balance reconciliation bot.
 *
 * Reads the workbook of legacy imported reservations with non-zero balances
 * and posts a single State Tax adjustment per reservation that zeroes the
 * balance. Sign convention from postAdjustment: positive amount discounts
 * the line (handles balance > 0), negative amount adds a charge (handles
 * balance < 0). One call per row, regardless of sign.
 *
 * Safety:
 *   - Dry-run by default; pass --apply to actually post.
 *   - Per-reservation cap (default $5); rows above it are skipped + logged.
 *   - Idempotent: every adjustment carries a stable description tag, and
 *     the script reads the audit CSV at startup to skip any reservation it
 *     already processed in a prior run.
 *   - Audit CSV records every action (incl. skips and errors) for replay.
 *
 * Usage:
 *   node scripts/reconcileBalances.js                                       # dry-run, default xlsx
 *   node scripts/reconcileBalances.js --apply --concurrency 4
 *   node scripts/reconcileBalances.js --input data/Balances.xlsx --cap 2.50
 *   node scripts/reconcileBalances.js --apply --limit 5                     # try just 5 rows
 *
 * Once we know the State Tax line target shape (from probeTaxLine.js),
 * fill it into TAX_LINE_EXTRAS below.
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { CloudbedsAPI } = require('../src/cloudbedsApi');

// Stable marker so we can recognise + skip our own prior adjustments.
const ADJUSTMENT_TAG = 'TAX_RECON_V1';
const ADJUSTMENT_DESCRIPTION = `South Dakota State Tax — import reconciliation [${ADJUSTMENT_TAG}]`;

// Targeting fields for postAdjustment. Populate from probeTaxLine.js output.
// Common keys: type='tax', taxID=<id>, itemID=<id>, subReservationID, roomID.
const TAX_LINE_EXTRAS = {
  type: 'tax',
  description: ADJUSTMENT_DESCRIPTION,
  reason: ADJUSTMENT_DESCRIPTION,
};

function parseArgs(argv) {
  const args = {
    input: path.join(__dirname, '..', 'data', 'Balances.xlsx'),
    audit: path.join(__dirname, '..', 'data', 'reconcile_audit.csv'),
    apply: false,
    cap: 5.00,
    limit: Infinity,
    concurrency: 2,
    sleepMs: 250,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--input') args.input = argv[++i];
    else if (a === '--audit') args.audit = argv[++i];
    else if (a === '--cap') args.cap = parseFloat(argv[++i]);
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--concurrency') args.concurrency = parseInt(argv[++i], 10);
    else if (a === '--sleep') args.sleepMs = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 28).join('\n'));
      process.exit(0);
    }
  }
  return args;
}

// Reservation cells are HYPERLINK formulas like:
//   HYPERLINK("https://us2.cloudbeds.com/connect/.../reservations/9080486848629225?display=4RP3DK343Q&reservation_id=9080486848629225", "4RP3DK343Q")
// `cell.text` resolves to the display string (the human code). We also pull
// the internal long ID out of the formula URL in case any endpoint needs it.
function extractInternalID(cellValue) {
  if (!cellValue || typeof cellValue !== 'object') return null;
  const formula = cellValue.formula || '';
  const m = formula.match(/reservation_id=(\d+)/) || formula.match(/reservations\/(\d+)/);
  return m ? m[1] : null;
}

async function readBalances(xlsxPath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.worksheets[0];
  const headerRow = ws.getRow(1).values.slice(1).map(v => String(v || '').trim());
  const idx = (name) => headerRow.findIndex(h => h.toLowerCase() === name.toLowerCase());
  const colRes = idx('Reservation Number');
  const colBal = idx('Reservation Balance Due');
  if (colRes < 0 || colBal < 0) {
    throw new Error(`Workbook missing required columns. Found: ${headerRow.join(' | ')}`);
  }
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    // colRes/colBal are 0-indexed against the header slice (which dropped the
    // leading empty). Convert to 1-indexed cell positions for getCell().
    const resCell = row.getCell(colRes + 1);
    const balCell = row.getCell(colBal + 1);
    const resID = String(resCell.text || resCell.value || '').trim();
    const bal = parseFloat(balCell.value);
    if (!resID || !Number.isFinite(bal) || Math.abs(bal) < 0.005) return;
    rows.push({
      reservationID: resID,
      internalID: extractInternalID(resCell.value),
      balance: Math.round(bal * 100) / 100,
    });
  });
  return rows;
}

function loadAlreadyProcessed(auditPath) {
  if (!fs.existsSync(auditPath)) return new Set();
  const seen = new Set();
  const lines = fs.readFileSync(auditPath, 'utf8').split('\n');
  for (const line of lines) {
    const cells = line.split(',');
    if (cells.length >= 4 && cells[3] === 'posted') {
      seen.add(cells[1]);
    }
  }
  return seen;
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function appendAudit(auditPath, row) {
  if (!fs.existsSync(auditPath)) {
    fs.writeFileSync(auditPath, 'timestamp,reservationID,balance,action,amount,error\n');
  }
  fs.appendFileSync(auditPath,
    [row.timestamp, row.reservationID, row.balance, row.action, row.amount ?? '', row.error ?? '']
      .map(csvEscape).join(',') + '\n');
}

async function processRow(api, row, args, auditPath) {
  const ts = new Date().toISOString();
  const absBal = Math.abs(row.balance);

  if (absBal > args.cap) {
    appendAudit(auditPath, { timestamp: ts, reservationID: row.reservationID, balance: row.balance, action: 'skipped_cap', error: `|balance|=${absBal} > cap=${args.cap}` });
    return { status: 'skipped_cap' };
  }

  if (!args.apply) {
    appendAudit(auditPath, { timestamp: ts, reservationID: row.reservationID, balance: row.balance, action: 'dry_run', amount: row.balance });
    return { status: 'dry_run' };
  }

  try {
    const res = await api.postAdjustment(row.reservationID, row.balance, TAX_LINE_EXTRAS);
    if (res && res.success !== false) {
      appendAudit(auditPath, { timestamp: ts, reservationID: row.reservationID, balance: row.balance, action: 'posted', amount: row.balance });
      return { status: 'posted' };
    }
    appendAudit(auditPath, { timestamp: ts, reservationID: row.reservationID, balance: row.balance, action: 'error', amount: row.balance, error: res?.error || res?.message || 'unknown' });
    return { status: 'error' };
  } catch (e) {
    appendAudit(auditPath, { timestamp: ts, reservationID: row.reservationID, balance: row.balance, action: 'error', amount: row.balance, error: e.message });
    return { status: 'error' };
  }
}

async function runWithConcurrency(items, concurrency, fn) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`Tax balance reconciliation`);
  console.log(`  input:       ${args.input}`);
  console.log(`  audit:       ${args.audit}`);
  console.log(`  mode:        ${args.apply ? 'APPLY' : 'dry-run'}`);
  console.log(`  cap:         $${args.cap.toFixed(2)}`);
  console.log(`  limit:       ${args.limit === Infinity ? 'all' : args.limit}`);
  console.log(`  concurrency: ${args.concurrency}`);

  const rows = await readBalances(args.input);
  console.log(`\nLoaded ${rows.length} non-zero rows from workbook.`);

  const processed = loadAlreadyProcessed(args.audit);
  const remaining = rows.filter(r => !processed.has(r.reservationID));
  console.log(`Already posted in prior runs: ${processed.size}.`);
  console.log(`Remaining to process: ${remaining.length}.`);

  const todo = Number.isFinite(args.limit) ? remaining.slice(0, args.limit) : remaining;

  const counts = { posted: 0, dry_run: 0, skipped_cap: 0, error: 0 };
  const api = new CloudbedsAPI();

  let done = 0;
  const total = todo.length;
  await runWithConcurrency(todo, args.concurrency, async (row) => {
    const r = await processRow(api, row, args, args.audit);
    counts[r.status] = (counts[r.status] || 0) + 1;
    done += 1;
    if (done % 50 === 0 || done === total) {
      console.log(`  progress: ${done}/${total}  posted=${counts.posted} dry=${counts.dry_run} cap=${counts.skipped_cap} err=${counts.error}`);
    }
    if (args.sleepMs) await new Promise(r => setTimeout(r, args.sleepMs));
  });

  console.log('\n=== Summary ===');
  console.log(counts);
  console.log(`Audit written to ${args.audit}`);
  if (!args.apply) {
    console.log('\nThis was a dry run. Re-run with --apply to actually post adjustments.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
