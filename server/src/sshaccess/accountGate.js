/**
 * sshaccess/accountGate.js — **공통 계정 비밀번호 탐침**(v3.24 반증 F2 — 한 주기 안의 계정 단위 정지).
 *
 * 왜: 폴러는 주기 시작 때 전 서버의 자격을 한꺼번에 해석하고(withResolvedAuth) 결과 기록(outcome.noteCredOutcome)은 주기가 끝난 뒤에 한다.
 *   그래서 같은 공통 계정을 물려받는 서버 N대가 틀린 비밀번호를 **한 주기에 N번** 보냈다(재현 — 가짜 sshd 5대 · 5회) — 계정 단위 정지(설계 §4.4 'AD 잠금 방지')가
 *   다음 주기부터만 들었다. 두 폴러(bm-usage · bm-storage)를 합치면 2N 회다.
 * 하는 일: 같은 계정 · 같은 비밀번호 판(credVersion)으로 가는 접속은 **먼저 간 하나(탐침)** 의 결과를 기다린다.
 *   · 그 판이 이 프로세스에서 한 번이라도 로그인에 성공했으면(ok) 기다리지 않는다(평소 — 동시 수집 그대로). 그래도 **거부를 보면 그 자리에서 정지**한다
 *     (137회차 — AD 에서 비밀번호가 바뀌면 포탈 판은 그대로라 성공 기록이 남아 있다: 이미 떠난 동시 접속만 더 가고 나머지는 보내지 않는다).
 *   · 탐침이 로그인 거부면 그 자리에서 계정 단위 정지를 걸고(state.setAccountStop — outcome 과 같은 기록) 기다리던 접속은 **보내지 않는다**.
 *   · 탐침이 거부도 성공도 아니면(연결 실패 · 시한) 기다리던 접속 중 다음 하나가 새 탐침이 된다(한꺼번에 풀어 N번 보내지 않게).
 *   · 접속 직전에 정지를 다시 본다(주기 시작 때 해석한 뒤 다른 경로 — 한 대로 다시 확인 · 다른 폴러 — 가 건 정지).
 *   · 146회차(141 결정 D1 — 권장안): 성공했던 판은 **유효 시간**(OK_TTL_MS — 그 판의 탐침이 로그인에 성공한 뒤 2분) 동안만 기다리지 않는다.
 *     예전에는 한 번 성공한 판이면 끝까지 탐침을 건너뛰어, AD 에서 비밀번호가 바뀐 직후 이미 떠난 동시 접속 수만큼 틀린 비밀번호가 갔다
 *     (재현 — 동시 8 → 8회 · bm-usage 32 + bm-storage 4 → 첫 주기 최대 약 36회). 지나면 다음 접속이 다시 탐침이고 나머지는 그 **로그인** 결과를 기다린다
 *     (run 이 받는 authed() — 호출부가 로그인 직후 부르면 그때 풀어 준다: 대기 = 계정당 로그인 1회 · 명령 시간까지 기다리지 않는다).
 *     유효 시간은 **탐침의 성공으로만** 새로 연다(성공했던 판의 접속 성공으로 늘리면 쉬지 않고 수집하는 동안 다시 탐침할 때가 오지 않는다) ·
 *     시계가 뒤로 가면(나이 < 0) 지난 것으로 본다(탐침 하나 — 닫히는 쪽). 서버 수만큼 차례로 보내는 상한은 쓰지 않는다(공통 계정 200대 · 800ms RTT 면 주기를 넘는다).
 *   · 성공했던 판의 다시 탐침이 연달아 OTHER_MAX 번 판정을 못 내고 **그 대기의 합이 OTHER_MIN_MS(1분) 이상**이면(시한 — 망 장애) 그 판을 한 유효 시간 동안 예전처럼 믿는다(거부는 듣는다) —
 *     망 장애 때 한 계정의 서버 수만큼 차례로 기다리며 동시 수집 칸을 묶지 않게. 처음 판(성공한 적 없음)은 예전처럼 하나씩 끝까지.
 *     151회차: 빨리 끝나는 실패(접속 거부 · 호스트키 — 폐기 · 재설치 서버)는 합이 하한에 닿지 않아 완화하지 않는다(셋만으로 D1 이 늘 꺼지던 것 — 재현).
 * 키 로그인(credVersion 없음)은 이 문을 지나지 않는다(키 거부는 계정 잠금 횟수에 들지 않는 것이 보통이고, 정지도 비밀번호 판에만 건다).
 * 판정(rejected)은 호출부가 **접속 단계 판정**으로 넘긴다(bm-storage `authFailed` · bm-usage `isSshAuthError` — 명령 출력의 'Permission denied' 로 멈추지 않게 · 반증 F3).
 * 상태는 메모리뿐이다(재시작하면 첫 주기에 다시 탐침 — 그것으로 충분하다). 대기는 장비 시한 **밖**에서 한다(호출부가 run 안에서 시한을 연다).
 */
