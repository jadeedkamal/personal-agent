(() => {
'use strict';

const $ = (sel) => document.querySelector(sel);
const loginScreen = $('#login-screen');
const appEl = $('#app');
const loginForm = $('#login-form');
const loginError = $('#login-error');
const sidebar = $('#sidebar');
const sidebarOverlay = $('#sidebar-overlay');
const menuBtn = $('#menu-btn');
const newChatBtn = $('#new-chat-btn');
const convoList = $('#convo-list');
const convoSearch = $('#convo-search');
const headerTitle = $('#header-title');
const statusPill = $('#status-pill');
const messagesEl = $('#messages');
const notifBtn = $('#notif-btn');
const liveDesktopBtn = $('#live-desktop-btn');
const liveDesktopPanel = $('#live-desktop-panel');
const liveDesktopFrameWrap = $('#live-desktop-frame-wrap');
const messagesInner = $('#messages-inner');
const emptyState = $('#empty-state');
const pendingAttachmentsEl = $('#pending-attachments');
const input = $('#input');
const sendBtn = $('#send-btn');
const attachBtn = $('#attach-btn');
const fileInput = $('#file-input');
const micBtn = $('#mic-btn');

const imageViewer = $('#image-viewer');
const imageViewerImg = $('#image-viewer-img');
function openImageViewer(url) {
  imageViewerImg.src = url;
  imageViewer.hidden = false;
}
function closeImageViewer() {
  imageViewer.hidden = true;
  imageViewerImg.src = '';
}
$('#image-viewer-close').addEventListener('click', closeImageViewer);
imageViewer.addEventListener('click', (e) => { if (e.target === imageViewer) closeImageViewer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !imageViewer.hidden) closeImageViewer(); });

// ---------------- Secure input ----------------
// Shows a request from the agent for a sensitive value (password, OTP, etc.) that gets typed
// directly into the currently-focused field on the virtual desktop — it's never sent as a chat
// message, never added to the conversation transcript, and never persisted to sessions.json.

const secureInputModal = $('#secure-input-modal');
const secureInputPromptEl = $('#secure-input-prompt');
const secureInputValueEl = $('#secure-input-value');
let currentSecureInputId = null;

function showSecureInputRequest(id, prompt) {
  currentSecureInputId = id;
  secureInputPromptEl.textContent = prompt || 'Enter the requested value';
  secureInputValueEl.value = '';
  secureInputModal.hidden = false;
  secureInputValueEl.focus();
}
function hideSecureInputRequest(id) {
  if (id && id !== currentSecureInputId) return; // a resolve/cancel for a different (stale) request
  secureInputModal.hidden = true;
  secureInputValueEl.value = '';
  currentSecureInputId = null;
}
async function submitSecureInput() {
  if (!currentSecureInputId) return;
  const id = currentSecureInputId;
  const value = secureInputValueEl.value;
  hideSecureInputRequest(id); // clear it out of the DOM before the network round-trip
  await fetch(`/api/secure-input/${id}/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }),
  });
}
async function cancelSecureInput() {
  if (!currentSecureInputId) return;
  const id = currentSecureInputId;
  hideSecureInputRequest(id);
  await fetch(`/api/secure-input/${id}/cancel`, { method: 'POST' });
}
$('#secure-input-submit').addEventListener('click', submitSecureInput);
$('#secure-input-cancel').addEventListener('click', cancelSecureInput);
secureInputValueEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitSecureInput(); }
  else if (e.key === 'Escape') { e.preventDefault(); cancelSecureInput(); }
});

// ---------------- Model picker ----------------
// Which specific model to use within the currently active CLI engine (set in Settings). The
// engine choice determines which catalog this dropdown shows.

const modelSelect = $('#model-select');

async function refreshModelPicker() {
  try {
    const [modelsRes, appSettingsRes] = await Promise.all([fetch('/api/models'), fetch('/api/app-settings')]);
    if (!modelsRes.ok || !appSettingsRes.ok) return;
    const { catalog } = await modelsRes.json();
    const appSettings = await appSettingsRes.json();
    const provider = appSettings.provider || 'claude';
    const models = catalog[provider] || [];
    modelSelect.innerHTML = models.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}</option>`).join('');
    modelSelect.value = appSettings.model[provider];
  } catch {}
}

modelSelect.addEventListener('change', async () => {
  const appSettingsRes = await fetch('/api/app-settings');
  const appSettings = appSettingsRes.ok ? await appSettingsRes.json() : { provider: 'claude' };
  await fetch('/api/app-settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: { [appSettings.provider]: modelSelect.value } }),
  });
});

// ---------------- Settings ----------------

const settingsBtn = $('#settings-btn');
const settingsModal = $('#settings-modal');
const settingsBody = $('#settings-body');

