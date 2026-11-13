/**
 * IP 변화 기록(vNEXT — 설계 docs/design/ipam-alerts-mac-dns ① ② · IP관리 › IP 변화 페이지).
 *
 * 스캔이 본 변화(새 미등록 IP · 예약 · 폐기 IP 사용 시작 · 호스트명 변경 · MAC 변경 · 충돌 의심 발생/해소 · 기준선)를 **알림과 무관하게** 남긴다 —
 *   알림을 끈 종류 · '알리지 않을 에이전트' 의 변화도 기록한다(보드 ③-8). 알림 결과는 항목의 `notify` 칸이 말한다.
 *
 * 저장: CONFIG_DIR/ipam-changes.json(상태 파일 — 배열 · 최근 CHANGE_LOG_MAX 건 · CHANGE_LOG_MAX_AGE_MS 보다 오래된 것은 지운다).
 *   쓰기는 디바운스(2초)로 묶은 원자 쓰기 + 종료 시 flush. 손상 파일은 보존하고 빈 기록으로 시작한다(조용한 덮어쓰기 금지).
 * 범위: 스캔 결과처럼 vCenter 귀속이 없다 — 라우트가 관리자 · 전 법인 계정에만 연다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { registerExitFlush } from '../util/exitFlush.js';
import { numOrNull } from '../util/numOrNull.js';

export const CHANGE_TYPES = Object.freeze(['conflict', 'conflict-resolved', 'mac-change', 'new-ip', 'reserved-up', 'rename', 'baseline']);
/** 알림 결과: sent(보냄) · failed(보내지 못함) · off(규칙 꺼짐) · quiet(알리지 않을 에이전트) · excluded(그 IP 는 MAC 변경 알림 제외) ·
 *  flap(두 MAC 사이 오감 — 처음 한 번만) · summary(묶음 상한 초과 — 요약 한 건으로) · engine(상태형 — 알림 엔진이 보낸다) · none(알림 대상 아님) */
export const NOTIFY_STATES = Object.freeze(['sent', 'failed', 'off', 'quiet', 'excluded', 'flap', 'summary', 'engine', 'none', 'skipped']);
export const CHANGE_LOG_MAX = 5000;
export const CHANGE_LOG_MAX_AGE_MS = 180 * 86_400_000;
const FILE = () => path.join(config.configDir, 'ipam-changes.json'); // 리터럴 — scripts/config-doc.mjs 가 이 형태만 읽는다
registerStateFile('ipam-changes.json');

let buf = null;
let seq = 0;
let timer = null;
let dirty = false;

function load() {
  if (buf) return buf;
  const file = FILE();
  buf = [];
  if (!fs.existsSync(file)) return buf;
  try {
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(a)) throw new Error('배열이 아닌 JSON 값');
    buf = a.filter((e) => e && typeof e === 'object' && CHANGE_TYPES.includes(e.type)).slice(-CHANGE_LOG_MAX);
  } catch (e) {
    preserveCorrupt(file, e?.message || String(e));
    buf = [];
  }
  for (const e of buf) { const n = numOrNull(e.id); if (n != null && n > seq) seq = n; }
  return buf;
}
function writeNow() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!buf || !dirty) return;
  dirty = false;
  try { atomicWriteFileSync(FILE(), JSON.stringify(buf), { mode: 0o600 }); } catch (e) { dirty = true; console.warn(`[ipam] IP 변화 기록을 쓰지 못했습니다: ${e?.message || e}`); }
}
function markDirty() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => { timer = null; writeNow(); }, 2_000);
  timer.unref?.();
}
registerExitFlush('ipam/ipam-changes.json', writeNow);

const str = (v, max = 200) => (v == null ? '' : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max));
const strList = (v, n = 6) => (Array.isArray(v) ? v.map((x) => str(x, 32)).filter(Boolean).slice(0, n) : []);

/** 들어온 항목을 아는 칸만으로 좁힌다(순수 — 모르는 type 은 null). */
export function cleanChange(c, ts) {
  if (!c || typeof c !== 'object' || !CHANGE_TYPES.includes(c.type)) return null;
  const out = { ts: numOrNull(c.ts) ?? ts ?? Date.now(), type: c.type, ip: str(c.ip, 45), agent: str(c.agent, 64) };
  for (const k of ['from', 'to', 'src', 'mac', 'status', 'spec', 'vendor', 'fromVendor', 'vm', 'vcenterId', 'note']) if (c[k] != null && c[k] !== '') out[k] = str(c[k]);
  if (Array.isArray(c.services) && c.services.length) out.services = strList(c.services);
  if (c.flap === true) out.flap = true;
  out.notify = NOTIFY_STATES.includes(c.notify) ? c.notify : 'none';
  return out;
}

/** 여러 건을 한 번에 남긴다. 새 항목(아이디 포함)을 돌려준다 — 알림 결과는 나중에 setNotify 로 고친다. */
export function appendChanges(list, ts = Date.now()) {
  const b = load();
  const added = [];
  for (const c of Array.isArray(list) ? list : []) {
    const e = cleanChange(c, ts);
    if (!e) continue;
    e.id = ++seq;
    b.push(e); added.push(e);
  }
  if (!added.length) return added;
  const cut = Date.now() - CHANGE_LOG_MAX_AGE_MS;
  let drop = 0;
  while (drop < b.length && (b[drop].ts || 0) < cut) drop++;
  if (b.length - drop > CHANGE_LOG_MAX) drop = b.length - CHANGE_LOG_MAX;
  if (drop > 0) b.splice(0, drop);
  markDirty();
  return added;
}
/** 남긴 항목들의 알림 결과를 고친다(같은 묶음이 보낸 결과). */
export function setNotify(entries, state) {
  if (!NOTIFY_STATES.includes(state)) return;
  let n = 0;
  for (const e of Array.isArray(entries) ? entries : []) if (e && typeof e === 'object') { e.notify = state; n++; }
  if (n) markDirty();
}

/**
 * 최근 기록(최신이 먼저). 필터: type · ip(정확히) · agent(대소문자 무시). 종류별 개수(필터 전 — 칩)와 상한을 싣는다(조용한 상한 금지).
 */
export function listChanges({ type = '', ip = '', agent = '', limit = 500 } = {}) {
  const all = load();
  const t = CHANGE_TYPES.includes(type) ? type : '';
  const ipq = String(ip || '').trim();
  const ag = String(agent || '').trim().toLowerCase();
  const counts = Object.fromEntries(CHANGE_TYPES.map((k) => [k, 0]));
  const rows = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    counts[e.type] = (counts[e.type] || 0) + 1;
    if (t && e.type !== t) continue;
    if (ipq && e.ip !== ipq) continue;
    if (ag && String(e.agent || '').toLowerCase() !== ag) continue;
    rows.push(e);
  }
  const n = Math.max(1, Math.min(CHANGE_LOG_MAX, Math.floor(numOrNull(limit) ?? 500)));
  return { entries: rows.slice(0, n).map((e) => ({ ...e })), matched: rows.length, total: all.length, counts, max: CHANGE_LOG_MAX, maxAgeDays: CHANGE_LOG_MAX_AGE_MS / 86_400_000, truncated: rows.length > n };
}

export function _resetChangeLogForTest() { writeNow(); buf = null; seq = 0; dirty = false; }
export function _flushChangeLogForTest() { writeNow(); }
