const { modelRouter } = require('./modelRouter');
const { logger } = require('./logger');

/**
 * VoiceLine — bridges an inbound phone call to Gemini 3.1 Live for real-time
 * conversational audio.
 *
 * Architecture:
 *   PSTN → Twilio Voice → <Stream> Media Streams WS  →  this module
 *                                                       ↓
 *                                              Gemini Live WS (audio in/out)
 *
 * Twilio sends μ-law 8kHz audio frames; Gemini Live expects 16-bit PCM 16kHz.
 * The transcoding hooks are stubbed below — wire them up once the Twilio
 * number and credentials are provisioned. AutonomyEngine tools (getReservation,
 * postPayment, alertFrontDesk, …) are exposed to Gemini Live via the same
 * function declarations the text lane uses, so a caller can reach the same
 * actions a guest SMS or kiosk visitor can.
 */
class VoiceLine {
  constructor(autonomyEngine, router = modelRouter) {
    this.engine = autonomyEngine;
    this.router = router;
    this.activeCalls = new Map(); // callSid -> session
  }

  /**
   * Twilio fetches this URL when a call comes in. Returns TwiML that opens
   * a bidirectional Media Stream back to /voice/stream.
   */
  twiml({ host }) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/voice/stream" />
  </Connect>
</Response>`;
  }

  /**
   * Wire this onto an upgrade-capable route. `ws` is a Twilio Media Streams
   * websocket; this method opens a paired Gemini Live session and pumps
   * audio in both directions.
   */
  async handleTwilioStream(ws) {
    const sessionDescriptor = this.router.voiceSession({
      systemInstruction: this._buildSystemInstruction()
    });

    logger.info(`[VOICE LINE] New call → ${sessionDescriptor.model} (voice=${sessionDescriptor.voice})`);

    let callSid = null;
    let live = null;

    try {
      live = await this._connectGeminiLive(sessionDescriptor);
    } catch (e) {
      logger.error(`[VOICE LINE] Failed to open Gemini Live session: ${e.message}`);
      try { ws.close(); } catch (_) {}
      return;
    }

    ws.on('message', (raw) => {
      let evt;
      try { evt = JSON.parse(raw.toString()); } catch (_) { return; }
      if (evt.event === 'start') {
        callSid = evt.start.callSid;
        this.activeCalls.set(callSid, { ws, live, startedAt: Date.now() });
        logger.info(`[VOICE LINE] Call ${callSid} started.`);
      } else if (evt.event === 'media' && evt.media?.payload) {
        const muLawB64 = evt.media.payload;
        const pcm16k = this._muLawToPcm16k(muLawB64);
        live.sendAudio(pcm16k);
      } else if (evt.event === 'stop') {
        logger.info(`[VOICE LINE] Call ${callSid} hung up.`);
        live.close();
        this.activeCalls.delete(callSid);
      }
    });

    live.on('audio', (pcm16k) => {
      const muLawB64 = this._pcm16kToMuLaw(pcm16k);
      ws.send(JSON.stringify({ event: 'media', media: { payload: muLawB64 } }));
    });

    live.on('toolCall', async ({ name, args }) => {
      // Reuse the AutonomyEngine's tool dispatcher so the voice agent can
      // run the same actions guest SMS can (lookup, payment, escalate, …).
      const result = await this.engine.runTool(name, args).catch(e => ({ error: e.message }));
      live.sendToolResult(name, result);
    });

    ws.on('close', () => {
      if (callSid) this.activeCalls.delete(callSid);
      try { live.close(); } catch (_) {}
    });
  }

  _buildSystemInstruction() {
    const base = this.engine.getSystemInstruction();
    return `${base}\n\nVOICE PROTOCOL:\nYou are speaking on a live phone line. Keep replies short and conversational. Never read URLs or long IDs aloud — offer to text them instead. If the caller is silent for >5s, prompt gently. If asked to transfer, call alertFrontDesk with urgency='high'.`;
  }

  /**
   * Establish the Gemini Live websocket. Implementation lives in a thin
   * adapter so we can swap providers (e.g. an Anthropic real-time voice API)
   * without touching the Twilio side.
   *
   * NOTE: This is a stub — the actual @google/genai live API contract should
   * be wired in once the SDK version supporting `gemini-3.1-live` is pinned.
   */
  async _connectGeminiLive(_descriptor) {
    throw new Error('Gemini Live adapter not yet wired. Pin @google/genai version that exports the live audio API and implement _connectGeminiLive.');
  }

  _muLawToPcm16k(_b64) {
    // TODO: implement μ-law 8kHz → PCM16 16kHz transcode (see RFC 1057).
    return Buffer.alloc(0);
  }

  _pcm16kToMuLaw(_pcm) {
    // TODO: implement PCM16 16kHz → μ-law 8kHz for Twilio playback.
    return '';
  }
}

module.exports = { VoiceLine };