function formatBytes(n) {
  if (typeof n !== 'number') return 'Unknown';
  const gb = n / (1024 ** 3);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(n / (1024 ** 2)).toFixed(0)} MB`;
}

function settingsRow(k, v) {
  return `<div class="settings-row"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span></div>`;
}

function formatResetTime(unixSeconds) {
  if (typeof unixSeconds !== 'number') return 'unknown';
  return new Date(unixSeconds * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function openSettings() {
  settingsModal.hidden = false;
  settingsBody.innerHTML = '<div class="settings-loading">Loading…</div>';
  try {
    const [sysRes, statusRes, usageRes, appSettingsRes] = await Promise.all([
      fetch('/api/system-info'),
      fetch('/api/status'),
      fetch('/api/usage-stats'),
      fetch('/api/app-settings'),
    ]);
    if (!sysRes.ok) throw new Error('request failed');
    const d = await sysRes.json();
    const status = statusRes.ok ? await statusRes.json() : {};
    const usage = usageRes.ok ? await usageRes.json() : {};
    const appSettings = appSettingsRes.ok ? await appSettingsRes.json() : { provider: 'claude' };

    const ramUsed = formatBytes(d.ramTotalBytes - d.ramFreeBytes);
    const ramTotal = formatBytes(d.ramTotalBytes);
    const diskLine = d.disk ? `${formatBytes(d.disk.usedBytes)} / ${formatBytes(d.disk.totalBytes)} used` : 'Unknown';

    const rows = [
      settingsRow('Username', d.username),
      settingsRow('Processor', `${d.cpu.model} (${d.cpu.cores} cores)`),
      settingsRow('RAM', `${ramUsed} / ${ramTotal} used`),
      settingsRow('Graphics Card', d.gpu),
      settingsRow('Storage', diskLine),
    ];

    if (status.authMethod === 'google' && status.googleEmail) {
      rows.push(settingsRow('Google Account', status.googleEmail));
    }

    const rl = usage.rateLimit;
    if (rl && rl.unifiedWindows) {
      const fiveHour = rl.unifiedWindows.five_hour;
      const sevenDay = rl.unifiedWindows.seven_day;
      if (fiveHour) rows.push(settingsRow('Claude usage (5h)', `${Math.round(fiveHour.utilization * 100)}% used · resets ${formatResetTime(fiveHour.resetsAt)}`));
      if (sevenDay) rows.push(settingsRow('Claude usage (7d)', `${Math.round(sevenDay.utilization * 100)}% used · resets ${formatResetTime(sevenDay.resetsAt)}`));
    } else {
      rows.push(settingsRow('Claude usage', 'Not available yet — send a message first'));
    }

    settingsBody.innerHTML = rows.join('');

    const engineRow = document.createElement('div');
    engineRow.className = 'settings-row';
    engineRow.innerHTML = `
      <span class="k">CLI Engine</span>
      <select class="settings-select">
        <option value="claude">Claude CLI</option>
        <option value="antigravity">Antigravity CLI</option>
      </select>`;
    const engineSelect = engineRow.querySelector('select');
    engineSelect.value = appSettings.provider || 'claude';
    engineSelect.addEventListener('change', async () => {
      await fetch('/api/app-settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: engineSelect.value }),
      });
      refreshModelPicker();
    });
    settingsBody.appendChild(engineRow);
  } catch {
    settingsBody.innerHTML = '<div class="settings-loading">Failed to load system info</div>';
  }
}
function closeSettings() { settingsModal.hidden = true; }

settingsBtn.addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', closeSettings);
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !settingsModal.hidden) closeSettings(); });

// ---------------- Theme ----------------
const THEMES = [
  { id: 'dark', label: 'Dark', swatch: '#4f8cff' },
  { id: 'light', label: 'Light', swatch: '#3b5bdb' },
  { id: 'midnight', label: 'Midnight', swatch: '#4096ff' },
  { id: 'forest', label: 'Forest', swatch: '#3cb46e' },
  { id: 'sunset', label: 'Sunset', swatch: '#ff7850' },
];
const themeBtn = $('#theme-btn');
const themeMenu = $('#theme-menu');
const themeColorMeta = document.querySelector('meta[name="theme-color"]');
const CHECK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function renderThemeMenu(active) {
  themeMenu.innerHTML = THEMES.map((t) => `
    <button type="button" class="theme-option btn-reset" data-id="${t.id}">
      <span class="swatch" style="background:${t.swatch}"></span>
      <span class="label">${t.label}</span>
      <span class="check">${t.id === active ? CHECK_SVG : ''}</span>
    </button>
  `).join('');
}

function applyTheme(id) {
  if (!THEMES.some((t) => t.id === id)) id = 'dark';
  document.documentElement.setAttribute('data-theme', id);
  try { localStorage.setItem('theme', id); } catch (e) {}
  if (themeColorMeta) themeColorMeta.content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  renderThemeMenu(id);
}

themeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  themeMenu.hidden = !themeMenu.hidden;
});
themeMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('.theme-option');
  if (!btn) return;
  applyTheme(btn.dataset.id);
  themeMenu.hidden = true;
});
document.addEventListener('click', () => { themeMenu.hidden = true; });

applyTheme((() => { try { return localStorage.getItem('theme') || 'dark'; } catch (e) { return 'dark'; } })());

let currentConversationId = null;
let currentConversationMode = 'workspace';
let conversations = []; // {id, title, updatedAt, mode}
let pendingFiles = []; // {filename, relativePath, mimeType, previewUrl}
let isStreaming = false;
let currentEventSourceAbort = null;
// How many messages of the current conversation are already rendered in the DOM — lets
// refreshConversationTail() append only what's new instead of re-rendering everything.
let renderedMessageCount = 0;

// ---------------- Auth ----------------

async function checkStatus() {
  const r = await fetch('/api/status');
  const data = await r.json();
  if (data.authed) {
    loginScreen.hidden = true;
    appEl.hidden = false;
    refreshModelPicker();
    await loadConversations();
    // A notification click takes priority over just restoring whatever was open before.
    const targetId = notifiedConversationId || localStorage.getItem('lastConversationId');
    if (targetId && conversations.some(c => c.id === targetId)) await selectConversation(targetId);
  } else {
    loginScreen.hidden = false;
    appEl.hidden = true;
  }
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const password = $('#password').value;
  const r = await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  });
  if (r.ok) {
    $('#password').value = '';
    await checkStatus();
  } else {
    const data = await r.json().catch(() => ({}));
    loginError.textContent = data.error || 'Login failed';
  }
});

// ---------------- Sidebar / conversations ----------------

function openSidebar() { sidebar.classList.add('open'); sidebarOverlay.classList.add('open'); }
function closeSidebar() { sidebar.classList.remove('open'); sidebarOverlay.classList.remove('open'); }
menuBtn.addEventListener('click', openSidebar);
sidebarOverlay.addEventListener('click', closeSidebar);

function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return day === 1 ? 'Yesterday' : `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

