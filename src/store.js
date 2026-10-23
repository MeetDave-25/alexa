// LifeOS data store: a single JSON file on disk. Small, inspectable, and easy to
// swap for a real database later — every read/write goes through this module.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_FILE = resolve(process.env.LIFEOS_DATA_FILE || 'data/lifeos.json');

export const today = () => isoDate(new Date());

export function isoDate(d) {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

export const newId = (prefix) => `${prefix}_${randomUUID().slice(0, 8)}`;

function seed() {
  const t = today();
  const doneDays = (n) => Array.from({ length: n }, (_, i) => addDays(t, -(i + 1)));
  return {
    profile: { name: process.env.LIFEOS_USER_NAME || 'Alex', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    tasks: [
      { id: newId('task'), title: 'Submit Alexa+ hackathon demo', area: 'work', priority: 'high', due: t, status: 'open', createdAt: t },
      { id: newId('task'), title: 'Call mom', area: 'family', priority: 'medium', due: t, status: 'open', createdAt: t },
      { id: newId('task'), title: 'Book dentist appointment', area: 'health', priority: 'low', due: addDays(t, 2), status: 'open', createdAt: t },
      { id: newId('task'), title: 'Review monthly budget', area: 'finance', priority: 'medium', due: addDays(t, -1), status: 'open', createdAt: addDays(t, -3) },
      { id: newId('task'), title: 'Draft LifeOS landing page', area: 'work', priority: 'medium', due: addDays(t, 5), status: 'open', createdAt: t },
      { id: newId('task'), title: 'Design MCP tool schema', area: 'work', priority: 'high', due: addDays(t, -2), status: 'done', createdAt: addDays(t, -5), completedAt: addDays(t, -2) },
      { id: newId('task'), title: 'Grocery run', area: 'home', priority: 'low', due: addDays(t, -1), status: 'done', createdAt: addDays(t, -2), completedAt: addDays(t, -1) },
    ],
    habits: [
      { id: newId('habit'), name: 'Meditate', frequency: 'daily', log: doneDays(6) },
      { id: newId('habit'), name: 'Workout', frequency: 'daily', log: doneDays(3) },
      { id: newId('habit'), name: 'Read', frequency: 'daily', log: [addDays(t, -1), addDays(t, -2), addDays(t, -4)] },
      { id: newId('habit'), name: 'Drink water', frequency: 'daily', log: doneDays(12) },
    ],
    goals: [
      { id: newId('goal'), title: 'Ship LifeOS MVP', area: 'work', progress: 70, target: addDays(t, 14) },
      { id: newId('goal'), title: 'Run a 10K', area: 'health', progress: 40, target: addDays(t, 60) },
      { id: newId('goal'), title: 'Save emergency fund', area: 'finance', progress: 55, target: addDays(t, 120) },
    ],
    moods: [
      { date: addDays(t, -3), score: 3, note: 'Busy day' },
      { date: addDays(t, -2), score: 4, note: 'Good workout' },
      { date: addDays(t, -1), score: 4, note: 'Productive' },
    ],
    journal: [
      { id: newId('note'), date: addDays(t, -1), text: 'Got the MCP handshake working. Feeling momentum.' },
    ],
  };
}

let cache = null;

export function load() {
  if (cache) return cache;
  if (existsSync(DATA_FILE)) {
    cache = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  } else {
    cache = seed();
    save();
  }
  return cache;
}

export function save() {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2));
}

export function reset() {
  cache = seed();
  save();
  return cache;
}

// Run a mutation and persist it.
export function mutate(fn) {
  const db = load();
  const result = fn(db);
  save();
  return result;
}
