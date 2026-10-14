/**
 * xferSpeedText.js — 특수 기능 '법인 간 전송 속도'(v2.735)의 문구·계산(순수 — React 없음, vitest 로 고정).
 *
 * 판정은 서버(`server/src/xferspeed/analyze.js`)가 하고 이 모듈은 **문장과 그림 좌표만** 만든다:
 *  · 상태(`STATE_TEXT`)·사유(`REASON_TEXT`)·실패 종류(`FAIL_TEXT`)는 서버 코드와 1:1 이다 — 서버 테스트(xferSpeed2735 ⑧)가 대조한다.
 *  · 값이 없으면 '—' 다(단위를 붙이지 않는다 — '— Mbps' 는 0 처럼 읽힌다).
 *  · 숫자(주기·크기·경계)는 서버 응답에서 받는다. 문장에 박지 않는다.
 *  · 시각은 서버가 준 포탈 오프셋(`offsetMin`, 기본 한국 시각)으로 쓴다 — 브라우저 시간대에 기대지 않는다.
 *  · 화면 문구에 백틱을 쓰지 않는다(BoldText 는 `**강조**` 만 해석한다).
 */
import { numOrNull } from '../../numOrNull.js';
import { agoText } from './relTime.js';

export const DIR_TEXT = Object.freeze({ down: '↓ 엣지 → 메인', up: '↑ 메인 → 엣지' });
export const DIR_SHORT = Object.freeze({ down: '↓', up: '↑' });
export const DIR_COLOR = Object.freeze({ down: '#22d3ee', up: '#f59e0b' });
export const DIR_TEXT_COLOR = Object.freeze({ down: '#67e8f9', up: '#fbbf24' });

/** 상태 — 서버 analyze.STATES 와 1:1. 측정 없음·오래됨은 회색이다(정상으로 칠하지 않는다). */
export const STATE_TEXT = Object.freeze({
  ok: { label: '정상', color: '#34e0b4' },
  slow: { label: '평소보다 느림', color: '#f59e0b' },
  fail: { label: '실패', color: '#ef4444' },
  stale: { label: '오래된 측정', color: '#8b9bb4' },
  'no-data': { label: '측정 없음', color: '#5d6b85' },
  excluded: { label: '측정 제외', color: '#5d6b85' },
});

/** 사유 — 서버 analyze.edgeRows 의 reason(실패 종류 제외)과 1:1. */
export const REASON_TEXT = Object.freeze({
  excluded: '설정에서 이 법인을 측정 대상에서 뺐습니다.',
  unregistered: '수집 서버 등록부에 없습니다 — 기록만 남아 있습니다(삭제되었거나 이름이 바뀌었습니다).',
  'disabled-central': '수집 서버 등록에서 이 엣지를 꺼 두었습니다.',
  'no-url': '수집 서버 등록에 URL 이 없습니다 — 메인이 이 엣지에 닿을 주소를 모릅니다.',
  never: '아직 한 번도 재지 않았습니다 — 주기 측정이 꺼져 있거나 첫 주기 전입니다.',
  old: '마지막 측정이 오래됐습니다 — 측정이 멈췄거나 이 법인을 건너뛰고 있습니다.',
  'below-baseline': '평소(최근 7일 중앙값)보다 느립니다.',
  'no-baseline': '평소 속도를 정할 측정이 아직 모자랍니다 — 느려짐은 판정하지 않았습니다.',
  'partial-baseline': '한쪽 방향은 평소 속도를 정할 측정이 모자라 그 방향은 느려짐을 판정하지 않았습니다.',
});

/** 실패 종류 — 서버 probe.XFER_FAIL_KINDS 와 1:1(조치가 다르므로 한 문구로 덮지 않는다). */
export const FAIL_TEXT = Object.freeze({
  'no-url': { label: 'URL 없음', fix: '설정 › 수집 서버에서 이 엣지의 URL 을 넣으세요.' },
  timeout: { label: '시한 초과', fix: '회선이 시한 안에 다 보내지 못했습니다. 회선 상태를 보거나 설정에서 시한을 늘리세요.' },
  unreachable: { label: '연결 실패', fix: '메인에서 이 엣지의 포탈 포트에 닿지 않습니다. 엣지 서비스·방화벽·경로를 확인하세요.' },
  auth: { label: '토큰 거부', fix: '중앙 등록값과 그 엣지의 COLLECTOR_TOKEN 이 다릅니다. 포탈 점검 › 토큰 점검으로 대조하세요.' },
  'collector-off': { label: '엣지 수집 경로 꺼짐', fix: '그 엣지의 portal.env 에 COLLECTOR_TOKEN 이 없어 수집 경로(/api/collector) 전체가 꺼져 있습니다. 토큰을 넣고 중앙 수집 서버 등록값과 맞추세요.' },
  disabled: { label: '엣지에서 꺼짐', fix: '그 엣지의 portal.env 에서 XFER_TEST_ENABLED=false 로 측정을 껐습니다. 의도한 것이면 설정에서 이 법인을 빼세요.' },
  'old-version': { label: '엣지 구버전', fix: '그 엣지에 측정 경로가 없습니다. 엣지를 업그레이드해야 잴 수 있습니다(다시 눌러도 같습니다).' },
  busy: { label: '엣지 바쁨', fix: '엣지가 다른 측정을 처리 중이었습니다. 다음 주기에 다시 잽니다.' },
  http: { label: 'HTTP 오류', fix: '엣지가 오류로 응답했습니다. 엣지 로그를 확인하세요.' },
  short: { label: '전송 중 끊김', fix: '보내는 도중 연결이 끊겼습니다. 같은 일이 반복되면 회선 품질(손실·재연결)을 확인하세요.' },
  'bad-body': { label: '응답 형식 오류', fix: '엣지가 아닌 서버(프록시·다른 서비스)에 닿았을 수 있습니다. 수집 서버 URL 을 확인하세요.' },
});

