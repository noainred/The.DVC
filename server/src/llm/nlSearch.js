/**
 * Natural-language infrastructure search. The LLM only translates the user's
 * question into a structured query (entity + filters); the query then runs
 * against the locally collected snapshot. Degrades to a rule-based parser when
 * the LLM is disabled/unavailable.
 */

import { store } from '../store.js';
import { REGIONS } from '../util/regions.js'; // v2.575 IMP-10 — 단일 소스
import { loadLlmConfig } from './config.js';
import { ollamaGenerate } from './ollama.js';
import { acquireLlmSlot, llmBusyError } from './limit.js'; // 결정(56~75 남긴 것) 67: LLM 동시 실행 상한

const PLURAL = { vm: 'vms', host: 'hosts', datastore: 'datastores', network: 'networks' };

// Filterable fields per entity (also drives the LLM prompt). 'region', 'ip',
// 'tag' are virtual fields resolved specially in testFilter().
const SCHEMA = {
  vm: {
    label: '가상머신',
    fields: {
      name: 'string', region: '아시아|중국|유럽|북미', vcenterId: 'string', host: 'string', cluster: 'string',
      guestOS: 'string', powerState: 'POWERED_ON|POWERED_OFF', cpuCount: 'number', memMB: 'number(MB)', storageGB: 'number',
      cpuUsagePct: 'number(0-100)', memUsagePct: 'number(0-100)', toolsStatus: 'string',
      snapshotCount: 'number', snapshotSizeGB: 'number', ip: 'IP 포함검색', tag: '태그 포함검색',
    },
  },
  host: {
    label: '호스트',
    fields: {
      name: 'string', region: '아시아|중국|유럽|북미', vcenterId: 'string', cluster: 'string',
      connectionState: 'CONNECTED|MAINTENANCE|DISCONNECTED', powerState: 'POWERED_ON|POWERED_OFF',
      cpuCores: 'number', cpuUsagePct: 'number(0-100)', memTotalMB: 'number', memUsagePct: 'number(0-100)',
      version: 'string(ESXi)', vendor: 'string', model: 'string', vmCount: 'number', powerWatts: 'number',
    },
  },
  datastore: {
    label: '데이터스토어',
    fields: { name: 'string', region: '아시아|중국|유럽|북미', vcenterId: 'string', type: 'VMFS|NFS|vSAN', capacityGB: 'number', freeGB: 'number', usagePct: 'number(0-100)' },
  },
  network: {
    label: '네트워크',
    fields: { name: 'string', region: '아시아|중국|유럽|북미', vcenterId: 'string', type: 'string', vlan: 'number' },
  },
};

function schemaText() {
  return Object.entries(SCHEMA).map(([e, def]) =>
    `- ${e}(${def.label}): ${Object.entries(def.fields).map(([f, t]) => `${f}[${t}]`).join(', ')}`).join('\n');
}

