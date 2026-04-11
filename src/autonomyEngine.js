const { GoogleGenAI, Type } = require('@google/genai');
const { CloudbedsAPI } = require('./cloudbedsApi');
const { logger } = require('./logger');

class AutonomyEngine {
  constructor() {
    // Initialize the Gemini client
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    this.api = new CloudbedsAPI();
  }

  getTools() {
    return [{
      functionDeclarations: [
        {
          name: "getReservation",
          description: "Fetches the guest's full reservation record (balance, dates, room type) using their name, phone, or reservation ID.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              query: { type: Type.STRING, description: "Name, phone number, or reservation ID" }
            },
            required: ["query"]
          }
        },
        {
          name: "getUnassignedRooms",
          description: "Checks hotel inventory for available rooms between two dates.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              startDate: { type: Type.STRING, description: "Arrival date (YYYY-MM-DD)" },
              endDate: { type: Type.STRING, description: "Departure date (YYYY-MM-DD)" }
            },
            required: ["startDate", "endDate"]
          }
        },
        {
          name: "updateReservation",
          description: "Updates reservation details like status (e.g., 'checked_out'), arrival date, or room type.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              reservationId: { type: Type.STRING, description: "The Cloudbeds reservation ID" },
              updates: { 
                type: Type.OBJECT, 
                description: "Key-value pairs to update (e.g., {'status': 'checked_out'}, {'roomType': 'King Suite'})"
              }
            },
            required: ["reservationId", "updates"]
          }
        },
        {
          name: "postFolioAdjustment",
          description: "Adds a charge or credit to the guest's folio (e.g., room upgrade fee).",
          parameters: {
            type: Type.OBJECT,
            properties: {
              reservationId: { type: Type.STRING },
              amount: { type: Type.NUMBER, description: "Amount in USD" },
              description: { type: Type.STRING, description: "Reason for the adjustment" }
            },
            required: ["reservationId", "amount", "description"]
          }
        },
        {
          name: "postPayment",
          description: "Charges the guest's credit card currently on file for a specified amount.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              reservationId: { type: Type.STRING },
              amount: { type: Type.NUMBER, description: "Amount to charge in USD" }
            },
            required: ["reservationId", "amount"]
          }
        }
      ]
    }];
  }

  getSystemInstruction() {
    return `You are the Autonomy Engine, an advanced AI concierge for a hotel running on Cloudbeds. 
Your job is to read guest requests (or staff requests), reason about what needs to be done, use the provided tools to query or update the Cloudbeds property management system, and then draft a professional, empathetic response.
When a request comes in:
1. Identify the intent and any necessary parameters.
2. Call tools to get the required information (like 'getReservation').
3. If necessary, call further tools to fix issues or update records.
4. When you have resolved the issue, draft a clear, friendly, and concise message back to the guest explaining what you did.
Always verify balances before processing a checkout.`;
  }

  async executeTask(messagePayload) {
    logger.info(`[AUTONOMY ENGINE] Processing new message from ${messagePayload.source || 'user'}: "${messagePayload.text}"`);
    
    try {
      const chat = this.ai.chats.create({
        model: process.env.GEMINI_MODEL || 'gemini-3.1-pro',
        config: {
          systemInstruction: this.getSystemInstruction(),
          tools: this.getTools(),
          temperature: 0.1
        }
      });

      // Send the initial user message
      let response = await chat.sendMessage({ message: messagePayload.text });
      logger.info(`[AUTONOMY ENGINE] Thinking...`);

      // Handle function calls loop
      while (response.functionCalls && response.functionCalls.length > 0) {
        const call = response.functionCalls[0];
        const { name, args } = call;
        
        logger.info(`[AUTONOMY ENGINE] Wants to execute: ${name}(${JSON.stringify(args)})`);
        
        let apiResult;
        try {
          if (name === 'getReservation') apiResult = await this.api.getReservation(args.query);
          else if (name === 'getUnassignedRooms') apiResult = await this.api.getUnassignedRooms(args.startDate, args.endDate);
          else if (name === 'updateReservation') apiResult = await this.api.updateReservation(args.reservationId, args.updates);
          else if (name === 'postFolioAdjustment') apiResult = await this.api.postFolioAdjustment(args.reservationId, args.amount, args.description);
          else if (name === 'postPayment') apiResult = await this.api.postPayment(args.reservationId, args.amount);
          else throw new Error("Unknown tool call");
        } catch (e) {
          apiResult = { error: e.message };
        }

        logger.info(`[AUTONOMY ENGINE] API Result: ${JSON.stringify(apiResult)}`);

        // Send tool output back to the model
        response = await chat.sendMessage({ 
          message: [{
            functionResponse: {
              name: name,
              response: apiResult
            }
          }]
        });
      }

      // The final text response
      const reply = response.text;
      logger.info(`[AUTONOMY ENGINE] Final Output: \n${reply}`);
      return reply;

    } catch (e) {
      logger.error(`[AUTONOMY ENGINE] Critical Failure: ${e.message}`);
      return "I'm sorry, I am experiencing a technical issue and cannot process your request right now. Please contact the front desk.";
    }
  }
}

module.exports = { AutonomyEngine };
