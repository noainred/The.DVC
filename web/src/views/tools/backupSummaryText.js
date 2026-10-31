/**
 * Backup › Summary 순수 도우미(v2.836 — 백업 메뉴 개편 1-b · 사용자 요청 '서머리에는 veeam/bareos/ssh 3개를 합쳐 BackedUp ·
 *   백업 안함 · 확인 필요 세 합계' · '폴더를 클릭하면 VM list' · '지정한 시간만큼 백업되지 않은 VM 찾기' + 시안 ① Summary).
 *   법인 줄 수는 서버(veeam/backupSummaryAgg.js — Detail 과 같은 VM 행을 센 값)를 그대로 쓰고, 여기서는 묶음·비율·정렬·문구만 만든다.
 *   폴더·VM 줄은 그 법인의 Detail 응답을 backupViewText.buildTree 로 그린다(판정 코어 하나).
 *   ⚠ 못 읽은 값은 '—'(0 이 아니다) · 정책을 모르면 묶음을 그리지 않는다 · 부분 합은 '*'.
 */
import { methodOf, RPO_DAYS, STALE_DEFAULT, STALE_SOURCES, STALE_UNITS, staleWindowMs, fmtNum } from './backupViewText.js';

/** BackedUp = 백업하겠다고 정한 정책(Veeam · Bareos · SSH) 합 — 서버 backupSummaryAgg.BACKED_UP_KEYS 와 같다(테스트 대조). */
export const BACKED_UP_KEYS = Object.freeze(['veeam', 'bareos', 'ssh']);
/** 세 묶음(화면 순서 · 색). 백업 안함 · 확인 필요 색은 Detail 의 정책 색과 같다. */
export const BUNDLES = Object.freeze([
  { key: 'backed', text: 'BackedUp', color: '#4ade80', title: '정책이 Veeam · Bareos · SSH 인 VM 합 — 세부 구분은 Detail' },
  { key: 'none', text: '백업 안함', color: methodOf('none').color, title: '백업하지 않기로 정한 VM' },
  { key: 'check', text: '확인 필요', color: methodOf('check').color, title: '정책을 아직 정하지 않았거나 예전 값(Clone · Config 백업)인 VM' },
]);

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * 세 묶음 — 서버 법인 집계(pa: pol + polUnk) 또는 웹 폴더 집계(buildTree agg: pol.unk)를 같은 모양으로.
 * @returns {null | { n, backed, none, check, unk, parts:{veeam,bareos,ssh} }} 정책을 모르면 null(표시 파일 손상 — 0 이 아니다)
 */
export function bundlesOf(a) {
  if (!a || !a.pol) return null;
  const p = a.pol;
  const parts = { veeam: p.veeam || 0, bareos: p.bareos || 0, ssh: p.ssh || 0 };
  return { n: a.n || 0, backed: parts.veeam + parts.bareos + parts.ssh, none: p.none || 0, check: p.check || 0, unk: fin(a.polUnk) ? a.polUnk : (p.unk || 0), parts };
}

/** 법인 집계의 RPO(기준 일수) — { ok, miss, unk, pct } · 대상(충족+미달)이 없으면 pct null. */
export function siteRpo(pa, days) {
  const d = RPO_DAYS.includes(Number(days)) ? Number(days) : 1;
  const r = pa?.rpo?.[`d${d}`];
  if (!r) return null;
  const den = r.ok + r.miss;
  return { ...r, pct: den ? Math.round((r.ok / den) * 1000) / 10 : null };
}

/** RPO 비율 글자색 — 95% 이상 초록 · 80% 이상 노랑 · 그 밖 빨강(Detail 폴더 줄과 같은 기준). */
export const rpoColor = (pct) => (!fin(pct) ? 'var(--text-dim)' : pct >= 95 ? '#86efac' : pct >= 80 ? '#fcd34d' : '#fca5a5');

/**
 * 숫자 줄(KPI) — 합계(totals.pa)로. 정책을 모르는 법인이 있으면 정책 수에 '*'(부분 합).
 * @returns {{ vm, backed, none, check, rpo, mm, err }} 각 { value, sub }
 */
export function summaryPolicyKpis(t, { rpoDays = 1 } = {}) {
  const pa = t?.pa;
  const dash = { value: '—', sub: '' };
  if (!pa) return { vm: dash, backed: dash, none: dash, check: dash, rpo: dash, mm: dash, err: dash };
  const b = bundlesOf(pa);
  const star = (t.pa.polUnkSites || 0) > 0 ? '*' : '';
  const polSub = star ? ` · 표시 파일을 못 읽은 법인 ${t.pa.polUnkSites}곳 제외` : '';
  const r = siteRpo(pa, rpoDays);
  return {
    vm: { value: fmtNum(pa.n), sub: `법인 ${fmtNum(t.vcenters)}곳 · 켜짐 ${fmtNum(pa.on)}` },
    backed: { value: b ? `${fmtNum(b.backed)}${star}` : '—', sub: b ? `Veeam ${fmtNum(b.parts.veeam)} · Bareos ${fmtNum(b.parts.bareos)} · SSH ${fmtNum(b.parts.ssh)}${polSub}` : '' },
    none: { value: b ? `${fmtNum(b.none)}${star}` : '—', sub: '백업하지 않기로 정함' },
    check: { value: b ? `${fmtNum(b.check)}${star}` : '—', sub: '정책 미정 · 예전 값' },
    rpo: { value: r?.pct == null ? '—' : `${r.pct}%`, sub: r ? `충족 ${fmtNum(r.ok)} · 미달 ${fmtNum(r.miss)}${r.unk ? ` · 모름 ${fmtNum(r.unk)}` : ''} · 백업 안함 제외` : '' },
    mm: { value: fmtNum(pa.mm), sub: `Veeam ${fmtNum(pa.mmBy?.veeam)} · Bareos 미등록 ${fmtNum(pa.mmBy?.bareos)} · 그 밖 ${fmtNum(pa.mmBy?.other)}${pa.mmUnk ? ` · 모름 ${fmtNum(pa.mmUnk)}` : ''}` },
    err: { value: fmtNum(pa.err?.vms), sub: `실패 ${fmtNum(pa.err?.fail)} · 경고 ${fmtNum(pa.err?.warn)}` },
  };
}

