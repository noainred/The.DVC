/**
 * svcstatus/settings.js — 포탈 서비스 상태 모니터링 설정(v3.54). 파일: CONFIG_DIR/svc-status-settings.json.
 *
 * 읽기는 공용 로더(`util/jsonFileLoad.js` — 읽기 오류 ≠ 손상 · 30초 재읽기 · 오류 중 저장 409 · 서비스 점검 등재).
 * ⚠ **측정 제외 목록 · 알림 설정은 못 읽어도 풀지 않는다**: 이 프로세스가 한 번이라도 읽은 값(`_lastGood`)이 있으면 오류 동안 그 값으로 돈다
 *   (alarm-mutes.js 와 같은 판단 — 제외가 풀리면 뺀 대상이 합계 · 알림에 다시 들어가고, 알림이 기본값으로 떨어지면 받는 사람이 사라진다).
 *   처음부터 못 읽었으면 기본값이고, 그 사실은 GET 응답(loadError)과 서비스 점검이 말한다.
 * ⚠ 저장은 디스크 쓰기 성공 뒤에만 캐시 · 리스너(v2.733 C4-04) · 숫자 칸의 빈 값 · 숫자 아님은 '현재 값 유지'(v2.604 LEFT2604-02 — `Number('')===0`).
 */
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { makeJsonFileLoader } from '../util/jsonFileLoad.js';
import { numOrNull } from '../util/numOrNull.js';
import { clampSetting } from '../util/clampSetting.js';
import { normalizeAddresses } from '../util/smtp.js';

const FILE = () => path.join(config.configDir, 'svc-status-settings.json');

/** 화면 · 저장 범위(웹은 응답의 limits 로 검사한다 — 숫자를 박지 않는다). */
export const LIMITS = Object.freeze({
  intervalMs: Object.freeze({ min: 30_000, max: 3_600_000, def: 60_000 }),
  timeoutMs: Object.freeze({ min: 500, max: 15_000, def: 2_500 }),
  concurrency: Object.freeze({ min: 1, max: 64, def: 16 }),
  failThreshold: Object.freeze({ min: 1, max: 20, def: 3 }),
  slowFactor: Object.freeze({ min: 1.2, max: 20, def: 2 }),
  slowMinDeltaMs: Object.freeze({ min: 0, max: 10_000, def: 30 }),
  retentionDays: Object.freeze({ min: 8, max: 730, def: 90 }),
  unknownMin: Object.freeze({ min: 0, max: 1_440, def: 30 }),
});
export const KIND_KEYS = Object.freeze(['collector', 'vcenter', 'cvp', 'storage']);
export const EXCLUDED_MAX = 2_000;
export const ALERT_TO_MAX = 50;
const ID_MAX = 300;

const t = (v) => String(v ?? '').trim();
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v, l, round = true) => clampSetting(v, { min: l.min, max: l.max, def: l.def, round });

function normalizeExcluded(list) {
  const out = []; const seen = new Set();
  for (const x of Array.isArray(list) ? list : []) {
    if (!isObj(x)) continue;
    const id = t(x.id).slice(0, ID_MAX);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const at = numOrNull(x.at);
    out.push({ id, reason: t(x.reason).slice(0, 200), at: at != null && at > 0 ? Math.round(at) : null, by: t(x.by).slice(0, 64) });
    if (out.length >= EXCLUDED_MAX) break;
  }
  return out;
}

