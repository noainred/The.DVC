/**
 * isiduText.js — 특수 기능 '아이실론 디렉터리 사용량'(v2.736) 화면의 문구·좌표(순수 — 테스트가 고정한다).
 *
 * 판정은 서버(`isidu/report.js`·`isidu/collect.js`)가 하고, 이 모듈은 그 결과를 문장·색·좌표로 바꾼다.
 *  · 크기는 du 와 같은 **1024 단위**다(du -h 의 '73G' 는 73 × 1024³ 바이트). 화면 표기 'TB' 는 그 단위다 — 각주가 말한다.
 *  · `-h` 값은 반올림(유효숫자 2자리)이다. 서버가 행마다 해상도(res)를 싣고, 두 관측의 차이가 해상도 안이면 `withinRes` —
 *    화면은 그것을 '변화 없음' 으로 말하고 숫자를 지어내지 않는다.
 *  · 비교 기준(7일·30일 전 수집)이 없으면 증감·신규 판정은 '—' 다(관측 2일로 7일 변화를 만들지 않는다).
 *  · 못 읽은 값은 '—' 이고 단위를 붙이지 않는다(`— TB` 는 0 처럼 읽힌다).
 *  · 문구에 백틱을 쓰지 않는다(BoldText 는 **강조**만 해석한다). 값 인용은 ‘ ’.
 */
import { numOrNull } from '../../numOrNull.js';
import { agoText } from './relTime.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** 실패 종류 — 서버 `isidu/collect.js FAIL_KINDS` 와 1:1(테스트가 서버 소스와 대조한다). */
export const FAIL_TEXT = Object.freeze({
  'no-key': { title: 'SSH 키 없음', fix: '이 노드의 SSH 키를 만들지 못했습니다 — 설정 창의 ‘키 만들기’ 를 누르고, 그래도 안 되면 서버 로그의 [isidu] 줄을 보세요.' },
  'device-missing': { title: '등록부에 장비 없음', fix: '스토리지 등록부에서 그 아이실론이 지워졌거나, 엣지가 스토리지 설정을 아직 받지 못했습니다 — 설정 › 스토리지에서 장비를 확인하세요.' },
  'device-not-isilon': { title: '아이실론이 아님', fix: '고른 장비의 종류가 아이실론(PowerScale)이 아닙니다 — 대상 설정에서 장비를 다시 고르세요.' },
  auth: { title: '인증 거부', fix: '아이실론이 키(또는 계정)를 받지 않았습니다. 키 인증이면 아래 공개키가 그 계정의 authorized_keys 에 있는지 확인하세요. 주기 수집은 계정 잠금을 막으려 멈췄고, 키·계정이 바뀌면 자동으로 다시 시도합니다.' },
  hostkey: { title: '호스트키 미확인', fix: '처음 보는(또는 바뀐) SSH 호스트키라 접속하지 않았습니다 — 설정 › 보안 › 장비 신뢰에서 지문을 확인하고 승인하세요.' },
  timeout: { title: '시한 초과', fix: 'du 가 시한 안에 끝나지 않았습니다 — 폴더가 매우 크면 시한을 늘리거나(최대 120분) 더 아래 경로로 나눠 등록하세요.' },
  unreachable: { title: '연결 실패', fix: '그 노드에서 아이실론 SSH(22번) 에 닿지 않습니다 — 주소·방화벽·회선을 확인하세요(엣지 담당이면 그 엣지에서).' },
  exec: { title: '명령 실패', fix: 'du 가 결과 없이 끝났습니다 — 경로가 있는지, 그 계정에 읽기 권한이 있는지 확인하세요(연결 시험으로 경로를 확인할 수 있습니다).' },
  parse: { title: '출력 해석 실패', fix: 'du 출력에서 폴더를 하나도 읽지 못했습니다 — 경로가 비어 있거나 명령이 다른 출력을 냈습니다. 오류 원문을 확인하세요.' },
  'output-cap': { title: '출력 상한 초과', fix: '하위 폴더가 너무 많아 출력이 상한을 넘었습니다 — 더 아래 경로로 나눠 등록하세요.' },
  db: { title: 'DB 저장 실패', fix: '조사는 끝났지만 결과를 DB 에 쓰지 못했습니다 — 디스크 여유와 서버 로그의 [isidu-db] 줄을 보세요.' },
});

export const failTitle = (kind) => FAIL_TEXT[kind]?.title || (kind ? String(kind) : '실패');

/** 바이트 → 사람이 읽는 크기(1024 단위). 못 읽은 값은 '—'. */
export function bytesText(b, { dash = '—' } = {}) {
  const n = numOrNull(b);
  if (n == null) return dash;
  let v = Math.abs(n); let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  const s = i === 0 ? String(Math.round(v)) : v < 100 ? (Math.round(v * 10) / 10).toFixed(1) : String(Math.round(v));
  return `${n < 0 ? '−' : ''}${s} ${UNITS[i]}`;
}

