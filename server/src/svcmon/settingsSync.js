/**
 * svcmon/settingsSync.js — **설정 연동**(v2.915): 포탈 설정에 등록된 시스템을 골라 Monitoring(성능점검) 대상으로 등록하고,
 * 설정이 바뀌면(새 항목 · 주소 변경 · 사라짐) 차이를 알린다.
 *
 * 사용자 요청(2026-11-06): "이 솔루션에서 사용하는, 설정한 모든 정보(edge · vCenter · proxy · CVP · 스토리지 …)를 모니터링 기능에
 * 사용자 선택해서 추가" + 시안 2차 "Datadog 대시보드 참고 · 기술 뷰". 설계 `docs/design/monitoring-autoreg/README.md`.
 *
 * ── 지키는 것 ────────────────────────────────────────────────────────────────
 * 1. **열거기를 새로 만들지 않는다** — 통신 점검의 설정 카탈로그(`linkcheck/settingsLinks.js buildSettingsTargets`)를 그대로 읽는다.
 *    같은 등록부를 두 곳에서 읽으면 한쪽만 고쳐진다(그 카탈로그가 이미 비밀 제거본만 읽고 export 이름 변경을 sourceErrors 로 올린다).
 * 2. **자격증명을 옮기지 않는다** — 만드는 점검은 무인증(TCP · 인증서 · HTTP 상태 · SSH/SMTP 배너)뿐이다(`checksFor`).
 *    무인증 장비의 HTTP 는 기대 코드를 비워 500 미만을 정상으로 본다(checker.js — 401/403 = 살아 있고 인증을 요구한다).
 * 3. **출처(origin)는 서버만 발급한다**(store.cleanOrigin 머리말) — 동기화의 조인 키는 `origin.key`(= 카탈로그 id `set:<kind>|<ref>`).
 * 4. **사라짐은 지우지 않는다** — 기본은 '중지 + origin.gone 표지'. 등록부를 못 읽은 출처(sourceErrors)의 대상은 사라짐이 아니라
 *    '판정 보류(held)' 다(servicemap 의 유령 키 보류와 같은 fail-closed — 손상 한 번이 전 대상을 중지시키지 않게).
 * 5. **자동 등록은 기본 끔** — 켜도 '한 번도 연동된 적 없는 키(known 밖)' 만, 중지 상태로 등록한다(지운 대상을 되살리지 않는다).
 * 6. 감지(5분)는 **카탈로그 읽기만** 한다(파일·메모리) — 네트워크 점검이 아니다. 엣지 노드(CENTRAL_URL)는 돌리지 않는다
 *    (엣지의 svcmon 대상은 중앙 배정 사본이다).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { fileStamp, dayKey } from '../util/dayKey.js';
import { SETTING_KINDS, SETTINGS_PATHS, GROUP_ORDER, DEPTH_LABEL } from '../linkcheck/settingsKinds.js';
import {
  listTargets, bulkAddTargets, updateTarget, updateTest, addTest, deleteTarget, getTarget, validateEndpoint, cleanOrigin, LIMITS,
} from './store.js';

const FILE = () => path.join(config.configDir, 'svcmon-settings-sync.json');
const t = (v) => String(v ?? '').trim();

/** 트리 최상위 폴더 — 설정 연동이 만든 대상은 이 아래 `<그룹>\<법인>` 에 놓인다. */
export const SYNC_ROOT = '설정 연동';
/** 점검 템플릿 표지(test.tpl) — 재동기화가 '설정 연동이 만든 점검' 만 고치는 근거(사람이 더한 점검은 건드리지 않는다). */
export const SYNC_TPL = 'settings';
/** 응답 행 상한 — 카탈로그가 이보다 크면 truncated 로 밝힌다(조용히 자르지 않는다). */
export const MAX_ROWS = 5000;
/** 한 번에 적용할 수 있는 항목 상한 — 대량 등록 1회 상한과 같다. */
export const MAX_APPLY = LIMITS.maxBulkRows;

/** 기본으로 등록하지 않는 종류와 이유(화면이 그대로 보여 준다). */
export const EXCLUDED_KINDS = Object.freeze({
  'set:webhook': '웹훅 URL 자체가 비밀(봉인 저장)입니다 — 호스트만 싣더라도 경로를 유추할 단서가 되어 Monitoring 대상으로 옮기지 않습니다.',
  'set:central': '엣지 → 중앙 링크는 엣지 자신이 잽니다(통신 점검 · 전송 속도).',
  'set:upgrade-src': '외부 인터넷 주소라 폐쇄망 엣지에서 전면 실패합니다 — 통신 점검이 잽니다.',
  'set:package-repo': '외부 저장소 주소 — 통신 점검이 잽니다.',
  'set:llm': '대개 이 포탈 자신(localhost)이라 SSRF 가드가 막습니다 — 통신 점검이 잽니다.',
  // v2.915(반증 H1·M7): 통합 계정의 '계정 이름 → 호스트' 매핑은 관리자 전용 정보다(통합 계정 목록 adminOnly). 등록하면 대상 이름·출처로
  //   /state 를 통해 범위 계정에도 보인다 — 옮기지 않는다(같은 호스트는 다른 종류로 이미 등록돼 있는 경우가 대부분이다).
  'set:credential-host': '통합 계정의 계정 이름과 호스트의 연결은 관리자 전용 정보라 Monitoring 대상(범위 계정도 보는 화면)으로 옮기지 않습니다.',
});

/**
 * 응답에 싣는 주소 — 사용자 정보(user:pw@)·쿼리·조각을 지운다(반증 H1: 봉인 비밀인 웹훅 URL 원문이 카탈로그 응답으로 나갔다).
 * 제외 종류(웹훅 등)는 주소 자체를 싣지 않는다 — 경로에 토큰이 있다.
 */
export function safeAddress(addr, kind = '') {
  const a = t(addr);
  if (!a) return '';
  if (EXCLUDED_KINDS[kind]) return '';
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(a);
    if (!hasScheme) return a.replace(/^[^@/]*@/, '').replace(/[?#].*$/, '').slice(0, 300);
    const u = new URL(a);
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 300);
  } catch { return ''; }
}

