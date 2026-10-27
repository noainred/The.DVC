/**
 * veeam/em/mapping.js — EM 백업 서버 매핑(v2.788.1 — 사용자 요청 'EM 에 연결된 백업 서버 매핑하는 기능').
 *   EM 이 아는 B&R 서버마다 사람이 정한다: ① 백업하는 vCenter(법인) ② 포탈에 등록된 어느 B&R 서버와 같은가(이름이 달라 자동 짝짓기가 못 찾을 때).
 *   CONFIG_DIR/veeam-em-map.json · 키 = '<EM id>|<백업 서버 이름 소문자>'(EM 안에서 이름이 하나뿐이다) · 패턴은 veeam/backupMarks.js
 *   (rev · 원자적 쓰기 · 로드 손상 보존 · 손상이면 쓰기 거부 503).
 *
 *  · br: ''(자동 — 이름으로 짝짓기) · '<B&R 서버 id>'(수동) · 'none'(포탈에 없음으로 확정 — 이름이 같아도 짝짓지 않는다)
 *  · vcenterIds: 비면 자동(짝지어진 B&R 등록의 vCenter 를 따른다) · 있으면 그것(수동)
 *  · 둘 다 비면 항목을 지운다(false 를 쌓지 않는다). 비밀은 없다(이름·id 만).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../../util/atomicWrite.js';

const FILE = () => path.join(config.configDir, 'veeam-em-map.json');
export const MAX_ENTRIES = 2000;
export const MAX_VCENTERS = 64;

let cache = null;
let rev = 0;
let unreadable = false;
export function emMapRev() { return rev; }
export function emMapUnreadable() { load(); return unreadable; }

function load() {
  if (cache) return cache;
  cache = {};
  const f = FILE();
  try {
    if (fs.existsSync(f)) {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.servers !== 'object' || Array.isArray(d.servers)) throw new Error('형식 오류');
      cache = d.servers || {};
    }
  } catch (e) { preserveCorrupt(f, e.message); cache = {}; unreadable = true; }
  return cache;
}

/** 키 — EM id + 백업 서버 이름(앞뒤 공백·대소문자 무시). */
export const mapKey = (emId, server) => `${String(emId || '')}|${String(server || '').trim().toLowerCase()}`;
/** 전체 맵 { key: { vcenterIds, br, server, by, at } }. */
export function getEmMap() { return load(); }

/**
 * 한 줄 저장. 검증은 호출부가 넘긴 목록으로(알려진 vCenter · 등록된 B&R) — 모르는 값은 400(조용히 버리지 않는다).
 * @returns {{ok:true, entry:object|null} | {ok:false, status:number, reason:string, code?:string}}
 */
export function setEmMap({ emId, server, vcenterIds, br }, { knownVcenters = [], knownBr = [], user } = {}) {
  const name = String(server || '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 120); // eslint-disable-line no-control-regex
  if (!emId || !name) return { ok: false, status: 400, reason: 'EM 과 백업 서버를 고르세요.' };
  if (vcenterIds != null && !Array.isArray(vcenterIds)) return { ok: false, status: 400, reason: 'vCenter 목록 형식이 올바르지 않습니다.' };
  const vcs = [...new Set((vcenterIds || []).map((v) => String(v)))];
  if (vcs.length > MAX_VCENTERS) return { ok: false, status: 400, reason: `vCenter 는 ${MAX_VCENTERS}개까지입니다.` };
  const known = new Set(knownVcenters.map(String));
  const unknown = vcs.filter((v) => !known.has(v));
  if (unknown.length) return { ok: false, status: 400, reason: `모르는 vCenter 입니다: ${unknown.slice(0, 3).join(', ')}` };
  const b = br == null ? '' : String(br);
  if (b && b !== 'none' && !knownBr.map(String).includes(b)) return { ok: false, status: 400, reason: '등록되지 않은 B&R 서버입니다.' };
  load();
  if (unreadable) return { ok: false, status: 503, code: 'emMapUnreadable', reason: '매핑 파일을 읽지 못해 저장하지 않습니다(손상 사본은 설정 폴더에 남았습니다).' };
  const key = mapKey(emId, name);
  const next = { ...cache };
  if (!vcs.length && !b) delete next[key];
  else {
    if (!next[key] && Object.keys(next).length >= MAX_ENTRIES) return { ok: false, status: 400, reason: `매핑은 ${MAX_ENTRIES}개까지입니다.` };
    next[key] = { vcenterIds: vcs, br: b, server: name, by: String(user?.username || 'unknown').slice(0, 64), at: new Date().toISOString() };
  }
  atomicWriteFileSync(FILE(), JSON.stringify({ v: 1, servers: next }, null, 2), { mode: 0o600 });
  cache = next; rev++;
  return { ok: true, entry: next[key] || null };
}

/** EM 을 지우면 그 EM 의 매핑도 지운다(유령 매핑 방지). 못 읽은 상태면 건드리지 않는다. */
export function dropEmMapFor(emId) {
  load();
  if (unreadable) return 0;
  const pre = `${String(emId)}|`;
  const keys = Object.keys(cache).filter((k) => k.startsWith(pre));
  if (!keys.length) return 0;
  const next = { ...cache };
  for (const k of keys) delete next[k];
  atomicWriteFileSync(FILE(), JSON.stringify({ v: 1, servers: next }, null, 2), { mode: 0o600 });
  cache = next; rev++;
  return keys.length;
}

export function _resetEmMapForTest() { cache = null; unreadable = false; rev++; }
