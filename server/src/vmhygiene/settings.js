/**
 * vmhygiene/settings.js — VM 구성 점검·스냅샷 정책 설정(`vm-hygiene.json`, v2.698). 사람이 정하는 **설정** 파일이다
 * (백업 '설정 변경' 감시 대상 · 비밀 없음). 손상이면 보존하고 기본값으로 시작한다(조용한 빈값 금지 — v2.580 규약).
 *
 * 모양: { snapAgeDays, snapCount, snapSizeGB, uptimeDays, exceptions:[문자열], notify:{ enabled, hour } }
 *  · 숫자 칸의 빈 값·글자는 **미지정**(이전 값 유지) — `Number('')===0` 이 '0일 넘은 스냅샷 = 전부' 가 되지 않게(v2.583 규약).
 *  · exceptions: VM 이름·메모에 이 글자가 들어 있으면 스냅샷 정책 판정에서 뺀다(뺀 개수는 화면이 밝힌다). 대소문자 무시.
 *  · notify: 하루 한 번(한국 시각 hour 시 이후 첫 확인) 스냅샷 정책 위반 요약을 알림 채널로 보낸다. 기본 꺼짐.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { numOrNull } from '../util/numOrNull.js';

export const SETTINGS_FILE_NAME = 'vm-hygiene.json';
const FILE = () => path.join(config.configDir, 'vm-hygiene.json');
export const DEFAULTS = Object.freeze({ snapAgeDays: 7, snapCount: 3, snapSizeGB: 100, uptimeDays: 365, exceptions: [], notify: { enabled: false, hour: 9 } });
export const RANGES = Object.freeze({ snapAgeDays: [1, 3650], snapCount: [1, 100], snapSizeGB: [1, 100_000], uptimeDays: [7, 3650] });
export const EXCEPTIONS_MAX = 200;
const EXC_LEN_MAX = 64;

let cache = null;
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const revOf = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 10);

function clampNum(raw, key, prev) {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return prev;
  const n = numOrNull(raw);
  if (n == null) return prev;
  const [lo, hi] = RANGES[key];
  return Math.min(hi, Math.max(lo, Math.round(n)));
}
function normExceptions(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().slice(0, EXC_LEN_MAX);
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length >= EXCEPTIONS_MAX) break;
  }
  return out;
}

/** 패치 적용(순수) — 모르는 키는 버리고, 빈 숫자 칸은 이전 값. */
export function applyPatch(cur, body = {}) {
  const b = isObj(body) ? body : {};
  const next = { ...cur, notify: { ...cur.notify } };
  for (const k of Object.keys(RANGES)) if (Object.hasOwn(b, k)) next[k] = clampNum(b[k], k, cur[k]);
  if (Object.hasOwn(b, 'exceptions')) { const e = normExceptions(b.exceptions); if (e) next.exceptions = e; }
  if (isObj(b.notify)) {
    if (typeof b.notify.enabled === 'boolean') next.notify.enabled = b.notify.enabled;
    if (Object.hasOwn(b.notify, 'hour')) {
      const h = numOrNull(b.notify.hour);
      if (h != null && h >= 0 && h <= 23) next.notify.hour = Math.trunc(h);
    }
  }
  return next;
}

let _readWarned = false;   // 69회차 F4: 읽기 오류 경고는 상태가 바뀔 때 한 번
export function loadVmHygieneSettings() {
  if (cache) return cache;
  let base = { ...DEFAULTS, notify: { ...DEFAULTS.notify } };
  const file = FILE();
  // 69회차 F4(재현 — cost/settings.js 와 같은 꼴): 읽기 오류는 손상이 아니다 — 원본을 옮기지 않고 기본값을 캐시하지 않으며(다음 호출에서 다시 읽는다)
  //   unreadable 로 밝힌다. 저장은 거절하고 알림은 보내지 않는다(예전에는 원본을 .corrupt 로 옮겨 알림 · 예외 · 기준이 영구히 기본값으로 돌아갔다).
  let raw = null;
  if (fs.existsSync(file)) {
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (!_readWarned) { _readWarned = true; console.warn(`[vm-hygiene] 설정 파일을 읽지 못했습니다(파일은 그대로 둡니다 — 다시 읽을 때까지 기본값 · 저장 거절 · 알림 보류): ${safeLoadText(e) || '사유 미상'}`); }
      const { updatedAt: _a, updatedBy: _b, ...core0 } = base;
      return { ...core0, updatedAt: null, updatedBy: null, unreadable: true, rev: 'unreadable' };
    }
  }
  _readWarned = false;
  try {
    if (raw != null) {
      const p = JSON.parse(raw);
      if (!isObj(p)) throw new Error('객체가 아닙니다');
      base = applyPatch(base, p);
      if (typeof p.updatedAt === 'number') base.updatedAt = p.updatedAt;
      if (typeof p.updatedBy === 'string') base.updatedBy = p.updatedBy.slice(0, 128);
    }
  } catch (e) {
    preserveCorrupt(file, e?.message);
    console.warn(`[vm-hygiene] 설정 파일을 읽지 못했습니다 — 원본을 .corrupt 로 보존하고 기본값으로 시작합니다: ${safeLoadText(e) || '사유 미상'}`);
  }
  const { updatedAt = null, updatedBy = null, ...core } = base;
  cache = { ...core, updatedAt, updatedBy, rev: revOf(core) };
  return cache;
}

export function saveVmHygieneSettings(body, user) {
  const cur = loadVmHygieneSettings();
  if (cur.unreadable) throw new Error('VM 구성 점검 설정 파일을 읽지 못해 저장하지 않습니다 — 파일을 확인한 뒤 다시 저장하세요(읽지 못한 값 위에 덮어쓰지 않습니다)');
  const { rev, updatedAt, updatedBy, unreadable, ...core } = cur;
  const next = applyPatch(core, body);
  const out = { ...next, updatedAt: Date.now(), updatedBy: user ? String(user).slice(0, 128) : null };
  atomicWriteFileSync(FILE(), JSON.stringify(out, null, 2));
  cache = null;
  return loadVmHygieneSettings();
}

export function _resetVmHygieneSettings() { cache = null; }
