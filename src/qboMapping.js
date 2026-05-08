'use strict';

/**
 * Cloudbeds → QuickBooks Online chart-of-accounts mapping for Gateway Park.
 *
 * The keys here are QBO **account numbers** (AcctNum) — the human-readable
 * codes you see in the QBO Chart of Accounts (e.g. 4000, 2200). Internal
 * QBO IDs (which is what the API actually wants) are resolved at boot
 * via QuickBooks.loadChartLookups() so we never hardcode them.
 *
 * Class names ('Rooms', 'Other Op', 'Misc') match the QBO Class entities
 * the bookkeeper set up. They're resolved the same way (Class.Name → Id).
 *
 * To extend the mapping (e.g. add a new fee type at the property): add
 * a rule to CUSTOM_ITEM_RULES below. Order matters — the first matching
 * regex wins. The catch-all at the end sends anything unmatched to
 * Miscellaneous Revenue (4900).
 */

const ACCT = {
  // Revenue
  ROOM_REVENUE:        '4000',
  NO_SHOW_REVENUE:     '4031',
  CANCEL_FEES:         '4041',
  PET_FEES:            '4051',
  DAMAGE_FEES:         '4061',
  ALLOWANCES_REFUNDS:  '4091',
  MISC_REVENUE:        '4900',
  // Tax liability
  SALES_TAX_PAYABLE:   '2200',
  TOURISM_TAX:         '2210',
  // Payment / clearing
  STRIPE_CLEARING:     '1100',
  OTA_CLEARING:        '1110',
  CASH_CLEARING:       '1120',
  AR:                  '1200'
};

const CLS = {
  ROOMS:    'Rooms',
  OTHER_OP: 'Other Op',
  MISC:     'Misc'
};

// Cloudbeds writes ancillary line items as transactionCategory='custom_item'
// with a free-text transactionCodeDescription. We pattern-match the
// description against this rule list to figure out which QBO account +
// class to credit. First match wins; the trailing catch-all sends
// anything else to Misc Revenue.
const CUSTOM_ITEM_RULES = [
  { match: /\bpet\b/i,                 acctNum: ACCT.PET_FEES,        className: CLS.OTHER_OP, label: 'Pet Fee' },
  { match: /damage|cleaning|smok/i,    acctNum: ACCT.DAMAGE_FEES,     className: CLS.OTHER_OP, label: 'Damage / Cleaning' },
  { match: /cancel/i,                  acctNum: ACCT.CANCEL_FEES,     className: CLS.ROOMS,    label: 'Cancellation Fee' },
  { match: /no.?show/i,                acctNum: ACCT.NO_SHOW_REVENUE, className: CLS.ROOMS,    label: 'No-Show Revenue' },
  // Catch-all: anything Cloudbeds tagged as a custom item that we don't
  // have a specific home for. Bookkeeper can move these to a more
  // specific account during reconciliation if it matters.
  { match: /.*/,                       acctNum: ACCT.MISC_REVENUE,    className: CLS.MISC,     label: 'Misc' }
];

/**
 * Classify one Cloudbeds transaction into a JE line spec.
 *
 * Cloudbeds sign convention:
 *   - Rate / tax / fee charges: amount is POSITIVE
 *   - Payments received: amount is NEGATIVE (they reduce balance)
 *   - Refunds: amount is POSITIVE on a payment row (they restore balance)
 *   - Adjustments (comps, discounts): amount is NEGATIVE
 *
 * We normalize to absolute amount and let `side` describe debit/credit.
 *
 * @returns { acctNum, className?, side: 'debit'|'credit', amount, label, source }
 *          or null if the txn should be skipped (void, zero, unknown).
 */
