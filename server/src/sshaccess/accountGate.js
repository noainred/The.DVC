/**
 * sshaccess/accountGate.js — **공통 계정 비밀번호 탐침**(v3.24 반증 F2 — 한 주기 안의 계정 단위 정지).
 *
 * 왜: 폴러는 주기 시작 때 전 서버의 자격을 한꺼번에 해석하고(withResolvedAuth) 결과 기록(outcome.noteCredOutcome)은 주기가 끝난 뒤에 한다.
 *   그래서 같은 공통 계정을 물려받는 서버 N대가 틀린 비밀번호를 **한 주기에 N번** 보냈다(재현 — 가짜 sshd 5대 · 5회) — 계정 단위 정지(설계 §4.4 'AD 잠금 방지')가
 *   다음 주기부터만 들었다. 두 폴러(bm-usage · bm-storage)를 합치면 2N 회다.
 * 하는 일: 같은 계정 · 같은 비밀번호 판(credVersion)으로 가는 접속은 **먼저 간 하나(탐침)** 의 결과를 기다린다.
 *   · 그 판이 **최근(OK_FRESH_MS) 로그인에 성공했으면** 기다리지 않는다(평소 — 한 주기 안의 동시 수집 그대로).
 *     v3.31(점검 1회차 S1 — 재현): 예전에는 ‘한 번이라도’ 성공한 판이면 결과를 보지 않고 통과시켰다 — 성공 뒤 AD 에서 비밀번호가 바뀌면
 *     다음 주기가 그 계정을 물려받는 N대에 틀린 비밀번호를 N번 보냈다(bm-storage 6대 → 6회 · 서버 명령 4회). 이제 ① 성공이 오래됐으면(주기 사이 —
 *     bm-usage 5분 · bm-storage 10분) 다시 탐침 하나부터 ② 빠른 길에서도 결과를 보고 거부면 그 자리에서 정지를 건다(아직 시작하지 않은 접속은 보내지 않는다 —
 *     이미 나간 동시 접속(풀 크기)까지만).
 *   · 탐침이 로그인 거부면 그 자리에서 계정 단위 정지를 걸고(state.setAccountStop — outcome 과 같은 기록) 기다리던 접속은 **보내지 않는다**.
 *   · 탐침이 거부도 성공도 아니면(연결 실패 · 시한) 기다리던 접속 중 다음 하나가 새 탐침이 된다(한꺼번에 풀어 N번 보내지 않게).
 *   · 접속 직전에 정지를 다시 본다(주기 시작 때 해석한 뒤 다른 경로 — 한 대로 다시 확인 · 다른 폴러 — 가 건 정지).
 * 키 로그인(credVersion 없음)은 이 문을 지나지 않는다(키 거부는 계정 잠금 횟수에 들지 않는 것이 보통이고, 정지도 비밀번호 판에만 건다).
 * 판정(rejected)은 호출부가 **접속 단계 판정**으로 넘긴다(bm-storage `authFailed` · bm-usage `isSshAuthError` — 명령 출력의 'Permission denied' 로 멈추지 않게 · 반증 F3).
 * 상태는 메모리뿐이다(재시작하면 첫 주기에 다시 탐침 — 그것으로 충분하다). 대기는 장비 시한 **밖**에서 한다(호출부가 run 안에서 시한을 연다).
 */
import { accountStopFor, setAccountStop, accountResumeEpoch } from './state.js';
import { wasLoggedIn, wasPasswordSent } from './loginMark.js';

