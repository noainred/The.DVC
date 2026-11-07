/**
 * svcmon/transitions.js — 점검 **상태 전이 이력 · 시간별 집계 · 실패 알림**(v2.915, Monitoring 개요 기술 뷰 · 개선안 ②).
 *
 * 왜 따로 두는가: 예전에는 결과(최신값)만 있고 '언제 무엇이 나빠졌나' 의 이력이 없었다. 점검 실패 알림도 없었다 —
 * `svcmon/` 아래 notify 호출 0건(있던 것은 엣지 무보고/재개 알림 `central/svcmonSilence.js` 뿐).
 *
 * 입력은 두 곳에서 온다 — 둘 다 결과를 기록하는 **그 자리**에서 `noteResult` 를 부른다(판정은 여기 하나):
 *   · 이 인스턴스의 폴러(`svcmon/poller.js sweep`) — scope ''(직접)
 *   · 중앙이 받은 엣지 보고(`central/svcmonEdge.js ingestReport`) — scope = 엣지 이름
 *
 * 지키는 것
 *  - **핫패스는 O(1)** — 결과 1건당 맵 갱신 몇 번뿐(20만 점검 × 1분 주기를 가정). 파일 쓰기 없음(이력은 메모리 — 재시작하면 비고,
 *    화면이 '재시작 이후' 임을 밝힌다).
 *  - 알림은 **전이 때만**(연속 N회째 처음 넘을 때 1번 · 복구 1번) — 매 결과마다 보내지 않는다. 한꺼번에 많이 넘으면(대량 장애)
 *    20초 창으로 묶어 **요약 1건**을 보낸다(알림 폭주 금지 — alerts.js 대기열 머리말의 '한 틱 40건' 사고와 같은 이유).
 *  - 알림은 **기본 끔**(설정 › Monitoring 설정 › 알림) — 업그레이드만으로 전 법인 포탈이 실패 중인 점검 수만큼 알림을 쏘지 않게.
 *  - 보내기는 `alerts.js enqueueNotify`(결과를 기다리지 않는 호출부용 대기열) — 폴러가 SMTP 로그인 시간만큼 멈추지 않게.
 */

import { numOrNull } from '../util/numOrNull.js';
import { getAlertSettings, cleanAlertSettings, ALERT_DEFAULTS, onAlertSettingsSaved, _setAlertSettingsCache } from './alertSettings.js';

export { getAlertSettings, saveAlertSettings, cleanAlertSettings, ALERT_DEFAULTS, ALERT_SCOPES } from './alertSettings.js';
const t = (v) => String(v ?? '').trim();

export const RING_MAX = 500;
export const HOUR_MS = 3_600_000;
export const HOURS_KEEP = 24;
export const ALERT_BATCH_MS = 20_000;
export const ALERT_BATCH_INDIVIDUAL_MAX = 5;
const ALERTED_MAX = 50_000;
export const SYNC_PATH_PREFIX = '설정 연동';

/* 알림 설정은 svcmon/alertSettings.js(파일 입출력은 그쪽 — 이 모듈은 메모리만 쓴다). */

/* ───────────────────────────── 이력 · 집계 ───────────────────────────── */

let _ring = [];                 // [{ at, scope, testId, from, to, target, test, path, host, reply, streak }]
const _hours = new Map();       // hourStart -> { ok, warn, bad, n, msSum, msN }
const _alerted = new Map();     // `${scope}|${testId}` -> { at, label, path, scope, testId }
const _warned = new Map();
const inScope = (s, p) => s.scope !== 'settings' || t(p) === SYNC_PATH_PREFIX || t(p).startsWith(`${SYNC_PATH_PREFIX}\\`);
// 알림을 끄면 '알린 상태' 를 비운다 — 다시 켰을 때 그 사이 복구된 점검에 거짓 복구 알림을 보내지 않게.
// v2.927(점검 D1-05 ①②): 범위를 좁히거나 경고 알림을 끌 때는 비우지 않는다 — 대신 복구 결과가 범위·종류와 관계없이 상태를 지운다(evalAlert).
//   저장 때 비우면 범위를 다시 넓힌 순간 아직 실패 중인(이미 알린) 점검에 실패 알림이 한 번 더 나간다.
onAlertSettingsSaved((next) => { if (!next.enabled) { _alerted.clear(); _warned.clear(); } });
let _queue = [];                // 보낼 알림(창으로 묶는다)
let _flushTimer = null;
let _sentStats = { individual: 0, summaries: 0, lastAt: 0 };

