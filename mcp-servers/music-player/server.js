#!/usr/bin/env node
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Same directory the agent-app server exposes via /api/music, so anything saved here
// immediately shows up in the app's Music panel.
const MUSIC_DIR = path.join(os.homedir(), 'music');
fs.mkdirSync(MUSIC_DIR, { recursive: true });

const AGENT_APP_URL = process.env.AGENT_APP_INTERNAL_URL || 'http://127.0.0.1:3000';
const INTERNAL_SHARED_SECRET = process.env.INTERNAL_SHARED_SECRET;

const YTDLP_BIN = 'yt-dlp';
const TIMEOUT_MS = 10 * 60 * 1000;

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);
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

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}

function listTracks() {
  return fs.readdirSync(MUSIC_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.mp3'))
    .map((e) => {
      const stat = fs.statSync(path.join(MUSIC_DIR, e.name));
      return { name: e.name, size: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

const tools = [
  {
    name: 'list_music',
    description: 'List the tracks already downloaded in the user\'s music library, so you can offer to play one without re-downloading, or check whether a song is already there.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const tracks = listTracks();
      if (!tracks.length) return { content: [{ type: 'text', text: 'The music library is empty.' }] };
      const lines = tracks.map((t) => `- ${t.name} (${formatBytes(t.size)})`).join('\n');
      return { content: [{ type: 'text', text: `Tracks in the music library:\n${lines}` }] };
    },
  },
  {
    name: 'download_music',
    description: 'Download the audio track from a YouTube (or other yt-dlp-supported) video link as an mp3 and add it to the user\'s music library. Use this when the user pastes a link and wants it as a song, not a video. Returns the saved track name — pass that to play_music to start playback.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The video page URL (e.g. a YouTube link).' },
      },
      required: ['url'],
    },
    handler: async ({ url }) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return { content: [{ type: 'text', text: `Invalid URL: ${url}` }], isError: true };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { content: [{ type: 'text', text: `Unsupported protocol: ${parsed.protocol}` }], isError: true };
      }

      const outTemplate = path.join(MUSIC_DIR, '%(title).150B.%(ext)s');
      const args = [
        '-q', '--no-warnings',
        '--no-playlist',
        '-x', '--audio-format', 'mp3',
        '-f', 'bestaudio/best',
        // Sites like YouTube bot-gate plain datacenter requests; riding on the desktop
        // Chrome profile's cookies (and a JS runtime for signature challenges) gets past it.
        '--cookies-from-browser', 'chrome',
        '--js-runtimes', 'node',
        '--force-overwrites',
        '-o', outTemplate,
        '--print', 'after_move:filepath',
        parsed.toString(),
      ];

      let stdout;
      try {
        stdout = await runYtDlp(args);
      } catch (err) {
        return { content: [{ type: 'text', text: `Download failed: ${err.message}` }], isError: true };
      }

      const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
      const filePath = lines[lines.length - 1];
      const resolved = filePath && path.resolve(filePath);
      if (!resolved || !resolved.startsWith(MUSIC_DIR + path.sep) || !fs.existsSync(resolved)) {
        return { content: [{ type: 'text', text: `Download finished but the output file could not be located (yt-dlp output: ${stdout.trim()})` }], isError: true };
      }

      const stat = fs.statSync(resolved);
      const name = path.basename(resolved);
      return {
        content: [{
          type: 'text',
          text: `Downloaded "${name}" (${formatBytes(stat.size)}) into the music library. Call play_music with name="${name}" to start playing it, or mention it's available in the Music panel.`,
        }],
      };
    },
  },
  {
    name: 'play_music',
    description: 'Start playing a track (by exact name from list_music or download_music) in the music player in the user\'s currently open browser tab. Use this when the user says "play <song>" or wants a just-downloaded track to start playing now. Only works while the user has the app open — if it fails, tell them to open the app and try again.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact track filename, as returned by list_music or download_music.' },
      },
      required: ['name'],
    },
    handler: async ({ name }) => {
      if (!INTERNAL_SHARED_SECRET) {
        return { content: [{ type: 'text', text: 'Playback control is not configured (missing INTERNAL_SHARED_SECRET).' }], isError: true };
      }
      const base = path.basename(String(name || ''));
      if (!fs.existsSync(path.join(MUSIC_DIR, base))) {
        return { content: [{ type: 'text', text: `No track named "${base}" in the music library. Use list_music to see what's available.` }], isError: true };
      }
      try {
        const res = await fetch(`${AGENT_APP_URL}/internal/music/play`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SHARED_SECRET },
          body: JSON.stringify({ name: base }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          return { content: [{ type: 'text', text: `Could not start playback: ${data.error || res.status}` }], isError: true };
        }
      } catch (err) {
        return { content: [{ type: 'text', text: `Could not reach the app: ${err.message}` }], isError: true };
      }
      return { content: [{ type: 'text', text: `Now playing "${base}" in the user's browser.` }] };
    },
  },
];

const server = new Server({ name: 'music-player', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
  try {
    return await tool.handler(req.params.arguments || {});
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
server.connect(transport);
