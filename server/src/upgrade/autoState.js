/**
 * upgrade/autoState.js — '자동 업그레이드가 지금 동작하는가, 아니면 왜 안 하는가' 판정 + 확인·적용 기록 정제(순수, v2.736.2).
 *
 * 왜(사용자 신고 2026-10-15 — "아직도 자동 업그레이드가 안되고 동일한 메시지가 있어, 서명 필수"):
 *   업그레이드 화면 '릴리스 서명 › 마지막 검증' 이 '아직 검증한 번들이 없습니다' 였다. 서명 판정(`signature.js decideSignature`)은
 *   성공이든 실패든 **시도하면 반드시** 기록을 남기므로, 그 문구는 '서명이 막았다' 가 아니라 **이 프로세스가 업그레이드를
 *   한 번도 시도하지 않았다** 는 뜻이었다(게시된 2.736.1 은 실제 코드로 서명 필수 정책에서 통과·설치됨을 확인했다).
 *   그런데 화면은 시도하지 않는 이유를 말하지 않았다 — 확인 주기 0분(= 백그라운드 확인 끔. 중앙 포탈의 기본값)이어도
 *   '자동 적용: 예' 라고만 보였고, 다음 확인 시각도, 마지막 백그라운드 확인의 결과도 없었다. 확인·적용 기록은 메모리에만 있어
 *   자동 업그레이드가 성공해 재시작하면 '업그레이드됐다' 는 흔적도 사라졌다.
 *
 * 규칙:
 *  - 판정은 서버가 코드(`AUTO_CODES`)로 하고 문장은 웹 `views/upgradeAutoText.js` 가 만든다(1:1 — 웹 테스트가 대조한다).
 *  - 상태(state)는 다섯이다 — on(자동 확인 + 자동 적용) / check-only(자동 확인만, 적용은 수동) / manual(자동 확인 안 함) /
 *    off(기능 꺼짐) / blocked(설정이 모자라 적용할 수 없음). 마지막 확인·적용이 실패했으면 상태는 그대로 두고 사유를 더한다.
 *  - 다음 확인 시각은 **타이머를 무장한 시각 + 주기의 배수** 다(setInterval 과 같은 규칙). 모르면 null — 지어내지 않는다.
 *  - 기록 정제(`sanitize*`)는 아는 필드만, 글자 길이를 자르고, 주소는 계정·쿼리를 뗀다(v2.730 I-08). 파일 저장과 화면 응답이
 *    같은 함수를 쓴다(쓸 때·읽을 때 둘 다).
 *  - 재시작 전 기록을 되살릴 때 `available`(새 버전 있음)은 **지금 버전 기준으로 다시 계산** 한다 — 재시작 전 '새 버전 있음' 을
 *    그대로 두면 이미 설치한 버전이 '새 버전' 으로 보인다. 설치는 언제나 방금 새로 받은 메타데이터로만 한다(적용 경로가 다시 확인한다).
 */
import { cmpVersion } from '../util/cmpVersion.js';

/** 판정 코드 — 웹 `AUTO_TEXT` 의 키와 1:1. */
export const AUTO_CODES = Object.freeze([
  'disabled',        // '자동 업그레이드 사용' 이 꺼짐 — 아무것도 하지 않는다(버튼도 잠긴다)
  'no-source',       // 원격 소스·감시 폴더 둘 다 비었다 — 확인할 곳이 없다
  'no-interval',     // 확인 주기 0분 — 백그라운드 확인을 하지 않으므로 자동 적용도 일어나지 않는다
  'no-auto-apply',   // 자동 적용 꺼짐 — 새 버전을 찾아도 적용은 수동
  'no-install-dir',  // 설치 경로 없음 — 적용할 수 없다
  'check-failed',    // 마지막 확인이 실패했다(사유 동봉)
  'apply-failed',    // 마지막 적용이 실패했다(사유 동봉)
  'deferred-scans',  // v2.737: 새 버전을 찾았지만 실행 중인 스캔이 끝나기를 기다리는 중(상한 UPGRADE_SCAN_DEFER_MAX_MS — 넘으면 적용)
]);
export const AUTO_STATES = Object.freeze(['on', 'check-only', 'manual', 'off', 'blocked']);
/** 백그라운드 확인 한 번의 결과 — 웹 `TICK_TEXT` 의 키와 1:1. */
export const TICK_OUTCOMES = Object.freeze(['up-to-date', 'available', 'applying', 'applied', 'apply-failed', 'check-failed', 'no-source', 'error', 'deferred']);

