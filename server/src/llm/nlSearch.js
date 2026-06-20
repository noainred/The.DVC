/**
 * Natural-language infrastructure search. The LLM only translates the user's
 * question into a structured query (entity + filters); the query then runs
 * against the locally collected snapshot. Degrades to a rule-based parser when
 * the LLM is disabled/unavailable.
 */

import { store } from '../store.js';
import { loadLlmConfig } from './config.js';
import { ollamaGenerate } from './ollama.js';

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

const num = (v) => (v == null || v === '' ? NaN : Number(v));

function testFilter(item, f, regionIds) {
  const { field, op = 'eq', value } = f || {};
  if (field === 'region') return regionIds(value).has(item.vcenterId);
  if (field === 'ip') {
    const ips = item.ipAddresses?.length ? item.ipAddresses : (item.ipAddress ? [item.ipAddress] : []);
    return ips.some((ip) => String(ip).includes(value));
  }
  if (field === 'tag') return (item.tags || []).some((t) => String(t).toLowerCase().includes(String(value).toLowerCase()));
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

function runQuery(q) {
  const snap = store.get();
  const entity = SCHEMA[q.entity] ? q.entity : 'vm';
  let items = snap[PLURAL[entity]] || [];
  const regionIds = (region) => new Set((snap.vcenters || []).filter((v) => (v.location?.region || '').toLowerCase() === String(region).toLowerCase()).map((v) => v.id));
  const filters = Array.isArray(q.filters) ? q.filters : [];
  const matchFn = q.match === 'any' ? 'some' : 'every';
  items = items.filter((it) => filters[matchFn]((f) => { try { return testFilter(it, f, regionIds); } catch { return false; } }));

  if (q.sort?.field) {
    const dir = q.sort.dir === 'desc' ? -1 : 1;
    items = [...items].sort((a, b) => {
      const x = a[q.sort.field], y = b[q.sort.field];
      const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return cmp * dir;
    });
  }
  const limit = Math.min(Number(q.limit) || 100, 500);
  return { entity, label: SCHEMA[entity].label, total: items.length, results: items.slice(0, limit) };
}

// --- rule-based fallback (no LLM) ---
function fallbackParse(query) {
  const s = query.toLowerCase();
  const entity = /호스트|host|esxi/.test(s) ? 'host' : /스토리지|데이터스토어|datastore|볼륨/.test(s) ? 'datastore' : /네트워크|network|포트그룹/.test(s) ? 'network' : 'vm';
  const filters = [];
  for (const r of ['아시아', '중국', '유럽', '북미']) if (query.includes(r)) filters.push({ field: 'region', op: 'eq', value: r });
  const pct = query.match(/(\d+)\s*%/);
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
export async function nlSearch(query) {
  const cfg = loadLlmConfig();
  let q, source;
  if (cfg.enabled) {
    try {
      const text = await ollamaGenerate(cfg, buildPrompt(query), { format: 'json' });
      q = extractJson(text);
      source = 'llm';
    } catch (err) {
      q = fallbackParse(query); source = 'fallback'; q._llmError = err.message;
    }
  } else {
    q = fallbackParse(query); source = 'fallback';
  }
  const out = runQuery(q);
  return {
    source, query: { entity: out.entity, filters: q.filters || [], match: q.match || 'all', sort: q.sort || null },
    llmError: q._llmError,
    ...out,
    summary: `${out.label} ${out.total.toLocaleString()}개 검색됨${out.total > out.results.length ? ` (상위 ${out.results.length}개 표시)` : ''}`,
  };
}

export const searchSchema = SCHEMA;