function buildPrompt(query) {
  return `너는 VMware 인프라 검색 질의 변환기다. 사용자의 한국어 질문을 아래 스키마에 맞는 JSON 쿼리로 변환해라. 설명 없이 JSON만 출력한다.

엔티티/필드:
${schemaText()}

연산자(op): eq, ne, gt, gte, lt, lte, contains, in

출력 JSON 형식:
{"entity":"vm","filters":[{"field":"memUsagePct","op":"gt","value":90}],"match":"all","sort":{"field":"memUsagePct","dir":"desc"},"limit":50}

규칙:
- region 값은 아시아/중국/유럽/북미 중 하나.
- 퍼센트/숫자 임계값은 number로. "90% 넘는"=gt 90, "이하"=lte.
- 이름/문자 부분일치는 op=contains.
- match는 모든 조건이면 "all", 하나라도면 "any".

질문: "${query}"
JSON:`;
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('LLM 응답에서 JSON을 찾지 못했습니다.');
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * 116회차 F3(재현 — 가짜 LLM 응답): LLM 이 준 질의의 **모양을 검증**한다. 예전에는 받은 JSON 을 그대로 실행하고 그대로 응답에 실었다 —
 *  ① `filters` 가 목록이 아니면(조건 하나를 객체로 준 흔한 꼴) 조건을 **조용히 버리고 전량**을 'LLM 해석' 결과로 줬고, 응답의 filters 가 객체라
 *     화면(AiSearch 의 filters.map)이 TypeError 를 던지는 모양이었다(목록 안의 null 도 같다 — f.field)
 *  ② 모르는 엔티티('hosts' · 'Host')를 말없이 가상머신으로 바꿔 찾았다
 *  ③ 모르는 연산자('>')는 `eq` 로 읽었고(> 30 이 = 30 이 됐다), 스키마에 없는 필드는 '0개 검색됨' 이 됐다
 *  ④ 조건 수 · 값 길이에 상한이 없었다(조건 수 × 인벤토리 수만큼 동기 비교).
 * 이제 스키마(SCHEMA)에 맞는 질의만 실행한다 — 엔티티의 대소문자 · 복수형과 연산자 기호(> >= < <= = !=)는 받아 주고, 조건 하나를 객체로 준 것은
 * 목록으로 감싼다. 그 밖은 던진다(부르는 쪽이 규칙 기반 폴백으로 돌리고 사유를 llmError 로 밝힌다 — 틀린 해석을 결과처럼 주지 않는다).
 * 실행 범위는 예전과 같다: 이 질의는 **이미 사용자 범위(allowed)로 자른 스냅샷** 위에서만 돈다(runQuery) — 모델 출력은 범위 · 권한을 바꾸지 못한다.
 */
export const NL_FILTERS_MAX = 20;
export const NL_VALUE_MAX = 200;
export const NL_IN_MAX = 50;
const NL_OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in']);
const NL_OP_ALIAS = new Map([['=', 'eq'], ['==', 'eq'], ['!=', 'ne'], ['<>', 'ne'], ['>', 'gt'], ['>=', 'gte'], ['<', 'lt'], ['<=', 'lte']]);
/** 값이 아니라 판정으로 푸는 필드(testFilter) — 크기 비교는 뜻이 없다. */
const NL_VIRTUAL = new Set(['region', 'ip', 'tag']);
const NL_VIRTUAL_OPS = new Set(['eq', 'ne', 'contains', 'in']);

export function normalizeLlmQuery(raw) {
  const bad = (m) => { const e = new Error(`LLM 응답 형식 오류 — ${m}`); e.code = 'llm-bad-query'; return e; };
  const short = (v) => (typeof v === 'string' ? v.slice(0, 40) : `${typeof v} 값`);   // 글자가 아닌 값은 종류만(큰 값을 글자로 바꾸지 않는다)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('JSON 객체가 아닙니다');
  let entity = typeof raw.entity === 'string' ? raw.entity.trim().toLowerCase() : '';
  if (!Object.hasOwn(SCHEMA, entity) && entity.endsWith('s') && Object.hasOwn(SCHEMA, entity.slice(0, -1))) entity = entity.slice(0, -1);
  if (!Object.hasOwn(SCHEMA, entity)) throw bad(`모르는 검색 대상(${short(raw.entity)})`);
  const fields = SCHEMA[entity].fields;
  let list = raw.filters == null ? [] : raw.filters;
  if (!Array.isArray(list)) {
    if (list && typeof list === 'object' && typeof list.field === 'string') list = [list];
    else throw bad('filters 가 목록이 아닙니다');
  }
  if (list.length > NL_FILTERS_MAX) throw bad(`조건이 너무 많습니다(${list.length}개 · 최대 ${NL_FILTERS_MAX}개)`);
  const prim = (v) => (typeof v === 'string' ? v.length <= NL_VALUE_MAX : typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)));
  const filters = list.map((f) => {
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw bad('조건이 객체가 아닙니다');
    const field = typeof f.field === 'string' ? f.field.trim() : '';
    if (!Object.hasOwn(fields, field)) throw bad(`스키마에 없는 필드(${short(f.field)})`);
    const opRaw = f.op == null ? 'eq' : String(f.op).trim().toLowerCase().slice(0, 20);
    const op = NL_OPS.has(opRaw) ? opRaw : NL_OP_ALIAS.get(opRaw);
    if (!op) throw bad(`모르는 연산자(${opRaw})`);
    if (NL_VIRTUAL.has(field) && !NL_VIRTUAL_OPS.has(op)) throw bad(`${field} 에는 쓸 수 없는 연산자(${op})`);
    let value = f.value;
    if (op === 'in') {
      if (!Array.isArray(value)) value = [value];
      if (!value.length || value.length > NL_IN_MAX || !value.every(prim)) throw bad(`${field} 의 값 목록이 올바르지 않습니다`);
    } else if (!prim(value)) throw bad(`${field} 의 값이 없거나 올바르지 않습니다`);
    return { field, op, value };
  });
  let sort = null;
  if (raw.sort && typeof raw.sort === 'object' && !Array.isArray(raw.sort) && raw.sort.field != null && raw.sort.field !== '') {
    const sf = typeof raw.sort.field === 'string' ? raw.sort.field.trim() : '';
    if (!Object.hasOwn(fields, sf) || NL_VIRTUAL.has(sf)) throw bad(`정렬할 수 없는 필드(${short(raw.sort.field)})`);
    sort = { field: sf, dir: String(raw.sort.dir).trim().toLowerCase() === 'desc' ? 'desc' : 'asc' };
  }
  return { entity, filters, match: raw.match === 'any' ? 'any' : 'all', sort, limit: raw.limit };
}

