/**
 * vmclone/nfsDs.js — 법인 백업 저장소: ESXi NFS 데이터스토어 정의(v2.793, 중앙 전용).
 *
 * 사용자 요구(2026-10-26): "백업 NFS 는 엣지 노드에 마운트된 NFS 를 쓰거나, NFS 를 지정해 ESXi 데이터스토어로 붙여 클론".
 * 이 파일은 두 번째 방식의 **정의와 호스트별 연결 결과**만 담는다. 연결 자체는 그 vCenter 에 로그인하는 노드가 한다
 * (중앙 직접 수집 vCenter 는 중앙, 사이트 위임 vCenter 는 담당 엣지 — vmclone/dispatch.js).
 *
 * 저장 파일: CONFIG_DIR/vm-clone-nfsds.json → { version:1, items:[{ id, vcenterId, name, server, exportPath, nfsVersion,
 *   createdAt, by, hosts: { [hostId]: { ok, at, detail } } }] }
 *  · 비밀이 없다(NFS AUTH_SYS — 사용자·비밀번호를 받지 않는다). 그래도 원자적 쓰기 + 손상 보존(목록이 지워지면 연결 결과가 사라진다).
 *  · ESXi 에서 데이터스토어를 **떼어 내는 기능은 없다**(사본이 남아 있을 수 있다 — vCenter 에서 직접). 삭제는 이 목록에서만 지운다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { validateNfsDsSpec } from './vsphere.js';

const FILE = path.join(config.configDir, 'vm-clone-nfsds.json');
export const MAX_ITEMS = 200;
const MAX_HOSTS = 500;

let _db = null;
function load() {
  if (_db) return _db;
  try {
    if (fs.existsSync(FILE)) {
      const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      _db = { items: Array.isArray(p?.items) ? p.items : [] };
      return _db;
    }
  } catch { preserveCorrupt(FILE); }
  _db = { items: [] };
  return _db;
}
function persist() { atomicWriteFileSync(FILE, JSON.stringify({ version: 1, items: load().items }, null, 2), { mode: 0o600 }); }

const copy = (x) => JSON.parse(JSON.stringify(x));
export function listNfsDs() { return load().items.map(copy); }
export function getNfsDs(id) { const x = load().items.find((i) => i.id === id); return x ? copy(x) : null; }

/** 정의 추가 — 같은 vCenter 에 같은 이름은 하나(데이터스토어 이름은 vCenter 안에서 유일하다). */
export function createNfsDs({ vcenterId, ...spec } = {}, by = '') {
  const db = load();
  const vc = String(vcenterId ?? '').trim().slice(0, 200);
  if (!vc) throw new Error('vCenter 를 고르세요');
  const s = validateNfsDsSpec(spec);
  if (db.items.length >= MAX_ITEMS) throw new Error(`NFS 데이터스토어 정의는 최대 ${MAX_ITEMS}개입니다`);
  if (db.items.some((i) => i.vcenterId === vc && i.name === s.name)) throw new Error(`이 vCenter 에 같은 이름(${s.name})의 정의가 이미 있습니다`);
  const item = { id: `nfsds-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, vcenterId: vc, ...s, createdAt: Date.now(), by: String(by || '').slice(0, 80), hosts: {} };
  db.items.push(item);
  persist();
  return copy(item);
}

/** 호스트별 연결 결과 반영(연결 작업이 끝났을 때). 모르는 id 면 false. */
export function applyAttachResult(id, hosts, at = Date.now()) {
  const it = load().items.find((i) => i.id === id);
  if (!it) return false;
  if (!it.hosts || typeof it.hosts !== 'object') it.hosts = {};
  for (const h of Array.isArray(hosts) ? hosts.slice(0, MAX_HOSTS) : []) {
    const hid = typeof h?.hostId === 'string' ? h.hostId.slice(0, 300) : '';
    if (!hid) continue;
    it.hosts[hid] = { ok: h.ok === true, at, detail: String(h.detail ?? '').slice(0, 300) };
  }
  const keys = Object.keys(it.hosts);
  if (keys.length > MAX_HOSTS) for (const k of keys.slice(0, keys.length - MAX_HOSTS)) delete it.hosts[k];
  persist();
  return true;
}

/**
 * v2.794 — 호스트별 떼어 내기 결과 반영. 성공한 호스트는 연결 기록을 지우고, 실패한 호스트는 연결 상태를 그대로 두고 사유만 고친다
 * (쓰는 VM 이 있어 떼지 못한 호스트를 '끊김' 으로 보이지 않게). 모르는 id 면 false.
 */
export function applyDetachResult(id, hosts, at = Date.now()) {
  const it = load().items.find((i) => i.id === id);
  if (!it) return false;
  if (!it.hosts || typeof it.hosts !== 'object') it.hosts = {};
  for (const h of Array.isArray(hosts) ? hosts.slice(0, MAX_HOSTS) : []) {
    const hid = typeof h?.hostId === 'string' ? h.hostId.slice(0, 300) : '';
    if (!hid) continue;
    if (h.ok === true) { delete it.hosts[hid]; continue; }
    const prev = it.hosts[hid];
    it.hosts[hid] = { ok: prev?.ok === true, at, detail: `떼어 내기 실패 — ${String(h.detail ?? '').slice(0, 280)}` };
  }
  persist();
  return true;
}

/** 목록에서만 지운다(ESXi 의 데이터스토어는 그대로다). */
export function deleteNfsDs(id) {
  const db = load();
  const i = db.items.findIndex((x) => x.id === id);
  if (i < 0) return false;
  db.items.splice(i, 1);
  persist();
  return true;
}

export function _resetNfsDsForTest() { _db = null; }