export const BASIS_TEXT = Object.freeze({
  receiver: '받는 쪽에서 잰 시간',
  'sender-total': '보낸 쪽 전체 시간(엣지 앞 프록시가 본문을 모았다가 넘긴 것으로 보여 이것으로 계산했습니다)',
});

/** 속도 표기 — 100 이상은 정수, 그 아래는 소수 한 자리. 값이 없으면 '—'(단위 없음). */
export function mbpsText(v, { unit = true } = {}) {
  const n = numOrNull(v);
  if (n == null) return '—';
  const s = n >= 100 ? String(Math.round(n)) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
  return unit ? `${s} Mbps` : s;
}

/** 로그 눈금 막대 폭(%) — 1·10·100·1000 Mbps 가 같은 간격. 값이 없으면 0, 있으면 최소 1.5%. */
export function logWidth(v, max = 1000) {
  const n = numOrNull(v);
  if (n == null || n <= 0) return 0;
  const top = Math.log10(Math.max(10, max));
  return Math.max(1.5, Math.min(100, (Math.log10(Math.max(1, n)) / top) * 100));
}

/** ms → '120초'·'9분'·'1.5시간'(기간 — '전' 을 붙이지 않는다). */
export function spanText(ms) {
  const n = numOrNull(ms);
  if (n == null || n < 0) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${Math.round(n / 100) / 10}초`;
  if (n < 3_600_000) return `${Math.round(n / 60_000)}분`;
  if (n < 86_400_000) return `${Math.round(n / 360_000) / 10}시간`;
  return `${Math.round(n / 8_640_000) / 10}일`;
}

/** 바이트 → 'MB'·'GB'(이진). */
export function bytesText(b) {
  const n = numOrNull(b);
  if (n == null) return '—';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

/** 포탈 시각(서버 오프셋) 'MM-DD HH:mm'. */
export function clockText(ts, offsetMin = 540, { date = true } = {}) {
  const t = numOrNull(ts);
  if (t == null || t <= 0) return '—';
  const d = new Date(t + offsetMin * 60_000);
  const p = (x) => String(x).padStart(2, '0');
  const hm = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  return date ? `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${hm}` : hm;
}

/** 평소 대비 배지 — 서버 vsPct 그대로. 판정 기준(slowPct)은 설정값. */
export function vsBadge(row, slowPct = 70) {
  if (!row) return { text: '—', tone: 'muted' };
  if (row.state === 'fail') return { text: '실패', tone: 'red' };
  if (row.state === 'no-data' || row.state === 'excluded') return { text: '—', tone: 'muted' };
  const v = numOrNull(row.vsPct);
  if (v == null) return { text: '기준 없음', tone: 'muted', title: REASON_TEXT['no-baseline'] };
  const partial = row.reason === 'partial-baseline' ? ` ${REASON_TEXT['partial-baseline']}` : '';
  return { text: `${v}%`, tone: v < slowPct ? 'amber' : 'green', title: `두 방향 중 낮은 쪽이 평소(7일 중앙값)의 ${v}% 입니다.${partial}` };
}

/** 한 행의 설명 한 줄(측정이 없거나 실패·느림일 때 막대 대신·아래에 보인다). */
export function rowReasonText(row, minEdgeVersion = '') {
  if (!row) return '';
  if (row.edgeOld && (row.state === 'no-data' || row.state === 'fail' || row.state === 'stale')) {
    return `엣지 버전 ${row.edgeVersion} — 이 측정은 ${minEdgeVersion || '새 버전'} 이상에서 됩니다. 엣지를 업그레이드하세요.`;
  }
  const fk = FAIL_TEXT[row.reason];
  if (row.state === 'fail' && fk) return `${fk.label} — ${fk.fix}`;
  return REASON_TEXT[row.reason] || '';
}

const STATE_ORDER = Object.freeze({ fail: 0, slow: 1, stale: 2, ok: 3, 'no-data': 4, excluded: 5 });
const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
const minMbps = (r) => {
  const v = [r?.down?.latest, r?.up?.latest].filter((l) => l?.ok).map((l) => numOrNull(l.mbps)).filter((x) => x != null);
  return v.length ? Math.min(...v) : null;
};

/** 표 정렬 — slow: 문제 먼저(실패·느림·오래됨) 그다음 느린 순 · name: 이름 순 · vs: 평소 대비 낮은 순. 값 없는 행은 언제나 뒤. */
export function sortRows(rows = [], mode = 'slow') {
  const list = [...rows];
  if (mode === 'name') return list.sort((a, b) => collator.compare(a.name || a.id, b.name || b.id));
  if (mode === 'vs') {
    return list.sort((a, b) => {
      const x = numOrNull(a.vsPct); const y = numOrNull(b.vsPct);
      if (x == null && y == null) return collator.compare(a.name || a.id, b.name || b.id);
      if (x == null) return 1;
      if (y == null) return -1;
      return x - y;
    });
  }
  return list.sort((a, b) => {
    const s = (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9);
    if (s) return s;
    const x = minMbps(a); const y = minMbps(b);
    if (x == null && y == null) return collator.compare(a.name || a.id, b.name || b.id);
    if (x == null) return 1;
    if (y == null) return -1;
    return x - y;
  });
}

/**
 * 스파크라인 경로 — 점([ts, mbps|null])을 시간 축에 놓고, 실패(null)·간격이 `gapMs` 를 넘는 곳은 선을 끊는다.
 * 점이 1개뿐이면 선을 만들지 않는다(추세가 있는 것처럼 보인다). 세로 축은 그 행의 두 방향 최대에 맞춘다.
 */
export function sparkPath(points = [], { w = 150, h = 34, from, to, max, gapMs = null, pad = 2 } = {}) {
  const pts = (points || []).filter((p) => Array.isArray(p) && numOrNull(p[0]) != null);
  if (!pts.length || from == null || to == null || to <= from) return '';
  // 끊는 간격 = 데이터의 측정 주기 × 2.5(하한 90분) — 30분 주기를 박아 두면 2시간 주기에서 선이 사라졌다(v2.735.3).
  if (gapMs == null) gapMs = Math.max(90 * 60_000, (cadenceOf(pts.map((p) => ({ ts: numOrNull(p[0]) }))) ?? 0) * 2.5);
  const top = numOrNull(max) && max > 0 ? max * 1.1 : Math.max(1, ...pts.map((p) => numOrNull(p[1]) || 0)) * 1.1;
  let d = ''; let prevTs = null; let run = 0; let open = false;
  const segs = [];
  for (const [ts, v] of pts) {
    const val = numOrNull(v);
    if (val == null || (prevTs != null && ts - prevTs > gapMs)) { if (open) segs.push(run); open = false; run = 0; }
    if (val != null) {
      const x = ((ts - from) / (to - from)) * w;
      const y = h - pad - (val / top) * (h - pad * 2);
      d += `${open ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `;
      open = true; run += 1;
    }
    prevTs = ts;
  }
  if (open) segs.push(run);
  if (!segs.some((n) => n >= 2)) return '';   // 이어진 점이 둘 이상인 구간이 없으면 선이 아니다
  return d.trim();
}

/** 시간대 히트맵 칸 색(평소 대비 비율). null 은 '측정 없음' — 점선 칸. */
export const HEAT_RAMP = Object.freeze(['#7c2d12', '#b45309', '#1e3a5f', '#0e7490', '#22d3ee']);
export function heatColor(ratio) {
  const r = numOrNull(ratio);
  if (r == null) return null;
  if (r < 0.6) return HEAT_RAMP[0];
  if (r < 0.85) return HEAT_RAMP[1];
  if (r < 0.97) return HEAT_RAMP[2];
  if (r < 1.1) return HEAT_RAMP[3];
  return HEAT_RAMP[4];
}
export function heatTitle(name, hour, cell) {
  const h = `${String(hour).padStart(2, '0')}시`;
  if (!cell) return `${name} ${h} — 측정 없음`;
  const pct = numOrNull(cell.ratio) == null ? '' : ` · 평소의 ${Math.round(cell.ratio * 100)}%`;
  return `${name} ${h} — 평균 ${mbpsText(cell.avg)}${pct} (측정 ${cell.n}회)`;
}

/** 횟수 표기 — 정수면 그대로, 아니면 소수 한 자리(매주·매월 예약은 하루 평균이 소수다). */
export function countText(n) {
  const v = numOrNull(n);
  if (v == null) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** 회선 사용 산수 — 서버 trafficOf 결과를 문장으로. 대상 0 이면 그 사실만. 예약이 있으면 하루 평균이고 최대치다. */
export function trafficLines(tr) {
  if (!tr) return [];
  const t = numOrNull(tr.targets) ?? 0;
  if (!t) return ['측정할 엣지가 없습니다(등록된 수집 서버가 없거나 전부 빠졌습니다).'];
  const sched = numOrNull(tr.scheduleRunsPerDay) ?? 0;
  const runs = sched > 0
    ? `하루 최대 약 ${countText(tr.cyclesPerDay)}회(간격 ${countText(tr.intervalRunsPerDay)} + 예약 ${countText(sched)})`
    : `하루 ${countText(tr.cyclesPerDay)}회`;
  const lines = [
    `한 번 = ${t}곳 × ${tr.sizeMB}MB × 2방향 = ${bytesText(tr.bytesPerCycle)} · ${runs} ≈ ${bytesText(tr.bytesPerDayCentral)}(메인 기준)`,
    `엣지 한 곳은 하루 약 ${bytesText(tr.bytesPerDayEdge)} 를 주고받습니다. 회선이 좁은 법인은 설정에서 뺄 수 있습니다.`,
  ];
  if (numOrNull(tr.onceSchedules)) lines.push(`1회 예약 ${tr.onceSchedules}개는 하루 평균에 넣지 않았습니다(실행할 때마다 한 번 = ${bytesText(tr.bytesPerCycle)}).`);
  return lines;
}

/** 머리 상태 문구 — 측정 중이면 진행, 아니면 마지막 주기와 다음 주기 예상. */
export function statusLine(status, now = Date.now()) {
  if (!status) return { tone: 'muted', text: '상태를 읽지 못했습니다' };
  if (status.role === 'edge') return { tone: 'muted', text: '이 포탈은 엣지입니다 — 측정은 메인이 합니다' };
  const p = status.progress;
  if (status.running && p) {
    const cur = (p.current || []).join(', ');
    return { tone: 'live', text: `측정 중 ${p.done} / ${p.total}${cur ? ` · 지금 ${cur}` : ''}` };
  }
  const last = status.last;
  const lastTxt = last?.at ? `마지막 측정 ${agoText(last.at, now)}` : '아직 측정한 적 없음';
  if (!status.enabled) return { tone: 'muted', text: `자동 측정 꺼짐 · ${lastTxt}` };
  if ('next' in status) {
    const nx = status.next;
    if (!nx) return { tone: 'muted', text: `${lastTxt} · 다음 실행 예정 없음(간격 실행 꺼짐 · 사용 중인 예약 없음)` };
    const left = nx.at - now;
    const when = left > 60_000 ? `약 ${spanText(left)} 후` : '곧';
    if (nx.kind === 'schedule') return { tone: 'ok', text: `${lastTxt} · 다음 실행 ${clockText(nx.at, status.offsetMin ?? 540)} 예약(${when})` };
    return { tone: 'ok', text: `${lastTxt} · 다음 간격 실행 ${when}` };
  }
  const iv = numOrNull(status.intervalMs);
  if (last?.at && iv) {
    const next = last.at + iv - now;
    return { tone: 'ok', text: `${lastTxt} · 다음 주기 ${next > 60_000 ? `약 ${spanText(next)} 후` : '곧'}` };
  }
  return { tone: 'ok', text: `${lastTxt} · 첫 주기 대기` };
}

/** 마지막 주기 요약(건너뛴·재지 못한 엣지를 숨기지 않는다). */
export function lastRunNote(last) {
  if (!last?.at) return '';
  if (last.error) return `마지막 주기가 실패했습니다: ${last.error}`;
  const parts = [`${last.targets}곳 중 ${last.measured}곳 측정${last.failed ? ` · 실패 포함 ${last.failed}곳` : ''} · 걸린 시간 ${spanText(last.ms)}`];
  if (last.notTried) parts.push(`주기 예산을 넘겨 ${last.notTried}곳은 재지 못했습니다(다음 주기에 먼저 잽니다)`);
  if (last.skipped) parts.push(`대상에서 빠진 수집 서버 ${last.skipped}곳`);
  if (last.dbOk === false) parts.push(`기록을 DB 에 쓰지 못했습니다: ${last.dbError || '사유 미상'}`);
  return parts.join(' · ');
}

/** 차트 모델(상세) — 원시(raw) 또는 일 요약(daily). 실패는 ✕ 표시, 간격이 크면 선을 끊는다. */
/** 연속한 점 간격의 중앙값(양수만, ms) — 측정 주기를 데이터에서 읽는다. 점이 2개 미만이면 null. */
export function cadenceOf(list = []) {
  const ts = (list || []).map((p) => numOrNull(p?.ts)).filter((v) => v != null).sort((a, b) => a - b);
  const ds = [];
  for (let i = 1; i < ts.length; i += 1) { const d = ts[i] - ts[i - 1]; if (d > 0) ds.push(d); }
  if (!ds.length) return null;
  ds.sort((a, b) => a - b);
  return ds[Math.floor((ds.length - 1) / 2)];   // 아래쪽 중앙값 — 빠진 측정이 만든 긴 간격이 주기로 읽히지 않게
}

export function chartModel(hist, { w = 1000, h = 260, padL = 52, padR = 12, padT = 12, padB = 26, now = Date.now() } = {}) {
  if (!hist?.series) return null;
  const daily = hist.source === 'daily';
  const span = Math.max(1, numOrNull(hist.days) ?? 7) * 86_400_000;
  // 축 = 서버가 준 창(v2.735.3 '이전 구간' — end 가 있으면 그 창). 구버전 응답(end 없음)은 예전처럼 지금 기준.
  const to = numOrNull(hist.end) ?? now; const from = to - span;
  const offMs = (numOrNull(hist.offsetMin) ?? 540) * 60_000;
  // 일 요약 점은 그날의 포탈 시각 정오(v2.735.3 — 예전 'T12:00Z' 는 KST 21:00 이라 축 끝을 넘어 찍혔다).
  const pt = (p) => (daily
    ? { ts: Date.parse(`${p.day}T12:00:00Z`) - offMs, day: p.day, v: numOrNull(p.avg), lo: numOrNull(p.min), hi: numOrNull(p.max), n: numOrNull(p.n), okN: numOrNull(p.okN), fail: (numOrNull(p.n) ?? 0) > (numOrNull(p.okN) ?? 0) }
    : { ts: numOrNull(p.ts), v: numOrNull(p.mbps), fail: !p.ok, kind: p.kind || null, bytes: numOrNull(p.bytes), latMs: numOrNull(p.latMs) });
  const down = (hist.series.down || []).map(pt).filter((p) => p.ts != null);
  const up = (hist.series.up || []).map(pt).filter((p) => p.ts != null);
  const vals = [...down, ...up].flatMap((p) => [p.v, p.hi]).filter((v) => v != null);
  const top = vals.length ? Math.max(...vals) * 1.12 : 1;
  const iw = w - padL - padR; const ih = h - padT - padB;
  const x = (ts) => padL + ((ts - from) / (to - from)) * iw;
  const y = (v) => padT + ih - (v / top) * ih;
  // 선을 끊는 간격 — 원시는 데이터의 측정 주기 × 2.5(하한 75분). 30분을 박아 두면 2시간·하루 주기에서 점이 하나도 이어지지 않아
  // 빈 차트가 됐다(v2.735.3). 일 요약은 1.5일. 이어지지 못한 점(앞뒤 모두 끊김)은 따로 점으로 그린다(singles).
  const cad = cadenceOf(down) ?? cadenceOf(up);
  const gapMs = daily ? 1.5 * 86_400_000 : Math.max(75 * 60_000, (cad ?? 0) * 2.5);
  const singles = { down: [], up: [] };
  const path = (list, dir) => {
    let d = ''; let prev = null; let run = [];
    const close = () => { if (run.length === 1) singles[dir].push({ x: x(run[0].ts), y: y(run[0].v) }); run = []; };
    for (const p of list) {
      if (p.v == null || (prev != null && p.ts - prev > gapMs)) close();
      if (p.v != null) { d += `${run.length ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)} `; run.push(p); }
      prev = p.ts;
    }
    close();
    return d.trim();
  };
  const fails = (list, dir) => list.filter((p) => p.fail && !daily).map((p) => ({ x: x(p.ts), y: padT + 10, dir, ts: p.ts }));
  const ticks = 4;
  const grid = Array.from({ length: ticks + 1 }, (_, i) => {
    const v = (top / ticks) * i;
    return { y: y(v), label: mbpsText(v, { unit: false }) };
  });
  const dayMs = 86_400_000;
  const stepDays = span <= 2 * dayMs ? 0.25 : span <= 8 * dayMs ? 1 : span <= 32 * dayMs ? 7 : span <= 200 * dayMs ? 30 : 90;
  // 눈금은 포탈 시각 경계(v2.735.3 — UTC 자정에 맞추면 KST 09:00 이 '날짜 눈금' 이 됐다).
  const stepMs = stepDays * dayMs;
  const xt = [];
  for (let t = Math.ceil((from + offMs) / stepMs) * stepMs - offMs; t <= to; t += stepMs) xt.push({ x: x(t), ts: t });
  const band = daily ? ['down', 'up'].map((dir) => {
    const list = dir === 'down' ? down : up;
    const pts = list.filter((p) => p.lo != null && p.hi != null);
    if (pts.length < 2) return null;
    const upper = pts.map((p) => `${x(p.ts).toFixed(1)},${y(p.hi).toFixed(1)}`);
    const lower = [...pts].reverse().map((p) => `${x(p.ts).toFixed(1)},${y(p.lo).toFixed(1)}`);
    return { dir, d: `M${upper.join(' L')} L${lower.join(' L')} Z` };
  }).filter(Boolean) : [];
  return {
    w, h, padL, padR, padT, padB, from, to, daily, gapMs,
    pts: { down: down.map((p) => ({ ...p, x: x(p.ts), y: p.v == null ? null : y(p.v) })), up: up.map((p) => ({ ...p, x: x(p.ts), y: p.v == null ? null : y(p.v) })) },
    down: path(down, 'down'), up: path(up, 'up'), singles, band,
    fails: [...fails(down, 'down'), ...fails(up, 'up')],
    grid, xticks: xt, points: { down: down.filter((p) => p.v != null).length, up: up.filter((p) => p.v != null).length },
    baseline: (dir) => {
      const m = numOrNull(hist.stats?.[dir]?.median);
      return m == null ? null : y(m);
    },
  };
}

/**
 * 차트 마우스 오버(v2.735.3 사용자 요청 "마우스를 차트에 오버하면 시간과 전송량"). 순수 — 화면 좌표 px(차트 viewBox 단위) → 표시할 내용.
 * 방향마다 그 시각에 가장 가까운 측정 하나를 고른다(허용 거리 = 선을 끊는 간격의 절반 — 측정이 없던 구간에서는 아무것도 고르지 않는다).
 * 두 방향은 같은 회차라도 몇 초 차이로 잰다 — 머리 시각은 더 가까운 쪽이고, 다른 쪽 시각이 1분 넘게 다르면 그 줄에 따로 적는다.
 * 실패는 '실패 — 사유', 일 요약은 '평균 (최저 · 최고) · 성공 n/N'. 값이 없으면 지어내지 않는다.
 */
const PAIR_MS = 15 * 60_000;
export function hoverAt(m, px, offsetMin = 540) {
  if (!m?.pts) return null;
  const iw = m.w - m.padL - m.padR;
  if (!(iw > 0) || !Number.isFinite(px) || px < 0 || px > m.w) return null;
  // 좌우 여백(축 글자 자리)에 있으면 축 끝으로 본다 — 좁은 화면에서 여백이 차트의 몇 % 라 끝 점을 고르기 어려웠다(v2.735.3 400px 확인).
  const cx = Math.min(m.w - m.padR, Math.max(m.padL, px));
  const ts = m.from + ((cx - m.padL) / iw) * (m.to - m.from);
  const tol = m.gapMs / 2;
  const near = (list, at, lim = tol) => {
    let best = null;
    for (const p of list || []) {
      const d = Math.abs(p.ts - at);
      if (d <= lim && (!best || d < best.d)) best = { p, d };
    }
    return best;
  };
  const nd0 = near(m.pts.down, ts); const nu0 = near(m.pts.up, ts);
  if (!nd0 && !nu0) return null;
  const main = !nu0 || (nd0 && nd0.d <= nu0.d) ? nd0.p : nu0.p;
  // 다른 방향은 '같은 회차' 만 — 한 회차의 ↓·↑ 는 몇 초~몇 분 차이로 잰다. 멀리 떨어진 다른 회차를 같은 시각인 척 짝짓지 않는다.
  const pairTol = m.daily ? tol : PAIR_MS;
  const nd = main === nd0?.p ? nd0 : near(m.pts.down, main.ts, pairTol);
  const nu = main === nu0?.p ? nu0 : near(m.pts.up, main.ts, pairTol);
  const line = (dir, hit) => {
    if (!hit) return { dir, text: '측정 없음', ok: null };
    const p = hit.p;
    if (m.daily) {
      if (p.v == null) return { dir, text: `성공 측정 없음${p.n ? ` · 실패 ${p.n}회` : ''}`, ok: false };
      const range = p.lo != null && p.hi != null ? ` (최저 ${mbpsText(p.lo, { unit: false })} · 최고 ${mbpsText(p.hi, { unit: false })})` : '';
      return { dir, text: `평균 ${mbpsText(p.v)}${range} · 성공 ${countText(p.okN)}/${countText(p.n)}`, ok: true };
    }
    const at = Math.abs(p.ts - main.ts) >= 60_000 ? ` · ${clockText(p.ts, offsetMin, { date: false })}` : '';
    if (p.fail) return { dir, text: `실패 — ${FAIL_TEXT[p.kind]?.label || '사유 미상'}${at}`, ok: false };
    const extra = [p.bytes != null ? bytesText(p.bytes) : '', p.latMs != null ? `지연 ${p.latMs}ms` : ''].filter(Boolean).join(' · ');
    return { dir, text: `${mbpsText(p.v)}${extra ? ` · ${extra}` : ''}${at}`, ok: true };
  };
  return {
    x: main.x, ts: main.ts,
    head: m.daily ? `${main.day || clockText(main.ts, offsetMin).slice(0, 10)} 하루 요약` : clockText(main.ts, offsetMin),
    lines: [line('down', nd), line('up', nu)],
    dots: [nd, nu].filter((h) => h && h.p.y != null).map((h) => ({ dir: h.p === nd?.p ? 'down' : 'up', x: h.p.x, y: h.p.y })),
  };
}

/*
 * '이전 구간' 보기(v2.735.3 사용자 요청 "각 시간 단위의 이전 단위를 볼 수 있는 기능" — iDRAC 통합 추이(v2.666)와 같은 모양).
 * 같은 길이(days)의 창을 back 칸만큼 과거로 옮긴다. 기준 끝(anchor)은 스크롤을 시작할 때 한 번 잡는다 — 매번 지금으로 다시 잡으면
 * 1분 갱신 사이에 창이 밀려 같은 칸이 다른 구간이 된다. back=0 은 예전 그대로 '최근 구간'(1분마다 갱신)이다.
 */
/** 몇 칸까지 과거로 갈 수 있나 — 그 보기가 읽는 표(원시 / 일 요약)의 가장 오래된 기록이 들어가는 칸까지. 기록이 없으면 0(스크롤을 숨긴다). */
export function maxBackOf(hist, anchorEnd) {
  const days = numOrNull(hist?.days); const end = numOrNull(anchorEnd);
  if (!(days > 0) || end == null) return 0;
  const span = days * 86_400_000;
  const off = numOrNull(hist?.offsetMin) ?? 540;
  const raw = days <= (numOrNull(hist?.rawMaxDays) ?? 31);
  const oldest = raw ? numOrNull(hist?.oldest?.sampleTs)
    : (typeof hist?.oldest?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(hist.oldest.day) ? Date.parse(`${hist.oldest.day}T00:00:00Z`) - off * 60_000 : null);
  if (oldest == null || !(end > oldest)) return 0;
  return Math.max(0, Math.min(Math.floor(3650 / days), Math.ceil((end - oldest) / span) - 1));
}
/** back 칸 과거 창의 끝(ms) — back 은 [0, maxBack] 로 자른다. */
export function windowEndOf(anchorEnd, back, days, maxBack = Infinity) {
  const b = Math.max(0, Math.min(Number.isFinite(maxBack) ? maxBack : Infinity, Math.floor(Number(back) || 0)));
  return { end: Number(anchorEnd) - b * days * 86_400_000, back: b };
}
/** 스크롤 위치 문구 — '최근 구간' 또는 'N칸 전 (단위)'. */
export function windowLabel(back, days) {
  if (!back) return '최근 구간';
  const lbl = PERIODS.find((p) => p.days === days)?.label || `${days}일`;
  return `${Number(back).toLocaleString()}칸 전 (${lbl} 단위)`;
}
/** 창 시각 범위 문구 — 시작 ~ 끝(포탈 시각). */
export function windowRangeText(end, days, offsetMin = 540) {
  const e = numOrNull(end); if (e == null || !(days > 0)) return '';
  return `${clockText(e - days * 86_400_000, offsetMin)} ~ ${clockText(e, offsetMin)}`;
}

/** '지연' 칸 설명 — 방향마다 재는 방법이 다르다(서버 `analyze.latencyMsOf` 와 같은 정의). */
export const LATENCY_NOTE = '지연 = 데이터가 흐르기 전·후의 연결 + 왕복 — ↓ 는 요청 → 응답 머리, ↑ 은 전체 − 엣지 수신 구간(응답 머리는 업로드가 끝나야 오기 때문). 보내는 쪽 전체 시간 기준(*)이면 구하지 않습니다.';

/** 상세 통계 칸 — 값이 없으면 '—'. */
export function statCells(stats) {
  const s = stats || {};
  const cell = (label, f) => ({ label, down: f(s.down), up: f(s.up) });
  return [
    cell('평균', (x) => mbpsText(x?.avg)),
    cell('중앙값', (x) => mbpsText(x?.median)),
    cell('하위 10%', (x) => mbpsText(x?.p10)),
    cell('최저 · 최고', (x) => (x?.min == null ? '—' : `${mbpsText(x.min, { unit: false })} · ${mbpsText(x.max, { unit: false })}`)),
    cell('성공률', (x) => (numOrNull(x?.okRate) == null ? '—' : `${x.okRate}% (${x.ok}/${x.n})`)),
    cell('지연(중앙값)', (x) => (numOrNull(x?.ttfbMedian) == null ? '—' : `${x.ttfbMedian}ms`)),
  ];
}

export const PERIODS = Object.freeze([
  { days: 1, label: '24시간' }, { days: 7, label: '7일' }, { days: 30, label: '30일' }, { days: 90, label: '90일' }, { days: 365, label: '1년' },
]);
/** 법인 상세를 열 때의 기본 기간 — 24시간(v2.735.2 사용자 요청 "기본 보기를 24시간으로"). PERIODS 안의 값이어야 한다. */
export const DEFAULT_PERIOD_DAYS = 1;

/** 설정 폼 — 화면 단위(분·MB·초·일) ↔ 서버(ms). 빈 칸은 보내지 않는다(서버도 '미지정' 으로 버린다). */
export const SETTING_FIELDS = Object.freeze([
  { key: 'intervalMs', label: '측정 주기', unit: '분', toUi: (v) => Math.round(v / 60_000), toSrv: (v) => v * 60_000, hint: '기본 30분' },
  { key: 'sizeMB', label: '보낼 크기', unit: 'MB', toUi: (v) => v, toSrv: (v) => v, hint: '방향마다 이만큼 주고받습니다' },
  { key: 'timeoutMs', label: '한 방향 시한', unit: '초', toUi: (v) => Math.round(v / 1000), toSrv: (v) => v * 1000, hint: '고지연 회선은 넉넉하게' },
  { key: 'concurrency', label: '동시에 잴 법인 수', unit: '곳', toUi: (v) => v, toSrv: (v) => v, hint: '1 이 가장 정확합니다(메인 회선을 나눠 쓰지 않음)' },
  { key: 'slowPct', label: '느려짐 기준', unit: '%', toUi: (v) => v, toSrv: (v) => v, hint: '평소(7일 중앙값)의 이 % 미만이면 느려짐' },
  { key: 'sampleRetentionDays', label: '측정 기록 보관', unit: '일', toUi: (v) => v, toSrv: (v) => v, hint: '30분마다 1건 원본' },
  { key: 'dailyRetentionDays', label: '일 요약 보관', unit: '일', toUi: (v) => v, toSrv: (v) => v, hint: '하루 평균·최저·최고' },
]);

export function rangeHint(f, ranges) {
  const r = ranges?.[f.key];
  if (!r) return f.hint;
  return `${f.hint} · ${f.toUi(r.min)}~${f.toUi(r.max)}${f.unit}`;
}

/** 폼 값 → 저장 본문(바뀐 칸만, 빈 칸·숫자 아님은 보내지 않는다). */
export function settingsPatch(form, saved) {
  const out = {};
  for (const f of SETTING_FIELDS) {
    const raw = form?.[f.key];
    if (raw == null || String(raw).trim() === '') continue;
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n)) continue;
    const v = f.toSrv(n);
    if (saved && saved[f.key] === v) continue;
    out[f.key] = v;
  }
  if (form && typeof form.enabled === 'boolean' && (!saved || saved.enabled !== form.enabled)) out.enabled = form.enabled;
  if (form && typeof form.intervalOn === 'boolean' && (!saved || (saved.intervalOn !== false) !== form.intervalOn)) out.intervalOn = form.intervalOn;
  if (form && Array.isArray(form.schedules)) {
    const a = JSON.stringify(form.schedules.map(scheduleForSave));
    const b = JSON.stringify((saved?.schedules || []).map(scheduleForSave));
    if (a !== b) out.schedules = form.schedules.map(scheduleForSave);
  }
  if (form && Array.isArray(form.excluded)) {
    const a = [...form.excluded].map((x) => String(x).toLowerCase()).sort().join('|');
    const b = [...(saved?.excluded || [])].map((x) => String(x).toLowerCase()).sort().join('|');
    if (a !== b) out.excluded = form.excluded;
  }
  return out;
}


/* ── 실행 일정(간격 · 예약) — 서버 `xferspeed/schedule.js` 와 같은 규칙(서버 테스트가 같은 입력으로 대조한다) ── */

export const SCHEDULE_KIND_TEXT = Object.freeze({ once: '1회', daily: '매일', weekly: '매주', monthly: '매월' });
export const SCHEDULE_KINDS = Object.freeze(['once', 'daily', 'weekly', 'monthly']);
export const WEEKDAYS = Object.freeze(['일', '월', '화', '수', '목', '금', '토']);
/** 놓침 사유 — 서버 schedule.MISSED_REASONS 와 1:1. */
export const MISSED_TEXT = Object.freeze({
  down: '포탈이 꺼져 있었습니다',
  busy: '이전 측정이 길어졌습니다',
  off: '자동 측정이 꺼져 있었습니다',
  late: '시각이 지난 뒤에 확인했습니다',
});
/** 간격 빠른 선택(분). 직접 입력도 된다(범위는 서버가 준다). */
export const INTERVAL_PRESETS = Object.freeze([30, 60, 120, 180, 360, 720, 1440]);

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function parseTime(v) { const m = TIME_RE.exec(String(v ?? '').trim()); return m ? { h: Number(m[1]), mi: Number(m[2]) } : null; }
function parseDate(v) {
  const m = DATE_RE.exec(String(v ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > lastDayOf(y, mo)) return null;
  return { y, mo, d };
}
const localMs = (y, mo, d, h, mi, off) => Date.UTC(y, mo - 1, d, h, mi) - off * 60_000;

/** 간격(분) → 사람이 읽는 말. */
export function intervalText(min) {
  const m = numOrNull(min);
  if (m == null || m <= 0) return '—';
  if (m % 1440 === 0) return `${m / 1440}일`;
  if (m % 60 === 0) return `${m / 60}시간`;
  if (m > 60) return `${Math.floor(m / 60)}시간 ${m % 60}분`;
  return `${m}분`;
}

/** 일정 → 한 줄('매주 월·목 09:00' · '2026-10-20 14:00 1회' · '매월 1·15일 06:00'). */
export function scheduleText(s) {
  if (!s) return '—';
  const time = String(s.time || '');
  if (s.kind === 'once') return `${s.date || '날짜 없음'} ${time} 1회`;
  if (s.kind === 'weekly') return `매주 ${(s.days || []).map((d) => WEEKDAYS[d]).filter(Boolean).join('·') || '요일 없음'} ${time}`;
  if (s.kind === 'monthly') return `매월 ${(s.monthDays || []).join('·') || '날짜 없음'}일 ${time}`;
  if (s.kind === 'daily') return `매일 ${time}`;
  return '—';
}

/** 폼 검사 — 서버 checkSchedule 과 같은 규칙·같은 문구(서버가 최종 판정한다). 문제가 없으면 ''. */
export function checkScheduleForm(s) {
  if (!s || !SCHEDULE_KINDS.includes(s.kind)) return '종류는 1회·매일·매주·매월 중 하나입니다';
  if (!parseTime(s.time)) return '시각은 00:00~23:59 형식이어야 합니다';
  if (s.kind === 'once' && !parseDate(s.date)) return '날짜는 YYYY-MM-DD 형식의 실제 날짜여야 합니다';
  if (s.kind === 'weekly' && !(s.days || []).length) return '매주 일정은 요일을 하나 이상 골라야 합니다';
  if (s.kind === 'monthly' && !(s.monthDays || []).length) return '매월 일정은 날짜를 하나 이상 골라야 합니다';
  return '';
}

/** 저장할 모양 — 종류에 맞는 칸만(서버가 since 를 정하므로 보내지 않는다). */
export function scheduleForSave(s) {
  const out = { kind: s.kind, time: String(s.time || '').trim(), enabled: s.enabled !== false };
  if (s.id) out.id = s.id;
  if (s.kind === 'once') out.date = String(s.date || '').trim();
  if (s.kind === 'weekly') out.days = [...new Set((s.days || []).map(Number))].sort((a, b) => a - b);
  if (s.kind === 'monthly') out.monthDays = [...new Set((s.monthDays || []).map(Number))].sort((a, b) => a - b);
  return out;
}

/** 새 일정(기본값) — 포탈 날짜의 오늘, 09:00, 매일. */
export function newSchedule(now = Date.now(), offsetMin = 540) {
  const d = new Date(now + offsetMin * 60_000);
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return { id: '', kind: 'daily', time: '09:00', date, days: [1], monthDays: [1], enabled: true };
}

function matchDay(s, y, mo, d, wd) {
  if (s.kind === 'daily') return true;
  if (s.kind === 'weekly') return (s.days || []).includes(wd);
  if (s.kind === 'monthly') {
    const last = lastDayOf(y, mo);
    if ((s.monthDays || []).includes(d)) return true;
    return d === last && (s.monthDays || []).some((x) => x > last);
  }
  return false;
}

/** after 보다 뒤의 첫 실행 시각(포탈 시각 기준) — 서버 nextOccurrence 와 같은 결과(테스트 대조). 없으면 null. */
export function nextOccurrence(s, after, offsetMin = 540) {
  if (!s || !SCHEDULE_KINDS.includes(s.kind)) return null;
  const tm = parseTime(s.time);
  if (!tm) return null;
  if (s.kind === 'once') {
    const p = parseDate(s.date);
    if (!p) return null;
    const occ = localMs(p.y, p.mo, p.d, tm.h, tm.mi, offsetMin);
    return occ > after ? occ : null;
  }
  const b = new Date(after + offsetMin * 60_000);
  for (let i = 0; i <= 400; i++) {
    const day = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() + i));
    const y = day.getUTCFullYear(); const mo = day.getUTCMonth() + 1; const d = day.getUTCDate();
    if (!matchDay(s, y, mo, d, day.getUTCDay())) continue;
    const occ = localMs(y, mo, d, tm.h, tm.mi, offsetMin);
    if (occ > after) return occ;
  }
  return null;
}

/** 하루 평균 실행 횟수(미리보기 — 서버 runsPerDay 와 같은 식). */
export function runsPerDayPreview({ intervalOn = true, intervalMin = 30, schedules = [] } = {}) {
  let n = 0;
  const iv = numOrNull(intervalMin);
  if (intervalOn && iv && iv > 0) n += Math.floor(1440 / Math.max(1, iv));
  for (const s of schedules || []) {
    if (!s?.enabled || checkScheduleForm(s)) continue;
    if (s.kind === 'daily') n += 1;
    else if (s.kind === 'weekly') n += (s.days || []).length / 7;
    else if (s.kind === 'monthly') n += Math.min(31, (s.monthDays || []).length) * 12 / 365;
  }
  return Math.round(n * 100) / 100;
}

/** 예약 한 줄의 상태 — 다음 실행 · 마지막 처리(실행/놓침 사유). */
export function scheduleStateText(st, offsetMin = 540, now = Date.now()) {
  const parts = [];
  if (st?.next) parts.push(`다음 ${clockText(st.next, offsetMin)}(${st.next - now > 60_000 ? `약 ${spanText(st.next - now)} 후` : '곧'})`);
  const l = st?.last;
  if (l?.lastAt) {
    if (l.result === 'missed') parts.push(`${clockText(l.lastAt, offsetMin)} 놓침 — ${MISSED_TEXT[l.reason] || '사유 미상'}`);
    else parts.push(`${clockText(l.lastAt, offsetMin)} 실행함`);
  }
  return parts.join(' · ');
}

/** 머리 한 줄 — '30분마다 · 예약 2개(매일 09:00 · 매주 월 18:00)'. 사용 중인 예약만 센다. */
export function planSummary(settings) {
  const st = settings || {};
  const iv = st.intervalOn === false ? '간격 실행 꺼짐' : `${intervalText(Math.round((numOrNull(st.intervalMs) ?? 0) / 60_000))}마다`;
  const on = (st.schedules || []).filter((x) => x?.enabled);
  if (!on.length) return st.intervalOn === false ? `${iv} · 사용 중인 예약 없음` : iv;
  const shown = on.slice(0, 3).map(scheduleText).join(' · ');
  return `${iv} · 예약 ${on.length}개(${shown}${on.length > 3 ? ' …' : ''})`;
}
