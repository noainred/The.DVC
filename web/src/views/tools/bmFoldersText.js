/**
 * 물리서버 폴더(도구 키 bm-folders, v2.984) — 화면 문구 · 순수 계산. 판정(어느 폴더 · 보류 · 없어짐 · 찾기)은 서버(bmfolders/build.js)가 하고,
 * 여기는 서버가 준 행을 고른 노드로 거르고 합치는 것만 한다(노드 test 로 고정 — bmFoldersText.test.js).
 * ⚠ 문구에 백틱 금지(BoldText 는 **강조** 만 해석한다 — 값 인용은 ‘ ’).
 */
import { numOrNull } from '../../numOrNull.js';

export const INTRO = '가상화 서버는 vCenter 가 클러스터로 나눠 주지만 물리서버(베어메탈)에는 그런 구조가 없습니다. iDRAC 으로 인식된 물리서버를 **법인 › 폴더**에 등록해 서비스별로 묶어 봅니다. '
  + '한 서버는 **한 폴더**에만 들어갑니다(vCenter 의 호스트 ↔ 클러스터와 같은 규칙). 엣지 · 수집 서버가 보고한 서버도 여기서 등록하고, 등록 정보는 중앙에만 저장됩니다.';

export const SRC_LABEL = { central: '중앙', edge: '엣지', collector: '수집 서버' };
export const SRC_BADGE = { central: 'blue', edge: 'teal', collector: 'teal' };
export const PLACE_LABEL = { manual: '손 등록', rule: '자동 규칙' };
export const MISSING_WHY = {
  'snapshot-initial': '인벤토리 첫 수집 전이라 판정을 미룹니다',
  'corp-hold': '그 법인이 수집 전이거나 꺼져 있어 판정을 미룹니다',
  'source-unread': '서버 목록 출처 중 못 읽은 것이 있어 판정을 미룹니다',
  'collector-listed': '수집 서버가 지금도 보고하는 서버지만 전력을 못 읽었거나 보고가 오래돼 서버 목록에서 빠졌습니다 — 지우지 않습니다(수집 서버가 하루 넘게 실패하면 보류도 끝남)',
};
export const SKIP_TEXT = {
  notFound: '찾지 못함', noCorp: '법인 미지정', readOnly: '조회 전용 법인', otherCorp: '다른 법인', inOther: '이미 다른 폴더', same: '이미 그 폴더', noFolder: '폴더 없음', notAssigned: '등록 없음',
  otherCorpReg: '다른 법인에 남은 예전 등록(그 법인에 쓸 수 없음)', badKey: '저장할 수 없는 키',
};

export const pctText = (v) => { const n = numOrNull(v); return n == null ? '—' : `${Math.round(n)}%`; };
export const wattsText = (w) => { const n = numOrNull(w); return n == null ? '—' : `${Math.round(n).toLocaleString()} W`; };
/** 경로 'A\\B' → 'A › B'. */
export const pathText = (p) => String(p || '').split('\\').filter(Boolean).join(' › ');
export const lastSeg = (p) => { const s = String(p || '').split('\\'); return s[s.length - 1] || ''; };
export const parentOf = (p) => { const i = String(p || '').lastIndexOf('\\'); return i > 0 ? p.slice(0, i) : ''; };
export const underPath = (p, base) => p === base || String(p || '').startsWith(`${base}\\`);
/** 입력한 폴더 경로 정리 — 앞뒤 공백 · 끝의 구분자(\\)를 걷는다(정규식 없이 — 끝 반복 정규식 금지 규약). */
export function trimPath(v) {
  let s = String(v ?? '').slice(0, 700).trim();
  while (s.endsWith('\\')) s = s.slice(0, -1).trimEnd();
  return s;
}
export const csvNameOf = (d = new Date()) => `bm-folders-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.csv`;

