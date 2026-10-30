/**
 * bareos/edgeStore.js — **엣지 쪽** 법인 Director 사본(v2.824 엣지 대행). 파일: CONFIG_DIR/bareos-edge-directors.json (0600 · 원자적 쓰기 · 비밀 봉인).
 *
 * 중앙이 이 엣지에 대행을 맡긴 Director(settings agent = 이 엣지)만 담는다 — agent/bareosConfigPull.js 가 5분마다 받아 교체한다.
 * 엣지 자기 화면의 Bareos 설정(bareos.json)과 섞지 않는다(그 파일은 이 엣지 포탈이 스스로 쓰는 Director 다).
 * 엣지 대행 워커(agent/bareosOpWorker.js)는 **이 사본에 있고 담당 = 나** 인 Director 로만 실행한다(작업에는 비밀번호가 없다).
 * 규칙: 로드 손상 → preserveCorrupt + 빈 사본(원본 보존) · 로드 오류 표지 · 받은 원소는 settings 와 같은 모양·검사만 통과한 것.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js';
import { makeLoadError } from '../util/registryCore.js';
import { readDirectorRecord, directorIssue, DIRECTOR_ID_RE, MAX_DIRECTORS } from './settings.js';

export const EDGE_FILE_NAME = 'bareos-edge-directors.json';
const FILE = () => path.join(config.configDir, 'bareos-edge-directors.json'); // 문자열 그대로 — scripts/config-doc.mjs 가 이 모양으로 파일을 찾는다
const lc = (s) => String(s ?? '').trim().toLowerCase();

let _cache = null;
const _loadErr = makeLoadError();

/** 내부 전용(비밀번호 포함). */
export function loadEdgeDirectors() {
  if (_cache) return _cache;
  try {
    if (fs.existsSync(FILE())) {
      const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.directors)) throw new Error('형식 오류');
      const p = openSecretsDeep(raw);
      const directors = [];
      for (const d of p.directors) {
        const id = typeof d?.id === 'string' ? d.id : '';
        if (!DIRECTOR_ID_RE.test(id) || directors.some((x) => x.id === id)) continue;
        const rec = readDirectorRecord(d, id);
        if (rec) directors.push(withEdgeMeta(rec, d));
        if (directors.length >= MAX_DIRECTORS) break;
      }
      _cache = { directors };
      _loadErr.clear();
      return _cache;
    }
  } catch (e) {
    preserveCorrupt(FILE(), e?.message);
    _loadErr.set(e);
    console.warn(`[bareos-edge] 대행 Director 사본을 읽지 못했습니다(${safeLoadText(e) || '사유 미상'}) — 손상본을 보존하고 빈 사본으로 시작합니다(다음 배정 인출이 다시 채웁니다).`);
  }
  _loadErr.checkCorruptOnly(FILE());
  _cache = { directors: [] };
  return _cache;
}
export function edgeStoreLoadError() { loadEdgeDirectors(); return _loadErr.get(); }
export function edgeDirectorById(id) { return loadEdgeDirectors().directors.find((d) => d.id === String(id || '')) || null; }

const SIG_RE = /^[0-9a-f]{16}$/;
/**
 * 사본 원소 표지: edgeCopy(인증 정지 키를 엣지 자기 Director 와 나눈다 — settings.directorCred) · connSig(중앙이 준 접속값 표지 —
 * 작업의 connSig 와 다르면 워커가 배정을 다시 받는다. 모르면 '').
 */
function withEdgeMeta(rec, src) { return { ...rec, edgeCopy: true, connSig: SIG_RE.test(src?.connSig) ? src.connSig : '' }; }

function persist(directors) {
  atomicWriteFileSync(FILE(), JSON.stringify(sealSecretsDeep({ version: 1, directors }), null, 2), { mode: 0o600 });
  _cache = { directors };
  _loadErr.clear();
}

/**
 * 중앙에서 받은 배정 목록으로 사본을 통째로 바꾼다. 담당 = 나(me)가 아닌 원소·모양이 틀린 원소는 받지 않는다.
 * @returns {{ count, rejected, removed: string[], moved: string[] }} moved = 접속처(주소·포트·콘솔)가 바뀐 Director(그 인증 정지 기록을 지운다)
 */
export function applyPulledDirectors(list, me) {
  const before = new Map(loadEdgeDirectors().directors.map((d) => [d.id, d]));
  const next = []; let rejected = 0;
  for (const d of (Array.isArray(list) ? list : []).slice(0, MAX_DIRECTORS)) {
    const id = typeof d?.id === 'string' ? d.id : '';
    if (!DIRECTOR_ID_RE.test(id) || next.some((x) => x.id === id) || lc(d?.agent) !== lc(me)) { rejected += 1; continue; }
    const rec0 = readDirectorRecord(d, id);
    if (!rec0) { rejected += 1; continue; }
    if (typeof d.password === 'string' && d.password) rec0.password = d.password.slice(0, 512);
    const rec = withEdgeMeta(rec0, d);
    if (directorIssue(rec)) { rejected += 1; continue; }
    next.push(rec);
  }
  const ids = new Set(next.map((d) => d.id));
  const removed = [...before.keys()].filter((id) => !ids.has(id));
  const moved = next.filter((d) => { const o = before.get(d.id); return o && (lc(o.host) !== lc(d.host) || Number(o.port) !== Number(d.port) || o.consoleName !== d.consoleName || o.password !== d.password); }).map((d) => d.id);
  persist(next);
  return { count: next.length, rejected, removed, moved };
}

/** 엣지에서 대행한 자동 설정 2단계가 새 콘솔로 접속에 성공했다 — 다음 배정 인출 전 작업이 옛 비밀번호로 실패하지 않게 사본을 바로 갱신한다. */
export function updateEdgeDirectorConn(id, { host, port, consoleName, password }) {
  const list = loadEdgeDirectors().directors.map((d) => ({ ...d }));
  const d = list.find((x) => x.id === id);
  if (!d) return false;
  // 중앙 저장값의 표지는 아직 모른다('' — 다음 작업이 다른 표지를 가져오면 워커가 배정을 다시 받는다)
  Object.assign(d, { host, port, consoleName, password, connSig: '' });
  if (directorIssue(d)) return false;
  persist(list);
  return true;
}

/** 엣지 상태(엣지 로그 spec · 진단) — 비밀 없이 개수·id·이름만. */
export function edgeStoreView() {
  const s = loadEdgeDirectors();
  return { count: s.directors.length, directors: s.directors.map((d) => ({ id: d.id, name: d.name, configured: !!(d.host && d.consoleName && d.password) })) };
}

export function _resetEdgeStoreForTest() { _cache = null; _loadErr.clear(); }
