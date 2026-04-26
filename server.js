const express = require('express');
const http = require('http');
const path = require('path');
const cron = require('node-cron');
const { Server } = require('socket.io');
const { logger } = require('./src/logger');
const { printPdfBuffer } = require('./src/printHandler');
const { CloudbedsAgent } = require('./src/agent');
const { NightAuditReport } = require('./src/nightAuditReport');
const { HousekeepingAssigner } = require('./src/housekeepingAssigner');
const { MessagingClient } = require('./src/messaging');

require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const port = process.env.PORT || 3000;

// Setup static files and APIs
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '5mb' })); // large enough for signature PNGs from kiosk
app.use(express.urlencoded({ extended: true })); // Required to parse incoming Twilio form payloads

// Add CORS headers so the Chrome Extension can make requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// Serve the Kiosk UI on the root directory
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'kiosk.html'));
});

// Initialize the master Autonomy Engine
const agent = new CloudbedsAgent();
const messaging = new MessagingClient();

// WebSockets (Tablet & Chat Connectivity)
io.on('connection', (socket) => {
  logger.info(`[WEBSOCKET] Client Connected: ${socket.id}`);
  
  socket.on('chat_message', async (data) => {
      const room = data.room || 'Unknown Room';
      const text = data.text;
      if (!text) return;
      
      logger.info(`[CHAT] Incoming message from Room ${room}: ${text}`);
      
      if (!agent.isRunning) {
          socket.emit('chat_response', { text: "The front desk is currently unavailable. Please call the main line." });
          return;
      }
      
      try {
          // Look up reservation by room
          let context = `Guest is messaging from Room ${room}. Treat as a general inquiry. `;
          
          // Execute autonomy engine logic
          const promptText = `${context}The guest in Room ${room} just sent a web chat message: "${text}". Reply warmly and directly to their question. Your reply will be sent immediately back to their device chat screen.`;
          
          const result = await agent.processIncomingMessage({
              source: 'webchat',
              sessionKey: `room:${room}`,
              text: promptText
          });
          
          if (result && result.agent_response) {
              socket.emit('chat_response', { text: result.agent_response });
              logger.action('Web Chat', `Replied to Room ${room}: ${text.substring(0, 40)}`, 'ok');
          }
      } catch (err) {
          logger.error(`[CHAT] Error processing message: ${err.message}`);
          socket.emit('chat_response', { text: "Sorry, we encountered a system error processing your message. Please call the front desk." });
      }
  });
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
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
     
     // Write to Sheets in background — don't block PDF delivery
     reportEngine.appendTransactionsToSheets(result.tdFilter, reportEngine.toYMD(reportDt))
       .catch(e => logger.error(`[EMPLOYEE] Background Sheets write failed: ${e.message}`));

     res.setHeader('Content-Length', result.pdfBuffer.length);
     res.setHeader('Content-Type', 'application/pdf');
     res.setHeader('Content-Disposition', 'inline; filename="GatewayPark_DailyReport.pdf"');
     res.send(result.pdfBuffer);
  } catch (err) {
     logger.error(`[EMPLOYEE] Manual report error: ${err.message}`);
     res.status(500).json({ error: err.message });
  }
});

