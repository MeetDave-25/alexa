// Model Context Protocol server — Streamable HTTP transport, spec revision 2025-11-25.
// https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
//
// Dependency-free on purpose: every protocol rule this server follows is in this file.
//   • One endpoint (/mcp). POST carries exactly one JSON-RPC message (no batching since 2025-06-18).
//   • Requests get a JSON response (or a single-event SSE stream if the client only accepts SSE).
//   • Notifications and responses get 202 Accepted with no body.
//   • initialize issues an MCP-Session-Id; later requests must echo it (400 if missing, 404 if unknown).
//   • Later requests carry MCP-Protocol-Version; unsupported values get 400.
//   • Origin is validated to block DNS-rebinding (403).
//   • GET returns 405 (this server does not open server-initiated SSE streams); DELETE ends a session.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tools, toolMap, resources, readResource, prompts, getPrompt } from './tools.js';

export const LATEST_PROTOCOL_VERSION = '2025-11-25';
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

const SERVER_INFO = {
  name: 'lifeos-mcp',
  title: 'LifeOS',
  version: '1.0.0',
  description: 'Your personal life operating system: tasks, habits, goals, mood and journal — by voice.',
  websiteUrl: 'https://github.com/MeetDave-25/alexa',
  icons: [{ src: '/icon.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
};

const INSTRUCTIONS =
  'LifeOS is the user\'s personal organizer. Every tool returns a "speech" field written to be read aloud ' +
  'as-is; prefer it over composing your own summary. Use get_daily_briefing for open-ended "how is my day" ' +
  'questions. Tasks, habits and goals can be referenced by a few words of their name.';

const sessions = new Map(); // id -> { protocolVersion, clientInfo, createdAt, lastSeen }
const SESSION_TTL_MS = 1000 * 60 * 60 * 6;

// Every inbound/outbound message is published here so the web simulator can show live MCP traffic.
export const traffic = new EventEmitter();
traffic.setMaxListeners(100);

export const sessionCount = () => sessions.size;

const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

function allowedOrigin(origin, host) {
  if (!origin) return true; // non-browser clients (Alexa+, Inspector CLI, curl) don't send Origin
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allow.includes('*') || allow.includes(origin)) return true;
  try {
    const u = new URL(origin);
    return u.host === host || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function sweepSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastSeen > SESSION_TTL_MS) sessions.delete(id);
}

// Minimal JSON-Schema check for required fields and primitive types; enough to give the model
// a useful, recoverable error instead of a crash.
function validateArgs(schema, args) {
  const errors = [];
  for (const key of schema.required || []) if (args[key] === undefined || args[key] === '') errors.push(`"${key}" is required`);
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties?.[key];
    if (!prop) {
      if (schema.additionalProperties === false) errors.push(`unknown argument "${key}"`);
      continue;
    }
    const type = Array.isArray(value) ? 'array' : typeof value;
    const want = [].concat(prop.type || []);
    if (want.length && !want.some((w) => w === type || (w === 'integer' && Number.isInteger(value)) || (w === 'number' && type === 'number') || (w === 'null' && value === null)))
      errors.push(`"${key}" should be ${want.join(' or ')}`);
    if (prop.enum && !prop.enum.includes(value)) errors.push(`"${key}" must be one of ${prop.enum.join(', ')}`);
  }
  return errors;
}

async function dispatch(msg, session) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
      return {
        result: {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false },
            logging: {},
          },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
        protocolVersion,
      };
    }
    case 'ping':
      return { result: {} };
    case 'tools/list':
      return {
        result: {
          tools: tools.map(({ handler, ...def }) => def),
        },
      };
    case 'tools/call': {
      const tool = toolMap.get(params.name);
      if (!tool) return { error: [-32602, `Unknown tool: ${params.name}`] };
      const args = params.arguments || {};
      const problems = validateArgs(tool.inputSchema, args);
      if (problems.length) {
        // Input validation failures are tool execution errors, so the model can self-correct.
        return { result: { content: [{ type: 'text', text: `Invalid arguments: ${problems.join('; ')}` }], isError: true } };
      }
      try {
        const { speech, data = {}, isError = false } = await tool.handler(args);
        return {
          result: {
            content: [{ type: 'text', text: speech }],
            structuredContent: { speech, ...data },
            isError,
          },
        };
      } catch (err) {
        return { result: { content: [{ type: 'text', text: `LifeOS hit an error: ${err.message}` }], isError: true } };
      }
    }
    case 'resources/list':
      return { result: { resources } };
    case 'resources/templates/list':
      return { result: { resourceTemplates: [] } };
    case 'resources/read': {
      const text = readResource(params.uri);
      if (text === null) return { error: [-32002, 'Resource not found', { uri: params.uri }] };
      return { result: { contents: [{ uri: params.uri, mimeType: 'application/json', text }] } };
    }
    case 'prompts/list':
      return { result: { prompts } };
    case 'prompts/get': {
      const prompt = getPrompt(params.name, params.arguments);
      if (!prompt) return { error: [-32602, `Unknown prompt: ${params.name}`] };
      return { result: prompt };
    }
    case 'logging/setLevel':
      if (session) session.logLevel = params.level;
      return { result: {} };
    default:
      return { error: [-32601, `Method not found: ${method}`] };
  }
}

