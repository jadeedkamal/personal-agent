#!/usr/bin/env node
// Long-running WhatsApp Web session (linked-device) + a small localhost HTTP API for the
// `whatsapp` MCP tool to talk to. Runs headful on the shared virtual display so the user can
// scan the initial link QR code via the app's Live Desktop view.
const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 4010;
const SHARED_SECRET = process.env.INTERNAL_SHARED_SECRET;
process.env.DISPLAY = process.env.GUI_DISPLAY || ':99';

const AUTH_DIR = path.join(__dirname, '.wwebjs_auth');
const FILES_DIR = path.join(os.homedir(), 'uploads');
const ALLOWED_MEDIA_DIRS = [FILES_DIR, path.join(os.homedir(), 'Downloads')];

// Numbers (digits only, with country code, e.g. "918590687460") allowed to trigger the
// "/download <url>" bot command over WhatsApp. Anyone else's messages are ignored.
const ALLOWED_NUMBERS = (process.env.WHATSAPP_ALLOWED_NUMBERS || '')
  .split(',')
  .map((n) => n.replace(/[^\d]/g, ''))
  .filter(Boolean);

let state = 'initializing'; // initializing | qr | authenticated | ready | disconnected | auth_failure
let lastQr = null;
let lastError = null;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
  puppeteer: {
    headless: false,
    // --disable-session-crashed-bubble suppresses the "Restore pages?" prompt Chrome shows
    // every launch (we always stop the service with SIGKILL, which looks like a crash to it) —
    // suspected of racing with Puppeteer's attached tab and causing "Target closed"/detached
    // frame errors on sendMessage.
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized', '--window-position=0,0', '--disable-session-crashed-bubble', '--disable-infobars'],
  },
});

client.on('qr', (qr) => { state = 'qr'; lastQr = qr; console.log('[whatsapp-bridge] QR ready, scan via Live Desktop'); });
client.on('authenticated', () => { state = 'authenticated'; lastQr = null; console.log('[whatsapp-bridge] authenticated'); });
client.on('ready', () => { state = 'ready'; console.log('[whatsapp-bridge] ready'); });
client.on('auth_failure', (msg) => { state = 'auth_failure'; lastError = msg; console.error('[whatsapp-bridge] auth failure', msg); });
client.on('disconnected', (reason) => { state = 'disconnected'; lastError = reason; console.log('[whatsapp-bridge] disconnected', reason); });

client.initialize().catch((err) => { state = 'auth_failure'; lastError = err.message; console.error('[whatsapp-bridge] init error', err); });

// Close the browser cleanly on stop/restart so Chrome doesn't flag the profile as crashed next
// launch (which otherwise shows a "Restore pages?" prompt every time and was implicated in
// intermittent "Target closed" send failures). Without this, systemd's stop-sigterm just times
// out after ~90s and force-kills the process anyway.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[whatsapp-bridge] shutting down cleanly...');
  // destroy() talks to the page over CDP and can hang forever if the page/frame is already
  // dead — don't let that turn into systemd's full ~90s stop-sigterm timeout + SIGKILL.
  const forceExit = setTimeout(() => {
    console.error('[whatsapp-bridge] destroy() did not finish in time, forcing exit');
    process.exit(1);
  }, 8000);
  try { await client.destroy(); } catch (err) { console.error('[whatsapp-bridge] shutdown error:', err); }
  clearTimeout(forceExit);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const app = express();
app.use(express.json({ limit: '5mb' }));

function requireSecret(req, res, next) {
  if (!SHARED_SECRET || req.headers['x-internal-secret'] !== SHARED_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/status', requireSecret, async (req, res) => {
  const out = { state, error: lastError };
  if (state === 'qr' && lastQr) {
    out.qrDataUrl = await qrcode.toDataURL(lastQr);
  }
  res.json(out);
});

async function findContact(name) {
  const contacts = await client.getContacts();
  const named = (c) => (c.name || c.pushname || '').trim();
  const nameLower = name.toLowerCase();
  const exact = contacts.filter((c) => c.isMyContact && named(c).toLowerCase() === nameLower);
  const pool = exact.length ? exact : contacts.filter((c) => c.isMyContact && named(c).toLowerCase().includes(nameLower));
  return pool.map((c) => ({ name: named(c) || c.number, number: c.number, id: c.id._serialized }));
}