/**
 * 종류 → 카탈로그 로더 이름(buildSettingsTargets 의 sourceErrors[].source). 그 출처를 못 읽었으면 그 종류의 연동 대상은
 * '사라짐' 이 아니라 '판정 보류' 다. ⚠ settingsLinks.js 의 load('<이름>') 과 같은 문자열이어야 한다(테스트가 대조).
 */
export const SOURCE_OF_KIND = Object.freeze({
  'set:vcenter': 'vcenters', 'set:nsx': 'nsx', 'set:horizon': 'horizon', 'set:collector': 'collectors', 'set:central': 'central',
  'set:deploy': 'deploy', 'set:relaytopo': 'relaytopo', 'set:idrac': 'idrac', 'set:ome': 'idrac', 'set:bmstor': 'bmstor',
  'set:gpu-physical': 'gpuPhysical', 'set:storage-api': 'storage', 'set:storage-ssh': 'storage', 'set:sanswitch-ssh': 'sanswitch',
  'set:sanswitch-rest': 'sanswitch', 'set:pdu': 'pdu', 'set:cvp': 'cvp', 'set:veeam': 'veeam', 'set:veeam-em': 'veeamEm',
  'set:bareos-dir': 'bareos', 'set:isidu-host': 'isidu', 'set:llm': 'llm', 'set:dataplane': 'remote', 'set:remote-ssh': 'remote',
  'set:capture': 'capture', 'set:credential-host': 'credentials', 'set:smtp': 'mail', 'set:webhook': 'alerts', 'set:ad': 'ad',
  'set:upgrade-src': 'upgrade', 'set:package-repo': 'packages',
});

/** 상태 — 화면 알약·패싯이 같은 키를 쓴다. */
export const SYNC_STATES = Object.freeze(['new', 'linked', 'changed', 'gone', 'held', 'problem', 'excluded']);

/* ───────────────────────────── 순수 판정 ───────────────────────────── */

/** 트리 경로 한 단계 — 폴더 이름에 못 쓰는 글자를 '_' 로(store addFolder SAFE_SEG 와 같은 금지 문자). */
export function pathSeg(v) {
  const s = t(v).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').slice(0, 60).trim();
  return s || '-';
}

/**
 * 법인 이름 — 카탈로그 항목의 vcenterId(종류에 따라 datacenterId 가 실린다 — settingsLinks 의 storage·pdu·cvp)를 사람이 읽는 이름으로.
 * vCenter 면 그 vCenter 의 DataCenter 이름(배정돼 있으면) → vCenter 이름 순. 모르면 '전역'.
 * @param {object} x 카탈로그 항목
 * @param {{vcNames?:Map, dcNames?:Map, dcOfVc?:Map}} ctx
 */
export function corpOf(x, ctx = {}) {
  const vcNames = ctx.vcNames || new Map();
  const dcNames = ctx.dcNames || new Map();
  const dcOfVc = ctx.dcOfVc || new Map();
  const ids = [t(x?.vcenterId), t(x?.facts?.vcenterId), t(x?.facts?.datacenter)].filter(Boolean);
  for (const id of ids) {
    if (vcNames.has(id)) {
      const dc = dcOfVc.get(id);
      if (dc && dcNames.has(dc)) return { id, label: dcNames.get(dc) };
      return { id, label: vcNames.get(id) };
    }
    if (dcNames.has(id)) return { id, label: dcNames.get(id) };
  }
  return { id: '', label: '전역' };
}

/** 대상 트리 경로 — `설정 연동\<그룹>\<법인>`. */
export function syncPathOf(x, corp) {
  return `${SYNC_ROOT}\\${pathSeg(x?.group || '기타')}\\${pathSeg(corp?.label || '전역')}`;
}

/** 출처 표지 — store.cleanOrigin 이 다시 정규화한다(이 함수는 키 모양만 만든다). */
export function originOf(x, corp, now = Date.now()) {
  return { key: t(x.id), kind: t(x.kind), ref: t(x.ref), host: t(x.host), port: Number(x.port) || undefined, corp: t(corp?.label), syncedAt: now };
}

const isHttps = (x) => t(x.scheme).toLowerCase() === 'https';
const DEFAULT_PORT_OF = { https: 443, http: 80 };

/**
 * 카탈로그 항목 → 만들 점검(무인증). 순수 함수 — 같은 입력이면 같은 점검(재동기화가 tplKey 로 맞춰 고친다).
 * 인터벌: TCP 120초 · HTTP·SSH·SMTP 300초 · 인증서 1일.
 * @returns {object[]} store.cleanTest 입력 모양 + tpl/tplKey
 */
