/**
 * storage/sampleDiag.js — 어레이 5분 표본의 '마지막 시도' 진단(v3.36.1 — 사용자 신고 '사용량이 보이지 않음' · Unity 인터페이스 화면).
 *
 * 왜: 표본의 probe(지표 경로별 항목 수 · 오류)는 DB 에 남지 않아, 포트 사용량이 비었을 때 화면이 이유를 말하지 못했다
 *   (실제 현장 — 496 포트 전부 '사용량 못 읽음' 인데 사유 칸이 비거나 '아직 표본이 없습니다' 로 틀리게 말했다).
 *   장비마다 마지막 시도 한 건만 메모리에 둔다(재시작하면 다음 주기에 다시 찬다 — 기록이 아니라 진단용).
 *
 * 들어오는 곳: 로컬 폴러(storage/nodeLoadPoller.js sampleOne — 성공 · 실패 모두) · 중앙 수신(central/storageEdge.js — 엣지가 올린 표본, 성공만).
 * 엣지에서 실패한 표본은 중앙에 오지 않는다 — 그 경우 화면은 '중앙에 표본이 없음 · 엣지 로그 확인' 으로 말한다(단정하지 않는다).
 * 저장 모양은 작게: 글자는 자르고, 경로 · 오류는 상한(외부 입력 — 엣지 · 장비 응답).
 */
import { numOrNull } from '../util/numOrNull.js';

const MAX_DEVICES = 2_000;
const _map = new Map();
const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : (typeof v === 'number' && Number.isFinite(v) ? String(v) : ''));

/** 표본(또는 실패) → 작은 진단 모양(순수). kinds = 단위 종류별 개수(sp · port · eth …). */
export function diagOf({ at = Date.now(), ok = false, error = '', sample = null, source = 'local' } = {}) {
  const kinds = {};
  for (const u of Array.isArray(sample?.units) ? sample.units.slice(0, 256) : []) {
    const k = typeof u?.kind === 'string' && /^[a-z]{0,8}$/.test(u.kind) ? (u.kind || 'unknown') : 'unknown';
    kinds[k] = (kinds[k] || 0) + 1;
  }
  const p = sample?.probe && typeof sample.probe === 'object' && !Array.isArray(sample.probe) ? sample.probe : {};
  const paths = {};
  if (p.paths && typeof p.paths === 'object' && !Array.isArray(p.paths)) {
    for (const [k, v] of Object.entries(p.paths).slice(0, 16)) if (/^[A-Za-z]{1,24}$/.test(k)) paths[k] = typeof v === 'number' ? v : s(v, 16);
  }
  const errors = Array.isArray(p.errors) ? p.errors.slice(0, 6).map((e) => s(e, 160)).filter(Boolean) : [];
  return {
    at: numOrNull(at) ?? Date.now(), ok: !!ok, source: s(source, 16), error: s(error, 200), kinds, paths, errors,
    counterNote: s(p.counterNote, 160), fcPath: s(p.fcPath, 40),
  };
}
export function noteSampleDiag(deviceId, d) {
  const id = s(deviceId, 128);
  if (!id) return;
  _map.delete(id);
  _map.set(id, diagOf(d));
  while (_map.size > MAX_DEVICES) _map.delete(_map.keys().next().value);
}
export function sampleDiagOf(deviceId) { return _map.get(String(deviceId ?? '')) || null; }
export function _resetSampleDiagForTest() { _map.clear(); }
