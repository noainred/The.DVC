/**
 * ipam/scanDatacenterSource.js — 스캔 결과 데이터센터 귀속의 입력을 모은다(v2.638). 판정은 scanDatacenter.js(순수).
 *
 * 대장(ledger.js)은 30초마다 다시 만들어지고 요청마다도 불리므로, 등록부 파일(vcenters.json·collectors.json·datacenters.json)을
 * 매번 읽지 않도록 **10초** 메모한다(내용은 등록 변경 때만 바뀐다 — 스캔 설정 저장·DataCenter 할당 저장은 invalidate 로 즉시 버린다).
 * 순환을 피하려고 store.js 를 import 하지 않는다 — 스냅샷의 vCenter 목록은 호출부가 넘긴다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, loadVcenterConfig } from '../config.js';
import { listCollectors } from '../collector/registry.js';
import { listDatacenters, getDatacenterAssign } from '../datacenter/store.js';
import { listScanAgents, scanResultAgents, scanRev, LOCAL } from './scanStore.js';
import { resolveAgentDatacenters, datacenterMapSig } from './scanDatacenter.js';

const TTL_MS = 10_000;
let _memo = null; // { at, snapKey, map, sig, inputs, tok }

/*
 * v2.639(감사 I2): TTL(10초)이 지나도 **입력이 그대로면 다시 만들지 않는다.** 예전에는 10초마다 vcenters.json(복호 포함)·
 *   collectors.json(복호)·datacenters.json 을 다시 읽고 스캔 결과 전체(최대 262,144개)를 **정렬**해 에이전트 집합을 모았다 —
 *   대장이 30초마다·요청마다 부르므로 그 비용이 상시였다(실측은 test/ipamStore2639.test.js 머리말과 보고서에).
 *   입력 토큰 = 등록부 파일 3개 + 스캔 설정 파일의 (mtime,size) + 스캔 결과 리비전(scanRev — 새 IP·에이전트 변경은 전부 리비전을
 *   올린다: mergeScanResults 의 `!prev`·`prev.agent !== agent` 가 changed 를 세운다). 토큰이 같으면 `at` 만 앞당긴다.
 *   ⚠ vcenter/registry·collector/registry 에는 리비전이 없어 파일 stat 으로 본다(datacenter/store 가 이미 같은 방식이다).
 *   invalidateScanDatacenters() 는 그대로 즉시 버린다(스캔 설정·DataCenter 할당 저장 직후).
 */
const _statTok = (file) => { try { const st = fs.statSync(file); return `${st.mtimeMs}:${st.size}`; } catch { return ''; } };
const CFG_FILES = ['collectors.json', 'datacenters.json', 'ipam-scan.json'].map((n) => path.join(config.configDir, n));
let _vcFile = null; // loadVcenterConfig 가 마지막으로 읽은 파일(후보 경로 중 하나) — 없으면 CONFIG_DIR/vcenters.json
function inputsToken() {
  const vcFile = _vcFile || path.join(config.configDir, 'vcenters.json');
  return `${_statTok(vcFile)}|${CFG_FILES.map(_statTok).join('|')}|n${scanRev()}`;
}

/** 등록부 입력(스냅샷 제외). 읽기 실패는 그 입력만 빈 값이고 사유를 싣는다. v2.639: 바깥 호출부 0건 — 내부 함수. */
function scanDatacenterInputs() {
  const errors = {};
  const safe = (k, fn, def) => { try { return fn(); } catch (e) { errors[k] = String(e?.message || e).slice(0, 200); return def; } };
  const vcenters = safe('vcenters', () => { const r = loadVcenterConfig(); if (r?.file) _vcFile = r.file; return r.vcenters || []; }, []);
  const collectors = safe('collectors', () => listCollectors(), []);
  const datacenters = safe('datacenters', () => listDatacenters(), []);
  const assign = safe('assign', () => getDatacenterAssign(), {});
  const agentsCfg = safe('scanSettings', () => listScanAgents(), []);
  const settings = {};
  for (const a of agentsCfg) settings[a.name] = { datacenterId: a.datacenterId || '' };
  return { vcenters, collectors, datacenters, assign, settings, errors };
}

/** 스캔 결과에 나오는 에이전트 이름 집합 — scanStore 가 적재 시점에 유지하는 목록(O(에이전트 수)). 예전 scanResultList 는 26만 개를 IP 순으로 정렬했다. */
function resultAgents(into) {
  try { for (const a of scanResultAgents()) if (a) into.add(a); } catch { /* 결과 목록 실패는 설정 에이전트만 판정 */ }
  return into;
}

/**
 * 지금의 에이전트 → 데이터센터 판정. `snapVcenters` 는 스냅샷의 vcenters(엣지가 올린 vCenter 의 collectedBy 판정용).
 * 결과를 판정할 에이전트 = 스캔 설정이 있는 에이전트 + 스캔 결과에 나오는 에이전트 + 이 포탈.
 */
export function currentScanDatacenters(snapVcenters = [], { now = Date.now() } = {}) {
  const snapKey = (Array.isArray(snapVcenters) ? snapVcenters : []).map((v) => `${v?.id}:${v?.collectedBy || ''}:${v?.collectSource || ''}`).join('|');
  if (_memo && _memo.snapKey === snapKey) {
    if (now - _memo.at < TTL_MS) return _memo;
    const tok = inputsToken();
    if (tok === _memo.tok) { _memo.at = now; return _memo; } // 입력 그대로 — stat 4회 + 리비전 비교만
  }
  const tok = inputsToken(); // 읽기 **전에** 찍는다 — 읽는 도중 바뀐 파일은 다음 호출이 토큰 불일치로 다시 읽게
  const inputs = scanDatacenterInputs();
  const agents = resultAgents(new Set([LOCAL, ...Object.keys(inputs.settings)]));
  const map = resolveAgentDatacenters({ ...inputs, agents: [...agents], snapVcenters });
  _memo = { at: now, snapKey, map, sig: datacenterMapSig(map), inputs, tok };
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