export function checksFor(x) {
  const spec = SETTING_KINDS[t(x?.kind)];
  if (!spec) return [];
  const port = Number(x.port) || spec.defaultPort || 443;
  const mk = (tplKey, o) => ({ tpl: SYNC_TPL, tplKey, enabled: true, ...o });
  const tcp = mk('tcp', { type: 'tcp', name: `TCP ${port}`, port, intervalSec: 120 });
  const cert = mk('cert', { type: 'cert', name: `인증서 만료(${port})`, port, warnDays: 30, intervalSec: 86400 });
  const mode = spec.probe?.mode;
  if (mode === 'http') {
    const scheme = isHttps(x) ? 'https' : 'http';
    // 엣지 포탈의 카탈로그 프로브(/api/collector/ping)는 포탈 토큰을 보낸다 — Monitoring 은 토큰을 싣지 않으므로 공개 상태 경로를 쓴다.
    const probePath = t(x.kind) === 'set:collector' ? '/api/health' : t(spec.probe?.path);
    const hostPart = x.host && String(x.host).includes(':') && !String(x.host).startsWith('[') ? `[${x.host}]` : t(x.host);
    const portPart = port === DEFAULT_PORT_OF[scheme] ? '' : `:${port}`;
    const url = `${scheme}://${hostPart}${portPart}${t(x.basePath)}${probePath}` || `${scheme}://${hostPart}${portPart}/`;
    const identity = spec.depth === 'identity';
    const http = mk('http', {
      type: 'http', name: `HTTP ${t(x.basePath)}${probePath || '/'}`.slice(0, 80), url: url.slice(0, 500), intervalSec: 300,
      // 인증서 **신뢰**는 이 점검의 질문이 아니다(자체서명 장비가 대부분) — 만료는 cert 점검이 본다.
      insecure: true,
      ...(identity ? { expectStatus: 200 } : {}),
      ...(t(x.kind) === 'set:collector' ? { keyword: 'status' } : {}),
    });
    return scheme === 'https' ? [tcp, cert, http] : [tcp, http];
  }
  if (mode === 'tls') return [tcp, cert];
  if (mode === 'ssh') return [mk('ssh', { type: 'ssh', name: `SSH 배너(${port})`, port, intervalSec: 300 })];
  if (mode === 'smtp') {
    // 465(암묵 TLS)는 평문 배너가 오지 않는다 — 포트 + 인증서로 본다.
    if (port === 465 || x.facts?.secure === true) return [tcp, cert];
    return [mk('smtp', { type: 'smtp', name: `SMTP 배너(${port})`, port, send: 'EHLO svcmon', intervalSec: 300 })];
  }
  if (mode === 'tcp') return port === 636 ? [tcp, cert] : [tcp];
  return [tcp];
}

/** 화면용 점검 요약(유형 · 이름). */
const checkBrief = (list) => list.map((c) => ({ type: c.type, name: c.name, port: c.port || null, url: c.url || '' }));

/**
 * 카탈로그 × Monitoring 대상 → 행 목록과 집계. **순수**(입력만 본다).
 *
 * @param {{targets:object[], problems:object[], sourceErrors:object[]}} built buildSettingsTargets() 결과
 * @param {object[]} svcTargets store.listTargets()
 * @param {{ctx?:object, candidates?:Map<string,string>, known?:Set<string>}} opts
 *   candidates: 소문자 엣지 이름 → 표기(배정 후보 — 토큰 발급 또는 보고 중) · known: 한 번이라도 연동된 키
 */
export function classifyCatalog(built = {}, svcTargets = [], { ctx = {}, candidates = new Map(), known = new Set() } = {}) {
  const linkedByKey = new Map();
  for (const st of svcTargets) {
    const k = t(st?.origin?.key);
    if (!k) continue;
    if (!linkedByKey.has(k)) linkedByKey.set(k, []);
    linkedByKey.get(k).push(st);
  }
  const failedSources = new Set((built.sourceErrors || []).map((e) => t(e?.source)).filter(Boolean));
  const present = new Set();
  const rows = [];

  const agentOf = (x) => {
    if (t(x.kind) === 'set:collector') return { agent: '', declared: '', note: '엣지 포탈은 중앙에서 잽니다(엣지가 자기 자신을 재면 회선 장애를 못 본다).' };
    const declared = t(x.agent);
    if (!declared) return { agent: '', declared: '', note: '' };
    const hit = candidates.get(declared.toLowerCase());
    return hit ? { agent: hit, declared, note: '' } : { agent: '', declared, note: `담당 엣지 '${declared}' 가 배정 후보가 아닙니다(토큰·보고 없음) — 중앙에서 잽니다.` };
  };

  const baseRow = (x, corp) => {
    const spec = SETTING_KINDS[t(x.kind)] || {};
    const ag = agentOf(x);
    return {
      key: t(x.id), kind: t(x.kind), kindLabel: spec.label || t(x.kind), group: spec.group || '기타', depth: spec.depth || '',
      settings: spec.settings || '', name: t(x.name) || t(x.ref), ref: t(x.ref),
      host: t(x.host), port: Number(x.port) || null, scheme: t(x.scheme),
      settingsEnabled: x.enabled !== false, corp: corp.label, corpId: corp.id, address: safeAddress(x.address, t(x.kind)),
      agent: ag.agent, agentDeclared: ag.declared, agentNote: ag.note,
      path: syncPathOf({ group: spec.group }, corp),
    };
  };

  for (const x of (built.targets || [])) {
    const key = t(x.id);
    if (!key) continue;
    present.add(key);
    const corp = corpOf(x, ctx);
    const row = baseRow(x, corp);
    const checks = checksFor(x);
    row.checks = checkBrief(checks);
    const linked = linkedByKey.get(key) || [];
    if (EXCLUDED_KINDS[row.kind] && !linked.length) {
      // 제외 종류는 주소·점검을 싣지 않는다(웹훅 URL 은 비밀 · 통합 계정 매핑은 관리자 전용).
      rows.push({ ...row, host: row.kind === 'set:webhook' ? '' : row.host, port: row.kind === 'set:webhook' ? null : row.port, checks: [], state: 'excluded', reason: EXCLUDED_KINDS[row.kind] });
      continue;
    }
    if (linked.length) {
      const st = linked[0];
      const o = st.origin || {};
      const hostChanged = t(st.host).toLowerCase() !== row.host.toLowerCase();
      const portChanged = !!(o.port && row.port && Number(o.port) !== row.port);
      // v2.915(반증 M3 — 재현): 사라짐으로 표지(·중지)된 대상이 설정에 다시 나타나면 '연동' 으로 두면 영구히 중지·표지가 남았다 —
      //   '변경(다시 나타남)' 으로 올려 적용이 표지를 지우고, 설정 연동이 중지한 것이었으면 다시 켠다(goneOff).
      const reappeared = !!o.gone;
      const changed = hostChanged || portChanged || reappeared;
      rows.push({
        ...row, state: changed ? 'changed' : 'linked', ...(reappeared ? { reappeared: true, reason: '설정에 다시 나타났습니다 — 적용하면 사라짐 표지를 지웁니다(설정 연동이 중지했다면 다시 켭니다).' } : {}),
        targetId: st.id, targetPath: st.path, targetName: st.name, targetEnabled: st.enabled !== false, targetAgent: t(st.agent),
        tests: Array.isArray(st.tests) ? st.tests.length : 0, syncedAt: o.syncedAt || null, ...(o.gone ? { wasGone: o.gone } : {}),
        ...(changed ? { prevHost: t(st.host), prevPort: o.port || null } : {}),
        ...(linked.length > 1 ? { dupTargets: linked.length } : {}),
      });
      continue;
    }
    const err = row.host ? validateEndpoint({ host: row.host }) : '주소가 비어 있습니다.';
    if (err) { rows.push({ ...row, state: 'problem', reason: err }); continue; }
    rows.push({ ...row, state: 'new', everLinked: known.has(key) });
  }

  // 카탈로그가 주소를 해석하지 못한 항목(설정 문제) — 연동 대상이 있으면 그 대상의 상태도 함께 싣는다.
  for (const p of (built.problems || [])) {
    const kind = t(p?.kind);
    const key = `${kind}|${t(p?.ref) || '-'}`;
    present.add(key);
    const spec = SETTING_KINDS[kind] || {};
    const linked = (linkedByKey.get(key) || [])[0];
    rows.push({
      key, kind, kindLabel: spec.label || kind, group: spec.group || '기타', depth: spec.depth || '', settings: spec.settings || '',
      name: t(p?.name) || t(p?.ref), ref: t(p?.ref), host: '', port: null, scheme: '', address: safeAddress(p?.address, kind), settingsEnabled: true,
      corp: '전역', corpId: '', agent: '', agentDeclared: '', agentNote: '', path: '', checks: [],
      state: 'problem', reason: t(p?.reason) || '주소를 해석하지 못했습니다.', ...(linked ? { targetId: linked.id, targetPath: linked.path } : {}),
    });
  }

  // 연동 대상인데 카탈로그에 없는 것 — 출처 등록부를 못 읽었으면 보류, 아니면 사라짐.
  for (const [key, list] of linkedByKey) {
    if (present.has(key)) continue;
    const st = list[0];
    const o = st.origin || {};
    const kind = t(o.kind);
    const spec = SETTING_KINDS[kind] || {};
    const held = failedSources.has(SOURCE_OF_KIND[kind] || '');
    rows.push({
      key, kind, kindLabel: spec.label || kind, group: spec.group || '기타', depth: spec.depth || '', settings: spec.settings || '',
      name: t(st.name), ref: t(o.ref), host: t(st.host), port: o.port || null, scheme: '', address: '', settingsEnabled: false,
      corp: t(o.corp) || '전역', corpId: '', agent: t(st.agent), agentDeclared: '', agentNote: '', path: t(st.path), checks: [],
      targetId: st.id, targetPath: st.path, targetName: st.name, targetEnabled: st.enabled !== false, tests: (st.tests || []).length,
      syncedAt: o.syncedAt || null, state: held ? 'held' : 'gone',
      reason: held ? `출처 등록부(${SOURCE_OF_KIND[kind]})를 읽지 못해 판정을 보류합니다 — 사라졌다고 단정하지 않습니다.`
        : (o.gone ? '설정에서 사라져 중지 표지가 붙어 있습니다.' : '설정에서 사라졌습니다 — 대상은 남아 있습니다.'),
      ...(o.gone ? { goneAt: o.gone } : {}),
    });
  }

  rows.sort((a, b) => {
    const ga = GROUP_ORDER.indexOf(a.group); const gb = GROUP_ORDER.indexOf(b.group);
    return (ga < 0 ? 99 : ga) - (gb < 0 ? 99 : gb) || a.kindLabel.localeCompare(b.kindLabel) || a.corp.localeCompare(b.corp) || a.name.localeCompare(b.name);
  });
  return { rows, counts: countsOf(rows) };
}

