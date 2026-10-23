// LifeOS for Alexa+ — simulator front end.
// Voice in (Web Speech API) → /api/ask → simulated Alexa+ agent → MCP → LifeOS tools → voice out.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const STARTERS = [
  ['☀️', "What's my day look like?", 'Your daily briefing'],
  ['✅', 'Remind me to call the bank tomorrow', 'Capture a task'],
  ['🔥', 'I finished my workout', 'Keep a streak alive'],
  ['💭', "I'm feeling great, shipped the demo", 'Check in your mood'],
  ['📅', 'Move the dentist to Friday', 'Reschedule anything'],
  ['📈', 'How was my week?', 'Weekly review'],
];
const CHIPS = ['Mark call mom as done', "What's coming up?", 'Bump my 10K goal by 10 percent', 'Show my habits', 'Journal: the demo finally clicked today', 'What tasks are overdue?', 'Start tracking stretching', 'How are my goals?'];

// ---------- dates ----------
const iso = (d) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const todayIso = () => iso(new Date());
const shift = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); };
const nice = (s) => {
  if (!s) return '';
  if (s === todayIso()) return 'Today';
  if (s === shift(todayIso(), 1)) return 'Tomorrow';
  if (s === shift(todayIso(), -1)) return 'Yesterday';
  return new Date(s + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};

// =====================================================================
// Orb — a living gradient blob whose motion reflects Alexa's state.
// =====================================================================
const orb = (() => {
  const cv = $('orb');
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, R = W * 0.3;
  const layers = [
    { c: [0, 210, 255], s: 1.0, p: 0 },
    { c: [123, 97, 255], s: 1.3, p: 2 },
    { c: [255, 95, 162], s: 0.8, p: 4 },
  ];
  let state = 'idle', level = 0, target = 0, t = 0, spin = 0;
  const speeds = { idle: 0.6, listening: 1.4, thinking: 3.2, speaking: 1.8 };
  const amps = { idle: 0.06, listening: 0.1, thinking: 0.12, speaking: 0.14 };

  function frame() {
    t += 0.016 * speeds[state];
    spin += state === 'thinking' ? 0.05 : 0.004;
    level += (target - level) * 0.18;
    if (state === 'speaking') target = Math.max(0, target * 0.92);
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'screen';
    const amp = amps[state] + level * 0.35;

    layers.forEach((L, k) => {
      // each layer orbits slightly off-centre so the colours separate instead of blending to white
      const cx = W / 2 + Math.cos(t * 0.5 * L.s + k * 2.1) * R * 0.16;
      const cy = H / 2 + Math.sin(t * 0.6 * L.s + k * 2.1) * R * 0.16;
      ctx.beginPath();
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        const n = Math.sin(a * 3 + t * L.s + L.p) * 0.5 + Math.sin(a * 5 - t * 1.3 * L.s + L.p) * 0.3 + Math.sin(a * 2 + t * 0.7) * 0.2;
        const r = R * (0.8 + n * amp + level * 0.12);
        ctx[i ? 'lineTo' : 'moveTo'](cx + Math.cos(a + spin * L.s) * r, cy + Math.sin(a + spin * L.s) * r);
      }
      const g = ctx.createRadialGradient(cx, cy, R * 0.05, cx, cy, R * 1.1);
      g.addColorStop(0, `rgba(${L.c},0.75)`);
      g.addColorStop(0.55, `rgba(${L.c},0.4)`);
      g.addColorStop(1, `rgba(${L.c},0.02)`);
      ctx.fillStyle = g;
      ctx.shadowColor = `rgba(${L.c},0.6)`;
      ctx.shadowBlur = 40;
      ctx.fill();
    });
    // glassy core highlight
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0;
    const h = ctx.createRadialGradient(W / 2 - R * 0.35, H / 2 - R * 0.4, 0, W / 2 - R * 0.35, H / 2 - R * 0.4, R * 0.55);
    h.addColorStop(0, 'rgba(255,255,255,0.32)');
    h.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = h;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, R * 0.8, 0, Math.PI * 2);
    ctx.fill();
    if (!reduceMotion || state !== 'idle') requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return {
    set(s) { const was = state; state = s; if (reduceMotion && was === 'idle' && s !== 'idle') requestAnimationFrame(frame); },
    level(v) { target = Math.min(1, v); },
  };
})();

