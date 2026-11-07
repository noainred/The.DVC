/**
 * views/featureUsageText.js — 설정 › 사용자 › 기능 사용 현황의 순수 판정 · 문구(v2.913, 설계 docs/design/feature-usage).
 *
 * 화면 키(서버 usage/keys.js) → 사람이 읽는 이름 · 메뉴 위치 · 종류 · 묶음. 이름의 원천은 하나씩이다:
 *   탭 · 메뉴 위치 = views/topMenu.js MENU_GROUPS · 도구 이름 · 관리자 전용 · 준비 중 = views/specialToolsList.js TOOLS ·
 *   설정 하위 = Settings.jsx SUB(화면이 settingsMeta 로 넘긴다 — 순환 import 를 만들지 않는다) · 콘솔 = console/nav.js 의 묶음 이름.
 * '못 센 것은 0 이 아니다': 직전 기간 기록이 없으면 비교는 null('—'), 기록이 꺼져 있던 날은 하루 평균의 분모에서 뺀다.
 * UI 개선 단서는 **규칙으로** 뽑고 규칙 문구를 함께 낸다(판단은 사람이 한다).
 * 문구에 백틱 금지 · 값 인용은 ‘ ’(BoldText 규약).
 */
import { MENU_GROUPS } from './topMenu.js';
import { PLATFORM_TABS } from './platform/platformText.js'; // v2.915 가상화 플랫폼 항목이 맡는 탭 이름
const PLATFORM_TAB_LABEL = new Map(PLATFORM_TABS.map((t) => [t.k, t.label]));
import { TOOLS } from './specialToolsList.js';

export const PERIODS = Object.freeze([7, 30, 90, 365]);
/** 기능별 표가 처음에 보이는 행 수(정렬한 뒤 자른다 — STable limit · 나머지 수를 화면이 밝힌다). */
export const FEATURE_LIMIT = 60;
export const VIEWS = Object.freeze([
  { k: 'overview', label: '개요' }, { k: 'features', label: '기능별' }, { k: 'users', label: '사용자별' }, { k: 'settings', label: '수집 설정' },
]);
export const CONSOLE_LABELS = Object.freeze({ overview: '전사 현황', compute: '컴퓨트', storage: '스토리지', network: '네트워크', facility: '물리 · 설비', alarms: '알람' });
export const KIND_LABEL = Object.freeze({ tab: '탭', tool: '도구', settings: '설정', console: '콘솔' });
export const KIND_BADGE = Object.freeze({ tab: 'gray', tool: 'blue', settings: 'purple', console: 'teal' });
export const TOOL_SEGS = Object.freeze({ serveranalysis: ['baremetal'] });

/**
 * 메뉴 묶음(색은 묶음에 고정 — 순위로 칠하지 않는다). 범주 색 5 + 중립(기타)은 dataviz 검증기로 어두운 패널(#141b2d) 위에서
 * 밝기 띠 · 채도 · 색각 이상 구분 · 대비를 통과한 값이다(설계 README 머리말 — 포탈 토큰의 밝은 색은 밝기 띠를 넘는다).
 */
export const BUCKETS = Object.freeze([
  { id: 'server', label: '서버', color: '#3b82f6' },
  { id: 'home', label: 'Overview · Summary', color: '#d97706' },
  { id: 'storage', label: '스토리지', color: '#0891b2' },
  { id: 'collab', label: '이슈 · 위키 · 게시판', color: '#9333ea' },
  { id: 'tools', label: '특수 기능', color: '#0d9488' },
  { id: 'etc', label: '기타', color: '#5d6b85' },
]);
const BUCKET_OF_GROUP = { overview: 'home', summary: 'home', server: 'server', storage: 'storage', issues: 'collab', wiki: 'collab', board: 'collab', tools: 'tools' };