/** 상태별 · 종류별 집계(화면 Query Value · 커버리지 Top List · 패싯이 같은 값을 쓴다). */
export function countsOf(rows = []) {
  const c = { total: rows.length };
  for (const s of SYNC_STATES) c[s] = 0;
  const byKind = {};
  for (const r of rows) {
    c[r.state] = (c[r.state] || 0) + 1;
    const k = byKind[r.kind] || (byKind[r.kind] = { kind: r.kind, label: r.kindLabel, group: r.group, total: 0, linked: 0 });
    if (r.state === 'gone' || r.state === 'held') continue;   // 설정에 없는 행은 커버리지 분모에 넣지 않는다
    k.total += 1;
    if (r.state === 'linked' || r.state === 'changed') k.linked += 1;
  }
  // 아직 처리하지 않은 사라짐(표지 없음) — 배너는 이것만 센다(중지 처리한 뒤에도 계속 뜨지 않게 — 반증 낮음).
  c.goneOpen = rows.filter((r) => r.state === 'gone' && !r.goneAt).length;
  const denom = rows.filter((r) => r.state !== 'gone' && r.state !== 'held' && r.state !== 'excluded').length;
  c.coveragePct = denom ? Math.round(((c.linked + c.changed) / denom) * 1000) / 10 : null;
  c.byKind = Object.values(byKind).sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  return c;
}

/* ───────────────────────────── 상태 파일 ───────────────────────────── */

const MAX_KNOWN = 20000;
const DAILY_KEEP = 30;