/** 입력(파일 · 화면) → 정규화된 설정. 모르는 키는 버린다. */
export function normalizeSettings(input = {}) {
  const s = isObj(input) ? input : {};
  const kinds = isObj(s.kinds) ? s.kinds : {};
  const al = isObj(s.alerts) ? s.alerts : {};
  return {
    enabled: s.enabled !== false,
    intervalMs: num(s.intervalMs, LIMITS.intervalMs),
    timeoutMs: num(s.timeoutMs, LIMITS.timeoutMs),
    concurrency: num(s.concurrency, LIMITS.concurrency),
    failThreshold: num(s.failThreshold, LIMITS.failThreshold),
    // 배수는 소수 한 자리(2.5배 등) — 반올림하지 않고 자른다.
    slowFactor: Math.round(num(s.slowFactor, LIMITS.slowFactor, false) * 10) / 10,
    slowMinDeltaMs: num(s.slowMinDeltaMs, LIMITS.slowMinDeltaMs),
    retentionDays: num(s.retentionDays, LIMITS.retentionDays),
    kinds: Object.fromEntries(KIND_KEYS.map((k) => [k, kinds[k] !== false])),
    alerts: {
      down: al.down !== false,
      slow: al.slow === true,
      unknownMin: num(al.unknownMin, LIMITS.unknownMin),
      to: normalizeAddresses(Array.isArray(al.to) ? al.to : t(al.to)).ok.slice(0, ALERT_TO_MAX),
    },
    excluded: normalizeExcluded(s.excluded),
    // 측정을 다시 켠 시각(꺼짐 → 켜짐 저장 때만) — 알림의 '못 잼' 시계가 꺼 둔 시간을 세지 않게(점검 반증 #1).
    enabledAt: (() => { const v = numOrNull(s.enabledAt); return v != null && v > 0 ? Math.round(v) : null; })(),
  };
}

export const DEFAULTS = Object.freeze(normalizeSettings({}));

const parseStrictObject = (text) => { const v = JSON.parse(text); if (!isObj(v)) throw new SyntaxError('객체가 아닌 JSON 값'); return v; };
const _file = makeJsonFileLoader(FILE, {
  label: '포탈 서비스 상태 모니터링 설정(svc-status-settings.json) — 확정하면 기본값(측정 켜짐 · 60초 · 제외 없음 · 끊김 알림 켜짐)으로 저장됩니다',
  confirm: () => saveSvcStatusSettings({}, { replace: true }),
  parse: parseStrictObject,
  tag: 'svcstatus',
});
let _cache = null;
let _lastGood = null;
const copy = (c) => JSON.parse(JSON.stringify(c));

export function loadSvcStatusSettings() {
  if (_cache && !_file.recheckDue()) return copy(_cache);
  const r = _file.load();
  if (r.kind === 'ok') { _cache = normalizeSettings(r.value); _lastGood = _cache; }
  else if (r.kind === 'missing' && !_file.loadError()) { _cache = normalizeSettings({}); _lastGood = _cache; }   // 파일 없음 = 기본값이 곧 관리자 값
  else _cache = _lastGood || normalizeSettings({});   // 못 읽음 — 마지막으로 읽은 값(제외 · 알림을 풀지 않는다)
  return copy(_cache);
}
/** 설정 파일을 못 읽었으면 `{ reason, at, readError }`(요약), 읽었으면 null. */
export function svcStatusSettingsLoadError() { loadSvcStatusSettings(); return _file.marker(); }
/** 저장 거절(로드 오류 중) — 라우트 409 · 조회 응답 표지(settingsUnreadSweep112 규약). */
export function svcStatusWriteRefusal() { loadSvcStatusSettings(); return _file.refusal('포탈 서비스 상태 모니터링 설정'); }
/** 오류 동안 마지막으로 읽은 값으로 도는가(화면이 '마지막으로 읽은 제외 목록으로 돕니다' 를 말한다). */
export function svcStatusUsingLastGood() { loadSvcStatusSettings(); return !!_file.loadError() && !!_lastGood; }

const _listeners = new Set();
export function onSvcStatusSettingsChange(cb) { _listeners.add(cb); return () => _listeners.delete(cb); }
function notifyChange() { for (const cb of _listeners) { try { cb(); } catch { /* 리스너 실패가 저장을 막지 않는다 */ } } }

/**
 * 저장. 화면 저장은 **부분 갱신**(보낸 키만 바꾸고 숫자 칸의 빈 값은 유지) — `replace:true` 는 확정(기본값으로) 전용.
 * 제외 목록은 이 경로로 바꾸지 않는다(`setExcluded` — 동시에 고치는 두 관리자가 서로의 목록을 덮지 않게 한 건씩).
 */