/** 부호를 붙인 크기(+ / −). 0 은 '0'. */
export function signedBytes(b) {
  const n = numOrNull(b);
  if (n == null) return '—';
  if (n === 0) return '0';
  return `${n > 0 ? '+' : '−'}${bytesText(Math.abs(n))}`;
}

/**
 * 증감 칸 하나.
 * @param d     서버 deltaOf 결과 {bytes, withinRes, uncertainty} 또는 null(비교 기준 없음 · 기준에 없던 폴더)
 * @param opts  isNew(서버 new7/new30 — true 면 '신규'), removed(사라진 폴더 행), hasBase(기준 스캔이 있는가)
 * @returns {{text:string, tone:'up'|'down'|'flat'|'new'|'gone'|'none', title:string}}
 */
export function deltaView(d, { isNew = null, removed = false, hasBase = true } = {}) {
  if (removed) return { text: '사라짐', tone: 'gone', title: '기준 수집에는 있었는데 지금은 없는 폴더입니다(크기는 그때 값).' };
  if (isNew === true) return { text: '신규', tone: 'new', title: '기준 수집에는 없던 폴더입니다.' };
  if (!d) return { text: '—', tone: 'none', title: hasBase ? '비교할 값이 없습니다.' : '비교할 이전 수집이 아직 없습니다(관측 기간이 짧습니다).' };
  const b = numOrNull(d.bytes);
  if (b == null) return { text: '—', tone: 'none', title: '비교할 값이 없습니다.' };
  if (d.withinRes) {
    return { text: '변화 없음', tone: 'flat', title: `차이 ${signedBytes(b)} 가 표기 오차(약 ±${bytesText(d.uncertainty)}) 안이라 변화라고 단정하지 않습니다(-h 값은 반올림입니다).` };
  }
  return { text: signedBytes(b), tone: b > 0 ? 'up' : b < 0 ? 'down' : 'flat', title: '' };
}

/** 비중(0~1) → '9.4%'. 작으면 '<0.1%'. 못 읽으면 '—'. */
export function shareText(s) {
  const n = numOrNull(s);
  if (n == null) return '—';
  const p = n * 100;
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${p < 10 ? (Math.round(p * 10) / 10).toFixed(1) : Math.round(p)}%`;
}

export const countText = (n) => (numOrNull(n) == null ? '—' : Number(n).toLocaleString('ko-KR'));

/** 노드 표기 — 담당 엣지가 있으면 그 엣지, 없으면 메인. */
export const nodeText = (agent) => (agent ? `엣지 ${agent}` : '메인');

/** 주기 표기. */
export function everyText(h) {
  const n = numOrNull(h);
  if (n == null || n <= 0) return '—';
  if (n % 24 === 0) return n === 24 ? '하루마다' : `${n / 24}일마다`;
  return `${n}시간마다`;
}

/** 소요 시간. */
export function durationText(ms) {
  const n = numOrNull(ms);
  if (n == null || n < 0) return '—';
  if (n < 1000) return '1초 미만';
  const s = Math.round(n / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${s % 60}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

/** 서버 normPath 와 같은 규칙(겹친 / 하나로 · 끝 / 제거). */
export function normPath(p) {
  let out = ''; let prev = false;
  for (const c of String(p ?? '')) {
    if (c === '/') { if (prev) continue; prev = true; } else prev = false;
    out += c;
  }
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/** 입력 중 안내(서버 pathIssue 와 같은 규칙 — 판정은 서버가 다시 한다). */
export function pathHint(p) {
  const raw = String(p ?? '').trim();
  if (!raw) return '조사할 디렉터리를 입력하세요.';
  if (raw.length > 1024) return '경로가 너무 깁니다(1024자 이하).';
  if (/[\u0000-\u001f\u007f]/.test(raw)) return '경로에 제어 문자가 있습니다.';
  if (/['\\$`]/.test(raw)) return '경로에 작은따옴표·역슬래시·$·백틱은 쓸 수 없습니다.';
  const n = normPath(raw);
  if (!(n === '/ifs' || n.startsWith('/ifs/'))) return '아이실론 경로(/ifs 아래 절대 경로)만 쓸 수 있습니다.';
  if (n.split('/').some((seg) => seg === '.' || seg === '..')) return "경로에 '.' 이나 '..' 조각은 쓸 수 없습니다.";
  return null;
}

/** 실행할 명령 미리보기(서버 duCommand 와 같은 모양 — 표시 전용). */
export function commandText({ username = '', host = '', port = 22, path = '', sizeMode = 'h' } = {}) {
  const flag = sizeMode === 'k' ? '-k' : '-h';
  const who = `${username || '(계정)'}@${host || '(주소)'}`;
  const p = Number(port) && Number(port) !== 22 ? ` -p ${Number(port)}` : '';
  return `ssh${p} ${who} "du -A ${flag} -d 1 '${normPath(path) || '/ifs/…'}'"`;
}

