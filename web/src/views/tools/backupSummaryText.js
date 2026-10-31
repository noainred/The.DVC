/**
 * Backup › Summary 순수 도우미(v2.836 — 백업 메뉴 개편 1-b · 사용자 요청 '서머리에는 veeam/bareos/ssh 3개를 합쳐 BackedUp ·
 *   백업 안함 · 확인 필요 세 합계' · '폴더를 클릭하면 VM list' · '지정한 시간만큼 백업되지 않은 VM 찾기' + 시안 ① Summary).
 *   법인 줄 수는 서버(veeam/backupSummaryAgg.js — Detail 과 같은 VM 행을 센 값)를 그대로 쓰고, 여기서는 묶음·비율·정렬·문구만 만든다.
 *   폴더·VM 줄은 그 법인의 Detail 응답을 backupViewText.buildTree 로 그린다(판정 코어 하나).
 *   ⚠ 못 읽은 값은 '—'(0 이 아니다) · 정책을 모르면 묶음을 그리지 않는다 · 부분 합은 '*'.
 */
import { methodOf, RPO_DAYS, STALE_DEFAULT, STALE_SOURCES, STALE_UNITS, staleWindowMs, fmtNum, fmtGb } from './backupViewText.js';

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

const p2 = (x) => String(x).padStart(2, '0');
/** 'HH:MM'(이 브라우저 시각) — 모르면 '—'. */
export const hhmm = (ms) => (fin(ms) && ms > 0 ? (() => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; })() : '—');
/** RPO 기준 라벨(시안 '24시간') — 값은 Detail 과 같은 1·3·7일. */
export const rpoLabel = (d) => ({ 1: '24시간', 3: '3일', 7: '7일' }[Number(d)] || `${d}일`);
/** 7일 성공률(%) — { ok, bad } · 끝난 결과가 없으면 null. */
export const okPct = (x) => (x && x.ok + x.bad > 0 ? Math.round((x.ok / (x.ok + x.bad)) * 1000) / 10 : null);
const GB = 1024 ** 3;
/** 바이트 → '1.2 TB' · '512 GB'(fmtGb 와 같은 단위 — 1024). 모르면 '—'. */
export const bytesText = (b) => (fin(b) && b >= 0 ? fmtGb(b / GB) : '—');

/**
 * 숫자 줄(시안 ① 6칸 — v2.837) — 합계(totals.pa)와 법인 줄(rows)로. 정책을 모르는 법인이 있으면 정책 수에 '*'(부분 합).
 *   ① 보호 대상 VM ② RPO 충족 ③ 보호 안 됨 · 확인 안 됨 ④ 지금 실행 중 ⑤ 최근 24시간 백업(성공/경고/실패) ⑥ 백업된 용량
 * @returns {{ prot, rpo, unprot, run, r24, bytes }} 각 { value, sub, title? }
 */
