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

/* ── 범위(scope) 판정 — 순수. 라우트가 auth/scope.js 의 Set(제한 없으면 null)을 넘긴다. ──
 *
 * v2.500(감사 M-1): 음소거는 '알람을 안 보이게 만드는' 상태변경이다. 규칙에 vcenterId 가 없으면
 * **전 vCenter** 에 적용되므로, 범위 제한 계정이 만들면 자기 범위 밖 사이트의 장애까지 가린다.
 * 조회 역시 규칙의 sample(알람 원문)·entityType 이 범위 밖 사이트의 자원명을 담을 수 있다.
 */

/** 생성 허용 판정. 반환: null(허용) 또는 거부 사유. allowed=null 이면 제한 없음. */
export function muteCreateIssue({ scope, vcenterId } = {}, allowed = null) {
  if (!allowed) return null;                                   // 전체 범위 계정 — 기존 동작 유지
  if (scope !== 'vcenter' || !vcenterId) return '범위가 제한된 계정은 특정 vCenter 규칙만 만들 수 있습니다(전 vCenter 음소거는 전체 범위 계정 전용).';
  if (!allowed.has(vcenterId)) return '수정 범위 밖의 vCenter 입니다.';
  return null;
}

/** 삭제 허용 판정. 전 vCenter 규칙(vcenterId 없음)은 전체 범위 계정만 지울 수 있다. */
export function muteDeleteIssue(mute, allowed = null) {
  if (!allowed) return null;
  if (!mute) return null;                                      // 없는 규칙 — 호출부가 404 로 처리
  if (!mute.vcenterId) return '전 vCenter 규칙은 전체 범위 계정만 삭제할 수 있습니다.';
  if (!allowed.has(mute.vcenterId)) return '수정 범위 밖의 vCenter 규칙입니다.';
  return null;
}

/**
 * 목록 가시성. 전 vCenter 규칙은 **그 사용자의 화면에도 실제로 적용되므로** 숨기지 않는다
 * (숨기면 "알람이 왜 안 보이지?" 를 설명할 수 없다). 범위 밖 특정 vCenter 규칙만 가린다.
 */
export function visibleMutes(mutes = [], allowed = null) {
  if (!allowed) return mutes;
  return mutes.filter((m) => !m.vcenterId || allowed.has(m.vcenterId));
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
