/**
 * subnetNotes.js — /24 대역 단위 용도 · 설명(v3.5.0 재설계 묶음 나 · 설계 docs/design/ipam-redesign §4 '대역 용도').
 *
 * 저장: CONFIG_DIR/ipam-subnet-notes.json = { "<a.b.c>": { purpose, desc, updatedAt, updatedBy } }.
 * 대역 정책(rangePolicies — 범위 + 관리상태 기본값)과는 다른 것이다: 이것은 대역의 이름표일 뿐 IP 판정에 쓰이지 않는다.
 * 그래서 원장 입력 지문 · ipam.db 에는 들어가지 않는다(대역 목록 응답에 합쳐 보낼 뿐).
 *
 * 쓰기 게이트는 라우트가 정한다(운영자 이상 + 전체 범위 — 한 /24 를 두 vCenter 가 나눠 쓸 수 있어 범위 계정이 남의 대역 이름을 바꾸지 않게).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'ipam-subnet-notes.json');
export const SUBNET_PURPOSE_MAX = 80;
export const SUBNET_DESC_MAX = 500;
let cache = null;

/** 'a.b.c' · 'a.b.c.0/24' · 'a.b.c.0' → 'a.b.c'(정규형 — 각 조각 0~255, 앞 0 없음). 아니면 ''. */
export function subnetKey(v) {
  const s = String(v ?? '').trim().replace(/\.0\/24$/, '').replace(/\/24$/, '');
  const parts = s.split('.');
  const p3 = parts.length === 4 && parts[3] === '0' ? parts.slice(0, 3) : parts;
  if (p3.length !== 3) return '';
  for (const x of p3) if (!/^(0|[1-9]\d{0,2})$/.test(x) || Number(x) > 255) return '';
  return p3.join('.');
}

function load() {
  if (cache) return cache;
  cache = {};
  try { if (fs.existsSync(FILE)) cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (e) { preserveCorrupt(FILE, e.message); cache = {}; }
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
  return cache;
}

/** 전체 맵(사본 아님 — 읽기만). */
export function getSubnetNotes() { return load(); }

/** 한 대역의 용도 · 설명(없으면 null). */
export function getSubnetNote(base) { const k = subnetKey(base); return k ? (load()[k] || null) : null; }

/**
 * 저장 — 둘 다 비면 지운다. 길이 초과 · 잘못된 대역은 저장하지 않고 이유를 돌려준다(자르지 않는다 — 조용히 바뀌면 사용자가 넣은 값이 사라진다).
 * @returns {{ok:true, note:object|null} | {ok:false, reason:string}}
 */
export function setSubnetNote(base, { purpose, desc } = {}, user = '') {
  const k = subnetKey(base);
  if (!k) return { ok: false, reason: '대역 형식이 아닙니다(예: 10.20.30 또는 10.20.30.0/24).' };
  const p = String(purpose ?? '').trim();
  const d = String(desc ?? '').trim();
  if (p.length > SUBNET_PURPOSE_MAX) return { ok: false, reason: `용도는 ${SUBNET_PURPOSE_MAX}자까지입니다(${p.length}자).` };
  if (d.length > SUBNET_DESC_MAX) return { ok: false, reason: `설명은 ${SUBNET_DESC_MAX}자까지입니다(${d.length}자).` };
  const data = { ...load() };
  if (!p && !d) delete data[k];
  else data[k] = { purpose: p, desc: d, updatedAt: new Date().toISOString(), updatedBy: String(user || '') };
  atomicWriteFileSync(FILE, JSON.stringify(data, null, 2), { mode: 0o600 }); // 실패면 던진다 — 캐시는 성공 뒤에만 바꾼다
  cache = data;
  return { ok: true, note: data[k] || null };
}

/** 대역 목록에 용도 · 설명을 붙인다(새 객체 — 메모된 목록을 바꾸지 않는다). */
export function withSubnetNotes(list) {
  const notes = load();
  return (list || []).map((s) => {
    const n = notes[s.base];
    return n ? { ...s, purpose: n.purpose || '', desc: n.desc || '', noteAt: n.updatedAt || null, noteBy: n.updatedBy || '' } : s;
  });
}

/**
 * 쓰기 판정(순수) — 범위 계정(allowed = 허용 vCenter Set)은 거부한다. 한 /24 를 여러 vCenter 가 나눠 쓸 수 있어 '그 대역이 내 범위인가' 로
 * 나눌 수 없다(남의 대역 이름을 바꾸게 된다). 거부면 사유 글자, 허용이면 null.
 */
export function subnetNoteWriteDenied(allowed) {
  return allowed ? '대역 용도는 전체 범위(vCenter 제한 없는) 계정만 바꿀 수 있습니다 — 한 대역을 여러 vCenter 가 나눠 쓸 수 있어 범위로 나눌 수 없습니다.' : null;
}

/** 테스트용 — 캐시를 비운다. */
export function _resetSubnetNotesForTest() { cache = null; }
