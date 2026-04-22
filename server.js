const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cron = require('node-cron');
const path = require('path');
const { CloudbedsAgent } = require('./src/agent');
const { NightAuditReport } = require('./src/nightAuditReport');
const { HousekeepingAssigner } = require('./src/housekeepingAssigner');
const { logger } = require('./src/logger');

require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const port = process.env.PORT || 3000;

// Setup static files and APIs
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '5mb' })); // large enough for signature PNGs from kiosk

// Serve the Kiosk UI on the root directory
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'kiosk.html'));
});

// Initialize the master Autonomy Engine
const agent = new CloudbedsAgent();

// WebSockets (Tablet Connectivity)
io.on('connection', (socket) => {
  logger.info(`[WEBSOCKET] Kiosk Tablet Connected: ${socket.id}`);
});

// Employee Dashboard Security Middleware
const checkLocalNetwork = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (/^::1|^127\.0\.0\.1|^::ffff:127\.0\.0\.1|^10\.|^192\.168\.|^172\.(1[6-9]|2[0-9]|3[0-1])\.|^::ffff:10\.|^::ffff:192\.168\./.test(ip)) {
    next();
  } else {
    logger.warn(`[SECURITY] Blocked external access attempt to staff portal from IP: ${ip}`);
    res.status(403).send('Forbidden: Local Network Access Only');
  }
};

app.get('/employee', checkLocalNetwork, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'employee.html'));
});

// Employee Portal API Routes
app.get('/api/employee/status', checkLocalNetwork, (req, res) => {
    res.json({
      status: agent.isRunning ? 'running' : 'stopped',
      uptime: process.uptime(),
      feed: logger.getFeed()
    });
  });

app.post('/api/employee/reports/night-audit', checkLocalNetwork, async (req, res) => {
  if (!agent.isRunning) return res.status(503).json({ error: "System is offline" });
  try {
     const reportEngine = new NightAuditReport(agent.engine.api);
     logger.info('[EMPLOYEE] Night Audit report manually requested via Dashboard');
     const reportDt = reportEngine.addDays(new Date(), -1);
     const result = await reportEngine.generatePdfBuffer(reportDt);
     if (!result || !result.pdfBuffer) throw new Error("PDF Generation Failed");
     
     res.setHeader('Content-Length', result.pdfBuffer.length);
     res.setHeader('Content-Type', 'application/pdf');
     res.setHeader('Content-Disposition', 'inline; filename="GatewayPark_DailyReport.pdf"');
     res.send(result.pdfBuffer);
  } catch (err) {
     logger.error(`[EMPLOYEE] Manual report error: ${err.message}`);
     res.status(500).json({ error: err.message });
  }
});

// Primary Webhook Ingress from Cloudbeds (System Events like reservation created)
app.post('/api/webhooks/cloudbeds', async (req, res) => {
  const payload = req.body;
  // Cloudbeds webhooks deliver `object` and `action` as separate top-level fields.
  const event = payload.event || (payload.object && payload.action ? `${payload.object}/${payload.action}` : 'unknown');
  const reservationID = payload.reservationID || payload.reservationId || 'unknown';
  logger.info(`[WEBHOOK] Incoming payload from Cloudbeds: ${event}`);

  // Cloudbeds requires an immediate 2XX response to prevent webhook retry loops
  res.status(200).send("OK");

  if (!agent.isRunning) {
    logger.warn(`[WEBHOOK] Engine stopped. Ignoring event.`);
    return;
  }

  try {
    let promptText = "";

    if (event === "reservation/created") {
      promptText = `A new reservation (ID: ${reservationID}) was just created on Cloudbeds. Please review their details and determine if any proactive steps or folio adjustments are needed.`;
    } else if (event === "reservation/dates_changed") {
      promptText = `The dates for reservation ${reservationID} just changed. Review the ledger to ensure we don't need to issue any fee adjustments.`;
    } else {
      promptText = `A generic Cloudbeds system event occurred: ${event} for reservation ${reservationID}. Review if necessary.`;
    }

    await agent.processIncomingMessage({ source: 'cloudbeds', text: promptText });
  } catch (err) {
    logger.error(`Webhook processing error: ${err.message}`);
  }
});

