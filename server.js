// Must come before ANY other require: a few of the modules below
// (notably modelRouter.js, which instantiates a singleton at module
// load time) read process.env.TEXT_MODEL / GEMINI_API_KEY / etc.
// during their own initialization. If dotenv runs after those requires
// the env vars are still undefined and the singletons lock in
// hard-coded defaults — silently ignoring whatever's in .env.
require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const { Server } = require('socket.io');
const { logger } = require('./src/logger');
const { AlertHub } = require('./src/alertHub');
const { startWarnDigest } = require('./src/warnDigest');
const { printPdfBuffer } = require('./src/printHandler');
const { CloudbedsAgent } = require('./src/agent');
const { NightAuditReport } = require('./src/nightAuditReport');
const { HousekeepingAssigner } = require('./src/housekeepingAssigner');
const { runRoomAssignment } = require('./src/roomAssignment');
const { MessagingClient } = require('./src/messaging');
const { WhistleListener } = require('./src/whistleListener');
const { reservationCache } = require('./src/reservationCache');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const port = process.env.PORT || 3000;

// Setup static files and APIs
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // HTML shells must never be cached: long-running kiosk browsers
    // would otherwise miss UI changes shipped mid-day, leaving stale JS
    // that mishandles new server response shapes.
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));
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
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'kiosk.html'));
});

// Initialize the master Autonomy Engine
const agent = new CloudbedsAgent();
const messaging = new MessagingClient();
const alertHub = new AlertHub(io);
agent.engine.alertHub = alertHub; // exposed so the alertFrontDesk tool can publish

// WebSockets (Tablet & Chat Connectivity)
io.on('connection', (socket) => {
  logger.info(`[WEBSOCKET] Client Connected: ${socket.id}`);

  // /alerts page joins this room so it gets alert:new and alert:ack events.
  socket.on('alerts:subscribe', () => {
    socket.join('alerts');
  });

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

// LAN-accessible alert console. Open in any browser on the local network
// (front desk PC, back-room tablet, manager office). Plays an audible
// chime/klaxon on alertFrontDesk events and lets staff acknowledge them.
app.get('/alerts', checkLocalNetwork, (req, res) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'alerts.html'));
});

app.get('/api/alerts', checkLocalNetwork, (req, res) => {
  res.json({ success: true, alerts: alertHub.listActive() });
});

app.post('/api/alerts/:id/ack', checkLocalNetwork, (req, res) => {
  const ok = alertHub.ack(req.params.id);
  res.json({ success: ok });
});

// Public liveness probe. Safe to expose through the Cloudflare tunnel —
// returns no secrets, just enough state to confirm the process is up and
// which messaging path is actually active. Curl this from outside the LAN
// to verify the tunnel is routing to us.
app.get('/api/health', (req, res) => {
  const provider = (process.env.MESSAGING_PROVIDER || 'none').toLowerCase();
  res.json({
    status: agent.isRunning ? 'running' : 'stopped',
    uptime: process.uptime(),
    messagingProvider: provider,
    messagingDryRun: provider === 'none',
    whistleRpaEnabled: process.env.ENABLE_WHISTLE_RPA === 'true'
  });
});

// Employee Portal API Routes
app.get('/api/employee/status', checkLocalNetwork, (req, res) => {
    res.json({
      status: agent.isRunning ? 'running' : 'stopped',
      uptime: process.uptime(),
      feed: logger.getFeed()
    });
  });

app.get('/api/employee/knowledge', checkLocalNetwork, (req, res) => {
    try {
        const data = fs.readFileSync(path.join(__dirname, 'data', 'knowledge_base.json'), 'utf8');
        res.json({ success: true, data: JSON.parse(data) });
    } catch (e) {
        if (e.code === 'ENOENT') {
            res.json({ success: true, data: [] });
        } else {
            res.status(500).json({ success: false, error: e.message });
        }
    }
});