const STATE_LABEL = { idle: 'Tap the mic or press <kbd>Space</kbd>', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…' };
function setState(s) {
  orb.set(s);
  const chat = $('stage').dataset.mode === 'chat';
  $('orb-state').innerHTML = chat ? (s === 'idle' ? 'Alexa' : STATE_LABEL[s]) : STATE_LABEL[s];
}

// Hook for scripted demo recordings to drive the orb while pre-rendered voices play.
window.__lifeos = { setState, level: (v) => orb.level(v) };

// =====================================================================
// Voice out
// =====================================================================
let tts = store.get('lifeos.tts', true);
const ttsBtn = $('tts');
const syncTts = () => { ttsBtn.setAttribute('aria-pressed', String(tts)); ttsBtn.title = tts ? 'Spoken replies on' : 'Spoken replies off'; };
syncTts();
ttsBtn.onclick = () => { tts = !tts; store.set('lifeos.tts', tts); syncTts(); if (!tts) speechSynthesis?.cancel(); };

function speak(text) {
  if (!tts || !('speechSynthesis' in window)) return setState('idle');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/\p{Extended_Pictographic}/gu, ''));
  const voices = speechSynthesis.getVoices();
  u.voice = voices.find((v) => /en-US/.test(v.lang) && /aria|jenny|samantha|zira|google us english|female/i.test(v.name)) || voices.find((v) => /en-US/.test(v.lang)) || null;
  u.rate = 1.04;
  u.onstart = () => setState('speaking');
  u.onboundary = () => orb.level(0.55 + Math.random() * 0.4);
  u.onend = u.onerror = () => { orb.level(0); setState('idle'); };
  speechSynthesis.speak(u);
}

// =====================================================================
// Conversation
// =====================================================================
const history = [];
let busy = false;

function enterChat() {
  if ($('stage').dataset.mode === 'chat') return;
  $('stage').dataset.mode = 'chat';
}

const wordify = (text) => text.split(/(\s+)/).map((w, i) => (w.trim() ? `<span class="w" style="animation-delay:${Math.min(i * 18, 1400)}ms">${esc(w)}</span>` : w)).join('');

async function ask(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  enterChat();
  const turn = document.createElement('div');
  turn.className = 'turn';
  turn.innerHTML = `<div class="said">${esc(text)}</div><div class="reply"><span class="typing"><i></i><i></i><i></i></span></div>`;
  $('thread').append(turn);
  scrollThread();
  setState('thinking');
  try {
    const res = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, history }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    const reply = turn.querySelector('.reply');
    reply.innerHTML = wordify(data.speech);
    for (const c of data.calls) {
      const html = renderCard(c);
      if (html) reply.insertAdjacentHTML('afterend', html);
    }
    turn.insertAdjacentHTML('beforeend', `<div class="meta">${data.calls.map((c) => `<span class="tool">${esc(c.name)}</span>`).join('')}<span>${{ claude: 'Claude', bedrock: 'Amazon Bedrock', rules: 'On-device' }[data.planner] || data.planner} · ${data.ms} ms · via MCP</span></div>`);
    requestAnimationFrame(() => turn.querySelectorAll('.bar b[data-w]').forEach((b) => (b.style.width = b.dataset.w + '%')));
    history.push({ role: 'user', text }, { role: 'assistant', text: data.speech });
    speak(data.speech);
    celebrate(data.calls);
    if (data.calls.length) refresh();
  } catch (err) {
    turn.querySelector('.reply').textContent = `Sorry, I couldn't reach LifeOS: ${err.message}`;
    setState('idle');
  } finally {
    busy = false;
    scrollThread();
  }
}

function scrollThread() {
  const th = $('thread');
  requestAnimationFrame(() => (th.scrollTop = th.scrollHeight));
}

