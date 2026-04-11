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
    
    logger.info(`Received payload: ${JSON.stringify(payload)}`);
    // Route to Autonomy Engine to decide what to do
    const responseText = await this.engine.executeTask(payload);
    
    return {
      success: true,
      agent_response: responseText
    };
  }
}

module.exports = { CloudbedsAgent };
