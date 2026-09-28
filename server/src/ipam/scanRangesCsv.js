/**
 * ipam/scanRangesCsv.js — **에이전트별 IP 스캔 대역** CSV 내보내기·가져오기 판정(순수, v2.636).
 *
 * 사용자 요청(2026-09-28): "IP scan 을 위한 입력/수정을 해야 하는데, 그 작업이 입력량이 많고 복잡해서" + CSV 가져오기 대상
 * "IP 관리상태 + 스캔 대역". 에이전트(엣지)마다 스캔 대역을 한 줄씩 넣던 입력을 파일로 주고받는다.
 * (vCenter별 스캔 대역은 v2.339 부터 `vcRangesCsv.js` 가 따로 한다 — 이 파일은 **IP 스캔 설정의 에이전트 대역**이다.)
 *
 * 형식: 한 줄에 대역 하나 — `agent,range`. 같은 에이전트가 여러 줄에 나온다(대역이 수백 개여도 셀 하나에 몰아넣지 않는다).
 *   agent 가 '__local__' 또는 '이 포탈' 이면 이 포탈이 직접 스캔하는 대역이다. range 가 빈 줄은 '이 에이전트의 대역을 비운다'
 *   (교체 모드에서만 뜻이 있다 — 내보낸 파일에 대역 없는 에이전트가 그렇게 실린다).
 *
 * 두 모드:
 *  · replace(교체) — 파일에 **나온 에이전트만** 대역 목록을 파일 내용으로 바꾼다. 파일에 없는 에이전트는 건드리지 않는다.
 *  · add(추가만) — 파일의 대역을 기존 목록 뒤에 붙인다(이미 있는 대역은 건너뛴다). 아무것도 지우지 않는다.
 * ⚠ 오류 줄이 하나라도 있는 에이전트는 **적용하지 않는다**(`blocked`) — 교체 모드에서 오류 줄만 빼고 적용하면 그 대역이 조용히 사라진다.
 * 판정 규칙: 대역 문법은 저장 라우트·스캐너와 같은 판정(`rangeSyntax.checkRangeSpec`, 뒤집힌 범위 오류)으로 본다 — 오류 행의 사유는
 * 그 판정의 문구를 그대로 싣는다(v2.639 — 예전 `rangeSize` 주입은 느슨해 PUT 이 거부하는 줄을 CSV 가 저장했다). 한 대역이 스캐너
 * 상한(RANGE_CAP)을 넘으면 **오류가 아니라 경고**다(스캐너는 앞 RANGE_CAP 개만 스캔한다 — 그 사실을 행에 적는다). 상한 비교의 크기는
 * 판정기의 `size`(CIDR 은 네트워크·브로드캐스트 포함 — /24 = 256) 다. 같은 에이전트 안의 중복 대역은 한 번만.
 */
import { parseCsvRows, csvLine, unguardCell, delimiterHint, CSV_BOM } from '../util/csv.js';
import { checkRangeSpec } from './rangeSyntax.js';

export const LOCAL_AGENT = '__local__';
const LOCAL_ALIASES = new Set(['__local__', '이 포탈', '이포탈', '(이 포탈)', 'portal']);
// v2.639: 아래 넷은 모듈 밖에서 쓰는 곳이 없어(저장소 grep 0) 비공개로 내렸다 — 삭제가 아니라 export 만 뗐다.
const SCAN_RANGES_COLUMNS = Object.freeze(['agent', 'range']);
const SCAN_RANGES_MAX_ROWS = 20_000;
const AGENT_NAME_MAX = 120;

const norm = (h) => unguardCell(h).trim().toLowerCase().replace(/[\s_\-()]/g, '');

/** 대역 문자열 정규화 — 앞뒤 공백·중간 공백 제거(‘10.0.0.1 - 10.0.0.5’ 같은 입력). */
function normRange(s) { return String(s || '').trim().replace(/\s*-\s*/g, '-').replace(/\s*\/\s*/g, '/'); }

/** 에이전트 이름 정규화 — 이 포탈 별칭은 LOCAL_AGENT 로. */
function normAgent(s) {
  const t = String(s || '').trim();
  return LOCAL_ALIASES.has(t.toLowerCase()) || LOCAL_ALIASES.has(t) ? LOCAL_AGENT : t;
}

/**
 * 에이전트별 설정 → CSV. agents: [{ name, ranges:[] }]. 대역 없는 에이전트는 range 빈 줄 하나로 싣는다(교체 왕복을 위해).
 */