let _state = null;
function emptyState() { return { version: 1, options: { autoKinds: [] }, known: {}, seen: {}, baselineAt: 0, ackAt: 0, daily: [] }; }
function loadState() {
  if (_state) return _state;
  try {
    if (fs.existsSync(FILE())) {
      const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('형식 오류');
      _state = {
        version: 1,
        options: { autoKinds: cleanAutoKinds(raw.options?.autoKinds) },
        known: raw.known && typeof raw.known === 'object' && !Array.isArray(raw.known) ? raw.known : {},
        // 배너의 '새 항목' 기준 — 키를 처음 본 시각 · 첫 감지 시각(그때 있던 것은 '새' 가 아니다) · 사람이 '확인' 한 시각.
        seen: raw.seen && typeof raw.seen === 'object' && !Array.isArray(raw.seen) ? raw.seen : {},
        baselineAt: Number(raw.baselineAt) || 0,
        ackAt: Number(raw.ackAt) || 0,
        daily: Array.isArray(raw.daily) ? raw.daily.filter((d) => d && typeof d.day === 'string').slice(-DAILY_KEEP) : [],
      };
      return _state;
    }
  } catch (e) { preserveCorrupt(FILE(), e?.message); }
  _state = emptyState();
  return _state;
}
function saveState() {
  try { atomicWriteFileSync(FILE(), JSON.stringify(loadState())); return true; }
  catch (e) { console.warn('[svcmon] 설정 연동 상태 저장 실패:', e?.message); return false; }
}
/** 자동 등록 종류 — 카탈로그에 있고 제외 목록이 아닌 것만. */
export function cleanAutoKinds(v) {
  return [...new Set((Array.isArray(v) ? v : []).map(t).filter((k) => SETTING_KINDS[k] && !EXCLUDED_KINDS[k]))].slice(0, 64);
}
export function getOptions() { return { autoKinds: [...loadState().options.autoKinds] }; }
export function setOptions(input = {}) {
  const st = loadState();
  st.options = { autoKinds: cleanAutoKinds(input.autoKinds) };
  const saved = saveState();
  return { ...getOptions(), saved };
}
function markKnown(keys, now = Date.now()) {
  const st = loadState();
  for (const k of keys) if (k) st.known[k] = now;
  const ks = Object.keys(st.known);
  if (ks.length > MAX_KNOWN) {
    ks.sort((a, b) => st.known[a] - st.known[b]);
    for (const k of ks.slice(0, ks.length - MAX_KNOWN)) delete st.known[k];
  }
}
export function knownKeys() { return new Set(Object.keys(loadState().known)); }

/* ───────────────────────────── 메모리 이력 ───────────────────────────── */

const RING_SLOTS = 288;          // 24시간 × 5분
const EVENT_MAX = 100;
let _ring = [];                  // [{ at, new, changed, gone, held, problem, linked }]
let _events = [];                // [{ at, kind:'drift'|'gone'|'apply'|'auto', text }]
let _last = null;                // { at, ms, counts, sourceErrors }
let _prevKeys = null;            // { new:Set, changed:Set, gone:Set }

export function pushEvent(ev) {
  _events.push({ at: Date.now(), ...ev, text: t(ev?.text).slice(0, 400) });
  if (_events.length > EVENT_MAX) _events.splice(0, _events.length - EVENT_MAX);
}
export function syncEvents() { return _events.slice().reverse(); }
export function driftRing() { return _ring.slice(); }
export function dailySummary() { return loadState().daily.slice(); }
/**
 * /svcmon/state 배너용 — 수만(이름·주소 없음). 아직 한 번도 감지하지 않았으면 null.
 * ⚠ `new` 는 '미등록 전부' 가 아니라 **기준점(첫 감지 · 마지막 확인) 이후 설정에 새로 생긴 미등록 항목** 이다 — 미등록은 변경이 아니다
 *   (Chromium 실측: 기준점 없이 미등록 258건을 '설정이 바뀌었습니다' 로 띄웠다). 주소 변경·사라짐은 연동 대상의 불일치라 늘 센다.
 */
export function driftSummary() {
  if (!_last) return null;
  const c = _last.counts || {};
  return { at: _last.at, new: newSinceCount(), unregistered: c.new || 0, changed: c.changed || 0, gone: c.goneOpen ?? c.gone ?? 0, held: c.held || 0 };
}
let _lastNewKeys = [];
function newSinceCount() {
  const st = loadState();
  const floor = Math.max(st.baselineAt || 0, st.ackAt || 0);
  return _lastNewKeys.filter((k) => (st.seen[k] || 0) > floor).length;
}
/** 배너 '확인' — 지금까지 생긴 새 항목을 본 것으로 둔다(미등록 상태는 그대로 — 설정 연동 탭에서 계속 보인다). */
export function ackDrift(now = Date.now()) {
  const st = loadState();
  st.ackAt = now;
  return { saved: saveState(), ackAt: now };
}
export function lastDetection() { return _last ? { ..._last } : null; }

const keysOf = (rows, state) => new Set(rows.filter((r) => r.state === state).map((r) => r.key));
const namesOf = (rows, keys, n = 4) => {
  const out = rows.filter((r) => keys.has(r.key)).slice(0, n).map((r) => `${r.kindLabel} ${r.name}`);
  return out.join(' · ') + (keys.size > n ? ` 외 ${keys.size - n}` : '');
};

/**
 * 감지 결과를 이력에 반영한다(링버퍼 · 이벤트 · 일별 요약). 순수에 가깝다 — 파일 쓰기는 일별 요약이 바뀔 때만.
 * @returns {{newKeys:Set, changedKeys:Set, goneKeys:Set}} 이번에 **새로** 나타난 키(이벤트 근거)
 */