export function summaryPolicyKpis(t, { rpoDays = 1, rows = [], em = null } = {}) {
  const pa = t?.pa;
  const dash = { value: '—', sub: '' };
  if (!pa) return { prot: dash, rpo: dash, unprot: dash, run: dash, r24: dash, bytes: dash };
  const b = bundlesOf(pa);
  const star = (pa.polUnkSites || 0) > 0 ? '*' : '';
  const r = siteRpo(pa, rpoDays);
  const label = rpoLabel(rpoDays);
  // ⑤ 가장 오래 걸린 법인 — 법인마다 24시간 결과의 시작~끝 폭(시작을 아는 것만)
  let longest = null;
  for (const x of Array.isArray(rows) ? rows : []) {
    const w = x?.pa?.win;
    if (fin(w?.start) && fin(w?.end) && w.end > w.start && (!longest || w.end - w.start > longest.ms)) longest = { name: x.name, ms: w.end - w.start };
  }
  const r24n = pa.r24 ? pa.r24.ok + pa.r24.warn + pa.r24.fail : 0;
  const bytesKnown = (pa.vbytesN || 0) + (pa.bbytesN || 0) > 0;
  const tr = em?.trend30;
  return {
    prot: { value: fmtNum(pa.n), sub: `법인 ${fmtNum(t.vcenters)}곳 · 켜짐 ${fmtNum(pa.on)}` },
    rpo: { value: r?.pct == null ? '—' : `${r.pct}%`, sub: r ? `${fmtNum(r.ok)}대 — ${label} 안에 성공한 백업 있음${r.unk ? ` · 모름 ${fmtNum(r.unk)}` : ''} · 백업 안함 제외` : '' },
    unprot: {
      value: b ? `${fmtNum(pa.unprot + b.check)}${star} · ${fmtNum(pa.unver)}` : `— · ${fmtNum(pa.unver)}`,
      sub: b ? `BackedUp ${fmtNum(b.backed)}(Veeam ${fmtNum(b.parts.veeam)} · Bareos ${fmtNum(b.parts.bareos)} · SSH ${fmtNum(b.parts.ssh)}) · 백업 안함 ${fmtNum(b.none)} · 확인 필요 ${fmtNum(b.check)} — 합 ${fmtNum(b.backed + b.none + b.check + b.unk)} · 보호 안 됨 = BackedUp 인데 백업 결과 없음 ${fmtNum(pa.unprot)} + 확인 필요 ${fmtNum(b.check)}${star ? ` · 표시 파일을 못 읽은 법인 ${pa.polUnkSites}곳 제외` : ''}` : '정책을 모름(표시 파일)',
      title: '보호 안 됨 = 정책이 BackedUp(Veeam · Bareos · SSH)인데 성공한 백업이 한 번도 없다고 확인된 VM + 정책 확인 필요 · 확인 안 됨 = 백업 안함이 아닌데 결과를 읽지 못한 VM(따로 셉니다)',
    },
    // v2.781(점검 G3 B-B1) 규칙 그대로: 마지막 읽기가 실패·오래된 Veeam 서버가 있으면 Veeam 실행 수는 하한('≥N') — 그 서버의 실행 중은 모른다
    run: {
      value: `${(t.runningUnknown || 0) > 0 ? '≥' : ''}${fmtNum((pa.run || 0) + (pa.brun || 0))}`,
      sub: `Veeam ${(t.runningUnknown || 0) > 0 ? '≥' : ''}${fmtNum(pa.run)} · Bareos ${fmtNum(pa.brun)}${pa.bwait ? ` · 대기 ${fmtNum(pa.bwait)}` : ''}${t.stuck == null ? '' : ` · 멈춤 의심 ${fmtNum(t.stuck)}`}${(t.runningUnknown || 0) > 0 ? ` · Veeam 모름 ${t.runningUnknown}곳(마지막 읽기 실패·오래됨)` : ''}`,
      title: t.stuck == null ? '멈춤 의심은 Bareos › 진행 현황 화면이 열려 최근 조회한 값이 있을 때만 셉니다' : undefined,
    },
    r24: {
      value: r24n ? `${fmtNum(pa.r24.ok)} / ${fmtNum(pa.r24.warn)} / ${fmtNum(pa.r24.fail)}` : '0 / 0 / 0',
      sub: [fin(pa.win?.start) && fin(pa.win?.end) ? `백업 기간 ${hhmm(pa.win.start)}~${hhmm(pa.win.end)}` : '', longest ? `가장 오래 걸림 ${longest.name}` : ''].filter(Boolean).join(' · ') || 'VM 마지막 결과 기준',
      title: 'VM 마다 마지막 결과(Veeam · Bareos 따로)가 최근 24시간 안에 끝난 것 — 성공 / 경고 / 실패(취소 포함)',
    },
    bytes: {
      value: bytesKnown ? bytesText((pa.vbytes || 0) + (pa.bbytes || 0)) : '—',
      sub: bytesKnown ? `Veeam ${bytesText(pa.vbytes)} · Bareos ${bytesText(pa.bbytes)}${tr ? ` · 저장소 30일 ${tr.pct > 0 ? '+' : ''}${tr.pct}%` : ''}` : '크기를 읽은 VM 이 없습니다',
      title: 'Veeam = 복원 지점 크기 합(B&R 결과) · Bareos = VM 마다 마지막 실행 크기 합(카탈로그 전체가 아니다) · 30일 추이 = Veeam 저장소 사용(EM 이력)',
    },
  };
}

/**
 * 찾기 행의 조치(시안 '조치' 열) — 이유에 맞는 다음 화면. 권한이 없는 화면은 Detail 로.
 * @returns {{ key:'veeam-run'|'bareos-target'|'live'|'policy'|'detail', text:string }}
 */
export function staleAction(row, { canRun = false, canBareos = false } = {}) {
  const vm = row?.vm || {};
  if (row?.kind === 'unknown') return { key: 'detail', text: 'Detail 에서 확인' };
  if (vm.b?.run && canBareos) return { key: 'live', text: '진행 현황' };
  if (vm.mm === true && vm.p === 'veeam' && canRun) return { key: 'veeam-run', text: 'Veeam 백업 실행' };
  if (vm.mm === true && vm.p === 'bareos' && canBareos) return { key: 'bareos-target', text: 'Bareos 대상 등록' };
  if (vm.p === 'check' || !vm.p) return { key: 'policy', text: '정책 정하기' };
  return { key: 'detail', text: 'Detail' };
}

/** 법인 줄 배지(시안 — 멈춤 의심 · 엣지 대행 · 인증 실패 · 한쪽 솔루션만). 모르면 넣지 않는다. */
export function siteBadges(r) {
  const out = [];
  if (fin(r?.stuck) && r.stuck > 0) out.push({ key: 'stuck', text: `멈춤 의심 ${r.stuck}`, tone: 'warn' });
  if (r?.bEdge) out.push({ key: 'edge', text: 'Director 엣지 대행', tone: 'info' });
  if (fin(r?.veeamAuth) && r.veeamAuth > 0) out.push({ key: 'auth', text: `Veeam 인증 실패 ${r.veeamAuth}`, tone: 'bad' });
  if (r?.bMapped === false && r?.veeamState && r.veeamState !== 'unlinked') out.push({ key: 'vonly', text: 'Veeam 만', tone: 'muted' });
  if (r?.bMapped === true && r?.veeamState === 'unlinked') out.push({ key: 'bonly', text: 'Bareos 만', tone: 'muted' });
  return out;
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
    ...(o.vc ? { vc: String(o.vc) } : {}),   // v2.837 법인 하나(빈 값 = 전체)
  };
}
/** 결과가 지금 조건으로 찾은 것인가(조건을 바꾸면 '다시 찾기' 를 알린다). */
export function staleQueryMatches(data, o) {
  const q = data?.q;
  if (!q) return false;
  return Number(q.n) === Number(o?.n) && q.unit === o?.unit && q.src === (o?.src || 'all') && q.excludeNone === (o?.excludeNone !== false)
    && q.onlyOn === (o?.onlyOn !== false) && q.includeNever === (o?.includeNever !== false) && (q.vc || '') === (o?.vc || '');
}