function celebrate(calls) {
  for (const { name, result } of calls) {
    const d = result?.structuredContent || {};
    if (name === 'complete_task' && d.remainingToday === 0) confetti();
    if (name === 'log_habit' && d.streak && d.streak % 7 === 0) confetti();
    if (name === 'update_goal_progress' && d.goal?.progress === 100) confetti();
  }
}

// ---------- answer cards ----------
const CHECK = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const MOOD_EMOJI = ['', '😣', '😕', '🙂', '😊', '🤩'];
const bar = (p) => `<div class="bar"><b data-w="${p}"></b></div>`;
const dots = (n) => `<span class="dots">${Array.from({ length: 7 }, (_, i) => `<i class="${i >= 7 - Math.min(n, 7) ? 'on' : ''} ${i === 6 ? 'today' : ''}"></i>`).join('')}</span>`;
const card = (title, body) => `<div class="card"><h4>${title}</h4>${body}</div>`;

function renderCard({ name, result }) {
  if (!result || result.isError) return '';
  const d = result.structuredContent || {};
  switch (name) {
    case 'get_daily_briefing':
      return card('Your day', `
        <div class="kpis">
          <div class="kpi"><b>${d.dueToday?.length ?? 0}</b><span>due today</span></div>
          <div class="kpi"><b>${d.overdue?.length ?? 0}</b><span>overdue</span></div>
          <div class="kpi"><b>${d.habitsPending?.length ?? 0}</b><span>habits left</span></div>
        </div>
        ${d.dueToday?.length ? `<ul style="margin-top:12px">${d.dueToday.map((t) => `<li><span class="prio ${t.priority}"></span>${esc(t.title)}</li>`).join('')}</ul>` : ''}
        ${d.nextGoal ? `<div style="margin-top:14px"><div class="row" style="justify-content:space-between;font-size:13px;margin-bottom:6px"><span>🎯 ${esc(d.nextGoal.title)}</span><b>${d.nextGoal.progress}%</b></div>${bar(d.nextGoal.progress)}</div>` : ''}`);
    case 'add_task':
      return card('✨ Added to LifeOS', `<div class="row"><span class="prio ${d.task.priority}"></span><b style="font-size:17px">${esc(d.task.title)}</b></div>
        <div class="pills">${d.task.due ? `<span class="pill">📅 ${nice(d.task.due)}</span>` : ''}<span class="pill">${esc(d.task.priority)} priority</span><span class="pill">${esc(d.task.area)}</span></div>`);
    case 'complete_task':
      return card('Checked off', `<div class="row"><span class="check">${CHECK}</span><div><b style="font-size:17px">${esc(d.task.title)}</b><div class="hint">${d.remainingToday ? `${d.remainingToday} left for today` : 'All clear for today 🎉'}</div></div></div>`);
    case 'reschedule_task':
      return card('Rescheduled', `<div class="row"><span class="emoji" style="font-size:36px">📅</span><div><b style="font-size:17px">${esc(d.task.title)}</b><div class="hint">Now due ${nice(d.task.due)}</div></div></div>`);
    case 'delete_task':
      return card('Deleted', `<div class="row"><span style="font-size:28px">🗑️</span><s>${esc(d.deleted.title)}</s></div>`);
    case 'log_habit':
      return card('Habit logged', `<div class="row"><span class="flame">🔥</span><div><div class="big">${d.streak}<small style="font-size:16px;font-weight:600;color:var(--muted)"> day${d.streak === 1 ? '' : 's'}</small></div><div class="hint">${esc(d.habit)} streak</div></div><div style="margin-left:auto">${dots(d.streak)}</div></div>`);
    case 'get_habits':
      return card('Habits', `<ul>${d.habits.map((h) => `<li><span style="width:20px">${h.doneToday ? '✅' : '⬜'}</span><span style="flex:1">${esc(h.name)}</span><span class="hint">🔥 ${h.streak}d</span></li>`).join('')}</ul>`);
    case 'create_habit':
      return card('New habit', `<div class="row"><span style="font-size:32px">🌱</span><div><b style="font-size:17px">${esc(d.habit.name)}</b><div class="hint">Tracking daily from today</div></div></div>`);
    case 'log_mood':
      return card('Mood check-in', `<div class="row"><span class="emoji">${MOOD_EMOJI[d.score]}</span><div><div class="big">${d.score}<small style="font-size:16px;color:var(--muted)">/5</small></div><div class="hint">7-day average ${d.weekAverage}</div></div></div>${d.note ? `<div class="pills"><span class="pill">“${esc(d.note)}”</span></div>` : ''}`);
    case 'add_journal_entry':
      return card(`Journal · entry ${d.totalEntries}`, `<blockquote>${esc(d.entry.text)}</blockquote>`);
    case 'get_goals':
      return card('Goals', `<ul style="gap:12px">${d.goals.map((g) => `<li style="display:block"><div class="row" style="justify-content:space-between;margin-bottom:6px"><span>${esc(g.title)}</span><b>${g.progress}%</b></div>${bar(g.progress)}</li>`).join('')}</ul>`);
    case 'update_goal_progress':
      return card('Goal progress', `<div class="row" style="justify-content:space-between;margin-bottom:8px"><b style="font-size:17px">🎯 ${esc(d.goal.title)}</b><span class="big" style="font-size:28px">${d.goal.progress}%</span></div>${bar(d.goal.progress)}`);
    case 'weekly_review':
      return card('Your week', `<div class="kpis">
          <div class="kpi"><b>${d.tasksCompleted}</b><span>tasks done</span></div>
          <div class="kpi"><b>${d.habitRate}%</b><span>habit rate</span></div>
          <div class="kpi"><b>${d.moodAverage ?? '–'}</b><span>avg mood</span></div>
        </div>${d.focus ? `<div class="pills"><span class="pill">Next week's focus: <b>${esc(d.focus)}</b></span></div>` : ''}`);
    case 'list_tasks':
      return d.tasks?.length ? card(`Tasks · ${d.tasks.length}`, `<ul>${d.tasks.slice(0, 6).map((t) => `<li><span class="prio ${t.priority}"></span><span style="flex:1">${esc(t.title)}</span><span class="hint">${nice(t.due)}</span></li>`).join('')}</ul>`) : '';
    default:
      return '';
  }
}

// =====================================================================
// Input: composer, starters, chips, voice
// =====================================================================
$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  ask($('input').value);
  $('input').value = '';
});

