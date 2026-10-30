/**
 * bareos/groups.js — Bareos 백업 그룹 원장(v2.830 · 사용자 요청 'VM 을 골라 그룹으로 — 이름·스케줄·스토리지 지정, 나중에 수정').
 * 파일: CONFIG_DIR/bareos-groups.json (자격증명 없음 · 원자적 쓰기 · 손상 보존 — 못 읽으면 쓰기를 거부한다).
 *
 * group = {
 *   id, name, vcenterId, directorId,        // 법인 = vCenter 1개 = Director 1개(루트 CLAUDE.md 1:1:1). directorId 는 만든 때의 매핑(표시용 — 실행은 잡의 Director 로)
 *   vmIds: string[],                        // 그룹 VM(인벤토리 id). VM 하나는 **그룹 하나에만**(두 그룹이면 같은 VM 이 두 번 돈다)
 *   schedule: { enabled, days, time, level, fullDays },   // groupSchedule.normSchedule
 *   storage, pool,                          // '' = 잡 기본값(등록 때 매핑 값). 값이 있으면 실행 때 `run … storage= pool=` 로 지정
 *   anchorAt,                               // 스케줄을 만들거나 바꾼 시각 — 그 앞의 회차는 돌리지 않는다
 *   lastKey,                                // 마지막으로 처리한 회차 열쇠(돌렸거나 놓침) — 같은 회차를 두 번 돌리지 않는다(**보내기 전에** 기록)
 *   lastFire: { key, at, trigger, by, level, total, started, skipped, failed, unknown, items[] } | null,
 *   missed: { key, at } | null,             // 포탈이 꺼져 있어 따라잡는 범위를 넘긴 회차
 *   createdBy, createdAt, updatedBy, updatedAt,
 * }
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { makeLoadError } from '../util/registryCore.js';
import { isResourceName } from './names.js';
import { normSchedule } from './groupSchedule.js';

export const FILE_NAME = 'bareos-groups.json';
const FILE = () => path.join(config.configDir, 'bareos-groups.json'); // 문자열 그대로 — scripts/config-doc.mjs 가 이 모양으로 파일을 찾는다
export const MAX_GROUPS = 500;
/** 그룹 하나의 VM 상한 — 일괄 등록 한 번(MAX_BULK)과 같은 값(새 VM 은 저장 때 한 번에 등록한다). */
export const MAX_MEMBERS = 200;
export const NAME_MAX = 60;
export const FIRE_ITEMS_KEEP = 200;

let _db = null;
const _loadErr = makeLoadError();
let _rev = 0;

const fail = (code, msg) => Object.assign(new Error(msg), { code });

function load() {
  if (_db) return _db;
  try {
    if (fs.existsSync(FILE())) {
      const p = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('형식 오류');
      _db = { groups: (Array.isArray(p.groups) ? p.groups : []).filter((g) => g && typeof g === 'object' && typeof g.id === 'string' && Array.isArray(g.vmIds)) };
      _loadErr.clear();
      return _db;
    }
  } catch (e) {
    preserveCorrupt(FILE(), e?.message);
    _loadErr.set(e);
    console.warn(`[bareos] 백업 그룹 원장을 읽지 못했습니다(${safeLoadText(e) || '사유 미상'}) — 손상본을 보존했습니다(그룹 저장·예약 실행을 멈춥니다).`);
  }
  _db = { groups: [] };
  _loadErr.checkCorruptOnly(FILE());
  return _db;
}

export function groupsLoadError() { load(); return _loadErr.get(); }
export function groupsRev() { return _rev; }

function persist() {
  const db = load();
  atomicWriteFileSync(FILE(), JSON.stringify({ version: 1, groups: db.groups }), { mode: 0o600 });
  _rev += 1;
}
/** 바꾸기 → 쓰기. 쓰기가 실패하면 메모리도 되돌린다(화면은 '저장됨', 재시작하면 사라지는 일이 없게 — registry.addJob 과 같은 규칙). */
function mutate(fn) {
  const db = load();
  if (_loadErr.get()) throw fail('unavailable', '백업 그룹 원장을 읽지 못한 상태라 바꾸지 않습니다(손상본 보존 — 서비스 점검에서 확인).');
  const before = JSON.stringify(db.groups);
  try {
    const out = fn(db);
    persist();
    return out;
  } catch (e) {
    db.groups = JSON.parse(before);
    throw e;
  }
}

