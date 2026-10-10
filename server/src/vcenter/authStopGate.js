/**
 * 주문형 vCenter 성능 조회가 **인증 실패 정지**(vcAuthGuard)를 따르게 하는 공용 판정(v2.733 점검 3회차 C3-01).
 *
 * 왜 있나: v2.591 이 `/vms/:id/metrics`·`/hosts/:id/metrics` 에만 '주 폴러가 멈춘 vCenter 에는 로그인하지 않고 409,
 * 거부는 같은 기록에 올린다' 를 넣었다(routes/api/vmMetrics.js 의 인라인 함수 두 개). 형제 주문형 경로 다섯 곳 —
 * 최적화 표 스파크라인(`POST /tools/waste/spark` — **VM 1대마다 로그인**)·VM 트리 기간 사용률(`POST /vms/usage`)·
 * 호스트/클러스터 추이(`GET /vcenters/:id/usage-history?scope=`)·축소 근거 리포트(`GET /tools/rightsize`)·
 * 유휴 VM 평균(`POST /tools/vm-finder withAvg` — VM 1대마다 day·week 2회) — 는 정지를 보지 않아, 비밀번호가 바뀐 뒤
 * 화면을 여는 것만으로 vCenter SSO 에 실패 로그인이 수십~수백 회 나갔다(재현: 합계 112회, 정지 기록의 시도 수는 1 그대로).
 * 같은 계정이라 SSO 잠금 정책(기본 180초 5회)이면 서비스 계정이 잠겨 **비밀번호를 고친 뒤에도 수집이 실패**한다.
 *
 * 판정은 여기 하나다 — 경로마다 20줄을 복사하지 않는다(server/CLAUDE.md '코어는 하나다').
 *  · 정지 조회는 **읽기 전용**(`peekAuthStop`) — 기록을 지우지 않는다. 해제는 주 폴러·연결 테스트만 한다. 사람이 비밀번호를
 *    고치면 자격증명 해시가 달라져 peek 이 null 이 되므로(authGuard 규칙 2) 그때부터 다시 조회한다.
 *  · 자격증명 거부(`isVcAuthError` — 출처에서 못 박은 플래그만)는 주 폴러와 **같은 기록**에 시도를 올린다.
 *    타임아웃·연결 실패·5xx 는 멈추지 않는다(authGuard 규칙 4 — 일시 장애가 조회를 영구 정지시키지 않게).
 *  · 한 요청 안에서는 vCenter 마다 **첫 시도의 결과를 본 뒤** 나머지를 시작한다(`createVcAuthGate`) — 동시성 6 으로
 *    보내면 정지 기록이 생기기 전에 실패 로그인이 6회 나간다. 자격증명이 맞으면 첫 시도 뒤 예전처럼 동시에 돈다.
 */
import { vcAuthGuard, isVcAuthError } from './restClient.js';

/** 정지 중이라 조회하지 않았다 — 화면이 그대로 쓰는 문장(vmMetrics.js v2.591 문구와 같다). */
export const authStoppedReason = (attempts) =>
  `vCenter 인증 실패로 멈춰 있어 조회하지 않았습니다(실패 ${attempts}회). 비밀번호를 고치거나 설정 › vCenter 연결 테스트가 성공하면 다시 조회합니다.`;

const view = (rec, reason) => ({ authStopped: true, since: rec.since, at: rec.at, attempts: rec.attempts, reason });

/** 이 vCenter 가 인증 정지 상태인가(읽기 전용). 정지면 표지 `{authStopped, since, at, attempts, reason}`, 아니면 null. */
export function vcAuthStopOf(vc) {
  const st = vc ? vcAuthGuard.peekAuthStop(vc) : null;
  return st ? view(st, authStoppedReason(st.attempts)) : null;
}

