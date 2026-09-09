const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const multer = require('multer');
const webpush = require('web-push');
const { spawn, execSync, execFile } = require('child_process');

const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const PUSH_SUBS_FILE = path.join(DATA_DIR, 'push-subscriptions.json');
const RATE_LIMIT_FILE = path.join(DATA_DIR, 'rate-limit.json');
const APP_SETTINGS_FILE = path.join(DATA_DIR, 'app-settings.json');
const ANTIGRAVITY_BIN = path.join(os.homedir(), '.local/bin/agy');
const CLAUDE_MEMORY_FILE = path.join(os.homedir(), '.claude/projects/-home-personalagent-agent-app/memory/MEMORY.md');
const WORKSPACE = process.env.AGENT_WORKSPACE || path.join(os.homedir(), 'workspace');
const UPLOADS_DIR = path.join(WORKSPACE, 'uploads');
const TOOL_IMAGES_DIR = path.join(DATA_DIR, 'tool-images');
const PASSWORD_HASH = process.env.AGENT_PASSWORD_HASH;
const SESSION_SECRET = process.env.SESSION_SECRET;
const PORT = process.env.PORT || 3000;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI;
const ALLOWED_GOOGLE_EMAIL = process.env.ALLOWED_GOOGLE_EMAIL;

if (!PASSWORD_HASH || !SESSION_SECRET) {
  console.error('Missing AGENT_PASSWORD_HASH or SESSION_SECRET env vars');
  process.exit(1);
}
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(TOOL_IMAGES_DIR, { recursive: true });

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:admin@personal-agent.duckdns.org', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.error('Missing VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY env vars — push notifications disabled');
}

function loadPushSubs() {
  try { return JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, 'utf8')); } catch { return []; }
}
function savePushSubs(subs) {
  fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify(subs, null, 2));
}

async function notifySubscribers(payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  const subs = loadPushSubs();
  if (!subs.length) { console.log('[push] no subscriptions on file, nothing to notify'); return; }
  const body = JSON.stringify(payload);
  const survivors = [];
  for (const sub of subs) {
    try {
      const res = await webpush.sendNotification(sub, body);
      console.log(`[push] sent to ${sub.endpoint.slice(0, 60)}... (${res.statusCode})`);
      survivors.push(sub);
    } catch (err) {
      console.log(`[push] failed for ${sub.endpoint.slice(0, 60)}...: ${err.statusCode} ${err.body || err.message}`);
      // 404/410 = the push service says this subscription is gone (unsubscribed, expired,
      // browser data cleared) — drop it instead of retrying it forever. Keep anything else
      // (e.g. a transient network error) so a fluke doesn't silently unregister a device.
      if (err.statusCode !== 404 && err.statusCode !== 410) survivors.push(sub);
    }
  }
  if (survivors.length !== subs.length) savePushSubs(survivors);
}

function loadConvos() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { return {}; }
}
function saveConvos(convos) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(convos, null, 2));
}

// The claude CLI emits a `rate_limit_event` mid-stream with the account's actual 5-hour/7-day
// usage-limit utilisation and reset times — this is the same info Claude Code's own UI shows.
// Cached to disk so Settings has something to show even before the next message is sent.
function saveRateLimitInfo(info) {
  try { fs.writeFileSync(RATE_LIMIT_FILE, JSON.stringify({ ...info, capturedAt: Date.now() }, null, 2)); } catch {}
}
function loadRateLimitInfo() {
  try { return JSON.parse(fs.readFileSync(RATE_LIMIT_FILE, 'utf8')); } catch { return null; }
}

// ---------- CLI engine selection (Claude CLI vs Antigravity CLI) ----------
//
// A global default (which CLI backend, and which model within it) rather than per-conversation,
// so switching in Settings takes effect on the very next message sent, in any conversation.