const okVersion = new Map();   // accountId → { v: 성공한 비밀번호 판(문자열), at: 마지막 성공 시각 }
/** 빠른 길(탐침 없이 동시에)을 여는 마지막 성공의 신선도 — 한 주기 안의 성공은 서로 이어 주고, 주기 사이(분 단위)는 넘지 않게. */
export const OK_FRESH_MS = 60_000;
let clock = () => Date.now();
const inflight = new Map();    // `${id}|${ver}` → Promise<'ok' | 'rejected' | 'other'>
// 정지 기록을 쓰지 못했을 때(디스크 오류 · 상한)만 쓰는 메모리 정지 — 1시간. 쓰기가 성공하면 상태 파일이 진실이다(정지 풀기는 그쪽에서).
//   2회차 반증 H1: 만료된 항목이 남아 있으면 다음 거부 때 다시 걸지 않아 1시간 뒤 N대 모두에 틀린 비밀번호가 갔다 — 만료를 함께 본다(memStopActive).
//   2회차 Q4: 사람이 ‘정지 풀기’ · ‘한 대로 다시 확인’ 을 하면(state.accountResumeEpoch 가 바뀜) 메모리 정지도 풀린다.
const memStop = new Map();     // `${id}|${ver}` → { at: 거부를 본 시각, epoch }
const MEM_STOP_MS = 3_600_000;
/*
 * 2회차 반증 M1 · 상태 Q1: 탐침이 ‘모름’(연결 실패 · 시한 — 비밀번호를 보냈는지 모른다)이면 다음 하나가 새 탐침이 되어 같은 계정 서버가 하나씩 직렬로 돈다 —
 *   한 법인 망이 끊기면 매 주기 N × 연결 시한(40대 × 15초 ≈ 10분)이고 대기자가 폴러의 풀 자리를 쥐어 다른 법인 수집까지 밀렸다(재현 201ms → 4,015ms).
 *   ① 다음 탐침은 **최근에 붙었던 서버**부터(순위 0) · 모르는 서버(1) · 최근 ‘모름’ 이었던 서버(2) 순 — 죽은 서버가 매번 탐침이 되지 않게.
 *   ② ‘모름’ 탐침이 PROBE_MISS_MAX 번 연달으면 남은 대기자와 PROBE_MISS_HOLD_MS 동안 오는 접속은 **이번에는 보내지 않는다**(`account-probe-unreached` —
 *      비밀번호를 보내지 않았다 · 다음 주기에 다시 본다). 성공 · 거부를 보면 연속 수를 지운다. 순위 ① 덕에 죽은 서버만 앞에 있어서 늘 건너뛰는 일은 없다
 *      (그 서버들은 다음 주기에 순위 2 로 밀린다).
 */
export const PROBE_MISS_MAX = 3;
export const PROBE_MISS_HOLD_MS = 120_000;
const SERVER_OK_KEEP_MS = 24 * 3_600_000;
const SERVER_MISS_KEEP_MS = 3_600_000;
const serverSeen = new Map();  // `${accountId}|${서버}` → { ok: 마지막 성공 시각, miss: 마지막 ‘모름’ 시각 }
const SERVER_SEEN_MAX = 20_000;
const missRun = new Map();     // `${id}|${ver}` → { n, at }
/*
 * 2회차 보안 B1: 비밀번호를 보냈는데 판정을 받지 못한 결과(‘sent’ — 로그인 시한 · 끊김)는 ‘모름’ 이 아니다 — 서버는 거부로 셌을 수 있다.
 *   예전에는 다음 대기자가 새 탐침이 되어 같은 계정 서버마다 한 번씩 보냈고, 정지도 걸리지 않아 주기마다 되풀이했다(재현 4대 → 4회 · 다음 주기 8회).
 *   ① ‘sent’ 면 남은 대기자와 PROBE_MISS_HOLD_MS 동안 오는 접속은 보내지 않는다(`account-login-unknown`) ② SENT_STOP_AFTER 번 연달으면(성공 · 거부 없이 —
 *   SENT_RUN_KEEP_MS 안) 계정 단위 정지를 건다(cause 'timeout' — 화면이 ‘로그인 판정을 시한 안에 받지 못함’ 으로 밝힌다 · 사람이 ‘한 대로 다시 확인’ 으로 푼다).
 *   시한 안에 끝나지 않는 로그인은 어차피 수집이 되지 않으니 멈춰도 잃는 것이 없다.
 */
export const SENT_STOP_AFTER = 3;
const SENT_RUN_KEEP_MS = 3 * 3_600_000;
const sentRun = new Map();     // `${id}|${ver}` → { n, at }
const sentHold = new Map();    // `${id}|${ver}` → 시각
const waitingRank = new Map(); // `${id}|${ver}` → [순위0 대기 수, 순위1, 순위2]

/** 정지로 보내지 않은 결과의 꼴 — 자격 해석이 막은 결과와 같다(authErrorCode — 사용 기록 · 인증 정지 판정에 들지 않는다). */
export const GATE_STOPPED = Object.freeze({ code: 'account-stopped' });