// Primary Webhook Ingress from Whistle / Guest Experience (Text Messaging)
app.post('/api/webhooks/whistle', async (req, res) => {
  const payload = req.body; 
  logger.info(`[WEBHOOK] Incoming SMS/Message from Whistle`);

  // Acknowledge immediately to Whistle
  res.status(200).send("OK");

  if (!agent.isRunning) return;

  try {
    // Example mapping - will be adjusted when Whistle keys arrive
    const guestPhone = payload.guest_phone || payload.phone || "Unknown";
    const message = payload.message || payload.text || payload.body;
    
    const promptText = `Guest at phone number ${guestPhone} just sent a text message: "${message}". Please respond. Your response will automatically be sent back to them via text.`;
    
    const result = await agent.processIncomingMessage({ source: 'whistle', text: promptText });
    
    // Ideally here we send the result.agent_response back to the Whistle API endpoint
    if (result && result.agent_response) {
       logger.info(`[WHISTLE API OUT] Sending SMS back off-chain: ${result.agent_response.substring(0,40)}...`);
       // await agent.api.sendWhistleMessage(guestPhone, result.agent_response); // coming soon
    }
    
  } catch (err) {
    logger.error(`Whistle Webhook processing error: ${err.message}`);
  }
});

// Manual Testing Endpoint (While waiting for actual webhooks)
app.post('/api/test', async (req, res) => {
  const { text } = req.body;
  logger.info(`[TEST] Manual test payload received: "${text}"`);
  
  try {
    const result = await agent.processIncomingMessage({ source: 'manual_test', text });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const { SalesTaxEngine } = require('./src/salesTaxEngine');

// Sales Tax Report Endpoint
app.post('/api/employee/reports/sales-tax', checkLocalNetwork, async (req, res) => {
  if (!agent.isRunning) return res.status(503).json({ success: false, error: 'Engine stopped' });
  const { month, year, useTax } = req.body;
  if (!month || !year) return res.status(400).json({ success: false, error: 'Month and year required.' });
  
  try {
     const taxEngine = new SalesTaxEngine(agent.engine.api);
     const result = await taxEngine.generateReport(month, parseInt(year), parseFloat(useTax || 0));
     logger.action('System', `Computed automated Sales Tax report for ${month} ${year}.`, 'ok');
     res.json(result);
  } catch (err) {
     logger.action('System', `Failed to generate Tax Report: ${err.message}`, 'error');
     logger.error(`[SALES TAX] Failed to process tax generation: ${err.message}`);
     res.status(500).json({ success: false, error: err.message });
  }
});

// Kiosk REST API Endpoint (Checkout)
app.post('/api/kiosk/checkout', async (req, res) => {
  const { reservationId, lastName, terminalName } = req.body;
  logger.info(`[KIOSK] Request received - Res: ${reservationId}, Name: ${lastName}, Terminal: ${terminalName}`);
  
  if (!agent.isRunning) {
    return res.status(503).json({ success: false, message: "Front desk system is currently initializing." });
  }

  try {
    // We send a specific intent prompt to the Autonomy Engine mimicking the kiosk request
    const promptText = `A guest with last name "${lastName}" is at the kiosk attempting to check out of reservation ${reservationId} using terminal ${terminalName}. Please process their checkout completely by verifying their balance, executing a checkout, and communicating success back.`;
    
    const result = await agent.processIncomingMessage({ source: 'kiosk', text: promptText });
    
    logger.action('Checkout', `Processed self-checkout for guest ${lastName} (Res: ${reservationId})`, 'ok');
    
    // The engine's text reply will be the message displayed on the Kiosk screen
    // If the engine didn't throw an error, we assume it successfully processed
    res.json({ success: true, status: 'complete', message: result.agent_response });
  } catch (error) {
    logger.action('Checkout', `Checkout failed for Res: ${reservationId} (${error.message})`, 'error');
    logger.error(`[KIOSK] Backend Execution Failed: ${error.message}`);
    res.status(500).json({ success: false, message: "System error. Please visit the front desk." });
  }
});

// Best-effort US-style "street, city, state zip" parser.
function parseAddressBlob(blob) {
  if (!blob || typeof blob !== 'string') return {};
  const parts = blob.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { guestAddress1: parts[0] };
  const [street, maybeCity, maybeStateZip, ...rest] = parts;
  const result = { guestAddress1: street };
  if (maybeCity) result.guestCity = maybeCity;
  if (maybeStateZip) {
    const m = maybeStateZip.match(/^([A-Za-z .]+?)\s*(\d{5}(?:-\d{4})?)?$/);
    if (m) {
      if (m[1]) result.guestState = m[1].trim();
      if (m[2]) result.guestZip = m[2];
    } else {
      result.guestState = maybeStateZip;
    }
  }
  if (rest.length) result.guestCountry = rest[rest.length - 1];
  return result;
}

// Kiosk REST API Endpoint (Checkin)
app.post('/api/kiosk/checkin', async (req, res) => {
  const { reservationId, lastName, terminalName, guestUpdates } = req.body;
  logger.info(`[KIOSK] Checkin Request received - Res: ${reservationId}, Name: ${lastName}, Terminal: ${terminalName}`);

  if (!agent.isRunning) {
    return res.status(503).json({ success: false, message: "Front desk system is currently initializing." });
  }

  try {
    if (guestUpdates) {
      logger.info(`[KIOSK] Syncing Registration Card and Profile Updates for ${reservationId}...`);
      try {
        const resData = await agent.engine.api.getReservationById(reservationId);
        if (resData.success && resData.data) {
          let guestID = resData.data.guestID || resData.data.guestId;
          if (!guestID && resData.data.guestList) {
            const guests = Object.values(resData.data.guestList);
            const mg = guests.find(g => g.isMainGuest) || guests[0];
            if (mg) guestID = mg.guestID || mg.guestId;
          }

          if (guestID) {
            const addressFields = parseAddressBlob(guestUpdates.address);
            await agent.engine.api.putGuest(guestID, {
              guestEmail: guestUpdates.email || undefined,
              guestCellPhone: guestUpdates.phone || undefined,
              ...addressFields
            });
          } else {
            logger.warn(`[KIOSK] Could not resolve guestID for reservation ${reservationId}; skipping putGuest.`);
          }
        }

        if (guestUpdates.signature) {
          await agent.engine.api.postReservationDocument(reservationId, guestUpdates.signature, "Registration_Signature.png");
        }
      } catch (e) {
        logger.error(`[KIOSK] Failed to sync registration to Cloudbeds (non-fatal): ${e.message}`);
      }
    }

    const promptText = `A guest with last name "${lastName}" is at the kiosk attempting to physically check in to reservation ${reservationId} using terminal ${terminalName}. Please process their check-in completely: fetch the reservation, collect any outstanding balance via chargePhysicalTerminal on the kiosk terminal, then call checkInReservation to transition Cloudbeds to checked_in, and communicate success back. If any step fails, surface the exact reason and ask the guest to see the front desk.`;

    const result = await agent.processIncomingMessage({ source: 'kiosk', text: promptText });

    logger.action('Checkin', `Processed self-checkin for guest ${lastName} (Res: ${reservationId})`, 'ok');
    res.json({ success: true, status: 'complete', message: result.agent_response });
  } catch (error) {
    logger.action('Checkin', `Checkin failed for Res: ${reservationId} (${error.message})`, 'error');
    logger.error(`[KIOSK] Backend Execution Failed: ${error.message}`);
    res.status(500).json({ success: false, message: "System error. Please visit the front desk." });
  }
});

// "Push to Tablet" Chrome Extension Relay Endpoint
app.post('/api/kiosk/push', (req, res) => {
  const { reservationId } = req.body;
  
  if (!reservationId) {
    return res.status(400).json({ success: false, error: 'reservationId is required' });
  }
  
  logger.info(`[KIOSK PUSH] Received Chrome Extension push for Reservation: ${reservationId}. Pinging tablet via WebSockets.`);
  
  // Emits the Cloudbeds push event directly to the tablet's browser
  io.emit('pushToTablet', { reservationId });
  
  res.json({ success: true, message: `Successfully pushed reservation ${reservationId} to tablet.` });
});

// Extract the main guest's verifiable contact info from a Cloudbeds reservation payload.
function extractGuestContact(data) {
  let phone = '';
  let email = (data.guestEmail || '').toString();
  let address1 = '', city = '', state = '', zip = '', country = '';

  if (data.guestList) {
    const guests = Object.values(data.guestList);
    const mg = guests.find(g => g.isMainGuest) || guests[0];
    if (mg) {
      phone = (mg.guestCellPhone || mg.guestPhone || '').toString().replace(/[^0-9]/g, '');
      if (!email) email = mg.guestEmail || '';
      address1 = mg.guestAddress1 || mg.guestAddress || '';
      city = mg.guestCity || '';
      state = mg.guestState || '';
      zip = mg.guestZip || '';
      country = mg.guestCountry || '';
    }
  }

  // Fallbacks for mock / legacy payloads that carry phone/email at the top level.
  if (!phone && data.phone) phone = String(data.phone).replace(/[^0-9]/g, '');
  if (!email && data.email) email = data.email;

  return {
    phone,
    email,
    address: [address1, city, state, zip].filter(Boolean).join(', '),
    city, state, zip, country
  };
}

// Identity verification for Kiosk (Search by Last Name or Reservation ID)
app.post('/api/kiosk/identify', async (req, res) => {
  const { query, mode } = req.body;
  if (!query) return res.status(400).json({ success: false });

  logger.info(`[KIOSK IDENTIFY] Searching for guest: ${query} (Mode: ${mode})`);
  const result = await agent.engine.api.getReservation(query, mode);

  if (result.success && result.data) {
    const contact = extractGuestContact(result.data);
    const reservationId = result.data.reservationID || result.data.reservationId;

    if (contact.phone && contact.phone.length >= 4) {
      const last4 = contact.phone.slice(-4);
      return res.json({
        success: true,
        requiresVerification: true,
        verifyType: 'phone',
        reservationId,
        maskedPhone: `***-***-${last4}`
      });
    }
    if (contact.email) {
      const parts = contact.email.split('@');
      const maskedEmail = parts.length === 2 ? `${parts[0].charAt(0)}***@${parts[1]}` : 'your email address';
      return res.json({
        success: true,
        requiresVerification: true,
        verifyType: 'email',
        reservationId,
        maskedEmail
      });
    }
    return res.json({ success: false, message: "We found your reservation, but it lacks contact details for secure verification. Please see the front desk." });
  }

  res.json({ success: false, message: result.message || "Could not locate a reservation with that information." });
});

app.post('/api/kiosk/verify', async (req, res) => {
  const { reservationId, pin } = req.body;
  if (!reservationId || !pin) return res.status(400).json({ success: false });

  logger.info(`[KIOSK VERIFY] Verifying Security PIN for reservation: ${reservationId}`);
  const result = await agent.engine.api.getReservationById(reservationId);

  if (result.success && result.data) {
    const contact = extractGuestContact(result.data);
    const guestData = {
      email: contact.email.toLowerCase(),
      phone: contact.phone,
      address: [contact.address1, contact.city, contact.state, contact.zip].filter(Boolean).join(', '),
      city: contact.city,
      state: contact.state,
      zip: contact.zip
    };

    if (contact.phone && contact.phone.length >= 4) {
      if (contact.phone.slice(-4) === pin.replace(/\s/g, '')) {
        return res.json({ success: true, reservationId, guestData });
      }
    } else if (contact.email) {
      if (contact.email.toLowerCase() === pin.toLowerCase().trim()) {
        return res.json({ success: true, reservationId, guestData });
      }
    }
  }

  res.json({ success: false, message: "Verification failed. Incorrect Security PIN or Email." });
});

// Kiosk config (property-specific values the client needs, like propertyID for the Guest Portal URL)
app.get('/api/kiosk/config', (req, res) => {
  res.json({
    propertyID: process.env.CLOUDBEDS_PROPERTY_ID || null,
    guestPortalBase: process.env.CLOUDBEDS_GUEST_PORTAL_BASE || 'https://hotels.cloudbeds.com/guest_portal'
  });
});

// CRON SCHEDULER
// =====================================

// 1. Room Assignment Optimization at 2:00 AM
cron.schedule('0 2 * * *', async () => {
  logger.info('[CRON] 2:00 AM - Triggering Room Assignment Optimization task...');
  if (agent.isRunning) {
    await agent.processIncomingMessage({
       source: 'cron',
       text: 'It is 2:00 AM. Please run the nightly room assignment optimization algorithm. Look for unassigned rooms and optimize reservations.'
    });
  } else {
    logger.warn('[CRON] Agent is not running. Skipping scheduled room assignment.');
  }
});

// 2. Automated Daily Report with Google Sheets Data Warehouse (4:00 AM)
cron.schedule('0 4 * * *', async () => {
  logger.info('[CRON] 4:00 AM - Triggering Automated Night Audit Data Warehouse routine...');
  if (agent.isRunning) {
    const reportEngine = new NightAuditReport(agent.engine.api);
    await reportEngine.runDailyAudit();
  } else {
    logger.warn('[CRON] Agent is not running. Skipping reporting pipeline.');
  }
});

// 3. Automated Housekeeping Clustering & Scheduling (6:00 AM)
cron.schedule('0 6 * * *', async () => {
  logger.info('[CRON] 6:00 AM - Triggering Housekeeping Load-Balancer algorithm...');
  if (agent.isRunning) {
    const housekeepingEngine = new HousekeepingAssigner(agent.engine.api);
    await housekeepingEngine.run6AMAssignment();
  } else {
    logger.warn('[CRON] Agent is not running. Skipping Housekeeping pipeline.');
  }
});

// BOOTSTRAP
// =====================================

/**
 * Validate env vars at boot so missing config surfaces immediately instead of
 * failing silently at 2 AM / 4 AM / 6 AM when the crons fire.
 */
function validateStartupConfig() {
  const groups = [
    {
      name: 'Gemini (Autonomy Engine)',
      required: ['GEMINI_API_KEY'],
      optional: ['GEMINI_MODEL']
    },
    {
      name: 'Cloudbeds API',
      required: ['CLOUDBEDS_API_KEY', 'CLOUDBEDS_PROPERTY_ID'],
      optional: ['CLOUDBEDS_HOST']
    },
    {
      name: 'Google Sheets (Night Audit + Housekeeping)',
      required: ['GOOGLE_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY'],
      optional: ['GOOGLE_SHEET_TAB_TRANSACTIONS', 'GOOGLE_SHEET_TAB_WEEKLY_SCHEDULE', 'GOOGLE_SHEET_TAB_HOUSEKEEPING_LOG']
    },
    {
      name: 'SMTP (Night Audit email dispatch)',
      required: ['SMTP_USER', 'SMTP_PASS'],
      optional: ['REPORT_EMAILS']
    }
  ];

  let allOk = true;
  for (const g of groups) {
    const missing = g.required.filter(k => !process.env[k]);
    if (missing.length === 0) {
      logger.info(`[CONFIG] ${g.name}: OK`);
    } else {
      allOk = false;
      logger.warn(`[CONFIG] ${g.name}: MISSING ${missing.join(', ')} — dependent tasks will fail or fall back.`);
    }
  }

  // Sanity-check the Google private key shape — a common failure mode is the
  // escaped-newlines variant not being unescaped.
  if (process.env.GOOGLE_PRIVATE_KEY && !process.env.GOOGLE_PRIVATE_KEY.includes('BEGIN PRIVATE KEY')) {
    logger.warn('[CONFIG] GOOGLE_PRIVATE_KEY is set but does not look like a PEM key. Expected BEGIN PRIVATE KEY header.');
  }

  return allOk;
}

async function boot() {
  logger.info(`Starting Hotel Automation Platform Server on port ${port}...`);
  validateStartupConfig();
  server.listen(port, () => {
    logger.info(`Dashboard accessible locally at http://localhost:${port}`);
  });

  const gracefulShutdown = async () => {
    logger.info('Shutting down server and agent...');
    await agent.stop();
    process.exit(0);
  };
  
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  // Start the background scraping sentinel
  try {
    await agent.start();
  } catch (error) {
    logger.error('Fatal agent error:', error.message);
  }
}

boot();
