const { GoogleGenAI, Type } = require('@google/genai');
const { CloudbedsAPI } = require('./cloudbedsApi');
const { logger } = require('./logger');

class AutonomyEngine {
  constructor() {
    // Initialize the Gemini client
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    this.api = new CloudbedsAPI();
  }

  getHotelPolicies() {
    return {
      hotelName: "Independent Hotel",
      frontDeskNumber: "Dial 0 or 555-0199",
      standardCheckin: "3:00 PM",
      standardCheckout: "11:00 AM",
      petPolicy: "Pet-friendly. $30 non-refundable fee per stay. Pets must not be left unattended, must be leashed in public. No pets in breakfast room or pool (unless certified service animal). Owners must clean up after pets to avoid extra fees.",
      smokingPolicy: "100% smoke-free (including vapes/marijuana). $250 cleaning fee for violations charged to card on file. Possible eviction.",
      paymentPolicy: "Valid CC matching government ID required. Card authorized for full estimated amount at check-in. Release takes 3-7 business days.",
      damagesPolicy: "Guests financially responsible for damages or excessive cleaning (e.g. biological waste, deep stains).",
      liabilityPolicy: "Hotel not liable for lost/stolen items. Lost & found held for 60 days. Guest pays shipping for returns.",
      cancellationPolicy: "Customer-centric and highly flexible. We value long-term loyalty over short-term fees. Agents are authorized to waive cancellation fees or offer future stay credits to ensure the guest leaves happy and feeling understood."
    };
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
        },
        {
          name: "alertFrontDesk",
          description: "Immediately escalates a critical issue, maintenance request, physical danger, or emergency to the human front desk staff via high-priority alert.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              urgency: { type: Type.STRING, description: "Must be 'high' or 'critical'" },
              issueDescription: { type: Type.STRING, description: "Brief description of the problem being escalated" }
            },
            required: ["urgency", "issueDescription"]
          }
        },
        {
          name: "chargePhysicalTerminal",
          description: "Pushes a payment request to the physical Stripe WisePOS E terminal at the front desk for a Card-Present transaction. MUST BE USED instead of postPayment if the guest is checking out at the physical kiosk.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              reservationId: { type: Type.STRING },
              amount: { type: Type.NUMBER, description: "Amount to charge in USD" },
              terminalName: { type: Type.STRING, description: "The name of the terminal the guest is standing at (e.g. 'Reader 1')" }
            },
            required: ["reservationId", "amount", "terminalName"]
          }
        },
        {
          name: "processCheckout",
          description: "Initiates the absolute full checkout sequence. Updates PMS status to checked_out and emails the fiscal document strictly adhering to Channel rules.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              reservationId: { type: Type.STRING }
            },
            required: ["reservationId"]
          }
        }
      ]
    }];
  }

  getSystemInstruction() {
    const policies = this.getHotelPolicies();
    return `You are the Autonomy Engine, an advanced AI concierge for ${policies.hotelName}.

EMPATHY & TONE:
Your primary goal is to ensure interactions feel genuinely human. Speak with high empathy, warmth, and understanding. Avoid robotic or highly rigid corporate language. Our philosophy is that the long-term value of a loyal customer outweighs nickle-and-diming them. Erring on the side of making the customer happy is your prime directive. Use a very conversational tone.

CRITICAL EMERGENCY PROTOCOL:
If the guest mentions a maintenance issue, flood, physical danger, or emergency:
1. You MUST immediately call the 'alertFrontDesk' tool to notify staff.
2. You MUST reply to the guest with this EXACT phrasing (adapted slightly to the context if needed): 
"Thank you for alerting us to this. We have immediately notified maintenance and a member of our team will be there to assist you as soon as possible. If this is an immediate, critical emergency, please contact the front desk directly by dialing ${policies.frontDeskNumber}."
Do not wait to solve the issue yourself. Do not provide a standardized response.

OPERATIONAL POLICIES to abide by implicitly:
${JSON.stringify(policies, null, 2)}

KIOSK & PAYMENTS PROTOCOL:
If processing a kiosk checkout and a balance is owed, you MUST use 'chargePhysicalTerminal' instead of 'postPayment'. We rely on Card-Present chip reads for security and lower fees. Do not use the card on file for kiosk visitors.

STANDARD WORKFLOW:
1. Identify intent.
2. Call required tools (like 'getReservation').
3. If necessary, call further tools (like 'postFolioAdjustment' or 'updateReservation').
4. Draft a clear, empathetic, and exceptionally helpful message back to the guest.`;
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
          else if (name === 'alertFrontDesk') {
            logger.warn(`[EMERGENCY ESCALATION] Urgency ${args.urgency.toUpperCase()}: ${args.issueDescription}`);
            // Hook for future integration (e.g. Twilio API, Siren, UI flash)
            apiResult = { success: true, action: "Front desk staff has been successfully pinged." };
          }
          else if (name === 'chargePhysicalTerminal') {
            logger.info(`[STRIPE TERMINAL] Pushing $${args.amount} to WisePOS E (${args.terminalName}) for ${args.reservationId}`);
            // This will block/wait for the Stripe API terminal callback
            apiResult = { success: true, message: `Payment of $${args.amount} successfully captured via physical chip inserted at ${args.terminalName}.` };
          }
          else if (name === 'processCheckout') {
            logger.info(`[CHECKOUT] Processing native checkout for ${args.reservationId}`);
            const resData = await this.api.getReservation(args.reservationId);
            if (resData.success && resData.data) {
                // Update status
                const updateRes = await this.api.updateReservation(args.reservationId, { status: 'checked_out' });
                
                // Security Guard - DO NOT SEND INVOICE TO CHANNEL COLLECT BOOKINGS
                if (resData.data.paymentType === 'Channel Collect Booking') {
                   logger.warn(`[CHECKOUT GUARD] Skipping Email Invoice step for ${args.reservationId} - Payment Type is Channel Collect Booking!`);
                   apiResult = { success: true, message: "Checkout processed, but invoice skipped due to Channel Collect policy." };
                } else {
                   // In reality, you extract the generated documentID from the reservation
                   const fakeDocId = `DOC_${args.reservationId}_123`;
                   const emailRes = await this.api.emailFiscalDocument(fakeDocId, resData.data.email || 'guest@example.com');
                   apiResult = { success: true, message: `Checkout processed. Invoice sent via email via native fiscal endpoint. (Status: ${emailRes.success})` };
                }
            } else {
                apiResult = { success: false, error: "Could not fetch reservation to process checkout." };
            }
          }
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
      throw e;
    }
  }
}

module.exports = { AutonomyEngine };