export function noteDetection(result, { at = Date.now(), ms = 0, sourceErrors = [] } = {}) {
  const rows = result?.rows || [];
  const counts = result?.counts || countsOf(rows);
  _last = { at, ms, counts: { ...counts, byKind: undefined }, sourceErrors: sourceErrors.slice(0, 20) };
  _ring.push({ at, new: counts.new || 0, changed: counts.changed || 0, gone: counts.gone || 0, held: counts.held || 0, linked: counts.linked || 0 });
  if (_ring.length > RING_SLOTS) _ring.splice(0, _ring.length - RING_SLOTS);
  const cur = { new: keysOf(rows, 'new'), changed: keysOf(rows, 'changed'), gone: keysOf(rows, 'gone') };
  const fresh = { newKeys: new Set(), changedKeys: new Set(), goneKeys: new Set() };
  if (_prevKeys) {
    for (const k of cur.new) if (!_prevKeys.new.has(k)) fresh.newKeys.add(k);
    for (const k of cur.changed) if (!_prevKeys.changed.has(k)) fresh.changedKeys.add(k);
    for (const k of cur.gone) if (!_prevKeys.gone.has(k)) fresh.goneKeys.add(k);
    const parts = [];
    if (fresh.newKeys.size) parts.push(`새 항목 ${fresh.newKeys.size} (${namesOf(rows, fresh.newKeys)})`);
    if (fresh.changedKeys.size) parts.push(`주소 변경 ${fresh.changedKeys.size} (${namesOf(rows, fresh.changedKeys)})`);
    if (fresh.goneKeys.size) parts.push(`설정에서 사라짐 ${fresh.goneKeys.size} (${namesOf(rows, fresh.goneKeys)})`);
    if (parts.length) pushEvent({ kind: fresh.goneKeys.size ? 'gone' : 'drift', text: `감지 — ${parts.join(' · ')} · 카탈로그 ${ms}ms` });
  }
  _prevKeys = cur;
  // 처음 본 시각 — 첫 감지 때 있던 키는 기준점(baselineAt)과 같아 '새 항목' 으로 세지 않는다.
  const st = loadState();
  let seenDirty = false;
  if (!st.baselineAt) { st.baselineAt = at; seenDirty = true; }
  for (const r of rows) {
    if (r.state === 'gone' || r.state === 'held' || !r.key || st.seen[r.key]) continue;
    st.seen[r.key] = at; seenDirty = true;
  }
  const sk = Object.keys(st.seen);
  if (sk.length > MAX_KNOWN) { sk.sort((a, b) => st.seen[a] - st.seen[b]); for (const k of sk.slice(0, sk.length - MAX_KNOWN)) delete st.seen[k]; }
  _lastNewKeys = [...cur.new];
  // 일별 요약(스파크라인 30일) — 그날의 마지막 감지 값으로 덮어쓴다.
  const day = dayKey(at);
  const entry = { day, total: counts.total || 0, linked: (counts.linked || 0) + (counts.changed || 0), new: counts.new || 0, changed: counts.changed || 0, gone: counts.gone || 0 };
  const lastEntry = st.daily[st.daily.length - 1];
  const same = lastEntry && lastEntry.day === day && ['total', 'linked', 'new', 'changed', 'gone'].every((k) => lastEntry[k] === entry[k]);
  if (!same) {
    if (lastEntry && lastEntry.day === day) st.daily[st.daily.length - 1] = entry;
    else st.daily.push(entry);
    if (st.daily.length > DAILY_KEEP) st.daily.splice(0, st.daily.length - DAILY_KEEP);
  }
  if (!same || seenDirty) saveState();
  return fresh;
}

/** 테스트 전용 — 메모리 이력·캐시 초기화. */
export function _resetSettingsSyncForTest() { _state = null; _ring = []; _events = []; _last = null; _prevKeys = null; _lastNewKeys = []; }

/* ───────────────────────────── 카탈로그 읽기(입출력) ───────────────────────────── */

/**
 * 카탈로그 + 문맥(법인 이름 · 배정 후보)을 읽어 분류한다. 네트워크 왕복 없음.
 * @param {{build?:Function, ctx?:object, candidates?:Map}} deps 테스트 주입
 */
export async function readCatalog(deps = {}) {
  const t0 = Date.now();
  const build = deps.build || (async () => (await import('../linkcheck/settingsLinks.js')).buildSettingsTargets());
  const built = await build();
  const ctx = deps.ctx || await loadCorpContext();
  const candidates = deps.candidates || await loadCandidates();
  const result = classifyCatalog(built, deps.svcTargets || listTargets(), { ctx, candidates, known: knownKeys() });
  return { ...result, sourceErrors: built.sourceErrors || [], ms: Date.now() - t0, at: Date.now() };
}

async function loadCorpContext() {
  const vcNames = new Map(); const dcNames = new Map(); const dcOfVc = new Map();
  try { for (const v of (await import('../vcenter/registry.js')).listRegistry()) if (t(v.id)) vcNames.set(t(v.id), t(v.name) || t(v.id)); } catch { /* 이름 없이 진행 */ }
  try {
    const dc = await import('../datacenter/store.js');
    for (const d of dc.listDatacenters()) if (t(d.id)) dcNames.set(t(d.id), t(d.name) || t(d.id));
    for (const id of vcNames.keys()) { const x = t(dc.datacenterOfVcenter(id)); if (x) dcOfVc.set(id, x); }
  } catch { /* DataCenter 없이 진행 */ }
  return { vcNames, dcNames, dcOfVc };
}

/** 배정 후보 엣지 — 개별 토큰이 발급됐거나 보고 중인 엣지(routes/svcmon/edge.js candidates 와 같은 합집합). */
export async function loadCandidates() {
  const m = new Map();
  try { for (const x of (await import('../central/agentTokens.js')).listAgentTokens()) if (t(x.agent)) m.set(t(x.agent).toLowerCase(), t(x.agent)); } catch { /* 없음 */ }
  try { for (const e of (await import('../central/svcmonEdge.js')).edgeSummary()) if (t(e.agent)) m.set(t(e.agent).toLowerCase(), t(e.agent)); } catch { /* 없음 */ }
  return m;
}

/* ───────────────────────────── 미리보기 · 적용 ───────────────────────────── */

const APPLY_STATES = new Set(['new', 'changed', 'gone']);
export const GONE_ACTIONS = Object.freeze(['disable', 'keep', 'delete']);

/**
 * 고른 키 → 실행 계획(저장 없음). 서버가 **지금** 다시 분류한 행으로만 판정한다(화면이 본 상태를 믿지 않는다).
 * @param {object[]} rows classifyCatalog().rows
 * @param {string[]} keys
 * @param {{enabled?:boolean, goneAction?:string, withChecks?:boolean, builtByKey?:Map}} o
 */
