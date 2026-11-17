/**
 * hostaccess/settings.js — 호스트 접근 제어 설정(`host-access.json`, v2.485).
 * 초안(draft)·적용 상태(applied)·확정 대기(pending)를 한 파일에 둔다. 원자적 쓰기 + preserveCorrupt.
 */
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { makeJsonFileReader } from '../util/jsonFileRead.js';   // 107회차: 읽기 오류 ≠ 손상(공용 읽기 — 30초 간격 재읽기)
import { normalizeSettings } from './render.js';
import { listeningPortalPorts } from '../util/httpsServer.js';
import { parseJsonObject } from '../util/jsonObject.js'; // v3.17.2: 객체가 아닌 JSON(수 · 글자 · 배열)은 깨진 JSON 과 같이 — 손상 보존 경로로

const FILE = path.join(config.configDir, 'host-access.json');
let cache = null;
/*
 * 107회차(재현 — EISDIR): 읽기 오류(EACCES · EIO · EISDIR)는 손상이 아니다 — 예전 catch 하나는 온전한 원본을 .corrupt 로 옮기고 빈 값 · 기본값을 캐시해
 *   다음 저장이 원본 자리를 덮었다. 읽기 단계는 공용 읽기: 원본을 두고 · 캐시하지 않고(30초 간격 재읽기) · 저장을 거절한다(503 settingsUnreadable). parse 실패는 예전과 같다.
 */
const _reader = makeJsonFileReader(() => FILE, { parse: (t) => t, preserve: false, tag: 'host-access' });
let _readErr = '';
/** 107회차: 읽기 오류 중의 저장 거절 본문(503) 또는 null. */
export function hostAccessWriteRefusal() {
  loadHostAccess();
  return _readErr ? { ok: false, status: 503, code: 'settingsUnreadable', readError: true, reason: `호스트 접근 제어 설정 파일(${path.basename(FILE)})을 읽지 못해 저장하지 않았습니다 — 읽기 오류(${_readErr})이고 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽고, 읽히면 저장이 다시 열립니다).` } : null;
}

export function loadHostAccess() {
  if (cache) return cache;
  const rr = _reader.read();
  if (rr.kind === 'read-error') { _readErr = String(rr.error?.code || 'read-error').slice(0, 32); return { draft: normalizeSettings({}, { portalPorts: listeningPortalPorts(config.port) }).settings, applied: null, pending: null }; }   // 107회차: 캐시하지 않는다 — 쓰기는 거절한다
  _readErr = '';
  let raw = {};
  try { if (rr.kind === 'ok') raw = parseJsonObject(rr.value); }
  catch (e) { preserveCorrupt(FILE); console.warn(`[host-access] 설정 로드 실패 — 원본을 .corrupt 로 보존하고 기본값으로 시작합니다: ${safeLoadText(e) || '사유 미상'}`); raw = {}; }
  // v2.731(G2b A4-02): 포탈 포트는 config.port 가 아니라 **실제로 듣는 포트 전부**(TLS_PORT 만 열면 PORT 는 듣지 않는다).
  const { settings } = normalizeSettings(raw.draft || {}, { portalPorts: listeningPortalPorts(config.port) });
  cache = {
    draft: settings,
    applied: raw.applied && typeof raw.applied === 'object' ? raw.applied : null,   // { at, by, fingerprint, rich:[], sshdStopped }
    pending: raw.pending && typeof raw.pending === 'object' ? raw.pending : null,   // { at, deadline, by, fingerprint, rich:[] }
  };
  return cache;
}

export function saveHostAccess(patch) {
  { const no = hostAccessWriteRefusal(); if (no) throw Object.assign(new Error(no.reason), no, { extra: { code: no.code, readError: true } }); }   // 107회차: 읽기 오류 중에는 빈 값 · 기본값 위에 쓰지 않는다
  const cur = loadHostAccess();
  const next = { ...cur, ...patch };
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next;
  return next;
}

export function _resetHostAccessCache() { cache = null; _reader.reset(); _readErr = ''; }