async function loadConversations() {
  const r = await fetch('/api/conversations');
  if (!r.ok) return;
  const data = await r.json();
  conversations = data.conversations || [];
  renderConvoList();
}

function renderConvoList() {
  const filter = convoSearch.value.trim().toLowerCase();
  convoList.innerHTML = '';
  const filtered = conversations.filter(c => !filter || (c.title || '').toLowerCase().includes(filter));
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:16px 10px;color:var(--muted-2);font-size:13px;';
    empty.textContent = filter ? 'No matches' : 'No conversations yet';
    convoList.appendChild(empty);
    return;
  }
  for (const c of filtered) {
    const row = document.createElement('div');
    row.className = 'convo-row' + (c.id === currentConversationId ? ' active' : '');
    const modeBadge = c.mode === 'improve'
      ? `<span class="mode-badge" title="Improve mode"><svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.9L12 3z" fill="currentColor"/></svg></span>`
      : '';
    row.innerHTML = `
      <div class="meta">
        <div class="title"></div>
        <div class="time"></div>
      </div>
      ${modeBadge}
      <div class="row-actions">
        <button class="btn-reset rename-btn" title="Rename">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="btn-reset delete-btn" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6h16z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>`;
    row.querySelector('.title').textContent = c.title || 'Untitled';
    row.querySelector('.time').textContent = relTime(c.updatedAt);
    row.addEventListener('click', (e) => {
      if (e.target.closest('.row-actions')) return;
      selectConversation(c.id);
      closeSidebar();
    });
    row.querySelector('.rename-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      startRename(row, c);
    });
    row.querySelector('.delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${c.title}"?`)) return;
      await fetch(`/api/conversations/${c.id}`, { method: 'DELETE' });
      if (currentConversationId === c.id) startNewChat();
      await loadConversations();
    });
    convoList.appendChild(row);
  }
}

