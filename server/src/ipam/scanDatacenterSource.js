/**
 * ipam/scanDatacenterSource.js — 스캔 결과 데이터센터 귀속의 입력을 모은다(v2.638). 판정은 scanDatacenter.js(순수).
 *
 * 대장(ledger.js)은 30초마다 다시 만들어지고 요청마다도 불리므로, 등록부 파일(vcenters.json·collectors.json·datacenters.json)을
 * 매번 읽지 않도록 **10초** 메모한다(내용은 등록 변경 때만 바뀐다 — 스캔 설정 저장·DataCenter 할당 저장은 invalidate 로 즉시 버린다).
 * 순환을 피하려고 store.js 를 import 하지 않는다 — 스냅샷의 vCenter 목록은 호출부가 넘긴다.
 */
import { loadVcenterConfig } from '../config.js';
import { listCollectors } from '../collector/registry.js';
import { listDatacenters, getDatacenterAssign } from '../datacenter/store.js';
import { listScanAgents, scanResultList, LOCAL } from './scanStore.js';
import { resolveAgentDatacenters, datacenterMapSig } from './scanDatacenter.js';

const TTL_MS = 10_000;
let _memo = null; // { at, snapKey, map, sig, inputs }

/** 등록부 입력(스냅샷 제외). 읽기 실패는 그 입력만 빈 값이고 사유를 싣는다. */
export function scanDatacenterInputs() {
  const errors = {};
  const safe = (k, fn, def) => { try { return fn(); } catch (e) { errors[k] = String(e?.message || e).slice(0, 200); return def; } };
  const vcenters = safe('vcenters', () => loadVcenterConfig().vcenters || [], []);
  const collectors = safe('collectors', () => listCollectors(), []);
  const datacenters = safe('datacenters', () => listDatacenters(), []);
  const assign = safe('assign', () => getDatacenterAssign(), {});
  const agentsCfg = safe('scanSettings', () => listScanAgents(), []);
  const settings = {};
  for (const a of agentsCfg) settings[a.name] = { datacenterId: a.datacenterId || '' };
  return { vcenters, collectors, datacenters, assign, settings, errors };
}

/**
 * 지금의 에이전트 → 데이터센터 판정. `snapVcenters` 는 스냅샷의 vcenters(엣지가 올린 vCenter 의 collectedBy 판정용).
 * 결과를 판정할 에이전트 = 스캔 설정이 있는 에이전트 + 스캔 결과에 나오는 에이전트 + 이 포탈.
 */
export function currentScanDatacenters(snapVcenters = [], { now = Date.now() } = {}) {
  const snapKey = (Array.isArray(snapVcenters) ? snapVcenters : []).map((v) => `${v?.id}:${v?.collectedBy || ''}:${v?.collectSource || ''}`).join('|');
  if (_memo && now - _memo.at < TTL_MS && _memo.snapKey === snapKey) return _memo;
  const inputs = scanDatacenterInputs();
  const agents = new Set([LOCAL, ...Object.keys(inputs.settings)]);
  try { for (const r of scanResultList()) if (r?.agent) agents.add(r.agent); } catch { /* 결과 목록 실패는 설정 에이전트만 판정 */ }
  const map = resolveAgentDatacenters({ ...inputs, agents: [...agents], snapVcenters });
  _memo = { at: now, snapKey, map, sig: datacenterMapSig(map), inputs };
  return _memo;
}

/** 한 에이전트의 판정 — 아직 설정·결과가 없는 이름(화면에서 새로 입력한 에이전트)도 그 자리에서 판정한다. */
export function scanDatacenterOf(agent, snapVcenters = []) {
  const m = currentScanDatacenters(snapVcenters);
  const key = String(agent || LOCAL).toLowerCase();
  if (m.map.has(key)) return m.map.get(key);
  return resolveAgentDatacenters({ ...m.inputs, agents: [String(agent || LOCAL)], snapVcenters }).get(key) || null;
}

/** 스캔 설정·DataCenter 할당을 바꾼 뒤 부른다(다음 판정이 새 값을 읽게). */
export function invalidateScanDatacenters() { _memo = null; }
