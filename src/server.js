// LifeOS server: hosts the MCP endpoint (/mcp) and the simulated Alexa+ web experience (/).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { handleMcp, traffic, sessionCount, LATEST_PROTOCOL_VERSION } from './mcp.js';
import { respond, discover, plannerName, plannerLabel, runTool } from './agent.js';
import { load, reset } from './store.js';
import { streak } from './tools.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1'; // spec: bind to localhost when running locally
const PUBLIC_DIR = resolve('public');
const SELF_URL = `http://127.0.0.1:${PORT}`;
const MAX_BODY = 1024 * 1024;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

function readBody(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function serveStatic(res, pathname) {
  const file = normalize(join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'Not found' });
  }
}

function dashboardState() {
  const db = load();
  return {
    profile: db.profile,
    tasks: db.tasks,
    habits: db.habits.map((h) => ({ id: h.id, name: h.name, streak: streak(h.log), log: h.log })),
    goals: db.goals,
    moods: db.moods.slice(-7),
    journal: db.journal.slice(-5).reverse(),
  };
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (pathname === '/mcp') return await handleMcp(req, res, req.method === 'POST' ? await readBody(req) : '');

    if (pathname === '/healthz') return json(res, 200, { ok: true, protocolVersion: LATEST_PROTOCOL_VERSION, sessions: sessionCount() });

    if (pathname === '/api/ask' && req.method === 'POST') {
      const { text, history } = JSON.parse((await readBody(req)) || '{}');
      if (!text?.trim()) return json(res, 400, { error: 'Say something first' });
      return json(res, 200, await respond(SELF_URL, text, Array.isArray(history) ? history : []));
    }
    if (pathname === '/api/tool' && req.method === 'POST') {
      const { name, args } = JSON.parse((await readBody(req)) || '{}');
      if (!name) return json(res, 400, { error: 'Missing tool name' });
      return json(res, 200, await runTool(SELF_URL, name, args));
    }
    if (pathname === '/api/discover') return json(res, 200, { ...(await discover(SELF_URL)), planner: plannerName(), plannerLabel: plannerLabel() });
    if (pathname === '/api/state') return json(res, 200, dashboardState());
    if (pathname === '/api/reset' && req.method === 'POST') {
      reset();
      return json(res, 200, { ok: true });
    }

    // Live feed of every MCP message the server sees — from the simulator, Inspector or Alexa+ itself.
    if (pathname === '/api/traffic') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      const onMsg = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      traffic.on('message', onMsg);
      req.on('close', () => {
        clearInterval(ping);
        traffic.off('message', onMsg);
      });
      return;
    }

    if (req.method === 'GET') return await serveStatic(res, pathname);
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, err.status || 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  LifeOS for Alexa+`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  MCP endpoint     http://${HOST}:${PORT}/mcp   (Streamable HTTP, spec ${LATEST_PROTOCOL_VERSION})`);
  console.log(`  Alexa+ simulator http://localhost:${PORT}/`);
  console.log(`  Planner          ${plannerLabel()}${plannerName() === 'rules' ? '  (set ANTHROPIC_API_KEY, or ALEXA_SIM_PLANNER=bedrock, to let a model pick tools)' : ''}`);
  console.log(`  Auth             ${process.env.LIFEOS_API_KEY ? 'Bearer token required' : 'open (set LIFEOS_API_KEY to require a bearer token)'}\n`);
});
