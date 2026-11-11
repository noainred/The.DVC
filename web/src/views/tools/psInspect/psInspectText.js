/**
 * psInspectText.js — PowerScale 장비 점검 화면의 글자 · 색 · 정렬(v2.964 · 순수 — vitest).
 *  · 판정은 서버(storage/inspect/judge.js) 하나 — 여기서는 상태 code → 낱말 · 색, 숫자 → 글자만 만든다(기준값 비교 없음).
 *  · 상태 다섯은 서버 catalog.STATUS_KO 와 1:1(테스트가 대조). 확인 불가는 빗금 · 낱말로 정상과 구분한다(색만으로 구분하지 않는다).
 */
export const STATUS_KO = Object.freeze({ ok: '정상', warn: '주의', bad: '이상', unknown: '확인 불가', na: '해당 없음' });
export const STATUS_ORDER = Object.freeze(['bad', 'warn', 'unknown', 'ok', 'na']);
export const GROUP_KO = Object.freeze({ components: '구성 요소', config: '구성', capacity: '용량', performance: '성능', protection: '데이터 보호' });
export const GROUP_ORDER = Object.freeze(['components', 'config', 'capacity', 'performance', 'protection']);
export const WEEKDAYS = Object.freeze([{ v: 1, l: '월' }, { v: 2, l: '화' }, { v: 3, l: '수' }, { v: 4, l: '목' }, { v: 5, l: '금' }, { v: 6, l: '토' }, { v: 7, l: '일' }]);
export const METHOD_KO = Object.freeze({ ssh: 'SSH', api: 'REST', demo: '데모' });
export const METRICS = Object.freeze([{ key: 'ops', label: '프로토콜 ops/s' }, { key: 'net', label: '처리량 In + Out' }, { key: 'busy', label: '디스크 busy' }, { key: 'cpu', label: 'CPU' }]);
export const RANGES = Object.freeze([{ key: '24h', label: '24시간' }, { key: '7d', label: '7일' }, { key: '30d', label: '30일' }]);
export const VIEWS = Object.freeze([
  { key: 'overview', label: '법인별 현황' }, { key: 'device', label: '점검 결과' }, { key: 'report', label: '주간 보고서' },
  { key: 'top', label: 'Top 10 노드 편중' }, { key: 'sources', label: '점검 주기 · 근거' },
]);
const RANK = { bad: 0, warn: 1, unknown: 2, ok: 3, na: 4 };