const VER_RE = /^v?\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const ver = (v) => (typeof v === 'string' && VER_RE.test(v.trim()) ? v.trim().replace(/^v/i, '') : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ts = (v) => { const n = num(v); return n != null && n > 0 ? n : null; };
const txt = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
const bool = (v) => v === true;
const TRIGGERS = new Set(['auto', 'manual']);
const trig = (v) => (TRIGGERS.has(v) ? v : null);

/** 화면·파일에 싣는 주소 — 계정·비밀번호·쿼리·조각을 뗀다(upgrade.js safeUrlText 와 같은 규칙. 순환 import 를 피해 사본을 둔다). */
export function urlText(u) {
  if (typeof u !== 'string' || !u) return null;
  try { const x = new URL(u); x.username = ''; x.password = ''; x.search = ''; x.hash = ''; return x.toString().slice(0, 400); }
  catch { return u.split('?')[0].replace(/\/\/[^/@]*@/, '//').slice(0, 400); }
}

/** 원격 확인 결과(checkRemote) 정제. */
function sanitizeRemote(r) {
  if (!r || typeof r !== 'object') return null;
  const out = {
    ok: bool(r.ok), available: bool(r.available), latest: ver(r.latest), current: ver(r.current),
    checkedAt: ts(r.checkedAt), source: urlText(r.source), error: txt(r.error, 600),
    tarGz: txt(r.tarGz, 200), sizeBytes: num(r.sizeBytes), manifestName: txt(r.manifestName, 200),
  };
  if (r.lastGood && typeof r.lastGood === 'object') {
    out.lastGood = { checkedAt: ts(r.lastGood.checkedAt), latest: ver(r.lastGood.latest), available: bool(r.lastGood.available) };
  }
  return out;
}

/** 확인 결과(manager.check) 정제 — 쓸 때·읽을 때 공용. */
export function sanitizeCheck(c) {
  if (!c || typeof c !== 'object') return null;
  const at = ts(c.at);
  if (at == null) return null;
  const out = { at, current: ver(c.current), trigger: trig(c.trigger) };
  if (c.watch && typeof c.watch === 'object') {
    out.watch = { available: bool(c.watch.available), version: ver(c.watch.version), path: txt(c.watch.path, 400) };
    // v2.809: 번들 옆 서명 manifest 유무(manager.check) — 빠뜨리면 화면(status.lastCheck)이 'manifest 없음' 경고를 못 띄운다(Chromium 확인에서 발견)
    if (typeof c.watch.hasManifest === 'boolean') out.watch.hasManifest = c.watch.hasManifest;
    if (c.watch.manifest != null) out.watch.manifest = txt(c.watch.manifest, 200);
  }
  if (c.remote && typeof c.remote === 'object') out.remote = sanitizeRemote(c.remote);
  if (c.restored === true) out.restored = true;
  return out;
}

function sanitizeSignature(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    verified: bool(s.verified), warned: bool(s.warned), code: txt(s.code, 60), keyId: txt(s.keyId, 80),
    version: ver(s.version), policy: s.policy === 'warn' || s.policy === 'require' ? s.policy : null, where: txt(s.where, 40),
  };
}

function sanitizeEdgePush(e) {
  if (!e || typeof e !== 'object') return null;
  const failed = Array.isArray(e.failed) ? e.failed.filter((f) => f && typeof f === 'object').slice(0, 20)
    .map((f) => ({ edge: urlText(f.edge) || txt(f.edge, 200), status: num(f.status), reason: txt(f.reason, 300) || '' })) : [];
  return { total: num(e.total) ?? 0, ok: num(e.ok) ?? 0, failed };
}

/** v2.775: 수집 서버 push 요약 정제(manager.summarizeCollectorPush 모양) — 이름·사유는 글자만, 64건 상한. */
function sanitizeCollectorPush(e) {
  if (!e || typeof e !== 'object') return null;
  const items = Array.isArray(e.items) ? e.items.filter((f) => f && typeof f === 'object').slice(0, 64)
    .map((f) => ({ id: txt(f.id, 128) || '', name: txt(f.name, 128) || '', ok: f.ok === true, status: num(f.status), version: ver(f.version) || '', reason: txt(f.reason, 300) || '' })) : [];
  const out = { total: num(e.total) ?? 0, ok: num(e.ok) ?? 0, items };
  const sk = txt(e.skipped, 300);
  if (sk) out.skipped = sk;
  return out;
}