const num = (v) => (v == null || v === '' ? NaN : Number(v));

/**
 * 116회차 F4(재현): 가상 필드(region · ip · tag)는 연산자를 **보지 않았다** — '북미가 아닌 호스트'(region ne 북미)가 북미 호스트만 줬고,
 * `in`(['아시아','유럽'])은 배열을 글자로 바꿔 아무것도 맞지 않았다. eq · contains = 맞음 · ne = 맞지 않음 · in = 값 중 하나라도 맞음.
 */
function virtualHit(item, field, value, regionIds) {
  if (field === 'region') return regionIds(value).has(item.vcenterId);
  if (field === 'ip') {
    const ips = item.ipAddresses?.length ? item.ipAddresses : (item.ipAddress ? [item.ipAddress] : []);
    return ips.some((ip) => String(ip).includes(value));
  }
  return (item.tags || []).some((t) => String(t).toLowerCase().includes(String(value).toLowerCase()));
}

function testFilter(item, f, regionIds) {
  const { field, op = 'eq', value } = f || {};
  if (field === 'region' || field === 'ip' || field === 'tag') {
    if (op === 'in') return Array.isArray(value) && value.some((x) => virtualHit(item, field, x, regionIds));
    const hit = virtualHit(item, field, value, regionIds);
    return op === 'ne' ? !hit : hit;
  }
  const v = item[field];
  switch (op) {
    case 'gt': return num(v) > num(value);
    case 'gte': return num(v) >= num(value);
    case 'lt': return num(v) < num(value);
    case 'lte': return num(v) <= num(value);
    case 'ne': return String(v).toLowerCase() !== String(value).toLowerCase();
    case 'contains': return String(v ?? '').toLowerCase().includes(String(value).toLowerCase());
    case 'in': return Array.isArray(value) && value.map(String).includes(String(v));
    case 'eq':
    default:
      if (typeof v === 'number' || !Number.isNaN(num(value))) return num(v) === num(value);
      return String(v ?? '').toLowerCase() === String(value).toLowerCase();
  }
}

/*
 * v2.632(감사 AX2-2632-06): 정렬 비교기. 값이 없는 항목(null·undefined·''·NaN)은 **방향과 무관하게 항상 뒤로**
 *   (STable 과 같은 규약). 예전엔 String(null)='null' 을 숫자 문자열과 localeCompare 해 내림차순에서 맨 앞에 와,
 *   '사용률 높은 데이터스토어' 상위 N 이 사용량 미상 DS 로 채워졌다. 숫자끼리는 수치 비교, 나머지는 문자열(숫자 인식) 비교.
 */
