const fs = require('fs');
const path = require('path');
const os = require('os');
const { print } = require('pdf-to-printer');
const { logger } = require('./logger');

/**
 * Handles physical printing of a downloaded PDF to the server's default printer.
 */
async function printPdfBuffer(pdfBuffer, documentId) {
  // Save buffer to a temporary file
  const tempDir = os.tmpdir();
  const filePath = path.join(tempDir, `Folio_${documentId}_${Date.now()}.pdf`);
  
  try {
    fs.writeFileSync(filePath, pdfBuffer);
    logger.info(`[PRINTER] PDF temporarily saved to ${filePath}`);

    logger.info(`[PRINTER] Sending document ${documentId} to default physical printer...`);
    // Print using the default Windows printer
    await print(filePath);
    logger.info(`[PRINTER] Document sent to printer successfully.`);

    // Clean up
    fs.unlinkSync(filePath);
    logger.info(`[PRINTER] Temporary file ${filePath} removed.`);
    return { success: true };
  } catch (err) {
    logger.error(`[PRINTER] Failed to print document: ${err.message}`);
    // Attempt cleanup if it exists
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch(e){}
    }
    return { success: false, error: err.message };
  }
}

// Itemize payment transactions for the receipt's "Payments Received"
// section. Each row gives the guest a clear paper trail for expense
// reports: card brand + last 4 if Cloudbeds populates the description
// that way, otherwise whatever description the transaction has.
//
// When transactions are unavailable (empty array passed in) but the
// reservation balance shows money was paid, render a single
// lump-sum row instead of "No payments recorded." — that double-rendered
// (empty state + lump sum fallback) on the previous version of this
// receipt and looked broken to the guest.
function _renderPaymentRows(payments, paidLumpSum) {
  if (!payments || payments.length === 0) {
    if (paidLumpSum > 0) {
      return `
      <tr>
        <td style="padding-left: 24px; color:#666;">Payment received <span style="color:#999; font-size:11px;">(transaction details unavailable)</span></td>
        <td style="text-align: right;">-$${paidLumpSum.toFixed(2)}</td>
      </tr>`;
    }
    return `<tr><td colspan="2" style="color:#999; padding: 8px 12px;">No payments recorded.</td></tr>`;
  }
  return payments.map(p => {
    const desc = (p.description || p.transactionCodeDescription || 'Payment').toString();
    const safe = desc.replace(/[<>]/g, '').substring(0, 80);
    const amt = Number(p.transactionAmount || p.amount || 0);
    // Payments are stored as negative numbers in some Cloudbeds reports;
    // normalize to positive so the receipt reads naturally.
    const display = Math.abs(amt).toFixed(2);
    const date = p.transactionDate || p.serviceDate || '';
    return `
      <tr>
        <td style="padding-left: 24px;">${safe}${date ? ` <span style="color:#999; font-size:11px;">(${date})</span>` : ''}</td>
        <td style="text-align: right;">-$${display}</td>
      </tr>
    `;
  }).join('');
}

// Hotel branding + contact block embedded at the top of every PDF
// receipt. Mirrors the values exposed in autonomyEngine.getHotelPolicies()
// so guest-facing answers and printed/emailed receipts stay in sync.
const HOTEL_INFO = {
  name: 'Gateway Park Hotel & Suites',
  address: '830 Gateway Lane, Tea, SD 57064',
  phone: '605-213-1500',
  fax: '605-213-1501',
  email: 'Info@gatewayparkhotel.com'
};

// Try to embed a logo at data/logo.png as a base64 data: URI. If the
// file isn't present we fall back to the bold hotel-name text. The
// logo file isn't checked into git — drop the operator's PNG into
// data/logo.png after deploy and it'll start appearing automatically.
function _loadLogoDataUri() {
  try {
    const logoPath = path.join(__dirname, '..', 'data', 'logo.png');
    if (fs.existsSync(logoPath)) {
      const data = fs.readFileSync(logoPath).toString('base64');
      return `data:image/png;base64,${data}`;
    }
  } catch (e) { /* fall through to text title */ }
  return '';
}

/**
 * Build the guest-facing folio PDF for a checkout receipt.
 *
 * Shape of the breakdown was previously a single "Total Room Charges &
 * Taxes" line, which guests (especially business travelers needing
 * itemized receipts for expense reports) couldn't use. Now broken into:
 *   Subtotal (room rate)
 *   Taxes & Fees
 *   Additional Items
 *   Total
 *   Payments Received (one row per payment with description / card info)
 *   Balance Due
 *
 * @param {string} reservationId
 * @param {object} r              the reservation as returned by getReservationById
 * @param {Array}  [transactions] optional pre-fetched payments for itemization;
 *                                if omitted, the section just shows the lump
 *                                sum from balanceDetailed.paid.
 */
