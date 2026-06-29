/**
 * 통합 서버 인벤토리 — 베어메탈/물리 서버의 '소속 법인(vCenter)' 수동 등록 저장.
 *
 * 통합 인벤토리 화면에서 베어메탈 서버를 어느 법인(vCenter)에 귀속시킬지 드롭다운으로 고른 값을
 * 저장한다. iDRAC 레지스트리에 등록된 서버는 레지스트리의 vcenterId(전력 귀속과 공유)를 직접
 * 갱신하므로, 이 저장소는 주로 레지스트리에 없는 서버(OME/원격/무전력 발견분)의 귀속을 담는다.
 *
 * 키는 Dell 서비스태그(소문자) 우선, 없으면 서버 ID. CONFIG_DIR/fleet-assign.json에 저장
 * (작은 JSON, atomic write — fleet-tags/alarm-mutes와 동일 패턴).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'fleet-assign.json');

let cache = null;

export function loadFleetAssign() {
  if (cache) return cache;
  try {
    const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = p && typeof p.assign === 'object' && p.assign ? p.assign : {};
  } catch {
    cache = {};
  }
  return cache;
}

/** 소속 법인 지정/해제. vcenterId가 빈값이면 해제. 반환 { ok, assign? , reason? }. */
export function setFleetAssign(key, vcenterId) {
  const k = String(key || '').trim().toLowerCase();
  if (!k) return { ok: false, reason: 'key(서비스태그 또는 서버 ID)가 필요합니다.' };
  if (k.length > 128) return { ok: false, reason: 'key가 너무 깁니다.' };
  const vc = String(vcenterId || '').trim();
  if (vc.length > 128) return { ok: false, reason: 'vcenterId가 너무 깁니다.' };
  const next = { ...loadFleetAssign() };
  if (!vc) delete next[k];
  else next[k] = vc;
  cache = next;
  try { atomicWriteFileSync(FILE, JSON.stringify({ assign: next }, null, 2)); }
  catch (e) { return { ok: false, reason: `저장 실패: ${e.message}` }; }
  return { ok: true, assign: next };
}

/** 테스트/관리용 초기화. */
export function resetFleetAssign() {
  cache = {};
  try { if (fs.existsSync(FILE)) fs.unlinkSync(FILE); } catch { /* */ }
}