// whatsapp-web.js's own "ready" event is unreliable right now (a known upstream issue tied to
// WhatsApp's @lid migration — https://github.com/wwebjs/whatsapp-web.js/issues/201844) and can
// simply never fire even though the session is fully logged in and functional. "authenticated"
// is good enough in practice; only "qr"/"disconnected"/etc. should actually block requests.
function isUsable(s) {
  return s === 'ready' || s === 'authenticated';
}

app.get('/contacts', requireSecret, async (req, res) => {
  if (!isUsable(state)) return res.status(409).json({ error: `WhatsApp not ready (state=${state})` });
  try {
    const matches = await findContact(String(req.query.search || ''));
    res.json({ matches: matches.slice(0, 15) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Confirmed by direct testing: sending inline media over a certain size crashes the WhatsApp Web
// page/frame entirely (not just that send — every subsequent send fails with "Target closed" /
// "detached Frame" until the bridge is restarted). A 43MB clip sent fine; a 154MB/10-minute clip
// reliably crashed it. This cap is a conservative line between those two, with margin — reject
// oversized files up front instead of risking the whole session.
const MAX_INLINE_MEDIA_BYTES = 64 * 1024 * 1024;

async function sendMediaMessage(chatId, resolvedPath, { caption, sendMediaAsDocument } = {}) {
  const size = fs.statSync(resolvedPath).size;
  if (size > MAX_INLINE_MEDIA_BYTES) {
    const mb = (size / (1024 * 1024)).toFixed(1);
    const capMb = MAX_INLINE_MEDIA_BYTES / (1024 * 1024);
    throw new Error(`File is ${mb}MB, over the ${capMb}MB limit for sending via WhatsApp here (larger files have crashed the session in testing) — try a shorter clip or lower quality.`);
  }
  const media = MessageMedia.fromFilePath(resolvedPath);
  // Root cause of earlier "file corrupted/unusual format" and "Evaluation failed: t" failures:
  // videos downloaded in AV1 codec (yt-dlp's default "best") aren't supported by WhatsApp at
  // all — confirmed by the same rejection happening via manual GUI upload, not just automation.
  // The video-downloader tool now forces H.264/AAC, so inline sends work normally;
  // sendMediaAsDocument is kept as an opt-in escape hatch, not the default.
  return client.sendMessage(chatId, media, { caption, sendMediaAsDocument: sendMediaAsDocument === true });
}

app.post('/send', requireSecret, async (req, res) => {
  if (!isUsable(state)) return res.status(409).json({ error: `WhatsApp not ready (state=${state})` });
  const { to, text, filePath, caption, sendMediaAsDocument } = req.body || {};
  if (!to) return res.status(400).json({ error: 'missing "to"' });

  try {
    let chatId;
    if (/^[\d+][\d\s().-]{5,}$/.test(to)) {
      const wid = await client.getNumberId(to.replace(/[^\d]/g, ''));
      if (!wid) return res.status(404).json({ error: `${to} is not on WhatsApp` });
      chatId = wid._serialized;
    } else {
      const matches = await findContact(to);
      if (matches.length === 0) return res.status(404).json({ error: `No contact matching "${to}"` });
      if (matches.length > 1) return res.status(300).json({ error: `Multiple contacts match "${to}"`, candidates: matches });
      chatId = matches[0].id;
    }

    if (filePath) {
      const resolved = path.resolve(filePath);
      if (!ALLOWED_MEDIA_DIRS.some((d) => resolved.startsWith(d + path.sep))) {
        return res.status(400).json({ error: `filePath must be inside ${ALLOWED_MEDIA_DIRS.join(' or ')}` });
      }
      if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'file not found' });
      const sentMsg = await sendMediaMessage(chatId, resolved, { caption: caption || text || undefined, sendMediaAsDocument });
      return res.json({ ok: true, to: chatId, messageId: sentMsg?.id?._serialized || null });
    } else if (text) {
      await client.sendMessage(chatId, text);
    } else {
      return res.status(400).json({ error: 'must provide "text" or "filePath"' });
    }
    res.json({ ok: true, to: chatId });
  } catch (err) {
    console.error('[whatsapp-bridge] /send error:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ---------- "/download <url>" bot command, restricted to ALLOWED_NUMBERS ----------

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timed out after 20 minutes'));
    }, 20 * 60 * 1000);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim().split('\n').slice(-5).join('\n') || `yt-dlp exited with code ${code}`));
      resolve(stdout);
    });
  });
}