const copy = (g) => (g ? JSON.parse(JSON.stringify(g)) : null);
export function listGroups() { return load().groups.map(copy); }
export function getGroup(id) { return copy(load().groups.find((g) => g.id === id)); }
/** 이 VM 이 든 그룹(같은 vCenter) — 없으면 null. */
export function groupOfVm(vcenterId, vmId) { return copy(load().groups.find((g) => g.vcenterId === vcenterId && g.vmIds.includes(vmId))); }

// 제어문자·앞뒤 공백 제거
// eslint-disable-next-line no-control-regex
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, NAME_MAX * 2).trim().slice(0, NAME_MAX);

/**
 * 입력 판정(순수에 가까움 — 지금 원장만 본다). 이름·VM·스케줄·스토리지 형식과 '이름 중복 · VM 은 그룹 하나에만' 을 본다.
 * @param {object} input { name, vcenterId, vmIds, schedule, storage, pool }
 * @param {{ selfId?: string }} [o] 수정이면 자기 자신은 빼고 본다
 * @returns {{ name, vmIds, schedule, storage, pool }}
 */
export function checkGroupInput(input, { selfId = '' } = {}) {
  const b = input && typeof input === 'object' ? input : {};
  const vcenterId = String(b.vcenterId || '');
  const name = cleanName(b.name);
  if (!name) throw fail('invalid', '그룹 이름을 적으세요.');
  if (!Array.isArray(b.vmIds)) throw fail('invalid', 'vmIds(배열)를 보내세요.');
  const vmIds = [...new Set(b.vmIds.filter((x) => typeof x === 'string' && x && x.length <= 300))];
  if (!vmIds.length) throw fail('invalid', '그룹에 넣을 VM 을 하나 이상 고르세요.');
  if (vmIds.length > MAX_MEMBERS) throw fail('invalid', `그룹 하나에는 VM 을 ${MAX_MEMBERS}대까지 넣을 수 있습니다(${vmIds.length}대를 골랐습니다).`);
  const storage = String(b.storage ?? '').trim();
  const pool = String(b.pool ?? '').trim();
  if (storage && !isResourceName(storage)) throw fail('invalid', '스토리지 이름이 올바르지 않습니다(영문·숫자·. _ - 만).');
  if (pool && !isResourceName(pool)) throw fail('invalid', '풀 이름이 올바르지 않습니다(영문·숫자·. _ - 만).');
  const schedule = normSchedule(b.schedule);
  const others = load().groups.filter((g) => g.vcenterId === vcenterId && g.id !== selfId);
  const low = name.toLowerCase();
  if (others.some((g) => String(g.name).toLowerCase() === low)) throw fail('conflict', `같은 법인에 ‘${name}’ 그룹이 이미 있습니다 — 다른 이름을 쓰세요.`);
  const taken = new Map();
  for (const g of others) for (const id of g.vmIds) taken.set(id, g.name);
  const dup = vmIds.filter((id) => taken.has(id));
  if (dup.length) {
    const groups = [...new Set(dup.map((id) => taken.get(id)))].slice(0, 5).join(', ');
    throw fail('conflict', `VM ${dup.length}대가 이미 다른 그룹(${groups})에 있습니다 — VM 하나는 그룹 하나에만 넣을 수 있습니다(두 그룹이면 같은 VM 이 두 번 백업됩니다).`);
  }
  return { name, vmIds, schedule, storage, pool };
}

