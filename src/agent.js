// Simulated Alexa+ agent. It plays the role Alexa+ plays in production: it discovers LifeOS tools
// over MCP, decides which to call for an utterance, calls them over Streamable HTTP, and speaks
// the result.
//
// Two planners:
//   • claude — when ANTHROPIC_API_KEY is set, Claude picks tools from the live tools/list.
//   • rules  — an offline intent router, so the demo runs with no keys and no network.
import { McpClient } from './mcp-client.js';

const MODEL = process.env.ALEXA_SIM_MODEL || 'claude-opus-5-5';

const SYSTEM_PROMPT = `You are Alexa+, a voice assistant. The user has connected LifeOS, their personal life organizer, through MCP.
Answer in one to three short spoken sentences: no markdown, lists, emoji or URLs, because your reply is read aloud.
Use LifeOS tools for anything about the user's tasks, habits, goals, mood or journal. Each tool result has a "speech" field written for voice; you may say it as-is or merge several into one natural reply.
If a request is ambiguous, make a sensible assumption rather than asking, unless it would delete something.
Today is ${new Date().toDateString()}.`;

let client = null;
let mcpTools = null;

async function getClient(baseUrl) {
  if (client?.sessionId) return client;
  client = new McpClient(`${baseUrl}/mcp`, { token: process.env.LIFEOS_API_KEY });
  await client.connect();
  mcpTools = await client.listTools();
  return client;
}

async function withSession(baseUrl, fn) {
  try {
    return await fn(await getClient(baseUrl));
  } catch (err) {
    if (err.code !== 'SESSION_EXPIRED') throw err;
    client = null;
    return fn(await getClient(baseUrl));
  }
}

const resultSpeech = (r) => r?.structuredContent?.speech || r?.content?.find((c) => c.type === 'text')?.text || '';

// ---------- Claude planner ----------

let anthropic = null;
async function getAnthropic() {
  if (anthropic) return anthropic;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  anthropic = new Anthropic();
  return anthropic;
}

async function planWithClaude(mcp, utterance, history) {
  const claude = await getAnthropic();
  const tools = mcpTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const messages = [
    ...history.slice(-6).map((h) => ({ role: h.role, content: h.text })),
    { role: 'user', content: utterance },
  ];
  const calls = [];

  for (let turn = 0; turn < 6; turn++) {
    const response = await claude.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT + (mcp.instructions ? `\n\nLifeOS server instructions: ${mcp.instructions}` : ''),
      tools,
      messages,
      output_config: { effort: 'low' }, // voice: keep latency down
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });

    if (response.stop_reason === 'refusal') return { speech: "Sorry, I can't help with that one.", calls };
    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !toolUses.length) {
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
      return { speech: text || resultSpeech(calls.at(-1)?.result) || 'Done.', calls };
    }

    const results = [];
    for (const use of toolUses) {
      const result = await mcp.callTool(use.name, use.input);
      calls.push({ name: use.name, args: use.input, result });
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: JSON.stringify(result.structuredContent ?? result.content),
        is_error: !!result.isError,
      });
    }
    messages.push({ role: 'user', content: results });
  }
  return { speech: resultSpeech(calls.at(-1)?.result) || 'Done.', calls };
}

// ---------- Amazon Bedrock planner (Converse API) ----------
// Any Bedrock model that supports tool use works; the default is Amazon Nova Pro via the US
// cross-region inference profile. Credentials come from the standard AWS chain (aws configure, SSO, env).

const BEDROCK_MODEL = process.env.BEDROCK_MODEL_ID || 'us.amazon.nova-pro-v1:0';
let bedrock = null;

async function getBedrock() {
  if (bedrock) return bedrock;
  const sdk = await import('@aws-sdk/client-bedrock-runtime');
  bedrock = { sdk, client: new sdk.BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' }) };
  return bedrock;
}

// MCP tool definitions → Bedrock toolConfig. Exported for tests.
export function toBedrockTools(tools) {
  return { tools: tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema } } })) };
}

