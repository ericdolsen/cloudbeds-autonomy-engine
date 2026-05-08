'use strict';

const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');
const { classifyTransaction, aggregate, ACCT } = require('./qboMapping');

const RECEIPT_DIR = path.join(__dirname, '..', 'data', 'qbo-receipts');

/**
 * Post one day of Cloudbeds activity into QuickBooks Online as a single
 * Journal Entry.
 *
 * Idempotency:
 *   We use DocNumber = "GP-YYYY-MM-DD" as the unique key. Re-running
 *   for the same date does NOT create a duplicate JE — instead we
 *   look up the existing JE, and if found, sparse-update it with the
 *   freshly recomputed lines. This means a backfill / re-run after a
 *   bookkeeper-edited day will overwrite their edits, so the manual
 *   "Post to QuickBooks" button asks for confirmation when the date
 *   has already been posted.
 *
 * Plug line:
 *   QBO requires every JE to balance. Sum-of-debits must equal
 *   sum-of-credits to the cent. After we apply the chart mapping to
 *   each Cloudbeds transaction the totals usually balance — but A/R
 *   (guests who left without paying) is the natural plug. If a small
 *   rounding difference remains after the AR plug, we route it to
 *   Misc Revenue (4900) so the entry still posts cleanly. Any drift
 *   over $1 is logged as a warning.
 */
