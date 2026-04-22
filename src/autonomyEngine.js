const { GoogleGenAI, Type } = require('@google/genai');
const { CloudbedsAPI } = require('./cloudbedsApi');
const { PaymentTerminal } = require('./paymentTerminal');
const { logger } = require('./logger');

const SESSION_TTL_MS = 30 * 60 * 1000; // 30-minute rolling window for guest SMS threads

class AutonomyEngine {
  constructor() {
    // Initialize the Gemini client
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    this.api = new CloudbedsAPI();
    this.paymentTerminal = new PaymentTerminal();
    // sessionKey -> { chat, lastSeen } — keeps Gemini chats warm so multi-turn
    // guest conversations (e.g. texts) retain memory across webhook calls.
    this.sessions = new Map();
  }

  _pruneSessions() {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [k, v] of this.sessions) {
      if (v.lastSeen < cutoff) this.sessions.delete(k);
    }
  }

  _getOrCreateChat(sessionKey) {
    this._pruneSessions();
    if (sessionKey && this.sessions.has(sessionKey)) {
      const s = this.sessions.get(sessionKey);
      s.lastSeen = Date.now();
      return s.chat;
    }
    const chat = this.ai.chats.create({
      model: process.env.GEMINI_MODEL || 'gemini-1.5-pro',
      config: {
        systemInstruction: this.getSystemInstruction(),
        tools: this.getTools(),
        temperature: 0.1
      }
    });
    if (sessionKey) this.sessions.set(sessionKey, { chat, lastSeen: Date.now() });
    return chat;
  }

  _resolveGuestEmail(reservationData) {
    if (!reservationData) return null;
    if (reservationData.email) return reservationData.email;
    if (reservationData.guestEmail) return reservationData.guestEmail;
    if (reservationData.guestList) {
      const guests = Object.values(reservationData.guestList);
      const mg = guests.find(g => g.isMainGuest) || guests[0];
      if (mg && mg.guestEmail) return mg.guestEmail;
    }
    return null;
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
          name: "getReservations",
          description: "Lists all reservations arriving within a date window. Use this for admin/batch operations (e.g. nightly room assignment) when you need to enumerate upcoming bookings.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              checkInFrom: { type: Type.STRING, description: "Window start date (YYYY-MM-DD)" },
              checkInTo: { type: Type.STRING, description: "Window end date (YYYY-MM-DD)" }
            },
            required: ["checkInFrom", "checkInTo"]
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
          description: "Adds a line-item charge to the guest's folio (e.g., room upgrade fee, parking, pet fee).",
          parameters: {
            type: Type.OBJECT,
            properties: {
              reservationId: { type: Type.STRING },
              amount: { type: Type.NUMBER, description: "Amount in USD" },
              description: { type: Type.STRING, description: "Reason for the charge" }
            },
            required: ["reservationId", "amount", "description"]
          }
        },
        {
          name: "postPayment",
          description: "Records a payment against the reservation folio using the guest's card on file. Do NOT use for in-person kiosk payments - use chargePhysicalTerminal instead.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              reservationId: { type: Type.STRING },
              amount: { type: Type.NUMBER, description: "Amount to charge in USD" },
              type: { type: Type.STRING, description: "One of: credit, debit, cash, check. Defaults to credit." },
              description: { type: Type.STRING, description: "Description / memo for the payment line." }
            },
            required: ["reservationId", "amount"]
          }
        },
        {
          name: "checkInReservation",
          description: "Transitions a confirmed reservation into 'checked_in' status via Cloudbeds. Use this once any outstanding balance has been collected.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              reservationId: { type: Type.STRING }
            },
            required: ["reservationId"]
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
          description: "Initiates the absolute full checkout sequence by updating PMS status to checked_out.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              reservationId: { type: Type.STRING }
            },
            required: ["reservationId"]
          }
        },
        {
          name: "evaluateAndEmailInvoice",
          description: "Evaluates the paymentType of a reservation and emails the fiscal document to the guest if safe. Aborts for Channel Collect Booking.",
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

CHECK-IN PROTOCOL:
To check a guest in, always call the 'checkInReservation' tool (NOT 'updateReservation'). Cloudbeds only permits check-in from a 'confirmed' status, so resolve any outstanding balance first (via chargePhysicalTerminal at the kiosk, or postPayment remotely) before calling 'checkInReservation'.

ADMIN & BATCH OPERATIONS:
When the incoming message is tagged with source=cron or source=system, you are acting as a BACK-OFFICE administrator, not a guest-facing concierge. You ARE authorized and expected to run batch and administrative workflows in this mode — including nightly room assignment optimization, audits, and bulk reservation updates. Do NOT refuse administrative tasks under these sources. Use the available tools (getReservations, getUnassignedRooms, updateReservation, postFolioAdjustment, postPayment, etc.) to carry out the work and report back a concise summary of actions taken.

STANDARD WORKFLOW:
1. Identify intent.
2. Call required tools (like 'getReservation').
3. If necessary, call further tools (like 'postFolioAdjustment' or 'updateReservation').
4. Draft a clear, empathetic, and exceptionally helpful message back to the guest.`;
  }

  async executeTask(messagePayload) {
    logger.info(`[AUTONOMY ENGINE] Processing new message from ${messagePayload.source || 'user'}: "${messagePayload.text}"`);

    try {
      const chat = this._getOrCreateChat(messagePayload.sessionKey);

      // Send the initial user message with an explicit source tag so the model
      // can tell guest-facing chat (kiosk/whistle) from admin batch work (cron/system).
      const sourceTag = messagePayload.source ? `[source=${messagePayload.source}] ` : '';
      let response = await chat.sendMessage({ message: `${sourceTag}${messagePayload.text}` });
      logger.info(`[AUTONOMY ENGINE] Thinking...${messagePayload.sessionKey ? ` (session=${messagePayload.sessionKey})` : ''}`);

      // Handle function calls loop
      while (response.functionCalls && response.functionCalls.length > 0) {
        const call = response.functionCalls[0];
        const { name, args } = call;

        logger.info(`[AUTONOMY ENGINE] Wants to execute: ${name}(${JSON.stringify(args)})`);

        let apiResult;
        try {
          if (name === 'getReservation') apiResult = await this.api.getReservation(args.query);
          else if (name === 'getUnassignedRooms') apiResult = await this.api.getUnassignedRooms(args.startDate, args.endDate);
          else if (name === 'getReservations') apiResult = await this.api.getReservations(args.checkInFrom, args.checkInTo);
          else if (name === 'updateReservation') apiResult = await this.api.updateReservation(args.reservationId, args.updates);
          else if (name === 'postFolioAdjustment') apiResult = await this.api.postCustomItem(args.reservationId, args.amount, args.description);
          else if (name === 'postPayment') apiResult = await this.api.postPayment(args.reservationId, args.amount, { type: args.type, description: args.description });
          else if (name === 'checkInReservation') apiResult = await this.api.checkInReservation(args.reservationId);
          else if (name === 'alertFrontDesk') {
            logger.warn(`[EMERGENCY ESCALATION] Urgency ${args.urgency.toUpperCase()}: ${args.issueDescription}`);
            // Hook for future integration (e.g. Twilio API, Siren, UI flash)
            apiResult = { success: true, action: "Front desk staff has been successfully pinged." };
          }
          else if (name === 'chargePhysicalTerminal') {
            logger.info(`[STRIPE TERMINAL] Pushing $${args.amount} to WisePOS E (${args.terminalName}) for ${args.reservationId}`);
            // This natively executes the Playwright script to click "Charge" on the terminal
            apiResult = await this.paymentTerminal.chargePhysicalTerminal(args.reservationId, args.amount, args.terminalName);
          }
          else if (name === 'processCheckout') {
            logger.info(`[CHECKOUT] Processing native checkout for ${args.reservationId}`);
            const resData = await this.api.getReservationById(args.reservationId);
            if (resData.success && resData.data) {
              const updateRes = await this.api.updateReservation(args.reservationId, { reservationStatus: 'checked_out' });
              if (!updateRes.success) {
                apiResult = { success: false, error: `Checkout status update failed: ${updateRes.error || 'unknown error'}` };
              } else {
                apiResult = { success: true, message: "Checkout processed successfully. Status updated to checked_out." };
              }
            } else {
              apiResult = { success: false, error: "Could not fetch reservation to process checkout." };
            }
          }
          else if (name === 'evaluateAndEmailInvoice') {
            logger.info(`[INVOICE GUARD] Evaluating invoice send for ${args.reservationId}`);
            const resData = await this.api.getReservationById(args.reservationId);
            if (resData.success && resData.data) {
              if (resData.data.paymentType === 'Channel Collect Booking') {
                logger.warn(`[CHECKOUT GUARD] Skipping Email Invoice step for ${args.reservationId} - Payment Type is Channel Collect Booking!`);
                apiResult = { success: true, message: "Invoice skipped due to Channel Collect policy." };
              } else {
                const guestEmail = this._resolveGuestEmail(resData.data);
                if (!guestEmail) {
                  apiResult = { success: true, message: `Invoice email skipped (missing guest email).` };
                } else if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
                  apiResult = { success: false, error: "SMTP credentials not configured in .env" };
                } else {
                  try {
                    const { generateFolioPdf } = require('./printHandler');
                    const pdfBuffer = await generateFolioPdf(args.reservationId, resData.data);
                    
                    const nodemailer = require('nodemailer');
                    const transporter = nodemailer.createTransport({
                      service: 'gmail',
                      auth: {
                        user: process.env.SMTP_USER,
                        pass: process.env.SMTP_PASS
                      }
                    });

                    const mailOptions = {
                      from: process.env.SMTP_ALIAS || process.env.SMTP_USER,
                      replyTo: process.env.SMTP_REPLY_TO || process.env.SMTP_USER,
                      to: guestEmail,
                      subject: `Your Receipt - ${args.reservationId} - Gateway Park Hotel`,
                      text: `Thank you for staying with us! Please find your final receipt attached.`,
                      attachments: [{
                        filename: `Receipt_${args.reservationId}.pdf`,
                        content: pdfBuffer,
                        contentType: 'application/pdf'
                      }]
                    };

                    await transporter.sendMail(mailOptions);
                    logger.info(`[INVOICE EMAIL] Sent local folio PDF to ${guestEmail}`);
                    apiResult = { success: true, message: `Invoice generated and emailed locally to ${guestEmail}.` };
                  } catch (err) {
                    logger.error(`[INVOICE EMAIL] Failed to send email: ${err.message}`);
                    apiResult = { success: false, error: `Failed to email invoice: ${err.message}` };
                  }
                }
              }
            } else {
              apiResult = { success: false, error: "Could not fetch reservation to evaluate invoice." };
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
