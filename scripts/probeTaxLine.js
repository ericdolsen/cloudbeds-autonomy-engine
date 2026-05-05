/**
 * Probe South Dakota State Tax line shape.
 *
 * Pulls transactions for a recent date window and a sample reservation
 * detail, then prints every distinct tax line we see (description, internal
 * code, sub-reservation IDs, etc.) so we know exactly what to pass to
 * postAdjustment when reconciling balance-due dust.
 *
 * Usage:
 *   node scripts/probeTaxLine.js                 # last 7 days
 *   node scripts/probeTaxLine.js --days 30
 *   node scripts/probeTaxLine.js --reservation 4RP3DK343Q
 */
const { CloudbedsAPI } = require('../src/cloudbedsApi');

function parseArgs(argv) {
  const args = { days: 7, reservation: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--days') args.days = parseInt(argv[++i], 10);
    else if (argv[i] === '--reservation') args.reservation = argv[++i];
  }
  return args;
}

function ymd(d) { return d.toISOString().slice(0, 10); }

async function main() {
  const args = parseArgs(process.argv);
  const api = new CloudbedsAPI();

  const end = new Date();
  const start = new Date(end.getTime() - args.days * 86400_000);
  console.log(`\n=== Transactions ${ymd(start)} → ${ymd(end)} ===`);
  const txnRes = await api.getTransactions(ymd(start), ymd(end));
  const txns = txnRes?.data || [];
  console.log(`fetched ${txns.length} transactions`);

  const taxTxns = txns.filter(t => t.transactionCategory === 'tax' && !t.transactionVoid);
  console.log(`${taxTxns.length} tax transactions`);

  // Group by description + internalTransactionCode so we can see each
  // distinct tax-line shape used by the property.
  const groups = new Map();
  for (const t of taxTxns) {
    const key = `${t.transactionCodeDescription}||${t.internalTransactionCode}`;
    if (!groups.has(key)) {
      groups.set(key, { sample: t, count: 0, totalAmount: 0 });
    }
    const g = groups.get(key);
    g.count += 1;
    g.totalAmount += parseFloat(t.transactionAmount || 0);
  }

  console.log(`\n--- Distinct tax line shapes (${groups.size}) ---`);
  for (const [key, g] of groups) {
    const s = g.sample;
    console.log({
      description: s.transactionCodeDescription,
      internalTransactionCode: s.internalTransactionCode,
      transactionType: s.transactionType,
      transactionCategory: s.transactionCategory,
      sourceFields: {
        sourceId: s.sourceId,
        subSourceId: s.subSourceId,
      },
      occurrences: g.count,
      totalAmount: g.totalAmount.toFixed(2),
    });
  }

  // Single-reservation deep dive for the field shape postAdjustment needs.
  let probeRes = args.reservation;
  if (!probeRes && taxTxns.length) probeRes = taxTxns[0].reservationID;
  if (probeRes) {
    console.log(`\n=== getReservation(${probeRes}) — line-item structure ===`);
    const detail = await api.getReservationById(probeRes);
    if (detail?.success === false) {
      console.log('lookup failed:', detail.error);
    } else {
      const d = detail?.data || detail;
      const summary = {
        reservationID: d.reservationID,
        balance: d.balance,
        balanceDetailed: d.balanceDetailed,
        assignedKeys: d.assigned ? Object.keys(d.assigned).slice(0, 3) : null,
        roomsKeys: d.rooms ? Object.keys(d.rooms).slice(0, 3) : null,
      };
      console.log('top-level shape:', summary);

      // Surface any nested field that looks like a per-line ID we'd target.
      const targetKeys = ['subReservationID', 'roomID', 'taxID', 'itemID', 'transactionID', 'internalTransactionCode'];
      const seen = new Set();
      const walk = (obj, path = '') => {
        if (!obj || typeof obj !== 'object') return;
        for (const [k, v] of Object.entries(obj)) {
          const p = path ? `${path}.${k}` : k;
          if (targetKeys.includes(k) && !seen.has(p)) {
            seen.add(p);
            console.log(`  ${p} = ${JSON.stringify(v)}`);
          }
          if (typeof v === 'object') walk(v, p);
        }
      };
      walk(d);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
