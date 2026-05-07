'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

/**
 * Thin wrapper over the Intuit QuickBooks Online REST API.
 *
 * Why we don't use the official `node-quickbooks` SDK:
 *   - Last meaningful release was 2 years ago.
 *   - It hides the request shape behind callback wrappers and we end up
 *     reading the source to understand what's on the wire.
 *   - Auth token rotation is the one thing we actually need to be careful
 *     about, and the SDK's persistence model fights with our .env-based
 *     secrets layout.
 * Direct axios calls are simpler and the surface we use is small.
 *
 * Auth flow:
 *   - On boot we read QBO_REFRESH_TOKEN + QBO_REALM_ID from .env.
 *   - The first request triggers _refreshAccessToken() which exchanges
 *     the refresh token for a fresh access token (1h TTL) and a
 *     potentially-rotated refresh token.
 *   - If Intuit rotates the refresh token (it does occasionally), we
 *     write the new value back to .env so the next process boot
 *     continues to work without re-running scripts/qboConnect.js.
 *
 * Env vars (set by scripts/qboConnect.js):
 *   QBO_CLIENT_ID, QBO_CLIENT_SECRET   — from developer.intuit.com app
 *   QBO_REFRESH_TOKEN                  — from OAuth handshake
 *   QBO_REALM_ID                       — the company's QBO id
 *   QBO_ENVIRONMENT                    — 'sandbox' (default) or 'production'
 *   QBO_MINOR_VERSION                  — pinned to 75 (current stable as of
 *                                        the schema we're targeting); bump
 *                                        only with a tested change.
 */

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const SANDBOX_API = 'https://sandbox-quickbooks.api.intuit.com';
const PROD_API    = 'https://quickbooks.api.intuit.com';
const MINOR_VERSION = process.env.QBO_MINOR_VERSION || '75';

class QuickBooks {
  constructor() {
    this.clientId     = process.env.QBO_CLIENT_ID;
    this.clientSecret = process.env.QBO_CLIENT_SECRET;
    this.refreshToken = process.env.QBO_REFRESH_TOKEN;
    this.realmId      = process.env.QBO_REALM_ID;
    this.env          = (process.env.QBO_ENVIRONMENT || 'sandbox').toLowerCase();
    this.apiBase      = this.env === 'production' ? PROD_API : SANDBOX_API;

    // Access-token cache. We refresh ~5 minutes before expiry so a
    // long-running request never trips on a just-expired token.
    this._accessToken = null;
    this._accessTokenExpiresAt = 0;
    this._refreshPromise = null;

    // Resolved at first use: maps logical names ("4000", "Rooms") onto
    // QBO internal IDs. Cached for the process lifetime; restart picks
    // up account or class additions in the QBO chart.
    this._accountIdByNum = null;  // AcctNum string → Id string
    this._classIdByName  = null;  // class Name (case-insensitive) → Id string
  }

  isConfigured() {
    return Boolean(this.clientId && this.clientSecret && this.refreshToken && this.realmId);
  }

  // ─── Auth ─────────────────────────────────────────────────────────────

  async _accessTokenValid() {
    return this._accessToken && Date.now() < this._accessTokenExpiresAt - 5 * 60 * 1000;
  }