export const statusText = (s) => STATUS_KO[s] || '—';
/** 숫자(천 단위) — 못 읽은 값은 '—'(단위 없이). */
export function numText(v, digits = 0) {
  const n = typeof v === 'number' ? v : (v == null || v === '' ? NaN : Number(v));
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}
export function pctText(v) { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? '—' : `${Math.round(n * 10) / 10}%`; }
/** 처리량(bps) → 글자. */
export function bpsText(v) {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return '—';
  const u = [['Gb/s', 1e9], ['Mb/s', 1e6], ['Kb/s', 1e3]].find(([, d]) => n >= d);
  return u ? `${(n / u[1]).toFixed(1)} ${u[0]}` : `${Math.round(n)} b/s`;
}
/** 지표 값 글자(Top 10 열). */
export function metricText(metric, v) {
  if (metric === 'net') return bpsText(v);
  if (metric === 'busy' || metric === 'cpu') return pctText(v);
  return numText(v);
}
/** 포탈 시각(KST — 서버 DAY_OFFSET_MIN 과 같은 540분) 'MM-DD HH:mm'. */
export function kstText(ms, { offsetMin = 540, withYear = false } = {}) {
  const n = Number(ms);
  if (ms == null || !Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n + offsetMin * 60_000);
  const p = (x) => String(x).padStart(2, '0');
  return `${withYear ? `${d.getUTCFullYear()}-` : ''}${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
/** 경과 — '3시간 전' · '2일 전'. */
export function agoText(ms, now = Date.now()) {
  const n = Number(ms);
  if (ms == null || !Number.isFinite(n)) return '—';
  const m = Math.max(0, Math.round((now - n) / 60_000));
  if (m < 60) return `${m}분 전`;
  if (m < 48 * 60) return `${Math.round(m / 60)}시간 전`;
  return `${Math.round(m / 1440)}일 전`;
}
/** 장비 정렬 — 나쁜 순 → 법인 → 이름(서버 순서와 같다 · 화면 정렬 버튼이 다시 바꿀 수 있다). */
export function sortDevices(list) {
  return [...(list || [])].sort((a, b) => (RANK[a?.summary?.overall] ?? 9) - (RANK[b?.summary?.overall] ?? 9)
    || String(a?.corpName || '').localeCompare(String(b?.corpName || '')) || String(a?.name || '').localeCompare(String(b?.name || '')));
}
/** 칸 띠 — 구분 순서대로 항목 상태를 묶는다(같은 순서가 점검 결과 표의 #). */
export function stripOf(items) {
  const by = new Map(GROUP_ORDER.map((g) => [g, []]));
  for (const i of items || []) if (by.has(i.group)) by.get(i.group).push({ id: i.id, no: i.no, status: i.status, label: i.label });
  for (const v of by.values()) v.sort((a, b) => a.no - b.no);
  return GROUP_ORDER.map((g) => ({ group: g, label: GROUP_KO[g], cells: by.get(g) }));
}
/** 이상 · 주의 목록(전 장비) — 이상 먼저 · 최대 n. */
export function issuesOf(devices, n = 30) {
  const out = [];
  for (const d of devices || []) for (const i of d.items || []) if (i.status === 'bad' || i.status === 'warn') out.push({ device: d, item: i });
  out.sort((a, b) => (RANK[a.item.status] - RANK[b.item.status]) || String(a.device.corpName).localeCompare(String(b.device.corpName)) || a.item.no - b.item.no);
  return { list: out.slice(0, n), more: Math.max(0, out.length - n), total: out.length };
}
/** 확인 불가 사유 묶음 — 같은 사유를 한 줄로(장비 · 항목 수). */
export function unknownReasons(devices) {
  const m = new Map();
  for (const d of devices || []) for (const i of d.items || []) {
    if (i.status !== 'unknown') continue;
    const why = String(i.why || '읽지 못했습니다');
    const key = why.replace(/\(.*$/, '').trim().slice(0, 80);
    const cur = m.get(key) || { why: key, items: 0, devices: new Set(), labels: new Set() };
    cur.items += 1; cur.devices.add(d.name); cur.labels.add(i.label);
    m.set(key, cur);
  }
  return [...m.values()].map((x) => ({ why: x.why, items: x.items, devices: [...x.devices], labels: [...x.labels] })).sort((a, b) => b.items - a.items);
}
/** 지난번 대비 배지 글자. */
export function diffText(diff) {
  if (!diff || !diff.base) return { text: '지난 점검 없음', tone: 'muted' };
  const w = diff.worse?.length || 0; const b = diff.better?.length || 0;
  if (w) return { text: `나빠짐 ${w}${b ? ` · 풀림 ${b}` : ''}`, tone: 'bad' };
  if (b) return { text: `풀림 ${b}`, tone: 'ok' };
  return { text: '변화 없음', tone: 'muted' };
}
/** 이메일 목록 글자 → 배열(쉼표 · 공백 · 줄바꿈). 검증은 서버가 한다(형식이 틀리면 400 사유). */
export const mailList = (s) => [...new Set(String(s || '').split(/[,\s;]+/).map((x) => x.trim()).filter(Boolean))];
/** 다음 회차 글자. */
export function scheduleText(st) {
  const s = st?.settings;
  if (!s) return '—';
  if (!s.enabled) return '주간 점검 꺼짐';
  const wd = WEEKDAYS.find((w) => w.v === s.weekday)?.l || '?';
  return `매주 ${wd}요일 ${s.time}${st.nextRunAt ? ` · 다음 ${kstText(st.nextRunAt)}` : ''}${s.mailEnabled ? ` · 메일 +${s.mailDelayMin}분` : ' · 메일 꺼짐'}`;
}
/** 클러스터 분포 점 그림 좌표(Top 10 오른쪽) — 가로 = 평균 대비 배수(0 ~ maxX), 값 없는 노드는 그리지 않는다. */
export function distLayout(clusters, { width = 360, left = 96, right = 30, rowH = 46, top = 30, maxX = 3 } = {}) {
  const x = (r) => left + Math.min(maxX, Math.max(0, Number(r) || 0)) / maxX * (width - left - right);
  const rows = (clusters || []).slice(0, 8).map((c, i) => ({ y: top + i * rowH, name: c.corpName || c.name, sub: c.maxRatio != null ? `최대 ${c.maxRatio}배` : '—', skewed: !!c.skewed,
    dots: (c.nodes || []).filter((n) => n.ratio != null).map((n) => ({ lnn: n.lnn, x: Math.round(x(n.ratio) * 10) / 10, ratio: n.ratio, hot: !!c.skewed && n.lnn === c.maxLnn })) }));
  return { rows, height: top + rows.length * rowH + 20, ticks: [0, 1, 1.5, 2, 3].map((v) => ({ v, x: Math.round(x(v) * 10) / 10 })) };
}