$('starters').innerHTML = STARTERS.map(([ic, q, sub]) => `<button class="starter" data-q="${esc(q)}"><span class="ic">${ic}</span><span><b>${esc(q)}</b><small>${esc(sub)}</small></span></button>`).join('');
$('chips').innerHTML = CHIPS.map((q) => `<button data-q="${esc(q)}">${esc(q)}</button>`).join('');
for (const el of document.querySelectorAll('[data-q]')) el.onclick = () => ask(el.dataset.q);

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const mic = $('mic');
let rec = null, listening = false, meter = null;

async function startMeter() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ac = new AudioContext();
    const an = ac.createAnalyser();
    an.fftSize = 512;
    ac.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    let raf;
    const tick = () => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      orb.level(Math.sqrt(sum / buf.length) * 6);
      raf = requestAnimationFrame(tick);
    };
    tick();
    meter = () => { cancelAnimationFrame(raf); stream.getTracks().forEach((t) => t.stop()); ac.close(); orb.level(0); };
  } catch { /* level meter is decoration; recognition still works */ }
}

if (!Recognition) {
  mic.disabled = true;
  mic.title = 'Voice needs Chrome or Edge. You can type instead.';
} else {
  rec = new Recognition();
  rec.lang = 'en-US';
  rec.interimResults = true;
  let finalText = '';
  rec.onstart = () => {
    listening = true;
    finalText = '';
    mic.classList.add('on');
    speechSynthesis?.cancel();
    setState('listening');
    startMeter();
  };
  rec.onresult = (e) => {
    const text = Array.from(e.results).map((r) => r[0].transcript).join('');
    $('input').value = text;
    if (e.results[e.results.length - 1].isFinal) finalText = text;
  };
  rec.onerror = (e) => { if (e.error === 'not-allowed') toast('🎙️ Allow microphone access to talk to Alexa'); };
  rec.onend = () => {
    listening = false;
    mic.classList.remove('on');
    meter?.();
    meter = null;
    $('input').value = '';
    if (finalText) ask(finalText);
    else if (!busy) setState('idle');
  };
  mic.onclick = () => (listening ? rec.stop() : rec.start());
}