/** 적용 결과(manager.apply · 엣지/수집기 push 수신) 정제 — 쓸 때·읽을 때 공용. */
export function sanitizeResult(r) {
  if (!r || typeof r !== 'object') return null;
  const at = ts(r.at);
  if (at == null) return null;
  const out = {
    at, source: txt(r.source, 40), trigger: trig(r.trigger), ok: bool(r.ok), reason: txt(r.reason, 800),
    code: txt(r.code, 60), version: ver(r.version), target: ver(r.target), from: ver(r.from), backup: txt(r.backup, 400),
    appliedArchive: txt(r.appliedArchive, 400), restarting: bool(r.restarting) || undefined,
    downloaded: num(r.downloaded), upToDate: bool(r.upToDate) || undefined,
  };
  const sig = sanitizeSignature(r.signature);
  if (sig) out.signature = sig;
  if (r.check && typeof r.check === 'object') {
    const c = sanitizeRemote(r.check);
    if (c) out.check = { latest: c.latest, current: c.current, source: c.source, error: c.error };
  }
  const ep = sanitizeEdgePush(r.edgePush);
  if (ep) out.edgePush = ep;
  const cp = sanitizeCollectorPush(r.collectorPush);
  if (cp) out.collectorPush = cp;
  if (r.restored === true) out.restored = true;
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === null) delete out[k];
  out.at = at; out.ok = bool(r.ok); // 핵심 필드는 null 이어도 남긴다(위 정리에서 지우지 않게)
  return out;
}

/** 백그라운드 확인 한 번(manager.tick) 기록 정제. */
export function sanitizeTick(t) {
  if (!t || typeof t !== 'object') return null;
  const at = ts(t.at);
  if (at == null) return null;
  return {
    at, finishedAt: ts(t.finishedAt), outcome: TICK_OUTCOMES.includes(t.outcome) ? t.outcome : 'error',
    latest: ver(t.latest), version: ver(t.version), reason: txt(t.reason, 600), ...(t.restored === true ? { restored: true } : {}),
  };
}

/**
 * 재시작 전 기록을 되살린다 — `restored:true` 를 달고, 확인 결과의 '새 버전 있음' 은 지금 버전 기준으로 다시 계산한다.
 * @param {object} doc 파일 내용 {lastCheck,lastResult,lastTick}
 * @param {string} currentVersion 지금 실행 중인 버전
 */
export function restoreStatus(doc, currentVersion) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const mark = (o) => (o ? { ...o, restored: true } : null);
  const check = mark(sanitizeCheck(d.lastCheck));
  if (check) {
    const newerThanNow = (v) => { const c = cmpVersion(v, currentVersion); return c != null && c > 0; };
    if (check.remote) check.remote.available = !!(check.remote.ok && check.remote.latest && newerThanNow(check.remote.latest));
    if (check.watch) check.watch.available = !!(check.watch.version && newerThanNow(check.watch.version));
  }
  return { lastCheck: check, lastResult: mark(sanitizeResult(d.lastResult)), lastTick: mark(sanitizeTick(d.lastTick)) };
}

/** 다음 백그라운드 확인 시각 — setInterval(무장 시각 + k × 주기). 꺼져 있거나 모르면 null. */
export function nextCheckAt({ armedAt, intervalMs, now }) {
  const a = ts(armedAt); const ms = num(intervalMs);
  if (a == null || ms == null || ms <= 0) return null;
  const t = num(now) ?? a;
  if (t < a) return a + ms;
  return a + (Math.floor((t - a) / ms) + 1) * ms;
}

/**
 * 실패한 적용 기록이 더는 지금 사유가 아닌가(리뷰 F1·F2 — 기록을 파일에 남기면서 실패가 그 조건보다 오래 살게 됐다).
 *  ① 그 적용의 대상 버전(target · version · check.latest)이 지금 버전보다 새롭지 않다 — 이미 설치됐다(다른 경로로 설치·같은 번들 push).
 *  ② 그 뒤의 백그라운드 확인이 '최신' 이었다 — 받을 새 버전이 없다(versions.json 되돌림 등).
 * 대상 버전을 모르면 ① 로 지우지 않는다(지어내지 않는다).
 * ⚠ v2.740(감사 B-10): `target`(설치하려던 버전 — 서명된 버전·감시 폴더 번들 버전)이 있으면 그것이 먼저다. 내용 버전 불일치
 *   실패의 `version` 은 번들 **내용**의 버전이라, 이름만 새 버전인 옛 번들(내용 = 지금 버전)이 매 주기 실패해도 ① 로 숨었다.
 */