/** 나이(초 전 · 분 전 · 시간 전). 값이 없으면 '—'. */
export function ageText(at, now = Date.now()) {
  const a = numOrNull(at);
  if (a == null) return '—';
  const s = Math.max(0, Math.round((now - a) / 1000));
  if (s < 90) return `${s}초 전`;
  if (s < 5400) return `${Math.round(s / 60)}분 전`;
  if (s < 172800) return `${Math.round(s / 3600)}시간 전`;
  return `${Math.round(s / 86400)}일 전`;
}

/**
 * 고른 노드의 서버 행.
 * sel: { type:'all' } | { type:'corp', corp } | { type:'folder', corp, path } | { type:'un', corp } | { type:'nocorp' } | { type:'name', path }(폴더 이름별 — 전 법인 같은 경로)
 * sub: 폴더를 골랐을 때 하위 폴더 서버도 넣는가.
 */
export function rowsOf(servers = [], sel = { type: 'all' }, { sub = true } = {}) {
  return servers.filter((r) => {
    switch (sel.type) {
      case 'corp': return r.corp === sel.corp;
      case 'folder': return r.corp === sel.corp && !!r.place && (sub ? underPath(r.path, sel.path) : r.path === sel.path);
      case 'un': return r.corp === sel.corp && !r.place;
      case 'nocorp': return !r.corp;
      case 'name': return !!r.place && (sub ? underPath(r.path, sel.path) : r.path === sel.path);
      default: return true;
    }
  });
}

/**
 * 합계 — CPU · 메모리는 **용량 가중**(Σ사용률×용량÷Σ용량 — 법인별 서버 사용량 · 서비스 인벤토리와 같은 정의). 사용률이나 용량을 못 읽은 서버는 빼고 따로 센다.
 * 전력은 읽은 서버만 더한다(못 읽은 서버를 0 W 로 채우지 않는다). 부품 장애를 모르는 서버(null)는 장애에도 정상에도 넣지 않는다.
 */
export function aggregate(rows = []) {
  const o = { n: rows.length, on: 0, off: 0, powerUnknown: 0, faults: 0, faultsUnknown: 0, cpu: null, mem: null, usageN: 0, usageMissing: 0, noCap: 0, watts: null, wattsN: 0 };
  let cw = 0; let cs = 0; let mw = 0; let ms = 0; let w = 0;
  for (const r of rows) {
    if (r.powered === true) o.on += 1; else if (r.powered === false) o.off += 1; else o.powerUnknown += 1;
    const f = numOrNull(r.faults);
    if (f == null) o.faultsUnknown += 1; else if (f > 0) o.faults += 1;
    const cpu = numOrNull(r.cpu); const mem = numOrNull(r.mem);
    if (cpu == null && mem == null) { o.usageMissing += 1; } else {
      const cores = numOrNull(r.cores); const gb = numOrNull(r.memGB);
      let used = false;
      if (cpu != null && cores != null && cores > 0) { cs += cpu * cores; cw += cores; used = true; }
      if (mem != null && gb != null && gb > 0) { ms += mem * gb; mw += gb; used = true; }
      if (used) o.usageN += 1; else o.noCap += 1;
    }
    const wt = numOrNull(r.watts);
    if (wt != null && wt > 0) { w += wt; o.wattsN += 1; }
  }
  o.cpu = cw > 0 ? Math.round((cs / cw) * 10) / 10 : null;
  o.mem = mw > 0 ? Math.round((ms / mw) * 10) / 10 : null;
  o.watts = o.wattsN ? Math.round(w) : null;
  return o;
}

/** 표 안 거르기 — 공백으로 나눈 글자가 **전부** 이름 · 모델 · 서비스 태그 · 엣지 중 하나에 들어가야 남는다(대소문자 무시). */
export function filterRows(rows = [], q = '', quick = '') {
  const toks = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  return rows.filter((r) => {
    if (quick === 'fault' && !(numOrNull(r.faults) > 0)) return false;
    if (quick === 'unread' && !(numOrNull(r.cpu) == null && numOrNull(r.mem) == null)) return false;
    if (quick === 'off' && r.powered !== false) return false;
    if (!toks.length) return true;
    const hay = `${r.name || ''} ${r.model || ''} ${r.serviceTag || ''} ${r.agent || ''}`.toLowerCase();
    return toks.every((t) => hay.includes(t));
  });
}