async function postDayToQbo({ qbo, api, dateStr, force = false }) {
  if (!qbo.isConfigured()) {
    throw new Error('QuickBooks integration not configured. Run scripts/qboConnect.js first.');
  }

  // Make sure the AcctNum/Class lookups are loaded. Cheap if already done.
  await qbo.loadChartLookups();

  // 1. Fetch transactions for the business date.
  logger.info(`[QBO POSTER] Fetching Cloudbeds transactions for ${dateStr}...`);
  const txnResp = await api.getTransactions(dateStr, dateStr);
  if (!txnResp || !txnResp.success) {
    throw new Error(`Could not fetch Cloudbeds transactions for ${dateStr}.`);
  }
  const txns = (txnResp.data || []).filter(t => t && !t.transactionVoid);
  logger.info(`[QBO POSTER] ${txns.length} transactions to classify.`);

  // 2. Classify each transaction.
  const classified = [];
  const skipped = [];
  for (const t of txns) {
    const line = classifyTransaction(t);
    if (line) classified.push(line);
    else skipped.push(t);
  }

  if (classified.length === 0) {
    logger.info(`[QBO POSTER] Nothing classified for ${dateStr}; skipping JE.`);
    return { success: true, skipped: true, reason: 'no transactions' };
  }

  // 3. Aggregate (acctNum, class) → net debit/credit.
  const aggregated = aggregate(classified);

  // 4. Compute imbalance and decide where the plug goes. If the day
  //    has unpaid arrivals (gross revenue > payments collected), the
  //    plug is debited to A/R. If the imbalance is tiny (< $1) and
  //    not naturally A/R, route the residual to Misc Revenue.
  const totalDebit  = sumSide(aggregated, 'debit');
  const totalCredit = sumSide(aggregated, 'credit');
  const imbalance = round2(totalCredit - totalDebit);

  if (Math.abs(imbalance) > 0.005) {
    // Positive imbalance = more credits than debits → need a debit
    // plug. The natural target is Accounts Receivable (guest left an
    // unpaid balance). Negative would be more debits than credits →
    // unusual; route to Misc Revenue and warn.
    if (imbalance > 0) {
      aggregated.push({
        acctNum: ACCT.AR,
        className: null,
        side: 'debit',
        amount: imbalance,
        label: 'Outstanding balance (plug to A/R)'
      });
      logger.info(`[QBO POSTER] Added A/R plug line for $${imbalance.toFixed(2)}.`);
    } else {
      const adj = Math.abs(imbalance);
      aggregated.push({
        acctNum: ACCT.MISC_REVENUE,
        className: 'Misc',
        side: 'credit',
        amount: adj,
        label: 'Rounding / unmatched debits (plug)'
      });
      if (adj > 1.00) {
        logger.warn(`[QBO POSTER] Day ${dateStr} had a NEGATIVE imbalance of $${adj.toFixed(2)} (more debits than credits). Routing to Misc Revenue. Investigate — this usually means a refund or void wasn't classified correctly.`);
      } else {
        logger.info(`[QBO POSTER] Added rounding plug for $${adj.toFixed(2)} to Misc Revenue.`);
      }
    }
  }

  // 5. Build the QBO JE payload.
  const docNumber = `GP-${dateStr}`;

  // QBO requires every line that references an Accounts Receivable
  // account to include a Customer in the Name field. Our daily aggregate
  // doesn't track per-guest balances, so we point all A/R activity at a
  // single placeholder customer ("Daily Cloudbeds Aggregate"). The
  // customer is auto-created on first use.
  let aggregateCustomerId = null;
  if (aggregated.some(l => l.acctNum === ACCT.AR)) {
    const customer = await qbo.findOrCreateCustomerByName('Daily Cloudbeds Aggregate');
    aggregateCustomerId = customer && customer.Id;
    if (!aggregateCustomerId) throw new Error('Could not resolve placeholder Customer for A/R line.');
  }

  const lines = aggregated.map((l, idx) => {
    const acctId = qbo.accountIdForNum(l.acctNum);
    const classId = l.className ? qbo.classIdForName(l.className) : null;
    const detail = {
      PostingType: l.side === 'debit' ? 'Debit' : 'Credit',
      AccountRef: { value: acctId }
    };
    if (classId) detail.ClassRef = { value: classId };
    // Attach the placeholder customer to A/R lines per QBO's
    // mandatory-Name-field requirement.
    if (l.acctNum === ACCT.AR && aggregateCustomerId) {
      detail.Entity = {
        Type: 'Customer',
        EntityRef: { value: aggregateCustomerId }
      };
    }
    return {
      Id: String(idx),
      Description: l.label || '',
      Amount: round2(l.amount),
      DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: detail
    };
  });

  const txnDate = dateStr;
  const memo = `Daily Cloudbeds summary for ${dateStr}. ${txns.length} txns.${skipped.length ? ` (${skipped.length} skipped)` : ''}`;
  const jePayload = { TxnDate: txnDate, DocNumber: docNumber, PrivateNote: memo, Line: lines };

  // Recompute totals AFTER the plug so the log line reflects what's
  // actually being sent to QBO (pre-plug totals were what made the
  // last operator look at a JE log line that read "DR != CR" even
  // though the posted JE was balanced).
  const finalDebit  = sumSide(aggregated, 'debit');
  const finalCredit = sumSide(aggregated, 'credit');

  // 6. Idempotency: look for an existing JE with this DocNumber.
  const existing = await qbo.findJournalEntryByDocNumber(docNumber);
  if (existing && !force) {
    logger.info(`[QBO POSTER] JE for ${dateStr} already exists (Id=${existing.Id}); not overwriting. Pass force=true to update.`);
    return {
      success: true,
      action: 'noop',
      reason: 'JE already exists for this date',
      docNumber,
      existingId: existing.Id,
      lines: lines.length,
      totalDebit: round2(totalDebit),
      totalCredit: round2(totalCredit)
    };
  }

  let result;
  if (existing && force) {
    logger.info(`[QBO POSTER] Updating existing JE for ${dateStr} (Id=${existing.Id}, SyncToken=${existing.SyncToken}). ${lines.length} lines, DR/CR $${finalDebit.toFixed(2)}.`);
    result = await qbo.updateJournalEntry({
      ...jePayload,
      Id: existing.Id,
      SyncToken: existing.SyncToken
    });
  } else {
    logger.info(`[QBO POSTER] Creating new JE for ${dateStr} with ${lines.length} lines, DR/CR $${finalDebit.toFixed(2)}.`);
    result = await qbo.createJournalEntry(jePayload);
  }

  // Write the offline reconciliation receipt. We do this AFTER the post
  // succeeds — failing to write the file shouldn't undo a successful
  // QBO post, so disk errors are warnings, not failures.
  _writeReceipt({
    docNumber,
    businessDate: dateStr,
    postedAt: new Date().toISOString(),
    action: existing ? 'updated' : 'created',
    qboId: (result && result.Id) || null,
    qboSyncToken: (result && result.SyncToken) || null,
    txnCount: txns.length,
    skippedCount: skipped.length,
    totals: { debit: round2(finalDebit), credit: round2(finalCredit) },
    aggregated
  });

  return {
    success: true,
    action: existing ? 'updated' : 'created',
    docNumber,
    qboId: result && result.Id,
    lines: lines.length,
    totalDebit: round2(finalDebit),
    totalCredit: round2(finalCredit),
    skipped: skipped.length
  };
}