function classifyTransaction(txn) {
  if (!txn || txn.transactionVoid) return null;
  const rawAmount = Number(txn.transactionAmount);
  if (!Number.isFinite(rawAmount) || rawAmount === 0) return null;

  const cat = String(txn.transactionCategory || '').toLowerCase();
  const desc = String(txn.transactionCodeDescription || '');
  const amount = Math.abs(rawAmount);
  const wasNegative = rawAmount < 0;

  switch (cat) {
    case 'rate':
      return {
        acctNum: ACCT.ROOM_REVENUE,
        className: CLS.ROOMS,
        side: 'credit',
        amount,
        label: 'Room Revenue',
        source: txn
      };

    case 'tax': {
      // SD State 4.2% + City 1% + City 2% all consolidate to 2200
      // (single SD DOR remit). Tourism (1.5%) is a separate filing
      // line so it gets its own account.
      const isTourism = /tourism/i.test(desc);
      return {
        acctNum: isTourism ? ACCT.TOURISM_TAX : ACCT.SALES_TAX_PAYABLE,
        className: null,
        side: 'credit',
        amount,
        label: isTourism ? 'Tourism Tax' : 'Sales Tax',
        source: txn
      };
    }

    case 'custom_item': {
      const rule = CUSTOM_ITEM_RULES.find(r => r.match.test(desc));
      // Catch-all guarantees rule is defined.
      return {
        acctNum: rule.acctNum,
        className: rule.className,
        side: 'credit',
        amount,
        label: rule.label,
        source: txn
      };
    }

    case 'adjustment':
      // Adjustments (comps, discounts, refunds-as-adjustments) reduce
      // gross revenue. USALI: post to contra-revenue (4091) as a debit.
      return {
        acctNum: ACCT.ALLOWANCES_REFUNDS,
        className: CLS.ROOMS,
        side: 'debit',
        amount,
        label: desc || 'Allowance / Adjustment',
        source: txn
      };

    case 'payment': {
      // Cloudbeds payments are negative amounts (reducing balance). A
      // refund on a payment row is positive — treated as a credit to
      // the same clearing account (reversing the original debit).
      const pType = String(txn.paymentType || '').toLowerCase();
      const srcBlob = `${desc} ${txn.sourceName || ''} ${txn.sourceID || ''}`.toLowerCase();
      const isChannelCollect = pType === 'channel_collect' || pType === 'cc' || /channel.?collect/.test(srcBlob);
      const isCash = pType === 'cash' || /\bcash\b/.test(srcBlob);
      const acctNum = isChannelCollect ? ACCT.OTA_CLEARING
                    : isCash            ? ACCT.CASH_CLEARING
                    :                     ACCT.STRIPE_CLEARING;
      // Negative-payment (the normal direction) → debit clearing.
      // Positive-payment (a refund) → credit clearing.
      const side = wasNegative ? 'debit' : 'credit';
      return {
        acctNum,
        className: null,
        side,
        amount,
        label: wasNegative ? 'Payment received' : 'Payment refund',
        source: txn
      };
    }

    default:
      return null;
  }
}

/**
 * Aggregate an array of classified line specs into one entry per
 * (acctNum, className) so the JE has a small, readable line count
 * instead of one line per Cloudbeds transaction.
 *
 * Side fold: if the same account ends up with both debits and credits
 * for the day (e.g. payments + refunds in the same Stripe Clearing),
 * we net them. The line appears on whichever side has the larger total.
 *
 * Each aggregated bucket also carries a `sources` array — the original
 * Cloudbeds transactions that rolled into that bucket. The poster uses
 * this for the offline reconciliation receipt; the JE payload itself
 * doesn't include source detail.
 */
function aggregate(lines) {
  const byKey = new Map();
  for (const l of lines) {
    if (!l) continue;
    const key = `${l.acctNum}::${l.className || ''}`;
    if (!byKey.has(key)) {
      byKey.set(key, { acctNum: l.acctNum, className: l.className, debit: 0, credit: 0, labels: new Set(), sources: [] });
    }
    const bucket = byKey.get(key);
    if (l.side === 'debit') bucket.debit += l.amount;
    else bucket.credit += l.amount;
    if (l.label) bucket.labels.add(l.label);
    if (l.source) bucket.sources.push(l.source);
  }

  const out = [];
  for (const bucket of byKey.values()) {
    const net = bucket.debit - bucket.credit;
    if (Math.abs(net) < 0.005) continue; // zero out — skip the line
    out.push({
      acctNum: bucket.acctNum,
      className: bucket.className || null,
      side: net > 0 ? 'debit' : 'credit',
      amount: Math.abs(round2(net)),
      label: [...bucket.labels].join(', '),
      sources: bucket.sources
    });
  }
  return out;
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = { ACCT, CLS, CUSTOM_ITEM_RULES, classifyTransaction, aggregate };