/** 새 그룹. checkGroupInput 을 **저장하는 순간** 다시 본다(그사이 다른 저장이 같은 VM 을 가져갔을 수 있다). */
export function addGroup(input, { by = '', directorId = '', now = Date.now() } = {}) {
  return mutate((db) => {
    if (db.groups.length >= MAX_GROUPS) throw fail('invalid', `백업 그룹은 ${MAX_GROUPS}개까지 만들 수 있습니다.`);
    const v = checkGroupInput(input);
    const g = {
      id: `bg_${now.toString(36)}${crypto.randomBytes(3).toString('hex')}`,
      name: v.name, vcenterId: String(input.vcenterId), directorId: String(directorId || ''),
      vmIds: v.vmIds, schedule: v.schedule, storage: v.storage, pool: v.pool,
      anchorAt: now, lastKey: '', lastFire: null, missed: null,
      createdBy: String(by), createdAt: now, updatedBy: String(by), updatedAt: now,
    };
    db.groups.push(g);
    return copy(g);
  });
}

/**
 * 고치기 — 이름·VM·스케줄·스토리지·풀. 스케줄이 바뀌면 anchorAt 을 지금으로(그 앞 회차는 새 스케줄의 회차가 아니다).
 * @returns {object|null} 없으면 null
 */
export function updateGroup(id, input, { by = '', now = Date.now() } = {}) {
  return mutate((db) => {
    const g = db.groups.find((x) => x.id === id);
    if (!g) return null;
    const v = checkGroupInput({ ...input, vcenterId: g.vcenterId }, { selfId: id });
    const schedChanged = JSON.stringify(v.schedule) !== JSON.stringify(g.schedule);
    Object.assign(g, { name: v.name, vmIds: v.vmIds, schedule: v.schedule, storage: v.storage, pool: v.pool, updatedBy: String(by), updatedAt: now });
    if (schedChanged) { g.anchorAt = now; g.missed = null; }
    return copy(g);
  });
}

export function deleteGroup(id) {
  return mutate((db) => {
    const i = db.groups.findIndex((g) => g.id === id);
    if (i < 0) return false;
    db.groups.splice(i, 1);
    return true;
  });
}

/**
 * 이 회차를 차지한다 — 실행을 **보내기 전에** 파일에 남긴다(보낸 뒤 쓰기 전에 포탈이 죽어도 다시 켜졌을 때 같은 회차를 또 돌리지 않게 — 한 번 이하).
 * 이미 그 회차면·그룹이 없으면·쓰지 못하면 false(그때는 보내지 않는다).
 */
export function claimSlot(id, key) {
  try {
    return mutate((db) => {
      const g = db.groups.find((x) => x.id === id);
      if (!g || g.lastKey === key) return false;
      g.lastKey = key;
      return true;
    });
  } catch (e) {
    console.warn(`[bareos] 백업 그룹 회차 기록 실패 — 이번 회차는 보내지 않습니다: ${String(e?.message || e).slice(0, 200)}`);
    return false;
  }
}

/** 따라잡는 범위를 넘긴 회차 — 돌리지 않고 남긴다(lastKey 도 그 회차로 — 틱마다 다시 보지 않게). */
export function recordMiss(id, slot) {
  try {
    return mutate((db) => {
      const g = db.groups.find((x) => x.id === id);
      if (!g || g.lastKey === slot.key) return false;
      g.lastKey = slot.key;
      g.missed = { key: slot.key, at: slot.at };
      return true;
    });
  } catch { return false; }
}

/** 실행 결과(예약·수동) — 항목은 FIRE_ITEMS_KEEP 개까지. 쓰기 실패는 삼킨다(실행은 이미 보냈다 — 원장 잡의 pending 이 진실). */
export function recordFire(id, fire) {
  try {
    return mutate((db) => {
      const g = db.groups.find((x) => x.id === id);
      if (!g) return false;
      g.lastFire = { ...fire, items: (Array.isArray(fire.items) ? fire.items : []).slice(0, FIRE_ITEMS_KEEP) };
      return true;
    });
  } catch (e) {
    console.warn(`[bareos] 백업 그룹 실행 결과를 기록하지 못했습니다: ${String(e?.message || e).slice(0, 200)}`);
    return false;
  }
}

export function _resetGroupsForTest() { _db = null; _loadErr.clear(); _rev = 0; }