/** 찾기 입력 'db, ora, -bak' → { include:['db','ora'], exclude:['bak'] }(소문자 · 중복 제거 · 각 64자 · 최대 10개씩). 서버도 같은 규칙으로 다시 자른다. */
export function parseQuery(text = '') {
  const include = []; const exclude = [];
  for (const raw of String(text || '').slice(0, 1024).split(',')) {
    let s = raw.trim().toLowerCase();
    if (!s) continue;
    const neg = s.startsWith('-');
    if (neg) s = s.slice(1).trim();
    s = s.slice(0, 64);
    if (!s) continue;
    const to = neg ? exclude : include;
    if (!to.includes(s) && to.length < 10) to.push(s);
  }
  return { include, exclude };
}

/** 이름에서 찾은 글자 위치(강조용) — [{ text, hit }]. 대소문자 무시 · 겹치면 앞 것. */
export function highlight(name = '', tokens = []) {
  const s = String(name || '');
  const low = s.toLowerCase();
  const marks = new Array(s.length).fill(false);
  for (const t of tokens) {
    if (!t) continue;
    for (let i = low.indexOf(t); i >= 0; i = low.indexOf(t, i + t.length)) for (let j = i; j < i + t.length; j += 1) marks[j] = true;
  }
  const out = [];
  for (let i = 0; i < s.length; i += 1) {
    const last = out[out.length - 1];
    if (last && last.hit === marks[i]) last.text += s[i]; else out.push({ text: s[i], hit: marks[i] });
  }
  return out;
}

/**
 * 등록 미리보기 — 고른 서버를 각자 법인의 path 폴더에 넣으면 법인별로 몇 대가 늘고 새 폴더가 생기는지.
 * 서버 규칙과 같은 판정: 이미 그 폴더면 그대로 · 다른 폴더(손 등록)는 moveExisting 일 때만 · 조회 전용 법인은 건너뜀.
 * @param picked   찾기 결과 행 중 고른 것
 * @param corps    메인 응답 corps(폴더 목록 · writable)
 * @param servers  메인 응답 servers(그 폴더에 지금 몇 대인지 세려고)
 */
export function previewAssign(picked = [], path = '', corps = [], servers = [], { moveExisting = false } = {}) {
  const byCorp = new Map();
  const skipped = { readOnly: 0, inOther: 0, same: 0 };
  const corpRow = new Map(corps.map((c) => [c.vcenterId, c]));
  for (const r of picked) {
    const c = corpRow.get(r.corp);
    if (c && c.writable === false) { skipped.readOnly += 1; continue; }
    if (r.place === 'manual' && r.path === path) { skipped.same += 1; continue; }
    if (r.place === 'manual' && !moveExisting) { skipped.inOther += 1; continue; }
    if (!byCorp.has(r.corp)) {
      const exists = !!c && (c.folders || []).some((f) => f.path === path);
      const before = servers.filter((s) => s.corp === r.corp && s.place && s.path === path).length;
      byCorp.set(r.corp, { corp: r.corp, before, add: 0, newFolder: !exists });
    }
    byCorp.get(r.corp).add += 1;
  }
  const list = [...byCorp.values()].sort((a, b) => b.add - a.add);
  return { list, total: list.reduce((s, x) => s + x.add, 0), newFolders: list.filter((x) => x.newFolder).length, skipped };
}

/** 쓰기 결과 → 알림 문구. 바뀐 것이 0건이면 경고로(성공처럼 보이지 않게). */
export function resultNote(okText, result) {
  const sk = result?.skipped || {};
  const skipped = Object.entries(sk).filter(([, n]) => n > 0).map(([k, n]) => `${SKIP_TEXT[k] || k} ${n}`).join(' · ');
  const changed = result?.added ?? result?.removed ?? result?.moved ?? null;
  if (changed === 0) return { ok: false, warn: true, text: `바뀐 서버가 없습니다${skipped ? ` — 건너뜀: ${skipped}` : ''}.` };
  return { ok: true, text: `${okText}${skipped ? ` (건너뜀: ${skipped})` : ''}` };
}

