// End-to-end check of the LifeOS MCP server against the Streamable HTTP rules in spec 2025-11-25.
// Starts its own server on a spare port with a throwaway data file, so it never touches your data.
//   npm test
//   MCP_URL=https://your-tunnel.example/mcp npm test   # test a deployed server instead
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const external = process.env.MCP_URL;
const port = 3900 + Math.floor(Math.random() * 90);
const base = external ? new URL(external).origin : `http://127.0.0.1:${port}`;
const url = external || `${base}/mcp`;
const tmp = mkdtempSync(join(tmpdir(), 'lifeos-'));
let child;

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${!ok && detail ? `\n      ${detail}` : ''}`);
};

const H = (extra = {}) => ({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...extra });
const post = (body, headers) => fetch(url, { method: 'POST', headers: H(headers), body: typeof body === 'string' ? body : JSON.stringify(body) });

async function startServer() {
  if (external) return;
  child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(port), LIFEOS_DATA_FILE: join(tmp, 'db.json'), ANTHROPIC_API_KEY: '', LIFEOS_API_KEY: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function main() {
  await startServer();
  console.log(`\nLifeOS MCP smoke test → ${url}\n`);

  // --- lifecycle ---
  let res = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } });
  const init = await res.json();
  const sid = res.headers.get('mcp-session-id');
  check('initialize → 200', res.status === 200);
  check('negotiates protocol 2025-11-25', init.result?.protocolVersion === '2025-11-25', JSON.stringify(init));
  check('issues MCP-Session-Id', !!sid);
  check('advertises tools/resources/prompts', !!(init.result?.capabilities?.tools && init.result.capabilities.resources && init.result.capabilities.prompts));
  check('serverInfo has title + icons', !!(init.result?.serverInfo?.title && init.result.serverInfo.icons?.length));

  const S = { 'MCP-Session-Id': sid, 'MCP-Protocol-Version': '2025-11-25' };
  res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, S);
  check('notification → 202 Accepted, empty body', res.status === 202 && (await res.text()) === '');

  res = await post({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'old', version: '1' } } });
  check('unknown requested version → server offers latest', (await res.json()).result?.protocolVersion === '2025-11-25');

  // --- transport rules ---
  res = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  check('missing session id → 400', res.status === 400);
  res = await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, { 'MCP-Session-Id': 'nope' });
  check('unknown session id → 404', res.status === 404);
  res = await post({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, { ...S, 'MCP-Protocol-Version': '2030-01-01' });
  check('unsupported MCP-Protocol-Version → 400', res.status === 400);
  res = await post([{ jsonrpc: '2.0', id: 6, method: 'ping' }], S);
  check('JSON-RPC batch → rejected', res.status === 400);
  res = await post('{not json', S);
  check('malformed JSON → -32700', (await res.json()).error?.code === -32700);
  res = await post({ jsonrpc: '2.0', id: 7, method: 'ping' }, { ...S, Origin: 'https://evil.example' });
  check('foreign Origin → 403', res.status === 403);
  res = await fetch(url, { method: 'GET', headers: { Accept: 'text/event-stream', ...S } });
  check('GET without SSE support → 405', res.status === 405);
  res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...S }, body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping' }) });
  check('SSE-only Accept → text/event-stream response', (res.headers.get('content-type') || '').includes('text/event-stream') && (await res.text()).includes('"result"'));

  // --- tools ---
  const call = async (name, args, id) => (await (await post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, S)).json());
  const list = await (await post({ jsonrpc: '2.0', id: 10, method: 'tools/list' }, S)).json();
  const tools = list.result?.tools || [];
  check(`tools/list returns ${tools.length} tools`, tools.length >= 10);
  check('every tool has inputSchema, outputSchema, annotations', tools.every((t) => t.inputSchema?.type === 'object' && t.outputSchema && t.annotations));
  check('delete_task is marked destructive', tools.find((t) => t.name === 'delete_task')?.annotations?.destructiveHint === true);

  let r = await call('get_daily_briefing', {}, 11);
  check('get_daily_briefing → speech + structuredContent', !!r.result?.content?.[0]?.text && !!r.result?.structuredContent?.speech);
  r = await call('add_task', { title: 'Smoke test task', due: 'tomorrow', priority: 'high' }, 12);
  check('add_task works', r.result?.structuredContent?.task?.priority === 'high' && /tomorrow/.test(r.result.content[0].text), JSON.stringify(r));
  r = await call('complete_task', { task: 'smoke test' }, 13);
  check('complete_task fuzzy-matches by title', r.result?.structuredContent?.task?.status === 'done', JSON.stringify(r));
  r = await call('log_habit', { habit: 'meditate' }, 14);
  check('log_habit returns streak', typeof r.result?.structuredContent?.streak === 'number' && r.result.structuredContent.streak >= 1);
  r = await call('log_mood', { score: 5, note: 'tests pass' }, 15);
  check('log_mood works', r.result?.structuredContent?.score === 5);
  r = await call('add_task', {}, 16);
  check('missing required arg → isError tool result (not protocol error)', r.result?.isError === true);
  r = await call('nope_tool', {}, 17);
  check('unknown tool → JSON-RPC -32602', r.error?.code === -32602);

  // --- resources & prompts ---
  r = await (await post({ jsonrpc: '2.0', id: 20, method: 'resources/read', params: { uri: 'lifeos://today' } }, S)).json();
  check('resources/read lifeos://today', !!JSON.parse(r.result?.contents?.[0]?.text || 'null')?.date);
  r = await (await post({ jsonrpc: '2.0', id: 21, method: 'prompts/get', params: { name: 'plan_my_day' } }, S)).json();
  check('prompts/get plan_my_day', r.result?.messages?.length === 1);
  r = await (await post({ jsonrpc: '2.0', id: 22, method: 'does/not/exist' }, S)).json();
  check('unknown method → -32601', r.error?.code === -32601);

  // --- simulator (offline rules planner) ---
  if (!external) {
    const utterances = [
      ["Alexa, what's my day look like?", 'get_daily_briefing'],
      ['Remind me to call the bank tomorrow', 'add_task'],
      ['I finished my workout', 'log_habit'],
      ['Mark call mom as done', 'complete_task'],
      ["I'm feeling great, shipped the demo", 'log_mood'],
      ['Move the dentist to Friday', 'reschedule_task'],
      ['Bump my 10K goal by 10 percent', 'update_goal_progress'],
      ['How was my week?', 'weekly_review'],
      ['Journal: the Alexa demo finally clicked today', 'add_journal_entry'],
      ['What tasks are overdue?', 'list_tasks'],
      ['Show my habits', 'get_habits'],
    ];
    for (const [text, tool] of utterances) {
      const a = await (await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })).json();
      check(`"${text}" → ${tool}`, a.calls?.[0]?.name === tool && !!a.speech, `got ${a.calls?.[0]?.name}: ${a.speech}`);
    }
  }

  // --- termination ---
  res = await fetch(url, { method: 'DELETE', headers: S });
  check('DELETE ends session → 200', res.status === 200);
  res = await post({ jsonrpc: '2.0', id: 30, method: 'ping' }, S);
  check('request on ended session → 404', res.status === 404);

  console.log(`\n${passed} passed, ${failed} failed\n`);
}

main()
  .catch((e) => {
    console.error(e);
    failed++;
  })
  .finally(() => {
    child?.kill();
    rmSync(tmp, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
  });
