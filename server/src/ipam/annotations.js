/**
 * Per-IP user annotations (custom memo + tags) for the IP ledger. These are
 * operator-authored notes kept SEPARATELY from the vCenter VM/host notes, so
 * they survive snapshot refreshes. Stored in CONFIG_DIR/ipam-annotations.json,
 * keyed by IP address.
 */

import { makeJsonFileLoader, READ_RETRY_MS } from '../util/jsonFileLoad.js';   // 25회차 F-4 · 결정(56~75 남긴 것) 62
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { canonIp } from '../util/ipv4.js';

const FILE = path.join(config.configDir, 'ipam-annotations.json');

let cache = null;
let rev = 0; // 메모/태그 변경 리비전(대장 캐시 무효화 키)
export function annotationsRev() { return rev; }

// 전체 점검 25회차 F-4: 손상 표지 · 서비스 점검 등재 · 오류 중 쓰기 거절(overrides.js 와 같은 판단)
// 결정(56~75 남긴 것) 62(62회차 남긴 것 — 재현): 읽기 오류(EACCES · EISDIR · EIO)도 손상과 같은 catch 로 받아 원본을 보존본으로 치우고 '확정(빈 맵)' 을 열었다 →
//   공용 로더(util/jsonFileLoad.js): 읽기 오류는 원본을 두고 캐시하지 않는다(30초 간격 재읽기 — 권한을 고치면 재시작 없이 풀린다) · 확정 불가(readError).
const _file = makeJsonFileLoader(() => FILE, { label: 'IP 관리 메모 · 태그', confirm: () => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); atomicWriteFileSync(FILE, JSON.stringify({ ...load() }, null, 2)); _file.saved(); }, tag: 'ipam' });
export function annotationsLoadError() { load(); return _file.loadError(); }
/** 응답 표지 — { reason, at, readError } 또는 null(62: 손상 · 읽기 오류 중 메모 GET 이 빈 값을 '없음' 으로 보이지 않게). */
export function annotationsLoadMarker() { load(); return _file.marker(); }
const refusal = () => _file.refusal('IP 관리 메모');
let _unread = false;   // 62: 읽기 오류 구간에 들어가고 나올 때 rev 를 올린다 — 원장 캐시(ipamRevKey)가 빈 메모로 만든 결과를 회복 뒤에도 붙잡지 않게
function load() {
  if (cache && !_file.recheckDue()) return cache;   // 결정 G2 반증 후속 ③: 오류 중에는 캐시를 믿지 않고 30초마다 다시 판정(보존본을 되돌리면 재시작 없이 풀린다)
  const hadErr = !!_file.loadError();
  const r = _file.load();
  if (r.kind === 'read-error') { if (!_unread) { _unread = true; rev++; } armRecheck(); return {}; }   // 62: 원본을 두고 빈 값을 캐시하지 않는다(쓰기는 refusal 로 막힌다)
  const recovered = r.kind === 'ok' && (_unread || hadErr);
  if (_unread) { _unread = false; rev++; } else if (recovered) rev++;   // 손상 → 되돌림도 원장 캐시를 버린다
  cache = r.kind === 'ok' ? r.value : {};
  armRecheck();
  return cache;
}
/*
 * 결정 G2 반증 후속 ④: 오류(읽기 오류 · 손상) 동안에는 30초 뒤 스스로 한 번 다시 판정한다(오류가 풀릴 때까지 이어서). 예전에는 누군가 load() 를
 *   부를 때까지(화면을 안 열면 원장 전량 확인 10분) 회복을 몰랐다 — 회복하면 위에서 rev 가 올라 다음 갱신 주기의 원장 입력 지문(ipamRevKey)이 바뀌고
 *   ipam.db 가 다시 만들어진다. 오류가 없으면 타이머를 걸지 않는다(unref — 프로세스 종료를 막지 않는다).
 */
let _recheckTimer = null;
function armRecheck() {
  if (_recheckTimer || !_file.loadError()) return;
  _recheckTimer = setTimeout(() => { _recheckTimer = null; try { load(); } catch { /* 다음 접근이 다시 판정한다 */ } }, READ_RETRY_MS + 1_000);
  _recheckTimer.unref?.();
}

/** Whole map { ip: { memo, tags[], updatedAt, updatedBy } }. */
export function getAnnotations() { return load(); }

/** One IP's annotation, or null. */
export function getAnnotation(ip) { const d = load(); const c = canonIp(ip); return (c && d[c]) || d[String(ip)] || null; }

const cleanTags = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/))
  .map((s) => String(s).trim()).filter(Boolean).slice(0, 20);

/** Create/update/clear one IP's annotation. Empty memo + no tags removes it. */
export function setAnnotation(ip, { memo = '', tags = [] } = {}, user) {
  const raw = String(ip || '').trim();
  if (!raw) return { ok: false, reason: 'IP가 필요합니다.' };
  // v2.594(감사 LO-2): IPv4 로 읽히면 정규형 키로 저장한다(선행 0 표기가 원장 행과 어긋나 유령이 되던 것).
  const key = canonIp(raw) || raw;
  if (annotationsLoadError()) return refusal();   // 25회차 F-4 · 62: 사유가 읽기 오류 · 손상을 가른다
  const data = { ...load() };   // 25회차 F-5: 사본 — persist 성공 뒤에만 캐시 교체
  if (raw !== key && data[raw]) delete data[raw];
  const m = String(memo || '').trim().slice(0, 2000);
  const t = cleanTags(tags);
  if (!m && t.length === 0) {
    delete data[key];
  } else {
    data[key] = { memo: m, tags: t, updatedAt: new Date().toISOString(), updatedBy: user?.username || 'unknown' };
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(data, null, 2)); // 부분기록 시 메모/태그 전량 유실 방지
  cache = data; rev++; _file.saved();
  return { ok: true, annotation: data[key] || null };
}

/**
 * v2.636: 여러 IP 의 메모·태그를 한 번에 저장(CSV 가져오기) — 파일 쓰기 1회. 규칙은 setAnnotation 과 같다
 * (빈 메모 + 태그 없음 = 삭제, 메모 2000자·태그 20개 절단은 판정 단계에서 이미 오류로 걸렀다).
 * @param {{ip:string, memo:string, tags:string[]}[]} entries
 */
export function setAnnotationsMany(entries, user) {
  if (annotationsLoadError()) return refusal();   // 25회차 F-4 · 62
  const data = { ...load() };   // 25회차 F-5: 사본 — persist 성공 뒤에만 캐시 교체
  const now = new Date().toISOString();
  const by = user?.username || 'unknown';
  let changed = 0; let removed = 0;
  for (const e of entries || []) {
    const raw = String(e?.ip || '').trim();
    if (!raw) continue;
    const key = canonIp(raw) || raw;
    if (raw !== key && data[raw]) delete data[raw];
    const m = String(e.memo || '').trim().slice(0, 2000);
    const t = cleanTags(e.tags);
    if (!m && t.length === 0) { if (data[key]) { delete data[key]; removed++; } continue; }
    data[key] = { memo: m, tags: t, updatedAt: now, updatedBy: by };
    changed++;
  }
  if (changed || removed) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    atomicWriteFileSync(FILE, JSON.stringify(data, null, 2));
    cache = data; rev++; _file.saved();
  }
  return { ok: true, changed, removed };
}