/** 테스트 주입 — 실제 발송 함수(기본: alerts.js enqueueNotify). */
let _send = null;
async function sendAlert(a) {
  if (_send) return _send(a);
  try { const m = await import('../alerts.js'); return m.enqueueNotify(a); } catch (e) { console.warn('[svcmon] 알림 대기열 실패:', e?.message || e); return null; }
}

function bumpHour(at, status, ms) {
  const h = Math.floor(at / HOUR_MS) * HOUR_MS;
  let b = _hours.get(h);
  if (!b) {
    b = { ok: 0, warn: 0, bad: 0, n: 0, msSum: 0, msN: 0 };
    _hours.set(h, b);
    // 오래된 칸 정리 — 칸을 새로 만들 때만(핫패스에서 매번 훑지 않는다).
    const floor = h - HOURS_KEEP * HOUR_MS;
    for (const k of _hours.keys()) if (k < floor) _hours.delete(k);
  }
  b.n += 1;
  if (status === 'ok' || status === 'warn' || status === 'bad') b[status] += 1;
  const m = numOrNull(ms);
  if (m != null && m >= 0 && status !== 'bad') { b.msSum += m; b.msN += 1; }
}

/**
 * 결과 1건 기록. 핫패스 — 던지지 않는다.
 * @param {{at?:number, scope?:string, testId:string, prev?:string|null, status:string, reply?:string, ms?:number|null, streak?:number,
 *          target?:{name?:string, path?:string, host?:string}, test?:{name?:string, type?:string}}} r
 */
export function noteResult(r) {
  try {
    const at = Number(r?.at) || Date.now();
    const status = t(r?.status);
    const scope = t(r?.scope);
    const testId = t(r?.testId);
    if (!testId || !status) return;
    bumpHour(at, status, r?.ms);
    const prev = r?.prev ? t(r.prev) : '';
    if (prev && prev !== status) {
      _ring.push({
        at, scope, testId, from: prev, to: status,
        target: t(r?.target?.name).slice(0, 120), path: t(r?.target?.path).slice(0, 300), host: t(r?.target?.host).slice(0, 253),
        test: t(r?.test?.name).slice(0, 80), type: t(r?.test?.type).slice(0, 16), reply: t(r?.reply).slice(0, 160),
        streak: Number(r?.streak) || 1,
      });
      if (_ring.length > RING_MAX) _ring.splice(0, _ring.length - RING_MAX);
    }
    evalAlert({ at, scope, testId, status, streak: Number(r?.streak) || 1, reply: t(r?.reply), target: r?.target || {}, test: r?.test || {} });
  } catch { /* 이력은 부가 정보 — 결과 기록을 막지 않는다 */ }
}

/**
 * 알림 키 — 직접 실행(scope '')은 testId(저장소 id — 안정). 엣지 행은 **(엣지 · 경로 · 대상 이름 · 점검 이름)** 으로 묶는다(v2.928 —
 * 반증 낮음: 엣지는 배정을 다시 굳힐 때마다 점검 id 를 새로 발급해, 실패가 이어지는 점검을 '처음 실패' 로 또 알렸고 옛 키가 남았다).
 * ⚠ 점검 이름은 유일하지 않다(반증 재검토 N1 — 재현: 마법사 기본 이름으로 TCP 22·443 이 둘 다 'TCP 포트 열림' → 한쪽 실패를 다른 쪽
 *   정상이 '복구' 로 지워 실패/복구가 번갈아 나갔다). 엣지가 같은 이름 키를 둘 이상 가지면(`test.dupName` — svcmonEdge 가 센다) 그 행은
 *   **testId 키**로 떨어뜨린다(재배정 때 한 번 더 알릴 수 있지만 거짓 복구는 없다). 구분자는 제어 문자(\u0001) — 이름·경로의 '|' 와 섞이지 않게.
 * 엣지 메타(이름)를 아직 모르면(중앙 재시작 직후 — 메타는 다음 push 에 온다) **null = 판정 보류** — 이름 없이 내부 id 로 알리지 않는다.
 * v2.927(점검 D1-03 — 보류에는 시한): 메타가 보류 시한(svcmonEdge metaAlertHoldMs) 안에 오지 않으면 svcmonEdge 가 `metaTimeout:true` 로 다시 판정한다 —
 *   그때만 testId 키(`엣지 \u0001 # id`)로 판정한다(무기한 보류 금지 · 루트 CLAUDE.md '보류에는 시한'). 나중에 메타가 오면 이름 키로 한 번 더 알릴 수 있다.
 */