window.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (e.code === 'Space' && !typing && rec && !listening) { e.preventDefault(); rec.start(); }
  if (e.key.toLowerCase() === 'd' && !typing && !e.metaKey && !e.ctrlKey) toggleDev();
  if (e.key === 'Escape') toggleDev(false);
});

// =====================================================================
// LifeOS panel
// =====================================================================
let lastJson = '';
let knownTasks = new Set();

async function tool(name, args) {
  const res = await fetch('/api/tool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, args }) });
  const r = await res.json();
  if (!res.ok) throw new Error(r.error);
  return r;
}

function taskRow(t) {
  const late = t.status === 'open' && t.due && t.due < todayIso();
  const fresh = knownTasks.size && !knownTasks.has(t.id);
  return `<li class="task ${t.status === 'done' ? 'done' : ''} ${fresh ? 'new' : ''}">
    <button class="box" data-task="${t.id}" data-title="${esc(t.title)}" aria-label="${t.status === 'done' ? 'Done' : 'Mark done'}: ${esc(t.title)}" ${t.status === 'done' ? 'disabled' : ''}>
      <svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <span class="prio ${t.priority}"></span>
    <span class="t" title="${esc(t.title)}">${esc(t.title)}</span>
    ${t.due ? `<span class="due ${late ? 'late' : ''}">${late ? 'Overdue' : nice(t.due)}</span>` : ''}
  </li>`;
}

async function refresh() {
  const s = await (await fetch('/api/state')).json();
  const json = JSON.stringify(s);
  if (json === lastJson) return;
  lastJson = json;
  const t = todayIso();
  const days = Array.from({ length: 7 }, (_, i) => shift(t, i - 6));

  // greeting
  const h = new Date().getHours();
  $('greeting').innerHTML = `${h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'}, <span>${esc(s.profile.name)}</span>.`;
  $('today-label').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  // tasks
  const todays = s.tasks.filter((x) => (x.status === 'open' && x.due && x.due <= t) || (x.status === 'done' && x.completedAt === t));
  todays.sort((a, b) => (a.status === 'done') - (b.status === 'done') || ['high', 'medium', 'low'].indexOf(a.priority) - ['high', 'medium', 'low'].indexOf(b.priority));
  const upcoming = s.tasks.filter((x) => x.status === 'open' && (!x.due || x.due > t)).sort((a, b) => (a.due || '9').localeCompare(b.due || '9'));
  $('tasks-today').innerHTML = todays.map(taskRow).join('') || '<li class="empty">Nothing due today. Enjoy it ☕</li>';
  $('tasks-upcoming').innerHTML = upcoming.map(taskRow).join('') || '<li class="empty">Nothing scheduled.</li>';
  const openToday = todays.filter((x) => x.status === 'open').length;
  $('c-today').textContent = todays.length ? `${todays.length - openToday}/${todays.length}` : '';
  $('c-up').textContent = upcoming.length || '';
  knownTasks = new Set(s.tasks.map((x) => x.id));

  // habits
  $('habits').innerHTML = s.habits.map((hb) => {
    const done = hb.log.includes(t);
    return `<button class="habit ${done ? 'done' : ''}" data-habit="${esc(hb.name)}" aria-pressed="${done}" title="${done ? 'Done today' : 'Tap to log ' + esc(hb.name)}">
      <span class="hn">${esc(hb.name)}<span class="st">${done ? '✓ ' : ''}🔥 ${hb.streak}</span></span>
      <span class="dots">${days.map((d) => `<i class="${hb.log.includes(d) ? 'on' : ''} ${d === t ? 'today' : ''}" title="${nice(d)}"></i>`).join('')}</span>
    </button>`;
  }).join('');

  // goals
  $('goals').innerHTML = s.goals.map((g) => `<li><div><span>${esc(g.title)}</span><span class="pct">${g.progress}%</span></div>${bar(g.progress)}</li>`).join('');

  // mood
  $('mood').innerHTML = days.map((d) => {
    const m = s.moods.find((x) => x.date === d);
    return `<div class="m ${m ? '' : 'none'}" title="${nice(d)}${m ? `: ${m.score}/5 ${esc(m.note)}` : ': no check-in'}"><b style="height:${m ? m.score * 18 : 4}%"></b><span>${new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'narrow' })}</span></div>`;
  }).join('');

  // journal
  const j = s.journal[0];
  $('journal').innerHTML = j ? `${esc(j.text)}<small>${nice(j.date)} · ${s.journal.length} recent entr${s.journal.length === 1 ? 'y' : 'ies'}</small>` : '<span class="empty">Say “journal: …” to write your first entry.</span>';

  // summary
  const habitsDone = s.habits.filter((x) => x.log.includes(t)).length;
  const units = todays.length + s.habits.length;
  const doneUnits = todays.length - openToday + habitsDone;
  const pct = units ? Math.round((doneUnits / units) * 100) : 0;
  $('day-pct').textContent = `${pct}%`;
  $('day-ring').style.strokeDashoffset = String(314.16 * (1 - pct / 100));
  $('s-tasks').textContent = openToday;
  $('s-habits').textContent = `${habitsDone}/${s.habits.length}`;
  const best = Math.max(0, ...s.habits.map((x) => x.streak));
  $('s-streak').textContent = `${best}d`;
  const mt = s.moods.find((x) => x.date === t);
  $('s-mood').textContent = mt ? MOOD_EMOJI[mt.score] : '–';

  requestAnimationFrame(() => document.querySelectorAll('.life .bar b[data-w]').forEach((b) => (b.style.width = b.dataset.w + '%')));
}

// One-tap actions — routed through MCP like everything else.
document.querySelector('.life').addEventListener('click', async (e) => {
  const box = e.target.closest('[data-task]');
  const habit = e.target.closest('[data-habit]');
  try {
    if (box && !box.disabled) {
      box.closest('.task').classList.add('done');
      const r = await tool('complete_task', { task: box.dataset.task });
      toast(`✅ ${box.dataset.title}`);
      if (r.structuredContent?.remainingToday === 0) confetti();
      refresh();
    } else if (habit && habit.getAttribute('aria-pressed') !== 'true') {
      habit.classList.add('done');
      const r = await tool('log_habit', { habit: habit.dataset.habit });
      const n = r.structuredContent?.streak;
      toast(`🔥 ${habit.dataset.habit} · ${n}-day streak`);
      if (n && n % 7 === 0) confetti();
      refresh();
    }
  } catch (err) {
    toast(`Couldn't update: ${err.message}`);
    refresh();
  }
});

$('reset').onclick = async () => {
  await fetch('/api/reset', { method: 'POST' });
  lastJson = '';
  knownTasks = new Set();
  await refresh();
  toast('Demo data restored');
};

// =====================================================================
// Toasts & confetti
// =====================================================================
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('toasts').append(el);
  setTimeout(() => el.remove(), 3100);
}