// 7-/14-day forward forecast (per-day OCC %, ADR, RevPAR, Room Revenue).
app.get('/api/employee/forecast', checkLocalNetwork, async (req, res) => {
  if (!agent.isRunning) return res.status(503).json({ error: "System is offline" });
  const days = Math.min(60, Math.max(1, parseInt(req.query.days || 14, 10)));
  try {
    const result = await agent.engine.api.getForecast(days);
    res.json(result);
  } catch (err) {
    logger.error(`[EMPLOYEE] Forecast failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Business on the books for a calendar month (default = current month).
app.get('/api/employee/business-on-books', checkLocalNetwork, async (req, res) => {
  if (!agent.isRunning) return res.status(503).json({ error: "System is offline" });
  const offset = parseInt(req.query.monthOffset || 0, 10);
  try {
    const result = await agent.engine.api.getBusinessOnBooks(offset);
    res.json(result);
  } catch (err) {
    logger.error(`[EMPLOYEE] BoB failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// WEBHOOK ADMIN ENDPOINTS
// (staff-only, gated by checkLocalNetwork)
// ==========================================

// List the webhook subscriptions Cloudbeds currently has on file for this property.
app.get('/api/admin/webhooks', checkLocalNetwork, async (req, res) => {
  try {
    const result = await agent.engine.api.getWebhooks();
    res.json(result);
  } catch (err) {
    logger.error(`[ADMIN] List webhooks failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Register the full event set against an endpoint URL. Idempotent on Cloudbeds'
// side (duplicate (object,action,url) tuples return the existing subscription).
// endpointUrl can be passed in the body, or falls back to the WEBHOOK_PUBLIC_URL
// env var. The handler always appends `/api/webhooks/cloudbeds` if the URL
// supplied doesn't already end with that path — so the staff just paste their
// tunnel hostname.
app.post('/api/admin/webhooks/register', checkLocalNetwork, async (req, res) => {
  try {
    let base = (req.body && req.body.endpointUrl) || process.env.WEBHOOK_PUBLIC_URL;
    if (!base) {
      return res.status(400).json({
        success: false,
        error: 'endpointUrl is required (pass in body or set WEBHOOK_PUBLIC_URL in .env)'
      });
    }
    base = base.replace(/\/+$/, ''); // strip trailing slashes
    const endpointUrl = base.endsWith('/api/webhooks/cloudbeds')
      ? base
      : `${base}/api/webhooks/cloudbeds`;

    logger.info(`[ADMIN] Registering all Cloudbeds webhooks against ${endpointUrl}...`);
    const results = await agent.engine.api.registerAllWebhooks(endpointUrl);
    logger.action('Webhooks', `Registered ${results.length} Cloudbeds webhook subscriptions to ${endpointUrl}`, 'ok');
    res.json({ success: true, endpointUrl, results });
  } catch (err) {
    logger.error(`[ADMIN] Webhook registration failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete one subscription by its Cloudbeds subscriptionID.
app.delete('/api/admin/webhooks/:id', checkLocalNetwork, async (req, res) => {
  try {
    const id = req.params.id;
    const result = await agent.engine.api.deleteWebhook(id);
    if (result.success) {
      logger.action('Webhooks', `Deleted subscription ${id}`, 'ok');
    }
    res.json(result);
  } catch (err) {
    logger.error(`[ADMIN] Webhook delete failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Night Audit Completion Webhook (Event-Driven Alternative to Cron)
app.post('/api/webhooks/night-audit-complete', async (req, res) => {
  const payload = req.body;
  logger.info(`[WEBHOOK] Incoming Night Audit Complete event: ${JSON.stringify(payload)}`);
  
  if (!agent.isRunning) {
    logger.warn('[WEBHOOK] Agent offline, ignoring night audit trigger.');
    return res.status(503).json({ error: "System is offline" });
  }

  res.status(200).send("OK"); // Ack immediately
  
  try {
    logger.info('[EVENT] Night Audit is complete! Triggering reporting and housekeeping pipelines sequentially...');
    const reportEngine = new NightAuditReport(agent.engine.api);
    await reportEngine.runDailyAudit();

    const housekeepingEngine = new HousekeepingAssigner(agent.engine.api);
    await housekeepingEngine.run6AMAssignment();
  } catch (err) {
    logger.error(`[EVENT] Error during post-night-audit pipelines: ${err.message}`);
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
    } else if (event === "reservation/status_changed" && (payload.status === "checked_out" || payload.new_status === "checked_out")) {
      promptText = `Reservation ${reservationID} just checked out natively. Evaluate if an invoice should be emailed by checking the paymentType (skip if Channel Collect Booking). If safe, email the fiscal document. Do not attempt to update the checkout status.`;
    } else {
      promptText = `A generic Cloudbeds system event occurred: ${event} for reservation ${reservationID}. Review if necessary.`;
    }

    await agent.processIncomingMessage({ source: 'cloudbeds', text: promptText });
  } catch (err) {
    logger.error(`Webhook processing error: ${err.message}`);
  }
});

// Primary Webhook Ingress from Twilio (Text Messaging)
app.post('/api/webhooks/sms', async (req, res) => {
  const payload = req.body;
  logger.info(`[WEBHOOK] Incoming SMS Message: ${JSON.stringify(Object.keys(payload || {}))}`);

  // Acknowledge immediately so Twilio doesn't retry.
  res.status(200).send("OK");

  if (!agent.isRunning) return;

  try {
    const guestPhone = payload.guest_phone || payload.phone || payload.from || payload.From || (payload.sms && payload.sms.from);
    const messageText = payload.message || payload.text || payload.body || payload.Body || (payload.sms && payload.sms.body);
    if (!guestPhone || !messageText) {
      logger.warn(`[WEBHOOK] SMS payload missing phone or message. Raw: ${JSON.stringify(payload).substring(0, 300)}`);
      return;
    }
    const digits = String(guestPhone).replace(/[^0-9]/g, '');

    // Look up the guest's most-relevant reservation so the agent has context
    // and doesn't have to guess who the texter is.
    let context = 'No active reservation was found matching this phone number. Treat as a prospective / general guest inquiry. ';
    try {
      const lookup = await agent.engine.api.getReservationsByPhone(digits);
      if (lookup.success && lookup.data && lookup.data.length > 0) {
        const r = lookup.data[0];
        const id = r.reservationID || r.reservationId;
        context = `Reservation context for this guest: reservationID=${id}, guestName=${r.guestName || ''}, status=${r.status || ''}, checkIn=${r.startDate || ''}, checkOut=${r.endDate || ''}. `;
      }
    } catch (e) {
      logger.warn(`[WEBHOOK] Phone->reservation lookup failed (non-fatal): ${e.message}`);
    }

    const promptText = `${context}The guest at ${guestPhone} just texted: "${messageText}". Reply warmly and directly. Your reply will be sent back to them via SMS, so keep it concise and do not include sign-offs like [Hotel Name] placeholders.`;

    const result = await agent.processIncomingMessage({
      source: 'whistle',
      sessionKey: `sms:${digits}`, // 30-min rolling thread memory per phone
      text: promptText
    });

    if (result && result.agent_response) {
      const send = await messaging.send(guestPhone, result.agent_response);
      if (send.success) {
        logger.action('Guest SMS', `Replied to ${guestPhone}: ${messageText.substring(0, 40)}`, 'ok');
      } else {
        logger.action('Guest SMS', `Reply to ${guestPhone} failed: ${send.error}`, 'error');
      }
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
    const promptText = `A guest with last name "${lastName}" is at the kiosk attempting to check out of reservation ${reservationId}. Please process their checkout completely by verifying their balance. If they owe a balance, direct them to the front desk. Otherwise, execute a checkout and communicate success back. Do NOT attempt to process payments.`;
    
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
              guestFirstName: guestUpdates.firstName || undefined,
              guestLastName: guestUpdates.lastName || undefined,
              guestEmail: guestUpdates.email || undefined,
              guestPhone: guestUpdates.phone || undefined,
              ...addressFields
            });
          } else {
            logger.warn(`[KIOSK] Could not resolve guestID for reservation ${reservationId}; skipping putGuest.`);
          }
        }

        if (guestUpdates.signature) {
          await agent.engine.api.postReservationDocument(reservationId, guestUpdates.signature, "Registration_Signature.png");
        }

        if (guestUpdates.hasPet) {
          logger.info(`[KIOSK] Guest indicated they have a pet. Posting $30 Pet Fee to ${reservationId}...`);
          try {
            await agent.engine.api.postCustomItem(reservationId, 30, "Pet Fee (Waiver Signed)", { appItemID: "PET_FEE" });
          } catch (petErr) {
            logger.warn(`[KIOSK] Failed to post Pet Fee for ${reservationId}: ${petErr.message}`);
          }
        }
      } catch (e) {
        logger.warn(`[KIOSK] Non-fatal error during pre-checkin profile sync: ${e.message}`);
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

// Kiosk REST API Endpoint (Print Receipt)
app.post('/api/kiosk/print_receipt', async (req, res) => {
  const { reservationId } = req.body;
  if (!reservationId) return res.status(400).json({ success: false, message: 'reservationId required' });

  logger.info(`[KIOSK] Print Receipt requested for ${reservationId}`);
  try {
    // 1. Get Reservation Details
    const resData = await agent.engine.api.getReservationById(reservationId);
    if (!resData || !resData.data) {
      return res.status(404).json({ success: false, message: "Could not fetch reservation details." });
    }
    
    const r = resData.data;
    
    // 2. Generate PDF
    const { generateFolioPdf } = require('./src/printHandler');
    const pdfBuffer = await generateFolioPdf(reservationId, r);

    // 4. Print it physically
    const printResult = await printPdfBuffer(pdfBuffer, reservationId);
    if (printResult.success) {
      return res.json({ status: 'complete', message: "Receipt sent to printer successfully." });
    } else {
      return res.status(500).json({ success: false, message: `Printer error: ${printResult.error}` });
    }
  } catch (err) {
    logger.error(`[KIOSK] Print receipt failed: ${err.message}`);
    return res.status(500).json({ success: false, message: "System error while printing." });
  }
});

// Extract the main guest's verifiable contact info from a Cloudbeds reservation payload.
function extractGuestContact(data) {
  let phone = '';
  let email = (data.guestEmail || '').toString();
  let address1 = '', city = '', state = '', zip = '', country = '';
  let firstName = '', lastName = '';

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
      firstName = mg.guestFirstName || '';
      lastName = mg.guestLastName || '';
    }
  }

  // Fallbacks for mock / legacy payloads that carry phone/email at the top level.
  if (!phone && data.phone) phone = String(data.phone).replace(/[^0-9]/g, '');
  if (!email && data.email) email = data.email;
  if (!firstName) firstName = data.guestFirstName || data.firstName || '';
  if (!lastName) lastName = data.guestLastName || data.lastName || '';

  return {
    phone,
    email,
    firstName,
    lastName,
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

    // Check if they typed the exact reservation ID to bypass PIN
    if (query.trim().toUpperCase() === reservationId.toUpperCase()) {
      return res.json({
        success: true,
        requiresVerification: false,
        reservationId
      });
    }

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
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email.toLowerCase(),
      phone: contact.phone,
      address: contact.address,
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

// Helper to calculate the hotel's logical business day, factoring in the 2:00 AM rollover.
function getHotelBusinessDate(offsetDays = 0) {
  const d = new Date();
  d.setHours(d.getHours() - 2);
  d.setDate(d.getDate() + offsetDays);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  
  const m = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  const y = parts.find(p => p.type === 'year').value;
  return `${y}-${m}-${day}`;
}

// CRON SCHEDULER
// =====================================

// 1. Room Assignment Optimization at 3:00 AM (After native Night Audit finishes at 2:00 AM)
cron.schedule('0 3 * * *', async () => {
  const todayStr = getHotelBusinessDate(0);
  const tomorrowStr = getHotelBusinessDate(1);
  logger.info(`[CRON] 3:00 AM - Triggering Room Assignment Optimization task for arriving date: ${todayStr}...`);
  if (agent.isRunning) {
    await agent.processIncomingMessage({
       source: 'cron',
       text: `It is 3:00 AM and Night Audit has completed. The new business date is ${todayStr}. Please run the nightly room assignment optimization algorithm. Look for unassigned rooms between ${todayStr} and ${tomorrowStr} and assign them to incoming reservations for today (${todayStr}).`
    });
  } else {
    logger.warn('[CRON] Agent is not running. Skipping scheduled room assignment.');
  }
}, { timezone: "America/Chicago" });

// 2. Night Audit at 4:00 AM
cron.schedule('0 4 * * *', async () => {
  logger.info('[CRON] 4:00 AM - Triggering Night Audit Generation...');
  if (agent.isRunning) {
    try {
      const reportEngine = new NightAuditReport(agent.engine.api);
      await reportEngine.runDailyAudit();
    } catch (e) {
      logger.error(`[CRON] Night audit failed: ${e.message}`);
    }
  } else {
    logger.warn('[CRON] Agent is not running. Skipping scheduled night audit.');
  }
}, { timezone: "America/Chicago" });

// 3. Housekeeping Assignment at 6:00 AM
cron.schedule('0 6 * * *', async () => {
  logger.info('[CRON] 6:00 AM - Triggering Housekeeping Assignment task...');
  if (agent.isRunning) {
    try {
      const housekeepingEngine = new HousekeepingAssigner(agent.engine.api);
      await housekeepingEngine.run6AMAssignment();
    } catch (e) {
      logger.error(`[CRON] Housekeeping failed: ${e.message}`);
    }
  } else {
    logger.warn('[CRON] Agent is not running. Skipping scheduled housekeeping assignment.');
  }
}, { timezone: "America/Chicago" });

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
    },
    {
      name: 'Messaging (Guest auto-replies)',
      // MESSAGING_PROVIDER=none is a valid dev choice — don't flag it as missing.
      required: [],
      optional: ['MESSAGING_PROVIDER', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'WHISTLE_API_KEY', 'WHISTLE_API_BASE']
    },
    {
      name: 'Cloudbeds Webhook Subscriptions',
      // Optional but recommended — without it, /api/admin/webhooks/register
      // requires the staff to type the public URL each time.
      required: [],
      optional: ['WEBHOOK_PUBLIC_URL']
    }
  ];

  const messagingProvider = (process.env.MESSAGING_PROVIDER || 'none').toLowerCase();
  if (messagingProvider === 'twilio') {
    const missing = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'].filter(k => !process.env[k]);
    if (missing.length) logger.warn(`[CONFIG] MESSAGING_PROVIDER=twilio but missing: ${missing.join(', ')} — outbound texts will fail.`);
    else logger.info('[CONFIG] Messaging provider: Twilio (OK).');
  } else if (messagingProvider === 'whistle') {
    if (!process.env.WHISTLE_API_KEY) logger.warn('[CONFIG] MESSAGING_PROVIDER=whistle but WHISTLE_API_KEY is missing — outbound texts will fail.');
    else logger.info('[CONFIG] Messaging provider: Whistle (OK).');
  } else {
    logger.info('[CONFIG] Messaging provider: none (dry-run — agent replies logged but not sent).');
  }

  if (process.env.WEBHOOK_PUBLIC_URL) {
    logger.info(`[CONFIG] Cloudbeds webhook public URL: ${process.env.WEBHOOK_PUBLIC_URL}`);
  } else {
    logger.warn('[CONFIG] WEBHOOK_PUBLIC_URL not set — POST /api/admin/webhooks/register will require an explicit endpointUrl in the request body.');
  }

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