const SEP = '\u0001';
export function alertKeyOf(x) {
  if (!t(x?.scope)) return `|${t(x?.testId)}`;
  const tn = t(x?.target?.name); const sn = t(x?.test?.name);
  if (!tn || !sn) return x?.metaTimeout === true ? `${t(x.scope)}${SEP}#${t(x?.testId)}` : null;
  if (x?.test?.dupName) return `${t(x.scope)}${SEP}#${t(x?.testId)}`;
  return [t(x.scope), t(x?.target?.path), tn, sn].join(SEP);
}
/** 지금 판정 보류 중인 (엣지 · 점검 id) — 메타가 와서 판정되면 빠진다(누적 수가 아니라 현재 수 — 반증 재검토 N2). */
const _held = new Set();
const HELD_MAX = 50_000;

/**
 * 알림 판정만(시간별 집계·전이 이력은 이미 셌을 때) — 엣지 메타가 늦게 와 보류됐던 결과를 다시 판정한다(svcmonEdge ingestReport).
 * 던지지 않는다.
 */
export function noteAlertOnly(r) {
  try {
    const status = t(r?.status); const testId = t(r?.testId);
    if (!testId || !status) return;
    evalAlert({ at: Number(r?.at) || Date.now(), scope: t(r?.scope), testId, status, streak: Number(r?.streak) || 1, reply: t(r?.reply), target: r?.target || {}, test: r?.test || {},
      metaTimeout: r?.metaTimeout === true });   // v2.927(점검 D1-03): 보류 시한을 넘긴 재판정만 testId 키로
  } catch { /* 알림은 부가 정보 */ }
}

function evalAlert(x) {
  const s = getAlertSettings();
  if (!s.enabled) return;
  const path = t(x.target?.path);
  // 키가 없으면(엣지 이름을 아직 모름) 보류 — 범위 검사보다 먼저(경로를 모르면 범위도 모른다 · v2.927 점검 D1-03: '설정 연동 대상만' 범위에서 빠지던 문제).
  const key = alertKeyOf(x);
  const heldKey = `${x.scope}${SEP}${x.testId}`;
  if (!key) { if (_held.size < HELD_MAX) _held.add(heldKey); return; }
  _held.delete(heldKey);
  const label = `${t(x.target?.name) || t(x.target?.host) || x.testId} › ${t(x.test?.name) || t(x.test?.type)}`;
  const where = x.scope ? `엣지 ${x.scope}` : '이 포탈';
  // v2.927(점검 D1-05 ① — 재현): 복구는 범위 검사보다 **먼저** — 범위 밖 복구도 '알린 상태' 는 지운다(알림만 생략). 예전에는 범위 검사에서 먼저
  //   돌아가 상태가 남았고, '전체' 로 되돌리면 오래전 복구된 점검에 복구 알림('이상 지속 약 360분')이 나갔다.
  //   ②(반증: 설계 판단): 경고만 알렸던 점검의 복구는 **경고 알림이 켜져 있을 때만** 보낸다(상태는 늘 지운다) — 범위와 같은 규칙(끈 종류·범위 밖은 상태만 닫는다).
  if (x.status === 'ok') {
    const bad = _alerted.get(key); const warned = _warned.get(key);
    if (!bad && !warned) return;
    _alerted.delete(key); _warned.delete(key);
    if (s.recover && inScope(s, path) && (bad || s.warn)) enqueue({ kind: 'ok', key, label, x, where, since: (bad || warned).at });
    return;
  }
  if (!inScope(s, path)) return;
  if (x.status === 'bad') {
    if (x.streak >= s.failCount && !_alerted.has(key)) {
      if (_alerted.size >= ALERTED_MAX) _alerted.delete(_alerted.keys().next().value);
      _alerted.set(key, { at: x.at, label, path, scope: x.scope, testId: x.testId });
      enqueue({ kind: 'bad', key, label, x, where });
    }
    return;
  }
  if (x.status === 'warn') {
    if (s.warn && x.streak >= s.failCount && !_warned.has(key)) {
      if (_warned.size >= ALERTED_MAX) _warned.delete(_warned.keys().next().value);
      _warned.set(key, { at: x.at, label, path, scope: x.scope, testId: x.testId });
      enqueue({ kind: 'warn', key, label, x, where });
    }
  }
}

