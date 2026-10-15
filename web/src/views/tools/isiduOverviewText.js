/**
 * isiduOverviewText.js — '아이실론 디렉터리 사용량' 서브메뉴(v2.739: 서머리 · 법인 현황 · 수집 상태 · 전 법인 Top 10)의 계산(순수 — 테스트가 고정한다).
 *
 * 사용자 요청: "법인 상황이 세로로 나와서 보기 불편해 … 서브 메뉴를 만들어서 서머리 1페이지, 법인 현황 1페이지, 수집상태 1페이지,
 *   모든 법인의 사용량 top 10". 배치는 승인된 시안(Claude Design '아이실론 디렉터리 사용량 서브메뉴 시안' 4장)을 따른다.
 *
 * 규칙:
 *  · 대상 상태 판정은 isiduText.targetStatus 하나다(여기서 다시 판정하지 않는다).
 *  · 합계는 성공한 수집이 있는 대상만 더하고 뺀 개수를 함께 준다(부분 합을 전체라 말하지 않는다).
 *  · 7일 변화 합은 7일 전 수집이 있는 대상만 더한다(기준이 없는 대상을 0 으로 세지 않는다). -h 반올림 해상도 안의 차이(withinRes)는
 *    카드가 '변화 없음' 이라 말하므로 합계에서도 0 으로 센다 — 더한 값이 전부 해상도 안이면 합도 '변화 없음' 이다.
 *  · 전 법인 Top 10 은 서버가 대상마다 준 상위 10 의 합집합에서 고른다 — 고른 법인들의 상위 10 은 언제나 그 안에 있다.
 *    순서는 서버 parse.sortBySize 와 같다(크기 내림차순 → 이름 localeCompare). 대상마다 수집 시각이 다르다는 사실을 말한다.
 *  · 못 읽은 값은 null(화면 '—'). 0 으로 채우지 않는다.
 */
import { numOrNull } from '../../numOrNull.js';
import { targetStatus, targetBytesOf, corpOverview, targetChip, pollStopped, countText } from './isiduText.js';
import { agoText } from './relTime.js';

const MIN = 60_000;
const HOUR = 3_600_000;

/** 서브메뉴 — 주소 `#/tools/isilon-dirusage/<키>`. 대상 화면은 `t/<id>` 그대로다. */
// v2.740(사용자 요청 "서머리를 없애고, 법인 현황을 첫 탭으로 … 전 법인 Top 10 을 두번째 … 수집 상태를 3번째"): 서머리 탭은 없다.
//   첫 화면은 법인 현황이고, 옛 주소 `…/summary` 도 법인 현황으로 연다(북마크가 빈 화면이 되지 않게).
export const SUBVIEWS = Object.freeze([
  ['corps', '법인 현황'], ['top10', '전 법인 Top 10'], ['status', '수집 상태'],
]);
export const SUBVIEW_KEYS = Object.freeze(SUBVIEWS.map(([k]) => k));
export const DEFAULT_SUBVIEW = 'corps';

/**
 * 주소 조각 → 화면. segs = hashSegments(hash). 이 도구 주소가 아니면 null.
 * @returns {{view:string, targetId:string}|null}
 */
export function viewOfSegs(segs, base = ['tools', 'isilon-dirusage']) {
  const s = Array.isArray(segs) ? segs : [];
  if (s[0] !== base[0] || s[1] !== base[1]) return null;
  if (s[2] === 't') {
    if (!s[3]) return { view: 'target', targetId: '' };
    // v2.741 RECENT-02: 잘못된 % 조각(손으로 고쳤거나 잘린 링크 — `#/…/t/%`)은 decodeURIComponent 가 URIError 를 던진다.
    // 렌더 중(useState 초기화)에 던지면 특수 기능 탭 전체가 오류 화면이 되므로, 다른 잘못된 조각처럼 첫 화면(법인 현황)으로 연다.
    try { return { view: 'target', targetId: decodeURIComponent(s[3]) }; } catch { return { view: DEFAULT_SUBVIEW, targetId: '' }; }
  }
  return { view: SUBVIEW_KEYS.includes(s[2]) ? s[2] : DEFAULT_SUBVIEW, targetId: '' };
}

/** 화면 → 주소. */
export function hashOfView(view, targetId = '', base = ['tools', 'isilon-dirusage']) {
  if (view === 'target' && targetId) return `#/${base.join('/')}/t/${encodeURIComponent(targetId)}`;
  return `#/${base.join('/')}/${SUBVIEW_KEYS.includes(view) ? view : DEFAULT_SUBVIEW}`;
}

