/**
 * sshaccess/accountGate.js — **공통 계정 비밀번호 탐침**(v3.24 반증 F2 — 한 주기 안의 계정 단위 정지).
 *
 * 왜: 폴러는 주기 시작 때 전 서버의 자격을 한꺼번에 해석하고(withResolvedAuth) 결과 기록(outcome.noteCredOutcome)은 주기가 끝난 뒤에 한다.
 *   그래서 같은 공통 계정을 물려받는 서버 N대가 틀린 비밀번호를 **한 주기에 N번** 보냈다(재현 — 가짜 sshd 5대 · 5회) — 계정 단위 정지(설계 §4.4 'AD 잠금 방지')가
 *   다음 주기부터만 들었다. 두 폴러(bm-usage · bm-storage)를 합치면 2N 회다.
 * 하는 일: 같은 계정 · 같은 비밀번호 판(credVersion)으로 가는 접속은 **먼저 간 하나(탐침)** 의 결과를 기다린다.
 *   · 그 판이 이 프로세스에서 한 번이라도 로그인에 성공했으면(ok) 기다리지 않는다(평소 — 동시 수집 그대로).
 *   · 탐침이 로그인 거부면 그 자리에서 계정 단위 정지를 걸고(state.setAccountStop — outcome 과 같은 기록) 기다리던 접속은 **보내지 않는다**.
 *   · 탐침이 거부도 성공도 아니면(연결 실패 · 시한) 기다리던 접속 중 다음 하나가 새 탐침이 된다(한꺼번에 풀어 N번 보내지 않게).
 *   · 접속 직전에 정지를 다시 본다(주기 시작 때 해석한 뒤 다른 경로 — 한 대로 다시 확인 · 다른 폴러 — 가 건 정지).
 * 키 로그인(credVersion 없음)은 이 문을 지나지 않는다(키 거부는 계정 잠금 횟수에 들지 않는 것이 보통이고, 정지도 비밀번호 판에만 건다).
 * 판정(rejected)은 호출부가 **접속 단계 판정**으로 넘긴다(bm-storage `authFailed` · bm-usage `isSshAuthError` — 명령 출력의 'Permission denied' 로 멈추지 않게 · 반증 F3).
 * 상태는 메모리뿐이다(재시작하면 첫 주기에 다시 탐침 — 그것으로 충분하다). 대기는 장비 시한 **밖**에서 한다(호출부가 run 안에서 시한을 연다).
 */
import { accountStopFor, setAccountStop } from './state.js';

const okVersion = new Map();   // accountId → 성공한 비밀번호 판(문자열)
const inflight = new Map();    // `${id}|${ver}` → Promise<'ok' | 'rejected' | 'other'>
// 정지 기록을 쓰지 못했을 때(디스크 오류)만 쓰는 메모리 정지 — 1시간. 쓰기가 성공하면 상태 파일이 진실이다(정지 풀기는 그쪽에서).
const memStop = new Map();     // `${id}|${ver}` → 거부를 본 시각
const MEM_STOP_MS = 3_600_000;

/** 정지로 보내지 않은 결과의 꼴 — 자격 해석이 막은 결과와 같다(authErrorCode — 사용 기록 · 인증 정지 판정에 들지 않는다). */
export const GATE_STOPPED = Object.freeze({ code: 'account-stopped' });

/**
 * @param {object} srv  withResolvedAuth 결과(credAccountId · credVersion · credAccountName · name · host)
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
  for (let i = 0; i < 10_000; i += 1) {
    const st = accountStopFor(id, v);
    if (st?.unreadable) return stopped('account-state-unreadable');
    if (st) return stopped('account-stopped');
    const ms = memStop.get(key);
    if (ms != null && Date.now() - ms < MEM_STOP_MS) return stopped('account-stopped');
    if (okVersion.get(id) === v) return run();
    const p = inflight.get(key);
    if (p) { await p; continue; }   // 탐침 결과를 보고 다시 판단(거부면 위에서 정지 · 실패면 다음 하나가 탐침)
    // 이 접속이 탐침이다 — 동기 구간에서 자리를 잡는다(다음 대기자가 같은 틱에 두 번째 탐침이 되지 않게).
    let done;
    inflight.set(key, new Promise((r) => { done = r; }));
    let verdict = 'other';
    try {
      const r = await run();
      verdict = r?.ok ? 'ok' : (rejected?.(r) ? 'rejected' : 'other');
      return r;
    } finally {
      if (verdict === 'ok') okVersion.set(id, v);
      else if (verdict === 'rejected') {
        okVersion.delete(id);
        const w = setAccountStop(id, { server: String(srv.name || srv.host || '').slice(0, 128), feature, version: v, accountName: String(srv.credAccountName || '') });
        if (!w?.ok) memStop.set(key, Date.now());
      }
      inflight.delete(key);
      done(verdict);
    }
  }
  return stopped('account-stopped');
}

/** 시험용. */
export function _resetAccountGateForTest() { okVersion.clear(); inflight.clear(); memStop.clear(); }