/**
 * 이름 바꾸기 · 지우기 결과 알림 — **응답 값으로**(미리 센 값이 아니라 서버가 실제로 한 것 — 2차 반증 2).
 * 빈 폴더를 바꾸거나 지운 것을 '바뀐 서버가 없습니다' 경고로 보이지 않게 resultNote 의 0건 판정을 타지 않는다.
 */
export function renameNote(r = {}) {
  const n = Number(r?.svcRules) || 0;
  if (r?.svcRulesNotMoved) return { ok: false, warn: true, text: `폴더 이름은 바꿨지만 서비스 인벤토리의 물리서버 폴더 규칙을 옮기지 못했습니다(${String(r.svcRulesNotMoved).slice(0, 120)}) — 서비스 인벤토리 › 소속 규칙에서 경로를 고치십시오.` };
  return { ok: true, text: `폴더 이름을 바꿨습니다${n ? ` — 서비스 인벤토리의 물리서버 폴더 규칙 ${n}개도 새 경로로 옮겼습니다` : ''}.` };
}
export function removeNote(label, r = {}) {
  const k = Number(r?.removed) || 0; const s = Number(r?.svcRules) || 0;
  return { ok: true, text: `폴더 ‘${label}’ 을(를) 지웠습니다${k ? ` — ${k}대가 (미분류)로 돌아갔습니다` : ''}.${s ? ` 서비스 인벤토리의 물리서버 폴더 규칙 ${s}개가 아직 이 경로를 가리킵니다 — 서비스 인벤토리 › 소속 규칙에서 정리하십시오.` : ''}` };
}

/** 폴더 이름별(전 법인) 묶음 — 같은 경로의 폴더를 법인을 넘어 합친다(읽기 전용 보기). */
export function foldersByName(corps = []) {
  const m = new Map();
  for (const c of corps) {
    for (const f of c.folders || []) {
      const x = m.get(f.path) || { path: f.path, name: f.name, depth: f.depth, total: 0, corps: 0, faults: 0 };
      x.total += f.total; x.faults += f.faults; x.corps += 1;
      m.set(f.path, x);
    }
  }
  return [...m.values()].sort((a, b) => a.path.localeCompare(b.path, 'ko'));
}

/** 오류 → 사용자 문구(서버 reason 우선). */
export function opErrorText(e) {
  const r = e?.serverReason || e?.body?.reason || e?.message || '';
  return String(r || '요청을 처리하지 못했습니다.').slice(0, 300);
}

// ───────── v2.987 맵 보기 · 저장한 보기 ─────────
/** 맵 묶기 — 'folder'(폴더 경로마다 · 미분류는 맨 뒤) · 'corp' · 'model'. 그룹 = { key, label, rows, un? }. */
export function mapGroups(rows = [], groupBy = 'folder', corpName = (x) => x) {
  const m = new Map();
  for (const r of rows) {
    let key; let label; let un = false;
    if (groupBy === 'corp') { key = r.corp || ''; label = r.corp ? corpName(r.corp) : '(법인 미지정)'; un = !r.corp; }
    else if (groupBy === 'model') { key = r.model || ''; label = r.model || '(모델 모름)'; un = !r.model; }
    else { key = r.place ? `${r.corp}|${r.path}` : `${r.corp}|`; label = r.place ? pathText(r.path) : '(미분류)'; un = !r.place; }
    if (!m.has(key)) m.set(key, { key, label, rows: [], un, ...(groupBy === 'folder' ? { corp: r.corp || '' } : {}) });
    m.get(key).rows.push(r);
  }
  return [...m.values()].sort((a, b) => (a.un - b.un) || a.label.localeCompare(b.label, 'ko'));
}