const MODEL_CATALOG = {
  claude: [
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-opus-5', label: 'Opus 5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  ],
  antigravity: [
    { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
    { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' },
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
    { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
    { id: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)' },
    { id: 'gemini-3.7-flash-medium', label: 'Gemini 3.7 Flash (Medium)' },
    { id: 'gemini-3.7-flash-low', label: 'Gemini 3.7 Flash (Low)' },
    { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)' },
    { id: 'gemini-3.6-flash-medium', label: 'Gemini 3.6 Flash (Medium)' },
    { id: 'gemini-3.6-flash-low', label: 'Gemini 3.6 Flash (Low)' },
  ],
};

const DEFAULT_APP_SETTINGS = {
  provider: 'claude',
  model: { claude: MODEL_CATALOG.claude[0].id, antigravity: MODEL_CATALOG.antigravity[0].id },
};

function loadAppSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(APP_SETTINGS_FILE, 'utf8'));
    return { ...DEFAULT_APP_SETTINGS, ...saved, model: { ...DEFAULT_APP_SETTINGS.model, ...(saved.model || {}) } };
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}
function saveAppSettings(settings) {
  fs.writeFileSync(APP_SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function verifyPassword(candidate) {
  const [salt, hash] = PASSWORD_HASH.split(':');
  const derived = crypto.scryptSync(candidate, salt, 64).toString('hex');
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 },
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

app.get('/api/authcheck', (req, res) => {
  if (req.session && req.session.authed) return res.status(200).end();
  return res.status(401).end();
});

const loginAttempts = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 15 * 60 * 1000; }
  if (rec.count >= 10) return res.status(429).json({ error: 'too many attempts, try later' });
  rec.count++;
  loginAttempts.set(ip, rec);

  const { password } = req.body || {};
  if (typeof password === 'string' && verifyPassword(password)) {
    req.session.authed = true;
    req.session.authMethod = 'password';
    delete req.session.googleEmail;
    loginAttempts.delete(ip);
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'invalid password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/status', (req, res) => {
  if (!(req.session && req.session.authed)) return res.json({ authed: false });
  res.json({
    authed: true,
    authMethod: req.session.authMethod || 'password',
    googleEmail: req.session.authMethod === 'google' ? req.session.googleEmail : undefined,
  });
});

// ---------- Google SSO ----------
// Alongside the password login, not replacing it — a second way in, not a weaker one. Access is
// still gated to a single allow-listed Google account (this is a personal single-user app; without
// this check, any Google account could sign in once the OAuth consent screen leaves testing mode).

app.get('/api/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_OAUTH_REDIRECT_URI) return res.status(404).send('Google sign-in is not configured.');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email',
    state,
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || state !== req.session.oauthState) {
    return res.status(400).send('Invalid or expired sign-in attempt. Go back and try again.');
  }
  delete req.session.oauthState;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokenData.error_description || 'token exchange failed');

    const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();
    if (!userRes.ok || !user.email) throw new Error('failed to fetch user info');

    if (!ALLOWED_GOOGLE_EMAIL || !user.email_verified || user.email.toLowerCase() !== ALLOWED_GOOGLE_EMAIL.toLowerCase()) {
      return res.status(403).send('This Google account is not authorised to sign in to this app.');
    }
    req.session.authed = true;
    req.session.authMethod = 'google';
    req.session.googleEmail = user.email;
    res.redirect('/');
  } catch (err) {
    console.error('[google-sso] callback failed:', err.message);
    res.status(500).send('Google sign-in failed. Please try again.');
  }
});

function getGpuInfo() {
  try {
    const out = execSync('lspci', { encoding: 'utf8', timeout: 3000 });
    const lines = out.split('\n').filter(l => /vga compatible controller|3d controller|display controller/i.test(l));
    if (!lines.length) return 'No dedicated GPU detected (headless virtual machine)';
    return lines.map(l => l.replace(/^[0-9a-f:.]+\s+[^:]+:\s*/i, '').trim()).join(', ');
  } catch {
    return 'Unknown';
  }
}

