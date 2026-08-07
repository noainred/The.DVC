/**
 * 성능점검 엣지 위임 — 중앙 측 수신 저장소 (RMA Active 방식).
 *
 * 원격 법인의 엣지 노드가 자기 대역을 로컬에서 점검하고 결과를 중앙으로 **밀어 올린다**.
 * 중앙은 그 대상을 직접 찌르지 않으므로 고RTT(폴란드·미국동부 800ms+)가 응답시간 판정을
 * 오염시키지 않는다. 통신은 엣지→중앙 단방향 아웃바운드라 NAT·폐쇄망도 커버한다.
 *
 * 왜 pull(중앙이 끌어오기)이 아닌가 — 조사에서 확인한 것들:
 *  - pull 경로의 공유 `COLLECTOR_TOKEN` 은 기본 구성에서 `CENTRAL_TOKEN` 과 같은 값이 된다
 *    (config.js). 하나가 새면 전 엣지가 열린다. push 는 엣지별 개별 토큰을 쓴다.
 *  - 기존 pull 응답에는 `generatedAt` 이 들어 있어 본문 SHA-1 ETag 가 매번 달라진다 →
 *    **304 가 성립한 적이 없다.** 무변동에도 전량이 WAN 을 탄다.
 *  - pull 은 중앙에 인바운드를 요구한다(대체 불가한 약점).
 *
 * ## 저장 구조
 * agent 별 **중첩 Map**. `agent::testId` 로 키를 이어붙이지 않는다 — 엣지 간 testId 충돌
 * (8자 난수, 10만 항목에서 기대 1.2건)을 원리적으로 없애고, 구분자로 NUL 을 쓰는 회피책도
 * 필요 없다.
 *
 * ## 시각은 중앙 시계가 진실
 * 엣지는 절대 시각을 보내지 않고 **구간값**(`a` = 직렬화 시점 − 측정 시점)만 보낸다.
 * 중앙이 `measuredAt = 수신시각 − a` 로 환산하므로 엣지 시계가 틀려도 판정이 흔들리지 않는다.
 *
 * ## R1 은 디스크에 쓰지 않는다
 * 30엣지 × 5,000행 ≈ 48MB. `JSON.stringify` 는 동기라(21MB=34ms 실측) 5초 디바운스로
 * 반복하면 그 자체가 이벤트 루프를 먹는다. 대가는 **중앙 재시작 후 최대 1 push 주기 동안
 * 전 엣지가 `unknown`** 이다. '오래된 정상을 초록으로 보여주기'보다 unknown 이 안전하다는
 * 판단이며, 이는 되짚어볼 수 있는 설계 선택이다(원격 인벤토리 캐시도 같은 선택을 했다).
 */

import { logAudit } from '../audit.js';

const envNum = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? Math.round(n) : d; };

export const MAX_AGENTS = envNum('SVCMON_EDGE_MAX_AGENTS', 64);
export const MAX_ROWS_PER_AGENT = envNum('SVCMON_EDGE_MAX_ROWS', 20000);
/** 시계 오차 경고 임계 — 넘어도 결과를 버리지 않는다(경고만). */
export const SKEW_WARN_MS = envNum('SVCMON_EDGE_SKEW_WARN_MS', 60_000);
/** 무보고 판정 = max(3 × 엣지가 알려준 예상 간격, 이 하한). */
export const SILENCE_MIN_MS = envNum('SVCMON_EDGE_SILENCE_MIN_MS', 300_000);
const REPLY_MAX = 200;             // 응답 문자열 상한(엣지도 자르지만 중앙에서 한 번 더)
const STATES = new Set(['ok', 'warn', 'bad']);

let agents = Object.create(null);   // null-proto: agent 이름이 '__proto__' 여도 프로토타입 오염 없음

