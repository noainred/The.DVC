/**
 * Alarm mute rules — "ignore this kind of alarm from now on". A rule matches by
 * entity type + a message template (digits normalized to '#') so e.g. clicking
 * "Datastore usage at 97%" mutes all "Datastore usage at NN%". Optionally scoped
 * to one vCenter. Stored in CONFIG_DIR/alarm-mutes.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const FILE = path.join(config.configDir, 'alarm-mutes.json');

/** Normalize an alarm message into a template (numbers → #). */
export function alarmTemplate(message) {
  return String(message || '').replace(/\d+/g, '#').trim();
}

export function loadMutes() {
  if (!fs.existsSync(FILE)) return [];
  try {
    const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(p?.mutes) ? p.mutes : [];
  } catch { return []; }
}

function save(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ mutes: list }, null, 2), { mode: 0o600 });
}

/** Add a mute rule derived from an alarm. Body: { entityType, message, vcenterId?, scope } */
export function addMute(body) {
  const message = String(body.message || '').trim();
  if (!message) return { ok: false, reason: '메시지가 필요합니다.' };
  const entityType = String(body.entityType || '').trim();
  const template = alarmTemplate(message);
  // scope: 'all' (every vCenter) or 'vcenter' (only the originating vCenter)
  const vcenterId = body.scope === 'vcenter' ? (body.vcenterId || '') : '';
  const list = loadMutes();
  const id = `${entityType}|${template}|${vcenterId}`;
  if (list.some((m) => m.id === id)) return { ok: true, already: true, mute: list.find((m) => m.id === id) };
  const mute = { id, entityType, template, sample: message, vcenterId, createdAt: Date.now() };
  list.push(mute);
  save(list);
  return { ok: true, mute };
}

export function removeMute(id) {
  const list = loadMutes();
  const next = list.filter((m) => m.id !== id);
  if (next.length === list.length) return { ok: false, reason: '없는 규칙' };
  save(next);
  return { ok: true };
}

export function listMutes() {
  return loadMutes();
}

/** Does any rule mute this alarm? */
export function isMuted(alarm, mutes = loadMutes()) {
  if (!mutes.length) return false;
  const tpl = alarmTemplate(alarm.message);
  return mutes.some((m) =>
    m.template === tpl &&
    (!m.entityType || m.entityType === alarm.entityType) &&
    (!m.vcenterId || m.vcenterId === alarm.vcenterId));
}

/** Remove muted alarms from a list. */
export function applyMutes(alarms) {
  const mutes = loadMutes();
  if (!mutes.length) return alarms;
  return alarms.filter((a) => !isMuted(a, mutes));
}
