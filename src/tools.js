// LifeOS tools exposed over MCP. Each tool returns:
//   speech — a short, voice-first sentence Alexa+ can read aloud
//   data   — structured data (sent as structuredContent) for richer clients / screens
import { load, mutate, today, addDays, newId } from './store.js';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const PRIORITIES = ['low', 'medium', 'high'];
const MOOD_WORDS = { 1: 'rough', 2: 'low', 3: 'okay', 4: 'good', 5: 'great' };

// ---------- helpers ----------

export function parseDate(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  const t = today();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (['today', 'tonight', 'this evening', 'now'].includes(s)) return t;
  if (s === 'tomorrow') return addDays(t, 1);
  if (s === 'yesterday') return addDays(t, -1);
  if (s === 'next week') return addDays(t, 7);
  if (s === 'this weekend' || s === 'weekend') return nextWeekday('saturday', t);
  const inDays = s.match(/^in (\d+) days?$/);
  if (inDays) return addDays(t, Number(inDays[1]));
  const wd = s.replace(/^(on|this|next)\s+/, '');
  // "next friday" is treated as the coming friday, which is how people usually mean it.
  if (WEEKDAYS.includes(wd)) return nextWeekday(wd, t);
  const parsed = new Date(input);
  return isNaN(parsed) ? null : parsed.toISOString().slice(0, 10);
}

function nextWeekday(name, from) {
  const cur = new Date(from + 'T12:00:00').getDay();
  const diff = (WEEKDAYS.indexOf(name) - cur + 7) % 7 || 7;
  return addDays(from, diff);
}

export function spokenDate(iso) {
  if (!iso) return 'no date';
  const t = today();
  if (iso === t) return 'today';
  if (iso === addDays(t, 1)) return 'tomorrow';
  if (iso === addDays(t, -1)) return 'yesterday';
  const d = new Date(iso + 'T12:00:00');
  const diff = Math.round((d - new Date(t + 'T12:00:00')) / 86400000);
  const weekday = WEEKDAYS[d.getDay()].replace(/^./, (c) => c.toUpperCase());
  if (diff > 0 && diff < 7) return weekday;
  if (diff === 7) return `next ${weekday}`;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

// Match a spoken reference ("the dentist one", "task_ab12cd34") to an item.
function findByName(items, ref, key) {
  if (!ref) return null;
  const q = String(ref).toLowerCase().trim();
  const exact = items.find((i) => i.id === ref || i[key].toLowerCase() === q);
  if (exact) return exact;
  const words = q.split(/\W+/).filter((w) => w.length > 2 && !['the', 'task', 'habit', 'goal', 'my', 'one', 'for'].includes(w));
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const name = item[key].toLowerCase();
    let score = name.includes(q) || q.includes(name) ? 10 : 0;
    for (const w of words) if (name.includes(w)) score += w.length;
    if (score > bestScore) [best, bestScore] = [item, score];
  }
  return best;
}

export function streak(log) {
  const days = new Set(log);
  let d = days.has(today()) ? today() : addDays(today(), -1);
  let n = 0;
  while (days.has(d)) {
    n += 1;
    d = addDays(d, -1);
  }
  return n;
}

const list = (arr) => (arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} and ${arr.at(-1)}`);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const notFound = (kind, ref) => ({ speech: `I couldn't find a ${kind} matching "${ref}".`, data: { found: false } , isError: true });

function openTasks(db) {
  return db.tasks.filter((t) => t.status === 'open');
}

// ---------- tool definitions ----------

const speechOutput = (props = {}) => ({
  type: 'object',
  properties: { speech: { type: 'string', description: 'Voice-ready response' }, ...props },
  required: ['speech'],
});

const taskRef = { type: 'string', description: 'Task id or a few words from its title, e.g. "dentist"' };