export async function handleMcp(req, res, rawBody) {
  sweepSessions();
  const sessionId = req.headers['mcp-session-id'];

  if (!allowedOrigin(req.headers.origin, req.headers.host)) {
    return send(res, 403, rpcError(null, -32000, 'Forbidden: Origin not allowed'));
  }

  const apiKey = process.env.LIFEOS_API_KEY;
  if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) {
    return send(res, 401, rpcError(null, -32001, 'Unauthorized'), { 'WWW-Authenticate': 'Bearer realm="lifeos"' });
  }

  if (req.method === 'GET') {
    return send(res, 405, rpcError(null, -32000, 'This server does not offer a server-initiated SSE stream'), { Allow: 'POST, DELETE' });
  }

  if (req.method === 'DELETE') {
    if (!sessionId) return send(res, 400, rpcError(null, -32000, 'Missing MCP-Session-Id'));
    if (!sessions.delete(sessionId)) return send(res, 404, rpcError(null, -32001, 'Session not found'));
    traffic.emit('message', { dir: 'in', sessionId, ts: Date.now(), message: { note: 'DELETE — session terminated' } });
    res.writeHead(200);
    return res.end();
  }

  if (req.method !== 'POST') return send(res, 405, rpcError(null, -32000, 'Method not allowed'), { Allow: 'POST, DELETE' });

  let msg;
  try {
    msg = JSON.parse(rawBody);
  } catch {
    return send(res, 400, rpcError(null, -32700, 'Parse error'));
  }
  if (Array.isArray(msg)) return send(res, 400, rpcError(null, -32600, 'JSON-RPC batching is not supported in this protocol version'));
  if (!msg || msg.jsonrpc !== '2.0') return send(res, 400, rpcError(msg?.id, -32600, 'Invalid Request'));

  const isInitialize = msg.method === 'initialize';
  let session = null;

  if (!isInitialize) {
    if (!sessionId) return send(res, 400, rpcError(msg.id, -32000, 'Bad Request: missing MCP-Session-Id header'));
    session = sessions.get(sessionId);
    if (!session) return send(res, 404, rpcError(msg.id, -32001, 'Session not found — re-initialize'));
    session.lastSeen = Date.now();
    const pv = req.headers['mcp-protocol-version'];
    if (pv && !SUPPORTED_PROTOCOL_VERSIONS.includes(pv)) {
      return send(res, 400, rpcError(msg.id, -32000, `Unsupported MCP-Protocol-Version: ${pv}`, { supported: SUPPORTED_PROTOCOL_VERSIONS }));
    }
  }

  traffic.emit('message', { dir: 'in', sessionId: sessionId || null, ts: Date.now(), message: msg });

  // Notifications (no id) and client responses (result/error, no method) → 202, no body.
  if (msg.method === undefined || msg.id === undefined) {
    res.writeHead(202);
    return res.end();
  }

  const out = await dispatch(msg, session);
  const reply = out.error ? rpcError(msg.id, ...out.error) : rpcResult(msg.id, out.result);
  const headers = {};

  if (isInitialize && out.result) {
    const newId = randomUUID();
    sessions.set(newId, { protocolVersion: out.protocolVersion, clientInfo: msg.params?.clientInfo, createdAt: Date.now(), lastSeen: Date.now() });
    headers['MCP-Session-Id'] = newId;
  }

  traffic.emit('message', { dir: 'out', sessionId: headers['MCP-Session-Id'] || sessionId, ts: Date.now(), message: reply });

  // Clients must accept both; we answer with plain JSON unless the client asked for SSE only.
  const accept = req.headers.accept || '';
  if (accept.includes('text/event-stream') && !accept.includes('application/json')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...headers });
    res.write(`id: ${randomUUID()}\nevent: message\ndata: ${JSON.stringify(reply)}\n\n`);
    return res.end();
  }
  return send(res, 200, reply, headers);
}
