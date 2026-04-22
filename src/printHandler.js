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

async function generateFolioPdf(reservationId, r) {
  const { chromium } = require('playwright');
  const htmlContent = `
    <html>
      <head>
        <style>
          body { font-family: 'Helvetica', 'Arial', sans-serif; padding: 40px; color: #333; }
          .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #eee; padding-bottom: 20px; }
          .title { font-size: 24px; font-weight: bold; margin-bottom: 5px; }
          .subtitle { font-size: 14px; color: #777; }
          .info-row { display: flex; justify-content: space-between; margin-bottom: 20px; }
          .box { padding: 15px; border: 1px solid #ddd; background: #fafafa; border-radius: 8px; width: 45%; }
          .label { font-size: 12px; color: #777; text-transform: uppercase; margin-bottom: 5px; }
          .val { font-size: 16px; font-weight: 500; }
          table { width: 100%; border-collapse: collapse; margin-top: 30px; }
          th { text-align: left; padding: 12px; border-bottom: 2px solid #ddd; color: #555; }
          td { padding: 12px; border-bottom: 1px solid #eee; }
          .total-row { font-weight: bold; font-size: 18px; }
          .footer { text-align: center; margin-top: 50px; font-size: 12px; color: #999; }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="title">GATEWAY PARK HOTEL & SUITES</div>
          <div class="subtitle">Guest Folio / Receipt</div>
        </div>
        
        <div class="info-row">
          <div class="box">
            <div class="label">Guest Name</div>
            <div class="val">${r.guestName || 'Valued Guest'}</div>
            <div class="label" style="margin-top:10px;">Email</div>
            <div class="val">${r.guestEmail || 'N/A'}</div>
          </div>
          <div class="box">
            <div class="label">Reservation ID</div>
            <div class="val">${reservationId}</div>
            <div class="label" style="margin-top:10px;">Dates</div>
            <div class="val">${r.startDate} to ${r.endDate}</div>
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
            <tr>
              <td>Total Room Charges & Taxes</td>
              <td style="text-align: right;">$${(r.total || 0).toFixed(2)}</td>
            </tr>
            <tr>
              <td>Total Payments Received</td>
              <td style="text-align: right;">-$${((r.total || 0) - (r.balance || 0)).toFixed(2)}</td>
            </tr>
            <tr class="total-row">
              <td style="padding-top: 20px;">Balance Due</td>
              <td style="text-align: right; padding-top: 20px;">$${(r.balance || 0).toFixed(2)}</td>
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