function confetti() {
  if (reduceMotion) return;
  const cv = $('confetti');
  const ctx = cv.getContext('2d');
  cv.width = innerWidth * devicePixelRatio;
  cv.height = innerHeight * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const colors = ['#00d2ff', '#7b61ff', '#ff5fa2', '#34d399', '#fbbf24'];
  const parts = Array.from({ length: 160 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 200, y: innerHeight * 0.45,
    vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 16 - 6,
    s: Math.random() * 7 + 4, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, c: colors[(Math.random() * colors.length) | 0],
  }));
  const end = performance.now() + 2600;
  (function step(now) {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.45; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore();
    }
    if (now < end) requestAnimationFrame(step);
    else ctx.clearRect(0, 0, innerWidth, innerHeight);
  })(performance.now());
}

// =====================================================================
// Developer drawer — live MCP traffic
// =====================================================================
const dev = $('dev');
function toggleDev(force) {
  const open = force ?? !dev.classList.contains('open');
  if (open) dev.hidden = false;
  requestAnimationFrame(() => dev.classList.toggle('open', open));
  $('dev-toggle').setAttribute('aria-expanded', String(open));
  if (!open) setTimeout(() => !dev.classList.contains('open') && (dev.hidden = true), 450);
}
$('dev-toggle').onclick = () => toggleDev();
$('dev-close').onclick = () => toggleDev(false);
$('clear').onclick = () => ($('log').innerHTML = '');