/*
 * v2.744(감사 DB-02): 문자열 비교는 모듈 수준 Intl.Collator 하나로 한다. 옵션 객체를 넘기는 localeCompare 는 호출마다 collator 를
 *   새로 해석해 VM 6,000대 이름 정렬이 약 0.4초 동기 정지였다(v2.503 웹 STable 과 같은 원인). 결과는 ECMA-402 상 같다 — 테스트가 대조한다.
 */
const NUM_COLLATOR = new Intl.Collator(undefined, { numeric: true });

export function nlSortCompare(field, dir = 1) {
  const empty = (v) => v == null || v === '' || (typeof v === 'number' && !Number.isFinite(v));
  return (a, b) => {
    const x = a?.[field], y = b?.[field];
    const ex = empty(x), ey = empty(y);
    if (ex || ey) return ex === ey ? 0 : ex ? 1 : -1;
    const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : NUM_COLLATOR.compare(String(x), String(y));
    return cmp * dir;
  };
}

function runQuery(q, allowed = null) {
  const snap = store.get();
  const entity = SCHEMA[q.entity] ? q.entity : 'vm';
  let items = snap[PLURAL[entity]] || [];
  // 사용자 scope 를 필터·total 산정보다 먼저 강제 — 범위 밖 vCenter 항목이 결과·집계에 새지 않게.
  // vm/host/datastore/network 모두 vcenterId 를 가진다. allowed=null(무제한)이면 통과.
  if (allowed) items = items.filter((it) => allowed.has(it.vcenterId));
  const regionIds = (region) => new Set((snap.vcenters || []).filter((v) => (v.location?.region || '').toLowerCase() === String(region).toLowerCase()).map((v) => v.id));
  const filters = Array.isArray(q.filters) ? q.filters : [];
  const matchFn = q.match === 'any' ? 'some' : 'every';
  items = items.filter((it) => filters[matchFn]((f) => { try { return testFilter(it, f, regionIds); } catch { return false; } }));

  if (q.sort?.field) {
    const dir = q.sort.dir === 'desc' ? -1 : 1;
    items = [...items].sort(nlSortCompare(q.sort.field, dir));
  }
  const limit = nlResultLimit(q.limit);
  return { entity, label: SCHEMA[entity].label, total: items.length, results: items.slice(0, limit) };
}

/**
 * 67회차 개선: 결과 개수 상한 — LLM 이 만든 limit 를 1~500 정수로. 예전 `Math.min(Number(q.limit) || 100, 500)` 은 음수(-5)를 그대로 써
 * `slice(0, -5)` 가 **뒤에서 5개를 빼고** 나머지를 줬고 요약은 '상위 N개 표시' 라고 했다(/vms limit 의 Math.max(1, …) 와 같은 함정). 0 · 음수 · 숫자 아님은 기본 100.
 */
export function nlResultLimit(v) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(n, 500);
}

/**
 * v2.605(감사 SEC2605-01): 질의 길이 상한 — 라우트(/search/nl)·ChatOps 가 먼저 거르고, nlSearch 도 스스로 거부한다
 * (정규식·LLM 프롬프트 모두 길이에 비례해 비싸진다. /api 본문 한도 1MB 를 그대로 받으면 한 요청이 루프를 수십 분 막았다).
 */
export const NL_QUERY_MAX = 500;

