/**
 * RMA 점검 스케줄(중앙, v2.418) — `rma-schedules.json` { version, agents: { name: { version, tests: [...] } } }.
 * HostMonitor 의 'Test by <agent>' 에 해당: 중앙이 법인별로 점검 목록(주기·파라미터·인스턴스)을 정하고,
 * RMA 가 롱폴 응답으로 받아(버전이 다를 때만) 현지에서 주기 실행한다.
 * 항목: { id, name, test, args, intervalSec, instance('' = 법인 내 아무 인스턴스 → 분배 방식 무관하게
 *        **모든 인스턴스가 실행하지 않도록** 중앙이 인스턴스별로 나눠 배정), enabled }
 * 비밀 없음. 원자적 쓰기 + preserveCorrupt.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { scheduleItemIssue, buildTest } from './tests.js';

const FILE = path.join(config.configDir, 'rma-schedules.json');
const MAX_PER_AGENT = 500;
let _db = null;
let seq = 0;

function load() {
  if (_db) return _db;
  try {
    if (fs.existsSync(FILE)) {
      const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      _db = { agents: p.agents && typeof p.agents === 'object' ? p.agents : {} };
      return _db;
    }
  } catch { preserveCorrupt(FILE); }
  _db = { agents: {} };
  return _db;
}
function persist() { atomicWriteFileSync(FILE, JSON.stringify({ version: 1, ...load() }, null, 2), { mode: 0o600 }); }
const lc = (a) => String(a || '').trim().toLowerCase();
const newId = () => `t_${Date.now().toString(36)}_${(seq++).toString(36)}`;

/** 법인 스케줄 { version, tests } (없으면 version 0, 빈 목록). */
export function scheduleFor(agent) {
  const a = load().agents[lc(agent)];
  return a ? { version: a.version || 0, tests: a.tests || [] } : { version: 0, tests: [] };
}

export function listSchedules() {
  return Object.entries(load().agents).map(([agent, a]) => ({ agent, version: a.version || 0, count: (a.tests || []).length, enabled: (a.tests || []).filter((t) => t.enabled !== false).length }));
}

/** 항목 추가/수정(id 있으면 수정). 검증 실패는 throw. 반환 저장된 항목. */
export function upsertScheduleItem(agent, item = {}) {
  const k = lc(agent);
  if (!k) throw new Error('agent 가 필요합니다.');
  const issue = scheduleItemIssue(item);
  if (issue) throw new Error(issue);
  const b = buildTest(item.test, item.args || {});
  const db = load();
  const a = db.agents[k] || { version: 0, tests: [] };
  const row = {
    id: item.id && a.tests.some((t) => t.id === item.id) ? item.id : newId(),
    name: String(item.name || '').trim().slice(0, 80),
    test: b.test, args: b.args, intervalSec: Number(item.intervalSec),
    instance: String(item.instance || '').trim(), enabled: item.enabled !== false, updatedAt: Date.now(),
  };
  const i = a.tests.findIndex((t) => t.id === row.id);
  if (i >= 0) a.tests[i] = { ...a.tests[i], ...row };
  else { if (a.tests.length >= MAX_PER_AGENT) throw new Error(`법인당 점검은 최대 ${MAX_PER_AGENT}개`); a.tests.push(row); }
  a.version = (a.version || 0) + 1;
  db.agents[k] = a;
  persist();
  return row;
}

export function removeScheduleItem(agent, id) {
  const k = lc(agent);
  const db = load(); const a = db.agents[k];
  if (!a) return false;
  const before = a.tests.length;
  a.tests = a.tests.filter((t) => t.id !== id);
  if (a.tests.length === before) return false;
  a.version = (a.version || 0) + 1;
  if (!a.tests.length) delete db.agents[k]; // 빈 법인은 제거 — 단, 엣지가 '삭제됨'을 알도록 version 0 이 아니라 없음(=version 0)으로 내려간다
  persist();
  return true;
}

/**
 * 인스턴스별 배정(순수): instance 가 비어 있는 항목은 온라인 인스턴스 목록에 **결정적으로**(id 해시 → 인덱스)
 * 나눠 준다 — 모든 인스턴스가 같은 점검을 중복 실행하지 않게. 오프라인이 되면 다음 폴에서 재배정된다.
 */
export function assignForInstance(schedule, instance, onlineInstances = []) {
  const pool = (onlineInstances.length ? onlineInstances : [instance]).map(String).sort((a, b) => a.localeCompare(b));
  const mine = String(instance);
  const hash = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };
  const tests = (schedule.tests || []).filter((t) => t.enabled !== false && !getCentral(t.test)).filter((t) => {
    if (t.instance) return t.instance.toLowerCase() === mine.toLowerCase();
    if (!pool.length) return true;
    return pool[hash(t.id) % pool.length] === mine;
  });
  return { version: schedule.version, tests, poolSize: pool.length };
}
const getCentral = (test) => { const b = buildTest(test, {}); return b.ok ? b.central : String(test) === 'rma-itself'; };

export function _resetSchedules() { _db = null; }