const methods = new Map();
function logEntry({ dir, message, sessionId }) {
  let label, cls = '';
  if (message.method) {
    label = message.method + (message.params?.name ? ` · ${message.params.name}` : '');
    if (message.id !== undefined) methods.set(`${sessionId}:${message.id}`, label);
  } else if (message.error) {
    label = `error ${message.error.code} · ${message.error.message}`;
    cls = 'err';
  } else if (message.result) {
    label = `${methods.get(`${sessionId}:${message.id}`) || methods.get(`null:${message.id}`) || 'result'} ✓`;
    if (message.result.isError) cls = 'err';
  } else label = message.note || 'message';

  const li = document.createElement('li');
  li.className = dir === 'in' ? 'in' : 'out';
  li.innerHTML = `<details><summary><span class="dir">${dir === 'in' ? '→' : '←'}</span><span class="method ${cls}">${esc(label)}</span><span class="sid">${sessionId ? esc(sessionId.slice(0, 8)) : ''}</span></summary><pre>${esc(JSON.stringify(message, null, 2))}</pre></details>`;
  $('log').prepend(li);
  while ($('log').children.length > 200) $('log').lastChild.remove();
  const b = $('beat');
  b.classList.remove('on');
  void b.offsetWidth;
  b.classList.add('on');
}

function connectTraffic() {
  const es = new EventSource('/api/traffic');
  es.onmessage = (e) => {
    const evt = JSON.parse(e.data);
    logEntry(evt);
    // Changes from any MCP client (Inspector, a real Alexa+ device) show up here too.
    if (evt.dir === 'in' && evt.message.method === 'tools/call') setTimeout(refresh, 150);
  };
  es.onerror = () => setConn('bad', 'Reconnecting…');
  es.onopen = () => setConn('ok', 'Connected via MCP');
}

function setConn(cls, text) {
  $('conn').className = `conn ${cls}`;
  $('conn-text').textContent = text;
}

// =====================================================================
// Boot
// =====================================================================
async function boot() {
  setState('idle');
  connectTraffic();
  refresh();
  try {
    const d = await (await fetch('/api/discover')).json();
    setConn('ok', 'Connected via MCP');
    $('facts').innerHTML = [
      ['Protocol', d.protocolVersion],
      ['Transport', 'Streamable HTTP'],
      ['Server', `${d.serverInfo.title} ${d.serverInfo.version}`],
      ['Session', d.sessionId],
      ['Planner', d.plannerLabel || d.planner],
      ['Endpoint', `${location.origin}/mcp`],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd title="${esc(v)}">${esc(v)}</dd></div>`).join('');
    $('tool-count').textContent = d.tools.length;
    $('tool-list').innerHTML = d.tools.map((t) => `<li>${esc(t.name)}${t.annotations?.readOnlyHint ? '<span class="tag ro">read-only</span>' : ''}${t.annotations?.destructiveHint ? '<span class="tag de">destructive</span>' : ''}${t.annotations?.idempotentHint ? '<span class="tag">idempotent</span>' : ''}</li>`).join('');
  } catch {
    setConn('bad', 'MCP server offline');
  }
  setInterval(refresh, 5000);

  // Demo links: /?ask=How%20was%20my%20week  ·  /?dev=1 opens the MCP drawer
  const params = new URLSearchParams(location.search);
  if (params.get('dev')) toggleDev(true);
  for (const q of params.getAll('ask')) await ask(q);
}

boot();