// --- rule-based fallback (no LLM) ---
export function _fallbackParseForTest(query) { return fallbackParse(query); }
function fallbackParse(query) {
  const s = query.toLowerCase();
  const entity = /호스트|host|esxi/.test(s) ? 'host' : /스토리지|데이터스토어|datastore|볼륨/.test(s) ? 'datastore' : /네트워크|network|포트그룹/.test(s) ? 'network' : 'vm';
  const filters = [];
  for (const r of REGIONS) if (query.includes(r)) filters.push({ field: 'region', op: 'eq', value: r });
  // v2.605(감사 SEC2605-01 — 재현): 앵커 없는 /(\d+)\s*%/ 는 숫자열의 모든 시작 위치에서 끝까지 훑어 O(n²) 였다
  //   ('1'×30,000+'x' 1초 · 120k 16.7초). 뒤보기로 숫자열의 첫 자리에서만 시작하고 자릿수를 묶는다(선형).
  const pct = query.match(/(?<!\d)(\d{1,6})\s*%/);
  if (pct) {
    const op = /이하|미만|under|낮|적/.test(s) ? 'lte' : 'gt';
    const field = /cpu/.test(s) ? 'cpuUsagePct' : entity === 'datastore' ? 'usagePct' : 'memUsagePct';
    filters.push({ field, op, value: Number(pct[1]) });
  }
  if (/꺼|off|정지|중지/.test(s) && entity === 'vm') filters.push({ field: 'powerState', op: 'eq', value: 'POWERED_OFF' });
  if (/켜|powered on|\bon\b|구동/.test(s) && entity === 'vm') filters.push({ field: 'powerState', op: 'eq', value: 'POWERED_ON' });
  if (/스냅샷|snapshot/.test(s) && entity === 'vm') filters.push({ field: 'snapshotCount', op: 'gt', value: 0 });
  if (/점검|maintenance|메인터넌스/.test(s) && entity === 'host') filters.push({ field: 'connectionState', op: 'eq', value: 'MAINTENANCE' });
  return { entity, filters, match: 'all', limit: 100 };
}

/** Main entry: translate `query` and run it. Returns the interpreted query + results. */
/**
 * 자연어 검색 결과 종류 → 그 결과를 볼 조회 권한(inv.* — v2.536 집행과 같은 축). v2.583 `/search/nl` 이 먼저 썼고
 * v2.591 S1 에 ChatOps 가 같은 표를 쓴다 — 두 곳이 각자 표를 들면 한쪽에만 종류가 늘어 다시 우회로가 된다.
 */
export const NL_ENTITY_PERM = Object.freeze({ vm: 'inv.vms', host: 'inv.hosts', datastore: 'inv.datastores', network: 'inv.networks' });

/**
 * @param {string} query
 * @param {Set<string>|null} allowed
 * @param {{slotHeld?:boolean}} [opt] slotHeld = 부르는 쪽(ChatOps)이 이미 LLM 자리를 잡았다(같은 요청이 두 자리를 잡지 않게)
 */
export async function nlSearch(query, allowed = null, { slotHeld = false } = {}) {
  if (String(query ?? '').length > NL_QUERY_MAX) {
    const e = new Error(`질의가 너무 깁니다(최대 ${NL_QUERY_MAX}자).`); e.status = 400; e.code = 'query-too-long'; throw e;
  }
  const cfg = loadLlmConfig();
  let q, source;
  if (cfg.enabled) {
    // 67: 자리가 없으면 폴백으로 조용히 바꾸지 않고 거절한다(429) — 폴백은 LLM 오류(응답 실패) 때만이다.
    const release = slotHeld ? null : acquireLlmSlot();
    if (!slotHeld && !release) throw llmBusyError();
    try {
      const text = await ollamaGenerate(cfg, buildPrompt(query), { format: 'json' });
      q = normalizeLlmQuery(extractJson(text));   // 116회차 F3: 스키마에 맞는 질의만 실행한다(아니면 아래 catch — 규칙 기반 폴백 + 사유)
      source = 'llm';
    } catch (err) {
      q = fallbackParse(query); source = 'fallback'; q._llmError = err.message;
    } finally { release?.(); }
  } else {
    q = fallbackParse(query); source = 'fallback';
  }
  const out = runQuery(q, allowed);
  return {
    source, query: { entity: out.entity, filters: q.filters || [], match: q.match || 'all', sort: q.sort || null },
    llmError: q._llmError,
    ...out,
    summary: `${out.label} ${out.total.toLocaleString()}개 검색됨${out.total > out.results.length ? ` (상위 ${out.results.length}개 표시)` : ''}`,
  };
}

export const searchSchema = SCHEMA;