export function failureMoot(lastResult, lastTick, currentVersion) {
  if (!lastResult || lastResult.ok !== false) return false;
  const target = ver(lastResult.target) || ver(lastResult.version) || ver(lastResult.check?.latest);
  if (target && ver(currentVersion)) { const c = cmpVersion(target, currentVersion); if (c != null && c <= 0) return true; }
  if (lastTick && lastTick.outcome === 'up-to-date' && ts(lastTick.at) != null && ts(lastResult.at) != null && lastTick.at > lastResult.at) return true;
  return false;
}

/**
 * 자동 업그레이드 상태 판정.
 * @param {object} o
 * @param {object} o.settings 유효 설정(enabled·autoApply·pollIntervalMs·installDir·remoteBase·watchDir)
 * @param {number} o.intervalMs 실제로 무장한 주기(clampPollMs 결과 — 0 이면 끔)
 * @param {number|null} o.armedAt 타이머를 무장한 시각(무장하지 않았으면 null)
 * @param {object|null} o.lastCheck · o.lastResult · o.lastTick 정제된 기록
 * @param {string|null} o.currentVersion 지금 실행 중인 버전 — 실패한 적용의 대상이 이미 설치돼 있으면 그 실패는 지난 일이다(리뷰 F1·F2)
 * @param {number} o.now
 * @returns {{state:string, issues:{code:string, reason?:string, at?:number, version?:string}[], intervalMs:number, nextCheckAt:number|null, armed:boolean}}
 */
export function autoUpgradeState({ settings = {}, intervalMs = 0, armedAt = null, lastCheck = null, lastResult = null, lastTick = null, currentVersion = null, deferral = null, now = Date.now() } = {}) {
  const s = settings || {};
  const ms = num(intervalMs) ?? 0;
  const issues = [];
  const base = { intervalMs: ms, nextCheckAt: null, armed: false };
  if (!s.enabled) return { ...base, state: 'off', issues: [{ code: 'disabled' }] };
  const hasSource = !!(s.remoteBase || s.watchDir);
  if (!hasSource) issues.push({ code: 'no-source' });
  if (ms <= 0) issues.push({ code: 'no-interval' });
  if (!s.autoApply) issues.push({ code: 'no-auto-apply' });
  if (!s.installDir) issues.push({ code: 'no-install-dir' });

  // 마지막 확인 실패 — 백그라운드든 수동이든 가장 최근 확인 기준(원격 오류만 사유가 있다).
  const remoteErr = lastCheck?.remote && lastCheck.remote.ok === false ? lastCheck.remote.error : null;
  if (remoteErr) issues.push({ code: 'check-failed', reason: remoteErr, at: lastCheck.at });
  // 마지막 적용 실패 — '이미 최신' 은 실패가 아니다. 지난 실패도 지금 사유가 아니다(failureMoot).
  if (lastResult && lastResult.ok === false && !lastResult.upToDate && !failureMoot(lastResult, lastTick, currentVersion)) {
    issues.push({ code: 'apply-failed', reason: lastResult.reason || null, at: lastResult.at, ...(lastResult.version ? { version: lastResult.version } : {}) });
  } else if (lastTick && lastTick.outcome === 'error' && lastTick.reason) {
    issues.push({ code: 'check-failed', reason: lastTick.reason, at: lastTick.at });
  }

  // v2.737: 실행 중 스캔이 끝나기를 기다리는 중 — 언제부터·언제까지(상한)·무엇을.
  const d = sanitizeDeferral(deferral);
  if (d) issues.push({ code: 'deferred-scans', at: d.since, until: d.until, version: d.latest || undefined, scans: d.scans.length, reason: d.scans.slice(0, 3).map((x) => x.label || x.kind).join(', ') || null });

  let state;
  if (!hasSource || (s.autoApply && !s.installDir && ms > 0)) state = 'blocked';
  else if (ms <= 0) state = 'manual';
  else if (!s.autoApply) state = 'check-only';
  else state = 'on';
  const armed = ts(armedAt) != null && ms > 0;
  return { state, issues, intervalMs: ms, armed, nextCheckAt: armed ? nextCheckAt({ armedAt, intervalMs: ms, now }) : null };
}

/** 업그레이드 대기 기록 정제(v2.737) — 화면 응답·판정 공용. 대기 중이 아니면 null. */
export function sanitizeDeferral(d) {
  if (!d || typeof d !== 'object') return null;
  const since = ts(d.since);
  if (since == null) return null;
  const scans = Array.isArray(d.scans) ? d.scans.filter((x) => x && typeof x === 'object').slice(0, 20)
    .map((x) => ({ kind: txt(x.kind, 32) || '', label: txt(x.label, 120) || '', since: ts(x.since) })) : [];
  return { since, until: ts(d.until), latest: ver(d.latest), scans };
}