import { accountStopFor, setAccountStop } from './state.js';

const okVersion = new Map();   // accountId → { v: 성공한 비밀번호 판(문자열), at: 그 판의 탐침이 로그인에 성공한 시각 }
const inflight = new Map();    // `${id}|${ver}` → Promise<'ok' | 'rejected' | 'other'>
const otherRounds = new Map(); // `${id}|${ver}` → { n: 성공했던 판의 다시 탐침이 연달아 판정을 못 낸 수(146회차), ms: 그 탐침들이 걸린 시간의 합(151회차) }
/** 146회차: 성공했던 판을 기다리지 않는 유효 시간 · 다시 탐침이 판정을 못 내도 되는 연속 횟수. */
export const OK_TTL_MS = 120_000;
export const OTHER_MAX = 3;
/**
 * 151회차(146 반증 — 재현): 완화는 판정을 못 낸 다시 탐침들이 **실제로 기다리게 한 시간의 합**이 이 값을 넘을 때만(망 장애 · 시한 — 146 이 막으려던 순차 대기).
 *   횟수만 보면 빨리 끝나는 실패(접속 거부 · 호스트키 · 꺼진 sshd — 폐기 · 재설치 서버)가 등록부 앞에 셋만 있어도 **매 다시 탐침마다** 완화에 들어가
 *   AD 비밀번호가 바뀐 뒤 동시 수만큼 틀린 비밀번호가 갔다(D1 이 그 계정에서 늘 꺼짐 — 실제 bm-storage 주기 4회 · 동시 8 시험 5회). 빠른 실패는 순차여도 거의 기다리지 않는다.
 */
export const OTHER_MIN_MS = 60_000;
const NOOP = () => {};
/** 성공했던 판이 아직 유효한가 — 나이가 음수(시계가 뒤로 감)면 지난 것으로 본다. */
const okFresh = (o, v, now) => !!o && o.v === v && now - o.at >= 0 && now - o.at < OK_TTL_MS;
// 정지 기록을 쓰지 못했을 때(디스크 오류)만 쓰는 메모리 정지 — 1시간. 쓰기가 성공하면 상태 파일이 진실이다(정지 풀기는 그쪽에서).
const memStop = new Map();     // `${id}|${ver}` → 거부를 본 시각
const MEM_STOP_MS = 3_600_000;

/** 정지로 보내지 않은 결과의 꼴 — 자격 해석이 막은 결과와 같다(authErrorCode — 사용 기록 · 인증 정지 판정에 들지 않는다). */
export const GATE_STOPPED = Object.freeze({ code: 'account-stopped' });

/**
 * @param {object} srv  withResolvedAuth 결과(credAccountId · credVersion · credAccountName · name · host)
 * @param {(authed:() => void) => Promise<object>} run  실제 접속(시한 포함) — 결과 객체를 돌려준다(던지면 'other' 로 본다).
 *   authed — 로그인에 성공한 직후 부르면 탐침의 판정을 그때 낸다(146회차 — 기다리던 접속이 명령 시간까지 기다리지 않게 · 부르지 않으면 run 이 끝날 때).
 * @param {{ feature:string, rejected:(r:object)=>boolean, stopped:(code:string)=>object }} o
 *   stopped — 보내지 않았을 때 돌려줄 결과를 만든다(호출부 모양 — bm-storage `{ok:false, mounts:[] …}` · bm-usage `{ok:false …}`)
 */