export function saveSvcStatusSettings(input = {}, { replace = false } = {}) {
  const cur = loadSvcStatusSettings();
  const no = _file.refusal('포탈 서비스 상태 모니터링 설정');
  if (no && !replace) throw Object.assign(new Error(no.reason), { status: 409, code: 'settings-unreadable' });
  let next;
  if (replace) next = normalizeSettings({});
  else {
    const src = isObj(input) ? input : {};
    const merged = { ...cur, excluded: cur.excluded };
    for (const k of ['intervalMs', 'timeoutMs', 'concurrency', 'failThreshold', 'slowFactor', 'slowMinDeltaMs', 'retentionDays']) {
      if (numOrNull(src[k]) != null) merged[k] = src[k];
    }
    if (typeof src.enabled === 'boolean') { merged.enabled = src.enabled; if (src.enabled && cur.enabled === false) merged.enabledAt = Date.now(); }
    if (isObj(src.kinds)) merged.kinds = { ...cur.kinds, ...Object.fromEntries(KIND_KEYS.filter((k) => typeof src.kinds[k] === 'boolean').map((k) => [k, src.kinds[k]])) };
    if (isObj(src.alerts)) {
      const a = src.alerts;
      merged.alerts = { ...cur.alerts };
      if (typeof a.down === 'boolean') merged.alerts.down = a.down;
      if (typeof a.slow === 'boolean') merged.alerts.slow = a.slow;
      if (numOrNull(a.unknownMin) != null) merged.alerts.unknownMin = a.unknownMin;
      if (a.to !== undefined) {
        const r = normalizeAddresses(Array.isArray(a.to) ? a.to : t(a.to));
        if (r.bad.length) throw Object.assign(new Error(`받는 사람 주소 형식이 올바르지 않습니다: ${r.bad.slice(0, 3).join(', ')}`), { status: 400, field: 'alerts.to' });
        // 점검 반증 #11: 상한을 넘으면 조용히 자르지 않고 거절한다(중복 제거 뒤 개수 — 대소문자만 다른 주소는 하나).
        if (r.ok.length > ALERT_TO_MAX) throw Object.assign(new Error(`받는 사람은 ${ALERT_TO_MAX}명까지입니다(지금 ${r.ok.length}명).`), { status: 400, field: 'alerts.to' });
        merged.alerts.to = r.ok;
      }
    }
    next = normalizeSettings(merged);
  }
  atomicWriteFileSync(FILE(), JSON.stringify({ version: 1, ...next }, null, 2), { mode: 0o600 });
  _cache = next; _lastGood = next;
  _file.saved();
  notifyChange();
  return loadSvcStatusSettings();
}

/** 측정 제외 한 건 켜기/끄기 — 읽은 그대로의 목록에 한 건만 더하거나 뺀다. */
export function setExcluded(id, on, { reason = '', by = '', now = Date.now() } = {}) {
  const key = t(id).slice(0, ID_MAX);
  if (!key) throw Object.assign(new Error('대상 id 가 필요합니다.'), { status: 400, field: 'id' });
  const cur = loadSvcStatusSettings();
  const no = _file.refusal('포탈 서비스 상태 모니터링 설정');
  if (no) throw Object.assign(new Error(no.reason), { status: 409, code: 'settings-unreadable' });
  const rest = cur.excluded.filter((x) => x.id !== key);
  if (on && rest.length >= EXCLUDED_MAX) throw Object.assign(new Error(`제외 목록이 상한(${EXCLUDED_MAX}건)에 닿았습니다.`), { status: 400, field: 'id' });
  const excluded = on ? [...rest, { id: key, reason: t(reason).slice(0, 200), at: now, by: t(by).slice(0, 64) }] : rest;
  const next = normalizeSettings({ ...cur, excluded });
  atomicWriteFileSync(FILE(), JSON.stringify({ version: 1, ...next }, null, 2), { mode: 0o600 });
  _cache = next; _lastGood = next;
  _file.saved();
  notifyChange();
  return loadSvcStatusSettings().excluded;
}

export function _resetSvcStatusSettingsForTest() { _cache = null; _lastGood = null; _file.saved(); }
/** 시험 전용 — 캐시만 버린다(마지막으로 읽은 값은 남긴다 · 다음 load 가 디스크를 다시 판정). */
export function _dropSvcStatusSettingsCacheForTest() { _cache = null; _file.resetRetry(); }
