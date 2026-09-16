/**
 * sanswitch/errBaseline.js — 포트 에러 카운터 **월 기준선**(v2.519).
 *
 * ── 왜 필요한가 ───────────────────────────────────────────────────────────────
 * `porterrshow` 의 카운터는 **부팅 이후 누적**이다. 몇 년 켜 둔 스위치는 crc err 가 수만이어도
 * 최근 한 달은 조용할 수 있다. 사용자 체크리스트의 *"당월에 새로 발생하는 에러를 측정"* 을 하려면
 * 어느 시점의 값을 기억해 둬야 한다.
 *
 * ⚠ **포탈이 `portstatsclear` 를 실행하지 않는다.** 체크리스트에 '필요 시' 로 적혀 있지만, 그것은
 *   스위치의 카운터를 0 으로 만드는 **파괴적 동작**이고 다른 팀·다른 도구가 잡아 둔 기준선을 함께
 *   지운다. 그래서 기준선은 **포탈 안에** 저장한다 — 스위치는 건드리지 않는다.
 *   (`tools/orphanVmdk.js` 가 삭제 API 를 만들지 않은 것과 같은 판단이다.)
 *
 * 파일: `CONFIG_DIR/sanswitch-err-baseline.json` — 자격증명이 없으므로 vault 대상은 아니지만
 * 0600 + 원자적 쓰기는 지킨다. 손상 시 **재생성**한다(기준선은 다시 저장할 수 있는 값이고,
 * 원본을 보존해 두면 쓸모없는 파일만 쌓인다 — v2.516 작업 로그와 같은 취급).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = () => path.join(config.configDir, 'sanswitch-err-baseline.json');
/** 장비 수 상한 — 28대 운영에 30+ 확장을 가정해도 넉넉하다. 포트는 디렉터 768까지. */
const MAX_DEVICES = 500;
// ⚠ v2.521 에 `errEncIn`·`errLossSig`·`errLinkFail` 을 더했다 — 사용자 제공 해석표가 이 카운터들을
//   서로 **다른 원인**(물리 Layer / Link·Optic·Cable)으로 구분한다. 기준선에 없으면 '당월 신규' 를
//   영영 판정할 수 없다. 옛 기준선 파일에는 이 키가 없고, 없는 키는 `errorDelta` 가 null(판정 보류)
//   을 돌려주므로 안전하다 — **0 으로 채우지 말 것**(오래된 누적이 통째로 '신규' 로 둔갑한다).
const KEYS = ['errCrc', 'errEncIn', 'errEncOut', 'errLinkFail', 'errLossSync', 'errLossSig', 'discC3'];

let _map = null;

function load() {
  if (_map) return _map;
  try { _map = new Map(Object.entries(JSON.parse(fs.readFileSync(FILE(), 'utf8')))); }
  catch { _map = new Map(); }   // 없거나 손상 — 새로 시작(다시 저장 가능한 값)
  return _map;
}

function persist() {
  try { atomicWriteFileSync(FILE(), JSON.stringify(Object.fromEntries(load())), { mode: 0o600 }); }
  catch (e) { console.warn(`[sanswitch-baseline] 저장 실패: ${e.message}`); }
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 스냅샷의 포트 카운터를 기준선 형태로 추린다(순수 — 테스트가 고정).
 *
 * ⚠ **카운터를 못 읽은 포트는 넣지 않는다.** 0 으로 채우면 다음 점검에서 '신규 = 현재값' 이 되어
 *   오래된 누적이 통째로 '당월 신규' 로 둔갑한다. `portsComplete` 도 함께 기록해, 엣지가 문제
 *   포트만 올린 스냅샷으로 만든 기준선임을 나중에 알 수 있게 한다.
 */
export function baselineFromSnapshot(snap) {
  const list = (snap?.ports?.list) || [];
  const ports = {};
  let counted = 0;
  for (const p of list.slice(0, 1000)) {
    const row = {};
    let any = false;
    for (const k of KEYS) { const v = num(p[k]); if (v != null) { row[k] = v; any = true; } }
    if (any) { ports[String(p.index)] = row; counted++; }
  }
  return {
    at: Number(snap?.collectedAt) || Date.now(),
    savedAt: Date.now(),
    ports, portCount: counted,
    portsComplete: (num(snap?.ports?.portsOmitted) || 0) === 0,
    collectedAt: Number(snap?.collectedAt) || null,
  };
}

/** 저장(덮어쓰기). 반환값은 저장된 기준선 요약. */
export function saveBaseline(deviceId, snap) {
  const id = String(deviceId || '');
  if (!id || !snap) return null;
  const b = baselineFromSnapshot(snap);
  const m = load();
  m.set(id, b);
  if (m.size > MAX_DEVICES) for (const k of [...m.keys()].slice(0, m.size - MAX_DEVICES)) m.delete(k);
  persist();
  return publicBaseline(b);
}

export function getBaseline(deviceId) { return load().get(String(deviceId || '')) || null; }

export function clearBaseline(deviceId) {
  const m = load();
  const had = m.delete(String(deviceId || ''));
  if (had) persist();
  return had;
}

/** 화면용 요약 — 포트별 원시 카운터는 싣지 않는다(768포트 × 4계열은 화면에 쓸모가 없다). */
export function publicBaseline(b) {
  if (!b) return null;
  return { at: b.at, savedAt: b.savedAt, portCount: b.portCount, portsComplete: b.portsComplete !== false };
}

/** 전 장비 기준선 요약(목록 화면·전체 점검 응답용). */
export function listBaselines() {
  return [...load().entries()].map(([deviceId, b]) => ({ deviceId, ...publicBaseline(b) }));
}

export function _resetForTest() { _map = null; }
