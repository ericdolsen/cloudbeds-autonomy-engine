const express = require('express');
const cron = require('node-cron');
const path = require('path');
const { CloudbedsAgent } = require('./src/agent');
const { logger } = require('./src/logger');

require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Setup static files and APIs
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Initialize the master Autonomy Engine
const agent = new CloudbedsAgent();

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

// BOOTSTRAP
// =====================================
async function boot() {
  logger.info(`Starting Hotel Automation Platform Server on port ${port}...`);
  app.listen(port, () => {
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