/** 메뉴 항목 표(탭 · 도구 → 위치) — MENU_GROUPS 에서 한 번 만든다. */
function menuIndex(groups = MENU_GROUPS) {
  const tab = new Map(); const tool = new Map(); const items = [];
  for (const g of groups) {
    const list = Array.isArray(g.children) ? g.children : [g];
    for (const c of list) {
      const where = Array.isArray(g.children) ? `${g.label} › ${c.label}` : g.label;
      const item = { group: g.id, groupLabel: g.label, label: c.label, where };
      if (c.tab) { if (!tab.has(c.tab)) tab.set(c.tab, item); items.push({ ...item, k: c.tab === 'tools' ? 'tab:tools' : `tab:${c.tab}` }); }
      // v2.915: 한 항목이 맡는 나머지 탭(가상화 플랫폼의 hosts · vms) — 같은 자리(서버 › 가상화 플랫폼)이고 이름은 '항목 › 탭'. 추적 키(tab:vms)는 그대로다.
      for (const t of Array.isArray(c.tabs) ? c.tabs : []) {
        const tl = PLATFORM_TAB_LABEL.get(t) || t;
        const sub = { ...item, label: `${c.label} › ${tl}`, where: `${where} › ${tl}` };
        if (!tab.has(t)) tab.set(t, sub);
        items.push({ ...sub, k: `tab:${t}` });
      }
      if (c.tool) {
        const key = c.seg ? `${c.tool}/${c.seg}` : c.tool;
        if (!tool.has(key)) tool.set(key, { ...item, direct: true });
        items.push({ ...item, k: `tool:${key}` });
      }
      // also: 그 메뉴 화면 위 탭으로 여는 도구(탭 항목 · 도구 항목 둘 다 가질 수 있다 — 가상화 서버 · Backup)
      for (const a of Array.isArray(c.also) ? c.also : []) if (!tool.has(a)) tool.set(a, { ...item, where: `${where} 화면 위 탭`, direct: false });
    }
  }
  return { tab, tool, items };
}
const MENU = menuIndex();
const TOOL_BY_K = new Map(TOOLS.map((t) => [t.k, t]));

/**
 * 화면 키 → 표시 정보.
 * @param {string} k
 * @param {{ settingsMeta?: {k:string,label:string,groupLabel:string,superOnly?:boolean}[] }} [ctx]
 * @returns {{ k, kind, kindLabel, label, where, bucket, inMenu:boolean, cardOnly:boolean, adminOnly:boolean, notReady:boolean, auth:string }}
 */
export function keyMeta(k, ctx = {}) {
  const s = String(k || '');
  const i = s.indexOf(':');
  const kind = i > 0 ? s.slice(0, i) : '';
  const rest = i > 0 ? s.slice(i + 1) : s;
  const base = { k: s, kind, kindLabel: KIND_LABEL[kind] || '기타', label: rest || s, where: '', bucket: 'etc', inMenu: false, cardOnly: false, adminOnly: false, notReady: false, auth: '' };
  if (kind === 'tab') {
    if (rest === 'tools') return { ...base, label: '특수 기능(카드 목록)', where: '특수 기능', bucket: 'tools', inMenu: true, auth: '전체' };
    if (rest === 'settings') return { ...base, label: '설정', where: '설정', bucket: 'etc', inMenu: true, auth: '설정 소유자' };
    const m = MENU.tab.get(rest);
    return { ...base, label: m?.label || rest, where: m?.where || '', bucket: BUCKET_OF_GROUP[m?.group] || 'etc', inMenu: !!m, auth: '' };
  }
  if (kind === 'tool') {
    const [tk, seg] = rest.split('/');
    const t = TOOL_BY_K.get(tk);
    const m = MENU.tool.get(rest) || (seg ? null : MENU.tool.get(tk));
    // 메뉴 항목 그 자체면 메뉴 이름(사람이 누르는 글자), 화면 위 탭 · 카드면 카탈로그 이름.
    const label = m && m.direct ? m.label : (t?.label || tk);
    return {
      ...base, label, where: m ? m.where : '특수 기능 카드',
      bucket: m ? (BUCKET_OF_GROUP[m.group] || 'etc') : 'tools',
      inMenu: !!m, cardOnly: !m, adminOnly: !!t?.adminOnly, notReady: !!(t?.disabled || t?.comingSoon),
      auth: t?.adminOnly ? '관리자 전용' : 'tools 권한',
    };
  }
  if (kind === 'settings') {
    const m = (ctx.settingsMeta || []).find((x) => x.k === rest);
    return { ...base, label: m?.label || rest, where: m ? `설정 › ${m.groupLabel} › ${m.label}` : '설정', bucket: 'etc', inMenu: true, auth: m?.superOnly ? '슈퍼 관리자' : '설정 소유자' };
  }
  if (kind === 'console') return { ...base, label: `관제 콘솔 › ${CONSOLE_LABELS[rest] || rest}`, where: '헤더 데이터 소스 배지', bucket: 'etc', inMenu: false, auth: '전체' };
  return base;
}

/** 추적 단위 전체(기능별 탭의 행) — 쓰이지 않은 화면까지 보이게. */
export function allUsageKeys(ctx = {}) {
  const out = new Set();
  for (const it of MENU.items) out.add(it.k);
  out.add('tab:tools'); out.add('tab:settings');
  for (const t of TOOLS) out.add(`tool:${t.k}`);
  for (const [tk, segs] of Object.entries(TOOL_SEGS)) for (const sg of segs) out.add(`tool:${tk}/${sg}`);
  for (const m of ctx.settingsMeta || []) out.add(`settings:${m.k}`);
  for (const c of Object.keys(CONSOLE_LABELS)) out.add(`console:${c}`);
  return [...out];
}

