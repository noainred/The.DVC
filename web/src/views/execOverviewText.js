/**
 * execOverviewText.js — '경영 보기' Overview(v2.670, 시안 design_handoff_exec_overview)의 판정·문구 — 순수 모듈(vitest).
 *
 * 원칙(시안 README + 이 저장소 규약):
 *   · 값을 못 읽으면 0 이 아니라 '—' 다(unitText 규약). 0 인 칸을 경고색으로 칠하지 않는다.
 *   · 임계는 엔지니어 보기와 같은 75% · 90%(consoleData WARN_PCT/CRIT_PCT).
 *   · 첫 수집 중·연결 실패를 '정상' 으로 말하지 않는다(v2.509 loadState 규약) — 헤드라인이 그 사실을 먼저 말한다.
 *   · 숫자(주기)를 문구에 박지 않는다 — 서버가 준 값만 쓴다.
 *   · 문구에 백틱·별표를 쓰지 않는다(BoldText 를 거치지 않는 plain 렌더다).
 */
import { normMode, resolveMode } from '../version_4/mode.js';
import { hashSegments } from '../hooks/hashTab.js';
import { WARN_PCT, CRIT_PCT } from '../console/consoleData.js';
import { corpSiteStatus } from './corpSiteStatus.js';
import { countText, kwText, capText, gpuCardValue, gpuCardMeta } from './overviewCardsText.js';

export { WARN_PCT, CRIT_PCT };

/* ── 보기 모드(경영 ↔ 엔지니어) ───────────────────────────────────────── */

/**
 * `#/overview/exec` · `#/overview/eng` — 이 앱의 해시는 첫 세그먼트가 탭이라 시안의 `?view=` 를 그대로 쓸 수 없다
 * (`#/overview?view=exec` 는 탭 'overview?view=exec' 로 읽혀 허용되지 않는다). 둘째 세그먼트로 받는다.
 * 해시의 값은 그 탭에만 적용하고 저장하지 않는다(V4 mode.js 규약 — 받은 링크가 내 설정을 바꾸면 안 된다).
 */
export function modeFromHash(hash) {
  const s = hashSegments(hash);
  return s[0] === 'overview' ? normMode(s[1]) : null;
}
export function overviewMode({ hash, stored, role } = {}) {
  return resolveMode({ query: modeFromHash(hash), stored, role });
}

/* ── 기간 ───────────────────────────────────────────────────────────── */

export const TREND_DAYS = [7, 30, 90];
export const DAYS_KEY = 'vmportal.execOverview.days';
export const normDays = (v) => (TREND_DAYS.includes(Number(v)) ? Number(v) : 7);

/* ── 머리 ────────────────────────────────────────────────────────── */

