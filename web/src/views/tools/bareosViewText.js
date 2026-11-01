/**
 * Bareos 조회 화면(v2.828 — 통합 현황 bareos-summary · 법인별 현황 bareos-detail) 판정·문구 하나.
 *   bareosClass 는 서버 server/src/bareos/vmView.js bareosClass 와 한 쌍이다(같은 입력 대조 — bareosViewText.test.js).
 *   문구에 백틱 금지(BoldText) · 값이 없으면 '—' · 못 읽은 값(null)은 0 으로 그리지 않는다.
 */
import { shortTs, fmtGb, folderParts, critOf } from './backupViewText.js';
import { levelLabel, decBytesText } from './bareosText.js';

const DAY = 86_400_000;
const isFin = (v) => typeof v === 'number' && Number.isFinite(v);
export const BAREOS_RPO_DAYS = [1, 3, 7];

/** 칸 b 분류 — 서버 bareos/vmView.js bareosClass 와 같다. */
export function bareosClass(b, { rpoDays = 1, now = Date.now() } = {}) {
  const days = BAREOS_RPO_DAYS.includes(Number(rpoDays)) ? Number(rpoDays) : 1;
  const job = !!b && b.job === true;
  const st = job ? b.st || null : null;
  return {
    unknown: b === null,
    job,
    missing: !!b && b.job === false,
    on: job && b.on !== false,
    off: job && b.on === false,
    ok: st === 'ok',
    warn: st === 'warning',
    fail: st === 'error' || st === 'canceled',
    run: job && !!b.run,
    never: job && !isFin(b.ok),
    old: job && b.on !== false && isFin(b.ok) && now - b.ok > days * DAY,
    gone: job && b.gone === true,
  };
}

/* ── Director 상태(서버 vmView.directorState 의 state) ── */
export const DIRECTOR_STATE = {
  ok: { text: '정상', color: '#22c55e' },
  relay: { text: '엣지 대행 회신 대기', color: '#3b82f6' },
  pending: { text: '조회 전', color: '#64748b' },
  error: { text: '조회 실패', color: '#f59e0b' },
  auth: { text: '인증 정지', color: '#ef4444' },
  unset: { text: '미설정', color: '#64748b' },
};
export const directorStateOf = (s) => DIRECTOR_STATE[s] || { text: s ? String(s) : '—', color: '#64748b' };
/** Director 한 줄 — '이름 · 상태 · 담당'(이름이 없으면 미설정). */
export function directorLineText(dir) {
  if (!dir || !dir.name) return 'Director 미설정 — 설정 탭에서 이 vCenter 를 법인 Director 에 묶어야 Bareos 결과가 보입니다';
  const st = directorStateOf(dir.state).text;
  const via = dir.via === 'edge' ? '엣지 대행' : '중앙 직접';
  return `Director ‘${dir.name}’ · ${st} · ${via}${isFin(dir.at) ? ` · 마지막 조회 ${shortTs(dir.at)}` : ''}`;
}
/** 결과를 모를 때(인증 정지·조회 실패·미설정) 화면이 밝힐 문장 — 모르면 null. */
export function resultsUnknownText(dir) {
  if (!dir || dir.resultsKnown !== false) return null;
  if (dir.state === 'auth') return 'Director 인증이 실패해 주기 조회를 멈췄습니다 — 결과(성공·실패·오래됨)는 마지막으로 읽은 값이라 합계에서 뺐습니다(모름).';
  if (dir.state === 'error') return 'Director 마지막 조회가 실패했습니다 — 결과는 마지막으로 읽은 값이라 합계에서 뺐습니다(모름). 다음 조회에서 다시 셉니다.';
  return '이 vCenter 를 묶은 Bareos Director 가 없거나 접속값이 비어 있어 결과를 모릅니다.';
}

