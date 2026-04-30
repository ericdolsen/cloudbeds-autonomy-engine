const { Type } = require('@google/genai');
const { CloudbedsAPI } = require('./cloudbedsApi');
const { PaymentTerminal } = require('./paymentTerminal');
const { modelRouter } = require('./modelRouter');
const { logger } = require('./logger');

const SESSION_TTL_MS = 30 * 60 * 1000; // 30-minute rolling window for guest SMS threads

class AutonomyEngine {
  constructor(router = modelRouter) {
    // Text lane goes through the router (Gemini 2.5 Flash by default). The
    // vision and voice lanes are owned by their dedicated modules and reach
    // into the same router for their own clients.
    this.router = router;
    this.api = new CloudbedsAPI();
    this.paymentTerminal = new PaymentTerminal();
    // sessionKey -> { chat, lastSeen } — keeps text-lane chats warm so
    // multi-turn guest conversations (e.g. texts) retain memory across
    // webhook calls.
    this.sessions = new Map();
    logger.info(`[AUTONOMY ENGINE] Text lane → ${this.router.textModel()}`);
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
    const chat = this.router.createTextChat({
      systemInstruction: this.getSystemInstruction(),
      tools: this.getTools(),
      temperature: 0.1
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
          name: "assignRoom",
          description: "Assigns a physical room to a reservation using the underlying Cloudbeds room ID. You MUST provide the complex cloudbeds roomID (e.g. '1234-5') and roomTypeID, which you can find via the getUnassignedRooms tool.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              reservationId: { type: Type.STRING },
              roomId: { type: Type.STRING, description: "The complex Cloudbeds room ID, NOT the simple room name." },
              roomTypeId: { type: Type.STRING }
            },
            required: ["reservationId", "roomId", "roomTypeId"]
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
          description: "Pushes a payment request to the physical Stripe WisePOS E terminal at the front desk for a real Card-Present transaction. This is the ONLY way the agent can take a payment — Gateway Park runs every card through Cloudbeds, so any balance the agent collects must go through this tool.",
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
    }, { googleSearch: {} }];
  }

  getKnowledgeBaseString() {
    try {
      const fs = require('fs');
      const path = require('path');
      const data = fs.readFileSync(path.join(__dirname, '..', 'data', 'knowledge_base.json'), 'utf8');
      const kb = JSON.parse(data);
      if (!Array.isArray(kb)) return 'No custom knowledge base found.';
      
      return kb.map(item => `Topic: ${item.topic}\nPolicy/Answer: ${item.info}`).join('\n\n');
    } catch (e) {
      return 'Knowledge base not initialized.';
    }
  }

  getSystemInstruction() {
    return `You are the Autonomy Engine, an advanced AI concierge for Gateway Park Hotel.

EMPATHY & TONE:
Your primary goal is to ensure interactions feel genuinely human. Speak with high empathy, warmth, and understanding. Avoid robotic or highly rigid corporate language. Our philosophy is that the long-term value of a loyal customer outweighs nickle-and-diming them. Erring on the side of making the customer happy is your prime directive. Use a very conversational tone.

CRITICAL EMERGENCY PROTOCOL:
If the guest mentions a maintenance issue, flood, physical danger, or emergency:
1. You MUST immediately call the 'alertFrontDesk' tool to notify staff.
2. You MUST reply to the guest with this EXACT phrasing (adapted slightly to the context if needed): 
"Thank you for alerting us to this. We have immediately notified maintenance and a member of our team will be there to assist you as soon as possible. If this is an immediate, critical emergency, please contact the front desk directly."
Do not wait to solve the issue yourself. Do not provide a standardized response.

HOTEL KNOWLEDGE BASE (Use this to answer all guest questions):
${this.getKnowledgeBaseString()}

KIOSK & PAYMENTS PROTOCOL:
If processing a kiosk checkout and a balance is owed, you MUST use 'chargePhysicalTerminal' to push the charge to the Stripe WisePOS E reader at the front desk. Gateway Park runs every card through Cloudbeds via Card-Present, never via card-on-file or external processors.

FINANCIAL POLICY (PAYMENTS):
The ONLY way the agent can take a payment is 'chargePhysicalTerminal' (Card-Present, real money moves). There is no tool that lets the agent record a payment without actually charging a card — and that is intentional. If you ever feel like you need to mark a balance as paid without running the card, the answer is to escalate via 'alertFrontDesk', not invent a workaround.

Balance handling rules:
- Outstanding balance at check-in → guest pays at the kiosk via 'chargePhysicalTerminal' or at the front desk in person. The agent does not pre-pay.
- Outstanding balance at checkout → if at the kiosk, use 'chargePhysicalTerminal'; otherwise direct the guest to the front desk and STOP.
- Tiny residual balances ($0.01-$5) appearing on a new reservation are usually rounding/tax artifacts that resolve naturally at check-in or via night audit. Note them but do not act on them.
- Refunds, comps, fee waivers — never automatic. Escalate to a human via 'alertFrontDesk' if a guest is asking for one.

CHECK-IN PROTOCOL:
To check a guest in, always call the 'checkInReservation' tool (NOT 'updateReservation'). Cloudbeds only permits check-in from a 'confirmed' status, so any outstanding balance must first be collected via 'chargePhysicalTerminal' at the kiosk (or in person at the front desk) before you call 'checkInReservation'.

CHECKOUT PROTOCOL:
When a guest indicates they want to check out (texts "checkout", asks to be checked out, confirms a checkout flow, etc.):
1. Identify the reservation via 'getReservation'.
2. If a balance is owed, direct the guest to the front desk and STOP — do NOT call processCheckout while a balance remains.
3. If the balance is zero (or already paid in full), call 'processCheckout' to update the status to checked_out.
4. After 'processCheckout' returns success, you MUST IMMEDIATELY call 'evaluateAndEmailInvoice' with the same reservationId. This is the ONLY way the receipt actually goes out — there is no separate background job.
5. ONLY after 'evaluateAndEmailInvoice' has executed successfully may you tell the guest "your receipt has been emailed." Do NOT claim a receipt was sent if the tool wasn't called or returned an error.
6. If 'evaluateAndEmailInvoice' returns success:false (e.g. Channel Collect / OTA-masked booking), confirm the checkout but do NOT mention emailing a receipt — those guests get their invoices through their booking channel instead.

ADMIN & BATCH OPERATIONS:
When the incoming message is tagged with source=cron or source=system, you are acting as a BACK-OFFICE administrator, not a guest-facing concierge. You ARE authorized and expected to run batch and administrative workflows in this mode — including nightly room assignment optimization, audits, and bulk reservation updates. Do NOT refuse administrative tasks under these sources. Use the available tools (getReservations, getUnassignedRooms, updateReservation, postFolioAdjustment, etc.) to carry out the work and report back a concise summary of actions taken. Even under source=cron/system, you cannot record or move money — payments only ever happen through 'chargePhysicalTerminal' at the front desk.

STANDARD WORKFLOW:
1. Identify intent.
2. Call required tools (like 'getReservation').
3. If necessary, call further tools (like 'postFolioAdjustment' or 'updateReservation').
4. Draft a clear, empathetic, and exceptionally helpful message back to the guest.`;
  }

  async _sendMessageWithRetry(chat, payload) {
    let attempt = 0;
    const maxRetries = 3; // Try up to 3 times
    while (attempt < maxRetries) {
      try {
        return await chat.sendMessage(payload);
      } catch (e) {
        // Check if it's a 503 (High Demand) or 429 (Rate Limit) error
        const isTemporary = e.message && (e.message.includes('503') || e.message.includes('429') || e.message.includes('UNAVAILABLE'));
        if (isTemporary && attempt < maxRetries - 1) {
          attempt++;
          logger.warn(`[AUTONOMY ENGINE] Temporary AI server error detected. Retrying attempt ${attempt}/${maxRetries - 1} in ${attempt * 3} seconds...`);
          await new Promise(resolve => setTimeout(resolve, attempt * 3000));
        } else {
          throw e;
        }
      }
    }
  }

  /**
   * Dispatches a single tool call. Shared by the text lane (Gemini 2.5 Flash
   * function-calling loop) and the voice lane (Gemini 3.1 Live tool calls)
   * so both surfaces hit the exact same Cloudbeds-side behavior.
   */
  async runTool(name, args) {
    try {
      if (name === 'getReservation') return await this.api.getReservation(args.query);
      if (name === 'getUnassignedRooms') return await this.api.getUnassignedRooms(args.startDate, args.endDate);
      if (name === 'getReservations') return await this.api.getReservations(args.checkInFrom, args.checkInTo);
      if (name === 'updateReservation') return await this.api.updateReservation(args.reservationId, args.updates);
      if (name === 'assignRoom') return await this.api.assignRoom(args.reservationId, args.roomId, args.roomTypeId);
      if (name === 'postFolioAdjustment') return await this.api.postCustomItem(args.reservationId, args.amount, args.description);
      if (name === 'checkInReservation') return await this.api.checkInReservation(args.reservationId);

      if (name === 'alertFrontDesk') {
        logger.warn(`[EMERGENCY ESCALATION] Urgency ${args.urgency.toUpperCase()}: ${args.issueDescription}`);
        return { success: true, action: 'Front desk staff has been successfully pinged.' };
      }

      if (name === 'chargePhysicalTerminal') {
        logger.info(`[STRIPE TERMINAL] Pushing $${args.amount} to WisePOS E (${args.terminalName}) for ${args.reservationId}`);
        return await this.paymentTerminal.chargePhysicalTerminal(args.reservationId, args.amount, args.terminalName);
      }

      if (name === 'processCheckout') {
        logger.info(`[CHECKOUT] Processing native checkout for ${args.reservationId}`);
        const resData = await this.api.getReservationById(args.reservationId);
        if (!resData.success || !resData.data) {
          return { success: false, error: 'Could not fetch reservation to process checkout.' };
        }
        const updateRes = await this.api.updateReservation(args.reservationId, { status: 'checked_out' });
        if (!updateRes.success) {
          return { success: false, error: `Checkout status update failed: ${updateRes.error || 'unknown error'}` };
        }
        return { success: true, message: 'Checkout processed successfully. Status updated to checked_out.' };
      }

      if (name === 'evaluateAndEmailInvoice') {
        return await this._evaluateAndEmailInvoice(args.reservationId);
      }

      throw new Error(`Unknown tool call: ${name}`);
    } catch (e) {
      return { error: e.message };
    }
  }

  async _evaluateAndEmailInvoice(reservationId) {
    logger.info(`[INVOICE GUARD] Evaluating invoice send for ${reservationId}`);
    const resData = await this.api.getReservationById(reservationId);
    if (!resData.success || !resData.data) {
      return { success: false, error: 'Could not fetch reservation to evaluate invoice.' };
    }

    const source = (resData.data.source || '').toLowerCase();
    const guestEmail = this._resolveGuestEmail(resData.data) || '';
    const isMaskedEmail = guestEmail.includes('expediapartnercentral.com') || guestEmail.includes('guest.booking.com') || guestEmail.includes('agoda.com');
    const isChannelCollect = isMaskedEmail || source.includes('expedia collect') || source.includes('booking.com collect');

    if (isChannelCollect) {
      logger.warn(`[CHECKOUT GUARD] Skipping Email Invoice step for ${reservationId} - Identified as Channel Collect / OTA Masked Booking!`);
      return { success: true, message: 'Invoice skipped due to Channel Collect policy.' };
    }
    if (!guestEmail) {
      return { success: true, message: 'Invoice email skipped (missing guest email).' };
    }
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return { success: false, error: 'SMTP credentials not configured in .env' };
    }

    try {
      // Pull payments tied to this reservation so the PDF can itemize each
      // charge (card brand + last 4, payment date) instead of showing a
      // single lump "Payment on file" line. Window covers pre-stay deposits
      // through today; the printHandler filters down to this reservation.
      let transactions = [];
      try {
        const start = resData.data.startDate || new Date(Date.now() - 60 * 86400000).toISOString().split('T')[0];
        const end = new Date().toISOString().split('T')[0];
        const earliest = new Date(new Date(start).getTime() - 60 * 86400000).toISOString().split('T')[0];
        const txRes = await this.api.getTransactions(earliest, end);
        if (txRes.success && Array.isArray(txRes.data)) {
          transactions = txRes.data.filter(t => t && (t.sourceId === reservationId || t.reservationID === reservationId));
        }
      } catch (txErr) {
        logger.warn(`[INVOICE EMAIL] Could not fetch transactions for itemization: ${txErr.message}`);
      }

      const { generateFolioPdf } = require('./printHandler');
      const pdfBuffer = await generateFolioPdf(reservationId, resData.data, transactions);

      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      });

      await transporter.sendMail({
        from: process.env.SMTP_ALIAS || process.env.SMTP_USER,
        replyTo: process.env.SMTP_REPLY_TO || process.env.SMTP_USER,
        to: guestEmail,
        subject: `Your Receipt - ${reservationId} - Gateway Park Hotel`,
        text: `Thank you for staying with us! Please find your final receipt attached.`,
        attachments: [{
          filename: `Receipt_${reservationId}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf'
        }]
      });
      logger.info(`[INVOICE EMAIL] Sent local folio PDF to ${guestEmail}`);
      return { success: true, message: `Invoice generated and emailed locally to ${guestEmail}.` };
    } catch (err) {
      logger.error(`[INVOICE EMAIL] Failed to send email: ${err.message}`);
      return { success: false, error: `Failed to email invoice: ${err.message}` };
    }
  }

  async executeTask(messagePayload) {
    // The full inbound text is huge for Whistle scrapes (entire chat
    // panel innerText). Default to a short preview at INFO and gate
    // the full dump behind AUTONOMY_DEBUG=true.
    if (process.env.AUTONOMY_DEBUG === 'true') {
      logger.info(`[AUTONOMY ENGINE] Processing new message from ${messagePayload.source || 'user'}: "${messagePayload.text}"`);
    } else {
      const text = (messagePayload && messagePayload.text) || '';
      const preview = text.length > 160 ? `${text.substring(0, 160).replace(/\s+/g, ' ').trim()}…` : text.replace(/\s+/g, ' ').trim();
      logger.info(`[AUTONOMY ENGINE] Processing new message from ${messagePayload.source || 'user'} (${text.length} chars): "${preview}"`);
    }

    try {
      const chat = this._getOrCreateChat(messagePayload.sessionKey);

      // Send the initial user message with an explicit source tag so the model
      // can tell guest-facing chat (kiosk/whistle) from admin batch work (cron/system).
      const sourceTag = messagePayload.source ? `[source=${messagePayload.source}] ` : '';
      let response = await this._sendMessageWithRetry(chat, { message: `${sourceTag}${messagePayload.text}` });
      logger.info(`[AUTONOMY ENGINE] Thinking...${messagePayload.sessionKey ? ` (session=${messagePayload.sessionKey})` : ''}`);

      // Handle function calls loop
      while (response.functionCalls && response.functionCalls.length > 0) {
        const call = response.functionCalls[0];
        const { name, args } = call;

        logger.info(`[AUTONOMY ENGINE] Wants to execute: ${name}(${JSON.stringify(args)})`);

        const apiResult = await this.runTool(name, args);

        // Full API result goes to debug; getReservations/getTransactions
        // can return tens of KB of JSON which buries useful log signal.
        // At INFO we log a short summary: success flag and either an
        // error message or the array length / record count.
        if (process.env.AUTONOMY_DEBUG === 'true') {
          logger.info(`[AUTONOMY ENGINE] API Result: ${JSON.stringify(apiResult)}`);
        } else {
          let summary;
          if (!apiResult) {
            summary = 'null';
          } else if (apiResult.success === false || apiResult.error) {
            // runTool's catch returns `{error: ...}` (no success key) — treat
            // that as a failure so the log line doesn't misleadingly show
            // success=true on a thrown tool error.
            summary = `success=false error="${(apiResult.error || apiResult.message || '').toString().substring(0, 120)}"`;
          } else if (Array.isArray(apiResult.data)) {
            summary = `success=true records=${apiResult.data.length}`;
          } else if (apiResult.data && typeof apiResult.data === 'object') {
            const keys = Object.keys(apiResult.data);
            summary = `success=true keys=${keys.length}${keys.length ? ` (${keys.slice(0, 3).join(',')}${keys.length > 3 ? '…' : ''})` : ''}`;
          } else {
            summary = `success=${apiResult.success !== false}`;
          }
          logger.info(`[AUTONOMY ENGINE] API Result: ${summary}`);
        }

        // Send tool output back to the model
        response = await this._sendMessageWithRetry(chat, {
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