/** 오류가 vCenter 자격증명 거부면 주 폴러와 같은 기록에 올리고 표지를, 아니면 null 을 돌려준다. */
export function noteVcAuthFailure(vc, err) {
  if (!vc?.id || !isVcAuthError(err)) return null;
  const rec = vcAuthGuard.markAuthStopped(vc.id, vc, err.message);
  return view(rec, `vCenter 인증 실패 — ${err.message}`);
}

/** 응답 본문용 — `{ok:false, ...표지}`. */
export const authStopBody = (info) => ({ ok: false, ...info });

/**
 * 단건 라우트: 정지면 **409**(재시도 대상이 아니다 — 웹 fetchJson 은 502 를 2회 재시도해 실패 로그인이 3배가 된다)를
 * 보내고 true. `allowManual` 이면 사람이 누른 `manual=1` 은 막지 않는다(성능 모달 '다시 조회' — v2.591 규칙 3).
 */
export function respondIfVcAuthStopped(req, res, vc, { allowManual = false } = {}) {
  if (allowManual && req.query?.manual === '1') return false;
  const info = vcAuthStopOf(vc);
  if (!info) return false;
  res.status(409).json(authStopBody(info));
  return true;
}

/** 단건 라우트 오류: 자격증명 거부면 기록에 올리고 409, 그 밖은 502(`prefix` + 원문). */
export function respondVcError(res, vc, err, { prefix = '' } = {}) {
  const info = noteVcAuthFailure(vc, err);
  if (info) return res.status(409).json(authStopBody(info));
  return res.status(502).json({ ok: false, reason: `${prefix}${err?.message || err}` });
}

/**
 * 한 요청 안의 vCenter 별 문(gate) — 여러 VM·vCenter 를 도는 주문형 조회용.
 *
 *   const gate = createVcAuthGate();
 *   const r = await gate.run(vc, () => fetchSomething(vc, ...));
 *   // r = { value } | { error } | { error, stopped } | { skipped: true, stopped }
 *   gate.stopped()  // { [vcId]: {since, at, attempts, reason} } — 응답 authStopped 로 싣는다
 *
 * · 처음 보는 vCenter 는 정지 기록을 먼저 본다 — 정지면 fn 을 부르지 않는다(로그인 0).
 * · 정지가 아니면 그 vCenter 의 **첫 호출만** 시작하고 같은 vCenter 의 나머지는 그 결과를 기다린다. 첫 호출이 자격증명
 *   거부면 기록에 올리고 나머지는 시작하지 않는다(실패 로그인 1회). 그 밖의 결과면 나머지가 그대로 돈다.
 * · 첫 호출 뒤에 거부가 나와도 같은 기록에 올리고 그 뒤 호출은 건너뛴다(이미 시작한 동시 호출은 끝까지 간다 — 정직 기록).
 */
export function createVcAuthGate() {
  const state = new Map(); // vcId -> { stop: info|null, first: Promise|null }
  const attempt = async (vc, s, fn) => {
    try { return { value: await fn() }; } catch (error) {
      const info = noteVcAuthFailure(vc, error);
      if (info) s.stop = info;
      return info ? { error, stopped: info } : { error };
    }
  };
  return {
    async run(vc, fn) {
      const id = String(vc?.id || '');
      let s = state.get(id);
      if (!s) {
        s = { stop: vcAuthStopOf(vc), first: null };
        state.set(id, s);
        if (!s.stop) {
          let release;
          s.first = new Promise((r) => { release = r; });
          try { return await attempt(vc, s, fn); } finally { release(); }
        }
      }
      if (s.first) await s.first;
      if (s.stop) return { skipped: true, stopped: s.stop };
      return attempt(vc, s, fn);
    },
    /** 이 요청에서 정지로 확인된 vCenter → 표지(이유 문장 포함). 없으면 빈 객체. */
    stopped() {
      const out = {};
      for (const [id, s] of state) if (s.stop) out[id] = { since: s.stop.since, at: s.stop.at, attempts: s.stop.attempts, reason: s.stop.reason };
      return out;
    },
    isStopped(vcId) { return !!state.get(String(vcId || ''))?.stop; },
  };
}
