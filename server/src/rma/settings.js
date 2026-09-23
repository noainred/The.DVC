/**
 * RMA 분배 설정(중앙) — `rma-settings.json` { version, defaultMode, agents: { name: { mode, primary } } }.
 * 비밀 없음(봉인 대상 아님). 원자적 쓰기 + 로드 손상 preserveCorrupt(설정 파일 공통 규약).
 */
import { strictIpv4Num, cidrMatch } from '../util/ipv4.js';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

export const MODES = [
  { id: 'active-active', label: 'Active-Active (선착 인출)', desc: '모든 인스턴스가 동시에 일합니다. 먼저 폴링한 인스턴스가 명령을 가져갑니다.' },
  { id: 'balance', label: '부하 분산 (최소 부하 → 라운드로빈)', desc: '등록 시점에 진행 중 명령이 가장 적은 온라인 인스턴스에 배정합니다. 동률이면 순서대로 돌립니다.' },
  { id: 'active-backup', label: 'Active-Backup (주/예비)', desc: '주 인스턴스만 실행합니다. 주가 오프라인이면 다음 순위(RMA_PRIORITY 낮은 값)가 자동으로 넘겨받습니다.' },
];
const MODE_IDS = new Set(MODES.map((m) => m.id));
const RE_INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const FILE = path.join(config.configDir, 'rma-settings.json');
let _db = null;

function load() {
  if (_db) return _db;
  try {
    if (fs.existsSync(FILE)) {
      const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      _db = { defaultMode: MODE_IDS.has(p.defaultMode) ? p.defaultMode : 'active-active', agents: p.agents && typeof p.agents === 'object' ? p.agents : {} };
      return _db;
    }
  } catch { preserveCorrupt(FILE); }
  _db = { defaultMode: 'active-active', agents: {} };
  return _db;
}
function persist() { atomicWriteFileSync(FILE, JSON.stringify({ version: 1, ...load() }, null, 2), { mode: 0o600 }); }

const lc = (a) => String(a || '').trim().toLowerCase();

/** 법인의 유효 분배 설정 { mode, primary }. 미설정은 전역 기본. */
export function modeFor(agent) {
  const db = load();
  const a = db.agents[lc(agent)] || {};
  return { mode: MODE_IDS.has(a.mode) ? a.mode : db.defaultMode, primary: String(a.primary || ''), explicit: MODE_IDS.has(a.mode) };
}

export function getRmaSettings() {
  const db = load();
  return { defaultMode: db.defaultMode, modes: MODES, agents: Object.fromEntries(Object.entries(db.agents).map(([k, v]) => [k, { mode: v.mode || '', primary: v.primary || '', allowedIps: v.allowedIps || [], comment: v.comment || '', remote: v.remote || null }])) };
}

/** 법인 설정 저장. mode '' = 전역 기본 따름. 반환 유효 설정. */
export function setAgentMode(agent, { mode = '', primary = '' } = {}) {
  const k = lc(agent);
  if (!k) throw new Error('agent 가 필요합니다.');
  if (mode && !MODE_IDS.has(mode)) throw new Error(`알 수 없는 분배 방식: ${String(mode).slice(0, 30)}`);
  const p = String(primary || '').trim();
  if (p && !RE_INSTANCE.test(p)) throw new Error('주 인스턴스 이름 형식 오류(영숫자·._-, 64자 이내)');
  const db = load();
  const keep = db.agents[k] || {};
  if (!mode && !p && !(keep.allowedIps || []).length && !keep.comment && !keep.remote) delete db.agents[k];
  else db.agents[k] = { ...keep, mode, primary: p };
  persist();
  return modeFor(k);
}

export function setDefaultMode(mode) {
  if (!MODE_IDS.has(mode)) throw new Error(`알 수 없는 분배 방식: ${String(mode).slice(0, 30)}`);
  load().defaultMode = mode;
  persist();
  return mode;
}

/** 접속 허용 IP(중앙, v2.418 — HostMonitor 'Accept connections from the following addresses' 대응). */
const RE_IP_ENTRY = /^[0-9a-fA-F.:]{2,45}(?:\/\d{1,3})?$/;
export function ipEntriesIssue(list) {
  for (const e of list || []) if (!RE_IP_ENTRY.test(String(e))) return `IP/CIDR 형식 오류: ${String(e).slice(0, 30)}`;
  if ((list || []).length > 64) return '허용 IP 는 64개 이내';
  return null;
}
export function setAgentAccess(agent, { allowedIps = [], comment = '' } = {}) {
  const k = lc(agent);
  if (!k) throw new Error('agent 가 필요합니다.');
  const ips = (Array.isArray(allowedIps) ? allowedIps : String(allowedIps).split(/[,\s]+/)).map((x) => String(x).trim()).filter(Boolean);
  const issue = ipEntriesIssue(ips);
  if (issue) throw new Error(issue);
  const db = load();
  db.agents[k] = { ...(db.agents[k] || {}), allowedIps: ips, comment: String(comment || '').slice(0, 200) };
  persist();
  return accessFor(k);
}
export function accessFor(agent) {
  const a = load().agents[lc(agent)] || {};
  return { allowedIps: Array.isArray(a.allowedIps) ? a.allowedIps : [], comment: a.comment || '' };
}
/** IPv4 CIDR/단일 IP 매칭(순수). IPv6 는 정확 일치만. 목록이 비면 전부 허용. */
export function ipAllowed(ip, list) {
  if (!list || !list.length) return true;
  const raw = String(ip || '').replace(/^::ffff:/, '');
  // v2.589: '10..0.5'·'010.0.0.5' 같은 비정규 표기를 CIDR 안으로 읽지 않는다(util/ipv4 단일 소스).
  const n = strictIpv4Num(raw);
  for (const e of list) {
    const [base, bits] = String(e).split('/');
    if (bits == null) { if (raw === base) return true; continue; }
    if (typeof n === 'number' && cidrMatch(n, e) === true) return true;
  }
  return false;
}

/** 원격 관리 설정(중앙 → RMA, RMA_REMOTE_MANAGE=true 인 인스턴스만 받아들인다 — 축소만 가능). */
export function setAgentRemote(agent, { longpollMs = 0, testConcurrency = 0, disabledTests = [] } = {}) {
  const k = lc(agent);
  if (!k) throw new Error('agent 가 필요합니다.');
  const lp = Number(longpollMs) || 0, tc = Number(testConcurrency) || 0;
  if (lp && (lp < 5000 || lp > 55000)) throw new Error('롱폴은 5000~55000ms');
  if (tc && (tc < 1 || tc > 16)) throw new Error('동시 점검 수는 1~16');
  const dis = (Array.isArray(disabledTests) ? disabledTests : String(disabledTests).split(/[,\s]+/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 200);
  const db = load();
  db.agents[k] = { ...(db.agents[k] || {}), remote: { longpollMs: lp, testConcurrency: tc, disabledTests: dis } };
  persist();
  return remoteFor(k);
}
export function remoteFor(agent) {
  const r = load().agents[lc(agent)]?.remote || {};
  return { longpollMs: r.longpollMs || 0, testConcurrency: r.testConcurrency || 0, disabledTests: r.disabledTests || [] };
}

export function _resetRmaSettings() { _db = null; }
