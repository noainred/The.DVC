/**
 * storage/restSampleGate.js — SSH 로 등록한 Unity 의 5분 표본을 REST 로 읽을 때의 '멈춤' 기록(v3.46.0).
 *
 * 사용자 요청(2026-11-26): "SSH 장비도 사용량은 REST 로 읽게 해줘, 안되면 SSH 로 진행" + 선택 'SSH 계정 그대로'.
 * 그 SSH 계정이 Unisphere 계정이 아닐 수 있다(예: service) — 그때 5분마다 REST 로그인을 다시 시도하면 실패 로그인이 쌓인다.
 *
 * 규칙(CLAUDE.md '인증 실패는 주기 수집을 멈춘다 · 자동 재시도 금지(계정 잠금)'):
 *  · REST 가 인증을 거절(401/403)하면 **그 장비의 REST 표본만** 멈춘다 — 자격증명 지문(host · 계정 · 비밀번호)이 바뀔 때까지.
 *    ⚠ 장비 인증 정지(storage/authGuard.js)는 걸지 않는다 — 걸면 SSH 용량 · 상태 수집까지 멈춘다(그 계정은 SSH 로는 맞는 계정이다).
 *  · 접속 · 시한 · TLS 같은 비인증 실패는 시한부(기본 1시간)로만 건너뛴다(그 사이엔 SSH 로 읽는다).
 *  · 메모리 기록이다 — 재시작하면 REST 를 한 번 다시 시도한다(재시작당 실패 로그인 최대 1회 — 정직 기록).
 */
import crypto from 'node:crypto';

export const REST_RETRY_MS = 60 * 60_000;
const MAX = 2_000;
const _m = new Map();   // deviceId → { kind:'auth'|'net', fp, at, until|null, detail }

/** 자격증명 지문(비밀번호를 담지 않는다 — 해시 앞 16자). host · 포트 · 계정 · 비밀번호 중 하나라도 바뀌면 달라진다. */
export function credFp(dev) {
  const s = [dev?.host || '', String(dev?.restPort || ''), dev?.username || '', dev?.password || ''].join('\u0000');
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}
/** 지금 REST 를 건너뛸 이유(순수 — 기록이 없거나 풀렸으면 null). */
export function restSkipReason(dev, now = Date.now()) {
  const r = _m.get(String(dev?.id ?? ''));
  if (!r) return null;
  if (r.fp !== credFp(dev)) { _m.delete(String(dev.id)); return null; }   // 자격증명이 바뀌면 다시 시도한다
  if (r.kind === 'net' && r.until != null && now >= r.until) { _m.delete(String(dev.id)); return null; }
  return { kind: r.kind, at: r.at, until: r.until, detail: r.detail };
}
export function markRestFailed(dev, { auth = false, detail = '', now = Date.now() } = {}) {
  const id = String(dev?.id ?? '');
  if (!id) return;
  _m.delete(id);
  _m.set(id, { kind: auth ? 'auth' : 'net', fp: credFp(dev), at: now, until: auth ? null : now + REST_RETRY_MS, detail: String(detail || '').slice(0, 160) });
  while (_m.size > MAX) _m.delete(_m.keys().next().value);
}
export function clearRestFailed(dev) { _m.delete(String(dev?.id ?? '')); }
export function _resetRestGateForTest() { _m.clear(); }
