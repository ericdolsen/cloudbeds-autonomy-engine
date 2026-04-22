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

module.exports = { printPdfBuffer };