export function planApply(rows, keys, { enabled = false, goneAction = 'disable', withChecks = true, builtByKey = new Map(), now = Date.now() } = {}) {
  const want = new Set((Array.isArray(keys) ? keys : []).map(t).filter(Boolean));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const add = []; const change = []; const gone = []; const skip = [];
  for (const k of want) {
    const r = byKey.get(k);
    if (!r) { skip.push({ key: k, name: '', reason: '카탈로그에 없습니다(새로 고친 뒤 다시 고르세요).' }); continue; }
    if (!APPLY_STATES.has(r.state)) { skip.push({ key: k, name: r.name, reason: r.state === 'linked' ? '이미 연동돼 있습니다.' : (r.reason || `상태 ${r.state} — 적용 대상이 아닙니다.`) }); continue; }
    const x = builtByKey.get(k);
    if (r.state === 'new') {
      if (!x) { skip.push({ key: k, name: r.name, reason: '카탈로그 항목을 다시 읽지 못했습니다.' }); continue; }
      add.push({
        key: k, name: r.name, kindLabel: r.kindLabel, path: r.path, host: r.host, port: r.port, agent: r.agent,
        row: {
          kind: 'infra', path: r.path, name: r.name.slice(0, 120), host: r.host, enabled, ...(r.agent ? { agent: r.agent } : {}),
          tests: withChecks ? checksFor(x) : [], origin: originOf(x, { label: r.corp }, now),
        },
      });
    } else if (r.state === 'changed') {
      if (!x) { skip.push({ key: k, name: r.name, reason: '카탈로그 항목을 다시 읽지 못했습니다.' }); continue; }
      change.push({ key: k, name: r.name, kindLabel: r.kindLabel, targetId: r.targetId, prevHost: r.prevHost, prevPort: r.prevPort, host: r.host, port: r.port, x, corp: r.corp });
    } else if (r.state === 'gone') {
      gone.push({ key: k, name: r.name, kindLabel: r.kindLabel, targetId: r.targetId, action: GONE_ACTIONS.includes(goneAction) ? goneAction : 'disable' });
    }
  }
  return { add, change, gone, skip };
}

/** 계획을 미리보기 응답 모양으로(내부 x·row 를 싣지 않는다). */
export function previewOf(plan, bulkPlan = null) {
  return {
    add: plan.add.map((a) => ({ key: a.key, name: a.name, kindLabel: a.kindLabel, path: a.path, host: a.host, port: a.port, agent: a.agent, checks: checkBrief(a.row.tests) })),
    change: plan.change.map((c) => ({ key: c.key, name: c.name, kindLabel: c.kindLabel, targetId: c.targetId, prevHost: c.prevHost, prevPort: c.prevPort, host: c.host, port: c.port })),
    gone: plan.gone.map((g) => ({ key: g.key, name: g.name, kindLabel: g.kindLabel, targetId: g.targetId, action: g.action })),
    skip: plan.skip.slice(0, 500),
    ...(bulkPlan ? {
      errors: bulkPlan.errors.slice(0, 200), over: bulkPlan.over, bulkSkipped: bulkPlan.skipped.slice(0, 200),
      newTests: bulkPlan.newTests, newFolders: bulkPlan.newFolders,
    } : {}),
  };
}

/**
 * 계획 실행. 추가는 대량 등록(전부 성공 또는 전부 취소) · 변경·사라짐은 대상별로 하고 결과를 그대로 보고한다(부분 실패를 숨기지 않는다).
 * @returns {{batch:string, added:number, addErrors:object[], addSkipped:object[], changed:object[], gone:object[], errors:object[], agents:string[]}}
 */
export function executePlan(plan, { user = '', now = Date.now(), batchPrefix = 'settings' } = {}) {
  const batch = `${batchPrefix}:${fileStamp(now)}${String(Math.floor((now / 1000) % 60)).padStart(2, '0')}`.slice(0, 40);
  const out = { batch, added: 0, newTests: 0, addErrors: [], addSkipped: [], changed: [], gone: [], errors: [], agents: [], committed: true };
  if (plan.add.length) {
    const r = bulkAddTargets(plan.add.map((a) => a.row), { atomic: true, dedup: true, batch, trustedOrigin: true });
    out.committed = r.committed;
    out.added = r.added; out.newTests = r.newTests; out.addErrors = r.errors.slice(0, 200); out.addSkipped = r.skipped.slice(0, 200);
    if (r.committed && r.added) {
      markKnown(plan.add.map((a) => a.key), now);
      out.agents = [...new Set(plan.add.map((a) => a.row.agent).filter(Boolean))];
    }
  }
  for (const c of plan.change) {
    try {
      const cur = getTarget(c.targetId);
      if (!cur) { out.errors.push({ key: c.key, name: c.name, reason: '대상이 이미 지워졌습니다.' }); continue; }
      const origin = { ...(cur.origin || {}), ...originOf(c.x, { label: c.corp }, now) };
      const reEnable = !!(cur.origin?.gone && cur.origin?.goneOff);
      delete origin.gone; delete origin.goneOff;
      updateTarget(c.targetId, { host: c.host, ...(reEnable ? { enabled: true } : {}) }, { origin });
      // 설정 연동이 만든 점검(tpl='settings')만 tplKey 로 맞춰 고친다 — id 를 승계해 연속 횟수·만기가 리셋되지 않는다.
      const specs = new Map(checksFor(c.x).map((s) => [s.tplKey, s]));
      let fixed = 0; let added = 0;
      for (const test of (getTarget(c.targetId)?.tests || [])) {
        if (test.tpl !== SYNC_TPL) continue;
        const s = specs.get(test.tplKey);
        if (!s) continue;
        // 주소에 묶인 칸(포트·URL)만 고친다 — 사람이 바꾼 사용 여부·주기·이름·임계는 그대로(반증 낮음: 예전에는 전부 덮어썼다).
        updateTest(c.targetId, test.id, Object.fromEntries(Object.entries({ port: s.port, url: s.url }).filter(([, v]) => v !== undefined)));
        specs.delete(test.tplKey);
        fixed += 1;
      }
      for (const s of specs.values()) {
        if ((getTarget(c.targetId)?.tests || []).some((x) => x.tpl === SYNC_TPL && x.tplKey === s.tplKey)) continue;
        addTest(c.targetId, s); added += 1;
      }
      out.changed.push({ key: c.key, name: c.name, targetId: c.targetId, from: `${c.prevHost}${c.prevPort ? `:${c.prevPort}` : ''}`, to: `${c.host}${c.port ? `:${c.port}` : ''}`, testsUpdated: fixed, testsAdded: added });
      if (cur.agent) out.agents.push(cur.agent);
    } catch (e) { out.errors.push({ key: c.key, name: c.name, reason: String(e?.message || e).slice(0, 200) }); }
  }
  for (const g of plan.gone) {
    try {
      const cur = getTarget(g.targetId);
      if (!cur) { out.errors.push({ key: g.key, name: g.name, reason: '대상이 이미 지워졌습니다.' }); continue; }
      if (g.action === 'delete') { deleteTarget(g.targetId); out.gone.push({ key: g.key, name: g.name, action: 'delete' }); }
      else {
        const origin = { ...(cur.origin || {}), gone: now, ...(g.action === 'disable' && cur.enabled !== false ? { goneOff: 1 } : {}) };
        updateTarget(g.targetId, g.action === 'disable' ? { enabled: false } : {}, { origin });
        out.gone.push({ key: g.key, name: g.name, action: g.action });
      }
      if (cur.agent) out.agents.push(cur.agent);
    } catch (e) { out.errors.push({ key: g.key, name: g.name, reason: String(e?.message || e).slice(0, 200) }); }
  }
  out.agents = [...new Set(out.agents)];
  saveState();
  const parts = [];
  if (out.added) parts.push(`추가 ${out.added}(점검 ${out.newTests})`);
  if (out.changed.length) parts.push(`주소 반영 ${out.changed.length}`);
  if (out.gone.length) parts.push(`사라짐 처리 ${out.gone.length}`);
  if (!out.committed) parts.push(`추가 취소(오류 ${out.addErrors.length})`);
  if (out.errors.length) parts.push(`실패 ${out.errors.length}`);
  pushEvent({ kind: batchPrefix === 'settings-auto' ? 'auto' : 'apply', text: `배치 ${batch} — ${parts.join(' · ') || '변경 없음'}${user ? ` · by ${user}` : ''}` });
  return out;
}