// Mirrors the video-downloader MCP tool's format/codec choices (see
// ~/mcp-servers/video-downloader/server.js) — kept as a separate copy since the two run as
// independent processes. Capped at 720p here to keep the bot's turnaround quick.
async function downloadVideoForBot(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }

  const outTemplate = path.join(FILES_DIR, '%(title).150B [%(id)s].%(ext)s');
  const args = [
    '-q', '--no-warnings', '--no-playlist',
    // Everything this downloads is destined for sendMediaMessage's MAX_INLINE_MEDIA_BYTES (64MB)
    // cap — no point downloading a huge file just to reject it at send time. 480p keeps typical
    // multi-minute clips comfortably under that; --max-filesize is a per-stream backstop, not a
    // guarantee on the merged size.
    '--max-filesize', '150M',
    '--cookies-from-browser', 'chrome',
    '--js-runtimes', 'node',
    '--force-overwrites',
    '-o', outTemplate,
    '-f', 'bestvideo[height<=480]+bestaudio/best[height<=480]',
    '-S', 'vcodec:h264,acodec:aac',
    '--merge-output-format', 'mp4',
    '--print', 'after_move:filepath',
    parsed.toString(),
  ];

  const stdout = await runYtDlp(args);
  const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const filePath = lines[lines.length - 1];
  const resolved = filePath && path.resolve(filePath);
  if (!resolved || !resolved.startsWith(FILES_DIR + path.sep) || !fs.existsSync(resolved)) {
    throw new Error(`Download finished but the output file could not be located (yt-dlp output: ${stdout.trim()})`);
  }
  return resolved;
}

const DOWNLOAD_CMD_RE = /^\/download\s+(\S+)/i;

// 'message' (MESSAGE_RECEIVED) only fires for messages sent by others — a self-chat message is
// technically sent by us, so it only shows up on 'message_create' (fires for every message,
// incoming or outgoing). The fromMe/isSelfChat filtering below still narrows this back down.
client.on('message_create', async (msg) => {
  try {
    if (msg.from.endsWith('@g.us')) return; // ignore groups
    // The "Message yourself" chat is a convenient way for the account owner to trigger the
    // command without a second phone — it's exempt from both the fromMe filter and the
    // allow-list below. Every other fromMe message (things we sent in real chats) is ignored,
    // otherwise the bot would react to its own "On it..." replies / sent videos.
    const selfId = client.info && client.info.wid && client.info.wid._serialized;
    const isSelfChat = !!selfId && msg.from === selfId;
    if (msg.fromMe && !isSelfChat) return;

    const match = DOWNLOAD_CMD_RE.exec((msg.body || '').trim());
    if (!match) return;

    if (!isSelfChat) {
      const contact = await msg.getContact();
      let senderNumber = (contact.number || '').replace(/[^\d]/g, '');
      // WhatsApp's newer privacy defaults hide the real phone number behind a per-chat "LID"
      // (contact.number/msg.from end in @lid, not @c.us) for senders who aren't in this
      // account's address book. Resolve the LID back to the actual phone number so the
      // allow-list check below compares against real numbers, not opaque LIDs.
      const senderId = msg.author || msg.from;
      if (senderId.endsWith('@lid')) {
        const [resolved] = await client.getContactLidAndPhone([senderId]);
        if (resolved && resolved.pn) {
          senderNumber = resolved.pn.replace(/[^\d]/g, '');
        }
      }
      if (!ALLOWED_NUMBERS.includes(senderNumber)) {
        console.log(`[whatsapp-bridge] ignoring /download from non-allowed number ${senderNumber}`);
        return;
      }
    }

    const url = match[1];
    console.log(`[whatsapp-bridge] /download from ${isSelfChat ? 'self-chat' : 'allowed number'}: ${url}`);
    await msg.reply('On it — downloading that now, hang tight.');

    let filePath;
    try {
      filePath = await downloadVideoForBot(url);
    } catch (err) {
      console.error('[whatsapp-bridge] bot download failed:', err);
      await msg.reply(`Couldn't download that: ${err.message}`);
      return;
    }

    try {
      await sendMediaMessage(msg.from, filePath);
    } catch (err) {
      console.error('[whatsapp-bridge] bot send failed:', err);
      await msg.reply(`Downloaded it, but couldn't send it: ${err.message}`);
    }
  } catch (err) {
    console.error('[whatsapp-bridge] message handler error:', err);
  }
});

app.listen(PORT, '127.0.0.1', () => console.log(`[whatsapp-bridge] listening on 127.0.0.1:${PORT}`));
