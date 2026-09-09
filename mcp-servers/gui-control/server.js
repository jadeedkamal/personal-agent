#!/usr/bin/env node
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DISPLAY = process.env.GUI_DISPLAY || ':99';
const ENV = { ...process.env, DISPLAY };
const AGENT_APP_URL = process.env.AGENT_APP_INTERNAL_URL || 'http://127.0.0.1:3000';
const INTERNAL_SHARED_SECRET = process.env.INTERNAL_SHARED_SECRET;
const ANTIGRAVITY_BIN = path.join(os.homedir(), '.local/bin/agy');

// Polls for a short, bounded window (well under a single turn's lifetime) instead of blocking
// for the full 5-minute request lifetime — long in-flight tool calls don't survive this
// environment tearing down/recycling background work between turns, so the tool must return
// quickly either way and let the caller re-check later via check_secure_input.
async function pollBriefly(id) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const pollRes = await fetch(`${AGENT_APP_URL}/internal/secure-input/${id}/poll`, {
      headers: { 'X-Internal-Secret': INTERNAL_SHARED_SECRET },
    });
    if (pollRes.status === 404) return { status: 'cancelled' };
    const data = await pollRes.json();
    if (data.done) {
      await run('xdotool', ['type', '--delay', '30', '--', data.value]);
      return { status: 'entered' };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { status: 'pending' };
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: ENV, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

const KEY_MAP = {
  enter: 'Return', return: 'Return', tab: 'Tab', esc: 'Escape', escape: 'Escape',
  backspace: 'BackSpace', delete: 'Delete', space: 'space',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next',
};

function normalizeKey(k) {
  return k.split('+').map(part => {
    const p = part.trim().toLowerCase();
    return KEY_MAP[p] || part.trim();
  }).join('+');
}

const tools = [
  {
    name: 'screenshot',
    description: 'Take a screenshot of the virtual desktop and return it as an image.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const file = path.join(os.tmpdir(), `shot-${Date.now()}.png`);
      await run('scrot', ['-z', file]);
      const buf = fs.readFileSync(file);
      fs.unlinkSync(file);
      return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }] };
    },
  },
  {
    name: 'analyze_screen',
    description: 'Take a screenshot and have a separate vision model (Gemini, via the Antigravity CLI) analyze it, returning a written description instead of the raw image. Use this instead of `screenshot` when you just need to know what\'s on screen (e.g. to check on a long-running task) without spending your own context on image tokens. Optionally pass a specific question to focus the analysis; otherwise it gives a general description.',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string', description: 'What to look for or ask about the screenshot. Omit for a general description.' } },
    },
    handler: async ({ question }) => {
      const dir = os.tmpdir();
      const fname = `shot-${Date.now()}.png`;
      const file = path.join(dir, fname);
      await run('scrot', ['-z', file]);
      try {
        const prompt = question
          ? `Look at the image file ${fname} in this directory and answer this question about it: ${question}`
          : `Describe in detail what's currently shown in the image file ${fname} in this directory — visible windows, text, UI elements, and anything noteworthy.`;
        const analysis = await new Promise((resolve, reject) => {
          execFile(
            ANTIGRAVITY_BIN,
            ['-p', prompt, '--add-dir', dir, '--model', 'gemini-3.8-flash-high', '--output-format', 'text'],
            { env: ENV, maxBuffer: 20 * 1024 * 1024, timeout: 60000 },
            (err, stdout, stderr) => {
              if (err) return reject(new Error(stderr || err.message));
              resolve(stdout.trim());
            }
          );
        });
        return { content: [{ type: 'text', text: analysis }] };
      } finally {
        fs.unlink(file, () => {});
      }
    },
  },
  {
    name: 'get_screen_size',
    description: 'Get the virtual desktop resolution.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const out = await run('xdotool', ['getdisplaygeometry']);
      return { content: [{ type: 'text', text: out.trim() }] };
    },
  },
  {
    name: 'move_mouse',
    description: 'Move the mouse cursor to absolute screen coordinates.',
    inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
    handler: async ({ x, y }) => {
      await run('xdotool', ['mousemove', String(Math.round(x)), String(Math.round(y))]);
      return { content: [{ type: 'text', text: `Moved to ${x},${y}` }] };
    },
  },
  {
    name: 'click',
    description: 'Click the mouse at coordinates. button: left, middle, right. Set double:true for a double-click.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' }, y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'middle', 'right'] },
        double: { type: 'boolean' },
      },
      required: ['x', 'y'],
    },
    handler: async ({ x, y, button = 'left', double = false }) => {
      const btnMap = { left: '1', middle: '2', right: '3' };
      await run('xdotool', ['mousemove', String(Math.round(x)), String(Math.round(y))]);
      await run('xdotool', ['click', ...(double ? ['--repeat', '2', '--delay', '120'] : []), btnMap[button] || '1']);
      return { content: [{ type: 'text', text: `Clicked (${button}${double ? ', double' : ''}) at ${x},${y}` }] };
    },
  },
  {
    name: 'drag',
    description: 'Press the left mouse button at (x1,y1), drag to (x2,y2), and release.',
    inputSchema: {
      type: 'object',
      properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' } },
      required: ['x1', 'y1', 'x2', 'y2'],
    },
    handler: async ({ x1, y1, x2, y2 }) => {
      await run('xdotool', ['mousemove', String(x1), String(y1)]);
      await run('xdotool', ['mousedown', '1']);
      await run('xdotool', ['mousemove', String(x2), String(y2)]);
      await run('xdotool', ['mouseup', '1']);
      return { content: [{ type: 'text', text: `Dragged from ${x1},${y1} to ${x2},${y2}` }] };
    },
  },
  {
    name: 'scroll',
    description: 'Scroll at the current mouse position. direction: up, down, left, right. amount: number of scroll clicks.',
    inputSchema: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'number' } },
      required: ['direction'],
    },
    handler: async ({ direction, amount = 3 }) => {
      const btn = { up: '4', down: '5', left: '6', right: '7' }[direction];
      await run('xdotool', ['click', '--repeat', String(amount), btn]);
      return { content: [{ type: 'text', text: `Scrolled ${direction} x${amount}` }] };
    },
  },
  {
    name: 'type_text',
    description: 'Type a string of text at the current cursor/focus position (e.g. into a focused text field).',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: async ({ text }) => {
      await run('xdotool', ['type', '--delay', '30', '--', text]);
      return { content: [{ type: 'text', text: `Typed ${text.length} chars` }] };
    },
  },
  {
    name: 'key_press',
    description: 'Press a key or key combo, e.g. "Return", "ctrl+c", "alt+Tab", "Escape".',
    inputSchema: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'] },
    handler: async ({ keys }) => {
      await run('xdotool', ['key', normalizeKey(keys)]);
      return { content: [{ type: 'text', text: `Pressed ${keys}` }] };
    },
  },
  {
    name: 'launch_app',
    description: 'Launch a GUI application or shell command on the desktop (runs detached, does not wait for it to exit). E.g. "chromium-browser https://example.com", "xfce4-terminal".',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    handler: async ({ command }) => {
      const { spawn } = require('child_process');
      const child = spawn('/bin/sh', ['-c', command], { env: ENV, detached: true, stdio: 'ignore' });
      child.unref();
      return { content: [{ type: 'text', text: `Launched: ${command}` }] };
    },
  },
  {
    name: 'restart_agent_app',
    description: 'Schedule a graceful restart of the agent-app backend (needed after editing server.js or its env vars). Unlike running "systemctl restart agent-app" directly, this does NOT restart immediately — it only sets a flag, and the actual restart happens once the current turn\'s response has fully finished sending, so nothing gets cut off mid-reply. Call this any time in the turn where you want the restart to happen; there\'s no need to make it your last action.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      if (!INTERNAL_SHARED_SECRET) {
        return { content: [{ type: 'text', text: 'Graceful restart is not configured (missing INTERNAL_SHARED_SECRET).' }], isError: true };
      }
      const res = await fetch(`${AGENT_APP_URL}/internal/restart/request`, {
        method: 'POST',
        headers: { 'X-Internal-Secret': INTERNAL_SHARED_SECRET },
      });
      if (!res.ok) {
        return { content: [{ type: 'text', text: `Failed to schedule restart (${res.status}).` }], isError: true };
      }
      const data = await res.json();
      return { content: [{ type: 'text', text: data.message || 'Restart scheduled.' }] };
    },
  },
  {
    name: 'list_windows',
    description: 'List open windows on the desktop with their titles and ids.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const out = await run('bash', ['-c', 'xdotool search --name "" getwindowname %@ 2>/dev/null | paste -sd"\\n" - || true']);
      const ids = await run('xdotool', ['search', '--name', '']).catch(() => '');
      return { content: [{ type: 'text', text: out || ids || '(no windows found)' }] };
    },
  },
  {
    name: 'request_secure_input',
    description: 'Ask the user for a sensitive value (password, OTP, API key, etc.) through a secure modal in their chat app, instead of asking them to type it in plain chat. The value never appears in chat text, the conversation transcript, or any log — it is typed directly into whatever GUI element currently has focus on the virtual desktop. Make sure the target field (e.g. a password box) is already focused before calling this. This returns quickly — it does NOT wait minutes for the user. If they haven\'t submitted yet within a few seconds, it returns a pending id; call check_secure_input with that id once the user says they\'ve submitted it (or after a short wait).',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string', description: 'Short description shown to the user, e.g. "Google account password"' } },
      required: ['prompt'],
    },
    handler: async ({ prompt }) => {
      if (!INTERNAL_SHARED_SECRET) {
        return { content: [{ type: 'text', text: 'Secure input is not configured (missing INTERNAL_SHARED_SECRET).' }], isError: true };
      }
      const createRes = await fetch(`${AGENT_APP_URL}/internal/secure-input/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SHARED_SECRET },
        body: JSON.stringify({ prompt }),
      });
      if (!createRes.ok) {
        return { content: [{ type: 'text', text: `Failed to request secure input (${createRes.status}).` }], isError: true };
      }
      const { id } = await createRes.json();
      const result = await pollBriefly(id);
      if (result.status === 'entered') {
        return { content: [{ type: 'text', text: 'Value entered into the focused field.' }] };
      }
      if (result.status === 'cancelled') {
        return { content: [{ type: 'text', text: 'The user cancelled the request (or it expired).' }], isError: true };
      }
      return { content: [{ type: 'text', text: `Still waiting on the user (request id: ${id}). Ask them to submit it, then call check_secure_input with id="${id}".` }] };
    },
  },
  {
    name: 'check_secure_input',
    description: 'Check whether the user has submitted a value for a pending request_secure_input call (by its id), and type it into the currently-focused field if so. Returns quickly — call this again (after another short wait) if it reports still pending.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The pending request id returned by request_secure_input' } },
      required: ['id'],
    },
    handler: async ({ id }) => {
      if (!INTERNAL_SHARED_SECRET) {
        return { content: [{ type: 'text', text: 'Secure input is not configured (missing INTERNAL_SHARED_SECRET).' }], isError: true };
      }
      const result = await pollBriefly(id);
      if (result.status === 'entered') {
        return { content: [{ type: 'text', text: 'Value entered into the focused field.' }] };
      }
      if (result.status === 'cancelled') {
        return { content: [{ type: 'text', text: 'The user cancelled the request (or it expired).' }], isError: true };
      }
      return { content: [{ type: 'text', text: `Still pending (request id: ${id}). Try again shortly.` }] };
    },
  },
  {
    name: 'activate_window',
    description: 'Bring a window to the front and give it focus by matching part of its title.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    handler: async ({ title }) => {
      const id = (await run('xdotool', ['search', '--name', title])).trim().split('\n')[0];
      if (!id) return { content: [{ type: 'text', text: `No window matching "${title}"` }] };
      await run('xdotool', ['windowactivate', id]);
      return { content: [{ type: 'text', text: `Activated window ${id}` }] };
    },
  },
];

const server = new Server({ name: 'gui-control', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find(t => t.name === req.params.name);
  if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
  try {
    return await tool.handler(req.params.arguments || {});
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
server.connect(transport);