async function planWithBedrock(mcp, utterance, history) {
  const { sdk, client } = await getBedrock();
  const messages = [
    ...history.slice(-6).map((h) => ({ role: h.role, content: [{ text: h.text }] })),
    { role: 'user', content: [{ text: utterance }] },
  ];
  const calls = [];

  for (let turn = 0; turn < 6; turn++) {
    const response = await client.send(
      new sdk.ConverseCommand({
        modelId: BEDROCK_MODEL,
        system: [{ text: SYSTEM_PROMPT + (mcp.instructions ? `\n\nLifeOS server instructions: ${mcp.instructions}` : '') }],
        messages,
        toolConfig: toBedrockTools(mcpTools),
        inferenceConfig: { maxTokens: 1024 },
      }),
    );
    const message = response.output?.message;
    if (!message) return { speech: 'Sorry, I lost my train of thought.', calls };
    messages.push(message);

    const toolUses = message.content.filter((b) => b.toolUse).map((b) => b.toolUse);
    if (response.stopReason !== 'tool_use' || !toolUses.length) {
      const text = message.content.filter((b) => b.text).map((b) => b.text).join(' ').trim();
      return { speech: text || resultSpeech(calls.at(-1)?.result) || 'Done.', calls };
    }

    const results = [];
    for (const use of toolUses) {
      const result = await mcp.callTool(use.name, use.input || {});
      calls.push({ name: use.name, args: use.input || {}, result });
      results.push({
        toolResult: {
          toolUseId: use.toolUseId,
          content: [{ json: result.structuredContent ?? { text: resultSpeech(result) } }],
          status: result.isError ? 'error' : 'success',
        },
      });
    }
    messages.push({ role: 'user', content: results });
  }
  return { speech: resultSpeech(calls.at(-1)?.result) || 'Done.', calls };
}

// ---------- offline rules planner ----------