/* ── 수 ── */
/** 수(null 은 '—') — 0 은 0. */
export const numText = (v) => (v == null ? '—' : isFin(v) ? v.toLocaleString('en-US') : '—');
/** 결과 막대 조각(%) — 성공·경고·실패·진행·나머지(아직·모름). 잡이 없거나 결과를 모르면 null(막대를 그리지 않는다). */
export function resultBar(c) {
  if (!c || !isFin(c.jobs) || c.jobs <= 0 || c.ok == null) return null;
  // 버그 점검 W3: 성공·경고·실패는 '마지막으로 끝난 실행', 진행은 '지금 도는 실행' 이라 한 잡이 둘 다 셀 수 있다(지난번 성공 + 지금 실행) —
  //   분모를 잡 수로만 두면 합이 100% 를 넘어 막대가 비율을 잃었다. 분모 = max(잡 수, 조각 합)
  const den = Math.max(c.jobs, (c.ok || 0) + (c.warn || 0) + (c.fail || 0) + (c.run || 0));
  const p = (n) => Math.round((n / den) * 1000) / 10;
  return { ok: p(c.ok), warn: p(c.warn), fail: p(c.fail), run: p(c.run) };
}

/* ── VM 칸 ── */
const ST_TEXT = { ok: '성공', warning: '경고', error: '실패', canceled: '취소' };
export const stText = (st) => ST_TEXT[st] || '—';
export const ST_TONE = { ok: 'ok', warning: 'warn', error: 'bad', canceled: 'bad' };
/** 마지막 실행 한 줄 — 레벨 · 바이트(모르면 뺀다). */
export function runLine(b) {
  if (!b || !b.job) return '';
  const parts = [];
  if (b.lv) parts.push(lvText(b.lv));
  if (isFin(b.by)) parts.push(bytesText(b.by));
  return parts.join(' · ');
}
/** 바이트 — 관리 화면·작업 결과 창과 같은 함수(bareosText.decBytesText — 10진 · 앞 4자리 버림, Bareos 보고서와 같은 숫자).
 *  v2.829: 이 화면만 1024 로 나누고 GB 를 붙여 같은 백업이 관리 화면 622.5 GB · 여기 579.8 GB 로 달랐다(판정 코어는 하나). */
export function bytesText(n) {
  return isFin(n) ? decBytesText(n) : '—';
}
export { shortTs, fmtGb, critOf };
/** 레벨 — 카탈로그 한 글자(F·I·D)도 낱말로(관리 화면 bareosText.levelLabel 과 같다). 모르는 값은 그대로, 없으면 '—'. */
export const lvText = (v) => (v ? (levelLabel(v) !== '—' ? levelLabel(v) : String(v)) : '—');

/* ── 보기 필터(법인별 현황) ── */
export const DETAIL_FILTERS = [
  ['all', '전체'], ['job', '잡 등록'], ['missing', '미등록'], ['run', '진행 중'], ['bad', '실패·경고'], ['old', '오래된 백업'], ['never', '백업 없음'], ['off', '잡 꺼짐'], ['mismatch', '방식 불일치'], ['gone', '인벤토리에 없음'],
];
/** 행이 보기 필터에 드는가. resultsKnown=false 면 결과 기준 필터(run·bad·old·never)에 넣지 않는다(모름). */
export function rowMatches(r, f, { rpoDays = 1, now = Date.now(), resultsKnown = true } = {}) {
  const k = bareosClass(r?.b, { rpoDays, now });
  if (f === 'job') return k.job;
  if (f === 'missing') return k.missing;
  if (f === 'off') return k.off;
  if (f === 'gone') return k.gone;
  if (f === 'mismatch') return k.job && !k.gone && r.method != null && r.method !== 'bareos';   // 서버 corpCounts 와 같다(인벤토리에 없는 VM 은 세지 않는다)
  if (!resultsKnown) return f === 'all';
  if (f === 'run') return k.run;
  if (f === 'bad') return k.fail || k.warn;
  if (f === 'old') return k.old;
  if (f === 'never') return k.never && k.on;
  return true;
}
export function detailFilterCounts(rows, opts) {
  const out = {};
  for (const [k] of DETAIL_FILTERS) out[k] = 0;
  for (const r of Array.isArray(rows) ? rows : []) for (const [k] of DETAIL_FILTERS) if (rowMatches(r, k, opts)) out[k]++;
  if (opts?.resultsKnown === false) for (const k of ['run', 'bad', 'old', 'never']) out[k] = null;
  // 버그 점검 W1: 파일을 못 읽으면 그 파일로 세는 칩은 '모름'(null → '—') — 0 이 아니다(서버 corpCounts 와 같은 뜻)
  if (opts?.marksKnown === false) for (const k of ['missing', 'mismatch']) out[k] = null;
  if (opts?.registryKnown === false) for (const [k] of DETAIL_FILTERS) if (k !== 'all') out[k] = null;
  return out;
}

