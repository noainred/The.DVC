/**
 * vmclone/corpMounts.js — 법인(실행 노드)별 '백업에 쓸 NFS 마운트' 지정(v2.794).
 *
 * 사용자 요구(2026-10-26): "백업 nfs 는 edge 노드에 마운트된 nfs 를 사용" — 엣지에는 백업과 무관한 마운트(로그·ISO 등)도 있다.
 * 법인 저장소 화면에서 마운트별로 '사용' 을 켜 두면 잡 마법사는 켠 마운트만 보이고, 잡 저장(서버)도 켠 마운트만 받는다.
 *  · 아무것도 지정하지 않은 법인(항목 없음)은 **모든 마운트**를 쓴다 — 이전 판 동작 그대로(업그레이드로 기존 잡이 막히지 않게).
 *  · 이미 저장된 잡은 지정과 무관하게 계속 돈다(실행기는 이 파일을 보지 않는다) — 지정은 '새로 고르는 대상' 을 좁힌다.
 *  · 키: 법인 키(dispatch.corpKeyOfTarget — 'central' · 'edge:<엣지 이름 소문자>'). 담당 미확정('unassigned')은 지정할 수 없다.
 *
 * 저장 파일: CONFIG_DIR/vm-clone-corp.json → { version:1, corps: { <key>: { mountIds:[...], at, by } } }
 * 원자적 쓰기 + 로드 손상 보존(preserveCorrupt) — 손상을 빈 값으로 넘기면 '지정 없음 = 전부 허용' 으로 조용히 넓어진다.
 * 그래서 로드 오류 동안은 loadError() 가 사유를 돌려주고 잡 저장 검사는 NFS 대상을 거부한다(fail-closed).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'vm-clone-corp.json');
const MAX_CORPS = 200;
const MAX_MOUNTS = 50;
const ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

let _db = null;
let _err = null;
function load() {
  if (_db) return _db;
  _err = null;
  try {
    if (fs.existsSync(FILE)) {
      const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      _db = { corps: p?.corps && typeof p.corps === 'object' && !Array.isArray(p.corps) ? p.corps : {} };
      return _db;
    }
  } catch (e) {
    _err = { at: Date.now(), reason: `vm-clone-corp.json 을 읽지 못했습니다(${String(e?.message || e).slice(0, 120)}) — 손상본을 옆에 보존했습니다` };
    preserveCorrupt(FILE);
  }
  _db = { corps: {} };
  return _db;
}
const KEY_RE = /^(central|edge:[^\s]{1,64})$/;
const keyOf = (corpKey) => { const k = String(corpKey ?? '').trim().slice(0, 70); if (!KEY_RE.test(k)) throw new Error('법인 키 형식 오류'); return k; };
const keyOrNull = (corpKey) => { try { return keyOf(corpKey); } catch { return null; } };

/** 파일을 못 읽었으면 { at, reason } — 화면이 알리고 잡 저장 검사가 NFS 대상을 거부한다. */
export function corpMountsLoadError() { load(); return _err; }

/** 그 법인이 백업에 쓰기로 한 마운트 id 집합. 지정이 없으면 null(전부). */
export function mountUseOf(corpKey) {
  const k = keyOrNull(corpKey);
  const v = k ? load().corps[k] : null;
  return Array.isArray(v?.mountIds) ? new Set(v.mountIds.map(String)) : null;
}

/** 화면용 — { mountIds:[], at, by } 또는 null. */
export function mountUseView(corpKey) {
  const k = keyOrNull(corpKey);
  const v = k ? load().corps[k] : null;
  return Array.isArray(v?.mountIds) ? { mountIds: [...v.mountIds], at: Number(v.at) || 0, by: String(v.by || '') } : null;
}

/**
 * 지정 저장. mountIds 가 null 이면 지정을 지운다(전부 허용으로 돌아간다). 빈 배열은 '아무것도 쓰지 않음' 이다(엣지 NFS 대상 금지).
 * 저장은 관리자 동작이라 로드 오류를 풀어 준다(그 저장이 지금 보이는 값을 확정한다).
 */
export function setMountUse(corpKey, mountIds, by = '') {
  const db = load();
  const key = keyOf(corpKey);
  if (mountIds == null) delete db.corps[key];
  else {
    if (!Array.isArray(mountIds)) throw new Error('mountIds 는 배열이어야 합니다');
    const ids = [...new Set(mountIds.map((x) => String(x ?? '').trim()))].filter((x) => ID_RE.test(x)).slice(0, MAX_MOUNTS);
    if (!db.corps[key] && Object.keys(db.corps).length >= MAX_CORPS) throw new Error(`법인 지정은 최대 ${MAX_CORPS}개입니다`);
    db.corps[key] = { mountIds: ids, at: Date.now(), by: String(by || '').slice(0, 80) };
  }
  atomicWriteFileSync(FILE, JSON.stringify({ version: 1, corps: db.corps }, null, 2), { mode: 0o600 });
  _err = null;
  return mountUseView(key);
}

/**
 * 잡 저장 검사(순수에 가깝다 — 지정은 이 모듈에서 읽는다). NFS 대상이 아니면 통과.
 * @returns {string} 거부 사유('' = 통과)
 */
export function mountUseDenied(dest, corpKey) {
  if (dest?.type !== 'nfs') return '';
  if (corpMountsLoadError()) return '법인별 마운트 지정 파일(vm-clone-corp.json)을 읽지 못해 NFS 대상을 확인할 수 없습니다 — 법인 저장소 화면에서 다시 저장하세요.';
  const use = mountUseOf(corpKey);
  if (!use) return '';
  if (!use.has(String(dest.mountId || ''))) return use.size ? '이 법인에서 백업에 쓰기로 지정하지 않은 마운트입니다 — 법인 저장소 화면에서 그 마운트의 ‘사용’ 을 켜세요.' : '이 법인은 엣지 NFS 마운트를 백업에 쓰지 않도록 지정돼 있습니다 — 법인 저장소 화면에서 바꾸세요.';
  return '';
}

export function _resetCorpMountsForTest() { _db = null; _err = null; }