/** 상태 묶음(수집 상태 칸 · 필터 칩). targetStatus 의 tone 으로 묶는다 — 합 = 대상 수. */
export const STATUS_GROUPS = Object.freeze([
  ['ok', '정상'], ['warn', '주의'], ['run', '진행 중'], ['bad', '실패'], ['muted', '꺼짐 · 수집 전'],
]);
const GROUP_RANK = { bad: 0, warn: 1, run: 2, muted: 3, ok: 4 };

export function statusCounts(targets, now = Date.now()) {
  const out = { ok: 0, warn: 0, run: 0, bad: 0, muted: 0, total: 0 };
  for (const t of Array.isArray(targets) ? targets : []) {
    if (!t) continue;
    const tone = targetStatus(t, now).tone;
    out[tone in out ? tone : 'muted']++;
    out.total++;
  }
  return out;
}

/**
 * 진행 막대 — 조사 중(또는 엣지가 요청을 가져감)인 대상의 경과 / 시한. 시작 시각을 모르면 null.
 * 엣지가 가져간 요청은 가져간 시각(takenAt)부터 센다. 시한은 대상 설정(분)이고 모르면 120분(서버 기본값).
 */
export function progressOf(t, now = Date.now()) {
  if (!t) return null;
  const since = numOrNull(t.running?.since) ?? (t.request?.state === 'taken' ? numOrNull(t.request?.takenAt) : null);
  if (since == null) return null;
  const limitMs = (numOrNull(t.timeoutMin) || 120) * MIN;
  const elapsedMs = Math.max(0, now - since);
  return { since, elapsedMs, limitMs, pct: Math.max(0, Math.min(1, elapsedMs / limitMs)), over: elapsedMs > limitMs };
}

/** v2.741 DEV-05: 이만큼 넘게 돈 실패는 1시간이 아니라 주기만큼 쉰다 — 서버 poller.LONG_FAIL_MS 와 같은 값(목록 응답 failLongMs). */
export const LONG_FAIL_MS = 30 * MIN;

/** 오래 돈 실패인가(서버 poller.isLongFailure 와 같은 판정 — 소요 시간을 모르면 아니다). */
export function isLongFailure(lt, longFailMs = LONG_FAIL_MS) {
  if (!lt || lt.ok) return false;
  const d = numOrNull(lt.durationMs);
  return d != null && d >= (numOrNull(longFailMs) || LONG_FAIL_MS);
}

/**
 * 다음 주기 수집 예상 시각(서버 poller.isDue 와 같은 규칙 — 성공 뒤는 주기, 실패 뒤는 min(주기, 재시도 간격),
 * v2.741 DEV-05: 오래 돈 실패(시한·출력 상한에 걸린 du) 뒤는 주기).
 * 꺼짐·장비 비활성·조사 중이면 null. 기록이 없거나 '지금 수집' 대기열에 있으면 'soon'. 엣지 담당은 그 엣지의 폴러가 같은 규칙으로 돈다 — 추정이다.
 * @returns {number|'soon'|null}
 */
export function nextRunOf(t, failRetryMs = HOUR, now = Date.now(), longFailMs = LONG_FAIL_MS) {
  if (!t || t.enabled === false || t.deviceDisabled || t.issue || t.running) return null;
  if (t.queued) return 'soon';
  const lt = t.lastTry;
  if (!lt || numOrNull(lt.ts) == null) return 'soon';
  const iv = Math.max(1, numOrNull(t.intervalHours) || 24) * HOUR;
  const wait = lt.ok || isLongFailure(lt, longFailMs) ? iv : Math.min(iv, numOrNull(failRetryMs) || HOUR);
  const at = lt.ts + wait;
  return at <= now ? 'soon' : at;
}

/**
 * v2.741 TIMING-02: '지금 수집' 응답에서 동시 실행 상한 때문에 바로 시작하지 않은 대상 — 조용히 빼지 않는다.
 * 없으면 ''.
 */
export function runQueueNote(r) {
  const n = Array.isArray(r?.queued) ? r.queued.length : 0;
  if (!n) return '';
  const c = numOrNull(r?.concurrency);
  return `동시 실행 상한${c ? `(${c}개)` : ''} 때문에 ${n}개는 대기열에 넣었습니다 — 앞 조사가 끝나면 차례로 시작합니다(장비에 du 를 한꺼번에 돌리지 않습니다).`;
}