const nf = new Intl.NumberFormat('ko-KR');
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** eyebrow 시각 — 'YYYY.MM.DD HH:mm KST'(포탈 기준 +09:00). 모르면 ''. */
export function briefingStamp(generatedAt, offsetMin = 540) {
  const t = typeof generatedAt === 'number' ? generatedAt : Date.parse(String(generatedAt || ''));
  if (!Number.isFinite(t)) return '';
  const d = new Date(t + offsetMin * 60_000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} KST`;
}

/* ── 사용률·색 ───────────────────────────────────────────────────────── */

/** 사용률 색(엔지니어 보기와 같은 75/90). 값이 없으면 회색. */
export function usageTone(pct) {
  const v = n(pct);
  if (v == null) return 'none';
  return v >= CRIT_PCT ? 'bad' : v >= WARN_PCT ? 'warn' : 'ok';
}
export const TONE_VAR = { ok: 'var(--green)', warn: 'var(--amber)', bad: 'var(--red)', none: 'var(--border-soft)', info: '#60a5fa' };

/** 링 게이지 3개 — 분모가 0 이면 '—'(서버 pct 가 0 을 줘도 '비어 있다' 로 그리지 않는다 — Overview.jsx v2.593 규칙). */
export function gauges(g) {
  if (!g) return [];
  const cpu = n(g.hosts) > 0 && Number(g.cpuTotalGhz) > 0 ? n(g.cpuUsagePct) : null;
  const mem = n(g.hosts) > 0 && Number(g.memTotalGB) > 0 ? n(g.memUsagePct) : null;
  const sto = n(g.datastores) > 0 && Number(g.storageTotalTB) > 0 ? n(g.storageUsagePct) : null;
  const tb = (x) => (x == null ? '—' : x >= 1000 ? `${(x / 1000).toFixed(2)} PB` : `${nf.format(Math.round(x))} TB`);
  return [
    { key: 'cpu', label: 'CPU', pct: cpu, basis: n(g.cpuCores) ? `물리 ${nf.format(g.cpuCores)} 코어 기준` : `${countText(Math.round(Number(g.cpuTotalGhz) || 0))} GHz 기준` },
    { key: 'mem', label: 'MEMORY', pct: mem, basis: `물리 ${tb(n(g.memTotalGB) == null ? null : g.memTotalGB / 1024)} 기준` },
    { key: 'sto', label: 'STORAGE', pct: sto, basis: `데이터스토어 ${tb(n(g.storageTotalTB))} 기준` },
  ];
}

/* ── 리전(차트 묶음 — region-chart-change.md) ──────────────────────────── */

/**
 * 차트 표시용 묶음 — 유럽 / 북미 / 아시아(중국 포함) / 대한민국.
 * ⚠ 데이터 리전 값(아시아·중국·유럽·북미)은 사용자 범위·필터·자연어 검색이 쓰므로 바꾸지 않는다 — 여기서만 다시 묶는다.
 * 대한민국 판정의 근거는 vCenter 위치의 나라 이름뿐이다.
 */
export const REGION_ORDER = ['유럽', '북미', '아시아(중국 포함)', '대한민국'];
export const REGION_COLOR = { '유럽': 'var(--purple)', '북미': 'var(--accent)', '아시아(중국 포함)': 'var(--accent-2)', '대한민국': 'var(--mint)', Unknown: '#64748b' };
export const isKorea = (s) => /korea|대한민국|한국/i.test(String(s?.location?.country || ''));
export function chartGroup(s) {
  if (isKorea(s)) return '대한민국';
  const r = s?.location?.region || s?.region || '';
  if (r === '아시아' || r === '중국') return '아시아(중국 포함)';
  return r || 'Unknown';
}

/** 사이트 → 리전 카드. 첫 수집 중·연결 실패처럼 세지 못하는 사이트는 VM·호스트에 더하지 않고 개수로 밝힌다. */
export function regionCards(sites) {
  const acc = new Map();
  for (const s of Array.isArray(sites) ? sites : []) {
    if (!s || s.status === 'disabled') continue;
    const k = chartGroup(s);
    const a = acc.get(k) || { key: k, vms: 0, hosts: 0, corps: 0, uncounted: 0 };
    a.corps += 1;
    const st = corpSiteStatus(s);
    if (st.countable) { a.vms += Number(s.metrics?.vms) || 0; a.hosts += Number(s.metrics?.hosts) || 0; } else a.uncounted += 1;
    acc.set(k, a);
  }
  const keys = [...REGION_ORDER.filter((k) => acc.has(k)), ...[...acc.keys()].filter((k) => !REGION_ORDER.includes(k))];
  const total = keys.reduce((t, k) => t + acc.get(k).vms, 0);
  return keys.map((k) => {
    const a = acc.get(k);
    const pct = total > 0 ? Math.round((a.vms / total) * 1000) / 10 : null;
    const corpText = k === '아시아(중국 포함)' ? `${a.corps}개 법인(중국 포함)` : `${a.corps}개 법인`;
    return { ...a, pct, color: REGION_COLOR[k] || REGION_COLOR.Unknown,
      desc: `${corpText} · 호스트 ${nf.format(a.hosts)}대${a.uncounted ? ` · 미수집 ${a.uncounted}곳 제외` : ''}` };
  });
}

/* ── 법인별 현황 ──────────────────────────────────────────────────────── */

/** 법인 행. 세지 못하는 사이트는 수치를 null 로 둔다('—' · 막대 없음). */
export function siteRowsExec(sites) {
  const rows = (Array.isArray(sites) ? sites : []).filter((s) => s).map((s) => {
    const st = corpSiteStatus(s);
    const m = s.metrics || {};
    const ok = st.countable;
    const cpu = ok ? n(m.cpuUsagePct) : null; const mem = ok ? n(m.memUsagePct) : null; const sto = ok ? n(m.storageUsagePct) : null;
    const vals = [cpu, mem, sto].filter((v) => v != null);
    const worst = vals.length ? Math.max(...vals) : null;
    // v2.732(점검 2회차 B2-01 후속, 그룹 i3): 낡은 값(위임 엣지 push 정지 · 연결 실패 이월 — corpSiteStatus.stale)은 정상 초록으로 칠하지 않는다.
    //   지금 값이 아니므로 최소 '주의'(호박색)이고, 마지막 값이 이미 위험이면 위험 그대로다(판정은 corpSiteStatus 하나 — 복제 금지).
    const tone = usageTone(worst);
    const dot = s.status === 'maintenance' ? 'info' : !ok ? 'none' : st.stale ? (tone === 'bad' ? 'bad' : 'warn') : tone === 'none' ? 'ok' : tone;
    return {
      id: s.id, city: s.location?.city || s.name || s.id, name: s.name || s.id,
      sub: [s.location?.country, s.id, s.status === 'maintenance' ? '점검 중' : ''].filter(Boolean).join(' · '),
      mark: st.mark, markTitle: st.title, countable: ok, stale: st.stale === true,
      vms: ok ? (Number(m.vms) || 0) : null, cpu, mem, sto, worst, dot,
    };
  });
  const maxVms = Math.max(0, ...rows.map((r) => r.vms || 0));
  for (const r of rows) r.vmPct = r.vms != null && maxVms > 0 ? Math.round((r.vms / maxVms) * 100) : null;
  return rows;
}

/** 정렬 — 'vms'(가상 서버 많은 순) · 'risk'(가장 높은 사용률 순). 모르는 값은 뒤로. 동점은 이름. */
export function sortSiteRows(rows, by = 'vms') {
  const key = by === 'risk' ? (r) => r.worst : (r) => r.vms;
  return [...(rows || [])].sort((a, b) => {
    const x = key(a); const y = key(b);
    if (x == null && y == null) return String(a.city).localeCompare(String(b.city), 'ko');
    if (x == null) return 1; if (y == null) return -1;
    return y - x || String(a.city).localeCompare(String(b.city), 'ko');
  });
}

/* ── 핵심 지표 추이 ───────────────────────────────────────────────────── */

/**
 * 스파크라인 경로 — 점이 없는 칸(null)은 선을 끊고(subpath), 점이 하나뿐인 조각은 선이 아니라 점으로 둔다
 * (한 점을 선으로 만들면 추세가 있는 것처럼 보인다 — bmUsageChart 규약). y 축은 유효 값의 최소~최대(값이 같으면 가운데).
 * 반환 `{ line, area, dots:[{x,y}], valid }`.
 */
export function sparkPaths(series, { w = 240, h = 48, pad = 4 } = {}) {
  const pts = Array.isArray(series) ? series : [];
  const vals = pts.map((p) => (p && p.v != null && Number.isFinite(Number(p.v)) ? Number(p.v) : null));
  const valid = vals.filter((v) => v != null);
  if (!valid.length) return { line: '', area: '', dots: [], valid: 0 };
  // 변화가 값의 5% 미만이면 그만큼 축을 넓힌다 — 4.60 → 4.61 kW 같은 잔물결을 급경사로 과장하지 않는다(bmUsageChart 0~100 고정과 같은 판단).
  let min = Math.min(...valid); let max = Math.max(...valid);
  const floorSpan = Math.max(Math.abs(max), Math.abs(min)) * 0.05;
  if (max - min < floorSpan) { const mid = (max + min) / 2; min = mid - floorSpan / 2; max = mid + floorSpan / 2; }
  const span = max - min;
  const x = (i) => (pts.length <= 1 ? w / 2 : pad + (i * (w - pad * 2)) / (pts.length - 1));
  const y = (v) => (span === 0 ? h / 2 : h - pad - ((v - min) / span) * (h - pad * 2));
  const segs = []; let cur = [];
  vals.forEach((v, i) => { if (v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([x(i), y(v)]); });
  if (cur.length) segs.push(cur);
  const f = (v) => Math.round(v * 10) / 10;
  let line = ''; let area = ''; const dots = [];
  for (const s of segs) {
    if (s.length === 1) { dots.push({ x: f(s[0][0]), y: f(s[0][1]) }); continue; }
    line += `M${s.map(([a, b]) => `${f(a)},${f(b)}`).join('L')}`;
    area += `M${f(s[0][0])},${h}L${s.map(([a, b]) => `${f(a)},${f(b)}`).join('L')}L${f(s[s.length - 1][0])},${h}Z`;
  }
  return { line, area, dots, valid: valid.length };
}

const sign = (v) => (v > 0 ? '+' : v < 0 ? '−' : '±');

/**
 * 증감 문구 — `+12 · 7일` · `+3.2 kW · 7일` · `+0.4 TB · 7일`. 증감을 모르면(유효 점 2개 미만) null.
 * 기간 표기는 조회 창이 아니라 **실제로 비교한 두 점 사이**다 — 창보다 짧으면 그 길이를 적는다(관측 10일로 30일 증감을 말하지 않는다).
 */
export function deltaText(kind, delta, days) {
  if (!delta || !Number.isFinite(Number(delta.diff))) return null;
  const spanDays = Number.isFinite(delta.lastTs - delta.firstTs) ? (delta.lastTs - delta.firstTs) / 86_400_000 : null;
  const label = spanDays != null && spanDays < days * 0.8 ? `${spanDays < 1 ? `${Math.max(1, Math.round(spanDays * 24))}시간` : `${Math.round(spanDays)}일`}` : `${days}일`;
  const d = Number(delta.diff);
  // 표시 단위로 반올림해 0 이면 부호 없이 '±0' — '−0.0 kW' 는 감소한 것처럼 읽힌다.
  let v;
  if (kind === 'power') v = Math.abs(d) < 50 ? '±0 kW' : `${sign(d)}${kwText(Math.abs(d))}`;
  else if (kind === 'storage') v = Math.abs(d) < 5e10 ? '±0 TB' : `${sign(d)}${capText(Math.abs(d))}`;
  else v = Math.round(Math.abs(d)) === 0 ? '±0' : `${sign(d)}${nf.format(Math.abs(Math.round(d)))}`;
  return `${v} · ${label}`;
}

/** 지표별 추이 설명(스파크라인이 없을 때 · 부분 구간이 있을 때). */
export function trendNote(kind, t) {
  if (!t) return '';
  if (t.reason === 'no-series') return '수량 추이는 기록하지 않습니다';
  if (t.reason) return '전체 범위 계정만 추이를 봅니다';
  if (t.error) return `추이를 읽지 못했습니다: ${t.error}`;
  const valid = (t.series || []).filter((p) => p && p.v != null).length;
  if (!valid) return '이 기간에 쌓인 추이가 없습니다';
  const bits = [];
  if (t.partial) bits.push(`일부만 집계된 ${t.partial}칸은 그리지 않았습니다`);
  if (kind === 'power') bits.push('추이는 서버(iDRAC) 전력만');
  if (kind === 'storage') bits.push('추이는 스토리지 사용량');
  return bits.join(' · ');
}

/* ── 주의가 필요한 항목 ───────────────────────────────────────────────── */

const vcName = (sites, id) => {
  const s = (sites || []).find((x) => x && x.id === id);
  return s?.location?.city || s?.name || id;
};

/**
 * 주의 항목 — 원천: 용량(사이트 사용률 + 용량 예측) · 장애(Critical 알람) · 라이선스(90일 이내) · 점검.
 * 권한이 없어 부르지 않은 원천은 `skipped` 로 밝힌다(조용히 빼지 않는다). 최대 `max` 건, 넘친 개수는 `omitted`.
 * @param {{sites, g, alarms, forecast, licenses, can:{alarms:boolean, forecast:boolean, licenses:boolean}, errors?:object}} x
 */
export function attentionItems({ sites = [], g = null, alarms = null, forecast = null, licenses = null, can = {}, errors = {} } = {}, max = 5) {
  const out = [];
  // 1) 용량 — 사이트 스토리지 사용률 75% 이상(높은 순). 예측이 있으면 그 사이트의 가장 이른 소진일을 붙인다.
  const soonest = new Map();
  for (const d of forecast?.items || []) {
    if (d?.daysToFull == null) continue;
    const cur = soonest.get(d.vcenterId);
    if (cur == null || d.daysToFull < cur) soonest.set(d.vcenterId, d.daysToFull);
  }
  const cap = (sites || []).filter((s) => s && corpSiteStatus(s).countable && n(s.metrics?.storageUsagePct) != null && s.metrics.storageUsagePct >= WARN_PCT)
    .sort((a, b) => b.metrics.storageUsagePct - a.metrics.storageUsagePct);
  for (const s of cap) {
    const pct = s.metrics.storageUsagePct;
    const days = soonest.get(s.id);
    out.push({ tag: '용량', tone: pct >= CRIT_PCT ? 'red' : 'amber', vc: s.id,
      title: `${vcName(sites, s.id)} 스토리지 사용률 ${pct}%`,
      desc: days != null ? `가장 빠른 데이터스토어가 현재 증가 추세면 약 ${nf.format(days)}일 후 가득 찹니다(선형 추정).` : '데이터스토어 사용률이 주의 기준(75%)을 넘었습니다.' });
  }
  // 2) 장애 — Critical 알람(vCenter 별).
  if (can.alarms) {
    const crit = (alarms?.items || []).filter((a) => a && a.severity === 'critical');
    const byVc = new Map();
    for (const a of crit) { const l = byVc.get(a.vcenterId) || []; l.push(a); byVc.set(a.vcenterId, l); }
    for (const [vc, list] of [...byVc.entries()].sort((a, b) => b[1].length - a[1].length)) {
      out.push({ tag: '장애', tone: 'red', vc, title: `${vcName(sites, vc)} Critical 알람 ${nf.format(list.length)}건`,
        desc: [...new Set(list.map((a) => a.entity).filter(Boolean))].slice(0, 2).join(' · ') || list[0]?.message || '' });
    }
  }
  // 3) 라이선스 — 90일 이내 만료(만료 포함).
  if (can.licenses) {
    const soon = (licenses?.items || []).filter((l) => l && n(l.daysLeft) != null && l.daysLeft <= 90);
    if (soon.length) {
      const min = Math.min(...soon.map((l) => l.daysLeft));
      const first = soon.find((l) => l.daysLeft === min);
      out.push({ tag: '라이선스', tone: min < 0 ? 'red' : 'amber', vc: first?.vcenterId || '',
        title: min < 0 ? `${first?.family || '라이선스'} 만료됨(${nf.format(-min)}일 지남)` : `${first?.family || '라이선스'} 라이선스 만료 D-${min}`,
        desc: `만료 90일 이내(만료 포함) 키 ${nf.format(soon.length)}개` });
    }
  }
  // 4) 점검 — 점검중 vCenter.
  for (const s of (sites || []).filter((x) => x && x.status === 'maintenance')) {
    out.push({ tag: '점검', tone: 'blue', vc: s.id, title: `${vcName(sites, s.id)} 법인 계획 점검 중`, desc: '점검 기간 동안 이 법인의 수치는 마지막 수집 값이고 장애로 집계하지 않습니다.' });
  }
  const skipped = [];
  if (!can.alarms) skipped.push('알람(권한 없음)');
  if (!can.licenses) skipped.push('라이선스(권한 없음)');
  if (!can.forecast) skipped.push('용량 예측(권한 없음)');
  // 403 은 장애가 아니라 접근 제어다 — '읽기 실패' 라 하면 사용자가 장애로 오해한다(v2.398 규약).
  for (const [k, e] of Object.entries(errors || {})) if (e) skipped.push(`${k}(${e === 'forbidden' ? '권한 없음' : '읽기 실패'})`);
  return { items: out.slice(0, max), total: out.length, omitted: Math.max(0, out.length - max), skipped };
}

/** 인벤토리 스트립 — 값·링크. 모르는 값은 '—'. */
export function inventoryCells(cards, g) {
  const c = cards || {};
  return [
    { key: 'dc', label: '데이터센터', value: countText(c.datacenters?.count) },
    { key: 'farm', label: '서버 Farm', value: countText(c.farms?.count), title: c.farms?.reason || undefined },
    { key: 'gpu', label: 'GPU(장)', value: countText(gpuKpi(c).value), hash: '#/tools/serveranalysis/gpu' },
    { key: 'net', label: '네트워크 장비(대)', value: countText(c.network?.count), hash: c.network?.reason ? undefined : '#/tools/cvp', title: c.network?.reason || undefined },
    { key: 'hosts', label: '호스트(대)', value: countText(g?.hosts), tab: 'hosts' },
    { key: 'alarms', label: '활성 알람(건)', value: countText(g?.alarms), tab: 'alarms' },
  ];
}

/**
 * v2.678 — 'GPU 카드' KPI(사용자 요청 "iDRAC 에서 수집한 데이터로 보여줘").
 * 출처는 /overview/cards 의 gpus(서버 분석 iDRAC 인벤토리 — 모델·이름이 있는 GPU 항목 수)다.
 * 인벤토리를 한 대도 못 읽었으면 0 이 아니라 '—'(모름), 일부만 읽었으면 '최소' 값임을 밝힌다
 * (읽지 못한 서버의 GPU 는 세지 않았다 — 부분 합을 전체라 말하지 않는다).
 */
export function gpuKpi(cards) {
  const g = cards?.gpus;
  if (!g) return { value: null, sub: '', partial: false };
  // v2.682 R3D-02: 판정은 overviewCardsText.gpuCardValue 하나(엔지니어 보기 카드와 같은 함수).
  const { value, unknown, partial } = gpuCardValue(g);
  // v2.683: 부제도 엔지니어 보기 카드와 같은 함수(서버 분석 › GPU 찾기와 같은 기준).
  const sub = gpuCardMeta(g);
  return { value, sub, partial };
}