const nat = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
/**
 * 폴더 트리(법인별 현황) — 보기·검색에 드는 행만 담고, 폴더마다 그 아래 전체 행의 집계(잡·성공·경고·실패·진행·미등록)를 단다.
 *   인벤토리에 없는 잡(gone)은 원장의 등록 때 위치로 놓인다.
 */
export function buildBareosTree(rows, { filter = 'all', q = '', rpoDays = 1, now = Date.now(), resultsKnown = true } = {}) {
  const mk = (key, name) => ({ key, name, children: new Map(), rows: [], agg: { n: 0, job: 0, ok: 0, warn: 0, fail: 0, run: 0, missing: 0, gb: 0 }, hit: 0 });
  const root = mk('', '');
  const needle = String(q || '').trim().toLowerCase();
  for (const r of Array.isArray(rows) ? rows : []) {
    const parts = folderParts(r.folder);
    const k = bareosClass(r.b, { rpoDays, now });
    const show = rowMatches(r, filter, { rpoDays, now, resultsKnown }) && (!needle || String(r.name || '').toLowerCase().includes(needle) || parts.join('/').toLowerCase().includes(needle));
    let node = root; const path = [root];
    for (const p of parts) {
      const key = node.key ? `${node.key}/${p}` : p;
      let next = node.children.get(p);
      if (!next) { next = mk(key, p); node.children.set(p, next); }
      node = next; path.push(node);
    }
    for (const n of path) {
      n.agg.n++; if (k.job) n.agg.job++; if (k.missing) n.agg.missing++;
      if (k.ok) n.agg.ok++; if (k.warn) n.agg.warn++; if (k.fail) n.agg.fail++; if (k.run) n.agg.run++;
      if (isFin(r.gb)) n.agg.gb += r.gb;
      if (show) n.hit++;
    }
    if (show) node.rows.push(r);
  }
  const fin = (n) => ({ key: n.key, name: n.name, agg: n.agg, hit: n.hit,
    children: [...n.children.values()].filter((x) => x.hit > 0).sort((a, b) => nat.compare(a.name, b.name)).map(fin),
    rows: n.rows.slice().sort((a, b) => nat.compare(String(a.name || ''), String(b.name || ''))) });
  return fin(root);
}
/** 트리 → 그릴 행. 검색·필터 중(forceOpen)이면 전부 펼친다. */
export function flattenBareosTree(tree, open, forceOpen) {
  const out = [];
  const walk = (n, depth) => {
    for (const c of n.children) {
      const isOpen = forceOpen || open.has(c.key);
      out.push({ kind: 'folder', key: `f:${c.key}`, node: c, depth, open: isOpen });
      if (isOpen) walk(c, depth + 1);
    }
    for (const r of n.rows) out.push({ kind: 'vm', key: `v:${r.id}`, row: r, depth });
  };
  if (tree) walk(tree, 0);
  return out;
}
/** 처음 펼칠 폴더 — 두 단계까지. */
export function initialBareosOpen(tree) {
  const s = new Set();
  for (const c of tree?.children || []) { s.add(c.key); for (const g of c.children || []) s.add(g.key); }
  return s;
}

