/**
 * 실제 OS 인벤토리 저장소(별도 DB) — VM별 1행, vmId 키로 upsert.
 * CONFIG_DIR/os-inventory.json(맵). 게스트에서 읽은 실제 OS와 ESXi 보고 guestOS의 불일치 여부 보관.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { classifyOs, majorOf } from './osDetect.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js'; // v2.582 ARCH-3: 상태 파일도 원자 쓰기(절단본 → 로드 실패 → 다음 저장이 빈 값으로 덮어쓰는 왕복 손상 차단)
import { registerExitFlush } from '../util/exitFlush.js'; // v2.582 ARCH-4: 디바운스 저장은 종료 시 동기 flush 를 등록한다
import { unreadVcenterReasons } from '../metrics/unreadVcenters.js'; // v2.742(VC-04): '지금 읽히지 않는 vCenter' 판정은 샘플러와 한 벌(잎 모듈)

const FILE = path.join(config.configDir, 'os-inventory.json');

let map = null; // vmId -> record
let wt = null;

function load() {
  if (map) return map;
  map = new Map();
  try { const o = JSON.parse(fs.readFileSync(FILE, 'utf8')); for (const [k, v] of Object.entries(o || {})) map.set(k, v); } catch { /* */ }
  return map;
}
function persistSoon() {
  if (wt) return;
  wt = setTimeout(() => { wt = null; try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); atomicWriteFileSync(FILE, JSON.stringify(Object.fromEntries(load()), null, 0), { mode: 0o600 }); } catch { /* */ } }, 2000);
  wt.unref?.();
}
registerExitFlush('inventory/osStore', () => { if (!wt) return; clearTimeout(wt); wt = null; try { atomicWriteFileSync(FILE, JSON.stringify(Object.fromEntries(load()), null, 0), { mode: 0o600 }); } catch { /* */ } });

/** ESXi 보고 guestOS와 실제 탐지 OS의 불일치 판정(계열 또는 메이저 버전 차이). */
export function computeMismatch(esxiGuestOS, detected) {
  if (!detected || !detected.os) return false;
  const ef = classifyOs(esxiGuestOS || '');
  const df = detected.family || classifyOs(detected.os);
  if (ef !== 'Other' && df !== 'Other' && ef !== df) return true;
  // v2.708: Windows 는 '메이저 숫자' 로 비교하지 않는다 — ESXi 는 'Windows Server 2022', 게스트 버전은 '10.0.20348' 이라
  //   숫자 비교(2022 ≠ 10)가 **모든 Windows VM 을 불일치**로 만들었다(데모 화면에서 1,611대 중 447대 전부). 연도(20xx)끼리 비교하고,
  //   ESXi 값이 'or later' 면 그 연도보다 **오래된** 게스트만 불일치다. 연도를 하나라도 못 읽으면 단정하지 않는다(false).
  if (ef === 'Windows' && df === 'Windows') {
    const ey = /\b(20\d\d)\b/.exec(String(esxiGuestOS || ''))?.[1];
    const dy = /\b(20\d\d)\b/.exec(String(detected.os || ''))?.[1];
    if (!ey || !dy) return false;
    return /or later/i.test(String(esxiGuestOS || '')) ? Number(dy) < Number(ey) : ey !== dy;
  }
  const em = majorOf(esxiGuestOS || ''); const dm = majorOf(detected.osVersion || detected.os || '');
  if (em && dm && em !== dm) return true;
  return false;
}

/**
 * 탐지 결과 upsert. vm: {id,name,vcenterId,host,cluster,guestOS}. detected: osDetect 결과 또는 null(+error).
 *
 * v2.742(감사 VC-04): **실패는 직전에 탐지한 OS 를 지우지 않는다.** 예전에는 실패(detected=null)가 os·mismatch 를 ''·false 로
 *   덮어써, 게스트 계정 잠금·Tools 일시 미응답·시한 초과 한 번으로 그 VM 의 실제 OS 와 '불일치' 판정이 사라졌다(다시 얻으려면 게스트
 *   로그인이 필요하다). 이제 실패는 error·errorAt·at(마지막 시도)만 갱신하고 os 계열 필드는 직전 값을 남긴다. 불일치는 남긴 OS 로
 *   지금 ESXi 보고값과 다시 계산한다(esxiGuestOS 가 지금 값이므로). okAt 은 마지막으로 OS 를 읽은 시각이다(옛 레코드는 at 으로 되돌린다
 *   — 실패 기록이 없던 레코드의 at 은 곧 성공 시각이었다). 성공은 error·errorAt 을 지운다.
 */
export function upsertOs(vm, detected, error = '') {
  load();
  const now = Date.now();
  const prev = map.get(vm.id) || null;
  const keep = !detected && prev && prev.os ? prev : null;   // 실패 + 직전에 읽은 OS 가 있다 → 그 OS 를 남긴다
  const src = detected || keep || null;
  const mismatch = src ? computeMismatch(vm.guestOS, detected || { os: keep.os, osVersion: keep.osVersion, family: keep.family }) : false;
  const okAt = detected ? now : (keep ? (Number.isFinite(keep.okAt) ? keep.okAt : (Number.isFinite(keep.at) && !keep.error ? keep.at : null)) : null);
  const rec = {
    vmId: vm.id, vmName: vm.name, vcenterId: vm.vcenterId, host: vm.host || '', cluster: vm.cluster || '',
    esxiGuestOS: vm.guestOS || '',
    os: src?.os || '', osId: src?.osId || '', osVersion: src?.osVersion || '', family: src?.family || '',
    kernel: src?.kernel || '', mismatch, error: detected ? '' : (error || ''), at: now,
    okAt,
    ...(!detected ? { errorAt: now } : {}),
  };
  map.set(vm.id, rec);
  persistSoon();
  return rec;
}