/* ─────────────── 개요 응답 상태(v2.740 감사 D-02) ───────────────
 * 개요(`/overview`)를 받지 못한 것을 '수집 없음' · '관측 짧음' · '불러오는 중' 으로 말하지 않는다. 대상 목록(상태·크기 합)은 목록 응답이라
 * 그대로 보이고, 7일 변화·30일 추이·상위 폴더 칸만 '개요를 읽지 못했습니다' 로 말한다. 실패하면 백오프로 다시 묻는다(403·404 는 멈춘다). */

/** 개요를 못 받은 칸의 공통 문구. */
export const OV_UNREAD = '개요를 읽지 못했습니다';

/** useOverview 결과 → 'ok'(받음) · 'stale'(직전 값 — 새로 못 읽음) · 'loading'(받는 중) · 'unread'(받지 못함). */
export function ovStatus(ov) {
  if (ov && ov.data) return ov.error ? 'stale' : 'ok';
  return ov && ov.error ? 'unread' : 'loading';
}

/** 실패 뒤 다시 묻는 간격(ms) — 15초 → 30초 → 60초(그 뒤 60초). */
export const OV_RETRY_MS = Object.freeze([15_000, 30_000, 60_000]);

/** n 번째(0부터) 연속 실패 뒤 다시 물을 간격. 다시 물어도 같은 실패(403·404)면 null. */
export function ovRetryDelay(err, fails = 0) {
  if (pollStopped(err)) return null;
  const n = Math.max(0, Math.floor(numOrNull(fails) ?? 0));
  return OV_RETRY_MS[Math.min(n, OV_RETRY_MS.length - 1)];
}

/** 서브메뉴 위 배너 — 못 읽음 · 직전 값. 받았거나 받는 중이면 null. */
export function ovBanner(ov) {
  const st = ovStatus(ov);
  if (st !== 'unread' && st !== 'stale') return null;
  const e = ov.error;
  const msg = String(e?.message || e);
  const retry = ovRetryDelay(e) != null
    ? '잠시 뒤 다시 시도합니다.'
    : `${e?.status === 403 ? '권한이 없어(403)' : '이 서버에 개요 기능이 없어(404 — 구버전일 수 있습니다)'} 다시 시도하지 않습니다.`;
  if (st === 'unread') return { tone: 'amber', text: `7일 변화·추이·상위 폴더를 읽지 못했습니다 — ${msg} 대상 목록은 그대로 보입니다. ${retry}` };
  return { tone: 'amber', text: `7일 변화·추이·상위 폴더를 새로 읽지 못했습니다 — 아래는 직전에 받은 값입니다. ${retry} (${msg})` };
}

/** 서머리 '7일 변화 합' 부제. */
export function summaryDelta7Sub(T, ovSt) {
  if (ovSt === 'loading') return '불러오는 중…';
  if (ovSt === 'unread') return `${OV_UNREAD} — 7일 변화를 모릅니다`;
  if (!T || T.delta7 == null) return '7일 전 수집이 있는 대상이 없습니다';
  return `7일 전 수집이 있는 대상 ${countText(T.delta7Targets)}개 기준${T.delta7WithinCount ? ` · 반올림 해상도 안의 차이 ${countText(T.delta7WithinCount)}개는 0 으로 셉니다` : ''}`;
}

/** 전 법인 상위(서머리 5 · Top 10) 표가 비었을 때 문구. */
export function topEmptyText(ovSt, { picked = false } = {}) {
  if (ovSt === 'loading') return '불러오는 중…';
  if (ovSt === 'unread') return `${OV_UNREAD} — 순위를 만들지 못했습니다(수집이 없다는 뜻이 아닙니다).`;
  return picked ? '고른 법인에 성공한 수집이 있는 대상이 없습니다.' : '성공한 수집이 있는 대상이 없습니다.';
}

/** 법인 현황 카드의 상위 폴더(top3)·30일 추이(trend) 칸이 비었을 때 문구. */
export function cardOvText(kind, ovSt) {
  const what = kind === 'trend' ? '30일 추이' : '상위 폴더';
  if (ovSt === 'loading') return `${what} 불러오는 중…`;
  if (ovSt === 'unread') return `${what}를 읽지 못했습니다(개요 조회 실패)`;
  return `${what} 없음`;
}

