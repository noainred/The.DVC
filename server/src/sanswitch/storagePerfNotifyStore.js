/**
 * sanswitch/storagePerfNotifyStore.js — SAN 스토리지 성능 **알림** 설정 · 상태 · 전이 판정(순수 부분 포함 · v2.950 · 설계 §12.2-6).
 *
 * 알림은 **상태가 바뀐 순간만**(파트 장애 규약 — 매 주기 전량을 보내지 않는다) · **법인 단위**로 묶는다(1:1:1 법인 묶음).
 *  · 수준: ok(0) < warn(1) < bad(2). unknown · na 는 수준이 아니다 — 올리지도 내리지도 않는다(못 읽은 것은 정상도 이상도 아니다).
 *    예외: `collect`(수집 상태) 항목은 ok → unknown(엣지 미보고 · 표본 없음)이 '보고 끊김' 이고 unknown → ok 가 회복이다(사용자 요구 '보고 끊김').
 *  · 열림: 새 수준이 minLevel(기본 warn) 이상이고 이전보다 높을 때. 회복: 이전이 warn 이상이고 지금 ok 일 때(recoveries 가 켜져 있을 때만).
 *  · 설정 `san-storage-notify.json` · 상태 `san-storage-notify-state.json`(마지막 판정 · 발송 기록 20) — 원자적 쓰기 + 손상 보존(server/CLAUDE.md).
 *  · 엣지는 보내지 않는다(중앙만 — 러너가 판단). 러너는 storagePerfNotify.js(라우트 함수를 쓰므로 여기와 분리 — 순환 import 방지).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { numOrNull } from '../util/numOrNull.js';

const FILE = () => path.join(config.configDir, 'san-storage-notify.json');
const STATE_FILE = () => path.join(config.configDir, 'san-storage-notify-state.json');
export const NOTIFY_HISTORY_MAX = 20;
export const LEVELS = Object.freeze({ ok: 0, warn: 1, bad: 2 });
export const MIN_LEVELS = Object.freeze(['warn', 'bad']);
export const NOTIFY_DEFAULTS = Object.freeze({ enabled: false, minLevel: 'warn', recoveries: true, items: null /* null = 전부 */ });
const strMax = (v, n) => String(v ?? '').slice(0, n);

/* ── 설정 ─────────────────────────────────────────────────────────────── */
let _cfg = null; let _loadErr = null;
export function normalizeNotifySettings(input, prev = NOTIFY_DEFAULTS) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = { ...NOTIFY_DEFAULTS, ...(prev || {}) };
  if (Object.hasOwn(src, 'enabled')) out.enabled = src.enabled === true || src.enabled === 'true';
  if (Object.hasOwn(src, 'minLevel')) { if (!MIN_LEVELS.includes(src.minLevel)) return { issue: 'minLevel 은 warn 또는 bad 입니다' }; out.minLevel = src.minLevel; }
  if (Object.hasOwn(src, 'recoveries')) out.recoveries = src.recoveries !== false && src.recoveries !== 'false';
  if (Object.hasOwn(src, 'items')) {
    if (src.items == null || src.items === '') out.items = null;
    else if (!Array.isArray(src.items) || src.items.some((x) => typeof x !== 'string' || !/^[a-zA-Z]{1,24}$/.test(x))) return { issue: 'items 는 항목 키 배열(또는 비움)입니다' };
    else out.items = [...new Set(src.items)].slice(0, 16);
  }
  return { settings: out };
}
export function loadNotifySettings() {
  if (_cfg) return _cfg;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    const r = normalizeNotifySettings(raw, NOTIFY_DEFAULTS);
    if (r.issue) throw new Error(r.issue);
    _cfg = { ...r.settings, updatedAt: numOrNull(raw.updatedAt), updatedBy: strMax(raw.updatedBy, 64) }; _loadErr = null;
  } catch (e) {
    if (e?.code !== 'ENOENT') { preserveCorrupt(FILE(), e?.message); _loadErr = { at: Date.now(), reason: strMax(e?.message, 200) }; console.warn(`[san-storage-notify] 설정 파일을 읽지 못했습니다(손상본 보존 · 알림 중지): ${_loadErr.reason}`); }
    _cfg = { ...NOTIFY_DEFAULTS, updatedAt: null, updatedBy: '' };
  }
  return _cfg;
}
export const notifyLoadError = () => { loadNotifySettings(); return _loadErr; };
export function saveNotifySettings(input, { by = '' } = {}) {
  loadNotifySettings();
  if (_loadErr) return { issue: '설정 파일을 읽지 못해 저장하지 않았습니다 — 손상본(san-storage-notify.json.corrupt.*)을 확인하세요.' };
  const r = normalizeNotifySettings(input, _cfg);
  if (r.issue) return r;
  const next = { ...r.settings, updatedAt: Date.now(), updatedBy: strMax(by, 64) };
  atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2), { mode: 0o600 });
  _cfg = next;
  return { settings: next };
}

