/**
 * storage/activityLog.js — 스토리지 수집 '작업 로그'(v2.315, 사용자 요구 '진행중/완료 창').
 *
 * 왜 필요한가: store.js 는 장비별 **최신 스냅샷 1건만** 보관하므로 '과거에 언제 수집했고
 * 성공/실패였나'는 남지 않는다. 이 모듈이 각 수집 실행(중앙 직접 = poller.collectOne,
 * 엣지 push 수신 = central/storageEdge.saveEdgeStorage) 을 시간순 링버퍼로 남겨 화면의
 * '완료(로그)' 구획의 원천이 된다. '진행중'은 poller 의 in-flight 집합이 담당(여긴 완료분).
 *
 * 저장: 인메모리 + 파일 영속(storage-activity.json, 0600). 손상 시 재생성 가능한 캐시 성격이라
 * preserveCorrupt 불필요. 링버퍼 상한 MAX 로 무한 증가를 막는다(오래된 것부터 폐기) — 매 폴
 * 주기마다 장비 수만큼 쌓이므로 상한이 없으면 파일이 계속 커진다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'storage-activity.json');
const MAX = Math.max(50, Number(process.env.STORAGE_ACTIVITY_MAX) || 500);
let _buf = null;

function load() {
  if (_buf) return _buf;
  try {
    const a = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    _buf = Array.isArray(a) ? a.slice(-MAX) : []; // 과거 파일이 상한을 넘겨도 로드 시 절단
  } catch { _buf = []; } // 없거나 손상 — 새로 시작(재생성 가능)
  return _buf;
}

/**
 * 수집 완료 이벤트 1건 기록.
 * @param {{deviceId,name,host,source,ok,nodes,usedBytes,totalBytes,durationMs,error,at}} evt
 *   source: 'central'(중앙 직접) 또는 엣지 이름. at 미지정 시 현재 시각(엣지 이벤트는 수집 시각).
 */
export function recordActivity(evt = {}) {
  const buf = load();
  const e = {
    at: Number(evt.at) || Date.now(),
    deviceId: String(evt.deviceId || ''),
    name: String(evt.name || evt.deviceId || ''),
    host: String(evt.host || ''),
    source: String(evt.source || 'central'),
    ok: !!evt.ok,
    nodes: Number.isFinite(evt.nodes) ? evt.nodes : null,
    usedBytes: Number.isFinite(evt.usedBytes) ? evt.usedBytes : null,
    totalBytes: Number.isFinite(evt.totalBytes) ? evt.totalBytes : null,
    durationMs: Number.isFinite(evt.durationMs) ? evt.durationMs : null,
    error: evt.error ? String(evt.error).slice(0, 300) : null, // 오류 문구 상한(로그 비대 방지)
  };
  buf.push(e);
  if (buf.length > MAX) buf.splice(0, buf.length - MAX); // 오래된 것부터 폐기(링버퍼)
  try { atomicWriteFileSync(FILE, JSON.stringify(buf), { mode: 0o600 }); }
  catch { /* 영속 실패는 무시 — 인메모리 로그는 유지(파일은 다음 기록에서 재시도) */ }
  return e;
}

/** 최근 이벤트 newest-first (limit 상한, 기본 100). */
export function listActivity(limit = 100) {
  const n = Math.max(1, Math.min(MAX, Number(limit) || 100));
  return load().slice(-n).reverse();
}

export function _resetForTest() { _buf = null; }