export const tools = [
  {
    name: 'get_daily_briefing',
    title: 'Daily briefing',
    description: "Summarize the user's day in LifeOS: tasks due and overdue, habits still to do, streaks, mood trend and the closest goal. Use for 'how's my day', 'good morning', 'what's on my plate'.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: speechOutput({ dueToday: { type: 'array' }, overdue: { type: 'array' }, habitsPending: { type: 'array' } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler() {
      const db = load();
      const t = today();
      const open = openTasks(db);
      const dueToday = open.filter((x) => x.due === t);
      const overdue = open.filter((x) => x.due && x.due < t);
      const pending = db.habits.filter((h) => !h.log.includes(t));
      const best = [...db.habits].sort((a, b) => streak(b.log) - streak(a.log))[0];
      const goal = [...db.goals].sort((a, b) => a.target.localeCompare(b.target))[0];
      const hour = new Date().getHours();
      const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

      const parts = [`${greet}, ${db.profile.name}.`];
      if (dueToday.length) {
        const high = dueToday.filter((x) => x.priority === 'high');
        parts.push(`You have ${plural(dueToday.length, 'task')} due today${high.length ? `, and the big one is ${high[0].title}` : `: ${list(dueToday.map((x) => x.title))}`}.`);
      } else parts.push('Nothing is due today.');
      if (overdue.length) parts.push(`${plural(overdue.length, 'task')} ${overdue.length === 1 ? 'is' : 'are'} overdue, including ${overdue[0].title}.`);
      if (pending.length) parts.push(`Still to do: ${list(pending.map((h) => h.name.toLowerCase()))}.`);
      if (best && streak(best.log) >= 3) parts.push(`Your ${best.name.toLowerCase()} streak is at ${streak(best.log)} days — keep it going.`);
      if (goal) parts.push(`${goal.title} is ${goal.progress}% done.`);

      return {
        speech: parts.join(' '),
        data: {
          date: t,
          dueToday: dueToday.map(({ id, title, priority }) => ({ id, title, priority })),
          overdue: overdue.map(({ id, title, due }) => ({ id, title, due })),
          habitsPending: pending.map((h) => h.name),
          topStreak: best ? { habit: best.name, days: streak(best.log) } : null,
          nextGoal: goal || null,
        },
      };
    },
  },
  {
    name: 'add_task',
    title: 'Add task',
    description: 'Add a task or reminder to LifeOS. Use for "remind me to…", "add a task…", "I need to…".',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What needs doing, in a few words' },
        due: { type: 'string', description: 'When it is due: ISO date (YYYY-MM-DD) or words like "today", "tomorrow", "friday", "in 3 days"' },
        priority: { type: 'string', enum: PRIORITIES, description: 'Defaults to medium' },
        area: { type: 'string', description: 'Life area, e.g. work, health, family, finance, home, personal' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    outputSchema: speechOutput({ task: { type: 'object' } }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler({ title, due, priority = 'medium', area = 'personal' }) {
      if (!title?.trim()) return { speech: 'What should the task be called?', data: {}, isError: true };
      const dueDate = parseDate(due);
      const task = { id: newId('task'), title: title.trim().replace(/^./, (c) => c.toUpperCase()), area, priority: PRIORITIES.includes(priority) ? priority : 'medium', due: dueDate, status: 'open', createdAt: today() };
      mutate((db) => db.tasks.push(task));
      return { speech: `Added "${task.title}"${dueDate ? ` for ${spokenDate(dueDate)}` : ''}.`, data: { task } };
    },
  },
  {
    name: 'list_tasks',
    title: 'List tasks',
    description: 'List open tasks. Filter by when (today, overdue, upcoming, all) and optionally by life area.',
    inputSchema: {
      type: 'object',
      properties: {
        when: { type: 'string', enum: ['today', 'overdue', 'upcoming', 'all'], description: 'Defaults to today (includes overdue)' },
        area: { type: 'string' },
      },
      additionalProperties: false,
    },
    outputSchema: speechOutput({ tasks: { type: 'array' } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler({ when = 'today', area } = {}) {
      const t = today();
      let tasks = openTasks(load());
      if (area) tasks = tasks.filter((x) => x.area?.toLowerCase() === area.toLowerCase());
      if (when === 'today') tasks = tasks.filter((x) => x.due && x.due <= t);
      if (when === 'overdue') tasks = tasks.filter((x) => x.due && x.due < t);
      if (when === 'upcoming') tasks = tasks.filter((x) => !x.due || x.due > t);
      tasks.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority));
      const label = { today: 'for today', overdue: 'overdue', upcoming: 'coming up', all: 'open' }[when];
      const speech = tasks.length
        ? `You have ${plural(tasks.length, 'task')} ${label}: ${list(tasks.slice(0, 5).map((x) => `${x.title}${when !== 'today' && x.due ? ` (${spokenDate(x.due)})` : ''}`))}${tasks.length > 5 ? ', and more' : ''}.`
        : `You have no tasks ${label}. Nice.`;
      return { speech, data: { tasks } };
    },
  },
  {
    name: 'complete_task',
    title: 'Complete task',
    description: 'Mark a task as done. Accepts the task id or words from its title.',
    inputSchema: { type: 'object', properties: { task: taskRef }, required: ['task'], additionalProperties: false },
    outputSchema: speechOutput({ task: { type: 'object' }, remainingToday: { type: 'number' } }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler({ task: ref }) {
      const task = findByName(openTasks(load()), ref, 'title');
      if (!task) return notFound('task', ref);
      const remaining = mutate((db) => {
        const tk = db.tasks.find((x) => x.id === task.id);
        tk.status = 'done';
        tk.completedAt = today();
        return openTasks(db).filter((x) => x.due && x.due <= today()).length;
      });
      return {
        speech: `Done — "${task.title}" is checked off. ${remaining ? `${plural(remaining, 'task')} left for today.` : "That's everything for today!"}`,
        data: { task: { ...task, status: 'done' }, remainingToday: remaining },
      };
    },
  },
  {
    name: 'reschedule_task',
    title: 'Reschedule task',
    description: 'Move a task to a new due date.',
    inputSchema: {
      type: 'object',
      properties: { task: taskRef, due: { type: 'string', description: 'New due date: ISO date or words like "tomorrow", "monday"' } },
      required: ['task', 'due'],
      additionalProperties: false,
    },
    outputSchema: speechOutput({ task: { type: 'object' } }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler({ task: ref, due }) {
      const task = findByName(openTasks(load()), ref, 'title');
      if (!task) return notFound('task', ref);
      const dueDate = parseDate(due);
      if (!dueDate) return { speech: `I didn't understand the date "${due}".`, data: {}, isError: true };
      mutate((db) => (db.tasks.find((x) => x.id === task.id).due = dueDate));
      return { speech: `Moved "${task.title}" to ${spokenDate(dueDate)}.`, data: { task: { ...task, due: dueDate } } };
    },
  },
  {
    name: 'delete_task',
    title: 'Delete task',
    description: 'Permanently delete a task. Only use when the user explicitly asks to delete or remove it.',
    inputSchema: { type: 'object', properties: { task: taskRef }, required: ['task'], additionalProperties: false },
    outputSchema: speechOutput({ deleted: { type: 'object' } }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    handler({ task: ref }) {
      const task = findByName(load().tasks, ref, 'title');
      if (!task) return notFound('task', ref);
      mutate((db) => (db.tasks = db.tasks.filter((x) => x.id !== task.id)));
      return { speech: `Deleted "${task.title}".`, data: { deleted: task } };
    },
  },
  {
    name: 'log_habit',
    title: 'Log habit',
    description: 'Record that the user did a habit (e.g. meditate, workout, read). Returns the updated streak.',
    inputSchema: {
      type: 'object',
      properties: {
        habit: { type: 'string', description: 'Habit name, e.g. "workout"' },
        date: { type: 'string', description: 'Defaults to today; also accepts "yesterday"' },
      },
      required: ['habit'],
      additionalProperties: false,
    },
    outputSchema: speechOutput({ habit: { type: 'string' }, streak: { type: 'number' } }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler({ habit: ref, date }) {
      const habit = findByName(load().habits, ref, 'name');
      if (!habit) return { ...notFound('habit', ref), speech: `You don't have a habit called "${ref}" yet. Want me to create it?` };
      const day = parseDate(date) || today();
      const s = mutate((db) => {
        const h = db.habits.find((x) => x.id === habit.id);
        if (!h.log.includes(day)) h.log.push(day);
        return streak(h.log);
      });
      const cheer = s >= 7 ? "That's a full week — impressive!" : s >= 3 ? 'Nice consistency.' : 'Good start.';
      return { speech: `Logged ${habit.name.toLowerCase()}. You're on a ${s}-day streak. ${cheer}`, data: { habit: habit.name, date: day, streak: s } };
    },
  },
  {
    name: 'get_habits',
    title: 'Habit tracker',
    description: "Get the user's habits with current streaks and whether each is done today.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: speechOutput({ habits: { type: 'array' } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler() {
      const habits = load().habits.map((h) => ({ name: h.name, streak: streak(h.log), doneToday: h.log.includes(today()) }));
      const done = habits.filter((h) => h.doneToday);
      const speech = `${done.length} of ${habits.length} habits done today. ` + habits.map((h) => `${h.name}: ${h.streak}-day streak${h.doneToday ? '' : ', not yet today'}`).join('. ') + '.';
      return { speech, data: { habits } };
    },
  },
  {
    name: 'create_habit',
    title: 'Create habit',
    description: 'Start tracking a new daily habit.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
    outputSchema: speechOutput({ habit: { type: 'object' } }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler({ name }) {
      const clean = name.trim().replace(/^./, (c) => c.toUpperCase());
      const habit = { id: newId('habit'), name: clean, frequency: 'daily', log: [] };
      mutate((db) => db.habits.push(habit));
      return { speech: `Now tracking "${clean}" every day. Tell me whenever you do it.`, data: { habit } };
    },
  },
  {
    name: 'log_mood',
    title: 'Log mood',
    description: "Check in the user's mood on a 1–5 scale (1 rough, 3 okay, 5 great), with an optional note.",
    inputSchema: {
      type: 'object',
      properties: {
        score: { type: 'integer', minimum: 1, maximum: 5 },
        note: { type: 'string', description: 'Why they feel this way, in their words' },
      },
      required: ['score'],
      additionalProperties: false,
    },
    outputSchema: speechOutput({ score: { type: 'number' }, weekAverage: { type: 'number' } }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler({ score, note }) {
      const s = Math.min(5, Math.max(1, Math.round(Number(score) || 3)));
      const avg = mutate((db) => {
        db.moods = db.moods.filter((m) => m.date !== today());
        db.moods.push({ date: today(), score: s, note: note || '' });
        const week = db.moods.filter((m) => m.date > addDays(today(), -7));
        return Math.round((week.reduce((a, m) => a + m.score, 0) / week.length) * 10) / 10;
      });
      const reply = s <= 2 ? "I'm sorry it's a tough one. Be kind to yourself — maybe a short walk or an early night." : s === 3 ? 'Thanks for checking in.' : 'Love to hear it!';
      return { speech: `Logged your mood as ${MOOD_WORDS[s]}. ${reply} Your 7-day average is ${avg} out of 5.`, data: { score: s, note: note || '', weekAverage: avg } };
    },
  },
  {
    name: 'add_journal_entry',
    title: 'Journal',
    description: 'Save a journal entry or note-to-self in the user\'s own words.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    outputSchema: speechOutput({ entry: { type: 'object' }, totalEntries: { type: 'number' } }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler({ text }) {
      const entry = { id: newId('note'), date: today(), text: text.trim() };
      const total = mutate((db) => db.journal.push(entry));
      return { speech: `Saved to your journal. That's entry number ${total}.`, data: { entry, totalEntries: total } };
    },
  },
  {
    name: 'get_goals',
    title: 'Goals',
    description: "Get the user's goals with progress percentage and target dates.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: speechOutput({ goals: { type: 'array' } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler() {
      const goals = load().goals;
      return { speech: `You have ${plural(goals.length, 'goal')}. ` + goals.map((g) => `${g.title} is ${g.progress}% done, target ${spokenDate(g.target)}`).join('. ') + '.', data: { goals } };
    },
  },
  {
    name: 'update_goal_progress',
    title: 'Update goal',
    description: 'Set a goal\'s progress (0–100) or nudge it by a delta, e.g. +10.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Goal id or words from its title' },
        progress: { type: 'integer', minimum: 0, maximum: 100, description: 'New absolute progress percentage' },
        delta: { type: 'integer', minimum: -100, maximum: 100, description: 'Relative change, e.g. 10 for +10%' },
      },
      required: ['goal'],
      additionalProperties: false,
    },
    outputSchema: speechOutput({ goal: { type: 'object' } }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler({ goal: ref, progress, delta }) {
      const goal = findByName(load().goals, ref, 'title');
      if (!goal) return notFound('goal', ref);
      const next = Math.min(100, Math.max(0, progress ?? goal.progress + (delta ?? 10)));
      mutate((db) => (db.goals.find((g) => g.id === goal.id).progress = next));
      return { speech: next === 100 ? `🎉 ${goal.title} is complete! Huge.` : `${goal.title} is now ${next}% done.`, data: { goal: { ...goal, progress: next } } };
    },
  },
  {
    name: 'weekly_review',
    title: 'Weekly review',
    description: 'Review the last 7 days: tasks completed, habit consistency, mood average, and a suggestion for next week.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: speechOutput({ tasksCompleted: { type: 'number' }, habitRate: { type: 'number' }, moodAverage: { type: ['number', 'null'] } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler() {
      const db = load();
      const since = addDays(today(), -7);
      const done = db.tasks.filter((t) => t.status === 'done' && t.completedAt > since).length;
      const possible = db.habits.length * 7;
      const hits = db.habits.reduce((a, h) => a + h.log.filter((d) => d > since).length, 0);
      const rate = possible ? Math.round((hits / possible) * 100) : 0;
      const moods = db.moods.filter((m) => m.date > since);
      const moodAvg = moods.length ? Math.round((moods.reduce((a, m) => a + m.score, 0) / moods.length) * 10) / 10 : null;
      const weakest = [...db.habits].sort((a, b) => a.log.filter((d) => d > since).length - b.log.filter((d) => d > since).length)[0];
      const speech = `This week you completed ${plural(done, 'task')}, hit your habits ${rate}% of the time${moodAvg ? `, and your mood averaged ${moodAvg} out of 5` : ''}. ` + (weakest ? `For next week, try focusing on ${weakest.name.toLowerCase()}.` : '');
      return { speech, data: { tasksCompleted: done, habitRate: rate, moodAverage: moodAvg, focus: weakest?.name || null } };
    },
  },
];

export const toolMap = new Map(tools.map((t) => [t.name, t]));

// ---------- resources & prompts ----------

export const resources = [
  { uri: 'lifeos://today', name: 'today', title: "Today's briefing", description: 'Daily briefing data as JSON', mimeType: 'application/json' },
  { uri: 'lifeos://tasks', name: 'tasks', title: 'All tasks', description: 'Every task in LifeOS', mimeType: 'application/json' },
  { uri: 'lifeos://habits', name: 'habits', title: 'Habits', description: 'Habits with streaks', mimeType: 'application/json' },
];

export function readResource(uri) {
  const db = load();
  const body = {
    'lifeos://today': () => toolMap.get('get_daily_briefing').handler().data,
    'lifeos://tasks': () => db.tasks,
    'lifeos://habits': () => toolMap.get('get_habits').handler().data.habits,
  }[uri];
  return body ? JSON.stringify(body(), null, 2) : null;
}

export const prompts = [
  { name: 'plan_my_day', title: 'Plan my day', description: 'Turn today\'s LifeOS data into a short, prioritized plan.' },
  { name: 'evening_reflection', title: 'Evening reflection', description: 'Guide a short end-of-day check-in: mood, wins, journal.', arguments: [{ name: 'win', description: 'One thing that went well', required: false }] },
];

export function getPrompt(name, args = {}) {
  if (name === 'plan_my_day') {
    return {
      description: 'Plan my day',
      messages: [{ role: 'user', content: { type: 'text', text: `Here is my LifeOS data for today:\n${readResource('lifeos://today')}\n\nGive me a 3-step plan for today, most important first. Keep it short enough to say out loud.` } }],
    };
  }
  if (name === 'evening_reflection') {
    return {
      description: 'Evening reflection',
      messages: [{ role: 'user', content: { type: 'text', text: `Run my evening reflection. ${args.win ? `Today's win: ${args.win}. ` : ''}Ask how I'm feeling (1–5) and log it with log_mood, then offer to save a journal entry with add_journal_entry.` } }],
    };
  }
  return null;
}