const serverIdOf = (srv) => String(srv?.id || `${srv?.host || ''}:${srv?.port || 22}`).slice(0, 160);
function memStopActive(key, id) {
  const m = memStop.get(key);
  if (!m) return false;
  const age = clock() - m.at;
  if (age >= MEM_STOP_MS || m.epoch !== accountResumeEpoch(id)) { memStop.delete(key); return false; }
  return true;   // 시계가 뒤로 가면(age < 0) 정지를 유지한다(안전한 쪽)
}
function rankOf(id, sid) {
  const x = serverSeen.get(`${id}|${sid}`);
  const now = clock();
  if (x?.ok && now - x.ok >= 0 && now - x.ok < SERVER_OK_KEEP_MS && !(x.miss && x.miss > x.ok)) return 0;
  if (x?.miss && now - x.miss >= 0 && now - x.miss < SERVER_MISS_KEEP_MS) return 2;
  return 1;
}
function noteServer(id, sid, verdict) {
  if (verdict !== 'ok' && verdict !== 'other') return;
  const k = `${id}|${sid}`;
  const x = serverSeen.get(k) || {};
  if (verdict === 'ok') x.ok = clock(); else x.miss = clock();
  serverSeen.delete(k); serverSeen.set(k, x);   // 최근 것이 뒤로(넘치면 오래된 것부터 버린다)
  if (serverSeen.size > SERVER_SEEN_MAX) serverSeen.delete(serverSeen.keys().next().value);
}
function missHeld(key) {
  const m = missRun.get(key);
  if (!m) return false;
  const age = clock() - m.at;
  if (m.n >= PROBE_MISS_MAX && age >= 0 && age < PROBE_MISS_HOLD_MS) return true;
  if (age < 0 || age >= PROBE_MISS_HOLD_MS) missRun.delete(key);
  return false;
}
const betterWaiting = (key, rank) => { const w = waitingRank.get(key); return !!w && w.slice(0, rank).some((n) => n > 0); };
function addWaiting(key, rank, d) {
  const w = waitingRank.get(key) || [0, 0, 0];
  w[rank] = Math.max(0, w[rank] + d);
  if (w.every((n) => n === 0)) waitingRank.delete(key); else waitingRank.set(key, w);
}

/**
 * @param {object} srv  withResolvedAuth 결과(credAccountId · credVersion · credAccountName · name · host · id)
 * @param {() => Promise<object>} run  실제 접속(시한 포함) — 결과 객체를 돌려준다(던지면 'other' 로 본다)
 * @param {{ feature:string, rejected:(r:object)=>boolean, stopped:(code:string)=>object }} o
 *   stopped — 보내지 않았을 때 돌려줄 결과를 만든다(호출부 모양 — bm-storage `{ok:false, mounts:[] …}` · bm-usage `{ok:false …}`)
 */
export async function gateAccountLogin(srv, run, { feature = '', rejected, stopped } = {}) {
  const id = String(srv?.credAccountId || '');
  const ver = srv?.credVersion;
  if (!id || ver == null) return run();
  const v = String(ver);
  const key = `${id}|${v}`;
  const sid = serverIdOf(srv);
  const rank = rankOf(id, sid);
  let waiting = false;
  try {
    for (let i = 0; i < 100_000; i += 1) {
      const st = accountStopFor(id, v);
      if (st?.unreadable) return stopped('account-state-unreadable');
      if (st) return stopped('account-stopped');
      if (memStopActive(key, id)) return stopped('account-stopped');
      const ok = okVersion.get(id);
      const p = inflight.get(key);
      const age = ok ? clock() - ok.at : -1;
      if (!p && ok && ok.v === v && age >= 0 && age < OK_FRESH_MS) {
        // 빠른 길 — 기다리지 않지만 결과는 본다(거부면 그 자리에서 정지 — 뒤에 오는 접속은 위의 정지 검사에서 막힌다)
        if (waiting) { addWaiting(key, rank, -1); waiting = false; }
        let verdict = 'other';
        try {
          const r = await run();
          verdict = verdictOf(r, rejected);
          return r;
        } finally { settle(srv, id, v, key, verdict, feature); noteServer(id, sid, verdict); if (verdict !== 'other' && verdict !== 'skip') missRun.delete(key); }
      }
      if (sentHeld(key)) return stopped('account-login-unknown');
      if (missHeld(key)) return stopped('account-probe-unreached');
      if (p) {   // 탐침 결과를 보고 다시 판단(거부면 위에서 정지 · 실패면 다음 하나가 탐침)
        if (!waiting) { addWaiting(key, rank, +1); waiting = true; }
        await p; continue;
      }
      // 더 나은 순위(최근에 붙었던 서버)의 대기자가 있으면 한 박자 양보 — 그 대기자가 다음 탐침이 된다
      if (betterWaiting(key, rank)) { await Promise.resolve(); continue; }
      if (waiting) { addWaiting(key, rank, -1); waiting = false; }
      // 이 접속이 탐침이다 — 동기 구간에서 자리를 잡는다(다음 대기자가 같은 틱에 두 번째 탐침이 되지 않게).
      let done;
      inflight.set(key, new Promise((r) => { done = r; }));
      let verdict = 'other';
      try {
        const r = await run();
        verdict = verdictOf(r, rejected);
        return r;
      } finally {
        settle(srv, id, v, key, verdict, feature);
        noteServer(id, sid, verdict);
        if (verdict === 'other') { const m = missRun.get(key); missRun.set(key, { n: (m && clock() - m.at >= 0 && clock() - m.at < PROBE_MISS_HOLD_MS ? m.n : 0) + 1, at: clock() }); } else if (verdict !== 'skip') missRun.delete(key);
        inflight.delete(key);
        done(verdict);
      }
    }
    return stopped('account-stopped');
  } finally { if (waiting) addWaiting(key, rank, -1); }
}

