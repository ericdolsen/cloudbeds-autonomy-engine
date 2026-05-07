#!/usr/bin/env node
/**
 * One-time QuickBooks Online OAuth setup.
 *
 * Run this once after creating the Intuit Developer app:
 *
 *   node scripts/qboConnect.js
 *
 * It opens your browser to Intuit's authorize URL, captures the redirect
 * with the auth code, exchanges it for a refresh token, and writes the
 * token + realm ID into .env. From then on the server uses the refresh
 * token automatically — access tokens auto-refresh every hour.
 *
 * Re-run this if:
 *   - You revoke the app in QBO
 *   - You connect to a different company (production vs sandbox)
 *   - The refresh token expires (Intuit rotates it after ~100 days of
 *     inactivity)
 *
 * Required env vars to be set BEFORE running this script:
 *   QBO_CLIENT_ID
 *   QBO_CLIENT_SECRET
 *   QBO_ENVIRONMENT       'sandbox' or 'production' — defaults to sandbox
 *
 * Writes back to .env (creating these if absent):
 *   QBO_REFRESH_TOKEN
 *   QBO_REALM_ID
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const axios = require('axios');
const { exec } = require('child_process');

require('dotenv').config();

const CLIENT_ID = process.env.QBO_CLIENT_ID;
const CLIENT_SECRET = process.env.QBO_CLIENT_SECRET;
const ENV = (process.env.QBO_ENVIRONMENT || 'sandbox').toLowerCase();
const REDIRECT_URI = 'http://localhost:8888/qbo/callback';
const SCOPE = 'com.intuit.quickbooks.accounting';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ERROR: QBO_CLIENT_ID and QBO_CLIENT_SECRET must be set in .env before running this script.');
  process.exit(1);
}

const state = crypto.randomBytes(16).toString('hex');
const authorizeUrl = new URL('https://appcenter.intuit.com/connect/oauth2');
authorizeUrl.searchParams.set('client_id', CLIENT_ID);
authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authorizeUrl.searchParams.set('response_type', 'code');
authorizeUrl.searchParams.set('scope', SCOPE);
authorizeUrl.searchParams.set('state', state);

console.log('\n=== QuickBooks Online OAuth Setup ===\n');
console.log(`Environment: ${ENV}`);
console.log(`Redirect URI: ${REDIRECT_URI}`);
console.log(`\nMake sure ${REDIRECT_URI} is in the app's "Redirect URIs" list at developer.intuit.com.\n`);
console.log('Opening browser for QBO authorization...');
console.log(`If the browser doesn't open, paste this URL manually:\n  ${authorizeUrl}\n`);

// Best-effort cross-platform browser open. The user can also click the
// printed URL if this fails.
function openBrowser(url) {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  try { exec(cmd); } catch (e) { /* user can click the URL */ }
}
openBrowser(authorizeUrl.toString());

// Tiny one-shot HTTP server to receive Intuit's redirect.
const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, REDIRECT_URI);
  if (reqUrl.pathname !== '/qbo/callback') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const code = reqUrl.searchParams.get('code');
  const realmId = reqUrl.searchParams.get('realmId');
  const returnedState = reqUrl.searchParams.get('state');
  const error = reqUrl.searchParams.get('error');

  if (error) {
    sendHtml(res, `<h1>QBO authorization failed</h1><pre>${escapeHtml(error)}</pre>`);
    console.error(`\nERROR: Intuit returned error="${error}". Aborting.`);
    server.close();
    process.exit(1);
  }
  if (returnedState !== state) {
    sendHtml(res, '<h1>State mismatch — possible CSRF. Aborting.</h1>');
    console.error('\nERROR: State token mismatch. Aborting.');
    server.close();
    process.exit(1);
  }
  if (!code || !realmId) {
    sendHtml(res, '<h1>Missing code or realmId in callback.</h1>');
    console.error('\nERROR: code/realmId missing from callback. Aborting.');
    server.close();
    process.exit(1);
  }

  console.log(`\nReceived auth code from Intuit (realmId=${realmId}). Exchanging for refresh token...`);

  try {
    const tokenResp = await axios.post(
      'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      }).toString(),
      {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        }
      }
    );

    const { refresh_token, access_token, expires_in } = tokenResp.data;
    if (!refresh_token) throw new Error('Intuit response missing refresh_token');

    writeEnv({ QBO_REFRESH_TOKEN: refresh_token, QBO_REALM_ID: realmId });

    sendHtml(res, `
      <h1 style="color:#15803d;">QBO authorization successful</h1>
      <p>You can close this tab. Refresh token + realm ID written to .env.</p>
    `);
    console.log('\nSUCCESS:');
    console.log(`  QBO_REALM_ID=${realmId}`);
    console.log(`  QBO_REFRESH_TOKEN=<written to .env, ${refresh_token.length} chars>`);
    console.log(`  Access token issued (expires in ${expires_in}s — auto-refreshed by the server).`);
    console.log('\nYou can now start the server. The integration will use these credentials.\n');
  } catch (e) {
    const msg = e.response ? `${e.response.status} ${JSON.stringify(e.response.data)}` : e.message;
    sendHtml(res, `<h1 style="color:#b91c1c;">Token exchange failed</h1><pre>${escapeHtml(msg)}</pre>`);
    console.error(`\nERROR: token exchange failed: ${msg}`);
    process.exit(1);
  }

  server.close();
  process.exit(0);
});

server.listen(8888, () => {
  console.log('Listening on http://localhost:8888 for the OAuth redirect...');
});

function sendHtml(res, body) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:32px;max-width:560px;margin:auto;">${body}</body></html>`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Append-or-update keys in .env. We don't pull in dotenv-expand for this —
// the format is simple and the alternative is leaving the secrets in chat
// for the operator to copy-paste, which is exactly what we're trying to
// avoid.
function writeEnv(updates) {
  const envPath = path.join(__dirname, '..', '.env');
  let lines = [];
  try {
    if (fs.existsSync(envPath)) {
      lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    }
  } catch (e) { /* fall through with empty */ }

  for (const [k, v] of Object.entries(updates)) {
    const line = `${k}=${v}`;
    const idx = lines.findIndex(l => l.startsWith(`${k}=`) || l.startsWith(`# ${k}=`));
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  fs.writeFileSync(envPath, lines.join('\n'), { mode: 0o600 });
}