/* ── 우선 확인(통합 현황) ── */
export const PRIORITY_TEXT = { fail: '실패', missing: '미등록', old: '오래된 백업', never: '백업 없음' };
export const PRIORITY_TONE = { fail: 'bad', missing: 'warn', old: 'warn', never: 'muted' };

/* ── Detail → Bareos 관리 화면 넘기기(Veeam 백업 실행 handoff 와 같은 모양 · 10분 · 200대) ── */
export const BAREOS_HANDOFF_KEY = 'bareos-backup.handoff';
const HANDOFF_TTL_MS = 10 * 60_000;
export const HANDOFF_MAX = 200;
export function saveBareosHandoff(vcenterId, vmIds, store = globalThis.sessionStorage) {
  try { store?.setItem(BAREOS_HANDOFF_KEY, JSON.stringify({ vcenterId: String(vcenterId || ''), vmIds: (Array.isArray(vmIds) ? vmIds : []).slice(0, HANDOFF_MAX).map(String), at: Date.now() })); return true; } catch { return false; }
}
/** 한 번 읽고 지운다. 오래됐거나(10분) 모양이 틀리면 null. */
export function takeBareosHandoff(store = globalThis.sessionStorage, now = Date.now()) {
  let raw = null;
  try { raw = store?.getItem(BAREOS_HANDOFF_KEY); store?.removeItem(BAREOS_HANDOFF_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j.vcenterId !== 'string' || !j.vcenterId || !Array.isArray(j.vmIds)) return null;
    if (!(now - Number(j.at) <= HANDOFF_TTL_MS)) return null;
    return { vcenterId: j.vcenterId, vmIds: j.vmIds.filter((x) => typeof x === 'string').slice(0, HANDOFF_MAX) };
  } catch { return null; }
}

/* ── Bareos 하위 탭(통합 · 법인별 · 백업 대상 · 실행 현황·이력 · 설정) — 도구 권한으로 보인다(서버가 진실의 원천 — 탭은 UX 게이팅) ── */
export function bareosSubTabs({ summaryOk = false, detailOk = false, manageOk = false, admin = false, fullScope = false } = {}) {
  return [
    ...(summaryOk ? [['summary', '통합 현황', '#/tools/bareos-summary']] : []),
    ...(detailOk ? [['detail', '법인별 현황', '#/tools/bareos-detail']] : []),
    // 버그 점검 W11: 관리 도구의 '백업 그룹' 탭(v2.830)도 같은 줄에(통합·법인별 화면에서 바로 간다)
    ...(admin && manageOk ? [['live', '진행 현황', '#/tools/bareos-backup/live'], ['targets', '백업 대상', '#/tools/bareos-backup/targets'], ['groups', '백업 그룹', '#/tools/bareos-backup/groups']] : []),
    // v2.839 '정책 · 일정'(조회 전용 키 bareos-summary 아래 — Director 수집본 · 접속하지 않는다)
    ...(summaryOk ? [['policy', '정책 · 일정', '#/tools/bareos-summary/policy']] : []),
    // v2.840 '보존 · 풀'(같은 조회 전용 키 — 수집본 · 볼륨 목록 즉시 조회만 관리 도구 권한)
    ...(summaryOk ? [['pools', '보존 · 풀', '#/tools/bareos-summary/pools']] : []),
    ...(admin && manageOk ? [['history', '실행 현황 · 이력', '#/tools/bareos-backup/history']] : []),
    ...(admin && manageOk && fullScope ? [['settings', '설정', '#/tools/bareos-backup/settings']] : []),
  ];
}
/** 법인별 현황이 이어받을 vCenter(통합 표에서 고른 것 — 이 브라우저에만). */
export const BAREOS_DETAIL_VC_KEY = 'bareos-detail-vc';