export function getOsResults({ vcenterId = '', mismatch = false } = {}) {
  load();
  let rows = [...map.values()];
  if (vcenterId) rows = rows.filter((r) => r.vcenterId === vcenterId);
  if (mismatch) rows = rows.filter((r) => r.mismatch);
  return rows.sort((a, b) => (a.vcenterId === b.vcenterId
    ? String(a.vmName || '').localeCompare(String(b.vmName || ''))
    : String(a.vcenterId || '').localeCompare(String(b.vcenterId || ''))));
}

export function getScannedIds() { load(); return new Set(map.keys()); }
export function getScanInfo(vmId) { load(); return map.get(vmId) || null; }

/** @param {(r:object)=>boolean} [keep] 행 필터(v2.599 — 범위 계정 요약은 그 범위 행으로만 센다). */
export function osSummary(keep = null) {
  load();
  const rows = keep ? [...map.values()].filter(keep) : [...map.values()];
  const byFamily = {};
  for (const r of rows) { const f = r.family || '미상'; byFamily[f] = (byFamily[f] || 0) + 1; }
  return {
    scanned: rows.length,
    mismatches: rows.filter((r) => r.mismatch).length,
    errors: rows.filter((r) => r.error).length,
    byFamily: Object.entries(byFamily).map(([family, count]) => ({ family, count })).sort((a, b) => b.count - a.count),
    lastAt: rows.reduce((mx, r) => Math.max(mx, r.at || 0), 0) || null,
  };
}

/**
 * 삭제된 VM·vCenter 의 레코드 정리.
 *
 * v2.742(감사 VC-04 — 재현): 예전에는 '스냅샷 VM 목록에 없는 레코드' 를 전부 지웠다. 그런데 스냅샷 VM 목록은 첫 수집 중(pending — VM 0개)·
 *   첫 병합 전 골격(initial)·연결 실패로 lastGood 가 만료됐거나 재시작 직후 인증 정지라 인벤토리가 빈 vCenter 에서 **비어 있다** —
 *   그 vCenter 의 OS 탐지 기록이 전부 지워졌고, 다시 얻으려면 VM 마다 게스트 로그인이 필요했다(대장의 '실제 OS'·'불일치' 가 사라짐).
 *   이제 지우는 것은 둘뿐이다(vmtrack/service.js '등록된 vCenter 기준' 규칙과 같은 판단):
 *   ① 알려진 vCenter(등록부 ∪ 스냅샷 — status 무관) 밖의 레코드 = 등록에서 지워진 vCenter
 *   ② 지금 인벤토리를 **온전히 읽은** vCenter(status connected · 첫 병합 끝 · 읽히지 않는 사유 없음 — metrics/unreadVcenters.js 한 벌)
 *      에서 사라진 VM
 *   스냅샷 자체가 없으면 아무것도 지우지 않고, 첫 병합 전(initial)이면 ② 를 하지 않으며, 등록부를 못 읽었으면(registryIds null) ① 을 하지 않는다.
 *
 * @param {object} snap 스냅샷(store.get())
 * @param {{ registryIds?: Iterable<string>|null }} [opt] 등록부의 vCenter id(데모·mock 은 비어 있을 수 있다 — 스냅샷 vCenter 와 합친다).
 *        null = 등록부를 못 읽음(① 생략).
 * @returns {{ removed: number, removedVcenter: number, removedVm: number, keptUnread: number }}
 */
export function pruneMissing(snap, { registryIds = [] } = {}) {
  load();
  const out = { removed: 0, removedVcenter: 0, removedVm: 0, keptUnread: 0 };
  if (!snap || typeof snap !== 'object' || !Array.isArray(snap.vcenters)) return out;   // 스냅샷을 모르면 지우지 않는다
  // registryIds === null: 등록부를 못 읽었다 — 'vCenter 가 지워졌다' 를 판정할 수 없으므로 ① 을 하지 않는다.
  const registryKnown = registryIds !== null;
  const known = new Set([...(registryIds || [])].map((x) => String(x ?? '')).filter(Boolean));
  for (const vc of snap.vcenters) if (vc && vc.id != null) known.add(String(vc.id));
  const unread = unreadVcenterReasons(snap);
  const complete = new Set();
  if (snap.initial !== true) {
    for (const vc of snap.vcenters) {
      const id = vc && vc.id != null ? String(vc.id) : '';
      if (id && vc.status === 'connected' && !unread.has(id)) complete.add(id);
    }
  }
  const present = new Set((snap.vms || []).map((v) => v?.id).filter((x) => x != null));
  for (const [id, r] of [...map.entries()]) {
    const vcId = String(r?.vcenterId ?? '');
    if (!known.has(vcId)) {
      if (registryKnown) { map.delete(id); out.removedVcenter += 1; } else out.keptUnread += 1;
      continue;
    }
    if (present.has(id)) continue;
    if (complete.has(vcId)) { map.delete(id); out.removedVm += 1; continue; }
    out.keptUnread += 1;   // 지금 그 vCenter 의 VM 목록을 온전히 모른다 — 지우지 않는다
  }
  out.removed = out.removedVcenter + out.removedVm;
  if (out.removed) persistSoon();
  return out;
}