function startRename(row, c) {
  const meta = row.querySelector('.meta');
  const titleEl = row.querySelector('.title');
  const inputEl = document.createElement('input');
  inputEl.className = 'title-input';
  inputEl.value = c.title || '';
  titleEl.replaceWith(inputEl);
  inputEl.focus();
  inputEl.select();
  const commit = async () => {
    const val = inputEl.value.trim();
    if (val && val !== c.title) {
      await fetch(`/api/conversations/${c.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: val }),
      });
    }
    await loadConversations();
  };
  inputEl.addEventListener('blur', commit);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); inputEl.blur(); }
    if (e.key === 'Escape') { inputEl.value = c.title; inputEl.blur(); }
  });
}

convoSearch.addEventListener('input', renderConvoList);

const improveBtn = $('#improve-btn');
const improveBanner = $('#improve-banner');

newChatBtn.addEventListener('click', () => { startNewChat('workspace'); closeSidebar(); });
improveBtn.addEventListener('click', () => { startNewChat('improve'); closeSidebar(); });

function startNewChat(mode) {
  currentConversationId = null;
  localStorage.removeItem('lastConversationId');
  currentConversationMode = mode || 'workspace';
  renderedMessageCount = 0;
  headerTitle.textContent = currentConversationMode === 'improve' ? 'Improve the agent' : 'New chat';
  messagesInner.innerHTML = '';
  messagesInner.appendChild(improveBanner);
  messagesInner.appendChild(emptyState);
  improveBanner.hidden = currentConversationMode !== 'improve';
  emptyState.hidden = false;
  emptyState.querySelector('h2').textContent = currentConversationMode === 'improve' ? 'What should I improve?' : 'What can I help with?';
  clearPendingAttachments();
  renderConvoList();
}

async function selectConversation(id) {
  currentConversationId = id;
  localStorage.setItem('lastConversationId', id);
  const r = await fetch(`/api/conversations/${id}`);
  if (!r.ok) return;
  const convo = await r.json();
  currentConversationMode = convo.mode || 'workspace';
  headerTitle.textContent = convo.title || 'Conversation';
  messagesInner.innerHTML = '';
  improveBanner.hidden = currentConversationMode !== 'improve';
  if (currentConversationMode === 'improve') messagesInner.appendChild(improveBanner);
  emptyState.hidden = true;
  for (const m of convo.messages || []) {
    if (m.role === 'user') addUserMessage(m.text, m.attachments || []);
    else if (m.role === 'assistant') addAssistantMessage(m.text, m.tools || [], m.usedThinking, m.blocks);
  }
  renderedMessageCount = (convo.messages || []).length;
  scrollToBottom();
  renderConvoList();
  // Pick up a response that's still generating (started from another tab/device, or from
  // this same tab before the page was reloaded) — it kept running on the server the whole time.
  tryReattach(id);
}

// ---------------- Markdown + lightweight code highlighting ----------------

function highlightCode(code) {
  const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped
    .replace(/(\/\/.*$|#.*$)/gm, '<span class="tok-com">$1</span>')
    .replace(/(&quot;.*?&quot;|'.*?'|`.*?`)/g, '<span class="tok-str">$1</span>')
    .replace(/\b(const|let|var|function|return|if|else|for|while|import|export|from|class|new|async|await|try|catch|def|print|true|false|null|undefined|None|True|False)\b/g, '<span class="tok-kw">$1</span>')
    .replace(/\b(\d+(\.\d+)?)\b/g, '<span class="tok-num">$1</span>');
}

const renderer = new marked.Renderer();
renderer.code = (code, lang) => {
  const codeText = typeof code === 'object' ? code.text : code;
  const language = typeof code === 'object' ? code.lang : lang;
  return `<div class="code-block"><div class="code-header"><span>${language || 'text'}</span></div><pre><code>${highlightCode(codeText || '')}</code></pre></div>`;
};
marked.setOptions({ renderer, breaks: true });

function renderMarkdown(text) {
  try { return marked.parse(text || '').trim(); } catch { return escapeHtml(text || ''); }
}
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------- Message rendering ----------------

let compactMessages = false;
const historyToggleBar = $('#history-toggle-bar');
const historyToggleLabel = $('#history-toggle-label');

function applyMessageVisibility() {
  const rows = messagesInner.querySelectorAll('.msg-row');
  rows.forEach((row, i) => {
    row.classList.toggle('history-hidden', compactMessages && i < rows.length - 2);
  });
}

function setCompactMessages(compact) {
  compactMessages = compact;
  historyToggleLabel.textContent = compact ? 'View full history' : 'Show latest only';
  applyMessageVisibility();
}

$('#history-toggle-btn').addEventListener('click', () => setCompactMessages(!compactMessages));

function scrollToBottom() {
  applyMessageVisibility();
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function fileIconSvg() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="var(--muted)" stroke-width="1.6"/><circle cx="9" cy="10" r="1.6" fill="var(--muted)"/><path d="M4 17l5-5 3 3 4-4 4 4" stroke="var(--muted)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function addUserMessage(text, attachments) {
  emptyState.hidden = true;
  const row = document.createElement('div');
  row.className = 'msg-row user';
  let attachHtml = '';
  if (attachments && attachments.length) {
    attachHtml = attachments.map(a => `
      <div class="attach-chip" style="margin-bottom:6px;">
        <div class="thumb">${a.mimeType && a.mimeType.startsWith('image/') ? `<img src="/${a.relativePath}">` : fileIconSvg()}</div>
        <span class="name">${escapeHtml(a.filename)}</span>
      </div>`).join('');
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  row.innerHTML = attachHtml;
  row.appendChild(bubble);
  messagesInner.appendChild(row);
  scrollToBottom();
}

const TOOL_ICONS = {
  Bash: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M7 9l3 3-3 3M13 15h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  Read: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M14 4H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V8l-5-4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 4v4h4" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  Edit: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  Write: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  default: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.6"/><path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
};

function toolLabel(name, input) {
  input = input || {};
  if (name === 'Bash') return input.description || input.command || 'Running command';
  if (name === 'Read') return `Reading ${input.file_path || ''}`;
  if (name === 'Edit') return `Editing ${input.file_path || ''}`;
  if (name === 'Write') return `Writing ${input.file_path || ''}`;
  if (name && name.startsWith('mcp__gui__')) return name.replace('mcp__gui__', '') + ' (desktop)';
  return name || 'Working';
}

function spinnerSvg() {
  return `<svg class="spin" width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M12 3a9 9 0 106.36 2.64" stroke="var(--working)" stroke-width="2.2" stroke-linecap="round"/></svg>`;
}
function checkSvg() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="var(--online)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function addAssistantMessage(text, tools, usedThinking, blocks) {
  emptyState.hidden = true;
  const row = document.createElement('div');
  row.className = 'msg-row assistant';
  if (usedThinking) {
    row.appendChild(buildThinkingIndicator(true));
  }
  if (blocks && blocks.length) {
    // Ordered text/tool segments in the order they actually happened during the turn.
    for (const block of blocks) {
      if (block.type === 'text') {
        if (!block.text) continue;
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.innerHTML = renderMarkdown(block.text);
        row.appendChild(bubble);
      } else if (block.type === 'tools' && block.tools.length) {
        row.appendChild(buildToolFeed(block.tools, true));
        const images = collectImages(block.tools, { excludeScreenshots: liveDesktopOpen });
        if (images.length) row.appendChild(buildImageGallery(images));
      }
    }
  } else {
    // Legacy messages saved before segments existed: tools bucket, then one text bubble.
    if (tools && tools.length) {
      row.appendChild(buildToolFeed(tools, true));
      const images = collectImages(tools, { excludeScreenshots: liveDesktopOpen });
      if (images.length) row.appendChild(buildImageGallery(images));
    }
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = renderMarkdown(text);
    row.appendChild(bubble);
  }
  messagesInner.appendChild(row);
  scrollToBottom();
}

// Claude only exposes a redacted (empty) thinking transcript through this API surface —
// there's no real reasoning text to show, so this is a static indicator, not an expandable feed.
function buildThinkingIndicator(done) {
  const el = document.createElement('div');
  el.className = 'tool-feed thinking-indicator';
  el.innerHTML = done
    ? `${checkSvg()}<span class="label">Used extended thinking</span>`
    : `${spinnerSvg()}<span class="label">Thinking…</span>`;
  return el;
}

function buildToolFeed(tools, collapsed) {
  const feed = document.createElement('div');
  feed.className = 'tool-feed';
  const header = document.createElement('button');
  header.className = 'btn-reset tool-feed-header';
  const anyRunning = tools.some(t => !t.done);
  header.innerHTML = `
    ${anyRunning ? spinnerSvg() : checkSvg()}
    <span class="label">${anyRunning ? 'Working…' : `Used ${tools.length} tool${tools.length === 1 ? '' : 's'}`}</span>
    <span class="chevron">${chevronSvg()}</span>`;
  const body = document.createElement('div');
  body.className = 'tool-feed-body';
  body.hidden = collapsed;
  header.querySelector('.chevron').classList.toggle('open', !collapsed);
  renderToolSteps(body, tools);
  header.addEventListener('click', () => {
    body.hidden = !body.hidden;
    header.querySelector('.chevron').classList.toggle('open', !body.hidden);
  });
  feed.appendChild(header);
  feed.appendChild(body);
  feed._tools = tools;
  feed._header = header;
  feed._body = body;
  return feed;
}

function chevronSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function renderToolSteps(body, tools) {
  body.innerHTML = '';
  for (const t of tools) {
    const step = document.createElement('div');
    step.className = 'tool-step' + (!t.done ? ' running' : '');
    const icon = t.done ? checkSvg() : (TOOL_ICONS[t.name] || TOOL_ICONS.default);
    step.innerHTML = `<span class="icon">${icon}</span><span class="step-label">${escapeHtml(toolLabel(t.name, t.input))}</span>`;
    const showThumbs = t.images && t.images.length && !(liveDesktopOpen && t.name === SCREENSHOT_TOOL_NAME);
    if (showThumbs) {
      for (const img of t.images) {
        const thumb = document.createElement('button');
        thumb.className = 'tool-step-thumb btn-reset';
        thumb.innerHTML = `<img src="${img.url}" alt="tool result image">`;
        thumb.addEventListener('click', () => openImageViewer(img.url));
        step.appendChild(thumb);
      }
    }
    body.appendChild(step);
  }
}

const SCREENSHOT_TOOL_NAME = 'mcp__gui__screenshot';

function collectImages(tools, { excludeScreenshots = false } = {}) {
  const images = [];
  for (const t of tools || []) {
    if (excludeScreenshots && t.name === SCREENSHOT_TOOL_NAME) continue;
    if (t.images) images.push(...t.images);
  }
  return images;
}

function renderImagesInto(container, images) {
  container.innerHTML = '';
  for (const img of images) {
    const btn = document.createElement('button');
    btn.className = 'gallery-thumb btn-reset';
    btn.innerHTML = `<img src="${img.url}" alt="screenshot">`;
    btn.addEventListener('click', () => openImageViewer(img.url));
    container.appendChild(btn);
  }
}

function buildImageGallery(images) {
  const gallery = document.createElement('div');
  gallery.className = 'image-gallery';
  renderImagesInto(gallery, images);
  return gallery;
}

// ---------------- Streaming chat ----------------

function setStreaming(streaming) {
  isStreaming = streaming;
  sendBtn.classList.toggle('stop', streaming);
  sendBtn.innerHTML = streaming
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="6" y="6" width="12" height="12" rx="2" fill="white"/></svg>`
    : `<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M12 19V5M5 12l7-7 7 7" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  statusPill.className = streaming ? 'working' : 'online';
  statusPill.querySelector('.label').textContent = streaming ? 'Working' : 'Online';
}

sendBtn.addEventListener('click', () => {
  if (isStreaming) { cancelStream(); return; }
  send();
});

input.addEventListener('keydown', (e) => {
  // Enter now just inserts a newline (the textarea's own default behaviour — no handling
  // needed). Ctrl/Cmd+Enter sends, so there's still a keyboard way to send.
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 240) + 'px';
});

async function cancelStream() {
  if (currentEventSourceAbort) currentEventSourceAbort.abort();
  await fetch('/api/chat/cancel', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: currentConversationId }),
  });
  setStreaming(false);
}