const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function blank(agent) {
  return {
    agent,
    firstAt: 0,
    lastAt: 0,
    lastSnapId: 0,
    prevCompleteSnapId: 0,   // 직전에 완결된 스냅샷 — GC 가 '한 세대 전'까지 허용하는 기준
    lastSeq: 0,
    lastTotal: 0,
    complete: false,
    expectMs: 60_000,
    skewMs: 0,
    items: 0,
    reported: 0,
    poller: null,
    caps: null,
    log: null,
    metaSig: '',
    rows: new Map(),      // edgeTestId -> { s, r, m, k, measuredAt, snapId }
    meta: new Map(),      // edgeTestId -> { p, n, h, t, y, iv }
    counters: { accepted: 0, dropped: 0, overflow: 0, badRow: 0, chunks: 0, snapshots: 0 },
    silent: null,         // svcmonSilence 가 관리(전환 알림용)
  };
}

/**
 * 엣지 보고 1청크 수신.
 *
 * @param {string} agent  **반드시 토큰에서 해석한 이름**(본문 값이 아니다). 라우트가 보장한다.
 * @param {object} body
 * @param {number} recvAt 중앙 시계 수신 시각
 * @returns {{ok:boolean, needMeta:boolean, accepted:number, dropped:number, reason?:string}}
 */
export function ingestReport(agent, body, recvAt = Date.now()) {
  const name = String(agent || '').trim();
  if (!name) return { ok: false, needMeta: false, accepted: 0, dropped: 0, reason: 'agent 를 해석할 수 없습니다.' };
  if (!agents[name] && Object.keys(agents).length >= MAX_AGENTS) {
    return { ok: false, needMeta: false, accepted: 0, dropped: 0, reason: `엣지 수 상한(${MAX_AGENTS}) 초과 — SVCMON_EDGE_MAX_AGENTS 를 조정하세요.` };
  }
  const a = agents[name] || (agents[name] = blank(name));
  if (!a.firstAt) a.firstAt = recvAt;

  const snapId = num(body?.snapId) || recvAt;
  const seq = Math.max(1, num(body?.seq) || 1);
  const total = Math.max(seq, num(body?.total) || 1);
  const sentAt = num(body?.sentAt);

  // 새 스냅샷이 시작되면 이전 스냅샷의 완결 상태를 닫는다.
  if (snapId !== a.lastSnapId) {
    a.complete = false;
    a.counters.snapshots += 1;
  }
  a.lastSnapId = snapId;
  a.lastSeq = seq;
  a.lastTotal = total;
  a.lastAt = recvAt;
  a.counters.chunks += 1;
  if (sentAt) a.skewMs = recvAt - sentAt;   // 편도 지연 포함 → 오차의 상한 추정치
  if (Number.isFinite(Number(body?.expectMs)) && Number(body.expectMs) > 0) a.expectMs = Number(body.expectMs);
  if (Number.isFinite(Number(body?.items))) a.items = num(body.items);
  if (Number.isFinite(Number(body?.reported))) a.reported = num(body.reported);
  if (body?.poller && typeof body.poller === 'object') a.poller = body.poller;
  if (body?.caps && typeof body.caps === 'object') a.caps = body.caps;
  if (body?.log && typeof body.log === 'object') a.log = body.log;

  let accepted = 0;
  let dropped = 0;
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  for (const r of rows) {
    const id = text(r?.i, 64);
    if (!id) { dropped += 1; a.counters.badRow += 1; continue; }
    if (!a.rows.has(id) && a.rows.size >= MAX_ROWS_PER_AGENT) {
      dropped += 1; a.counters.overflow += 1;
      continue;                                  // 조용히 자르지 않고 카운터·응답으로 알린다
    }
    // 구간값 → 중앙 시계. 음수·24시간 초과는 위조·시계 점프로 보고 수신 시각으로 대체한다.
    const ageMs = Number(r?.a);
    let measuredAt = recvAt;
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 86_400_000) measuredAt = recvAt - ageMs;
    else a.counters.badRow += 1;

    const prev = a.rows.get(id);
    // 재전송·순서 뒤바뀜에 안전하도록 더 최신 측정만 채택한다.
    if (prev && prev.measuredAt > measuredAt) { accepted += 1; continue; }
    a.rows.set(id, {
      s: STATES.has(r?.s) ? r.s : 'bad',
      r: text(r?.r, REPLY_MAX),
      m: num(r?.m),
      k: Math.max(0, num(r?.k)),
      measuredAt,
      snapId,
    });
    accepted += 1;
  }
  a.counters.accepted += accepted;
  a.counters.dropped += dropped;

  // meta 는 요청했을 때만 온다(내부 구성 정보를 상시 WAN 에 태우지 않는다).
  const meta = Array.isArray(body?.meta) ? body.meta : null;
  if (meta) {
    for (const m of meta) {
      const id = text(m?.i, 64);
      if (!id) continue;
      a.meta.set(id, {
        p: text(m?.p, 620), n: text(m?.n, 120), h: text(m?.h, 253),
        t: text(m?.t, 80), y: text(m?.y, 16), iv: num(m?.iv) || 60,
      });
    }
    a.metaSig = text(body?.metaSig, 64);
  }

  // 스냅샷 완결: 마지막 청크를 받으면 이번/직전 완결 스냅샷에 속하지 않은 행을 정리한다
  // (엣지에서 삭제된 점검 청소). '직전 완결'까지 허용하는 이유: 청크 하나가 유실되면 그
  // 행들은 이전 스냅샷 값으로 남는데, 즉시 지우면 '모름'이 되고 남기면 다음 완결까지
  // stale 로 보인다 — 후자가 정확한 표현이다.
  // ⚠ snapId 는 시간 기반 큰 수라 `< snapId - 1` 산술 비교는 '직전 스냅샷 허용'이 되지
  //   못한다(사실상 이번 것만 유지). 반드시 **직전 완결 id 를 따로 기억해** 비교한다.
  //   또 snapId 가 역행하는 보고(엣지 재시작·시계 점프·위조)에서는 GC 를 건너뛴다 —
  //   낮은 id 기준으로 지우면 정상 행이 대량 삭제된다.
  if (seq >= total) {
    a.complete = true;
    if (snapId >= a.prevCompleteSnapId) {
      for (const [id, row] of a.rows) {
        if (row.snapId !== snapId && row.snapId !== a.prevCompleteSnapId) a.rows.delete(id);
      }
      for (const id of a.meta.keys()) if (!a.rows.has(id)) a.meta.delete(id);
      a.prevCompleteSnapId = snapId;
    }
  }

  // metaSig 가 중앙 보유분과 다르거나 메타가 비면 다음 push 에 동봉을 요청한다.
  const wantSig = text(body?.metaSig, 64);
  const needMeta = !meta && (!!wantSig && wantSig !== a.metaSig || a.meta.size === 0) && a.rows.size > 0;

  return { ok: true, needMeta, accepted, dropped, reason: dropped ? '일부 행이 상한/형식으로 버려졌습니다.' : undefined };
}