const DUE_RE = /\s+(?:by |on |for |due )?(today|tonight|tomorrow|this weekend|next week|in \d+ days?|(?:this |next |on )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;
const AREAS = ['work', 'health', 'family', 'finance', 'home', 'personal', 'fitness', 'learning'];

function moodScore(text) {
  const num = text.match(/\b([1-5])\s*(?:out of|\/)\s*(?:5|five)\b/);
  if (num) return Number(num[1]);
  const scales = [
    [5, /\b(great|amazing|awesome|fantastic|excellent|incredible|on top of the world)\b/],
    [1, /\b(terrible|awful|horrible|miserable|depressed|worst)\b/],
    [2, /\b(tired|low|sad|stressed|down|anxious|bad|exhausted|overwhelmed|not great)\b/],
    [4, /\b(good|happy|well|productive|positive|nice)\b/],
    [3, /\b(okay|ok|fine|alright|meh|so-so)\b/],
  ];
  return scales.find(([, re]) => re.test(text))?.[0] ?? 3;
}

function parseTask(raw) {
  let title = raw.trim().replace(/[.?!]+$/, '');
  let due;
  let priority;
  let area;
  const d = title.match(DUE_RE);
  if (d) {
    due = d[1].replace(/^(on|this)\s+/i, '');
    title = title.replace(d[0], '');
  }
  if (/\b(urgent|important|high priority|asap)\b/i.test(title)) {
    priority = 'high';
    title = title.replace(/,?\s*(it's |its )?(urgent|important|high priority|asap)\b/gi, '');
  }
  const a = title.match(new RegExp(`\\s+for (${AREAS.join('|')})$`, 'i'));
  if (a) {
    area = a[1].toLowerCase();
    title = title.replace(a[0], '');
  }
  return Object.fromEntries(Object.entries({ title: title.trim(), due, priority, area }).filter(([, v]) => v));
}

async function habitNames(mcp) {
  const res = await mcp.request('resources/read', { uri: 'lifeos://habits' });
  return JSON.parse(res.contents[0].text).map((h) => h.name);
}

function matchHabit(text, names) {
  const t = text.toLowerCase();
  return names.find((n) => {
    const stem = n.toLowerCase().split(' ')[0].slice(0, 4);
    return t.includes(n.toLowerCase()) || t.includes(stem);
  });
}

async function route(mcp, text) {
  const t = text.toLowerCase();
  let m;

  if (/\b(what can you do|help|how does this work)\b/.test(t)) return { speech: 'I can run your LifeOS by voice. Try: what\'s my day look like, remind me to call the bank tomorrow, I finished my workout, I\'m feeling great, or how was my week.' };
  if (/\b(weekly review|how was my week|review (?:my|the) week|week in review)\b/.test(t)) return ['weekly_review', {}];
  if (/\b(good morning|briefing|how(?:'s| is) my day|what(?:'s| is| does) (?:on )?my (?:day|plate|agenda)|my day look|daily summary|catch me up)\b/.test(t)) return ['get_daily_briefing', {}];

  if ((m = t.match(/\b(?:start tracking|new habit|create (?:a )?(?:new )?habit|add (?:a )?habit)\s+(?:called |named |to )?(.+)/))) return ['create_habit', { name: m[1].replace(/[.?!]$/, '') }];

  if ((m = t.match(/\b(?:i(?:'m| am)? feeling|i feel|my mood is|mood check|feeling)\b\s*(.*)/))) {
    return ['log_mood', { score: moodScore(t), ...(m[1] ? { note: text.slice(text.toLowerCase().indexOf(m[1])).replace(/[.?!]$/, '') } : {}) }];
  }

  if ((m = text.match(/\b(?:journal(?: entry)?|note to self|dear diary|write down|jot down)[:,]?\s*(?:that\s+)?(.+)/i))) return ['add_journal_entry', { text: m[1] }];

  if ((m = t.match(/\b(?:update|set|bump|move|increase)\s+(?:my\s+)?(.+?)\s+(?:goal\s+)?(to|by)\s+(\d+)\s*(?:%|percent)?/)) && !/\btask\b/.test(t)) {
    return ['update_goal_progress', { goal: m[1].replace(/\s*goal$/, ''), ...(m[2] === 'to' ? { progress: Number(m[3]) } : { delta: Number(m[3]) }) }];
  }
  if (/\bgoals?\b/.test(t)) return ['get_goals', {}];

  if ((m = t.match(/\b(?:move|reschedule|push)\s+(?:the\s+)?(.+?)\s+(?:task\s+)?to\s+(.+)/))) return ['reschedule_task', { task: m[1], due: m[2].replace(/[.?!]$/, '') }];
  if ((m = t.match(/\b(?:delete|remove|cancel)\s+(?:the\s+)?(?:task\s+)?(.+)/))) return ['delete_task', { task: m[1].replace(/\s+task$/, '').replace(/[.?!]$/, '') }];

  if (/\b(habits?|streaks?)\b/.test(t) && /\b(how|what|show|list|my)\b/.test(t)) return ['get_habits', {}];

  // "I meditated", "I just finished my workout", "log reading" → habit if it names one, otherwise a task.
  if (/\b(?:i(?:'ve)? (?:just )?(?:did|done|finished|completed|went|worked|meditated|read|drank)|log|logged|track|mark|check off|complete|done with)\b/.test(t)) {
    const habit = matchHabit(t, await habitNames(mcp));
    if (habit && !/\btask\b/.test(t)) return ['log_habit', { habit }];
    m = t.match(/\b(?:finished|completed|complete|done with|mark|check off|did)\s+(?:the\s+|my\s+)?(.+?)(?:\s+task)?(?:\s+as (?:done|complete|finished))?(?:\s+off)?[.?!]?$/);
    if (m) return ['complete_task', { task: m[1] }];
  }

  if ((m = text.match(/\b(?:remind me to|add (?:a )?(?:task|todo|to-do)(?: to)?|i need to|i have to|i should|put)\s+(.+?)(?:\s+on my (?:list|to-?do list))?$/i))) return ['add_task', parseTask(m[1])];

  if (/\b(tasks?|to-?dos?|to do|list|coming up|upcoming|what(?:'s| is) next)\b/.test(t)) {
    const when = /overdue|late|behind/.test(t) ? 'overdue' : /upcoming|coming up|this week|later|next/.test(t) ? 'upcoming' : /\ball\b|everything/.test(t) ? 'all' : 'today';
    const area = AREAS.find((a) => t.includes(` ${a}`));
    return ['list_tasks', { when, ...(area ? { area } : {}) }];
  }

  return { speech: "I'm not sure how to help with that yet. You can ask about your day, add a task, log a habit, or check in your mood." };
}

async function planWithRules(mcp, utterance) {
  const plan = await route(mcp, utterance);
  if (!Array.isArray(plan)) return { speech: plan.speech, calls: [] };
  const [name, args] = plan;
  const result = await mcp.callTool(name, args);
  return { speech: resultSpeech(result), calls: [{ name, args, result }] };
}

// ---------- entry point ----------

// ALEXA_SIM_PLANNER = claude | bedrock | rules. Unset: Claude if ANTHROPIC_API_KEY is set,
// else Bedrock if BEDROCK_MODEL_ID is set, else the offline rules.
export function plannerName() {
  const forced = process.env.ALEXA_SIM_PLANNER;
  if (['claude', 'bedrock', 'rules'].includes(forced)) return forced;
  if (process.env.ANTHROPIC_API_KEY) return 'claude';
  if (process.env.BEDROCK_MODEL_ID) return 'bedrock';
  return 'rules';
}

export function plannerLabel() {
  return { claude: `Claude (${MODEL})`, bedrock: `Amazon Bedrock (${BEDROCK_MODEL})`, rules: 'On-device rules' }[plannerName()];
}

const PLANNERS = { claude: planWithClaude, bedrock: planWithBedrock };

export async function respond(baseUrl, utterance, history = []) {
  const clean = utterance.replace(/^\s*(?:hey\s+)?alexa[,!]?\s*/i, '').replace(/^(?:ask|tell|open) life ?os (?:to |that |for )?/i, '').trim();
  const started = Date.now();
  const planner = plannerName();

  const out = await withSession(baseUrl, async (mcp) => {
    mcp.drainLog(); // keep the trace to this utterance only
    let res;
    try {
      res = PLANNERS[planner] ? await PLANNERS[planner](mcp, clean, history) : await planWithRules(mcp, clean);
    } catch (err) {
      if (!PLANNERS[planner] || err.code === 'SESSION_EXPIRED') throw err;
      console.warn(`[agent] ${planner} planner failed (${err.name}: ${err.message}); falling back to rules`);
      res = { ...(await planWithRules(mcp, clean)), fallback: true };
    }
    return { ...res, trace: mcp.drainLog(), sessionId: mcp.sessionId, protocolVersion: mcp.protocolVersion };
  });

  return { ...out, planner: out.fallback ? 'rules' : planner, utterance: clean, ms: Date.now() - started };
}

// Direct UI actions (tap a checkbox, tap a habit) also go through MCP, so they show in the traffic view.
export async function runTool(baseUrl, name, args = {}) {
  return withSession(baseUrl, async (mcp) => {
    const result = await mcp.callTool(name, args);
    mcp.drainLog();
    return result;
  });
}

export async function discover(baseUrl) {
  return withSession(baseUrl, async (mcp) => ({ serverInfo: mcp.serverInfo, protocolVersion: mcp.protocolVersion, sessionId: mcp.sessionId, tools: mcpTools }));
}