// Builds one assistant turn's DOM (thinking indicator, typing spinner, and a growing
// chronological list of text/tool segments) plus the SSE handling that drives it. Shared by
// a freshly-sent message and by re-attaching to a generation still running on the server
// after a reload/reconnect — the same event stream shape drives both.
function createTurnRenderer() {
  const assistantRow = document.createElement('div');
  assistantRow.className = 'msg-row assistant';
  const thinkingIndicator = buildThinkingIndicator(false);
  thinkingIndicator.hidden = true;
  const typingIndicator = document.createElement('div');
  typingIndicator.className = 'typing-indicator';
  typingIndicator.innerHTML = spinnerSvg();
  assistantRow.appendChild(thinkingIndicator);
  assistantRow.appendChild(typingIndicator);
  messagesInner.appendChild(assistantRow);
  scrollToBottom();

  let thinkingStarted = false;
  let hadTextSegment = false;
  // The turn is rendered as a chronological sequence of segments (text bubble, tool-call
  // group, text bubble, ...) instead of bucketing all tool calls above all text — this
  // mirrors the order things actually happened rather than flattening it into two piles.
  let currentSeg = null;
  const toolIndexById = new Map(); // tool id -> { seg, tool }
  let renderScheduled = false;

  function finalizeSegment(seg) {
    if (!seg || seg.finalized) return;
    seg.finalized = true;
    if (seg.type === 'text') {
      seg.el.innerHTML = renderMarkdown(seg.text);
    } else if (seg.type === 'tools') {
      seg.el._header.innerHTML = `${checkSvg()}<span class="label">Used ${seg.tools.length} tool${seg.tools.length === 1 ? '' : 's'}</span><span class="chevron">${chevronSvg()}</span>`;
      seg.el._body.hidden = true;
      // Note: buildToolFeed() already attached a click listener to the header that toggles
      // body.hidden — don't attach a second one here (it would fire both and cancel out).
    }
  }

  function startTextSegment() {
    finalizeSegment(currentSeg);
    typingIndicator.hidden = true;
    hadTextSegment = true;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    assistantRow.appendChild(bubble);
    scrollToBottom();
    currentSeg = { type: 'text', el: bubble, text: '', finalized: false };
    return currentSeg;
  }

  function startToolsSegment() {
    finalizeSegment(currentSeg);
    typingIndicator.hidden = true;
    const feed = buildToolFeed([], false);
    feed._header.innerHTML = `${spinnerSvg()}<span class="label">Working…</span><span class="chevron open">${chevronSvg()}</span>`;
    const gallery = document.createElement('div');
    gallery.className = 'image-gallery';
    assistantRow.appendChild(feed);
    assistantRow.appendChild(gallery);
    scrollToBottom();
    currentSeg = { type: 'tools', el: feed, tools: [], gallery, finalized: false };
    return currentSeg;
  }

  // Batch DOM updates to at most once per animation frame — re-parsing markdown on every
  // single SSE delta (which can arrive many times per frame) is what made streaming feel choppy.
  function scheduleTextRender(seg) {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      if (seg.finalized) return; // superseded by a later segment (or already finalized) since this was scheduled
      seg.el.innerHTML = renderMarkdown(seg.text) + '<span class="caret"></span>';
      scrollToBottom();
    });
  }

  // Rebuilds everything that already happened before this client (re)connected, from a
  // 'sync' snapshot. All but the last block are already finished; the last one is still
  // live and becomes the segment that further live events append to.
  function hydrateFromBlocks(blocks) {
    blocks.forEach((block, i) => {
      const isLast = i === blocks.length - 1;
      if (block.type === 'text') {
        const seg = startTextSegment();
        seg.text = block.text || '';
        if (isLast) scheduleTextRender(seg); else finalizeSegment(seg);
      } else if (block.type === 'tools') {
        const seg = startToolsSegment();
        for (const t of block.tools) {
          seg.tools.push(t);
          toolIndexById.set(t.id, { seg, tool: t });
        }
        renderToolSteps(seg.el._body, seg.tools);
        const images = collectImages(seg.tools, { excludeScreenshots: liveDesktopOpen });
        if (images.length) renderImagesInto(seg.gallery, images);
        if (!isLast) finalizeSegment(seg);
      }
    });
  }

  async function handleEvent(event, payload) {
    if (event === 'start') {
      currentConversationId = payload.conversationId;
      localStorage.setItem('lastConversationId', currentConversationId);
    } else if (event === 'sync') {
      hydrateFromBlocks(payload.blocks || []);
      if (payload.usedThinking) {
        thinkingStarted = true;
        thinkingIndicator.hidden = false;
        thinkingIndicator.innerHTML = `${checkSvg()}<span class="label">Used extended thinking</span>`;
      }
    } else if (event === 'thinking_start') {
      thinkingStarted = true;
      thinkingIndicator.hidden = false;
    } else if (event === 'tool_start') {
      const seg = (currentSeg && currentSeg.type === 'tools') ? currentSeg : startToolsSegment();
      const t = { id: payload.id, name: payload.name, input: null, done: false };
      seg.tools.push(t);
      toolIndexById.set(payload.id, { seg, tool: t });
      renderToolSteps(seg.el._body, seg.tools);
    } else if (event === 'tool_input') {
      const entry = toolIndexById.get(payload.id);
      if (entry) {
        entry.tool.name = payload.name;
        entry.tool.input = payload.input;
        renderToolSteps(entry.seg.el._body, entry.seg.tools);
      }
    } else if (event === 'tool_result') {
      const entry = toolIndexById.get(payload.id);
      if (entry) {
        entry.tool.done = true;
        entry.tool.images = payload.images || [];
        renderToolSteps(entry.seg.el._body, entry.seg.tools);
        const segImages = collectImages(entry.seg.tools, { excludeScreenshots: liveDesktopOpen });
        if (segImages.length) {
          renderImagesInto(entry.seg.gallery, segImages);
          scrollToBottom();
        }
      }
    } else if (event === 'text_delta') {
      const seg = (currentSeg && currentSeg.type === 'text') ? currentSeg : startTextSegment();
      seg.text += payload.text;
      scheduleTextRender(seg);
    } else if (event === 'done') {
      finalizeSegment(currentSeg);
      if (!hadTextSegment) {
        const seg = startTextSegment();
        seg.text = payload.reply || '(no response)';
        finalizeSegment(seg);
      }
      typingIndicator.hidden = true;
      thinkingIndicator.hidden = !(thinkingStarted || payload.usedThinking);
      if (!thinkingIndicator.hidden) {
        thinkingIndicator.innerHTML = `${checkSvg()}<span class="label">Used extended thinking</span>`;
      }
      renderedMessageCount += 1;
      await loadConversations();
      headerTitle.textContent = (conversations.find(c => c.id === currentConversationId) || {}).title || headerTitle.textContent;
    } else if (event === 'error') {
      typingIndicator.hidden = true;
      const seg = (currentSeg && currentSeg.type === 'text') ? currentSeg : startTextSegment();
      seg.finalized = true;
      seg.el.textContent = payload.message || 'Something went wrong';
      assistantRow.classList.add('error');
      renderedMessageCount += 1;
    }
  }

  function handleStreamError(err) {
    typingIndicator.hidden = true;
    if (err.name === 'AbortError') {
      finalizeSegment(currentSeg); // close out any in-progress segment before appending a "stopped" bubble
      if (!hadTextSegment) {
        const seg = startTextSegment();
        seg.finalized = true;
        seg.el.textContent = '(stopped)';
      }
      return;
    }
    // A real network hiccup, not a user-initiated stop — leave whatever's shown so far as-is
    // (the generation keeps running server-side regardless of this connection) and let the
    // reconnect listeners (visibilitychange/online/pageshow) re-attach once we're back.
    scheduleReattach(1500);
  }

  return { assistantRow, handleEvent, handleStreamError };
}

