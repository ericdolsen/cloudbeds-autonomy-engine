const { GoogleGenAI } = require('@google/genai');
const { logger } = require('./logger');

/**
 * ModelRouter — central abstraction for picking the right model per task lane.
 *
 *   text   → Gemini 2.5 Flash         (high-volume guest text, tool calling, batch ops)
 *   vision → Claude Sonnet 4.5        (zero-mistake screen-clicking on the Cloudbeds UI)
 *   voice  → Gemini 3.1 Live          (real-time bidirectional phone audio)
 *
 * Each lane is exposed as a getClient() factory + a routeXxx() helper. Callers
 * that need raw access (e.g. the AutonomyEngine, which manages multi-turn chat
 * sessions) should use getClient(); one-shot callers use the routeXxx helpers.
 *
 * Models are fully overridable via env so we can swap families without code
 * changes (e.g. point the text lane at a Pro model for a tricky workflow).
 */
class ModelRouter {
  constructor() {
    this.lanes = {
      text: {
        provider: 'google',
        model: process.env.TEXT_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        apiKeyEnv: 'GEMINI_API_KEY',
        purpose: 'High-volume guest text, tool calling, admin/batch reasoning'
      },
      vision: {
        provider: 'anthropic',
        model: process.env.VISION_MODEL || 'claude-sonnet-4-5',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        purpose: 'Zero-mistake screen-clicking on the Cloudbeds UI / Whistle inbox'
      },
      voice: {
        provider: 'google',
        model: process.env.VOICE_MODEL || 'gemini-3.1-live',
        apiKeyEnv: 'GEMINI_API_KEY',
        purpose: 'Real-time, bidirectional phone-line audio'
      }
    };

    this._googleClient = null;
    this._anthropicClient = null;
  }

  describe() {
    return Object.fromEntries(
      Object.entries(this.lanes).map(([lane, cfg]) => [lane, { model: cfg.model, provider: cfg.provider }])
    );
  }

  _googleAi() {
    if (!this._googleClient) {
      if (!process.env.GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is not set; text/voice lanes unavailable.');
      }
      this._googleClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }
    return this._googleClient;
  }

  _anthropic() {
    if (!this._anthropicClient) {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY is not set; vision lane unavailable.');
      }
      let Anthropic;
      try {
        Anthropic = require('@anthropic-ai/sdk');
      } catch (e) {
        throw new Error("@anthropic-ai/sdk is not installed. Run `npm install @anthropic-ai/sdk` to enable the vision lane.");
      }
      const Ctor = Anthropic.Anthropic || Anthropic.default || Anthropic;
      this._anthropicClient = new Ctor({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return this._anthropicClient;
  }

  /**
   * Returns a configured Gemini chat session for the text lane. The
   * AutonomyEngine uses this to keep multi-turn guest threads warm.
   */
  createTextChat({ systemInstruction, tools, temperature = 0.1 } = {}) {
    const lane = this.lanes.text;
    const ai = this._googleAi();
    return ai.chats.create({
      model: lane.model,
      config: {
        systemInstruction,
        tools,
        temperature,
        // Gemini 3.x models auto-attach a built-in tool (google_search)
        // to every request. When that's combined with our
        // functionDeclarations the API rejects with
        // "Please enable tool_config.include_server_side_tool_invocations
        // to use Built-in tools with Function calling." Setting this
        // flag opts us in to the mixed mode — built-in invocations
        // run server-side and we keep using our own function calls
        // alongside. No-op on older models that don't auto-attach.
        toolConfig: { includeServerSideToolInvocations: true }
      }
    });
  }

  textModel() {
    return this.lanes.text.model;
  }

  /**
   * One-shot vision call. Given a screenshot (PNG base64) and a brief telling
   * Claude what action to take, returns Claude's structured plan.
   *
   * The vision lane is the "zero-mistake" path: Claude reasons about the
   * pixels and returns either coordinates or a short DOM directive. Callers
   * (e.g. PaymentTerminal) execute the directive against Playwright.
   */
  async routeVisionClick({ screenshotPngBase64, instruction, viewport }) {
    if (!screenshotPngBase64) throw new Error('routeVisionClick requires screenshotPngBase64');
    const lane = this.lanes.vision;
    const client = this._anthropic();

    const sys = `You are a UI automation co-pilot for the Cloudbeds web PMS. You will be shown a screenshot and asked to identify exactly one next action. Reply with strict JSON: {"action": "click"|"type"|"wait"|"done"|"abort", "target": {"x": number, "y": number} | {"selector": string} | null, "text": string | null, "reason": string}. Coordinates must be in the supplied viewport (top-left origin, integer pixels). Never invent UI elements you cannot see. If the requested target is not visible, return action="abort" with a reason.`;

    logger.info(`[VISION ROUTER] Asking ${lane.model} for next click: "${instruction.substring(0, 80)}"`);

    const resp = await client.messages.create({
      model: lane.model,
      max_tokens: 512,
      system: sys,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotPngBase64 } },
          { type: 'text', text: `Viewport: ${JSON.stringify(viewport || { width: 1920, height: 1080 })}\n\nGoal: ${instruction}\n\nReturn only the JSON object.` }
        ]
      }]
    });

    const raw = resp.content.find(c => c.type === 'text')?.text || '{}';
    const match = raw.match(/\{[\s\S]*\}/);
    try {
      return JSON.parse(match ? match[0] : raw);
    } catch (e) {
      logger.warn(`[VISION ROUTER] Could not parse Claude reply, returning abort. Raw: ${raw.substring(0, 200)}`);
      return { action: 'abort', target: null, text: null, reason: `Unparseable model reply: ${raw.substring(0, 120)}` };
    }
  }

  /**
   * Voice lane factory. Returns a session descriptor the VoiceLine module can
   * use to open a Gemini Live websocket. We don't establish the connection
   * here — Live sessions are stateful and tied to a single phone call.
   */
  voiceSession({ systemInstruction, voice = 'Aoede' } = {}) {
    const lane = this.lanes.voice;
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not set; voice lane unavailable.');
    }
    return {
      provider: lane.provider,
      model: lane.model,
      voice,
      systemInstruction,
      apiKey: process.env.GEMINI_API_KEY
    };
  }
}

// Singleton — every caller shares one router so we don't churn API clients.
const modelRouter = new ModelRouter();

module.exports = { ModelRouter, modelRouter };