/** 출처 해제 — 대상은 그대로 두고 '수동 대상' 으로 바꾼다(다음 동기화가 건드리지 않는다). */
export function detachTarget(id) {
  const cur = getTarget(id);
  if (!cur) return null;
  if (!cur.origin) return { target: cur, changed: false };
  const next = updateTarget(id, {}, { origin: null });
  pushEvent({ kind: 'apply', text: `연동 해제 — ${cur.name} (${cur.origin.key})` });
  return { target: next, changed: true };
}

/** 종류 메타(화면 패싯 라벨 · 설정 화면 링크 · 제외 사유). */
export function kindMeta() {
  const out = {};
  for (const [k, v] of Object.entries(SETTING_KINDS)) {
    out[k] = {
      label: v.label, group: v.group, depth: v.depth, depthLabel: DEPTH_LABEL[v.depth] || v.depth,
      settingsHash: SETTINGS_PATHS[v.settings]?.hash || '', settingsLabel: SETTINGS_PATHS[v.settings]?.label || '',
      excluded: EXCLUDED_KINDS[k] || '',
    };
  }
  return out;
}

/* ───────────────────────────── 주기 감지 ───────────────────────────── */

export const DETECT_INTERVAL_MS = 5 * 60_000;
const FIRST_DELAY_MS = 60_000;
let _timer = null;
let _running = false;

/** 감지 1회 — 카탈로그 읽기 + 이력 반영 + (켰으면) 자동 등록. 진행 중이면 건너뛴다. */
export async function detectOnce(deps = {}) {
  if (_running) return null;
  _running = true;
  try {
    const cat = await readCatalog(deps);
    noteDetection(cat, { at: cat.at, ms: cat.ms, sourceErrors: cat.sourceErrors });
    const auto = new Set(getOptions().autoKinds);
    if (auto.size) {
      const known = knownKeys();
      const keys = cat.rows.filter((r) => r.state === 'new' && auto.has(r.kind) && !known.has(r.key)).map((r) => r.key).slice(0, MAX_APPLY);
      if (keys.length) {
        const built = await (deps.build || (async () => (await import('../linkcheck/settingsLinks.js')).buildSettingsTargets()))();
        const builtByKey = new Map((built.targets || []).map((x) => [t(x.id), x]));
        // 자동 등록은 언제나 '중지' 로 — 사람이 확인하고 켠다(대량 등록 마법사의 기본과 같다).
        const plan = planApply(cat.rows, keys, { enabled: false, builtByKey });
        if (plan.add.length) {
          const r = executePlan({ add: plan.add, change: [], gone: [], skip: [] }, { user: 'auto', batchPrefix: 'settings-auto' });
          try {
            const { recordBatch } = await import('./batches.js');
            if (r.added) recordBatch({ id: r.batch, createdBy: 'auto', source: 'settings', kind: 'infra', path: SYNC_ROOT, targets: r.added, tests: r.newTests, note: '설정 연동 자동 등록(중지 상태)' });
          } catch { /* 원장은 부가 정보 */ }
        }
      }
    }
    return cat;
  } catch (e) {
    console.warn('[svcmon] 설정 연동 감지 실패:', e?.message || e);
    return null;
  } finally { _running = false; }
}

/** 감지 타이머 — 엣지 노드(CENTRAL_URL)는 돌리지 않는다(엣지 svcmon 대상은 중앙 배정 사본이다). */
export function startSettingsSyncDetector() {
  if (_timer) return;
  if (String(config.agent?.centralUrl || '').trim()) return;
  const first = setTimeout(() => { detectOnce().catch(() => {}); }, FIRST_DELAY_MS);
  first.unref?.();
  _timer = setInterval(() => { detectOnce().catch(() => {}); }, DETECT_INTERVAL_MS);
  _timer.unref?.();
}
/** 이 노드에서 설정 연동을 쓸 수 있는가(엣지 노드는 409). */
export function syncAvailableHere() { return !String(config.agent?.centralUrl || '').trim(); }

export { cleanOrigin };