/* ── 상태(마지막 판정 · 발송 기록) ──────────────────────────────────────── */
let _state = null;
export function loadNotifyState() {
  if (_state) return _state;
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('형식 오류');
    _state = { last: raw.last && typeof raw.last === 'object' ? raw.last : {}, at: numOrNull(raw.at), history: (Array.isArray(raw.history) ? raw.history : []).slice(0, NOTIFY_HISTORY_MAX), lastTick: raw.lastTick && typeof raw.lastTick === 'object' ? raw.lastTick : null };
  } catch (e) {
    if (e?.code !== 'ENOENT') { preserveCorrupt(STATE_FILE(), e?.message); console.warn(`[san-storage-notify] 상태 파일을 읽지 못해 새로 시작합니다(첫 틱은 기준만 잡고 보내지 않습니다): ${safeLoadText(e, 160)}`); }
    _state = { last: {}, at: null, history: [], lastTick: null };
  }
  return _state;
}
export function saveNotifyState(next) {
  _state = next;
  try { atomicWriteFileSync(STATE_FILE(), JSON.stringify(next), { mode: 0o600 }); return true; }
  catch (e) { console.warn(`[san-storage-notify] 상태 파일을 저장하지 못했습니다(메모리로 계속): ${e.message}`); return false; }
}
export function recordNotify(entry) {
  const st = loadNotifyState();
  const e = { at: Date.now(), ...entry };
  st.history = [e, ...st.history].slice(0, NOTIFY_HISTORY_MAX);
  saveNotifyState(st);
  return e;
}
export function _resetNotifyForTest() { _cfg = null; _loadErr = null; _state = null; }

/* ── 전이 판정(순수) ─────────────────────────────────────────────────── */
/** 점검 결과 → 상태 스냅샷 { `${dc}|${key}`: { name, dc, dcName, overall, items:{k:status}, texts:{k:text} } }. */
export function snapshotOf(results = []) {
  const out = {};
  for (const r of results || []) {
    if (!r || !r.key) continue;
    const items = {}; const texts = {};
    for (const [k, v] of Object.entries(r.items || {})) { items[k] = v?.status || 'unknown'; texts[k] = strMax(v?.text, 160); }
    out[`${r.datacenterId ?? ''}|${r.key}`] = { name: strMax(r.name || r.key, 120), dc: String(r.datacenterId ?? ''), dcName: strMax(r.datacenterName, 80), overall: r.overall || 'unknown', items, texts };
  }
  return out;
}
const levelOf = (s) => (Object.hasOwn(LEVELS, s) ? LEVELS[s] : null);
/**
 * 전이(순수): prev · cur 스냅샷 → 열림 · 회복 목록. 첫 비교(prev 가 비어 있음)는 기준만 잡고 아무것도 열지 않는다(기동 직후 전량 발송 금지).
 * @returns {{opened:Array<{id,name,dc,dcName,item,from,to,text}>, recovered:Array<…>, first:boolean}}
 */
