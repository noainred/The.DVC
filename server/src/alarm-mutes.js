/**
 * Alarm mute rules — "ignore this kind of alarm from now on". A rule matches by
 * entity type + a message template (digits normalized to '#') so e.g. clicking
 * "Datastore usage at 97%" mutes all "Datastore usage at NN%". Optionally scoped
 * to one vCenter. Stored in CONFIG_DIR/alarm-mutes.json.
 */

import fs from 'node:fs';
import { atomicWriteFileSync, preserveCorrupt } from './util/atomicWrite.js';
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
  } catch (e) {
    // v2.447(감사 B4): 조용히 [] 를 돌려주면 **모든 뮤트가 풀려** 무시하기로 한 알람이 다시 쏟아지고,
    // 다음 save() 가 규칙 1개짜리 파일로 덮어써 기존 규칙이 영구 유실된다. 원본을 보존하고 경고를 남긴다.
    preserveCorrupt(FILE, e.message);
    console.warn(`[alarm-mutes] 파일이 손상돼 뮤트 규칙을 읽지 못했습니다 — 원본을 보존했습니다: ${e.message}`);
    return [];
  }
}

function save(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  // v2.447(감사 B4): 원자적 쓰기 — 쓰기 도중 크래시/정전으로 잘린 JSON 이 남으면 위 loadMutes 가
  // 빈 목록으로 폴백해 뮤트가 전부 풀린다(다른 설정 파일들은 전부 atomicWriteFileSync 를 쓴다).
  atomicWriteFileSync(FILE, JSON.stringify({ mutes: list }, null, 2), { mode: 0o600 });
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