async function consumeResponse(resp, tr) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = chunk.split('\n');
      let event = 'message', data = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (!data) continue;
      let payload;
      try { payload = JSON.parse(data); } catch { continue; }
      if (event === 'secure_input_request') {
        showSecureInputRequest(payload.id, payload.prompt);
      } else if (event === 'secure_input_resolved') {
        hideSecureInputRequest(payload.id);
      } else {
        await tr.handleEvent(event, payload);
      }
    }
  }
}

async function send() {
  const text = input.value.trim();
  if (!text && !pendingFiles.length) return;
  if (isStreaming) return;

  const attachments = pendingFiles.slice();
  clearPendingAttachments();
  input.value = '';
  input.style.height = 'auto';

  addUserMessage(text, attachments);
  renderedMessageCount += 1;
  setStreaming(true);

  const tr = createTurnRenderer();
  const controller = new AbortController();
  currentEventSourceAbort = controller;

  try {
    const resp = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, conversationId: currentConversationId, attachments, mode: currentConversationMode }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      throw new Error(errBody.error || `Request failed (${resp.status})`);
    }
    await consumeResponse(resp, tr);
  } catch (err) {
    tr.handleStreamError(err);
  } finally {
    setStreaming(false);
    currentEventSourceAbort = null;
  }
}

