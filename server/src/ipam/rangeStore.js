/**
 * vCenter별 IP 스캔 대역 저장소 — 각 vCenter(법인/사이트)에 귀속된 스캔 대역을 저장하고,
 * 주기 스캔(scanPoller)이 이 대역들을 합쳐 함께 스캔하도록 한다. 대역 선택 → 네트워크 맵
 * 시각화(netmap)의 대상 IP 집합도 여기서 가져온다.
 *
 * 저장: CONFIG_DIR/ipam-vcenter-ranges.json
 *   { vcenters: { [vcenterId]: { ranges: string[], enabled: bool, updatedAt: ms } } }
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeSettingsLoadError } from '../util/settingsLoadError.js';   // 60회차 F1

const FILE = path.join(config.configDir, 'ipam-vcenter-ranges.json');

let cache = null;
let cacheMtime = -1;

/*
 * 전체 점검 60회차 F1(재현 — 25회차 F-4 의 형제): 손상되면 표지 없이 빈 맵이 되어 ① 옮기지 못한 vCenter 대역의 중앙 주기 스캔이 조용히 멈추고
 *   ② 다음 저장 한 번이 그 한 vCenter 만 든 파일을 만들었다(나머지는 손상 보존본에만 — 서비스 점검에도 없었다). 이제 로드 오류를 세우고(서비스 점검 목록)
 *   오류 중 저장 · 삭제는 거절한다(code 'settings-unreadable' — 라우트 409). 해제는 보존본을 되돌리거나(mtime 이 바뀌면 다시 읽는다) 서비스 점검 확정.
 *   객체가 아닌 JSON · vcenters 가 객체가 아닌 값도 손상이다(예전에는 `{"vcenters":null}` 이 그대로 캐시가 되어 저장이 TypeError 로 죽었다).
 */
const _loadErr = makeSettingsLoadError(() => FILE, { label: 'IP 스캔 — vCenter 별 대역(에이전트로 옮기지 못한 것)', confirm: () => write({ vcenters: {} }) });
/** vCenter 별 대역 파일을 못 읽었으면 { at, reason }, 아니면 null. */
export function vcRangesLoadError() { read(); return _loadErr.get(); }
const VC_RANGES_REFUSAL = { ok: false, code: 'settings-unreadable', reason: 'vCenter 별 스캔 대역 파일(ipam-vcenter-ranges.json)을 읽지 못한 상태라 저장하지 않았습니다 — 지금 저장하면 그 vCenter 만 든 파일이 됩니다. 서비스 점검에서 기본값으로 확정하거나 손상 보존본을 되돌리세요.' };
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function read() {
  // 파일 mtime이 캐시 적재 이후 변했으면(외부 편집·백업 복원·다른 프로세스) 재파싱한다.
  let mtime = -1;
  try { mtime = fs.statSync(FILE).mtimeMs; } catch { mtime = 0; /* 파일 없음 */ }
  if (cache && mtime === cacheMtime) return cache;
  if (!fs.existsSync(FILE)) { cache = { vcenters: {} }; _loadErr.missing(); }   // 60회차 F1: 보존본만 남았으면(재시작 뒤 포함) 여전히 못 읽은 것
  else {
    try {
      const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (!isObj(j) || !isObj(j.vcenters)) throw new Error('형식 오류 — vcenters 객체가 없습니다');
      cache = j; _loadErr.ok();
    } catch (e) { _loadErr.corrupt(e); preserveCorrupt(FILE, e.message); cache = { vcenters: {} }; }
  }
  cacheMtime = mtime;
  return cache;
}

/*
 * v2.639(감사 S1): 쓰기 실패는 **던진다** — 예전에는 console 에만 남기고 호출부(saveVcRanges·removeVcRanges)가 `{ok:true}` 를
 *   돌려줬다. 캐시는 이미 새 값이라 화면은 '저장됨' 이었고 재시작하면 사라졌다(디스크 풀·권한). 형제 `scanStore.saveAll`·
 *   `settings.saveSettings` 는 던지므로 같은 동작으로 맞춘다(호출부 centralIpam.js 는 동기 핸들러라 throw 가 500 으로 간다).
 *   캐시는 **쓰기가 성공한 뒤에만** 바꾼다(실패해도 메모리와 디스크가 어긋나지 않게). 호출부도 캐시 객체를 제자리에서
 *   고치지 않고 사본을 넘긴다.
 */
function write(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(data, null, 2));
  try { fs.chmodSync(FILE, 0o600); } catch { /* */ }
  cache = data;
  try { cacheMtime = fs.statSync(FILE).mtimeMs; } catch { cacheMtime = -1; }
  _loadErr.ok();
}

const normRanges = (r) => (Array.isArray(r) ? r : String(r || '').split(/[\n,]/))
  .map((s) => String(s).trim()).filter(Boolean);

/** 전체 per-vCenter 대역 맵 반환(원본 캐시는 노출하지 않게 복제). v2.639: 바깥 호출부 0건 — 모듈 내부용(export 를 뗐다). */
// eslint-disable-next-line no-unused-vars
function loadVcRanges() {
  return structuredClone(read().vcenters || {});
}

/** [{ vcenterId, ranges, enabled, updatedAt }] 목록. */
export function listVcRanges() {
  const vc = read().vcenters || {};
  return Object.entries(vc).map(([vcenterId, e]) => ({
    vcenterId, ranges: e.ranges || [], enabled: e.enabled !== false, updatedAt: e.updatedAt || null,
  }));
}

/** 특정 vCenter 대역(문자열 배열). */
export function rangesForVcenter(vcenterId) {
  const e = (read().vcenters || {})[vcenterId];
  return e ? (e.ranges || []) : [];
}

/** vCenter 대역 저장/수정. partial: { ranges?, enabled? }. */
export function saveVcRanges(vcenterId, partial = {}) {
  const id = String(vcenterId || '').trim();
  if (!id) return { ok: false, reason: 'vcenterId가 필요합니다.' };
  const data = read();
  if (_loadErr.get()) return { ...VC_RANGES_REFUSAL };   // 60회차 F1
  const cur = data.vcenters[id] || { ranges: [], enabled: true };
  const next = {
    ranges: partial.ranges !== undefined ? normRanges(partial.ranges) : (cur.ranges || []),
    enabled: partial.enabled !== undefined ? partial.enabled !== false : (cur.enabled !== false),
    updatedAt: Date.now(),
  };
  write({ ...data, vcenters: { ...data.vcenters, [id]: next } }); // 캐시 객체를 제자리에서 고치지 않는다(쓰기 실패 시 원복이 필요 없게)
  return { ok: true, vcenterId: id, ...next };
}

/** vCenter 대역 삭제. 쓰기 실패는 던진다(v2.639 S1). */
export function removeVcRanges(vcenterId) {
  const data = read();
  if (_loadErr.get()) return { ...VC_RANGES_REFUSAL };   // 60회차 F1
  if (!data.vcenters[vcenterId]) return { ok: false, reason: '없는 항목' };
  const { [vcenterId]: _removed, ...rest } = data.vcenters;
  write({ ...data, vcenters: rest });
  return { ok: true };
}

/** enabled인 모든 vCenter 대역을 합친 유니크 spec 배열(폴러가 함께 스캔). */
export function enabledVcRanges() {
  const vc = read().vcenters || {};
  const set = new Set();
  for (const e of Object.values(vc)) {
    if (e.enabled === false) continue;
    for (const r of (e.ranges || [])) { const s = String(r).trim(); if (s) set.add(s); }
  }
  return [...set];
}