export async function gateAccountLogin(srv, run, { feature = '', rejected, stopped } = {}) {
  const id = String(srv?.credAccountId || '');
  const ver = srv?.credVersion;
  if (!id || ver == null) return run(NOOP);
  const v = String(ver);
  const key = `${id}|${v}`;
  // 거부를 본 자리에서 정지(탐침 · 성공했던 판의 접속 모두 — 같은 기록 · 쓰기 실패면 메모리 정지)
  const noteRejected = () => {
    if (okVersion.get(id)?.v === v) okVersion.delete(id);
    const w = setAccountStop(id, { server: String(srv.name || srv.host || '').slice(0, 128), feature, version: v, accountName: String(srv.credAccountName || '') });
    if (!w?.ok) memStop.set(key, Date.now());
  };
  for (let i = 0; i < 10_000; i += 1) {
    const st = accountStopFor(id, v);
    if (st?.unreadable) return stopped('account-state-unreadable');
    if (st) return stopped('account-stopped');
    const ms = memStop.get(key);
    if (ms != null && Date.now() - ms < MEM_STOP_MS) return stopped('account-stopped');
    const prevOk = okVersion.get(id);
    if (okFresh(prevOk, v, Date.now())) {
      // 137회차(재현): 성공했던 판은 기다리지 않지만 **거부는 듣는다** — AD 에서 비밀번호가 바뀌면(포탈 판은 그대로) 성공 기록 때문에 탐침을 건너뛰어
      //   한 주기에 서버 수만큼(두 폴러면 2배) 틀린 비밀번호를 보냈다(정지는 주기가 끝난 뒤 outcome 에서야 걸렸다). 지금 동시에 떠난 접속만 더 간다.
      //   146회차: 그것도 유효 시간 안에서만(머리말) — 지나면 아래 탐침으로 간다.
      const r = await run(NOOP);
      if (!r?.ok && rejected?.(r)) noteRejected();
      return r;
    }
    const p = inflight.get(key);
    if (p) { await p; continue; }   // 탐침 결과를 보고 다시 판단(거부면 위에서 정지 · 실패면 다음 하나가 탐침)
    // 이 접속이 탐침이다 — 동기 구간에서 자리를 잡는다(다음 대기자가 같은 틱에 두 번째 탐침이 되지 않게).
    let done;
    const mine = new Promise((r) => { done = r; });
    inflight.set(key, mine);
    const hadOk = !!prevOk && prevOk.v === v;   // 성공했던 판의 다시 탐침(146회차)
    const t0 = Date.now();                       // 151회차: 이 탐침이 기다리게 한 시간(완화 하한)
    let settled = false;
    // 판정은 한 번만 — 로그인 직후(authed) 또는 run 이 끝날 때. 자리도 그때 한 번 비운다(먼저 풀린 뒤 새 탐침이 잡은 자리를 run 끝에 지우지 않게).
    const settle = (verdict) => {
      if (settled) return;
      settled = true;
      if (verdict === 'ok') { okVersion.set(id, { v, at: Date.now() }); otherRounds.delete(key); }
      else if (verdict === 'rejected') { otherRounds.delete(key); noteRejected(); }
      else if (hadOk) {
        const prev = otherRounds.get(key) || { n: 0, ms: 0 };
        const cur = { n: prev.n + 1, ms: prev.ms + Math.max(0, Date.now() - t0) };   // 시계가 뒤로 가면 0(완화 쪽으로 세지 않는다)
        if (cur.n >= OTHER_MAX && cur.ms >= OTHER_MIN_MS) { otherRounds.delete(key); okVersion.set(id, { v, at: Date.now() }); } else otherRounds.set(key, cur);
      }
      inflight.delete(key);
      done(verdict);
    };
    let verdict = 'other';
    try {
      const r = await run(() => settle('ok'));
      verdict = r?.ok ? 'ok' : (rejected?.(r) ? 'rejected' : 'other');
      if (settled && verdict === 'rejected') noteRejected();   // 로그인 뒤의 거부 판정(있어서는 안 된다) — 성공했던 판의 거부와 같이 멈춘다
      return r;
    } finally {
      settle(verdict);
    }
  }
  return stopped('account-stopped');
}

/** 시험용. */
export function _resetAccountGateForTest() { okVersion.clear(); inflight.clear(); memStop.clear(); otherRounds.clear(); }
