# Cloudbeds Autonomy Engine

An intelligent, API-driven Autonomy Engine powered by Gemini 3.1 Pro to automate hotel operations, guest communications, and check-outs via the Cloudbeds Property Management System.

## Architecture
This project replaces traditional, brittle headless-browser automation (e.g., Playwright) with a deterministic logic loop. The Engine intercepts raw incoming webhook messaging (from guests, staff, or internal automated CRON jobs), leverages an LLM to reason about the context, and executes backend structured API calls natively against Cloudbeds.

### Core Files
- `server.js`: Exposes REST endpoints to receive Cloudbeds Chat Webhooks and Kiosk inputs.
- `src/autonomyEngine.js`: The "brain" module utilizing the `@google/genai` SDK to map intent -> API calls.
- `src/cloudbedsApi.js`: Standard backend wrapper targeting `api.cloudbeds.com`.

## Local Development / Testing
1. Configure your `.env` variables:
   - `GEMINI_API_KEY`
   - `GEMINI_MODEL="gemini-3.1-pro"` (or `gemini-3.1-flash-lite-preview` for simple triage)
   - `CLOUDBEDS_API_KEY`
2. Run the application:
   ```bash
   npm start
   ```
3. Test locally using the development trigger:
   ```bash
   curl -X POST http://localhost:3000/api/test -H "Content-Type: application/json" -d "{\"text\": \"Simulated guest request here\"}"
   ```