app.get('/api/system-info', requireAuth, (req, res) => {
  const cpus = os.cpus();
  let disk = null;
  try {
    const stat = fs.statfsSync('/');
    const totalBytes = stat.blocks * stat.bsize;
    const freeBytes = stat.bavail * stat.bsize;
    disk = { totalBytes, freeBytes, usedBytes: totalBytes - freeBytes };
  } catch {}
  res.json({
    username: os.userInfo().username,
    cpu: { model: cpus[0] ? cpus[0].model.trim() : 'Unknown', cores: cpus.length },
    ramTotalBytes: os.totalmem(),
    ramFreeBytes: os.freemem(),
    gpu: getGpuInfo(),
    disk,
  });
});

app.get('/api/usage-stats', requireAuth, (req, res) => {
  res.json({ rateLimit: loadRateLimitInfo() });
});

app.get('/api/models', requireAuth, (req, res) => {
  res.json({ catalog: MODEL_CATALOG });
});

app.get('/api/app-settings', requireAuth, (req, res) => {
  res.json(loadAppSettings());
});

app.post('/api/app-settings', requireAuth, (req, res) => {
  const settings = loadAppSettings();
  const { provider, model } = req.body || {};
  if (provider && MODEL_CATALOG[provider]) settings.provider = provider;
  if (model && typeof model === 'object') {
    for (const key of Object.keys(model)) {
      if (MODEL_CATALOG[key] && MODEL_CATALOG[key].some(m => m.id === model[key])) {
        settings.model[key] = model[key];
      }
    }
  }
  saveAppSettings(settings);
  res.json(settings);
});

// ---------- Conversations ----------

app.get('/api/conversations', requireAuth, (req, res) => {
  const convos = loadConvos();
  const list = Object.entries(convos).map(([id, c]) => ({ id, title: c.title, updatedAt: c.updatedAt, mode: c.mode || 'workspace' }));
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  res.json({ conversations: list });
});

app.get('/api/conversations/:id', requireAuth, (req, res) => {
  const convos = loadConvos();
  const c = convos[req.params.id];
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(c);
});

app.patch('/api/conversations/:id', requireAuth, (req, res) => {
  const convos = loadConvos();
  const c = convos[req.params.id];
  if (!c) return res.status(404).json({ error: 'not found' });
  const { title } = req.body || {};
  if (typeof title === 'string' && title.trim()) {
    c.title = title.trim().slice(0, 100);
    saveConvos(convos);
  }
  res.json({ ok: true });
});

app.delete('/api/conversations/:id', requireAuth, (req, res) => {
  const convos = loadConvos();
  delete convos[req.params.id];
  saveConvos(convos);
  killGeneration(req.params.id);
  res.json({ ok: true });
});

// ---------- Push notifications ----------

app.get('/api/push/vapid-public-key', requireAuth, (req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(404).json({ error: 'push not configured' });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const sub = req.body;
  if (!sub || typeof sub.endpoint !== 'string') return res.status(400).json({ error: 'invalid subscription' });
  const subs = loadPushSubs();
  if (!subs.some(s => s.endpoint === sub.endpoint)) {
    subs.push(sub);
    savePushSubs(subs);
  }
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  const { endpoint } = req.body || {};
  const subs = loadPushSubs().filter(s => s.endpoint !== endpoint);
  savePushSubs(subs);
  res.json({ ok: true });
});

// ---------- Uploads ----------

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safe}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  res.json({
    filename: req.file.originalname,
    storedName: req.file.filename,
    relativePath: path.join('uploads', req.file.filename),
    mimeType: req.file.mimetype,
    size: req.file.size,
  });
});

app.use('/uploads', requireAuth, express.static(UPLOADS_DIR));
app.use('/tool-images', requireAuth, express.static(TOOL_IMAGES_DIR));

// ---------- General file storage (not tied to chat) ----------

const FILES_DIR = path.join(os.homedir(), 'uploads');
fs.mkdirSync(FILES_DIR, { recursive: true });

function sanitizeFileName(name) {
  const base = path.basename(name).replace(/[/\\]/g, '_').replace(/^\.+/, '');
  return base || 'file';
}