/** 경로 꼬리(표에서 '…/users/aaa' 처럼). */
export function tailPath(path, name) {
  const segs = normPath(path).split('/').filter(Boolean);
  const last = segs[segs.length - 1] || '';
  return `…/${last ? `${last}/` : ''}${name}`;
}

/* ─────────────── 스파크라인 · 추이 차트 ─────────────── */

/**
 * 스파크라인 좌표 — null 은 선을 끊는다(그때는 없던 폴더). 점이 하나뿐인 구간은 점으로.
 * @returns {{d:string, dots:{x:number,y:number}[]}}
 */
export function sparkPath(values, w = 100, h = 24, pad = 2) {
  const vs = Array.isArray(values) ? values.map(numOrNull) : [];
  const ok = vs.filter((v) => v != null);
  if (!ok.length) return { d: '', dots: [] };
  let lo = Math.min(...ok); let hi = Math.max(...ok);
  // 변화가 값의 2% 미만이면 축을 넓힌다 — 잔물결을 급경사로 보이지 않게(v2.670 경영 보기와 같은 판단).
  const minSpan = Math.max(hi * 0.02, 1);
  if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
  const n = vs.length;
  const X = (i) => pad + (n <= 1 ? (w - pad * 2) / 2 : (i * (w - pad * 2)) / (n - 1));
  const Y = (v) => pad + (h - pad * 2) * (1 - (v - lo) / (hi - lo));
  let d = ''; const dots = [];
  let run = [];
  const flush = () => {
    if (run.length === 1) dots.push({ x: X(run[0][0]), y: Y(run[0][1]) });
    else if (run.length > 1) d += run.map(([i, v], k) => `${k ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ') + ' ';
    run = [];
  };
  vs.forEach((v, i) => { if (v == null) flush(); else run.push([i, v]); });
  flush();
  return { d: d.trim(), dots };
}

/** 1024 단위의 보기 좋은 눈금 간격. */
function niceStep(span, ticks = 4) {
  const raw = span / ticks;
  if (!(raw > 0)) return 1;
  const base = 1024 ** Math.max(0, Math.floor(Math.log(raw) / Math.log(1024)));
  const r = raw / base;
  const steps = [1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
  const s = steps.find((x) => x >= r) || 1024;
  return s * base;
}

/** 수집 간격(아래쪽 중앙값) — 선을 끊는 기준. */
export function cadenceOf(ts) {
  const gaps = [];
  for (let i = 1; i < ts.length; i++) { const g = ts[i] - ts[i - 1]; if (g > 0) gaps.push(g); }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor((gaps.length - 1) / 2)];
}

/**
 * 추이 차트 모델.
 * @param points [{ts, bytes, partial?}] (서버 trend)
 * @param box    {w, h, padL, padR, padT, padB}
 * @returns {{hasData, lines:string[], area:string, solid:{x,y}[], hollow:{x,y,ts,bytes}[], yTicks:{y,label}[], xTicks:{x,label}[], last:{x,y,bytes,ts}|null, gapMs:number|null, breaks:number}}
 */
export function trendModel(points, { w = 420, h = 170, padL = 44, padR = 10, padT = 12, padB = 22 } = {}, { now = Date.now(), days = 30 } = {}) {
  const pts = (Array.isArray(points) ? points : []).filter((p) => p && numOrNull(p.ts) != null && numOrNull(p.bytes) != null)
    .map((p) => ({ ts: Number(p.ts), bytes: Number(p.bytes), partial: !!p.partial })).sort((a, b) => a.ts - b.ts);
  const empty = { hasData: false, lines: [], area: '', solid: [], hollow: [], yTicks: [], xTicks: [], last: null, gapMs: null, breaks: 0 };
  if (!pts.length) return empty;
  const end = Math.max(pts[pts.length - 1].ts, Math.min(now, pts[pts.length - 1].ts + DAY));
  const start = Math.min(pts[0].ts, end - days * DAY);
  const full = pts.filter((p) => !p.partial);
  const vals = (full.length ? full : pts).map((p) => p.bytes);
  let lo = Math.min(...vals); let hi = Math.max(...vals);
  const minSpan = Math.max(hi * 0.05, 1024 ** 2);
  if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = Math.max(0, mid - minSpan / 2); hi = lo + minSpan; }
  const step = niceStep(hi - lo);
  lo = Math.max(0, Math.floor(lo / step) * step); hi = Math.ceil(hi / step) * step;
  if (hi <= lo) hi = lo + step;
  const X = (t) => padL + ((t - start) / Math.max(1, end - start)) * (w - padL - padR);
  const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  const cad = cadenceOf(full.map((p) => p.ts));
  const gapMs = cad ? Math.max(cad * 2.5, 6 * HOUR) : null;
  const lines = []; let cur = []; let breaks = 0; let prevTs = null;
  for (const p of full) {
    if (prevTs != null && gapMs != null && p.ts - prevTs > gapMs) { if (cur.length) lines.push(cur); cur = []; breaks++; }
    cur.push(p); prevTs = p.ts;
  }
  if (cur.length) lines.push(cur);
  const toD = (seg) => seg.map((p, i) => `${i ? 'L' : 'M'}${X(p.ts).toFixed(1)} ${Y(p.bytes).toFixed(1)}`).join(' ');
  const multi = lines.filter((s) => s.length > 1);
  const longest = multi.reduce((a, s) => (s.length > (a?.length || 0) ? s : a), null);
  const base = Y(lo);
  const area = longest ? `${toD(longest)} L${X(longest[longest.length - 1].ts).toFixed(1)} ${base.toFixed(1)} L${X(longest[0].ts).toFixed(1)} ${base.toFixed(1)} Z` : '';
  const solid = lines.filter((s) => s.length === 1).map((s) => ({ x: X(s[0].ts), y: Y(s[0].bytes) }));
  const hollow = pts.filter((p) => p.partial).map((p) => ({ x: X(p.ts), y: Y(Math.max(lo, p.bytes)), ts: p.ts, bytes: p.bytes }));
  const yTicks = [];
  for (let v = lo; v <= hi + step / 2; v += step) yTicks.push({ y: Y(v), label: bytesText(v).replace(' ', '') });
  const fmtD = (t) => { const d = new Date(t + 9 * HOUR); return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; };
  const xTicks = [{ x: X(start), label: fmtD(start), anchor: 'start' }, { x: X(end), label: fmtD(end), anchor: 'end' }];
  const lp = full.length ? full[full.length - 1] : pts[pts.length - 1];
  return { hasData: true, lines: multi.map(toD), area, solid, hollow, yTicks, xTicks, last: { x: X(lp.ts), y: Y(Math.max(lo, lp.bytes)), bytes: lp.bytes, ts: lp.ts }, gapMs, breaks };
}

/** 추이 아래 해설 — 해상도·부분 합·실패를 말한다. 해상도는 서버가 싣는 마지막 점의 res(없으면 크기로 어림). */
export function trendNotes(tr, { sizeMode = 'h' } = {}) {
  const out = [];
  const pts = (tr?.points || []).filter((p) => p && numOrNull(p.bytes) != null);
  const last = pts[pts.length - 1] || null;
  if (sizeMode !== 'k' && last) {
    const res = numOrNull(last.res) ?? resolutionOf(last.bytes);
    if (res > 1) out.push(`-h 값은 반올림입니다 — 이 크기에서는 약 ${bytesText(res)} 보다 작은 변화가 보이지 않습니다.`);
  }
  const partial = pts.filter((p) => p.partial).length;
  if (partial) out.push(`속이 빈 점 ${partial}개는 권한 오류가 난 수집입니다 — 그때 크기는 실제보다 작을 수 있어 선에 넣지 않았습니다.`);
  const fails = (tr?.failures || []).length;
  if (fails) out.push(`이 기간에 실패한 수집 ${fails}회는 점이 없습니다.`);
  return out;
}

/** du -h 표기의 해상도(바이트) 어림 — 서버 res 가 없을 때만 쓴다(10 미만은 소수 1자리, 그 이상은 정수). */
export function resolutionOf(bytes) {
  const n = numOrNull(bytes);
  if (n == null || n <= 0) return 1;
  let v = n; let i = 0;
  while (v >= 1024 && i < 5) { v /= 1024; i++; }
  const unit = 1024 ** i;
  return v < 10 && i > 0 ? unit / 10 : unit;
}

/* ─────────────── KPI · 해설 ─────────────── */

/** 비교 기준 해설 — 기준이 없거나 간격이 7일과 다르면 말한다. */
export function baseNote(rep) {
  if (!rep || rep.state !== 'ok') return null;
  if (!rep.base7) return '7일 전 수집이 아직 없어 7일 변화·신규·사라짐을 판정하지 않았습니다(—). 수집이 쌓이면 채워집니다.';
  const span = numOrNull(rep.base7.spanDays);
  if (span != null && Math.abs(span - 7) >= 1) return `7일 변화의 실제 비교 간격은 ${span}일입니다(그 날짜에 수집이 없어 가장 가까운 이전 수집과 비교했습니다).`;
  return null;
}

/** 수집 결과에 대한 해설(권한 오류·상한·실패·해상도). */
export function scanNotes(rep, now = Date.now()) {
  const out = [];
  if (!rep || rep.state !== 'ok') return out;
  const s = rep.scan || {};
  if (s.errLines > 0) out.push({ tone: 'amber', text: `du 가 권한 오류 **${countText(s.errLines)}줄**을 냈습니다 — 해당 폴더의 크기는 실제보다 작을 수 있습니다.${s.errSample?.[0] ? ` 예: ‘${String(s.errSample[0]).slice(0, 160)}’` : ''}` });
  if (s.truncated) out.push({ tone: 'amber', text: '출력이 상한에 걸려 일부 폴더가 빠졌습니다 — 더 아래 경로로 나눠 등록하세요.' });
  if (s.skipped > 0) out.push({ tone: '', text: `해석하지 못한 줄 ${countText(s.skipped)}개는 뺐습니다(경로가 다르거나 형식이 다른 줄).` });
  if (rep.lastFailure) {
    const f = rep.lastFailure;
    out.push({ tone: 'red', text: `마지막 시도는 실패했습니다(${agoText(f.ts, now)} · ${failTitle(f.kind)}${rep.failStreak > 1 ? ` · 연속 ${rep.failStreak}회` : ''}) — 아래 값은 **${agoText(s.ts, now)}** 성공한 수집입니다.` });
  }
  return out;
}

/**
 * KPI 4칸.
 * @returns {{key,label,value,sub,tone?}[]}
 */
export function kpiCards(rep, target, now = Date.now()) {
  if (!rep || rep.state !== 'ok') return [];
  const k = rep.kpi || {};
  const d7 = deltaView(k.totalDelta7, { hasBase: !!rep.base7 });
  const res = rep.scan?.sizeMode === 'k' ? '정확(-k)' : '반올림(-h)';
  return [
    { key: 'total', label: '디렉터리 전체', value: bytesText(k.denomBytes), sub: `7일 ${d7.text} · ${res}`, tone: d7.tone },
    { key: 'users', label: '사용자 폴더', value: countText(k.users), sub: rep.base7 ? `신규 ${countText(k.new7)} · 사라짐 ${countText(k.removed7)} (7일 전 대비)` : '신규·사라짐: 7일 전 수집 없음' },
    { key: 'top', label: `Top ${k.topN || 10} 비중`, value: shareText(k.topShare), sub: `${bytesText(k.topBytes)} / ${bytesText(k.denomBytes)}`, bar: numOrNull(k.topShare) },
    { key: 'last', label: '마지막 수집', value: agoText(rep.scan?.ts, now), sub: `소요 ${durationText(rep.scan?.durationMs)} · ${everyText(target?.intervalHours)} · ${nodeText(rep.scan?.node || '')}` },
  ];
}

/* ─────────────── 수집 상태 ─────────────── */

/**
 * 대상 하나의 수집 상태(표·칩).
 * 순서가 계약이다 — 장비 문제 → 꺼짐 → 진행 중 → 요청 대기 → 인증 정지 → 최근 실패 → 기록 없음 → 오래됨 → 정상.
 * @returns {{key:string, text:string, tone:'ok'|'warn'|'bad'|'muted'|'run', detail:string}}
 */
export function targetStatus(t, now = Date.now()) {
  if (!t) return { key: 'none', text: '—', tone: 'muted', detail: '' };
  if (t.issue) return { key: 'issue', text: failTitle(t.issue), tone: 'bad', detail: FAIL_TEXT[t.issue]?.fix || '' };
  if (t.enabled === false) return { key: 'off', text: '꺼짐', tone: 'muted', detail: '이 대상은 주기 수집을 하지 않습니다(설정에서 켤 수 있습니다).' };
  if (t.deviceDisabled) return { key: 'off', text: '장비 비활성', tone: 'muted', detail: '스토리지 등록부에서 이 아이실론이 비활성이라 주기 수집을 하지 않습니다.' };
  if (t.running) {
    const since = numOrNull(t.running.since);
    return { key: 'running', text: '조사 중', tone: 'run', detail: `${since ? `${agoText(since, now).replace(' 전', '')}째` : ''} du 실행 중${t.agent ? `(엣지 보고 ${agoText(t.running.reportedAt, now)})` : ''}` };
  }
  if (t.request) return { key: 'requested', text: t.request.state === 'taken' ? '엣지가 실행 중' : '요청 대기', tone: 'run', detail: t.request.state === 'taken' ? '엣지가 요청을 가져갔습니다 — 결과가 오면 갱신됩니다.' : '엣지가 다음 설정 pull 에 가져갑니다.' };
  if (t.authStopped) return { key: 'auth-stopped', text: '인증 정지', tone: 'bad', detail: FAIL_TEXT.auth.fix };
  const ok = t.okScan; const lt = t.lastTry;
  if (lt && lt.ok === false && (!ok || lt.ts > ok.ts)) {
    return { key: 'failed', text: failTitle(lt.kind), tone: 'bad', detail: `${lt.error ? `${String(lt.error).slice(0, 240)} — ` : ''}${FAIL_TEXT[lt.kind]?.fix || ''}` };
  }
  if (!ok) return { key: 'never', text: '수집 전', tone: 'muted', detail: t.agent ? `엣지 ‘${t.agent}’ 가 첫 수집 결과를 아직 올리지 않았습니다.` : '첫 수집이 아직 없습니다 — 지금 수집을 누르거나 다음 주기를 기다리세요.' };
  const every = (numOrNull(t.intervalHours) || 24) * HOUR;
  const staleMs = every * 2 + (numOrNull(t.timeoutMin) || 30) * MIN + HOUR;
  if (now - ok.ts > staleMs) return { key: 'stale', text: '보고 늦음', tone: 'warn', detail: `마지막 성공이 ${agoText(ok.ts, now)}입니다(주기 ${everyText(t.intervalHours)}).${t.agent ? ` 엣지 ‘${t.agent}’ 의 상태를 엣지 로그에서 확인하세요.` : ''}` };
  if (ok.errLines > 0) return { key: 'ok-partial', text: '정상(권한 오류 일부)', tone: 'warn', detail: `권한 오류 ${countText(ok.errLines)}줄 — 일부 폴더 크기가 작을 수 있습니다.` };
  return { key: 'ok', text: '정상', tone: 'ok', detail: '' };
}

/** 키 상태 배지. */
export function keyStatus(key) {
  if (!key) return { text: '보고 없음', tone: 'muted' };
  if (key.error) return { text: '키 오류', tone: 'bad' };
  if (key.usable) return { text: '키 있음', tone: 'ok' };
  if (key.present) return { text: '키 사용 불가', tone: 'bad' };
  return { text: '키 없음', tone: 'warn' };
}

/**
 * 키를 등록해야 하는 노드 목록 — 메인 + 키 인증 대상을 맡은 엣지. 엣지가 보고하지 않았으면 '보고 없음'(키가 없다고 단정하지 않는다).
 * @returns {{node:string, agent:string, key:object|null, reportedAt:number|null, targets:string[]}[]}
 */
export function keyRows(targets, mainKey, edges) {
  const byAgent = new Map();
  const need = (Array.isArray(targets) ? targets : []).filter((t) => t && t.auth !== 'device');
  const mainTargets = need.filter((t) => !t.agent).map((t) => t.label || t.id);
  const rows = [{ node: '메인', agent: '', key: mainKey || null, reportedAt: null, targets: mainTargets }];
  for (const t of need.filter((x) => x.agent)) {
    const k = String(t.agent).toLowerCase();
    if (!byAgent.has(k)) byAgent.set(k, { agent: t.agent, targets: [] });
    byAgent.get(k).targets.push(t.label || t.id);
  }
  const edgeOf = new Map((Array.isArray(edges) ? edges : []).map((e) => [String(e.agent || '').toLowerCase(), e]));
  for (const [k, v] of byAgent) {
    const e = edgeOf.get(k) || null;
    rows.push({ node: `엣지 ${v.agent}`, agent: v.agent, key: e?.key || null, reportedAt: numOrNull(e?.at), targets: v.targets });
  }
  return rows;
}

/** '지금 수집' 응답(202) → 한 줄. */
/**
 * 메인 → 엣지 직접 요청(원격 실행·원격 연결 시험)의 실패 종류 — 서버 `central/edgePull.js EDGE_PULL_KINDS` + 'edge-pull'
 * (`central/isiduRemote.js` 가 더하는 것)와 1:1(테스트가 서버 소스와 대조한다). iDRAC PUSH 스캔과 같은 길이다.
 */
export const EDGE_CALL_TEXT = Object.freeze({
  'not-registered': '메인의 수집 서버 등록부에 이 엣지가 없습니다 — 설정 › 수집 서버(원격)에 엣지 포탈 URL·토큰을 등록하면 바로 보낼 수 있습니다.',
  'disabled-central': '메인에서 이 수집 서버를 비활성으로 두었습니다 — 설정 › 수집 서버(원격)에서 켜세요.',
  'no-url': '이 수집 서버에 URL 이 없습니다 — 등록부에 엣지 포탈 주소를 넣으세요.',
  timeout: '엣지가 시한 안에 답하지 않았습니다 — 엣지가 바쁘거나 회선이 느립니다.',
  unreachable: '메인에서 엣지 포탈에 닿지 않습니다 — 방화벽·주소를 확인하세요.',
  auth: '수집 서버 토큰이 엣지의 COLLECTOR_TOKEN 과 다릅니다 — 설정 › 수집 서버(원격)의 진단으로 맞추세요.',
  disabled: '엣지의 collector 기능이 꺼져 있습니다(엣지 COLLECTOR_TOKEN 미설정).',
  'old-version': '엣지가 2.736 이전 버전입니다 — 엣지를 업그레이드해야 바로 실행·원격 연결 시험이 됩니다.',
  http: '엣지가 오류로 답했습니다.',
  'bad-body': '엣지 응답 형식이 다릅니다(엣지 포탈이 아닌 서버에 닿았을 수 있습니다).',
  'edge-pull': '엣지가 메인의 설정을 받지 못했습니다 — 엣지 → 메인 통신(CENTRAL_URL·CENTRAL_TOKEN)을 확인하세요.',
});
export const edgeCallText = (kind) => EDGE_CALL_TEXT[kind] || (kind ? `엣지 요청 실패(${kind})` : '엣지 요청 실패');

/** '지금 수집' 응답의 엣지별 전달 결과 → 줄 목록 `{ agent, ok, text }`. */
export function nudgeLines(r) {
  return (Array.isArray(r?.nudged) ? r.nudged : []).map((n) => ({
    agent: n.agent || '',
    ok: n.ok === true,
    text: n.ok === true
      ? `엣지 ‘${n.agent}’ 에 바로 전달 — ${numOrNull(n.started) ? `조사 ${n.started}개 시작` : '요청을 받았습니다(이미 조사 중이면 끝난 뒤 반영)'}`
      : `엣지 ‘${n.agent}’ 에 바로 전달하지 못했습니다 — ${edgeCallText(n.kind)}${n.reason && (n.kind === 'http' || n.kind === 'edge-pull' || n.kind === 'unreachable' || n.kind === 'timeout') ? ` (${String(n.reason).slice(0, 120)})` : ''} 요청은 남아 있어 엣지의 다음 설정 pull(기본 5분)이 가져갑니다.`,
  }));
}

/** 연결 시험 결과 → `{ tone, text }`(메인·엣지 공통). */
export function testResultText(r) {
  if (!r) return null;
  const where = r.via === 'edge' ? `엣지 ‘${r.node || '?'}’ 에서` : '메인에서';
  if (r.ok) return { tone: 'ok', text: `성공 — ${r.out || ''}${r.demo ? '' : ` (${where} · ${numOrNull(r.ms) ?? '—'}ms)`}` };
  if (r.via === 'edge' && r.kind && EDGE_CALL_TEXT[r.kind]) return { tone: 'bad', text: `엣지 ‘${r.node || '?'}’ 에 시험을 보내지 못했습니다 — ${edgeCallText(r.kind)}${r.kind === 'http' && r.reason ? ` (${String(r.reason).slice(0, 120)})` : ''}` };
  const fk = r.failKind || r.kind;
  const fix = fk && FAIL_TEXT[fk] ? ` — ${FAIL_TEXT[fk].fix}` : '';
  return { tone: 'bad', text: `${where} 실패: ${r.reason || '실패'}${fix}` };
}

export function runResultText(r) {
  if (!r) return '';
  const parts = [];
  if (r.started?.length) parts.push(`메인에서 ${r.started.length}개 시작`);
  if (r.requested?.length) {
    const ns = Array.isArray(r.nudged) ? r.nudged : [];
    const ok = ns.filter((n) => n.ok === true).length;
    parts.push(ns.length
      ? `엣지에 ${r.requested.length}개 요청 — 바로 전달 ${ok}/${ns.length}곳${ok < ns.length ? '(못 받은 엣지는 다음 설정 pull 에 가져갑니다)' : ''}`
      : `엣지에 ${r.requested.length}개 요청(다음 설정 pull 에 가져갑니다)`);
  }
  if (r.duplicate?.length) parts.push(`이미 요청됨 ${r.duplicate.length}개`);
  if (r.busy?.length) parts.push(`이미 조사 중 ${r.busy.length}개`);
  if (r.issues?.length) parts.push(`장비 문제로 건너뜀 ${r.issues.length}개`);
  if (r.notFound?.length) parts.push(`설정에 없음 ${r.notFound.length}개`);
  if (r.notHere?.length) parts.push(`이 노드 몫이 아님 ${r.notHere.length}개`);
  return parts.length ? `${parts.join(' · ')}. du 는 수 분~수십 분 걸릴 수 있습니다 — 끝나면 이 화면이 갱신됩니다.` : '시작할 대상이 없습니다.';
}

/* ─────────────── 전체 사용자 표 ─────────────── */

export const USER_FILTERS = Object.freeze([
  ['all', '전체'], ['new', '신규(7일)'], ['grow', '증가(7일)'], ['shrink', '감소(7일)'], ['removed', '사라짐(7일)'],
]);
export const PAGE_SIZE = 50;

/** 표 아래 문구 — 표시 범위와 남은 행. */
export function usersFootNote(res, shownCount) {
  if (!res || res.state !== 'ok') return '';
  const total = numOrNull(res.total) || 0;
  const from = (numOrNull(res.offset) || 0) + 1;
  const to = (numOrNull(res.offset) || 0) + (numOrNull(shownCount) || 0);
  if (!total) return '조건에 맞는 폴더가 없습니다.';
  const rest = Math.max(0, total - to);
  return `${countText(total)}개 중 ${countText(from)}–${countText(to)}${rest ? ` · 나머지 ${countText(rest)}개는 다음 쪽이나 검색으로 엽니다` : ''}.`;
}

/* ─────────────── 설정 폼 ─────────────── */

export const INTERVAL_CHOICES = Object.freeze([6, 12, 24, 48, 168]);
export const TIMEOUT_CHOICES = Object.freeze([10, 20, 30, 60, 90, 120]);

export function blankTarget() {
  return { id: '', label: '', deviceId: '', host: '', port: '', username: '', auth: 'key', path: '/ifs/data/workspace/users', sizeMode: 'h', intervalHours: 24, timeoutMin: 30, topN: 10, enabled: true, agent: '', datacenterId: '', runVia: 'device' };
}

/** 서버 설정의 대상 → 폼(숫자는 그대로, 없으면 빈 칸). */
export function formFromTarget(t) {
  const b = blankTarget();
  if (!t) return b;
  const keep = (v) => (v == null ? '' : v);
  return {
    ...b, id: t.id || '', label: t.label || '', deviceId: t.deviceId || '', host: t.host || '', port: keep(t.port), username: t.username || '',
    auth: t.auth === 'device' ? 'device' : 'key', path: t.path || '', sizeMode: t.sizeMode === 'k' ? 'k' : 'h',
    intervalHours: keep(t.intervalHours), timeoutMin: keep(t.timeoutMin), topN: keep(t.topN), enabled: t.enabled !== false,
    agent: t.agent || '', datacenterId: t.datacenterId || '', runVia: t.runVia === 'node' ? 'node' : 'device',
  };
}

/**
 * 폼 → 저장 본문의 대상 하나. 숫자 칸의 빈 값은 **보내지 않는다**(서버가 이전 값·기본값을 쓴다 — '빈 칸 = 0' 금지).
 * 등록부 장비를 고르면 주소·엣지·DataCenter 는 등록부가 정하므로 싣지 않는다.
 */
export function targetBody(f) {
  const out = { label: String(f.label || '').trim(), path: String(f.path || '').trim(), sizeMode: f.sizeMode === 'k' ? 'k' : 'h', auth: f.auth === 'device' ? 'device' : 'key', enabled: f.enabled !== false };
  if (f.id) out.id = f.id;
  for (const k of ['port', 'intervalHours', 'timeoutMin', 'topN']) {
    const n = numOrNull(f[k]);
    if (n != null) out[k] = n;
  }
  const user = String(f.username || '').trim();
  if (f.deviceId) {
    out.deviceId = f.deviceId; if (user) out.username = user;
    // v2.736 실행 노드 — 'device'(장비 담당 노드를 따른다) 면 고른 엣지를 싣지 않는다(서버도 저장하지 않는다).
    out.runVia = f.runVia === 'node' ? 'node' : 'device';
    if (out.runVia === 'node') out.agent = f.agent || '';
  } else {
    out.host = String(f.host || '').trim(); out.username = user; out.agent = f.agent || ''; out.datacenterId = f.datacenterId || '';
  }
  return out;
}

/** 실행 노드 Select 의 '장비 담당 노드 따름' 값(엣지 이름과 겹치지 않는 표지). */
export const RUN_FOLLOW = '__device__';
/** 폼 → 실행 노드 Select 값. */
export function runSelectValue(f) { return f?.deviceId && f.runVia !== 'node' ? RUN_FOLLOW : (f?.agent || ''); }
/** 실행 노드 Select 값 → 폼 패치. */
export function runSelectPatch(v) { return v === RUN_FOLLOW ? { runVia: 'device', agent: '' } : { runVia: 'node', agent: v || '' }; }
/** 폼이 실제로 실행될 노드 이름('' = 메인). 장비 담당 노드를 따르면 등록부 값. */
export function formRunNode(f, dev) {
  if (!f) return '';
  if (f.deviceId && f.runVia !== 'node') return dev?.agent || '';
  return f.agent || '';
}
/** 등록부 계정 인증은 장비 담당 노드나 메인에서만(다른 엣지의 스토리지 등록부에는 그 계정이 없다) — 서버 normalizeTarget 과 같은 판정. */
export function deviceAuthIssue(f, dev) {
  if (!f?.deviceId || f.auth !== 'device' || f.runVia !== 'node') return null;
  const a = String(f.agent || '').trim().toLowerCase();
  if (!a || !dev || a === String(dev.agent || '').trim().toLowerCase()) return null;
  return `엣지 ‘${f.agent}’ 의 스토리지 등록부에는 이 장비 계정이 없습니다 — SSH 키 인증으로 바꾸거나 실행 노드를 장비 담당 노드(${dev.agent ? `엣지 ‘${dev.agent}’` : '메인'})나 메인으로 두세요.`;
}

/** 폼의 장비 선택지 라벨. */
export function deviceLabel(d, dcName = (id) => id) {
  if (!d) return '';
  const where = d.agent ? `엣지 ${d.agent}` : '메인 수집';
  const dc = d.datacenterId ? ` · ${dcName(d.datacenterId)}` : '';
  return `${d.name || d.host}${dc} · ${where}${d.enabled === false ? ' · 비활성' : ''}`;
}

/** 대상 칩 라벨(법인·장비·경로·노드). */
export function targetChip(t) {
  return {
    corp: t.corp || (t.datacenterId || ''),
    device: t.deviceName || t.host || '—',
    path: t.path || '',
    node: `${nodeText(t.agent)}${t.agentSource === 'override' ? ' · 지정' : ''}`,
    label: t.label || t.deviceName || t.host || t.id,
  };
}