app.post('/api/employee/knowledge', checkLocalNetwork, express.json(), (req, res) => {
    try {
        if (!Array.isArray(req.body)) throw new Error('Expected JSON array');
        fs.writeFileSync(path.join(__dirname, 'data', 'knowledge_base.json'), JSON.stringify(req.body, null, 2));
        logger.info('[ADMIN] Knowledge Base updated via Employee Hub');
        
        // Let the engine know the knowledge base has changed if we want it to hot-reload,
        // though it reads it dynamically in getSystemInstruction anyway.
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
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

// GET group profiles for the outstanding group invoice tool
app.get('/api/employee/groups', checkLocalNetwork, async (req, res) => {
  if (!agent.isRunning) return res.status(503).json({ error: "System is offline" });
  try {
    const result = await agent.engine.api.getGroups();
    res.json(result);
  } catch (err) {
    logger.error(`[EMPLOYEE] getGroups failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET unpaid line items for a specific group
app.get('/api/employee/groups/:id/outstanding-invoice', checkLocalNetwork, async (req, res) => {
  if (!agent.isRunning) return res.status(503).json({ error: "System is offline" });
  try {
    const groupId = req.params.id; // The groupCode, kept for logging
    const numId = req.query.numId; // The actual numeric ID from the Cloudbeds API contacts
    if (!numId) {
        return res.status(400).json({ success: false, error: "Missing numeric group ID" });
    }
    
    const transactionsRes = await agent.engine.api.getUnpaidGroupTransactions(numId);
    if (!transactionsRes.success) {
       return res.status(500).json({ success: false, error: "Failed to fetch transactions" });
    }
    
    // An invoice logic:
    // A transaction is a "charge" if it's a debit (which is positive or negative depending on the account, but
    // usually in FolioTransactionResponse amount > 0 is debit if it's a charge, or negative. 
    // Cloudbeds returns transactionType: "payment", "product", "addon", "rate", "tax", "fee".
    // Payments are usually negative or have transactionType == "payment".
    
    const transactions = transactionsRes.data;
    const charges = [];
    const payments = [];
    
    transactions.forEach(t => {
      // Sometimes amount is negative for payments and positive for charges.
      if (t.transactionType === 'payment' || t.transactionType === 'accountsReceivable' || (t.amount < 0 && t.transactionType !== 'adjustment')) {
         payments.push(t);
      } else {
         charges.push(t);
      }
    });

    let totalCharges = charges.reduce((sum, c) => sum + parseFloat(c.amount || 0), 0);
    let totalPayments = payments.reduce((sum, p) => sum + Math.abs(parseFloat(p.amount || 0)), 0);
    
    // We want to calculate the remaining balance. The raw logic:
    let remainingPayments = totalPayments;
    
    // Filter to unpaid or partially paid charges.
    // Cloudbeds doesn't strictly link every payment to every charge perfectly in all properties unless allocations are strictly enforced.
    // So we'll just return all charges and the total balance.
    
    const balance = totalCharges - totalPayments;
    
    res.json({
      success: true,
      data: {
         charges,
         payments,
         totalCharges: totalCharges.toFixed(2),
         totalPayments: totalPayments.toFixed(2),
         balance: balance.toFixed(2)
      }
    });
  } catch (err) {
    logger.error(`[EMPLOYEE] getOutstandingInvoice failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Diagnostic endpoint for the night audit pipeline. Returns the raw Cloudbeds
// shapes that feed the report so we can confirm field names without guessing:
//   - one sample reservation from /getReservations (today + 14 days)
//   - one sample transaction from /accounting/transactions (today)
//   - the /getRooms response shape used by _resolveTotalRooms
// Local-network-gated (same as the other employee endpoints) and intended for
// one-off debugging; remove or move behind an admin flag once the field names
// are nailed down.
app.get('/api/employee/debug/report-shape', checkLocalNetwork, async (req, res) => {
  if (!agent.isRunning) return res.status(503).json({ error: "System is offline" });
  try {
    const today = new Date().toISOString().slice(0, 10);
    const future = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    const [resList, txnList, roomsRaw] = await Promise.all([
      agent.engine.api.getReservations(today, future),
      agent.engine.api.getTransactions(today, today),
      agent.engine.api._getClient().get('/getRooms', {
        params: agent.engine.api.propertyID ? { propertyID: agent.engine.api.propertyID } : {}
      }).then(r => r.data).catch(e => ({ error: e.message }))
    ]);
    const sampleReservation = (resList.data || [])[0] || null;
    const sampleTransaction = (txnList.data || [])[0] || null;

    // Also fetch the detail (singular) endpoint for the same reservation —
    // /getReservations returns "lite" data on most accounts; /getReservation
    // is where dailyRates / roomTotal live. Confirms the detail fallback in
    // _collectStaysInRange has fields to work with.
    let sampleReservationDetail = null;
    let detailKeys = [];
    if (sampleReservation && sampleReservation.reservationID) {
      const detailRes = await agent.engine.api.getReservationById(sampleReservation.reservationID).catch(() => null);
      if (detailRes && detailRes.success && detailRes.data) {
        sampleReservationDetail = detailRes.data;
        detailKeys = Object.keys(detailRes.data);
      }
    }

    res.json({
      sampleReservation,
      reservationKeys: sampleReservation ? Object.keys(sampleReservation) : [],
      sampleReservationDetail,
      detailKeys,
      sampleTransaction,
      transactionKeys: sampleTransaction ? Object.keys(sampleTransaction) : [],
      getRoomsRaw: roomsRaw,
      hint: "detailKeys come from /getReservation (singular); reservationKeys come from /getReservations (lite). The detail endpoint should expose dailyRates / roomTotal which the lite version omits — _collectStaysInRange now falls through to detail when balance/subtotal yield zero. Set FORECAST_REVENUE_FIELD=<field> in .env to override."
    });
  } catch (err) {
    logger.error(`[EMPLOYEE] debug/report-shape failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Per-day room-night audit. Pulls the same transactions the night-audit
// pipeline sees (live API + Google Sheets), then bins them by category so
// we can pinpoint exactly where the MTD room-night undercount is coming
// from on a single date. Compare the output against Cloudbeds' native
// "Total Rooms Sold" for that day; the gap should fall into one of the
// buckets below (sourceId-empty rate rows, comp/block/zero-rate rows,
// or sheet rows missing internalTransactionCode).
//
// Usage:
//   GET /api/employee/debug/night-count?date=2026-04-18
app.get('/api/employee/debug/night-count', checkLocalNetwork, async (req, res) => {
  if (!agent.isRunning) return res.status(503).json({ error: "System is offline" });
  const date = (req.query.date || '').match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.date : null;
  if (!date) return res.status(400).json({ error: "Pass ?date=YYYY-MM-DD" });

  try {
    const reportEngine = new NightAuditReport(agent.engine.api);
    const [liveTxns, sheetTxns] = await Promise.all([
      agent.engine.api.getTransactions(date, date),
      reportEngine.getTransactionsFromSheets(date, date)
    ]);

    const breakdown = (txns) => {
      const stats = {
        total: txns.length,
        active: 0,
        voided: 0,
        roomRate: 0,
        roomRateZeroAmount: 0,
        roomRateEmptySourceId: 0,
        roomRateAdjustments: 0,
        items: 0,
        payments: 0,
        other: 0,
        uniqueRoomNights: 0,
        sampleEmptySourceIdRoomRate: null,
        sampleAdjustment: null,
        sampleZeroRate: null
      };
      const rooms = new Set();

      for (const t of txns) {
        if (t.transactionVoid === true || t.transactionVoid === '1' || t.transactionVoid === 'Yes') {
          stats.voided++;
          continue;
        }
        stats.active++;
        const amt = parseFloat(t.transactionAmount || 0);
        const code = t.internalTransactionCode || '';
        const desc = t.transactionCodeDescription || '';
        const rvType = t.roomRevenueType || '';
        const type = t.transactionType || '';

        const isRateAdj = /^1\d*A$/.test(code) ||
          (desc === 'Room Rate' && amt < 0 && rvType !== 'Room Rate') ||
          (desc === 'Rate - Adjustment') ||
          (desc === 'Room Rate - Adjustment');

        if (rvType === 'Room Rate') {
          stats.roomRate++;
          if (amt === 0) {
            stats.roomRateZeroAmount++;
            if (!stats.sampleZeroRate) stats.sampleZeroRate = { code, desc, roomNumber: t.roomNumber, reservationID: t.reservationID };
          }
          if (!t.roomNumber) {
            stats.roomRateEmptySourceId++;
            if (!stats.sampleEmptySourceIdRoomRate) stats.sampleEmptySourceIdRoomRate = { code, desc, amount: amt, reservationID: t.reservationID };
          } else {
            rooms.add(`${t.transactionDate}_${t.roomNumber}`);
          }
        } else if (isRateAdj) {
          stats.roomRateAdjustments++;
          if (!stats.sampleAdjustment) stats.sampleAdjustment = { code, desc, amount: amt };
        } else if (['Items & Services', 'Add-On'].includes(type)) {
          stats.items++;
        } else if (type === 'Payment') {
          stats.payments++;
        } else {
          stats.other++;
        }
      }
      stats.uniqueRoomNights = rooms.size;
      return stats;
    };

    res.json({
      date,
      live: breakdown(liveTxns.data || []),
      sheet: breakdown(sheetTxns),
      hint: "uniqueRoomNights is what computeFromTransactions feeds into MTD/YTD math. Compare against Cloudbeds 'Total Rooms Sold' for this date. roomRateEmptySourceId / roomRateZeroAmount / sample* fields point at which transactions slip through. If sheet.roomRate < live.roomRate, the historical backfill missed rows; re-run scripts/backfillHistory.js --from <this date> --to <this date>."
    });
  } catch (err) {
    logger.error(`[EMPLOYEE] debug/night-count failed: ${err.message}`);
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

  // Update local reservation cache in the background
  if (reservationID !== 'unknown' && event.startsWith('reservation/')) {
    reservationCache.updateReservation(reservationID, agent.engine.api).catch(e => {
      logger.error(`[WEBHOOK] Cache update failed for ${reservationID}: ${e.message}`);
    });
  }

  // Informational events that don't require agent reasoning. The cache
  // update above (when applicable) is the only side effect we need.
  // Without this gate, every housekeeping room_condition_changed event
  // (fired whenever a room status flips — clean / dirty / occupied /
  // vacant) was prompting the agent to run a full arrivals audit, which
  // burned getReservations API calls on every housekeeper action.
  const NO_AGENT_EVENTS = new Set([
    'housekeeping/room_condition_changed',
    'guest/created',
    'guest/details_changed',
    'reservation/accommodation_changed',
    'reservation/accommodation_status_changed'
  ]);
  if (NO_AGENT_EVENTS.has(event)) {
    return;
  }

  try {
    let promptText = "";

    if (event === "reservation/created") {
      const { getHotelBusinessDate } = require('./src/utils');
      const todayStr = getHotelBusinessDate(0);
      promptText = `A new reservation (ID: ${reservationID}) was just created on Cloudbeds. Look it up via 'getReservation' and surface a SHORT note for the staff log noting the guest name, dates, room type, and any flags worth a human glance. If their check-in date is TODAY (${todayStr}), you MUST execute the room assignment logic: use 'getUnassignedRooms' to find availability and 'assignRoom' to lock it in. Do NOT call 'postFolioAdjustment' or any other money-moving tool.`;
    } else if (event === "reservation/dates_changed") {
      promptText = `The dates for reservation ${reservationID} just changed. Surface a short note for the staff log with the new dates and any visible balance impact. Do NOT post payments or fee adjustments — date-change billing is reconciled at the desk or via night audit.`;
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
    const sessionKey = `sms:${digits}`;
    
    // LOOP PREVENTION: Ignore messages from the AI or Hotel Staff
    const sender = String(payload.sender || payload.from || payload.From || payload.sender_name || '').toLowerCase();
    const isOutbound = payload.direction === 'outbound' || payload.direction === 'out' || payload.is_outbound || payload.isOutbound;
    const isSystemOrStaff = sender.includes('frontdesk@') || sender.includes('ai') || sender.includes('system') || sender.includes('gateway park');
    
    // Fallback: If the RPA scraper dumped the sender name into the message text itself
    const msgLower = String(messageText).toLowerCase().trim();
    const isTextFromStaff = msgLower.startsWith('ai -') || msgLower.startsWith('frontdesk@') || msgLower.startsWith('system -');

    if (isOutbound || isSystemOrStaff || isTextFromStaff) {
      logger.info(`[WEBHOOK] Outbound/staff message detected. Recording context for session ${sessionKey} to prevent AI loop.`);
      if (agent && agent.engine && agent.engine.markStaffIntervention) {
        agent.engine.markStaffIntervention(sessionKey, messageText);
      }
      return;
    }

    // GUEST MESSAGE HANDLING
    // Delay 30 seconds to allow a human staff member to jump in.
    logger.info(`[WEBHOOK] Guest message received. Waiting 30s before AI response...`);
    
    setTimeout(async () => {
      try {
        // Check if a human staff member intervened within the last 5 minutes
        if (agent && agent.engine && agent.engine.sessions.has(sessionKey)) {
          const s = agent.engine.sessions.get(sessionKey);
          if (s.staffIntervenedAt && (Date.now() - s.staffIntervenedAt < 5 * 60 * 1000)) {
            logger.info(`[WEBHOOK] Human staff intervened recently. Canceling AI response for ${sessionKey}.`);
            return;
          }
        }

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
          sessionKey, // 30-min rolling thread memory per phone
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
        logger.error(`Whistle Webhook delayed processing error: ${err.message}`);
      }
    }, 30000);

  } catch (err) {
    logger.error(`Whistle Webhook synchronous processing error: ${err.message}`);
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
    const promptText = `A guest with last name "${lastName}" is at the kiosk attempting to check out of reservation ${reservationId}. Process their checkout completely by verifying their balance. If they owe a balance, direct them to the front desk and STOP. Otherwise: (1) execute the checkout, then (2) IMMEDIATELY call evaluateAndEmailInvoice with reservationId="${reservationId}" — do not ask the guest whether they want a receipt, always email it. Then communicate success back in one short sentence (e.g. "You're checked out — a receipt has been emailed to you."). Do NOT attempt to process payments.`;
    
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

    const isCollect = await agent.engine.api.isChannelCollect(reservationId);
    const paymentInstruction = isCollect 
      ? "This is a Channel Collect booking. Do NOT use chargePhysicalTerminal. If there is an outstanding balance, it means the virtual card on file failed to auto-charge. In this case, DO NOT check them in. Instead, escalate to the front desk so they can charge the card on file, and tell the guest the front desk will assist them."
      : "collect any outstanding balance via chargePhysicalTerminal on the kiosk terminal,";

    const promptText = `A guest with last name "${lastName}" is at the kiosk attempting to physically check in to reservation ${reservationId} using terminal ${terminalName}. Please process their check-in completely: fetch the reservation, ${paymentInstruction} then call checkInReservation to transition Cloudbeds to checked_in, and communicate success back. If any step fails, surface the exact reason and ask the guest to see the front desk.`;

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
  const { reservationId, kioskId, alphaId } = req.body;
  
  if (!reservationId) {
    return res.status(400).json({ success: false, error: 'reservationId is required' });
  }
  
  logger.info(`[KIOSK PUSH] Received Chrome Extension push for Reservation: ${reservationId} (Alpha: ${alphaId || 'None'}) targeting Kiosk ${kioskId || 'All'}. Pinging tablet via WebSockets.`);
  
  // Emits the Cloudbeds push event directly to the tablet's browser
  io.emit('pushToTablet', { reservationId, kioskId, alphaId });
  
  res.json({ success: true, message: `Successfully pushed reservation ${reservationId} to tablet.` });
});

// Kiosk REST API Endpoint (Print Receipt)
app.post('/api/kiosk/print_receipt', async (req, res) => {
  const { reservationId } = req.body;
  if (!reservationId) return res.status(400).json({ success: false, message: 'reservationId required' });

  logger.info(`[KIOSK] Print Receipt requested for ${reservationId}`);
  try {
    const isCollect = await agent.engine.api.isChannelCollect(reservationId);
    if (isCollect) {
      logger.warn(`[KIOSK] Aborting physical print receipt for ${reservationId} due to Channel Collect policy.`);
      return res.status(403).json({ success: false, message: "Receipts for this booking must be obtained directly from your booking provider." });
    }

    // 1. Get Reservation Details
    const resData = await agent.engine.api.getReservationById(reservationId);
    if (!resData || !resData.data) {
      return res.status(404).json({ success: false, message: "Could not fetch reservation details." });
    }

    const r = resData.data;

    // 2. Pull payment transactions so the printed receipt can itemize each
    //    line (card brand + last 4, payment date) instead of falling back to
    //    the "No payments recorded." block. Same pattern the email path
    //    uses in autonomyEngine._evaluateAndEmailInvoice.
    let transactions = [];
    try {
      const start = r.startDate || new Date(Date.now() - 60 * 86400000).toISOString().split('T')[0];
      const end = new Date().toISOString().split('T')[0];
      const earliest = new Date(new Date(start).getTime() - 60 * 86400000).toISOString().split('T')[0];
      const txRes = await agent.engine.api.getTransactions(earliest, end);
      if (txRes && txRes.success && Array.isArray(txRes.data)) {
        transactions = txRes.data.filter(t => t && (t.sourceId === reservationId || t.reservationID === reservationId));
      }
    } catch (txErr) {
      logger.warn(`[KIOSK] Could not fetch transactions for printed receipt: ${txErr.message}`);
    }

    // 3. Generate PDF
    const { generateFolioPdf } = require('./src/printHandler');
    const pdfBuffer = await generateFolioPdf(reservationId, r, transactions);

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
      phone = (mg.guestPhone || mg.guestCellPhone || '').toString().replace(/[^0-9]/g, '');
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

// Build a compact, kiosk-display-friendly summary of a reservation. The chooser
// UI needs the room name, dates, named guest, and balance — nothing else. Keeps
// the wire payload small even for groups of 17 sub-reservations.
function summarizeReservationForKiosk(r) {
  if (!r) return null;
  const id = r.reservationID || r.reservationId;
  // Prefer the sub-reservation's own guestList main guest, since multi-room
  // bookings attach individual profiles per sub. Fall back to the top-level
  // guestName which may just be the booker.
  let displayName = r.guestName || '';
  if (r.guestList && typeof r.guestList === 'object') {
    const guests = Object.values(r.guestList);
    const main = guests.find(g => g && g.isMainGuest) || guests[0];
    if (main && (main.guestFirstName || main.guestLastName)) {
      displayName = [main.guestFirstName, main.guestLastName].filter(Boolean).join(' ').trim() || displayName;
    }
  }
  // Room number is buried inside guestList[0].rooms[0].roomName in the
  // Cloudbeds shape. Extract it if present so the chooser can label cards.
  let roomName = '';
  if (r.guestList && typeof r.guestList === 'object') {
    for (const g of Object.values(r.guestList)) {
      if (g && Array.isArray(g.rooms) && g.rooms[0] && g.rooms[0].roomName) {
        roomName = g.rooms[0].roomName;
        break;
      }
    }
  }
  return {
    reservationId: id,
    roomName,
    guestName: displayName,
    startDate: r.startDate,
    endDate: r.endDate,
    status: r.status,
    balance: typeof r.balance === 'number' ? r.balance : null
  };
}

// Identity verification for Kiosk (Search by Last Name or Reservation ID)
app.post('/api/kiosk/identify', async (req, res) => {
  const { query, mode, trustedPush } = req.body;
  if (!query) return res.status(400).json({ success: false });

  logger.info(`[KIOSK IDENTIFY] Searching for guest: ${query} (Mode: ${mode})`);

  const today = new Date().toISOString().split('T')[0];

  // Multi-top-level disambiguation. When a guest's last name appears on
  // more than one of today's bookings (e.g. "Olsen" is a sub-guest on a
  // multi-room booking AND also a separate solo Olsen reservation), the
  // old single-best-match path silently picked one and PIN-verified
  // against the wrong contact. Here we pull EVERY today match, group by
  // parent prefix, and if more than one group exists we send the kiosk
  // a top-level chooser so the guest picks before PIN.
  if (mode === 'checkin') {
    const allToday = reservationCache.searchAllToday(query);
    const actionable = allToday.filter(r => {
      const status = (r.status || '').toLowerCase();
      return status !== 'checked_in' && status !== 'checked_out' && status !== 'cancelled' && status !== 'no_show';
    });
    // Group by parent prefix
    const byParent = new Map();
    for (const r of actionable) {
      const id = r.reservationID || r.reservationId;
      const prefix = reservationCache._parentPrefix(id);
      if (!byParent.has(prefix)) byParent.set(prefix, []);
      byParent.get(prefix).push(r);
    }

    if (byParent.size > 1) {
      // Build top-level chooser cards. Each card represents one parent
      // group; the anchor is the parent reservation (no -N suffix) if
      // present in the group, otherwise the lowest-suffix entry.
      const topLevelGroups = [];
      for (const [prefix, members] of byParent.entries()) {
        const sorted = members.slice().sort((a, b) => {
          const aSuffix = ((a.reservationID || a.reservationId).match(/-(\d+)$/) || [, '0'])[1];
          const bSuffix = ((b.reservationID || b.reservationId).match(/-(\d+)$/) || [, '0'])[1];
          return Number(aSuffix) - Number(bSuffix);
        });
        const anchor = sorted[0];
        const anchorId = anchor.reservationID || anchor.reservationId;
        const contact = extractGuestContact(anchor);
        const subRooms = sorted.map(summarizeReservationForKiosk).filter(Boolean);

        let verifyType = null, masked = null;
        if (contact.phone && contact.phone.length >= 4) {
          verifyType = 'phone';
          masked = `***-***-${contact.phone.slice(-4)}`;
        } else if (contact.email) {
          const parts = contact.email.split('@');
          verifyType = 'email';
          masked = parts.length === 2 ? `${parts[0].charAt(0)}***@${parts[1]}` : 'your email address';
        }

        topLevelGroups.push({
          anchorReservationId: anchorId,
          displayName: anchor.guestName || `${contact.firstName} ${contact.lastName}`.trim() || 'Guest',
          startDate: anchor.startDate,
          endDate: anchor.endDate,
          roomCount: subRooms.length,
          verifyType,
          masked,
          subRooms
        });
      }
      return res.json({ success: true, multiTopLevel: true, topLevelGroups });
    }
  }

  // Single top-level (or non-checkin mode) — original flow.
  const result = await agent.engine.api.getReservation(query, mode);

  if (result.success && result.data) {
    const contact = extractGuestContact(result.data);
    const reservationId = result.data.reservationID || result.data.reservationId;

    let group = [];
    if (mode === 'checkin') {
      const siblings = reservationCache.findSiblings(reservationId);
      
      let expandedSiblings = [];
      siblings.forEach(s => {
        let unpackedRooms = 0;
        if (s.guestList) {
          Object.values(s.guestList).forEach(g => {
            if (Array.isArray(g.rooms)) {
              g.rooms.forEach(room => {
                unpackedRooms++;
                expandedSiblings.push({
                  ...s,
                  reservationID: room.subReservationID || s.reservationID || s.reservationId,
                  reservationId: room.subReservationID || s.reservationID || s.reservationId,
                  guestList: {
                    [g.guestID || 'temp']: {
                      ...g,
                      rooms: [room]
                    }
                  }
                });
              });
            }
          });
        }
        if (unpackedRooms === 0) {
          expandedSiblings.push(s);
        }
      });

      group = expandedSiblings
        .filter(r => r.startDate === today)
        .filter(r => {
          const status = (r.status || '').toLowerCase();
          return status !== 'checked_in' && status !== 'checked_out' && status !== 'cancelled' && status !== 'no_show';
        })
        .map(summarizeReservationForKiosk)
        .filter(Boolean)
        .sort((a, b) => {
          const aSuffix = (a.reservationId.match(/-(\d+)$/) || [, '0'])[1];
          const bSuffix = (b.reservationId.match(/-(\d+)$/) || [, '0'])[1];
          return Number(aSuffix) - Number(bSuffix);
        });
    }
    const isMultiRoom = group.length > 1;

    if (query.trim().toUpperCase() === reservationId.toUpperCase() || trustedPush) {
      return res.json({
        success: true,
        requiresVerification: false,
        reservationId,
        guestData: contact,
        ...(isMultiRoom ? { group } : {})
      });
    }

    if (contact.phone && contact.phone.length >= 4) {
      return res.json({
        success: true,
        requiresVerification: true,
        verifyType: 'phone',
        reservationId,
        maskedPhone: `***-***-${contact.phone.slice(-4)}`,
        ...(isMultiRoom ? { group } : {})
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
        maskedEmail,
        ...(isMultiRoom ? { group } : {})
      });
    }
    return res.json({ success: false, message: "We found your reservation, but it lacks contact details for secure verification. Please see the front desk." });
  }

  res.json({ success: false, message: result.message || "Could not locate a reservation with that information." });
});

// Fetch contact details for a sibling sub-reservation in a multi-room
// booking, anchored to a reservation that already passed PIN verification
// in this session. The caller proves they're authorized for the group by
// presenting the verifiedReservationId (returned by /api/kiosk/verify).
// We confirm both share a parent ID prefix before disclosing the target's
// guest data — no cross-group lookups.
app.post('/api/kiosk/sub-reservation', async (req, res) => {
  const { verifiedReservationId, targetReservationId } = req.body;
  if (!verifiedReservationId || !targetReservationId) {
    return res.status(400).json({ success: false, message: "Missing reservation IDs" });
  }
  const verifiedPrefix = reservationCache._parentPrefix(verifiedReservationId);
  const targetPrefix = reservationCache._parentPrefix(targetReservationId);
  if (!verifiedPrefix || verifiedPrefix !== targetPrefix) {
    logger.warn(`[KIOSK SUBRES] Refused cross-group lookup: ${verifiedReservationId} → ${targetReservationId}`);
    return res.status(403).json({ success: false, message: "That reservation isn't part of your booking." });
  }
  logger.info(`[KIOSK SUBRES] Loading sub-reservation ${targetReservationId} (verified via ${verifiedReservationId})`);
  const result = await agent.engine.api.getReservationById(targetReservationId);
  if (result.success && result.data) {
    const contact = extractGuestContact(result.data);
    return res.json({
      success: true,
      reservationId: targetReservationId,
      guestData: {
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email.toLowerCase(),
        phone: contact.phone,
        address: contact.address,
        city: contact.city,
        state: contact.state,
        zip: contact.zip
      }
    });
  }
  res.json({ success: false, message: "Could not load that reservation. Please see the front desk." });
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

// 0. Daily Reservation Cache Hard Sync at 2:05 AM
cron.schedule('5 2 * * *', async () => {
  logger.info('[CRON] 2:05 AM - Triggering full background sync for Reservation Cache...');
  if (agent.isRunning) {
    reservationCache.syncFromCloudbeds(agent.engine.api).catch(e => {
      logger.error(`[CRON] Nightly cache sync failed: ${e.message}`);
    });
  }
}, { timezone: "America/Chicago" });

// 1. Room Assignment at 3:00 AM (after Cloudbeds Night Audit finishes at 2:00).
// Deterministic JS — see src/roomAssignment.js for why this isn't the agent.
cron.schedule('0 3 * * *', async () => {
  const todayStr = getHotelBusinessDate(0);
  const tomorrowStr = getHotelBusinessDate(1);
  logger.info(`[CRON] 3:00 AM - Triggering deterministic room assignment for ${todayStr}...`);
  if (!agent.isRunning) {
    logger.warn('[CRON] Agent is not running. Skipping scheduled room assignment.');
    return;
  }
  try {
    await runRoomAssignment({
      api: agent.engine.api,
      alertHub: agent.engine.alertHub,
      todayStr,
      tomorrowStr
    });
  } catch (e) {
    logger.error(`[CRON] Room assignment crashed: ${e.message}`);
    if (agent.engine.alertHub) {
      agent.engine.alertHub.publish({
        urgency: 'critical',
        issueDescription: `Nightly room assignment crashed at 3:00 AM: ${e.message}. Reassign manually before arrivals start.`
      });
    }
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

  // One-line at-a-glance summary so silent dry-runs and disabled subsystems
  // can't hide inside the longer per-group OK lines above.
  const live = [];
  const dryRun = [];
  const disabled = [];
  if (messagingProvider === 'none') dryRun.push('Messaging(SMS replies suppressed)');
  else live.push(`Messaging(${messagingProvider})`);
  if (process.env.ENABLE_WHISTLE_RPA === 'true') live.push('WhistleRPA');
  else disabled.push('WhistleRPA(set ENABLE_WHISTLE_RPA=true)');
  if (process.env.WEBHOOK_PUBLIC_URL) live.push('CloudbedsWebhooks');
  else disabled.push('CloudbedsWebhooks(set WEBHOOK_PUBLIC_URL)');
  const parts = [];
  if (live.length) parts.push(`Live: ${live.join(', ')}`);
  if (dryRun.length) parts.push(`DryRun: ${dryRun.join(', ')}`);
  if (disabled.length) parts.push(`Disabled: ${disabled.join(', ')}`);
  logger.info(`[STARTUP] ${parts.join(' | ')}`);

  return allOk;
}

async function boot() {
  logger.info(`Starting Hotel Automation Platform Server on port ${port}...`);
  validateStartupConfig();
  startWarnDigest();
  server.listen(port, () => {
    logger.info(`Dashboard accessible locally at http://localhost:${port}`);
  });

  let whistleListener = null;

  const gracefulShutdown = async () => {
    logger.info('Shutting down server and agent...');
    if (whistleListener) await whistleListener.stop();
    if (agent.engine && agent.engine.paymentTerminal) {
      try { await agent.engine.paymentTerminal.stop(); } catch (e) {}
    }
    await agent.stop();
    process.exit(0);
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  // Start the background scraping sentinel
  try {
    await agent.start();

    // Kick off background cache sync
    reservationCache.syncFromCloudbeds(agent.engine.api).catch(e => {
      logger.error(`[CACHE] Initial background sync failed: ${e.message}`);
    });

    // Pre-warm the kiosk payment-terminal browser so the first kiosk
    // charge doesn't pay the 2-4s Chrome cold-start. Mirrors how
    // WhistleListener launches at boot — separate Chrome user-data-dir,
    // long-lived for the process lifetime.
    //
    // CRITICAL: await this BEFORE starting WhistleListener. Even though
    // they use separate user-data-dirs, Chrome on Windows uses an
    // installation-level singleton — two Playwright launches firing within
    // a few milliseconds race that lock and both crash with
    // "Protocol error (Browser.getWindowForTarget): Browser window not found"
    // (the Chrome process exits cleanly with code 0 before it can produce
    // a window). Sequencing eliminates the race entirely. Trade is ~10s
    // of boot time.
    if (agent.engine && agent.engine.paymentTerminal) {
      try {
        await agent.engine.paymentTerminal.start();
      } catch (e) {
        logger.error(`[STRIPE TERMINAL] Pre-warm failed (charges will retry on demand): ${e.message}`);
      }
    }

    if (process.env.ENABLE_WHISTLE_RPA === 'true') {
      whistleListener = new WhistleListener(agent);
      whistleListener.start().catch(e => logger.error(`[WHISTLE RPA] Fatal error: ${e.message}`));
    }
  } catch (error) {
    logger.error('Fatal agent error:', error.message);
  }
}

boot();