function uniqueFileName(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  let n = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem} (${n})${ext}`;
    n++;
  }
  return candidate;
}

const filesUpload = multer({
  storage: multer.diskStorage({
    destination: FILES_DIR,
    filename: (req, file, cb) => cb(null, uniqueFileName(FILES_DIR, sanitizeFileName(file.originalname))),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

app.get('/api/files', requireAuth, (req, res) => {
  const entries = fs.readdirSync(FILES_DIR, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const stat = fs.statSync(path.join(FILES_DIR, e.name));
      return { name: e.name, size: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  res.json(entries);
});

app.post('/api/files/upload', requireAuth, filesUpload.array('files', 20), (req, res) => {
  res.json({ uploaded: (req.files || []).map((f) => f.filename) });
});

app.get('/api/files/download/:name', requireAuth, (req, res) => {
  const name = path.basename(req.params.name);
  const filePath = path.join(FILES_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.download(filePath, name);
});

app.delete('/api/files/:name', requireAuth, (req, res) => {
  const name = path.basename(req.params.name);
  const filePath = path.join(FILES_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not found' });
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// ---------- Claude streaming ----------

// A generation runs independently of any particular HTTP connection: closing the browser,
// backgrounding the tab, or a dropped network connection must not kill the underlying
// `claude` process or lose the response. It keeps running and gets persisted regardless of
// whether anyone is watching, and any client — the same one reconnecting, or a fresh page
// load — can re-attach via GET /api/chat/attach to see it (or its final result).
const activeGenerations = new Map(); // conversationId -> generation state

function killGeneration(conversationId) {
  const gen = activeGenerations.get(conversationId);
  if (gen) { try { gen.child.kill('SIGTERM'); } catch {} }
}

app.post('/api/chat/cancel', requireAuth, (req, res) => {
  const { conversationId } = req.body || {};
  killGeneration(conversationId);
  res.json({ ok: true });
});

app.get('/api/chat/attach', requireAuth, (req, res) => {
  const gen = activeGenerations.get(req.query.conversationId);
  if (!gen) return res.status(404).json({ error: 'not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  gen.subscribers.add(res);
  // Catch this client up on everything that already happened before it (re)connected.
  res.write(`event: sync\ndata: ${JSON.stringify({ blocks: gen.blocks, usedThinking: gen.usedThinking })}\n\n`);
  req.on('close', () => { gen.subscribers.delete(res); });
});

// ---------- Secure input (credentials typed directly into the target, never through chat) ----------
//
// The gui-control MCP tool `request_secure_input` calls the /internal/* routes below (localhost
// only, gated by a shared secret set in both .secrets/agent.env and config/mcp.json) to ask the
// user for a sensitive value without it ever passing through the model's context, the chat
// transcript, or sessions.json. The browser submits the value via the normal authenticated
// /api/secure-input route; it's held in memory only, handed to the MCP tool exactly once via
// polling, and deleted immediately after — never written to disk.
const INTERNAL_SHARED_SECRET = process.env.INTERNAL_SHARED_SECRET;
const pendingSecureInputs = new Map(); // id -> { prompt, value, createdAt }

function requireInternalSecret(req, res, next) {
  if (!INTERNAL_SHARED_SECRET || req.get('X-Internal-Secret') !== INTERNAL_SHARED_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

function broadcastToAllGenerations(event, data) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const gen of activeGenerations.values()) {
    for (const sub of gen.subscribers) sub.write(line);
  }
}

app.post('/internal/secure-input/create', requireInternalSecret, (req, res) => {
  const prompt = String((req.body || {}).prompt || 'Enter the requested value').slice(0, 300);
  const id = crypto.randomUUID();
  pendingSecureInputs.set(id, { prompt, value: null, createdAt: Date.now() });
  setTimeout(() => pendingSecureInputs.delete(id), 5 * 60 * 1000);
  broadcastToAllGenerations('secure_input_request', { id, prompt });
  res.json({ id });
});

app.get('/internal/secure-input/:id/poll', requireInternalSecret, (req, res) => {
  const entry = pendingSecureInputs.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'not found or expired' });
  if (entry.value === null) return res.json({ done: false });
  pendingSecureInputs.delete(req.params.id); // single-use: gone from memory the moment it's read
  res.json({ done: true, value: entry.value });
});

app.post('/api/secure-input/:id/submit', requireAuth, (req, res) => {
  const entry = pendingSecureInputs.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'not found or expired' });
  const { value } = req.body || {};
  if (typeof value !== 'string' || !value) return res.status(400).json({ error: 'value required' });
  entry.value = value;
  broadcastToAllGenerations('secure_input_resolved', { id: req.params.id });
  res.json({ ok: true });
});

app.post('/api/secure-input/:id/cancel', requireAuth, (req, res) => {
  pendingSecureInputs.delete(req.params.id);
  broadcastToAllGenerations('secure_input_resolved', { id: req.params.id });
  res.json({ ok: true });
});

// ---------- Graceful restart ----------
//
// `systemctl restart agent-app` kills this very process, including whatever response is still
// streaming out through it — restarting mid-turn cuts the user's answer off mid-sentence. This
// lets a tool call *schedule* a restart instead of forcing one immediately: it just sets a flag,
// and the flag is only acted on inside a generation's own close handler, i.e. once that
// generation's reply has already been fully broadcast and every subscriber connection ended.
let pendingRestart = false;

app.post('/internal/restart/request', requireInternalSecret, (req, res) => {
  pendingRestart = true;
  res.json({ ok: true, message: 'Restart scheduled for once the current response finishes.' });
});

function restartIfPending() {
  if (!pendingRestart) return;
  pendingRestart = false;
  console.log('[restart] Current response finished — restarting agent-app shortly.');
  // A short delay is a cheap extra margin for the already-ended response to finish leaving the
  // socket, on top of the fact that every subscriber's res.end() has already been called by now.
  setTimeout(() => {
    execFile('sudo', ['systemctl', 'restart', 'agent-app'], (err) => {
      if (err) console.error('[restart] failed:', err.message);
    });
  }, 1500);
}

const APP_DIR = __dirname;
const IMPROVE_SYSTEM_PROMPT = `You are operating in "Improve" mode: your working directory is the source code of the very app the user is talking to you through (Personal Agent), not their general workspace.