/** 대상 개요 행을 id 로. */
export function overviewIndex(ov) {
  const m = new Map();
  for (const x of Array.isArray(ov?.targets) ? ov.targets : []) if (x && x.id) m.set(x.id, x);
  return m;
}

/**
 * 서머리(순수).
 * @param targets 목록 응답의 대상
 * @param ovById overviewIndex 결과(없으면 빈 Map — 7일 변화·상위 5 는 null/[])
 */
export function summaryModel(targets, ovById = new Map(), now = Date.now()) {
  const list = Array.isArray(targets) ? targets.filter(Boolean) : [];
  const co = corpOverview(list, now);
  let d7 = 0; let d7n = 0; let d7in = 0;
  const corps = co.groups.map((g) => {
    let gd = 0; let gn = 0; let gin = 0;
    for (const it of g.items) {
      const ov = ovById.get(it.t.id);
      const d = numOrNull(ov?.totalDelta7?.bytes);
      if (ov?.state !== 'ok' || d == null) continue;
      gn++;
      // -h 반올림 해상도 안의 차이는 '변화 없음'(카드와 같은 판정) — 합계에서도 0 으로 센다. 그대로 더하면 반올림 한 칸(예 0.1T)이 변화로 보인다.
      if (ov.totalDelta7.withinRes === true) gin++; else gd += d;
    }
    if (gn) { d7 += gd; d7n += gn; d7in += gin; }
    const unread = g.items.filter((x) => x.bytes == null);
    return {
      corp: g.corp, label: g.label, worst: g.worst, targets: g.items.length, users: g.users, bytes: g.bytes,
      share: co.totals.bytes && g.bytes != null ? g.bytes / co.totals.bytes : null,
      delta7: gn ? gd : null, delta7Within: gn > 0 && gin === gn, delta7Partial: gn > 0 && gn < g.measured,
      lastOk: Math.max(0, ...g.items.map((x) => numOrNull(x.t.okScan?.ts) || 0)) || null,
      errLines: g.items.reduce((s, x) => s + (numOrNull(x.t.okScan?.errLines) || 0), 0),
      unread: unread.map((x) => ({ id: x.t.id, st: x.st })),
    };
  }).sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || String(a.label).localeCompare(String(b.label)));
  const counts = statusCounts(list, now);
  const watch = list.map((t) => ({ t, st: targetStatus(t, now) }))
    .filter((x) => x.st.tone !== 'ok')
    .sort((a, b) => (GROUP_RANK[a.st.tone] ?? 3) - (GROUP_RANK[b.st.tone] ?? 3) || String(a.t.label || a.t.id).localeCompare(String(b.t.label || b.t.id)))
    .map((x) => ({ ...x, prog: progressOf(x.t, now) }));
  const measured = list.filter((t) => targetBytesOf(t) != null).length;
  return {
    totals: { ...co.totals, measured, delta7: d7n ? d7 : null, delta7Within: d7n > 0 && d7in === d7n, delta7WithinCount: d7in, delta7Targets: [...ovById.values()].filter((o) => o?.state === 'ok' && numOrNull(o.totalDelta7?.bytes) != null && list.some((t) => t.id === o.id)).length },
    corps, counts, watch,
  };
}

/**
 * 전 법인 Top N(순수) — 고른 법인(없으면 전부)의 대상마다 상위 폴더를 모아 크기 순으로.
 * @param targets 목록 응답의 대상(법인·장비 이름)
 * @param ovById overviewIndex 결과
 * @param opts.corps 고른 법인 이름 Set(비어 있으면 전부) · opts.n 몇 개
 */