/*
 * v2.927(점검 D1-05 ③): 대상·점검을 지우거나 끄면 결과가 더 오지 않아 '알린 상태' 가 닫히지 않았다(알림 탭 '지금 알린 상태: 실패 N' 이 실패 중인
 *   점검이 없어도 N). 결과가 멈추는 자리에서 지운다(복구 알림은 보내지 않는다 — 결과가 아니다):
 *   · 이 포탈의 폴러 — 색인을 다시 만들 때 살아 있는 점검 id 로(scope '' 키는 `|testId` — 안정).
 *   · 중앙의 엣지 수신 — 완결 GC 가 행을 지운 뒤 **남은 행의 알림 키**로(v2.928 이름 키: 재배정으로 id 만 바뀐 점검은 키가 같아 남는다 — 같은 실패를
 *     다시 알리지 않게) · 엣지를 잊을 때 그 엣지 전부. 보류 중(_held)인 그 행도 함께 뺀다(metaPending 이 지운 행을 세지 않게).
 */
/** 보류 중인 (엣지 · 점검 id) 하나를 뺀다 — 행이 사라졌을 때. */
export function forgetHeld(scope, testId) { _held.delete(`${t(scope)}${SEP}${t(testId)}`); }
/** 그 scope 의 알린 상태가 하나라도 있는가(엣지 GC 가 남은 행의 키를 계산할지 정한다). */
export function hasAlertedIn(scope) {
  const sc = t(scope);
  for (const m of [_alerted, _warned]) for (const v of m.values()) if (v?.scope === sc) return true;
  return false;
}
/**
 * 한 scope(엣지 이름 · '' = 이 포탈)의 알린 상태 중 `keep(key, entry)` 가 거짓인 것을 지운다(entry 에 scope·testId 가 실려 있다 — 키를 다시 쪼개지 않는다).
 * keep 이 없으면 그 scope 전부(보류 중인 것까지).
 */
export function forgetAlertedWhere(scope, keep = null) {
  const sc = t(scope);
  for (const m of [_alerted, _warned]) {
    for (const [k, v] of m) {
      if (v?.scope !== sc) continue;
      if (!keep || !keep(k, v)) m.delete(k);
    }
  }
  if (!keep) { const pre = `${sc}${SEP}`; for (const h of _held) if (h.startsWith(pre)) _held.delete(h); }
}

function enqueue(item) {
  _queue.push(item);
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => { _flushTimer = null; flushAlerts().catch(() => {}); }, ALERT_BATCH_MS);
  _flushTimer.unref?.();
}

const mins = (ms) => Math.max(0, Math.round(ms / 60_000));

/** 알림 묶음 → 보낼 알림 목록(순수 — 테스트가 고정). 창 안의 건수가 상한 이하면 하나씩, 넘으면 종류별 요약 1건. */
export function buildAlerts(items = [], s = getAlertSettings()) {
  const out = [];
  const byKind = { bad: [], warn: [], ok: [] };
  for (const it of items) (byKind[it.kind] || (byKind[it.kind] = [])).push(it);
  const one = (it) => {
    const p = t(it.x?.target?.path);
    if (it.kind === 'bad') {
      return {
        severity: 'critical', key: `svcmon.test.bad:${it.key}`, title: `Monitoring 점검 실패: ${it.label}`,
        detail: `${s.failCount}회 연속 실패(현재 ${it.x.streak}회) · ${it.x.reply || '응답 없음'} · 점검 위치 ${it.where}${p ? ` · 경로 ${p}` : ''}`,
      };
    }
    if (it.kind === 'warn') {
      return {
        severity: 'warning', key: `svcmon.test.warn:${it.key}`, title: `Monitoring 점검 경고: ${it.label}`,
        detail: `${s.failCount}회 연속 경고 · ${it.x.reply || ''} · 점검 위치 ${it.where}${p ? ` · 경로 ${p}` : ''}`,
      };
    }
    return {
      severity: 'info', key: `svcmon.test.ok:${it.key}`, title: `Monitoring 점검 복구: ${it.label}`,
      detail: `정상으로 돌아왔습니다(${it.x.reply || 'ok'}) · 이상 지속 약 ${mins(it.x.at - (it.since || it.x.at))}분 · 점검 위치 ${it.where}`,
    };
  };
  for (const kind of ['bad', 'warn', 'ok']) {
    const list = byKind[kind] || [];
    if (!list.length) continue;
    if (list.length <= ALERT_BATCH_INDIVIDUAL_MAX) { for (const it of list) out.push(one(it)); continue; }
    const head = list.slice(0, 10).map((it) => `· ${it.label} (${it.where})`).join('\n');
    const name = kind === 'bad' ? '실패' : kind === 'warn' ? '경고' : '복구';
    out.push({
      severity: kind === 'bad' ? 'critical' : kind === 'warn' ? 'warning' : 'info',
      // 키에 시각을 넣는다 — 고정 키면 alerts.js 억제 창(기본 5분)이 다음 요약을 'suppressed' 로 버렸다(반증 M4 — 재현).
      key: `svcmon.test.${kind}:summary:${Date.now()}`,
      title: `Monitoring 점검 ${name} ${list.length}건(${Math.round(ALERT_BATCH_MS / 1000)}초 안에 몰림 — 요약)`,
      detail: `${head}${list.length > 10 ? `\n… 외 ${list.length - 10}건` : ''}\n대량 ${name}는 회선·엣지 장애일 수 있습니다 — Monitoring › 개요의 엣지 보고 · 상태 전이를 먼저 보세요.`,
    });
  }
  return out;
}

