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
    fail: st === 'error',
    cancel: st === 'canceled',   // v2.870 사람이 멈춘 실행 — 실패와 따로(서버 vmView.bareosClass 와 같다)
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
  const den = Math.max(c.jobs, (c.ok || 0) + (c.warn || 0) + (c.fail || 0) + (c.cancel || 0) + (c.run || 0));
  const p = (n) => Math.round(((n || 0) / den) * 1000) / 10;
  return { ok: p(c.ok), warn: p(c.warn), fail: p(c.fail), cancel: p(c.cancel), run: p(c.run) };
}

/**
 * v2.860 법인 줄의 '확인 필요'(현황 화면 · 시안 ①) — 실패 + 미등록 + 오래됨 + 백업 없음(우선 확인과 같은 종류).
 *   결과를 모르는 법인(인증 정지 · 조회 실패 · 미설정)은 결과 기준 수가 null 이라 n 도 null(모름 — 0 이 아니다). 미등록은 따로 알 수 있으면 싣는다.
 */
export function corpAttention(c) {
  const parts = { fail: c?.fail ?? null, missing: c?.missing ?? null, old: c?.old ?? null, never: c?.never ?? null };
  const known = [parts.fail, parts.old, parts.never].every((v) => isFin(v));
  const n = known && isFin(parts.missing) ? parts.fail + parts.missing + parts.old + parts.never : null;
  return { n, parts };
}
/** 법인 줄의 칸 — unknown(결과 모름) · attn(확인 필요) · ok(정상). 세 칸은 겹치지 않는다(칩 수의 합 = 전체). */
export function corpBucket(row) {
  if (!row?.director || ['auth', 'error', 'unset'].includes(row.director.state)) return 'unknown';
  const a = corpAttention(row.counts);
  return a.n === null ? 'unknown' : a.n > 0 ? 'attn' : 'ok';
}
export const CORP_BUCKETS = Object.freeze([['all', '전체'], ['attn', '확인 필요'], ['ok', '정상'], ['unknown', '모름']]);
/** 합계 칸 글자 — 일부 법인이 모름이면 '*'(부분 합). */
export const partialText = (t, k) => (t ? `${numText(t[k])}${t.partial?.[k] ? '*' : ''}` : '—');

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
  ['all', '전체'], ['attn', '확인 필요'], ['job', '잡 등록'], ['missing', '미등록'], ['run', '진행 중'], ['bad', '실패·경고·취소'], ['old', '오래된 백업'], ['never', '백업 없음'], ['off', '잡 꺼짐'], ['mismatch', '방식 불일치'], ['gone', '인벤토리에 없음'],
];
/**
 * v2.860(사용자 요청 'Bareos UI 전폭 개선 — 직관적이고 복잡하지 않게' · docs/design/bareos-ui-v2 시안 ②): 법인 화면은 칩 6개만 먼저 보이고
 *   나머지는 '더 보기' 뒤에 둔다. 판정(rowMatches)·수(detailFilterCounts)는 그대로 — 보이는 자리만 나눈다.
 */
export const DETAIL_FILTERS_MAIN = Object.freeze(['all', 'attn', 'run', 'bad', 'missing', 'old']);
export const DETAIL_FILTERS_MORE = Object.freeze(['job', 'never', 'off', 'mismatch', 'gone']);
/** 행이 보기 필터에 드는가. resultsKnown=false 면 결과 기준 필터(run·bad·old·never)에 넣지 않는다(모름). */
export function rowMatches(r, f, { rpoDays = 1, now = Date.now(), resultsKnown = true } = {}) {
  const k = bareosClass(r?.b, { rpoDays, now });
  if (f === 'job') return k.job;
  if (f === 'missing') return k.missing;
  if (f === 'off') return k.off;
  if (f === 'gone') return k.gone;
  if (f === 'mismatch') return k.job && !k.gone && r.method != null && r.method !== 'bareos';   // 서버 corpCounts 와 같다(인벤토리에 없는 VM 은 세지 않는다)
  // v2.860 '확인 필요' = 우선 확인과 같은 종류(실패 · 미등록 · 오래됨 · 백업 없음) — 결과를 모르면 미등록만(결과 기준 종류는 모름)
  if (f === 'attn') return k.missing || (resultsKnown && (k.fail || k.old || (k.never && k.on)));
  if (!resultsKnown) return f === 'all';
  if (f === 'run') return k.run;
  if (f === 'bad') return k.fail || k.warn || k.cancel;
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
  // '확인 필요' 는 결과를 모르면(인증 정지 등) 미등록만 센 부분 수다 — 0 으로 오해하지 않게 모름(—)으로
  if (opts?.resultsKnown === false) out.attn = null;
  if (opts?.registryKnown === false) for (const [k] of DETAIL_FILTERS) if (k !== 'all') out[k] = null;
  return out;
}

