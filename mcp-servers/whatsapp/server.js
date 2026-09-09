#!/usr/bin/env node
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const BRIDGE_URL = process.env.WHATSAPP_BRIDGE_URL || 'http://127.0.0.1:4010';
const INTERNAL_SHARED_SECRET = process.env.INTERNAL_SHARED_SECRET;

async function bridgeFetch(pathAndQuery, options = {}) {
  const res = await fetch(`${BRIDGE_URL}${pathAndQuery}`, {
    ...options,
    headers: { 'X-Internal-Secret': INTERNAL_SHARED_SECRET, ...(options.headers || {}) },
  });
  let body;
  try { body = await res.json(); } catch { body = null; }
  return { ok: res.ok, status: res.status, body };
}

const tools = [
  {
    name: 'whatsapp_status',
    description: 'Check whether the WhatsApp bridge is linked and ready to send messages. Call this first if unsure, or if a send fails saying WhatsApp is not ready. If the state is "qr", tell the user to open the Live Desktop panel in this app and scan the QR code shown there with their phone (WhatsApp app → Linked Devices → Link a Device) — it only needs to be done once.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const { ok, body } = await bridgeFetch('/status');
      if (!ok || !body) return { content: [{ type: 'text', text: 'Could not reach the WhatsApp bridge service.' }], isError: true };
      if (body.state === 'qr') {
        return { content: [{ type: 'text', text: 'WhatsApp is not linked yet. Ask the user to open the Live Desktop panel (top of the chat) and scan the QR code shown there with their phone: WhatsApp app → Settings → Linked Devices → Link a Device.' }] };
      }
      return { content: [{ type: 'text', text: `WhatsApp bridge state: ${body.state}` }] };
    },
  },
  {
    name: 'search_whatsapp_contacts',
    description: 'Search the linked WhatsApp account\'s contacts by (partial) name. Use this to disambiguate before sending if you\'re not sure of the exact contact name or number, or after send_whatsapp_message reports multiple/no matches.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Name (or part of it) to search for.' } },
      required: ['query'],
    },
    handler: async ({ query }) => {
      const { ok, status, body } = await bridgeFetch(`/contacts?search=${encodeURIComponent(query)}`);
      if (!ok) return { content: [{ type: 'text', text: body?.error || `Bridge error (${status})` }], isError: true };
      if (!body.matches.length) return { content: [{ type: 'text', text: `No contacts matching "${query}".` }] };
      const lines = body.matches.map((m) => `- ${m.name} (${m.number})`).join('\n');
      return { content: [{ type: 'text', text: lines }] };
    },
  },
  {
    name: 'send_whatsapp_message',
    description: 'Send a WhatsApp text message and/or a file (e.g. a video downloaded via download_video, an image, a document) to a contact. `to` can be a saved contact name (exact or partial — if it matches more than one contact you\'ll get a list back to disambiguate with the user) or a phone number with country code (digits, spaces, +, - and () are all fine, e.g. "+1 415 555 0100"). `filePath` must be a file already on this machine, inside ~/uploads or ~/Downloads (e.g. the downloadUrl a prior tool returned, translated to its real filesystem path). Videos from download_video are sent as normal inline-playable media. If a send ever fails with something like "unusual format" or a corrupted-file complaint, the file is very likely an AV1-codec video (WhatsApp only supports H.264) — re-download it and check.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Contact name or phone number (with country code) to send to.' },
        text: { type: 'string', description: 'Text message to send. If filePath is also given, this is used as the media caption instead.' },
        filePath: { type: 'string', description: 'Absolute path to a file inside ~/uploads or ~/Downloads to send as media.' },
      },
      required: ['to'],
    },
    handler: async ({ to, text, filePath }) => {
      if (!text && !filePath) {
        return { content: [{ type: 'text', text: 'Provide "text" and/or "filePath".' }], isError: true };
      }
      const { ok, status, body } = await bridgeFetch('/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, text, filePath }),
      });
      if (!ok) {
        if (status === 300 && body?.candidates) {
          const lines = body.candidates.map((c) => `- ${c.name} (${c.number})`).join('\n');
          return { content: [{ type: 'text', text: `${body.error}\n${lines}\nAsk the user which one they meant, then retry with the exact name or number.` }], isError: true };
        }
        return { content: [{ type: 'text', text: body?.error || `Send failed (${status})` }], isError: true };
      }
      return { content: [{ type: 'text', text: `Sent to ${to}.` }] };
    },
  },
];

const server = new Server({ name: 'whatsapp', version: '1.0.0' }, { capabilities: { tools: {} } });

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