export async function flushAlerts() {
  const items = _queue; _queue = [];
  if (!items.length) return [];
  const list = buildAlerts(items);
  for (const a of list) {
    await sendAlert(a);
    // v2.927(점검 D1-06): 요약 키는 `…:summary:<시각>` 이다(반증 M4 — 고정 키는 억제 창에 버려졌다) — 끝이 ':summary' 인지만 보면 늘 '개별' 로 셌다.
    if (/:summary(:|$)/.test(a.key)) _sentStats.summaries += 1; else _sentStats.individual += 1;
  }
  _sentStats.lastAt = Date.now();
  return list;
}

/* ───────────────────────────── 조회 ───────────────────────────── */

/** 최근 전이(최신 먼저). */
export function recentTransitions(limit = 50) {
  return _ring.slice(-Math.max(1, Math.min(RING_MAX, Number(limit) || 50))).reverse();
}

/** 지난 24시간 시간별 집계(오래된 → 최신, 빈 시간은 0 — 결측과 구분되게 `n` 을 싣는다). */
export function hourlySeries(now = Date.now()) {
  const cur = Math.floor(now / HOUR_MS) * HOUR_MS;
  const out = [];
  for (let i = HOURS_KEEP - 1; i >= 0; i -= 1) {
    const h = cur - i * HOUR_MS;
    const b = _hours.get(h);
    out.push({ at: h, ok: b?.ok || 0, warn: b?.warn || 0, bad: b?.bad || 0, n: b?.n || 0, avgMs: b?.msN ? Math.round(b.msSum / b.msN) : null });
  }
  return out;
}

/**
 * v2.927(점검 D1-08): 요약 묶음 규칙 — 화면 문구가 상수를 박지 않게 API 로 싣는다. 요약은 창 안의 같은 종류가 상한(ALERT_BATCH_INDIVIDUAL_MAX)을
 *   **넘을 때**라 '몇 건 이상이면 요약' 은 상한 + 1 이다(+1 해석은 여기 한 곳 — buildAlerts 의 `list.length <= ALERT_BATCH_INDIVIDUAL_MAX` 와 같은 뜻).
 */
export function alertBatchInfo() {
  return { batchMs: ALERT_BATCH_MS, batchIndividualMax: ALERT_BATCH_INDIVIDUAL_MAX, summaryFrom: ALERT_BATCH_INDIVIDUAL_MAX + 1 };
}

export function alertStats() {
  return { alerted: _alerted.size, warned: _warned.size, queued: _queue.length, metaPending: _held.size, ..._sentStats };
}
/** 기동 시각 — 화면이 '재시작 이후' 임을 밝힌다. */
const _startedAt = Date.now();
export function transitionsSince() { return _startedAt; }

/** 테스트 전용. */
export function _resetTransitionsForTest({ send = null } = {}) {
  _ring = []; _hours.clear(); _alerted.clear(); _warned.clear(); _queue = []; _setAlertSettingsCache(null); _send = send; _held.clear();
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  _sentStats = { individual: 0, summaries: 0, lastAt: 0 };
}
export function _setAlertSettingsForTest(s) { _setAlertSettingsCache(cleanAlertSettings(s, ALERT_DEFAULTS)); }
