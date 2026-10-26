# Froxy V1 Standalone — website + WhatsApp bot

This project combines the pairing website and Baileys bot in one Node.js service. A user enters their own WhatsApp number on the website, receives a pairing code, and links the account through WhatsApp's official “Link with phone number” flow. Each number gets a separate auth directory under `DATA_DIR/sessions/`.

## Before deploying
- Use Node.js 20+ and a host that supports persistent private storage.
- Set `DATA_DIR` to a persistent directory that is NOT publicly served.
- Set `SITE_ORIGIN` to the exact HTTPS origin of your site.
- Set `OWNER_NUMBER` only in the host's private environment settings, if you want owner notifications.
- Set `SUPPORT_LINK` to your real support URL if you have one.
- Never commit `data/`, auth files, `.env`, or pairing codes to GitHub.
- Add CAPTCHA or another durable anti-abuse control before sharing the public portal widely.
- Review the current Baileys terms and WhatsApp rules before production use. Use only with account-owner authorization.

## Run
1. Upload the project to your Node.js host.
2. Install dependencies with `npm install`.
3. Start with `npm start`.
4. Open the service URL. `/api/health` reports basic service status.

## What is included
- Classy purple Froxy V1 website.
- Website `/api/pair` endpoint.
- Separate saved auth folder for each phone number.
- Session restore after restart (requires persistent disk).
- Linked-success message sent to the linked account's own chat on first successful connection.
- `.help`, `.alive`, `.froxy`, `.tagall`, `.hidetag`, and `.viewonce` privacy info.
- Simple greeting auto-reply.

## Important limitations
This is a starter implementation and has not been tested against your exact hosting setup or your existing project. Multi-account WhatsApp sessions consume memory and can be disconnected by WhatsApp; use a modest account limit and monitor the service. The request throttles in this starter are in-memory and reset on restart. Add stronger abuse protection before public launch.

`.froxy` is a placeholder helper, not a live AI model; it needs a separate AI provider integration to answer questions. The bot intentionally does not download, save, or bypass view-once media, because that would defeat the sender's privacy choice.

The included `linkedMessage` uses `SUPPORT_LINK` and `SITE_ORIGIN` environment variables rather than inventing a support invite. It identifies the bot as Froxy V1.