/** 법인 줄 정렬 키(제목 버튼). 모르는 값(null)은 방향과 무관하게 늘 뒤. */
export const SITE_SORTS = Object.freeze({
  name: { text: '법인', get: (r) => String(r?.name || '') },
  gb: { text: '용량', get: (r) => (fin(r?.pa?.gb) && r.pa.n > r.pa.gbUnk ? r.pa.gb : null) },
  backed: { text: 'BackedUp 비율', get: (r) => { const b = bundlesOf(r?.pa); return b && b.n ? b.backed / b.n : null; } },
  rpo: { text: 'RPO', get: (r, o) => siteRpo(r?.pa, o?.rpoDays)?.pct ?? null },
  lok: { text: '마지막 백업', get: (r) => (fin(r?.pa?.lok) ? r.pa.lok : null) },
  nx: { text: '다음 예정', get: (r) => (fin(r?.pa?.nx) ? r.pa.nx : null) },
  err: { text: '실패', get: (r) => (fin(r?.pa?.err?.vms) ? r.pa.err.vms : null) },
});
const nat = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
/**
 * 법인 줄 정렬 — key 가 모르는 값이면 이름 순. 같은 값은 이름 순.
 * @param {'asc'|'desc'} dir
 */
export function sortSites(rows, key = 'name', dir = 'asc', o = {}) {
  const s = SITE_SORTS[key] || SITE_SORTS.name;
  const sign = dir === 'desc' ? -1 : 1;
  return (Array.isArray(rows) ? rows : []).slice().sort((a, b) => {
    const x = s.get(a, o); const y = s.get(b, o);
    if (x == null || y == null) return x == null && y == null ? nat.compare(String(a.name || ''), String(b.name || '')) : x == null ? 1 : -1;
    const c = typeof x === 'string' ? nat.compare(x, y) : x - y;
    return c ? c * sign : nat.compare(String(a.name || ''), String(b.name || ''));
  });
}

/** 법인 이름 아래 한 줄 — 그 법인의 값을 못 읽은 쪽을 밝힌다(0 이 아니다). */
export function siteNote(r) {
  const out = [];
  if (r?.veeamState === 'unlinked') out.push('Veeam 연동 없음');
  else if (r?.veeamState && r.veeamState !== 'ok') out.push('Veeam 일부·모름');
  if (r?.bareosUnknown) out.push('Bareos 원장 못 읽음');
  if (r?.pa && !r.pa.pol) out.push('정책 모름');
  return out.join(' · ');
}

/* ── 전체 법인 '백업 안 된 VM 찾기'(서버 GET /tools/backup-summary/stale) ─────────────────────── */

/** Summary 찾기 조건 기억 키(Detail 의 'backup-detail.stale' 과 따로 — 두 화면 조건이 섞이지 않게). */
export const SUMMARY_STALE_KEY = 'backup-summary.stale';
/** 조건 → 쿼리(서버 staleQueryOf 가 읽는 모양) · 전원·제외 범위는 Summary 옵션 그대로. 기간이 틀리면 null(부르지 않는다). */
export function staleQuery(o, scope = {}) {
  if (staleWindowMs(o?.n, o?.unit) == null) return null;
  return {
    n: String(o.n), unit: STALE_UNITS.some(([k]) => k === o.unit) ? o.unit : STALE_DEFAULT.unit,
    src: STALE_SOURCES.includes(o.src) ? o.src : 'all',
    excludeNone: o.excludeNone === false ? '0' : '1', onlyOn: o.onlyOn === false ? '0' : '1', includeNever: o.includeNever === false ? '0' : '1',
    power: scope.power || 'all', excl: scope.excl === false ? '0' : '1',
  };
}
/** 결과가 지금 조건으로 찾은 것인가(조건을 바꾸면 '다시 찾기' 를 알린다). */
export function staleQueryMatches(data, o) {
  const q = data?.q;
  if (!q) return false;
  return Number(q.n) === Number(o?.n) && q.unit === o?.unit && q.src === (o?.src || 'all') && q.excludeNone === (o?.excludeNone !== false)
    && q.onlyOn === (o?.onlyOn !== false) && q.includeNever === (o?.includeNever !== false);
}