/**
 * Write a JSON receipt to data/qbo-receipts/<docNumber>.json with full
 * per-line + per-source-txn detail so the bookkeeper can reconcile
 * offline. Failure to write is logged but does not throw — by the time
 * we get here, QBO has already accepted the JE.
 */
function _writeReceipt(envelope) {
  try {
    fs.mkdirSync(RECEIPT_DIR, { recursive: true });
    const receipt = {
      docNumber:     envelope.docNumber,
      businessDate:  envelope.businessDate,
      postedAt:      envelope.postedAt,
      action:        envelope.action,
      qboId:         envelope.qboId,
      qboSyncToken:  envelope.qboSyncToken,
      txnCount:      envelope.txnCount,
      skippedCount:  envelope.skippedCount,
      totals:        envelope.totals,
      lines: envelope.aggregated.map((l, idx) => ({
        lineNumber:  idx + 1,
        acctNum:     l.acctNum,
        className:   l.className,
        side:        l.side,
        amount:      round2(l.amount),
        description: l.label,
        sources:     (l.sources || []).map(s => ({
          // Only the Cloudbeds fields a bookkeeper actually needs to
          // cross-reference. Skip raw blobs / internal codes.
          reservationID:               s.reservationID || null,
          guestName:                   s.guestName || null,
          transactionID:               s.transactionID || s.id || null,
          transactionDate:             s.transactionDate || null,
          transactionType:             s.transactionType || null,
          transactionCategory:         s.transactionCategory || null,
          transactionCodeDescription: s.transactionCodeDescription || null,
          transactionAmount:           Number(s.transactionAmount) || 0,
          paymentType:                 s.paymentType || null,
          sourceName:                  s.sourceName || null
        }))
      }))
    };
    const filePath = path.join(RECEIPT_DIR, `${envelope.docNumber}.json`);
    fs.writeFileSync(filePath, JSON.stringify(receipt, null, 2), 'utf8');
    logger.info(`[QBO POSTER] Wrote receipt ${path.basename(filePath)} (${receipt.lines.length} lines, ${receipt.txnCount} source txns).`);
  } catch (e) {
    logger.warn(`[QBO POSTER] Could not write receipt for ${envelope.docNumber}: ${e.message}. The JE posted successfully; this only affects the offline audit trail.`);
  }
}

/**
 * Read a previously-posted receipt by business date. Returns null if
 * no receipt exists. Used by the /api/qbo/receipt endpoint.
 */
function readReceipt(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const filePath = path.join(RECEIPT_DIR, `GP-${dateStr}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    logger.warn(`[QBO POSTER] Could not parse receipt ${path.basename(filePath)}: ${e.message}`);
    return null;
  }
}

function sumSide(lines, side) {
  return lines.reduce((s, l) => s + (l.side === side ? l.amount : 0), 0);
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = { postDayToQbo, readReceipt };
