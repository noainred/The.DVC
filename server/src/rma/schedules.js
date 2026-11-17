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
import { makeSettingsLoadError } from '../util/settingsLoadError.js';
import { scheduleItemIssue, buildTest } from './tests.js';
import { scheduleSignRequired } from './signing.js';

const FILE = path.join(config.configDir, 'rma-schedules.json');
const MAX_PER_AGENT = 500;
let _db = null;
let seq = 0;

/*
 * v2.631(EDGE2631-01): 손상 → 보존 → 빈 스케줄이면 /api/central/rma-poll 이 버전 불일치로 **빈 스케줄을 내려보내** 엣지가 점검을
 *   전부 멈추고, 동시에 중앙은 known 집합이 비어 엣지가 보낸 점검 결과를 전부 버렸다. 로드 오류를 기억해 rma-poll 이 503 으로
 *   답하게 한다(엣지는 비-2xx 면 outbox·스케줄을 그대로 두고 백오프한다). 관리자가 한 번 저장하면 풀린다.
 */
const _loadErr = makeSettingsLoadError(() => FILE, { label: 'RMA 점검 스케줄', confirm: () => { load(); persist(); } });
function load() {
  if (_db) return _db;
  if (!fs.existsSync(FILE)) { _loadErr.missing(); _db = { agents: {} }; return _db; }
  try {
    const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('객체가 아닌 JSON 값');
    _db = { agents: p.agents && typeof p.agents === 'object' ? p.agents : {} };
    _loadErr.ok();
    return _db;
  } catch (e) { _loadErr.corrupt(e); preserveCorrupt(FILE, e?.message); }
  _db = { agents: {} };
  return _db;
}
function persist() { atomicWriteFileSync(FILE, JSON.stringify({ version: 1, ...load() }, null, 2), { mode: 0o600 }); _loadErr.ok(); }
/** v2.631(EDGE2631-01): 스케줄 파일을 못 읽었으면 사유(rma-poll 이 503 으로 답한다), 읽었으면 null. */
export function rmaSchedulesLoadError() { load(); return _loadErr.get(); }
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

/**
 * 결정(56~75 남긴 것) 64 F7 — 스케줄 서명 상태 한 줄(순수, 중앙 화면). 서명이 필요한 항목(script · ssh, 켜진 것)이 있고
 *   ① 이 법인 인스턴스 중 RMA_PASSWORD 가 있는(signed) 곳이 있는데 중앙에 비밀번호가 없으면 → 그 점검이 멈춘다는 사실
 *   ② 엣지가 서명 없음/불일치로 실행하지 않은 항목 수를 보고하면 → 그 수. 해당 없으면 ''.
 * @param {{ tests?:object[], hasPassword?:boolean, instances?:object[] }} p
 */
export function scheduleSignNote({ tests = [], hasPassword = false, instances = [] } = {}) {
  const need = (Array.isArray(tests) ? tests : []).filter((t) => t && t.enabled !== false && scheduleSignRequired(t.test)).length;
  if (!need) return '';
  const inst = Array.isArray(instances) ? instances : [];
  const edgeSigned = inst.some((i) => i && i.signed === true);
  const rejected = inst.reduce((n, i) => n + (Math.max(0, Number(i?.scheduleSigRejected) || 0)), 0);
  if (edgeSigned && !hasPassword) return `중앙에 이 법인의 RMA 비밀번호가 없어 외부 스크립트 · SSH 점검 ${need}개가 서명 없이 내려갑니다 — RMA_PASSWORD 가 있는 엣지는 그 점검을 실행하지 않습니다(설정에서 엣지와 같은 비밀번호를 등록하세요).`;
  if (rejected) return `엣지가 서명 없음/불일치로 외부 스크립트 · SSH 점검 ${rejected}개를 실행하지 않고 있습니다 — 점검 상태의 사유를 보세요.`;
  return '';
}

export function _resetSchedules() { _db = null; }