  async _refreshAccessToken() {
    // Coalesce concurrent refreshes — first caller does the work, others
    // await the same promise.
    if (this._refreshPromise) return this._refreshPromise;
    this._refreshPromise = (async () => {
      try {
        const resp = await axios.post(
          TOKEN_URL,
          new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: this.refreshToken
          }).toString(),
          {
            headers: {
              'Authorization': 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64'),
              'Content-Type': 'application/x-www-form-urlencoded',
              'Accept': 'application/json'
            },
            timeout: 15000
          }
        );
        const { access_token, refresh_token, expires_in } = resp.data;
        this._accessToken = access_token;
        this._accessTokenExpiresAt = Date.now() + (expires_in || 3600) * 1000;
        // Intuit rotates refresh tokens occasionally; persist the new
        // one so a process restart doesn't lose access.
        if (refresh_token && refresh_token !== this.refreshToken) {
          this.refreshToken = refresh_token;
          _persistRefreshToken(refresh_token);
          logger.info(`[QBO] Refresh token rotated; persisted to .env.`);
        }
      } finally {
        this._refreshPromise = null;
      }
    })();
    return this._refreshPromise;
  }

  async _authedHeaders() {
    if (!await this._accessTokenValid()) await this._refreshAccessToken();
    return {
      'Authorization': `Bearer ${this._accessToken}`,
      'Accept': 'application/json'
    };
  }

  // ─── Low-level REST ───────────────────────────────────────────────────

  /**
   * GET against the QBO REST surface. Passes minorversion automatically.
   * Returns parsed body. Throws on non-2xx with the QBO fault message
   * pulled out of `Fault.Error[].Detail` so logs are useful.
   */
  async _get(pathSuffix, params = {}) {
    const url = `${this.apiBase}/v3/company/${this.realmId}${pathSuffix}`;
    const headers = await this._authedHeaders();
    try {
      const resp = await axios.get(url, {
        headers,
        params: { ...params, minorversion: MINOR_VERSION },
        timeout: 30000
      });
      return resp.data;
    } catch (e) {
      throw _wrapQboError(e, 'GET ' + pathSuffix);
    }
  }

  async _post(pathSuffix, body, params = {}) {
    const url = `${this.apiBase}/v3/company/${this.realmId}${pathSuffix}`;
    const headers = {
      ...(await this._authedHeaders()),
      'Content-Type': 'application/json'
    };
    try {
      const resp = await axios.post(url, body, {
        headers,
        params: { ...params, minorversion: MINOR_VERSION },
        timeout: 30000
      });
      return resp.data;
    } catch (e) {
      throw _wrapQboError(e, 'POST ' + pathSuffix);
    }
  }

  // ─── Higher-level operations ──────────────────────────────────────────

  /**
   * Run a QBO SQL query. The QBO query language is a tiny SQL subset
   * — used here for SELECT lookups against Account, Class, JournalEntry.
   */
  async query(sql) {
    const data = await this._get('/query', { query: sql });
    return data.QueryResponse || {};
  }

  /**
   * Build the AcctNum → Id and Class.Name → Id lookups. Cached per
   * process; restart to pick up new accounts. Quiet no-op if QBO has
   * no Class entities (Classes is a feature you opt in to).
   */
  async loadChartLookups() {
    if (!this._accountIdByNum) {
      const accounts = await this.query("SELECT Id, AcctNum, Name, AccountType FROM Account WHERE Active = true MAXRESULTS 1000");
      const list = accounts.Account || [];
      this._accountIdByNum = new Map();
      for (const a of list) {
        if (a.AcctNum) this._accountIdByNum.set(String(a.AcctNum), String(a.Id));
      }
      logger.info(`[QBO] Loaded ${this._accountIdByNum.size} accounts from chart.`);
    }
    if (!this._classIdByName) {
      try {
        const classes = await this.query("SELECT Id, Name FROM Class WHERE Active = true MAXRESULTS 200");
        const list = classes.Class || [];
        this._classIdByName = new Map();
        for (const c of list) {
          if (c.Name) this._classIdByName.set(c.Name.toLowerCase(), String(c.Id));
        }
        logger.info(`[QBO] Loaded ${this._classIdByName.size} classes.`);
      } catch (e) {
        logger.warn(`[QBO] Could not load Class entities (${e.message}); class refs on JE lines will be skipped.`);
        this._classIdByName = new Map();
      }
    }
  }

  accountIdForNum(acctNum) {
    if (!this._accountIdByNum) throw new Error('loadChartLookups() must run before accountIdForNum()');
    const id = this._accountIdByNum.get(String(acctNum));
    if (!id) throw new Error(`QBO chart has no account with AcctNum="${acctNum}". Add it in the chart of accounts or update the mapping.`);
    return id;
  }

  classIdForName(name) {
    if (!this._classIdByName) return null;
    if (!name) return null;
    return this._classIdByName.get(String(name).toLowerCase()) || null;
  }

  /**
   * Find an existing JournalEntry by DocNumber. We use DocNumber as our
   * idempotency key — typically "GP-YYYY-MM-DD". Returns the JE record
   * if found, null otherwise.
   */
  async findJournalEntryByDocNumber(docNumber) {
    const safe = String(docNumber).replace(/'/g, "\\'");
    const r = await this.query(`SELECT * FROM JournalEntry WHERE DocNumber = '${safe}' MAXRESULTS 1`);
    const list = r.JournalEntry || [];
    return list[0] || null;
  }

  /**
   * POST a JournalEntry. Caller is responsible for building the Line[]
   * shape with PostingType + AccountRef + (optional) ClassRef. Returns
   * the persisted JE (with Id, SyncToken).
   */
  async createJournalEntry(je) {
    const data = await this._post('/journalentry', je);
    return data.JournalEntry;
  }

  /**
   * Update an existing JournalEntry (sparse update). Used when re-running
   * a date that already posted, so we replace the JE in-place rather than
   * creating a duplicate.
   */
  async updateJournalEntry(je) {
    if (!je.Id || !je.SyncToken) throw new Error('updateJournalEntry requires Id and SyncToken');
    const data = await this._post('/journalentry', { ...je, sparse: false });
    return data.JournalEntry;
  }

  /**
   * Cheap probe used at server boot to verify we can talk to QBO.
   */
  async ping() {
    const r = await this.query("SELECT COUNT(*) FROM Account");
    return r;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function _wrapQboError(e, label) {
  if (e.response && e.response.data && e.response.data.Fault) {
    const fault = e.response.data.Fault;
    // QBO's generic Message ("A business validation error has occurred")
    // is useless on its own — the actual cause is in Detail. Show both
    // when they differ, so debugging doesn't require digging through
    // the raw HTTP response.
    const errs = (fault.Error || []).map(x => {
      const parts = [];
      if (x.code) parts.push(`code=${x.code}`);
      if (x.element) parts.push(`element=${x.element}`);
      if (x.Message) parts.push(`msg="${x.Message}"`);
      if (x.Detail && x.Detail !== x.Message) parts.push(`detail="${x.Detail}"`);
      return parts.join(' ');
    }).join(' | ');
    const msg = `[QBO ${label}] ${e.response.status} ${fault.type || ''} ${errs}`.trim();
    return new Error(msg);
  }
  if (e.response) {
    return new Error(`[QBO ${label}] ${e.response.status} ${JSON.stringify(e.response.data).substring(0, 400)}`);
  }
  return new Error(`[QBO ${label}] ${e.message}`);
}

// Updates QBO_REFRESH_TOKEN in the host's .env file. Mirrors the helper
// in scripts/qboConnect.js — kept inline here so the runtime path doesn't
// depend on the script package layout.
function _persistRefreshToken(newToken) {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    let lines = [];
    if (fs.existsSync(envPath)) {
      lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    }
    const idx = lines.findIndex(l => l.startsWith('QBO_REFRESH_TOKEN='));
    const line = `QBO_REFRESH_TOKEN=${newToken}`;
    if (idx >= 0) lines[idx] = line; else lines.push(line);
    fs.writeFileSync(envPath, lines.join('\n'), { mode: 0o600 });
  } catch (e) {
    logger.warn(`[QBO] Could not persist rotated refresh token to .env: ${e.message}. The token still works for this process; re-run scripts/qboConnect.js if a restart fails to authenticate.`);
  }
}

module.exports = { QuickBooks };
