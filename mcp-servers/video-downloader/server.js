#!/usr/bin/env node
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Same directory the agent-app server exposes at GET /api/files/download/:name,
// so anything saved here immediately shows up in the app's Files panel and is
// downloadable (from any logged-in device, including a phone) with no extra wiring.
const FILES_DIR = path.join(os.homedir(), 'uploads');
fs.mkdirSync(FILES_DIR, { recursive: true });

const YTDLP_BIN = 'yt-dlp';
const TIMEOUT_MS = 20 * 60 * 1000;
const MAX_FILESIZE = '4G';

function formatSelectorFor(quality) {
  const q = (quality || 'best').trim().toLowerCase();
  if (q === 'audio' || q === 'mp3') {
    return { formatArgs: ['-x', '--audio-format', 'mp3', '-f', 'bestaudio/best'] };
  }
  const m = q.match(/^(\d{3,4})p?$/);
  const heightFilter = m ? `[height<=${m[1]}]` : '';
  return {
    formatArgs: [
      '-f', `bestvideo${heightFilter}+bestaudio/best${heightFilter}`,
      // Prefer H.264 video + AAC audio over YouTube's default best (often AV1/Opus) —
      // WhatsApp and most messaging apps reject AV1 outright and can mishandle Opus-in-mp4,
      // even though it plays fine in a browser.
      '-S', 'vcodec:h264,acodec:aac',
      '--merge-output-format', 'mp4',
    ],
  };
}

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

const tools = [
  {
    name: 'download_video',
    description: 'Download a video (or audio) from YouTube or any other yt-dlp-supported site into the app\'s shared file store, so the user can grab it from the Files panel or a download link/button in chat — including on their phone. Use this whenever the user says something like "download this video" and gives (or already shared) a URL. After it succeeds, reply with a Markdown link in the exact form [Download video](<downloadUrl>) using the downloadUrl returned by this tool (keep the link text generic — the real filename can contain [ ] characters that would break Markdown link syntax) — the app renders links to /api/files/download/ as a tappable download button, so the user can save it straight to their phone.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The video page URL (e.g. a YouTube link).' },
        quality: {
          type: 'string',
          description: 'Desired quality: "best" (default, highest available video+audio merged to mp4), a height like "1080p"/"720p"/"480p" to cap resolution, or "audio" to extract mp3 audio only.',
        },
      },
      required: ['url'],
    },
    handler: async ({ url, quality }) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return { content: [{ type: 'text', text: `Invalid URL: ${url}` }], isError: true };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { content: [{ type: 'text', text: `Unsupported protocol: ${parsed.protocol}` }], isError: true };
      }

      const { formatArgs } = formatSelectorFor(quality);
      const outTemplate = path.join(FILES_DIR, '%(title).150B [%(id)s].%(ext)s');
      const args = [
        '-q', '--no-warnings',
        '--no-playlist',
        '--max-filesize', MAX_FILESIZE,
        // Sites like YouTube bot-gate plain datacenter requests; riding on the desktop
        // Chrome profile's cookies (and a JS runtime for signature challenges) gets past it.
        '--cookies-from-browser', 'chrome',
        '--js-runtimes', 'node',
        // Without this, yt-dlp silently skips downloading (and reports the stale file) if a
        // same-named file already exists — e.g. a repeat request, or one made before a format
        // preference change like the H.264 fix below.
        '--force-overwrites',
        '-o', outTemplate,
        ...formatArgs,
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
      if (!resolved || !resolved.startsWith(FILES_DIR + path.sep) || !fs.existsSync(resolved)) {
        return { content: [{ type: 'text', text: `Download finished but the output file could not be located (yt-dlp output: ${stdout.trim()})` }], isError: true };
      }

      const stat = fs.statSync(resolved);
      const name = path.basename(resolved);
      const downloadUrl = `/api/files/download/${encodeURIComponent(name)}`;

      return {
        content: [{
          type: 'text',
          text: `Downloaded "${name}" (${formatBytes(stat.size)}). downloadUrl: ${downloadUrl}\n`
            + `Reply with exactly this Markdown link (the filename may contain [ ] characters, so keep the link text generic — do not put the filename inside the brackets): [Download video](${downloadUrl})\n`
            + `You can mention the title and size in plain text next to it.`,
        }],
      };
    },
  },
];

const server = new Server({ name: 'video-downloader', version: '1.0.0' }, { capabilities: { tools: {} } });

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
