# Cloudflare Tunnel — public webhook URL for the local server

The autonomy engine runs on a PC on your local network. Webhook providers
(Whistle/Twilio for inbound SMS, Cloudbeds for reservation events) need a
public HTTPS URL to reach it. Cloudflare Tunnel gives you one for free with
no port forwarding.

## One-time setup (Windows / Mac / Linux)

1. **Install `cloudflared`** on the same PC that runs the server:
   - Windows: `winget install --id Cloudflare.cloudflared`
     (or download the `.msi` from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
   - macOS: `brew install cloudflared`
   - Linux: see https://pkg.cloudflare.com

2. **Authenticate once** (opens a browser, pick a Cloudflare account + zone):
   ```
   cloudflared tunnel login
   ```

3. **Create the named tunnel** (one-time; name it anything — `hotel-kiosk` below):
   ```
   cloudflared tunnel create hotel-kiosk
   ```
   This outputs a tunnel UUID and saves a credentials file locally.

4. **Point a hostname at the tunnel** (replace `kiosk.your-domain.com` with a
   subdomain on a zone you control in Cloudflare):
   ```
   cloudflared tunnel route dns hotel-kiosk kiosk.your-domain.com
   ```

5. **Create a config file** at `~/.cloudflared/config.yml` (or
   `%USERPROFILE%\.cloudflared\config.yml` on Windows):
   ```yaml
   tunnel: hotel-kiosk
   credentials-file: C:\Users\you\.cloudflared\<UUID>.json   # path from step 3
   ingress:
     - hostname: kiosk.your-domain.com
       service: http://localhost:3000
     - service: http_status:404
   ```

## Running the tunnel

**Manual (foreground, good for testing):**
```
cloudflared tunnel run hotel-kiosk
```

**As a Windows service (starts at boot):**
```
cloudflared service install
```
This reads `%USERPROFILE%\.cloudflared\config.yml` and runs the tunnel in
the background forever.

## Using the public URL

Once running, `https://kiosk.your-domain.com/...` proxies to your local
`http://localhost:3000/...`. Configure the following webhook endpoints on
each provider:

| Provider  | Webhook URL |
|-----------|-------------|
| Whistle   | `https://kiosk.your-domain.com/api/webhooks/whistle` |
| Twilio    | `https://kiosk.your-domain.com/api/webhooks/whistle` (same handler) |
| Cloudbeds | `https://kiosk.your-domain.com/api/webhooks/cloudbeds` |

## Quick test

With the server and the tunnel both running:

```
curl -X POST https://kiosk.your-domain.com/api/webhooks/whistle \
  -H "Content-Type: application/json" \
  -d '{"guest_phone":"+15552219988","message":"hi, what time is checkout?"}'
```

You should see:
1. `[WEBHOOK] Incoming SMS/Message from Whistle` in `logs/`.
2. `[API CALL] getReservationsByPhone: ...` (the context lookup).
3. `[AUTONOMY ENGINE] Final Output: ...` (the drafted reply).
4. `[MESSAGING] provider=... (N chars)` (the outbound send).
5. In the employee dashboard activity feed: `Guest SMS — Replied to +1555...`

If `MESSAGING_PROVIDER=none` (the default), step 4 will log
`[MESSAGING] No provider configured. Dry-run: ...` — the agent's reply is
logged but not actually sent. Flip to `twilio` or `whistle` in `.env` (see
README) when ready to go live.

## Notes

- The tunnel does NOT affect the local kiosk (still `http://localhost:3000`).
  Only external callers need the public hostname.
- Cloudflare Tunnel is encrypted end-to-end; no need for a separate SSL cert.
- If you don't own a domain on Cloudflare, a free `trycloudflare.com`
  hostname works too: `cloudflared tunnel --url http://localhost:3000`
  (but the hostname is random and changes between runs — fine for testing,
  not for production webhook configuration).