/** 메뉴 항목(상단 메뉴 · 설정 하위) 키 — '정리 후보' 의 모집단. */
export function menuItemKeys(ctx = {}) {
  return [...new Set([...MENU.items.map((x) => x.k), ...(ctx.settingsMeta || []).map((m) => `settings:${m.k}`)])];
}

/* ── 수치 · 문구 ─────────────────────────────────────────────────────────── */
const n0 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const fmtInt = (v) => (n0(v) == null ? '—' : Math.round(v).toLocaleString('ko-KR'));

/** 머문 시간 — 41시간 20분 · 3분 48초 · 12초. 값이 없으면 '—'. */
export function fmtDur(ms) {
  const v = n0(ms);
  if (v == null) return '—';
  const s = Math.round(v / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분${s % 60 ? ` ${s % 60}초` : ''}`;
  const h = Math.floor(m / 60);
  return `${h.toLocaleString('ko-KR')}시간${m % 60 ? ` ${m % 60}분` : ''}`;
}
/** 파일 크기 — 값이 없으면 '—', 1MB 미만은 KB. */
export function fmtBytes(b) {
  const v = n0(b);
  if (v == null) return '크기 —';
  if (v < 1048576) return `${Math.max(1, Math.round(v / 1024)).toLocaleString('ko-KR')} KB`;
  return `${(v / 1048576).toFixed(1)} MB`;
}
/** 1회 평균 — 열람이 0 이면 '—'. */
export const avgPerView = (ms, views) => (n0(views) && views > 0 && n0(ms) != null ? fmtDur(ms / views) : '—');
export const pctText = (part, total) => (n0(total) && total > 0 && n0(part) != null ? `${((part / total) * 100).toFixed(1)}%` : '—');

/**
 * 지난 기간 대비 — prev 가 null 이면(그 기간 기록이 날마다 있지 않음) '—', prev 0 이면 '새로'.
 * 기록한 날 수가 다르면(이번 기간에 꺼진 날이 있으면) 하루 평균끼리 비교한다: curDays · prevDays 를 주면 cur/curDays 와 prev/prevDays 를 견준다.
 */
export function trendOf(cur, prev, curDays = 0, prevDays = 0) {
  if (prev == null) return { text: '—', dir: 'flat' };
  if (curDays > 0 && prevDays > 0 && curDays !== prevDays) { cur /= curDays; prev /= prevDays; }
  if (prev === 0) return cur > 0 ? { text: '새로', dir: 'up' } : { text: '—', dir: 'flat' };
  const d = Math.round(((cur - prev) / prev) * 100);
  return { text: `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d)}%`, dir: d >= 3 ? 'up' : d <= -3 ? 'dn' : 'flat' };
}

const pad2 = (n) => String(n).padStart(2, '0');
/** epoch ms → 'MM-DD HH:mm'(한국 시각). 값이 없으면 '—'. */
export function fmtWhen(ts) {
  const v = n0(ts);
  if (v == null) return '—';
  const d = new Date(v + 9 * 3_600_000);
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** 묶음별 열람 합(색은 BUCKETS 고정). '기타' 안의 내역도 돌려준다. */
export function bucketShares(byKey, ctx = {}) {
  const sum = Object.fromEntries(BUCKETS.map((b) => [b.id, 0]));
  const etc = new Map();
  let total = 0;
  for (const r of byKey || []) {
    const m = keyMeta(r.k, ctx);
    sum[m.bucket] = (sum[m.bucket] || 0) + r.views;
    total += r.views;
    if (m.bucket === 'etc') {
      const g = m.kind === 'settings' || r.k === 'tab:settings' ? '설정' : m.kind === 'console' ? '관제 콘솔' : (m.where.split(' › ')[0] || '그 밖');
      etc.set(g, (etc.get(g) || 0) + r.views);
    }
  }
  return { total, rows: BUCKETS.map((b) => ({ ...b, views: sum[b.id] || 0 })), etc: [...etc.entries()].sort((a, b) => b[1] - a[1]) };
}

/** 하루 평균 — 기록이 켜져 있던 날만 분모로(꺼진 날은 0 이 아니다). */
export function perDay(total, recDays) { return recDays > 0 ? total / recDays : null; }

/**
 * UI 개선 단서(규칙 — 화면이 규칙 문구를 함께 보인다).
 *  · 승격 후보: 메뉴 항목이 아닌 도구(카드 전용) 중 열람 상위 3 · 사용자 2명 이상
 *  · 정리 후보: 메뉴 항목(상단 메뉴 · 설정 하위) 중 이 기간 0회 · 준비 중 제외 — 기록이 켜진 날이 없으면 판단하지 않는다
 *  · 깊이: 설정 하위 · 카드 전용 도구 중, 그 화면을 주 3회 이상 연 사용자가 있는 것(열람 많은 순 3)
 */
export const HINT_RULES = Object.freeze({
  promote: '규칙: 메뉴 항목이 아닌 도구(특수 기능 카드로만 여는 것) 중 열람 상위 3 · 사용자 2명 이상',
  prune: '규칙: 메뉴 항목(상단 메뉴 · 설정 하위) 중 이 기간 0회 · 준비 중 항목 제외 · 권한 때문에 아무도 열 수 없는 항목일 수 있다',
  depth: '규칙: 설정 하위 · 카드 전용 도구 중 주 3회 이상 여는 사용자가 있는 화면(열람 많은 순)',
});
export function usageHints(report, ctx = {}) {
  const empty = { promote: [], prune: { items: [], total: 0 }, depth: [] };
  if (!report || !(report.totals?.recDays > 0)) return empty;
  const byKey = new Map((report.byKey || []).map((r) => [r.k, r]));
  const promote = (report.byKey || []).filter((r) => keyMeta(r.k, ctx).cardOnly && r.users >= 2).slice(0, 3)
    .map((r) => ({ k: r.k, label: keyMeta(r.k, ctx).label, views: r.views, users: r.users }));
  const pruneAll = menuItemKeys(ctx).filter((k) => !(byKey.get(k)?.views > 0)).map((k) => keyMeta(k, ctx)).filter((m) => !m.notReady)
    .map((m) => ({ k: m.k, label: m.label, where: m.where }));
  const weeks = Math.max(1, (report.range?.days || 7) / 7);
  const heavy = new Map();
  for (const [, k, v] of report.userKeys || []) {
    const m = keyMeta(k, ctx);
    if (!(m.kind === 'settings' || m.cardOnly)) continue;
    if (v / weeks >= 3) heavy.set(k, (heavy.get(k) || 0) + 1);
  }
  const depth = [...heavy.entries()].map(([k, users]) => ({ k, label: keyMeta(k, ctx).where || keyMeta(k, ctx).label, views: byKey.get(k)?.views || 0, users }))
    .sort((a, b) => b.views - a.views).slice(0, 3);
  return { promote, prune: { items: pruneAll.slice(0, 4), total: pruneAll.length }, depth };
}

/** 사용자 표 필터. */
export function filterUsers(users, { role = '', scope = '', src = '', q = '' } = {}) {
  const t = String(q || '').trim().toLowerCase();
  return (users || []).filter((u) => (!role || u.role === role)
    && (!scope || (scope === 'full' ? !u.scoped : !!u.scoped))
    && (!src || u.src === src)
    && (!t || `${u.user} ${u.name || ''}`.toLowerCase().includes(t)));
}

/** 기능 표 필터. status: '' | used | unused | admin | notReady */
export function filterFeatures(rows, { kind = '', status = '', q = '' } = {}) {
  const t = String(q || '').trim().toLowerCase();
  return (rows || []).filter((r) => (!kind || r.meta.kind === kind)
    && (!status || (status === 'used' ? r.views > 0 : status === 'unused' ? !(r.views > 0) && !r.meta.notReady : status === 'admin' ? r.meta.adminOnly : r.meta.notReady))
    && (!t || `${r.meta.label} ${r.meta.where} ${r.k}`.toLowerCase().includes(t)));
}

export const ROLE_BADGE = Object.freeze({ admin: 'purple', operator: 'blue', viewer: 'gray', super_admin: 'purple' });
export const SRC_LABEL = Object.freeze({ local: '로컬', ad: 'AD', unknown: '—' });

export const PURGE_SCOPES = Object.freeze([
  { k: 'user', label: '한 사용자' }, { k: 'before', label: '어느 날 이전' }, { k: 'all', label: '전체(모든 사용자 · 모든 날)' },
]);
export const DROP_LABEL = Object.freeze({
  'settings-unreadable': '설정 못 읽음', 'no-user': '계정 없음', excluded: '제외 계정', 'unknown-key': '모르는 화면 키', 'rate-limited': '분당 상한 초과', 'buffer-full': '모으기 칸 가득',
});
