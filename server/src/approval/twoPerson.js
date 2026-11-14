/**
 * approval/twoPerson.js — 두 사람 승인의 **실행 쪽**(v3.10.0). 저장은 `approval/store.js`, 여기는 ‘승인되면 무엇을 실행하나’ 를 종류(kind)마다 등록받아 돌린다.
 *
 *   registerKind('ssh-key-rotate', { label, run(payload, { by, request }) → {ok,…}, discard?(payload, why) })
 *   submit({ kind, title, target, corp, payload, by, required }, runNow)
 *       required 가 거짓이면 runNow() 를 바로 실행(두 사람 승인이 꺼진 설치 — 본인 OTP 만).
 *       참이면 요청을 만들고 { ok:true, pending:true, request } 를 돌려준다(실행은 다른 설정 소유자가 승인할 때).
 *   approve(id, { by, digest, note }) → 승인 기록 → run → 결과 기록
 *   reject(id, { by, note })         → 돌려보냄(요청자 본인이면 ‘취소’) → discard
 *   expireSweep()                    → 시한이 지난 요청을 확정 → discard
 *
 * 규칙: 실행 함수는 **요청 본문(payload)만** 본다(승인 시점의 요청 본문 = 요청 때 본문 — store 가 지문으로 묶는다). 승인 요청의 본문에 비밀을 넣지 않는다.
 * 등록되지 않은 종류의 요청은 승인할 수 없다(모르는 것을 실행하지 않는다).
 */
import * as AP from './store.js';

const kinds = new Map();
/** @param {string} kind @param {{label:string, run:Function, discard?:Function}} def */
export function registerKind(kind, def) { if (def && typeof def.run === 'function') kinds.set(String(kind), def); }
export function kindLabel(kind) { return kinds.get(String(kind))?.label || String(kind); }
export function _resetKindsForTest() { kinds.clear(); }

export async function submit({ kind, title, target, corp = '', payload = {}, by = '', required = true } = {}, runNow) {
  if (!required) return runNow();
  if (!kinds.has(String(kind))) return { ok: false, code: 'unknown-kind', status: 500, reason: '승인 절차가 등록되지 않은 동작입니다.' };
  const r = AP.createRequest({ kind, title, target, corp, payload, by });
  if (!r.ok) return r;
  return { ok: true, pending: true, request: r.request };
}

export async function approve(id, { by = '', digest = '', note = '' } = {}) {
  const cur = AP.getRequest(id);
  if (cur && !kinds.has(cur.kind)) return { ok: false, code: 'unknown-kind', status: 409, reason: '이 포탈이 모르는 종류의 요청입니다 — 실행하지 않았습니다.' };
  const d = AP.decide(id, { by, approve: true, digest, note });
  if (!d.ok) return d;
  let res;
  try { res = await kinds.get(d.request.kind).run(d.request.payload, { by, request: d.request }); }
  catch (e) { res = { ok: false, code: 'error', reason: `실행 중 오류(${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 120)})` }; }
  const ok = !!(res && res.ok);
  // 결과 기록에 실패하면 응답에 밝힌다(점검 C-8 — 실행은 됐는데 기록이 ‘승인됨’ 에 멈추면 10분 뒤 ‘중단’ 으로 확정된다).
  const mk = AP.markExecuted(id, { ok, code: ok ? 'ok' : res?.code, reason: ok ? '' : res?.reason });
  const recordFailed = !(mk && mk.ok);
  // 승인은 됐지만 실행이 실패하면 요청은 ‘failed’ 로 끝난다(다시 하려면 새 요청) — 뒷정리도 한다.
  if (!ok) { try { kinds.get(d.request.kind).discard?.(d.request.payload, 'failed'); } catch { /* 뒷정리 실패는 결과를 바꾸지 않는다 */ } }
  return { ok, request: AP.getRequest(id), result: res, ...(recordFailed ? { recordFailed: true, recordReason: String(mk?.reason || '').slice(0, 200) } : {}),
    ...(ok ? {} : { code: res?.code || 'failed', status: res?.status || 409, reason: res?.reason || '실행하지 못했습니다.' }) };
}

export function reject(id, { by = '', note = '' } = {}) {
  const d = AP.decide(id, { by, approve: false, note });
  if (!d.ok) return d;
  try { kinds.get(d.request.kind)?.discard?.(d.request.payload, d.request.status); } catch { /* */ }
  return { ok: true, request: d.request };
}

/** 시한이 지난 요청을 확정하고 뒷정리한다(주기 점검이 부른다). 확정한 요청 목록. */
export function expireSweep({ now = Date.now() } = {}) {
  const due = AP.expireDue({ now });
  for (const r of due) { try { kinds.get(r.kind)?.discard?.(r.payload, r.interrupted ? 'interrupted' : 'expired'); } catch { /* */ } }
  return due;
}
