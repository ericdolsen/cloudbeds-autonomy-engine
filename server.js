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
  logger.info(`[WEBHOOK] Incoming payload from Cloudbeds: ${payload.event}`);
  
  // Cloudbeds requires an immediate 2XX response to prevent webhook retry loops
  res.status(200).send("OK");

  if (!agent.isRunning) {
    logger.warn(`[WEBHOOK] Engine stopped. Ignoring event.`);
    return;
  }

  try {
    let promptText = "";
    
    // Translate raw JSON webhooks into human-readable prompts for the LLM
    if (payload.event === "reservation/created") {
      promptText = `A new reservation (ID: ${payload.reservationID || payload.reservationId}) was just created on Cloudbeds. Please review their details and determine if any proactive steps or folio adjustments are needed.`;
    } else if (payload.event === "reservation/dates_changed") {
      promptText = `The dates for reservation ${payload.reservationId} just changed. Review the ledger to ensure we don't need to issue any fee adjustments.`;
    } else {
      promptText = `A generic Cloudbeds system event occurred: ${payload.event} for reservation ${payload.reservationID || 'unknown'}. Review if necessary.`;
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
     logger.action('System', `Computed automated Sales Tax report for ${month} ${year}.`, 'ok');
     res.json(result);
  } catch (err) {
     logger.action('System', `Failed to generate Tax Report: ${err.message}`, 'error');
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
            // 1. Get Guest ID
            const resData = await agent.engine.api.getReservation(reservationId);
            if (resData.success && resData.data) {
                let guestID = resData.data.guestID || resData.data.guestId;
                if (!guestID && resData.data.guestList) {
                    const guests = Object.values(resData.data.guestList);
                    const mg = guests.find(g => g.isMainGuest) || guests[0];
                    if (mg) guestID = mg.guestID || mg.guestId;
                }
                
                // 2. Update Profile
                if (guestID) {
                    await agent.engine.api.putGuest(guestID, {
                        guestEmail: guestUpdates.email,
                        guestCellPhone: guestUpdates.phone,
                        guestAddress: guestUpdates.address
                    });
                }
            }
            
            // 3. Upload Signature
            if (guestUpdates.signature) {
                await agent.engine.api.postReservationDocument(reservationId, guestUpdates.signature, "Registration_Signature.png");
            }
        } catch (e) {
            logger.error(`[KIOSK] Failed to sync registration to Cloudbeds (Non-Fatal): ${e.message}`);
        }
    }

    const promptText = `A guest with last name "${lastName}" is at the kiosk attempting to physically check in to reservation ${reservationId} using terminal ${terminalName}. Please process their check-in completely by checking for an outstanding balance, prompting them to swipe/insert a card on the terminal if money is owed, and then finally executing the cloudbeds check-in status update and communicating success back.`;
    
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

// Identity verification for Kiosk (Search by Last Name)
app.post('/api/kiosk/identify', async (req, res) => {
  const { query, mode } = req.body;
  if (!query) return res.status(400).json({ success: false });

  logger.info(`[KIOSK IDENTIFY] Searching for guest: ${query} (Mode: ${mode})`);
  const result = await agent.engine.api.getReservation(query, mode);

  if (result.success && result.data) {
     // Normalize phone and email deeply embedded in Cloudbeds guestList
     let phoneStr = '';
     let actEmail = result.data.guestEmail || '';
     
     if (result.data.guestList) {
         const guests = Object.values(result.data.guestList);
         const mg = guests.find(g => g.isMainGuest) || guests[0];
         if (mg) {
             phoneStr = (mg.guestCellPhone || mg.guestPhone || '').replace(/[^0-9]/g, '');
             if (!actEmail) actEmail = mg.guestEmail;
         }
     }

     if (phoneStr && phoneStr.length >= 4) {
         const last4 = phoneStr.slice(-4);
         return res.json({ 
           success: true, 
           requiresVerification: true, 
           verifyType: 'phone',
           maskedPhone: `***-***-${last4}`
         });
     } else if (actEmail) {
         const parts = actEmail.split('@');
         const maskedEmail = parts.length === 2 ? `${parts[0].charAt(0)}***@${parts[1]}` : 'your email address';
         return res.json({
           success: true,
           requiresVerification: true,
           verifyType: 'email',
           maskedEmail: maskedEmail
         });
     } else {
         // Extreme Fallback
         return res.json({ success: false, message: "We found your reservation, but it lacks contact details for secure verification. Please see the front desk." });
     }
  }
  
  res.json({ success: false, message: "Could not locate a reservation with that information." });
});

app.post('/api/kiosk/verify', async (req, res) => {
  const { query, pin } = req.body;
  if (!query || !pin) return res.status(400).json({ success: false });

  logger.info(`[KIOSK VERIFY] Verifying Security PIN for guest: ${query}`);
  const result = await agent.engine.api.getReservation(query);

  if (result.success && result.data) {
     let phoneStr = '';
     let actEmail = (result.data.guestEmail || '').toLowerCase();
     
     if (result.data.guestList) {
         const guests = Object.values(result.data.guestList);
         const mg = guests.find(g => g.isMainGuest) || guests[0];
         if (mg) {
             phoneStr = (mg.guestCellPhone || mg.guestPhone || '').replace(/[^0-9]/g, '');
             if (!actEmail) actEmail = (mg.guestEmail || '').toLowerCase();
         }
     }

     let guestData = { email: actEmail, phone: phoneStr, address: '', city: '', state: '', zip: '' };
     if (result.data.guestList) {
         const guests = Object.values(result.data.guestList);
         const mg = guests.find(g => g.isMainGuest) || guests[0];
         if (mg) {
             guestData.address = mg.guestAddress || '';
             guestData.city = mg.guestCity || '';
             guestData.state = mg.guestState || '';
             guestData.zip = mg.guestZip || '';
         }
     }

     if (phoneStr && phoneStr.length >= 4) {
         if (phoneStr.slice(-4) === pin) return res.json({ success: true, reservationId: result.data.reservationId || result.data.reservationID, guestData });
     } else if (actEmail) {
         if (actEmail === pin.toLowerCase().trim()) return res.json({ success: true, reservationId: result.data.reservationId || result.data.reservationID, guestData });
     }
  }
  
  res.json({ success: false, message: "Verification failed. Incorrect Security PIN or Email." });
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