export function crossTop(targets, ovById = new Map(), { corps = null, n = 10, unread = false } = {}) {
  const pick = corps && corps.size ? corps : null;
  const rows = []; const included = []; const excluded = [];
  let base = 0;
  for (const t of Array.isArray(targets) ? targets : []) {
    if (!t) continue;
    const corp = String(t.corp || t.datacenterId || '').trim();
    if (pick && !pick.has(corp || '')) continue;
    const ov = ovById.get(t.id);
    // 개요를 받지 못했으면(unread) 그 대상은 '결과 없음' 이 아니라 '개요 못 읽음' 이다(D-02).
    if (!ov || ov.state !== 'ok') { excluded.push({ id: t.id, corp, state: ov?.state || (unread ? 'overview-unread' : 'loading') }); continue; }
    included.push(t.id);
    const denom = numOrNull(ov.scan?.denom);
    if (denom != null) base += denom;
    const c = targetChip(t);
    for (const u of ov.top || []) {
      rows.push({
        key: `${t.id}/${u.name}`, targetId: t.id, corp: corp || '', corpLabel: corp || '법인 미지정', device: c.device, label: t.label || '', path: ov.scan?.path || t.path || '',
        name: u.name, bytes: numOrNull(u.bytes), res: numOrNull(u.res), share: numOrNull(u.share), d7: u.d7 ?? null, new7: u.new7 ?? null,
        hasBase: !!ov.base7, scanTs: numOrNull(ov.scan?.ts), sizeMode: ov.scan?.sizeMode || 'h',
      });
    }
  }
  rows.sort((a, b) => ((b.bytes ?? -1) - (a.bytes ?? -1)) || String(a.name).localeCompare(String(b.name)) || String(a.targetId).localeCompare(String(b.targetId)));
  const top = rows.slice(0, Math.max(1, numOrNull(n) || 10)).map((r, i) => ({ ...r, rank: i + 1 }));
  const sum = top.reduce((s, r) => s + (r.bytes || 0), 0);
  const ts = top.map((r) => r.scanTs).filter((x) => x != null);
  return {
    top, sum: top.length ? sum : null, base: included.length ? base : null,
    share: included.length && base > 0 ? sum / base : null,
    included, excluded,
    oldestTs: ts.length ? Math.min(...ts) : null, newestTs: ts.length ? Math.max(...ts) : null,
    approx: top.some((r) => r.sizeMode !== 'k'),
  };
}

/** 상위 표에서 빠진 대상 중 '결과 없음'(개요는 받았는데 성공한 수집이 없음)만 센다 — 개요 못 읽음·받는 중은 세지 않는다. */
export function noResultCount(r) {
  return (r?.excluded || []).filter((x) => x && x.state !== 'overview-unread' && x.state !== 'loading').length;
}

/** 고를 수 있는 법인(전 법인 Top 10 칩) — 결과가 없는 법인은 고를 수 없음 표시. 개요를 못 읽었으면(unread) 결과 유무를 모른다(unknown). */
export function corpChoices(targets, ovById = new Map(), { unread = false } = {}) {
  const m = new Map();
  for (const t of Array.isArray(targets) ? targets : []) {
    if (!t) continue;
    const corp = String(t.corp || t.datacenterId || '').trim();
    if (!m.has(corp)) m.set(corp, { corp, label: corp || '법인 미지정', targets: 0, withData: 0, unknown: !!unread });
    const g = m.get(corp);
    g.targets++;
    if (ovById.get(t.id)?.state === 'ok') g.withData++;
  }
  return [...m.values()].sort((a, b) => (a.corp ? 0 : 1) - (b.corp ? 0 : 1) || a.label.localeCompare(b.label, 'ko', { numeric: true }));
}

/** 법인 칩 표시 — 결과 없음은 잠근다. 개요를 못 읽어 모르는 칩은 잠그지 않는다(고르면 표가 '개요를 읽지 못했습니다' 라 말한다). */
export function corpChipView(c) {
  if (c?.unknown) return { disabled: false, suffix: '', title: `${OV_UNREAD} — 이 법인의 결과 유무를 모릅니다(대상 ${c.targets}개)` };
  if (!c?.withData) return { disabled: true, suffix: ' · 결과 없음', title: '이 법인은 아직 성공한 수집이 없습니다' };
  return { disabled: false, suffix: '', title: `대상 ${c.targets}개` };
}

/** 법인 현황 정렬. */
export const CORP_SORTS = Object.freeze([['size', '크기 큰 순'], ['d7', '7일 증가 큰 순'], ['status', '상태(문제 먼저)'], ['name', '이름 순']]);

/**
 * 법인 현황 카드(순수) — 대상 하나 = 카드 하나.
 * @returns {{t, st, chip, users, bytes, d7, hasBase, okTs, points, top3, prog}[]}
 */