export function diffCheck(prev, cur, { minLevel = 'warn', recoveries = true, items = null } = {}) {
  const prevKeys = Object.keys(prev || {});
  const first = prevKeys.length === 0;
  const opened = []; const recovered = [];
  if (first) return { opened, recovered, first };
  const minL = LEVELS[minLevel] ?? LEVELS.warn;
  for (const [id, c] of Object.entries(cur || {})) {
    const p = prev[id];
    if (!p) continue;   // 새 어레이 — 다음 비교부터
    for (const [k, to] of Object.entries(c.items || {})) {
      if (items && !items.includes(k)) continue;
      const from = p.items?.[k] ?? 'unknown';
      if (from === to) continue;
      const base = { id, name: c.name, dc: c.dc, dcName: c.dcName, item: k, from, to, text: c.texts?.[k] || '' };
      if (k === 'collect') {   // 보고 끊김 · 회복(unknown 이 뜻을 가진 유일한 항목)
        if (from === 'ok' && to === 'unknown') opened.push({ ...base, kind: 'lost' });
        else if (from === 'unknown' && to === 'ok' && recoveries) recovered.push(base);
        else if (levelOf(from) != null && levelOf(to) != null && levelOf(to) > levelOf(from) && levelOf(to) >= minL) opened.push(base);
        continue;
      }
      const lf = levelOf(from); const lt = levelOf(to);
      if (lt != null && lt >= minL && (lf == null || lt > lf)) opened.push(base);
      else if (recoveries && lf != null && lf >= LEVELS.warn && to === 'ok') recovered.push(base);
    }
  }
  return { opened, recovered, first };
}
/** 법인별 묶음 → 알림(순수). 심각도: 이상 열림 critical · 주의 열림 warning · 회복만 info. */
export function alertsOf({ opened = [], recovered = [] }, { labels = {}, viewPath = '#/tools/san-storage/check' } = {}) {
  const byDc = new Map();
  const add = (x, kind) => { const k = x.dc || ''; const g = byDc.get(k) || { dc: k, dcName: x.dcName || x.dc || '(법인 미지정)', opened: [], recovered: [] }; g[kind].push(x); byDc.set(k, g); };
  for (const x of opened) add(x, 'opened');
  for (const x of recovered) add(x, 'recovered');
  const out = [];
  for (const g of byDc.values()) {
    const bad = g.opened.filter((x) => x.to === 'bad').length; const warn = g.opened.filter((x) => x.to === 'warn').length; const lost = g.opened.filter((x) => x.kind === 'lost').length;
    const sev = bad ? 'critical' : (warn || lost) ? 'warning' : 'info';
    const head = [bad ? `이상 ${bad}` : '', warn ? `주의 ${warn}` : '', lost ? `보고 끊김 ${lost}` : '', g.recovered.length ? `회복 ${g.recovered.length}` : ''].filter(Boolean).join(' · ');
    const lab = (k) => labels[k] || k;
    const line = (x, tag) => `[${tag}] ${x.name} · ${lab(x.item)}: ${x.from} → ${x.to}${x.text ? ` — ${x.text}` : ''}`;
    const lines = [...g.opened.map((x) => line(x, x.kind === 'lost' ? '보고 끊김' : x.to === 'bad' ? '이상' : '주의')), ...g.recovered.map((x) => line(x, '회복'))];
    lines.push(`화면: ${viewPath} (법인 ${g.dcName})`);
    out.push({ key: `san-storage:${g.dc || 'none'}`, severity: sev, title: `SAN 스토리지 성능 — ${g.dcName}: ${head}`, detail: lines.join('\n').replace(/\*\*/g, ''), dc: g.dc, counts: { bad, warn, lost, recovered: g.recovered.length } });
  }
  return out;
}