// Re-attaches to a generation that's still running on the server for `conversationId` — the
// backend keeps it running independent of any client connection, so this covers reopening a
// conversation after a reload, or reconnecting after the tab was backgrounded/offline mid-turn.
// A non-200 just means nothing is currently generating for it (already finished, or never started).
async function tryReattach(conversationId) {
  if (!conversationId || isStreaming) return;
  let resp;
  try {
    resp = await fetch(`/api/chat/attach?conversationId=${encodeURIComponent(conversationId)}`);
  } catch {
    return; // still offline — the online/visibilitychange/pageshow listeners will try again
  }
  if (resp.status !== 200) {
    await refreshConversationTail(conversationId);
    return;
  }
  if (conversationId !== currentConversationId) {
    try { await resp.body.cancel(); } catch {}
    return;
  }

  setStreaming(true);
  const tr = createTurnRenderer();
  try {
    await consumeResponse(resp, tr);
  } catch (err) {
    tr.handleStreamError(err);
  } finally {
    setStreaming(false);
  }
}

// Appends any messages that were persisted while we weren't looking (generation finished
// while backgrounded/offline/closed) without re-rendering history that's already shown.
async function refreshConversationTail(conversationId) {
  if (conversationId !== currentConversationId) return;
  let convo;
  try {
    const r = await fetch(`/api/conversations/${conversationId}`);
    if (!r.ok) return;
    convo = await r.json();
  } catch {
    return;
  }
  const msgs = convo.messages || [];
  if (msgs.length <= renderedMessageCount) return;
  for (const m of msgs.slice(renderedMessageCount)) {
    if (m.role === 'user') addUserMessage(m.text, m.attachments || []);
    else if (m.role === 'assistant') addAssistantMessage(m.text, m.tools || [], m.usedThinking, m.blocks);
  }
  renderedMessageCount = msgs.length;
  scrollToBottom();
}

let reattachTimer = null;
function scheduleReattach(delayMs) {
  if (reattachTimer) return;
  reattachTimer = setTimeout(() => {
    reattachTimer = null;
    if (!isStreaming) tryReattach(currentConversationId);
  }, delayMs);
}