export function corpCards(targets, ovById = new Map(), now = Date.now(), sort = 'size', { unread = false } = {}) {
  const cards = (Array.isArray(targets) ? targets : []).filter(Boolean).map((t) => {
    const ov = ovById.get(t.id);
    const ok = ov?.state === 'ok';
    return {
      ovUnread: !!unread && !ov,
      t, st: targetStatus(t, now), chip: targetChip(t),
      corp: String(t.corp || t.datacenterId || '').trim(),
      users: numOrNull(t.okScan?.count), bytes: targetBytesOf(t),
      d7: ok ? (ov.totalDelta7 ?? null) : null, hasBase: ok && !!ov.base7,
      okTs: numOrNull(t.okScan?.ts), points: ok ? (ov.points || []) : [], top3: ok ? (ov.top || []).slice(0, 3) : [],
      prog: progressOf(t, now),
    };
  });
  const name = (c) => String(c.corp || '~') + String(c.t.label || c.t.id);
  const cmp = {
    size: (a, b) => (b.bytes ?? -1) - (a.bytes ?? -1),
    d7: (a, b) => (numOrNull(b.d7?.bytes) ?? -Infinity) - (numOrNull(a.d7?.bytes) ?? -Infinity),
    status: (a, b) => (GROUP_RANK[a.st.tone] ?? 3) - (GROUP_RANK[b.st.tone] ?? 3),
    name: () => 0,
  }[sort] || (() => 0);
  return cards.sort((a, b) => cmp(a, b) || name(a).localeCompare(name(b), 'ko', { numeric: true }));
}

/** 미니 추이 선(카드) — 값 범위가 작으면 넓혀서 잔물결을 급경사로 보이지 않게(v2.670 규칙). */
export function miniLine(points, w = 220, h = 44, pad = 3) {
  const vs = (Array.isArray(points) ? points : []).map((p) => ({ ts: numOrNull(p?.ts), v: numOrNull(p?.bytes), partial: !!p?.partial })).filter((p) => p.ts != null && p.v != null);
  if (!vs.length) return { d: '', dots: [], last: null };
  const t0 = vs[0].ts; const t1 = vs[vs.length - 1].ts;
  let lo = Math.min(...vs.map((p) => p.v)); let hi = Math.max(...vs.map((p) => p.v));
  const mid = (lo + hi) / 2;
  const span = Math.max(hi - lo, Math.abs(mid) * 0.05, 1);
  lo = mid - span / 2; hi = mid + span / 2;
  const x = (ts) => (t1 > t0 ? pad + ((ts - t0) / (t1 - t0)) * (w - pad * 2) : w / 2);
  const y = (v) => pad + (1 - (v - lo) / (hi - lo)) * (h - pad * 2);
  const pts = vs.map((p) => ({ x: Math.round(x(p.ts) * 10) / 10, y: Math.round(y(p.v) * 10) / 10, partial: p.partial }));
  return {
    d: pts.length > 1 ? `M${pts.map((p) => `${p.x},${p.y}`).join(' L')}` : '',
    dots: pts.length === 1 ? pts : pts.filter((p) => p.partial),
    last: pts[pts.length - 1],
  };
}

/** 앞으로의 시각 → '약 N분 뒤' · '약 N시간 뒤'(지난 시각·모름은 ''). */
export function aheadText(ts, now = Date.now()) {
  const t = numOrNull(ts);
  if (t == null || t <= now) return '';
  const m = Math.max(1, Math.round((t - now) / MIN));
  if (m < 60) return `약 ${m}분 뒤`;
  const h = (t - now) / HOUR;
  return `약 ${h < 10 ? Math.round(h * 10) / 10 : Math.round(h)}시간 뒤`;
}

/** 수집 상태 표의 '진행 · 마지막 시도' 칸(순수). */
export function attemptText(t, now = Date.now()) {
  const p = progressOf(t, now);
  if (p) {
    const min = Math.round(p.elapsedMs / MIN);
    const lim = Math.round(p.limitMs / MIN);
    return { text: `${min < 60 ? `${min}분` : `${Math.floor(min / 60)}시간 ${min % 60}분`}째 · 시한 ${lim}분`, prog: p };
  }
  if (t?.queued) return { text: `대기 중 · 동시 실행 상한(앞 조사가 끝나면 시작)${numOrNull(t.queued.since) != null ? ` · ${agoText(t.queued.since, now)} 요청` : ''}`, prog: null };
  const lt = t?.lastTry;
  if (!lt || numOrNull(lt.ts) == null) return { text: '시도 기록 없음', prog: null };
  return { text: `${lt.ok ? '성공' : '실패'} · ${agoText(lt.ts, now)}${isLongFailure(lt) ? ' · 오래 걸린 실패라 주기 뒤에 다시 시도' : ''}`, prog: null };
}