const nat = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
/**
 * 폴더 트리(법인별 현황) — 보기·검색에 드는 행만 담고, 폴더마다 그 아래 전체 행의 집계(잡·성공·경고·실패·진행·미등록)를 단다.
 *   인벤토리에 없는 잡(gone)은 원장의 등록 때 위치로 놓인다.
 */
export function buildBareosTree(rows, { filter = 'all', q = '', rpoDays = 1, now = Date.now(), resultsKnown = true } = {}) {
  const mk = (key, name) => ({ key, name, children: new Map(), rows: [], agg: { n: 0, job: 0, ok: 0, warn: 0, fail: 0, cancel: 0, run: 0, missing: 0, gb: 0 }, hit: 0 });
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
      if (k.ok) n.agg.ok++; if (k.warn) n.agg.warn++; if (k.fail) n.agg.fail++; if (k.cancel) n.agg.cancel++; if (k.run) n.agg.run++;
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
/**
 * v2.846 버그 점검(U-8): 서버가 VM 단위 목록을 싣지 않은 경우(법인별 현황 권한 없음 — bareosViews summaryData 의 priorityWithheld) —
 *   칩 수는 '—'(0 이 아니다) · 빈 표 문구는 '확인할 VM 없음' 이 아니라 권한 안내.
 */
export const PRIORITY_WITHHELD_TEXT = '법인별 현황(Bareos 법인별) 권한이 있어야 VM 목록이 보입니다 — 이 계정에는 우선 확인 목록을 싣지 않았습니다(확인할 VM 이 없다는 뜻이 아닙니다).';
/** 우선 확인 칩 글자 — 목록을 받지 못했으면 '—'. */
export function priorityChips(data) {
  const held = !!data?.priorityWithheld;
  const n = (v) => (held ? '—' : String(isFin(v) ? v : 0));
  return [['all', `전체 ${n(data?.priorityTotal)}`], ...Object.keys(PRIORITY_TEXT).map((k) => [k, `${PRIORITY_TEXT[k]} ${n(data?.priorityByKind?.[k])}`])];
}
/** 우선 확인 표가 비었을 때 문구. */
export const priorityEmptyText = (data) => (data?.priorityWithheld ? PRIORITY_WITHHELD_TEXT : '확인할 VM 이 없습니다.');

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

/* ── Bareos 탭(v2.860 — 9개 → 5개 · docs/design/bareos-ui-v2 시안 ⓪) ──
 *   현황(bareos-summary) · 법인(bareos-detail) · 운영(bareos-backup — 백업 대상 · 백업 그룹 · 진행·이력) · 정책 · 보존(bareos-summary/policy) · 설정(bareos-backup/settings).
 *   도구 키 · 권한 · 서버 집행은 그대로다(탭은 UX 게이팅 — 서버가 진실의 원천). 어느 도구 키로 들어와도 같은 자리 · 같은 모양(BareosTabs 하나).
 */
export function bareosSubTabs({ summaryOk = false, detailOk = false, manageOk = false, admin = false, fullScope = false } = {}) {
  return [
    ...(summaryOk ? [['summary', '현황', '#/tools/bareos-summary']] : []),
    ...(detailOk ? [['detail', '법인', '#/tools/bareos-detail']] : []),
    ...(admin && manageOk ? [['ops', '운영', '#/tools/bareos-backup/targets']] : []),
    ...(summaryOk ? [['policy', '정책 · 보존', '#/tools/bareos-summary/policy']] : []),
    ...(admin && manageOk && fullScope ? [['settings', '설정', '#/tools/bareos-backup/settings']] : []),
  ];
}
/** 운영 탭 안의 묶음(관리 도구 bareos-backup 의 하위 주소). 설정은 위 탭 줄의 '설정' 이다. */
export const OPS_SEGMENTS = Object.freeze([['targets', '백업 대상'], ['groups', '백업 그룹'], ['restore', '복원'], ['runs', '진행 · 이력']]);   // v2.861 복원(폴더에서 고르기 · 3단계)
/** 관리 도구의 하위 주소 → 위 탭 키. */
export const opsTopOf = (tab) => (tab === 'settings' ? 'settings' : 'ops');
/**
 * v2.860 옛 하위 주소 → 새 하위 주소(북마크 · 다른 화면의 링크가 살아 있게). 진행 현황(live) · 실행 현황 · 이력(history)은 '진행 · 이력'(runs) 하나가 됐고,
 *   보존 · 풀(pools)은 정책 · 보존 한 화면의 풀 구획이다.
 */
export const LEGACY_OPS_TAB = Object.freeze({ live: 'runs', history: 'runs' });
export const opsTabOf = (tab) => LEGACY_OPS_TAB[tab] || tab;
const OPS_BASE = ['tools', 'bareos-backup'];
const segsOf = (hash) => String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
const underOps = (s) => OPS_BASE.every((b, i) => s[i] === b);
/**
 * 옛 하위 주소면 새 주소(그 아래 조각은 그대로 — live/corp → runs/corp), 아니면 null.
 *   부르는 쪽은 자식이 주소를 읽기 전에(렌더 중) replaceState 한다 — 효과에서 바꾸면 자식(현황판)이 옛 주소를 먼저 읽어 보기를 잃는다.
 */
export function legacyOpsHash(hash) {
  const s = segsOf(hash);
  if (!underOps(s) || !LEGACY_OPS_TAB[s[2]]) return null;
  return `#/${[...OPS_BASE, LEGACY_OPS_TAB[s[2]], ...s.slice(3)].join('/')}`;
}
/** 진행 · 이력에서 법인별 진행 현황판을 펼친 채로 열지 — 옛 진행 현황 주소(live)로 왔거나 현황판 보기가 주소에 있으면(runs/<보기>). */
export function runsBoardOpen(hash) {
  const s = segsOf(hash);
  return underOps(s) && (s[2] === 'live' || (s[2] === 'runs' && !!s[3]));
}
/**
 * v2.860 법인 화면 → 운영 › 백업 대상 넘기기(그 VM 의 대상을 골라 오른쪽 패널을 연다 — 한 번 읽고 지운다 · 10분). 쓰기는 운영(관리자)에서만.
 */
export const TARGET_FOCUS_KEY = 'bareos-backup.focus';
export function saveTargetFocus(vcenterId, vmId, store = globalThis.sessionStorage) {
  try { store?.setItem(TARGET_FOCUS_KEY, JSON.stringify({ vcenterId: String(vcenterId || ''), vmId: String(vmId || ''), at: Date.now() })); return true; } catch { return false; }
}
/**
 * v2.871 통합 에러 로그 '이력 →'(시안 docs/design/bareos-errlog ③) — 진행 · 이력에서 그 VM 을 대상으로 고르고 그 실행(jobid)의 작업 로그를 요약으로 연 채 뜬다.
 *   예전에는 고정 주소로만 가서 대상 목록의 첫 VM(실패한 VM 과 무관)이 보였다(사용자 스크린샷 2026-11-04). 같은 열쇠 · 한 번 읽고 지운다 · 10분.
 */
export function saveRunFocus(vcenterId, vmId, jobid, store = globalThis.sessionStorage) {
  const n = Number(jobid);
  try { store?.setItem(TARGET_FOCUS_KEY, JSON.stringify({ vcenterId: String(vcenterId || ''), vmId: String(vmId || ''), jobid: Number.isInteger(n) && n > 0 ? n : null, tab: 'runs', at: Date.now() })); return true; } catch { return false; }
}
export function takeTargetFocus(store = globalThis.sessionStorage, now = Date.now()) {
  let raw = null;
  try { raw = store?.getItem(TARGET_FOCUS_KEY); store?.removeItem(TARGET_FOCUS_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j.vmId !== 'string' || !j.vmId || !(now - Number(j.at) <= HANDOFF_TTL_MS)) return null;
    const n = Number(j.jobid);
    return { vcenterId: String(j.vcenterId || ''), vmId: j.vmId, tab: j.tab === 'runs' ? 'runs' : 'targets', jobid: Number.isInteger(n) && n > 0 ? n : null };
  } catch { return null; }
}
/** 법인별 현황이 이어받을 vCenter(통합 표에서 고른 것 — 이 브라우저에만). */
export const BAREOS_DETAIL_VC_KEY = 'bareos-detail-vc';