/** 무보고 판정 — 엣지가 알려준 예상 간격에 자동 적응한다(주기를 바꾼 엣지도 커버). */
export function silenceLimitMs(a) {
  return Math.max(SILENCE_MIN_MS, 3 * (a?.expectMs || 60_000));
}
export function isSilent(a, now = Date.now()) {
  return !!a && (now - a.lastAt) > silenceLimitMs(a);
}

/** 엣지 카드 요약 — 화면과 알림이 같은 판정을 쓰게 한다. */
export function edgeSummary(now = Date.now()) {
  const out = [];
  for (const name of Object.keys(agents)) {
    const a = agents[name];
    const silent = isSilent(a, now);
    let ok = 0; let warn = 0; let bad = 0; let stale = 0;
    // 행 신선도: 엣지는 보고 중인데 그 행만 안 도는 경우가 있다(엣지 내부 과부하).
    // 그래서 전량 스냅샷을 받는다 — 델타로는 '여전히 ok' 와 '안 돌았다'를 구별할 수 없다.
    for (const [id, r] of a.rows) {
      const iv = (a.meta.get(id)?.iv || 60) * 1000;
      const limit = Math.max(3 * iv, 5 * (a.expectMs || 60_000));
      if (now - r.measuredAt > limit) { stale += 1; continue; }
      if (r.s === 'ok') ok += 1; else if (r.s === 'warn') warn += 1; else bad += 1;
    }
    const notRun = Math.max(0, (a.items || 0) - (a.reported || 0));
    out.push({
      agent: name,
      silent,
      unknown: silent,                       // 무보고면 그 엣지 전 항목의 현재 상태를 알 수 없다
      lastAt: a.lastAt,
      ageMs: a.lastAt ? now - a.lastAt : null,
      expectMs: a.expectMs,
      silenceLimitMs: silenceLimitMs(a),
      skewMs: a.skewMs,
      skewWarn: Math.abs(a.skewMs) > SKEW_WARN_MS,
      complete: a.complete,
      lastSnapId: a.lastSnapId,
      chunks: `${a.lastSeq}/${a.lastTotal}`,
      items: a.items,
      reported: a.reported,
      notRun,
      rows: a.rows.size,
      hasMeta: a.meta.size > 0,
      counts: silent ? { ok: 0, warn: 0, bad: 0, stale: 0 } : { ok, warn, bad, stale },
      poller: a.poller,
      caps: a.caps,
      log: a.log,
      counters: a.counters,
    });
  }
  return out.sort((x, y) => x.agent.localeCompare(y.agent));
}

