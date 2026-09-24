/**
 * relaycheck/settings.js — HAProxy 경로 점검 설정(v2.429, 사용자 요구 '특수기능에 haproxy 설정을 주기적으로 점검해서 알람으로 알려주고
 * 해결방안도 제시').
 *
 * 구성도: 중앙 → Edge DVC(HAProxy) → IRS. Edge DVC 호스트마다 표준 포워딩 포트 프로파일이 같으므로(4000 자기 포탈, 4065 자기 vCenter,
 * 4066 IRS vCenter, 4067 IRS SSH, 4068 IRS 포탈, 4001 HQ 포탈) **호스트 × 프로파일** 로 점검 대상을 자동 생성한다.
 * 호스트는 수집 서버 목록의 URL 호스트에서 자동으로 뽑고, 수동 호스트를 더할 수 있다. 파일: CONFIG_DIR/relaycheck-settings.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

const FILE = () => path.join(config.configDir, 'relaycheck-settings.json');

export const KINDS = {
  'edge-portal': { label: 'Edge 포탈', desc: '중계 엣지(Edge DVC) 자신의 포탈. 수집 서버 항목의 토큰으로 ping 해 응답 엣지 이름까지 대조.' },
  'edge-vcenter': { label: 'Edge vCenter', desc: '중계 엣지가 자기 사이트 vCenter(VCSA)로 전달하는 포트. TCP→TLS→HTTP 단계 확인.' },
  'irs-vcenter': { label: 'IRS vCenter', desc: '중계 엣지가 IRS 사이트 vCenter 로 전달하는 포트. TCP→TLS→HTTP 단계 확인.' },
  'irs-ssh': { label: 'IRS SSH', desc: '중계 엣지가 IRS 의 SSH(22)로 전달하는 포트. SSH 배너("SSH-2.0-…") 수신 확인.' },
  'irs-portal': { label: 'IRS 포탈', desc: '중계 엣지가 IRS 포탈(:4000)로 전달하는 포트. 수집 서버 항목의 토큰으로 ping 하고 응답 엣지가 IRS 인지(중계 엣지 자신이 아닌지) 대조.' },
  'hq-portal': { label: 'HQ(중앙) 포탈', desc: '중계 엣지가 중앙 포탈로 전달하는 포트(IRS 가 중앙에 push 할 때 지나는 문). 응답이 이 중앙 자신인지(인스턴스 id) 대조.' },
};

export const DEFAULT_PROFILE = [
  { port: 4000, kind: 'edge-portal' },
  { port: 4065, kind: 'edge-vcenter' },
  { port: 4066, kind: 'irs-vcenter' },
  { port: 4067, kind: 'irs-ssh' },
  { port: 4068, kind: 'irs-portal' },
  { port: 4001, kind: 'hq-portal' },
];

export const LIMITS = {
  intervalMs: { min: 60_000, max: 6 * 3600_000, def: 5 * 60_000 },
  timeoutMs: { min: 2_000, max: 60_000, def: 8_000 },
  failStreak: { min: 1, max: 10, def: 2 },
};
const clamp = (v, l) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(l.max, Math.max(l.min, Math.round(n))) : l.def; };
const RE_HOST = /^[A-Za-z0-9.\-_:[\]]{1,253}$/;

export function normalizeSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {}; // null 은 기본 매개변수가 막지 못한다(TIM2601-03)
  const profile = (Array.isArray(input.profile) ? input.profile : DEFAULT_PROFILE)
    .map((p) => ({ port: Number(p?.port), kind: String(p?.kind || ''), label: String(p?.label || '').slice(0, 40) }))
    .filter((p) => Number.isInteger(p.port) && p.port > 0 && p.port <= 65535 && KINDS[p.kind])
    .slice(0, 32);
  const hosts = (Array.isArray(input.hosts) ? input.hosts : [])
    .map((h) => (typeof h === 'string' ? { host: h } : h))
    .map((h) => ({ host: String(h?.host || '').trim(), label: String(h?.label || '').slice(0, 40) }))
    .filter((h) => RE_HOST.test(h.host))
    .slice(0, 200);
  const exclude = (Array.isArray(input.exclude) ? input.exclude : []).map(String).filter((x) => /^[^:\s]+:\d+$/.test(x)).slice(0, 500);
  return {
    enabled: input.enabled !== false,
    intervalMs: clamp(input.intervalMs, LIMITS.intervalMs),
    timeoutMs: clamp(input.timeoutMs, LIMITS.timeoutMs),
    failStreak: clamp(input.failStreak, LIMITS.failStreak),
    autoHosts: input.autoHosts !== false,     // 수집 서버 URL 호스트를 자동 대상에 포함
    topologyHosts: input.topologyHosts !== false, // 중계 토폴로지(v2.431) 사이트의 Edge 주소도 대상에 포함(그 사이트 서비스 표 기준 포트)
    alerts: input.alerts !== false,           // 상태 전이 시 알림 채널 발화
    profile: profile.length ? profile : DEFAULT_PROFILE.map((p) => ({ ...p, label: '' })),
    hosts, exclude,
  };
}

let _cache = null;
export function loadSettings() {
  if (_cache) return { ..._cache, profile: _cache.profile.map((p) => ({ ...p })), hosts: _cache.hosts.map((h) => ({ ...h })), exclude: [..._cache.exclude] };
  let raw = {};
  try { if (fs.existsSync(FILE())) raw = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { preserveCorrupt(FILE()); raw = {}; }
  // v2.601(감사 TIM2601-03 — 재현): 파일 내용이 유효한 JSON 값 null·배열·숫자면 JSON.parse 는 성공해 손상 보존을 건너뛰고
  // 정규화가 TypeError 로 던졌다(_cache 가 안 채워져 **매 호출** 던진다 → 이 로더를 getMs 로 쓰는 적응 타이머가 멈췄다).
  // 객체가 아니면 손상으로 보고 보존한 뒤 기본값으로 시작한다(bmusage/settings.js readFile 과 같은 판정).
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { preserveCorrupt(FILE(), '객체가 아닌 JSON 값'); raw = {}; }
  _cache = normalizeSettings(raw);
  return loadSettings();
}
// v2.591 L10: 값이 바뀌면 무장된 타이머를 즉시 재무장하게 알린다(v2.409 '값 변경 시 즉시 재무장' 규약 — vmseries·curuser 와 같은 형태).
//   없으면 주기를 길게 둔 뒤 줄여도 옛 주기(최대 6시간)가 지나야 새 주기가 먹었다.
const _listeners = new Set();
export function onRelayCheckSettingsChange(cb) { _listeners.add(cb); return () => _listeners.delete(cb); }
function notifyChange() { for (const cb of _listeners) { try { cb(); } catch { /* 리스너 실패가 저장을 막지 않는다 */ } } }
export function saveSettings(input = {}) {
  _cache = normalizeSettings(input);
  atomicWriteFileSync(FILE(), JSON.stringify({ version: 1, ..._cache }, null, 2), { mode: 0o600 });
  notifyChange();
  return loadSettings();
}
export function _resetForTest() { _cache = null; }