Layout:
- ${APP_DIR}/server.js — Express backend (auth, conversation storage, SSE streaming to the claude CLI, uploads)
- ${APP_DIR}/public/ — frontend (index.html, app.js, styles.css, manifest.json, sw.js, vendor/marked.js)
- ${APP_DIR}/config/mcp.json — MCP server config loaded by every claude invocation
- ~/mcp-servers/gui-control/server.js — the MCP server exposing GUI control tools (screenshot, click, type_text, etc.)
- Systemd services you may restart after changes: agent-app (this backend — restarting it WILL drop your own current connection, that's expected), xvfb / xfce / x11vnc / novnc (virtual desktop stack), caddy (reverse proxy + TLS, config at /etc/caddy/Caddyfile)

Ground rules:
- This is the user's only interface to this machine. Never leave it broken: after editing server.js or frontend files, sanity-check syntax (node -c for JS) before restarting the service, and prefer small, testable changes over big rewrites.
- Never remove or weaken the login/session auth, never expose secrets (the OAuth token, session secret, password hash) in code you write or logs.
- After a change that requires a restart, restart the specific affected service(s) yourself and briefly report what changed and why.
- If a change is destructive, irreversible, or touches security/auth, explain the tradeoff in your reply rather than assuming.`;

function readClaudeMemorySummary() {
  try { return fs.readFileSync(CLAUDE_MEMORY_FILE, 'utf8').slice(0, 4000); } catch { return null; }
}

// ---------- CLI engine backends ----------
//
// Both `claude` and `agy` (Antigravity) support a `-p ... --output-format stream-json` headless
// mode, but each emits a completely different NDJSON event schema. Everything outside this object
// (persistence, SSE relay, reattach, push notifications) works in terms of the shared
// block/tool/text_delta vocabulary already built for Claude — buildArgs()/parseLine() are the only
// two places that need to know which CLI is actually running.
const PROVIDERS = {
  claude: {
    command: 'claude',
    buildArgs({ fullPrompt, isResume, convoId, convoMode, model }) {
      const args = [
        '-p', fullPrompt,
        '--output-format', 'stream-json',
        '--include-partial-messages',
        '--verbose',
        '--permission-mode', 'bypassPermissions',
        '--mcp-config', path.join(__dirname, 'config', 'mcp.json'),
      ];
      if (convoMode === 'improve') args.push('--append-system-prompt', IMPROVE_SYSTEM_PROMPT);
      if (model) args.push('--model', model);
      args.push(isResume ? '--resume' : '--session-id', convoId);
      return args;
    },
    parseLine(obj, gen, broadcast) {
      if (obj.type === 'stream_event' && obj.event) {
        const ev = obj.event;
        if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
          const meta = { id: ev.content_block.id, name: ev.content_block.name, input: null, done: false, images: [] };
          gen.toolMeta.set(ev.content_block.id, meta);
          if (!gen.currentBlock || gen.currentBlock.type !== 'tools') {
            gen.currentBlock = { type: 'tools', tools: [] };
            gen.blocks.push(gen.currentBlock);
          }
          gen.currentBlock.tools.push(meta);
          broadcast('tool_start', { id: meta.id, name: meta.name });
        } else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'thinking') {
          gen.usedThinking = true;
          broadcast('thinking_start', {});
        } else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
          gen.assistantText += ev.delta.text;
          if (!gen.currentBlock || gen.currentBlock.type !== 'text') {
            gen.currentBlock = { type: 'text', text: '' };
            gen.blocks.push(gen.currentBlock);
          }
          gen.currentBlock.text += ev.delta.text;
          broadcast('text_delta', { text: ev.delta.text });
        }
      } else if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
        for (const block of obj.message.content) {
          if (block.type === 'tool_use') {
            const meta = gen.toolMeta.get(block.id) || {};
            meta.name = block.name;
            meta.input = block.input;
            gen.toolMeta.set(block.id, meta);
            broadcast('tool_input', { id: block.id, name: block.name, input: block.input });
          }
        }
      } else if (obj.type === 'user' && obj.message && Array.isArray(obj.message.content)) {
        for (const block of obj.message.content) {
          if (block.type === 'tool_result') {
            const meta = gen.toolMeta.get(block.tool_use_id) || {};
            meta.done = true;

            let resultText = '';
            const images = [];
            const parts = Array.isArray(block.content) ? block.content : [{ type: 'text', text: String(block.content ?? '') }];
            for (const part of parts) {
              if (part.type === 'text') {
                resultText += part.text;
              } else if (part.type === 'image' && part.source && part.source.data) {
                const ext = (part.source.media_type || 'image/png').split('/')[1] || 'png';
                const fname = `${crypto.randomUUID()}.${ext}`;
                fs.writeFileSync(path.join(TOOL_IMAGES_DIR, fname), Buffer.from(part.source.data, 'base64'));
                images.push({ url: `/tool-images/${fname}`, mediaType: part.source.media_type });
              }
              // 'tool_reference' parts (internal tool-lookup placeholders) carry no useful data — skipped.
            }

            meta.images = images;
            gen.toolMeta.set(block.tool_use_id, meta);
            broadcast('tool_result', {
              id: block.tool_use_id,
              isError: !!block.is_error,
              summary: resultText.slice(0, 4000),
              images,
            });
          }
        }
      } else if (obj.type === 'result') {
        gen.finalResult = obj;
      } else if (obj.type === 'rate_limit_event' && obj.rate_limit_info) {
        saveRateLimitInfo(obj.rate_limit_info);
      }
    },
  },
  antigravity: {
    command: ANTIGRAVITY_BIN,
    buildArgs({ fullPrompt, isResume, model, nativeConversationId }) {
      const args = [
        '-p', fullPrompt,
        '--output-format', 'stream-json',
        '--dangerously-skip-permissions',
      ];
      if (model) args.push('--model', model);
      if (isResume && nativeConversationId) args.push('--conversation', nativeConversationId);
      return args;
    },
    parseLine(obj, gen, broadcast) {
      if (obj.event === 'init' && obj.conversation_id) {
        gen.antigravityConversationId = obj.conversation_id;
        return;
      }
      if (obj.event === 'step_update' && obj.step_update) {
        const su = obj.step_update;
        if (su.usage && su.usage.thinking_tokens > 0 && !gen.usedThinking) {
          gen.usedThinking = true;
          broadcast('thinking_start', {});
        }
        if (su.step_type === 'agent_response') {
          if (su.text_delta) {
            if (!gen.currentBlock || gen.currentBlock.type !== 'text') {
              gen.currentBlock = { type: 'text', text: '' };
              gen.blocks.push(gen.currentBlock);
            }
            gen.assistantText += su.text_delta;
            gen.currentBlock.text += su.text_delta;
            broadcast('text_delta', { text: su.text_delta });
          }
        } else if (su.step_type === 'tool') {
          const id = `${su.conversation_id || obj.conversation_id || ''}-${su.step_index}`;
          if (su.state === 'ACTIVE') {
            const meta = { id, name: su.tool_name, input: (su.tool_info && su.tool_info.parameters) || null, done: false, images: [] };
            gen.toolMeta.set(id, meta);
            if (!gen.currentBlock || gen.currentBlock.type !== 'tools') {
              gen.currentBlock = { type: 'tools', tools: [] };
              gen.blocks.push(gen.currentBlock);
            }
            gen.currentBlock.tools.push(meta);
            broadcast('tool_start', { id, name: meta.name });
            broadcast('tool_input', { id, name: meta.name, input: meta.input });
          } else if (su.state === 'DONE') {
            const meta = gen.toolMeta.get(id);
            if (meta) {
              meta.done = true;
              const output = su.tool_info && su.tool_info.output;
              broadcast('tool_result', { id, isError: false, summary: String(output == null ? '' : output).slice(0, 4000), images: [] });
            }
          }
        }
      } else if (obj.event === 'result' && obj.result) {
        gen.finalResult = { result: obj.result.response, usage: obj.result.usage };
      }
    },
  },
};

app.post('/api/chat/stream', requireAuth, (req, res) => {
  const { message, conversationId, attachments, mode } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message required' });
  }

  const convos = loadConvos();
  const appSettings = loadAppSettings();
  const providerName = PROVIDERS[appSettings.provider] ? appSettings.provider : 'claude';
  const provider = PROVIDERS[providerName];
  const model = appSettings.model[providerName];

  let convoId = conversationId;
  let isResume = false;
  if (convoId && convos[convoId]) {
    isResume = true;
  } else {
    convoId = crypto.randomUUID();
    convos[convoId] = {
      title: message.slice(0, 60), updatedAt: Date.now(), messages: [],
      mode: mode === 'improve' ? 'improve' : 'workspace',
    };
  }
  if (activeGenerations.has(convoId)) {
    return res.status(409).json({ error: 'a response is already generating for this conversation' });
  }
  const convoMode = convos[convoId].mode || 'workspace';
  const cwd = convoMode === 'improve' ? APP_DIR : WORKSPACE;

  // Each CLI keeps its own native session/resume mechanism across consecutive turns on the SAME
  // provider (efficient, cached). The moment the active provider differs from whoever handled the
  // previous turn, that native history is invisible to it — so rebuild enough context manually
  // from our own stored transcript instead of the thread silently breaking on a switch.
  const lastAssistant = [...convos[convoId].messages].reverse().find(m => m.role === 'assistant');
  const switchedProvider = isResume && lastAssistant && lastAssistant.provider && lastAssistant.provider !== providerName;

  let fullPrompt = message;
  if (Array.isArray(attachments) && attachments.length) {
    const list = attachments.map(a => `- ${a.relativePath} (${a.filename})`).join('\n');
    fullPrompt += `\n\n[Attached files, relative to your working directory]\n${list}`;
  }
  if (switchedProvider) {
    const transcript = convos[convoId].messages.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n\n');
    fullPrompt = `[Continuing an existing conversation previously handled by a different AI CLI/model. Prior conversation, for context:]\n\n${transcript}\n\n[End of prior context — continue naturally from here.]\n\n${fullPrompt}`;
  }
  if (providerName === 'antigravity') {
    if (convoMode === 'improve') fullPrompt = `${IMPROVE_SYSTEM_PROMPT}\n\n${fullPrompt}`;
    const memory = readClaudeMemorySummary();
    if (memory) fullPrompt = `[Shared memory notes carried over from the Claude-side agent, for context:]\n${memory}\n\n${fullPrompt}`;
  }

  convos[convoId].messages.push({
    role: 'user', text: message, attachments: attachments || [], at: Date.now(),
  });
  saveConvos(convos);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const args = provider.buildArgs({
    fullPrompt,
    isResume: isResume && !switchedProvider,
    convoId,
    convoMode,
    model,
    nativeConversationId: convos[convoId].antigravityConversationId,
  });

  const child = spawn(provider.command, args, { cwd, env: process.env });

  const gen = {
    child,
    blocks: [], // ordered text/tools segments, in the order they actually happened
    currentBlock: null,
    assistantText: '',
    usedThinking: false,
    toolMeta: new Map(), // tool_use id -> same object referenced inside blocks
    finalResult: null,
    antigravityConversationId: null,
    stderrBuf: '',
    subscribers: new Set([res]),
  };
  activeGenerations.set(convoId, gen);

  const broadcast = (event, data) => {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const sub of gen.subscribers) sub.write(line);
  };
  broadcast('start', { conversationId: convoId });

  let buffer = '';

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }

      provider.parseLine(obj, gen, broadcast);
    }
  });

  child.stderr.on('data', (d) => { gen.stderrBuf += d.toString(); });

  child.on('close', (code) => {
    activeGenerations.delete(convoId);
    const convosNow = loadConvos();
    if (convosNow[convoId]) {
      const replyText = (gen.finalResult && gen.finalResult.result) || gen.assistantText || '(no response)';
      const isError = code !== 0 && !gen.finalResult;

      convosNow[convoId].messages.push({
        role: 'assistant', text: replyText, blocks: gen.blocks, usedThinking: gen.usedThinking || undefined,
        provider: providerName, model, at: Date.now(),
      });
      convosNow[convoId].updatedAt = Date.now();
      if (gen.antigravityConversationId) convosNow[convoId].antigravityConversationId = gen.antigravityConversationId;
      saveConvos(convosNow);

      if (isError) {
        broadcast('error', { message: gen.stderrBuf.slice(0, 2000) || `claude exited with code ${code}` });
      } else {
        broadcast('done', { conversationId: convoId, reply: replyText, usedThinking: gen.usedThinking || undefined });
      }

      // Only push a notification if nobody was actually watching it finish — mirrors how
      // chat apps don't notify you about a conversation you already have open.
      console.log(`[push] generation for ${convoId} finished with ${gen.subscribers.size} subscriber(s) still attached`);
      if (gen.subscribers.size === 0) {
        notifySubscribers({
          title: convosNow[convoId].title || 'Personal Agent',
          body: isError ? 'Something went wrong with the response.' : replyText.slice(0, 180),
          conversationId: convoId,
        }).catch(() => {});
      }
    }
    for (const sub of gen.subscribers) sub.end();
    gen.subscribers.clear();
    restartIfPending();
  });

  child.on('error', (err) => {
    activeGenerations.delete(convoId);
    broadcast('error', { message: err.message });
    for (const sub of gen.subscribers) sub.end();
    gen.subscribers.clear();
    restartIfPending();
  });

  req.on('close', () => {
    // Deliberately NOT killing the child here — the generation keeps running in the
    // background and gets persisted regardless of whether any client is still watching.
    gen.subscribers.delete(res);
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent backend listening on 127.0.0.1:${PORT}, workspace=${WORKSPACE}`);
});