// Covers: browser/PWA reopened, tab switched back to, network reconnected, or restored from
// the back/forward cache — any of these can be the moment a response finished without us
// ever seeing it, or a moment where our stream silently died without an error event.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleReattach(0);
});
window.addEventListener('online', () => scheduleReattach(0));
window.addEventListener('pageshow', () => scheduleReattach(0));

// ---------------- Attachments ----------------

function clearPendingAttachments() {
  pendingFiles = [];
  pendingAttachmentsEl.innerHTML = '';
}

function renderPendingAttachments() {
  pendingAttachmentsEl.innerHTML = '';
  for (const f of pendingFiles) {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    chip.innerHTML = `
      <div class="thumb">${f.previewUrl ? `<img src="${f.previewUrl}">` : fileIconSvg()}</div>
      <span class="name">${escapeHtml(f.filename)}</span>
      <button class="btn-reset remove-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>`;
    chip.querySelector('.remove-btn').addEventListener('click', () => {
      pendingFiles = pendingFiles.filter(x => x !== f);
      renderPendingAttachments();
    });
    pendingAttachmentsEl.appendChild(chip);
  }
}

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  for (const file of fileInput.files) {
    const form = new FormData();
    form.append('file', file);
    try {
      const r = await fetch('/api/upload', { method: 'POST', body: form });
      if (!r.ok) continue;
      const data = await r.json();
      const entry = { ...data, previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null };
      pendingFiles.push(entry);
    } catch {}
  }
  fileInput.value = '';
  renderPendingAttachments();
});

// ---------------- Voice input ----------------

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let isRecording = false;

if (SpeechRecognition) {
  recognizer = new SpeechRecognition();
  recognizer.continuous = false;
  recognizer.interimResults = true;
  recognizer.onresult = (e) => {
    let transcript = '';
    for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript;
    input.value = transcript;
    input.dispatchEvent(new Event('input'));
  };
  recognizer.onend = () => { isRecording = false; micBtn.classList.remove('recording'); };
  recognizer.onerror = () => { isRecording = false; micBtn.classList.remove('recording'); };
} else {
  micBtn.hidden = true;
}

micBtn.addEventListener('click', () => {
  if (!recognizer) return;
  if (isRecording) { recognizer.stop(); return; }
  isRecording = true;
  micBtn.classList.add('recording');
  recognizer.start();
});

// ---------------- Live Desktop ----------------

let liveDesktopOpen = false;
let liveDesktopIframe = null;

function setLiveDesktopOpen(open) {
  liveDesktopOpen = open;
  liveDesktopBtn.classList.toggle('active', open);
  liveDesktopPanel.hidden = !open;
  historyToggleBar.hidden = !open;
  setCompactMessages(open);
  localStorage.setItem('liveDesktopOpen', open ? '1' : '0');

  if (open && !liveDesktopIframe) {
    const status = document.createElement('div');
    status.className = 'ld-status';
    status.innerHTML = '<span class="dot"></span><span>Live desktop</span>';
    liveDesktopIframe = document.createElement('iframe');
    liveDesktopIframe.src = '/desktop/vnc.html?autoconnect=true&resize=scale&path=desktop/websockify';
    liveDesktopIframe.allow = 'clipboard-read; clipboard-write';
    liveDesktopFrameWrap.innerHTML = '';
    liveDesktopFrameWrap.appendChild(status);
    liveDesktopFrameWrap.appendChild(liveDesktopIframe);
  } else if (!open && liveDesktopIframe) {
    // Tear the iframe down (not just hide it) so the underlying VNC/websocket connection
    // actually closes instead of continuing to run invisibly in the background.
    liveDesktopFrameWrap.innerHTML = '';
    liveDesktopIframe = null;
  }
}

liveDesktopBtn.addEventListener('click', () => setLiveDesktopOpen(!liveDesktopOpen));

if (localStorage.getItem('liveDesktopOpen') === '1') setLiveDesktopOpen(true);

// ---------------- PWA service worker ----------------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'sw-updated' && !isStreaming) {
      location.reload();
    } else if (e.data && e.data.type === 'open-conversation' && e.data.conversationId) {
      selectConversation(e.data.conversationId);
    }
  });
}

// ---------------- Push notifications ----------------

const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64Safe);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function refreshNotifBtnState() {
  if (!pushSupported) { notifBtn.hidden = true; return; }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  notifBtn.classList.toggle('active', !!sub);
}

async function toggleNotifications() {
  if (!pushSupported) return;
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    await fetch('/api/push/unsubscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: existing.endpoint }),
    });
    await existing.unsubscribe();
    await refreshNotifBtnState();
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return;
  const r = await fetch('/api/push/vapid-public-key');
  if (!r.ok) return; // push not configured server-side
  const { publicKey } = await r.json();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await fetch('/api/push/subscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub.toJSON()),
  });
  await refreshNotifBtnState();
}

notifBtn.addEventListener('click', toggleNotifications);

// If a notification click had to open a fresh window (no existing tab to focus), the service
// worker points it at ?c=<conversationId> — pick that up once (after login is confirmed, in
// checkStatus), then clean the URL so a refresh doesn't re-trigger it.
const notifiedConversationId = new URLSearchParams(location.search).get('c');
if (notifiedConversationId) history.replaceState({}, '', location.pathname);

checkStatus();
if (pushSupported) refreshNotifBtnState();
refreshModelPicker();
})();