export function scanRangesToCsv(agents) {
  const lines = [csvLine(SCAN_RANGES_COLUMNS)];
  for (const a of agents || []) {
    const name = a.name || LOCAL_AGENT;
    const ranges = Array.isArray(a.ranges) ? a.ranges.filter(Boolean) : [];
    if (!ranges.length) lines.push(csvLine([name, '']));
    for (const r of ranges) lines.push(csvLine([name, r]));
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

export function scanRangesSampleCsv() {
  const lines = [
    csvLine(SCAN_RANGES_COLUMNS),
    csvLine(['# agent: 에이전트(엣지) 이름 또는 __local__(이 포탈 직접)', '# range: CIDR(10.0.0.0/24)·범위(10.0.0.1-50)·단일 IP — 한 줄에 하나']),
    csvLine([LOCAL_AGENT, '10.10.0.0/24']),
    csvLine([LOCAL_AGENT, '10.10.1.1-10.10.1.50']),
    csvLine(['edge-seoul', '172.16.5.0/26']),
  ];
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/** CSV → { rows:[{_line, agent, range}], error }. */
export function parseScanRangesCsv(text) {
  let rows;
  try { rows = parseCsvRows(text, { maxRows: SCAN_RANGES_MAX_ROWS + 1, maxCell: 512 }); }
  catch (e) { return { rows: [], error: e.message }; }
  if (rows.length < 2) return { rows: [], error: '헤더 + 최소 1개 데이터 행이 필요합니다.' };
  const header = rows[0].map(norm);
  const ai = header.findIndex((h) => ['agent', '에이전트', 'edge', '엣지'].includes(h));
  const ri = header.findIndex((h) => ['range', 'ranges', '대역', 'cidr'].includes(h));
  if (ai < 0 || ri < 0) return { rows: [], error: "필수 헤더 'agent' 와 'range' 가 없습니다." + delimiterHint(rows[0]) };
  const out = [];
  rows.slice(1).forEach((cells, n) => {
    const agent = unguardCell(cells[ai] ?? '').trim();
    const range = unguardCell(cells[ri] ?? '').trim();
    if (!agent && !range) return;
    if (agent.startsWith('#')) return;
    out.push({ _line: n + 2, agent, range });
  });
  return { rows: out, error: null };
}

/**
 * 판정(순수). ctx: { current: Map<정규화 에이전트 키(소문자), {name, ranges}>, rangeCap }
 *   (v2.639: 예전 `rangeSize` 주입 인자는 받아도 무시한다 — 판정은 `checkRangeSpec` 하나다.)
 * @returns {{ report, summary, plans:[{agent, key, before:[], after:[], added:[], removed:[]}] }}
 */
export function analyzeScanRangesImport(rows, { mode = 'replace', current = new Map(), rangeCap = 4096 } = {}) {
  const report = []; const perAgent = new Map();
  const summary = { add: 0, keep: 0, dup: 0, empty: 0, warn: 0, error: 0 };
  for (const r of rows) {
    const agent = normAgent(r.agent);
    const out = { line: r._line, agent: agent || r.agent, range: r.range, action: 'error', reason: null };
    const done = (a, reason = null) => { out.action = a; out.reason = reason; summary[a] += 1; report.push(out); };
    if (!agent) { done('error', '에이전트 칸이 비어 있습니다.'); continue; }
    if (agent.length > AGENT_NAME_MAX || /[\u0000-\u001f\u007f]/.test(agent)) { done('error', `에이전트 이름이 ${AGENT_NAME_MAX}자를 넘거나 제어 문자가 있습니다.`); continue; }
    const k = agent.toLowerCase();
    if (!perAgent.has(k)) perAgent.set(k, { agent, ranges: [], errors: 0 });
    const slot = perAgent.get(k);
    if (!r.range) { done('empty'); continue; }
    const spec = normRange(r.range);
    const judged = checkRangeSpec(spec, { reversed: 'error' }); // 저장 라우트(PUT vc-ranges / scan/settings)·스캐너와 같은 판정
    if (!judged.ok) { slot.errors += 1; done('error', `대역 문법 오류: '${String(r.range).slice(0, 60)}' (${judged.reason})`); continue; }
    const size = judged.size;
    if (slot.ranges.includes(spec)) { done('dup', '같은 에이전트에 같은 대역이 이미 앞 줄에 있습니다 — 한 번만 넣습니다.'); continue; }
    slot.ranges.push(spec);
    const cur = current.get(k);
    const existed = !!cur && (cur.ranges || []).includes(spec);
    if (size > rangeCap) { summary.warn += 1; out.warn = `이 대역은 ${size.toLocaleString()}개 IP 라 스캐너가 앞 ${rangeCap.toLocaleString()}개만 스캔합니다 — /24 단위로 나누는 것을 권합니다.`; }
    done(existed ? 'keep' : 'add');
  }
  const plans = [];
  for (const [k, slot] of perAgent) {
    const cur = current.get(k);
    const before = cur ? [...(cur.ranges || [])] : [];
    const after = mode === 'add' ? [...before, ...slot.ranges.filter((x) => !before.includes(x))] : [...slot.ranges];
    const added = after.filter((x) => !before.includes(x));
    const removed = before.filter((x) => !after.includes(x));
    // ⚠ 오류 행이 있는 에이전트는 **통째로 적용하지 않는다** — 교체 모드에서 오류 줄만 빼고 적용하면 그 대역이 조용히 지워진다.
    const blocked = slot.errors > 0 ? `이 에이전트의 줄 ${slot.errors}개에 오류가 있어 이 에이전트는 적용하지 않습니다 — 고친 뒤 다시 가져오세요.` : null;
    plans.push({ agent: cur?.name || slot.agent, key: cur?.name || slot.agent, isNew: !cur, before, after, added, removed, blocked });
  }
  return { report, summary, plans, mode: mode === 'add' ? 'add' : 'replace' };
}