async function generateFolioPdf(reservationId, r, transactions) {
  const { chromium } = require('playwright');
  const detailed = r.balanceDetailed || {};
  const subtotal = Number(detailed.subTotal || 0);
  const taxesFees = Number(detailed.taxesFees || 0);
  const additionalItems = Number(detailed.additionalItems || 0);
  const grandTotal = Number(detailed.grandTotal || r.total || 0);
  const paid = Number(detailed.paid || (grandTotal - (r.balance || 0)));
  const balance = Number(r.balance || 0);

  const payments = Array.isArray(transactions)
    ? transactions.filter(t => t && (t.transactionType === 'Payment' || t.transactionCategory === 'payment') && !t.transactionVoid)
    : [];

  const logoDataUri = _loadLogoDataUri();

  const htmlContent = `
    <html>
      <head>
        <style>
          body { font-family: 'Helvetica', 'Arial', sans-serif; padding: 40px; color: #333; }
          .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #eee; padding-bottom: 20px; }
          .header img.logo { max-width: 320px; max-height: 90px; display: block; margin: 0 auto 10px; }
          .title { font-size: 24px; font-weight: bold; margin-bottom: 5px; }
          .subtitle { font-size: 14px; color: #777; margin-bottom: 8px; }
          .hotel-info { font-size: 12px; color: #666; line-height: 1.5; }
          .hotel-info .sep { color: #ccc; margin: 0 6px; }
          .info-row { display: flex; justify-content: space-between; margin-bottom: 20px; }
          .box { padding: 15px; border: 1px solid #ddd; background: #fafafa; border-radius: 8px; width: 45%; }
          .label { font-size: 12px; color: #777; text-transform: uppercase; margin-bottom: 5px; }
          .val { font-size: 16px; font-weight: 500; }
          table { width: 100%; border-collapse: collapse; margin-top: 30px; }
          th { text-align: left; padding: 12px; border-bottom: 2px solid #ddd; color: #555; }
          td { padding: 12px; border-bottom: 1px solid #eee; }
          .section-row td { background: #f5f7fa; font-weight: 600; color: #555; padding-top: 16px; padding-bottom: 8px; }
          .total-row td { font-weight: bold; font-size: 18px; padding-top: 16px; }
          .balance-row td { font-weight: bold; font-size: 20px; color: ${balance > 0 ? '#b91c1c' : '#15803d'}; }
          .footer { text-align: center; margin-top: 50px; font-size: 12px; color: #999; }
        </style>
      </head>
      <body>
        <div class="header">
          ${logoDataUri
            ? `<img class="logo" src="${logoDataUri}" alt="${HOTEL_INFO.name}" />`
            : `<div class="title">${HOTEL_INFO.name.toUpperCase()}</div>`}
          <div class="subtitle">Guest Folio / Receipt</div>
          <div class="hotel-info">
            ${HOTEL_INFO.address}
            <span class="sep">·</span> ${HOTEL_INFO.phone}
            <span class="sep">·</span> ${HOTEL_INFO.email}
          </div>
        </div>

        <div class="info-row">
          <div class="box">
            <div class="label">Guest Name</div>
            <div class="val">${(r.guestName || 'Valued Guest').toString().replace(/[<>]/g, '')}</div>
            <div class="label" style="margin-top:10px;">Email</div>
            <div class="val">${(r.guestEmail || 'N/A').toString().replace(/[<>]/g, '')}</div>
          </div>
          <div class="box">
            <div class="label">Reservation ID</div>
            <div class="val">${reservationId}</div>
            <div class="label" style="margin-top:10px;">Dates</div>
            <div class="val">${r.startDate || ''} to ${r.endDate || ''}</div>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Description</th>
              <th style="text-align: right;">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr class="section-row"><td colspan="2">Charges</td></tr>
            <tr>
              <td style="padding-left: 24px;">Room Subtotal</td>
              <td style="text-align: right;">$${subtotal.toFixed(2)}</td>
            </tr>
            ${additionalItems > 0 ? `
            <tr>
              <td style="padding-left: 24px;">Additional Items &amp; Services</td>
              <td style="text-align: right;">$${additionalItems.toFixed(2)}</td>
            </tr>` : ''}
            <tr>
              <td style="padding-left: 24px;">Taxes &amp; Fees</td>
              <td style="text-align: right;">$${taxesFees.toFixed(2)}</td>
            </tr>
            <tr class="total-row">
              <td>Total</td>
              <td style="text-align: right;">$${grandTotal.toFixed(2)}</td>
            </tr>

            <tr class="section-row"><td colspan="2">Payments Received</td></tr>
            ${_renderPaymentRows(payments, paid)}
            <tr class="total-row">
              <td>Total Paid</td>
              <td style="text-align: right;">-$${paid.toFixed(2)}</td>
            </tr>

            <tr class="balance-row">
              <td style="padding-top: 24px;">Balance ${balance > 0 ? 'Due' : 'Settled'}</td>
              <td style="text-align: right; padding-top: 24px;">$${balance.toFixed(2)}</td>
            </tr>
          </tbody>
        </table>

        <div class="footer">
          Thank you for staying with us!<br>
          Please contact the front desk if you have any questions regarding this receipt.
        </div>
      </body>
    </html>
  `;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(htmlContent, { waitUntil: 'networkidle' });
  const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
  await browser.close();
  return pdfBuffer;
}

module.exports = { printPdfBuffer, generateFolioPdf };
