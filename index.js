import express from "express";
import rateLimit from "express-rate-limit";
import pino from "pino";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage
} from "@whiskeysockets/baileys";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const REGISTRY_FILE = path.join(DATA_DIR, "registry.json");
const OWNER_NUMBER = digitsOnly(process.env.OWNER_NUMBER || "");
const SITE_ORIGIN = process.env.SITE_ORIGIN || "";
const SUPPORT_LINK = process.env.SUPPORT_LINK || "";
const PREFIX = process.env.PREFIX || ".";
const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
app.disable("x-powered-by");
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS || 1));
app.use(express.json({ limit: "8kb" }));
app.use(express.static("public", { extensions: ["html"] }));

function digitsOnly(value) {
  return typeof value === "string" ? value.replace(/\D/g, "") : "";
}
function validPhone(value) {
  return /^[1-9]\d{7,14}$/.test(value);
}
function sessionKey(phone) {
  return crypto.createHash("sha256").update(phone).digest("hex").slice(0, 32);
}
function sessionPath(phone) {
  return path.join(SESSIONS_DIR, sessionKey(phone));
}
function readRegistry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
let registry = readRegistry();
function saveRegistry() {
  const tmp = `${REGISTRY_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, REGISTRY_FILE);
}
const sockets = new Map();
const pendingPairs = new Map();
const phoneRequests = new Map();
const MAX_ACTIVE = Number(process.env.MAX_ACTIVE_ACCOUNTS || 25);

function allowPhoneRequest(phone) {
  const now = Date.now();
  const previous = (phoneRequests.get(phone) || []).filter(t => now - t < 60 * 60 * 1000);
  if (previous.length >= 3) return false;
  previous.push(now);
  phoneRequests.set(phone, previous);
  return true;
}

const pairLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests. Wait 15 minutes and try again." }
});
app.use("/api/pair", pairLimiter);
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store, private");
  const origin = _req.get("origin");
  if (SITE_ORIGIN && origin && origin !== SITE_ORIGIN) {
    return res.status(403).json({ error: "Origin not allowed." });
  }
  next();
});

function unwrapMessage(message) {
  let current = message;
  for (let i = 0; i < 5 && current; i++) {
    if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message;
    else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message;
    else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
    else if (current.viewOnceMessageV2Extension?.message) current = current.viewOnceMessageV2Extension.message;
    else break;
  }
  return current || {};
}
function getText(message) {
  const m = unwrapMessage(message);
  return m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    "";
}
function hasViewOnce(message) {
  return Boolean(
    message?.viewOnceMessage ||
    message?.viewOnceMessageV2 ||
    message?.viewOnceMessageV2Extension ||
    message?.ephemeralMessage?.message?.viewOnceMessage ||
    message?.ephemeralMessage?.message?.viewOnceMessageV2
  );
}
function jidToDigits(jid = "") {
  return jid.split("@")[0].split(":")[0].replace(/\D/g, "");
}

function linkedMessage() {
  const support = SUPPORT_LINK || "(Support link not configured)";
  return `
╭───────────────────────────╮
│  🦊  F R O X Y  T E C H  💜  │
│  ───────────────────────  │
│  ✨ LINKED SUCCESSFULLY ✨ │
╰───────────────────────────╯

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  💎 *ACCOUNT CONNECTED* 💎  ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

┌─⭓ *Device Info*
│ • 𓆩💜𓆪 Bot: Froxy V1
│ • 𓆩⚡𓆪 Status: Connected
│ • 𓆩🛡️𓆪 Security: WhatsApp-linked session
│ • 𓆩👑𓆪 Owner: This account
└───────────────────────────

┌─⭓ *What You Unlock*
│ ◦ 🤖 Froxy helper commands
│ ◦ 💬 Auto replies
│ ◦ 🛡️ Antilink settings (configurable)
│ ◦ 👥 Group tagging commands
│ ◦ ⚡ Pair through the official website
└───────────────────────────

┌─⭓ *Commands to Start*
│ ◦ .help - Show all commands
│ ◦ .froxy <question> - Froxy helper
│ ◦ .alive - Check bot status
│ ◦ .tagall - Tag group participants
│ ◦ .hidetag - Tag group silently
│ ◦ .viewonce - Explain view-once privacy
└───────────────────────────

╭─❖ *OFFICIAL SUPPORT* ❖─╮
│ 🔗 ${support}
│ 💜 Froxy V1 Support
╰───────────────────────────

       ◢◤◇◥◣
       ◥◣◇◢◤
    ┏━━━━━━━┓
    ┃  FXT  ┃  FXT Solutions
    ┃  💜🖤  ┃  Est. 2025
    ┗━━━━━━━┛

✨ *Powered by Froxy Tech* ✨
🌐 ${SITE_ORIGIN || "Configure SITE_ORIGIN"}

> *Thank you for choosing Froxy 💜*
> _Your WhatsApp automation starts now..._
`.trim();
}

async function sendOnceLinked(sock, phone) {
  const entry = registry[phone] || (registry[phone] = {});
  if (entry.linkedMessageSent) return;
  // Send to the linked account's own WhatsApp chat (Message yourself).
  await sock.sendMessage(sock.user.id, { text: linkedMessage() });
  entry.linkedMessageSent = true;
  entry.linkedAt = new Date().toISOString();
  saveRegistry();

  if (OWNER_NUMBER && OWNER_NUMBER !== phone) {
    try {
      await sock.sendMessage(`${OWNER_NUMBER}@s.whatsapp.net`, {
        text: `🦊 Froxy V1: a WhatsApp account finished linking through the portal.`
      });
    } catch (err) {
      logger.warn({ err }, "Could not notify configured owner");
    }
  }
}

async function handleCommand(sock, msg, phone) {
  if (!msg.message || msg.key.fromMe) return;
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid) return;

  // Do not download, re-send, or archive view-once media. Respect sender privacy.
  if (hasViewOnce(msg.message)) {
    const txt = getText(msg.message);
    if (txt.startsWith(`${PREFIX}viewonce`)) {
      await sock.sendMessage(remoteJid, { text: "View-once media is designed to be temporary. Froxy does not save or bypass that privacy setting." }, { quoted: msg });
    }
    return;
  }

  const text = getText(msg.message).trim();
  const lower = text.toLowerCase();
  const isGroup = remoteJid.endsWith("@g.us");
  const sender = msg.key.participant || remoteJid;
  const senderDigits = jidToDigits(sender);
  const isOwner = senderDigits === phone || (OWNER_NUMBER && senderDigits === OWNER_NUMBER);

  // Lightweight pre-added auto replies.
  if (["hi", "hello", "hey"].includes(lower)) {
    await sock.sendMessage(remoteJid, { text: "🦊 Hey! Froxy V1 is here. Type .help to see commands." }, { quoted: msg });
    return;
  }
  if (!text.startsWith(PREFIX)) return;

  const [rawCommand, ...args] = text.slice(PREFIX.length).split(/\s+/);
  const command = (rawCommand || "").toLowerCase();
  const query = args.join(" ");

  if (command === "help") {
    return sock.sendMessage(remoteJid, { text:
`🦊 *FROXY V1 COMMANDS*

• .help — Show this menu
• .alive — Check connection
• .froxy <question> — Simple helper response
• .tagall — Tag group members
• .hidetag <message> — Mention group members with a message
• .viewonce — View-once privacy information

Pairing portal: ${SITE_ORIGIN || "configure SITE_ORIGIN"}

Note: this starter respects view-once media and does not save or bypass it.` }, { quoted: msg });
  }
  if (command === "alive") {
    return sock.sendMessage(remoteJid, { text: `🦊 *FROXY V1 IS ONLINE*\n💜 Session: Connected\n⚡ Prefix: ${PREFIX}` }, { quoted: msg });
  }
  if (command === "froxy") {
    if (!query) return sock.sendMessage(remoteJid, { text: "Ask me something after the command, e.g. .froxy give me study tips." }, { quoted: msg });
    return sock.sendMessage(remoteJid, { text: `🦊 *Froxy Helper*\n\nYou asked: ${query}\n\nThis standalone starter has no AI provider connected yet. Add an AI API key and provider integration to enable generated answers.` }, { quoted: msg });
  }
  if (command === "viewonce") {
    return sock.sendMessage(remoteJid, { text: "🔒 *View-once privacy*\nFroxy will not save, expose, or bypass view-once media. Ask the sender to share it normally if you need to keep a copy." }, { quoted: msg });
  }
  if (command === "tagall" || command === "hidetag") {
    if (!isGroup) return sock.sendMessage(remoteJid, { text: "This command works in groups only." }, { quoted: msg });
    if (!isOwner) return sock.sendMessage(remoteJid, { text: "Only the account owner can use this group command in this starter." }, { quoted: msg });
    try {
      const metadata = await sock.groupMetadata(remoteJid);
      const participants = metadata.participants || [];
      if (!participants.length) return;
      const mentions = participants.map(p => p.id);
      const body = command === "tagall"
        ? `📣 *FROXY TAG ALL*\n\n${mentions.map(j => `• @${jidToDigits(j)}`).join("\n")}`
        : (query || "🦊 Froxy V1").trim();
      return sock.sendMessage(remoteJid, { text: body, mentions }, { quoted: msg });
    } catch {
      return sock.sendMessage(remoteJid, { text: "Could not get group participants. Check bot permissions and try again." }, { quoted: msg });
    }
  }
}

async function startAccount(phone, { pairing = false } = {}) {
  if (sockets.has(phone)) return sockets.get(phone);
  if (sockets.size >= MAX_ACTIVE) throw new Error("This Froxy host has reached its configured account limit.");

  const authDir = sessionPath(phone);
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Froxy V1", "Chrome", "1.0.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });
  sockets.set(phone, sock);
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      try { await handleCommand(sock, msg, phone); }
      catch (err) { logger.warn({ err }, "Message handler failed"); }
    }
  });

  sock.ev.on("connection.update", async update => {
    if (update.connection === "open") {
      const entry = registry[phone] || (registry[phone] = {});
      entry.sessionKey = sessionKey(phone);
      entry.lastConnectedAt = new Date().toISOString();
      saveRegistry();
      try { await sendOnceLinked(sock, phone); }
      catch (err) { logger.warn({ err }, "Could not send linked message"); }
      pendingPairs.delete(phone);
    }
    if (update.connection === "close") {
      sockets.delete(phone);
      const code = update.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        delete registry[phone];
        saveRegistry();
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
        pendingPairs.delete(phone);
      } else {
        // Reconnect existing sessions with a short delay.
        setTimeout(() => {
          startAccount(phone).catch(err => logger.warn({ err }, "Reconnect failed"));
        }, 3000);
      }
    }
  });

  if (pairing && !state.creds.registered) {
    // Wait for Baileys' QR stage, then ask WhatsApp for a phone-number pairing code.
    const code = await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error("Pairing request timed out. Try again.")); }
      }, 45000);
      const fail = err => {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(err);
      };
      sock.ev.on("connection.update", async update => {
        if (settled) return;
        if (update.qr && !sock.authState.creds.registered) {
          settled = true; clearTimeout(timer);
          try { resolve(await sock.requestPairingCode(phone)); }
          catch (err) { reject(err); }
        }
        if (update.connection === "close") {
          fail(new Error("Could not start WhatsApp pairing. Try again shortly."));
        }
      });
    }).catch(err => {
      sockets.delete(phone);
      try { sock.end(undefined); } catch {}
      throw err;
    });
    pendingPairs.set(phone, { createdAt: Date.now() });
    return { sock, code };
  }
  return { sock, code: null };
}

// Restore known sessions at startup.
async function restoreSessions() {
  for (const phone of Object.keys(registry)) {
    if (!validPhone(phone)) continue;
    const authDir = sessionPath(phone);
    if (fs.existsSync(path.join(authDir, "creds.json"))) {
      try { await startAccount(phone); }
      catch (err) { logger.warn({ err }, "Could not restore saved session"); }
    }
  }
}

app.post("/api/pair", async (req, res) => {
  const phone = digitsOnly(String(req.body?.phone || ""));
  if (!validPhone(phone)) return res.status(400).json({ error: "Enter an international WhatsApp number with country code, digits only." });
  if (!allowPhoneRequest(phone)) return res.status(429).json({ error: "Too many requests for this number. Try again in an hour." });
  if (pendingPairs.has(phone)) return res.status(409).json({ error: "A pairing request is already pending for this number." });
  if (sockets.has(phone)) return res.status(409).json({ error: "This number already has an active Froxy session." });

  try {
    const { code } = await startAccount(phone, { pairing: true });
    if (!code) return res.status(409).json({ error: "This number already has a registered session." });
    res.set("Cache-Control", "no-store, private");
    return res.json({
      code,
      instructions: "On the WhatsApp account for this number, open Settings → Linked Devices → Link a Device → Link with phone number, then enter this code."
    });
  } catch (err) {
    logger.warn({ err }, "Pairing request failed");
    return res.status(500).json({ error: err.message || "Could not start pairing." });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "Froxy V1", activeSessions: sockets.size }));
app.listen(PORT, HOST, () => {
  logger.info(`Froxy V1 website and pairing API listening on ${HOST}:${PORT}`);
  restoreSessions().catch(err => logger.error({ err }, "Session restore failed"));
});

process.on("SIGINT", () => {
  for (const sock of sockets.values()) { try { sock.end(undefined); } catch {} }
  process.exit(0);
});
process.on("SIGTERM", () => {
  for (const sock of sockets.values()) { try { sock.end(undefined); } catch {} }
  process.exit(0);
});
