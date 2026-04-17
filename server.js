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
app.use(express.json());

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

// Dashboard API Routes
app.get('/api/status', (req, res) => {
  res.json({
    status: agent.isRunning ? 'running' : 'stopped',
    uptime: process.uptime()
  });
});

// Primary Webhook Ingress from Cloudbeds (System Events like reservation created)
app.post('/api/webhooks/cloudbeds', async (req, res) => {
  const payload = req.body; 
  logger.info(`[WEBHOOK] Incoming payload from Cloudbeds: ${payload.event}`);
  
  // Cloudbeds requires an immediate 2XX response to prevent webhook retry loops
  res.status(200).send("OK");

  if (!agent.isRunning) {
    logger.warn(`[WEBHOOK] Engine stopped. Ignoring event.`);
    return;
  }

  try {
    const resId = payload.reservationID || payload.reservationId || 'unknown';
    let promptText = "";

    switch (payload.event) {
      case "reservation/created":
        promptText = `A new reservation (ID: ${resId}) was just created on Cloudbeds. Please review their details and determine if any proactive steps or folio adjustments are needed.`;
        break;
      case "reservation/status_changed":
        promptText = `Reservation ${resId} status changed to "${payload.status || 'unknown'}". If this is a check-in, make sure the room is ready; if cancelled, review refund and cancellation fee policy.`;
        break;
      case "reservation/dates_changed":
        promptText = `The dates for reservation ${resId} just changed. Review the ledger to ensure we don't need to issue any fee adjustments.`;
        break;
      case "reservation/accommodation_status_changed":
      case "reservation/accommodation_changed":
        promptText = `Room assignment for reservation ${resId} changed. Confirm housekeeping state for the new room and update the guest if they have arrived.`;
        break;
      case "reservation/deleted":
        promptText = `Reservation ${resId} was deleted. Verify no outstanding folio balance or pending payment needs to be reconciled.`;
        break;
      case "guest/created":
      case "guest/details_changed":
        promptText = `Guest record updated on reservation ${resId} (event: ${payload.event}). No action usually required, but flag if phone or email changed so comms go to the right place.`;
        break;
      case "housekeeping/room_condition_changed": {
        // Real-time trigger: rebalance housekeeping assignments as rooms flip dirty/clean.
        const housekeepingEngine = new HousekeepingAssigner(agent.api);
        housekeepingEngine.run6AMAssignment().catch(e => logger.error(`Housekeeping rebalance failed: ${e.message}`));
        return;
      }
      case "night_audit/completed": {
        // Fire the same pipeline as the 4am cron, but driven by the real audit completion.
        const reportEngine = new NightAuditReport(agent.api);
        reportEngine.runDailyAudit().catch(e => logger.error(`Night audit report failed: ${e.message}`));
        return;
      }
      default:
        promptText = `A generic Cloudbeds system event occurred: ${payload.event} for reservation ${resId}. Review if necessary.`;
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

// Kiosk REST API Endpoint
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
    
    // The engine's text reply will be the message displayed on the Kiosk screen
    // If the engine didn't throw an error, we assume it successfully processed
    res.json({ success: true, status: 'complete', message: result.agent_response });
  } catch (error) {
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

// Identity verification for Kiosk (Search by Last Name)
app.post('/api/kiosk/identify', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ success: false });

  logger.info(`[KIOSK IDENTIFY] Searching for guest: ${query}`);
  const result = await agent.engine.api.getReservation(query);

  if (result.success && result.data && result.data.phone) {
     const phoneStr = result.data.phone.replace(/[^0-9]/g, '');
     if (phoneStr.length >= 4) {
         const last4 = phoneStr.slice(-4);
         return res.json({ 
           success: true, 
           requiresVerification: true, 
           maskedPhone: `***-***-${last4}`
         });
     }
  }
  
  res.json({ success: false, message: "Could not locate a reservation with that information." });
});

app.post('/api/kiosk/verify', async (req, res) => {
  const { query, pin } = req.body;
  if (!query || !pin) return res.status(400).json({ success: false });

  logger.info(`[KIOSK VERIFY] Verifying PIN for guest: ${query}`);
  const result = await agent.engine.api.getReservation(query);

  if (result.success && result.data && result.data.phone) {
     const phoneStr = result.data.phone.replace(/[^0-9]/g, '');
     if (phoneStr.slice(-4) === pin) {
         return res.json({ 
           success: true, 
           reservationId: result.data.reservationId 
         });
     }
  }
  
  res.json({ success: false, message: "Verification failed. Incorrect PIN." });
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
    const reportEngine = new NightAuditReport(agent.api);
    await reportEngine.runDailyAudit();
  } else {
    logger.warn('[CRON] Agent is not running. Skipping reporting pipeline.');
  }
});

// 3. Automated Housekeeping Clustering & Scheduling (6:00 AM)
cron.schedule('0 6 * * *', async () => {
  logger.info('[CRON] 6:00 AM - Triggering Housekeeping Load-Balancer algorithm...');
  if (agent.isRunning) {
    const housekeepingEngine = new HousekeepingAssigner(agent.api);
    await housekeepingEngine.run6AMAssignment();
  } else {
    logger.warn('[CRON] Agent is not running. Skipping Housekeeping pipeline.');
  }
});

// BOOTSTRAP
// =====================================
async function boot() {
  logger.info(`Starting Hotel Automation Platform Server on port ${port}...`);
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