/** 엣지 1개의 항목 목록(메타가 있으면 이름·경로까지). limit 로 잘라 응답 크기를 묶는다. */
export function edgeState(agent, { path: scope = '', limit = 500, only = '' } = {}, now = Date.now()) {
  const a = agents[String(agent || '').trim()];
  if (!a) return null;
  const silent = isSilent(a, now);
  const items = [];
  for (const [id, r] of a.rows) {
    const m = a.meta.get(id) || null;
    if (scope && m && !(m.p === scope || String(m.p).startsWith(`${scope}\\`))) continue;
    const iv = (m?.iv || 60) * 1000;
    const limitMs = Math.max(3 * iv, 5 * (a.expectMs || 60_000));
    const stale = now - r.measuredAt > limitMs;
    const state = silent ? 'unknown' : (stale ? 'stale' : r.s);
    if (only && only !== state) continue;
    items.push({
      id,
      state,
      status: r.s,
      reply: r.r,
      ms: r.m,
      streak: r.k,
      ageMs: now - r.measuredAt,
      path: m?.p || '',
      target: m?.n || '',
      host: m?.h || '',
      test: m?.t || '',
      type: m?.y || '',
      intervalSec: m?.iv || null,
    });
  }
  items.sort((x, y) => (x.path || '').localeCompare(y.path || '') || (x.target || '').localeCompare(y.target || ''));
  return {
    agent: a.agent,
    silent,
    total: items.length,
    truncated: items.length > limit,
    items: items.slice(0, limit),
    hasMeta: a.meta.size > 0,
  };
}

/** 전체 엣지 합산(중앙 화면 KPI 에 더할 값). 무보고 엣지는 unknown 으로만 센다. */
export function edgeTotals(now = Date.now()) {
  const t = { agents: 0, silent: 0, rows: 0, ok: 0, warn: 0, bad: 0, stale: 0, unknown: 0, notRun: 0 };
  for (const s of edgeSummary(now)) {
    t.agents += 1;
    if (s.silent) { t.silent += 1; t.unknown += s.rows; }
    else { t.ok += s.counts.ok; t.warn += s.counts.warn; t.bad += s.counts.bad; t.stale += s.counts.stale; }
    t.rows += s.rows;
    t.notRun += s.notRun;
  }
  return t;
}

export function getAgentRaw(agent) { return agents[String(agent || '').trim()] || null; }
export function listAgentNames() { return Object.keys(agents).sort(); }

/** 엣지 등록 해제(교체·오타로 생긴 유령 엣지 정리). 감사에 남긴다. */
export function forgetAgent(agent, user = '') {
  const name = String(agent || '').trim();
  if (!agents[name]) return false;
  const rows = agents[name].rows.size;
  delete agents[name];
  logAudit({ user, action: 'svcmon.edge.forget', target: name, detail: `행 ${rows}개 폐기` });
  return true;
}

export function _resetEdgeCache() { agents = Object.create(null); }
