const { logger } = require('./logger');
const { AutonomyEngine } = require('./autonomyEngine');

require('dotenv').config();

class CloudbedsAgent {
  constructor() {
    this.isRunning = false;
    this.engine = new AutonomyEngine();
    
    // We no longer require CLOUDBEDS_EMAIL/PASSWORD since we use API tokens
    if (!process.env.GEMINI_API_KEY) {
      logger.warn('GEMINI_API_KEY is not set in .env! Autonomy Engine will fail to process intent.');
    }
  }

  async start() {
    logger.info('Starting Cloudbeds Agent (Autonomy Engine Mode)...');
    this.isRunning = true;
    logger.info('Agent is running. Ready to receive incoming webhook events from Cloudbeds.');
  }

  async stop() {
    this.isRunning = false;
    logger.info('Agent stopped.');
  }

  /**
   * Main entry point for incoming messages from Cloudbeds Webhooks
   */
  async processIncomingMessage(payload) {
    if (!this.isRunning) {
      logger.warn('Agent is stopped, ignoring message.');
      return;
    }
    
    // Full-payload dump goes to debug only — at INFO it floods the log
    // (Whistle scrapes are 600-3000 chars and get logged AGAIN by
    // executeTask). Useful when AUTONOMY_DEBUG=true and you're chasing
    // a "what did the engine actually see" question.
    if (process.env.AUTONOMY_DEBUG === 'true') {
      logger.info(`Received payload: ${JSON.stringify(payload)}`);
    } else {
      const textLen = (payload && payload.text) ? payload.text.length : 0;
      logger.info(`Received payload from ${(payload && payload.source) || 'unknown'} (${textLen} chars)`);
    }
    // Route to Autonomy Engine to decide what to do
    const responseText = await this.engine.executeTask(payload);
    
    return {
      success: true,
      agent_response: responseText
    };
  }
}

module.exports = { CloudbedsAgent };