/**
 * 맵 칸 색 — 'cpu' · 'mem'(밝기 5단 · 20% 단위) · 'watts'(보이는 서버 중 최대 대비 5단) · 'fault'(장애 · 정상 · 모름).
 * 못 읽은 값은 'na'(점선 빈 칸 — 0 으로 칠하지 않는다) · 꺼짐은 'off'. 장애가 있으면 bad = true(테두리 — 색과 따로).
 */
export function cellTone(r, colorBy = 'cpu', maxWatts = null) {
  const bad = numOrNull(r?.faults) > 0;
  if (r?.powered === false) return { tone: 'off', bad, label: '꺼짐' };
  if (colorBy === 'fault') {
    const f = numOrNull(r?.faults);
    return f == null ? { tone: 'na', bad, label: '장애 모름' } : { tone: f > 0 ? 'u5' : 'u1', bad, label: f > 0 ? `부품 장애 ${f}건` : '장애 없음' };
  }
  const v = colorBy === 'mem' ? numOrNull(r?.mem) : colorBy === 'watts' ? numOrNull(r?.watts) : numOrNull(r?.cpu);
  if (v == null || (colorBy === 'watts' && !(v > 0))) return { tone: 'na', bad, label: '못 읽음' };
  const pct = colorBy === 'watts' ? (maxWatts > 0 ? (v / maxWatts) * 100 : null) : v;
  if (pct == null) return { tone: 'na', bad, label: '못 읽음' };
  const lv = Math.min(5, Math.max(1, Math.ceil(Math.max(pct, 0.0001) / 20)));
  return { tone: `u${lv}`, bad, label: colorBy === 'watts' ? `${Math.round(v)} W` : `${Math.round(v)}%` };
}

export const VIEWS_KEY = 'bmf.views';
export const VIEWS_MAX = 20;
const SEL_TYPES = new Set(['all', 'corp', 'folder', 'un', 'nocorp', 'name']);
/** 저장한 보기 한 건 정리 — 아는 필드만 · 글자 상한(브라우저 저장소는 사람이 고칠 수 있다). 모르는 모양이면 null. */
export function cleanView(v) {
  if (!v || typeof v !== 'object') return null;
  const name = String(v.name ?? '').trim().slice(0, 40);
  const s = v.state && typeof v.state === 'object' ? v.state : null;
  if (!name || !s) return null;
  const sel = s.sel && typeof s.sel === 'object' && SEL_TYPES.has(s.sel.type)
    ? { type: s.sel.type, ...(typeof s.sel.corp === 'string' ? { corp: s.sel.corp.slice(0, 128) } : {}), ...(typeof s.sel.path === 'string' ? { path: s.sel.path.slice(0, 700) } : {}) }
    : { type: 'all' };
  const pick = (x, list, d) => (list.includes(x) ? x : d);
  return {
    name,
    state: {
      sel, view: pick(s.view, ['list', 'map'], 'list'), treeMode: pick(s.treeMode, ['corp', 'name'], 'corp'),
      q: String(s.q ?? '').slice(0, 200), quick: pick(s.quick, ['', 'fault', 'unread', 'off'], ''), sub: s.sub !== false,
      groupBy: pick(s.groupBy, ['folder', 'corp', 'model'], 'folder'), colorBy: pick(s.colorBy, ['cpu', 'mem', 'watts', 'fault'], 'cpu'),
    },
  };
}
/** 저장된 글자 → 보기 목록(망가졌으면 빈 목록 — 던지지 않는다). */
export function parseViews(raw) {
  try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a.map(cleanView).filter(Boolean).slice(0, VIEWS_MAX) : []; } catch { return []; }
}
/** 같은 이름이면 바꾸고 없으면 앞에 더한다(최대 VIEWS_MAX — 넘치면 가장 오래된 것을 버린다). */
export function upsertView(list = [], name = '', state = {}) {
  const v = cleanView({ name, state });
  if (!v) return list;
  return [v, ...list.filter((x) => x.name !== v.name)].slice(0, VIEWS_MAX);
}