/**
 * 결과 → 판정. 점검 1회차 R2 · T4: 로그인은 됐고 그 뒤에 실패한 결과(`loggedIn: true` 또는 loginMark 표시 — 코어 readServer · 두 폴러)는 ‘성공’ 이다
 * (비밀번호는 받아들여졌다 — ‘모름’ 이면 기다리던 접속을 하나씩 직렬로 풀어 같은 계정 서버 50대가 약 50분 걸렸다).
 */
function verdictOf(r, rejected) {
  if (r?.ok || wasLoggedIn(r)) return 'ok';
  // 접속하지 않은 결과(전역 슬롯 가득 · 주소 없음 · 자격 해석이 막음)는 판정에 넣지 않는다 — 다음 하나가 탐침이 될 뿐 ‘모름’ 연속에 세지 않는다
  if (r?.busy === true || r?.notConnected === true || (typeof r?.authErrorCode === 'string' && r.authErrorCode)) return 'skip';
  if (rejected?.(r)) return 'rejected';
  return wasPasswordSent(r) ? 'sent' : 'other';
}
function sentHeld(key) {
  const at = sentHold.get(key);
  if (at == null) return false;
  const age = clock() - at;
  if (age >= 0 && age < PROBE_MISS_HOLD_MS) return true;
  sentHold.delete(key);
  return false;
}

/** 결과 기록 하나(탐침 · 빠른 길 공통): 성공이면 신선도를 새로 · 거부면 빠른 길을 닫고 계정 단위 정지(못 쓰면 메모리 정지). */
function settle(srv, id, v, key, verdict, feature) {
  if (verdict === 'ok') { okVersion.set(id, { v, at: clock() }); sentRun.delete(key); sentHold.delete(key); return; }
  if (verdict === 'sent') {
    okVersion.delete(id);
    sentHold.set(key, clock());
    const m = sentRun.get(key);
    const n = (m && clock() - m.at >= 0 && clock() - m.at < SENT_RUN_KEEP_MS ? m.n : 0) + 1;
    sentRun.set(key, { n, at: clock() });
    if (n >= SENT_STOP_AFTER) stopAccount(srv, id, v, key, feature, 'timeout');
    return;
  }
  if (verdict !== 'rejected') return;
  okVersion.delete(id); sentRun.delete(key);
  stopAccount(srv, id, v, key, feature, '');
}
function stopAccount(srv, id, v, key, feature, cause) {
  if (memStopActive(key, id) || accountStopFor(id, v)) return;   // 동시에 나간 접속의 거부가 겹쳐도 정지는 한 번(만료된 메모리 정지는 다시 건다 — H1)
  const w = setAccountStop(id, { server: String(srv.name || srv.host || '').slice(0, 128), feature, version: v, accountName: String(srv.credAccountName || ''), cause });
  if (!w?.ok) memStop.set(key, { at: clock(), epoch: accountResumeEpoch(id) });
}

/** 시험용. */
export function _resetAccountGateForTest({ now = null } = {}) { okVersion.clear(); inflight.clear(); memStop.clear(); serverSeen.clear(); missRun.clear(); waitingRank.clear(); sentRun.clear(); sentHold.clear(); clock = typeof now === 'function' ? now : () => Date.now(); }
