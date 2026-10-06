/**
 * bmusage/settings.js — 베어메탈 사용률 수집 설정(v2.550).
 *
 * 사용자 요청(2026-09-17): "여기에 분류된 서버들만 CPU memory disk Network HBA 사용율을 수집하고
 * 싶어"(서버 분석 › 구분 › **Baremetal(미가상화 물리)**).
 * 선택: **iDRAC + OS SSH 둘 다(되는 것부터)** · **법인 단위로 켠다** · **5분 · 원시 90일 + 일롤업
 * 5년** · **Linux + Windows 둘 다**.
 *
 * ── 왜 법인 단위인가(사용자 선택) ────────────────────────────────────────────
 * 이 현장은 등록 서버 1,135대 · 법인 16곳이다(사용자 화면). 전량을 한 번에 켜면 주기마다
 * iDRAC·SSH 세션이 수백 개 열린다. 법인별로 켜서 회선·장비 부하를 눈으로 보며 늘리는 것이 설계다.
 *
 * ⚠ **기본 꺼짐(opt-in)** — 켜지 않은 법인은 대상 0대다(빈 화면은 '이상' 이 아니라 '안 켰다' 다).
 * ⚠ 주기·보존 **숫자를 화면 문구에 박지 말 것** — 이 모듈이 주는 값만 쓴다(CLAUDE.md 규약).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeSettingsLoadError } from '../util/settingsLoadError.js';
import { clampSetting } from '../util/clampSetting.js'; // v2.613 DEPS2613-12 · RUNTIME2613-08: 숫자 설정 정규화는 하나(빈 칸 = 미지정)
import crypto from 'node:crypto';
import { registerStateFile } from '../util/stateFiles.js';
import { capStr } from '../util/capStr.js';
import { demoOn } from '../mock/demo/flags.js'; // v2.708: 데모(mock)는 켜진 것처럼 — 설정 파일은 바꾸지 않는다

const FILE = () => path.join(config.configDir, 'bmusage-settings.json');
/*
 * v2.627(사용자 요청 "한번에 켜는 기능" · 선택 "중앙 설정이 엣지를 따른다"): 중앙이 엣지 28곳의 설정을 한 번에 정한다.
 *  · 중앙: `bmusage-distribute.json` — 배포 켬/끔 + 엣지별 제외(관리자가 고른 **설정**이라 백업 대상이다).
 *  · 엣지: `bmusage-central.json` — 중앙이 내려준 사본(**상태** — 백업 '설정 변경' 감시에서 뺀다). 로컬 파일은 그대로 두고
 *    유효 설정을 계산할 때만 겹친다 — 배포를 끄거나 그 엣지를 제외하면 사본을 지워 **엣지 로컬 설정으로 되돌아간다**.
 * ⚠⚠ Enterprise 대체 수집(`enterprise*`)은 **배포하지 않는다**(사용자 선택) — v2.554 '장비 부하에 관리자가 동의해야 켜진다'
 *   는 그 엣지 관리자의 동의다. `DISTRIBUTED_KEYS` 에 enterprise 키를 넣지 말 것(테스트가 고정한다).
 */
const DIST_FILE = () => path.join(config.configDir, 'bmusage-distribute.json');
registerStateFile('bmusage-central.json');
const CENTRAL_COPY_FILE = () => path.join(config.configDir, 'bmusage-central.json');
export const DISTRIBUTED_KEYS = Object.freeze([
  'enabled', 'corps', 'includeUnassigned', 'includeVirtualization', 'intervalMs', 'rawRetentionDays', 'dailyRetentionDays',
  'osSsh', 'idracTelemetry', 'idracFullTelemetry', 'alertEnabled', 'alertPct', 'alertSustainMin', 'alertRepeatHours',
]);

/** 사용자가 고른 기본값. 주기 5분 · 원시 90일 · 일 롤업 5년. */
export const DEFAULTS = Object.freeze({
  enabled: false,
  corps: {},                 // { [vcenterId]: true }  — 켠 법인만
  includeUnassigned: false,  // 법인 귀속이 없는 베어메탈도 수집할지(기본 제외 — 어느 법인 부하인지 모른다)
  /*
   * v2.625(사용자 요청 "iDRAC 사용량을 ESXi 호스트까지 넓혀서"): 켠 법인의 **가상화 호스트(ESXi)** 도 iDRAC 텔레메트리로
   * CPU·메모리를 읽는다. ⚠ **기본 꺼짐**이다 — 호스트 약 658대가 5분마다 Redfish 요청을 더한다(사용자 선택: 별도 스위치 +
   * 법인 선택). 경로는 iDRAC 하나뿐이다(ESXi 에는 OS SSH 경로를 걸지 않는다). 못 읽은 호스트는 '법인별 서버 사용량' 화면이
   * vCenter 값으로 채우고 출처를 밝힌다(수집이 아니라 표시 단계의 결정 — 여기서는 대상만 정한다).
   */
  includeVirtualization: false,
  intervalMs: 5 * 60_000,
  rawRetentionDays: 90,
  dailyRetentionDays: 365 * 5,
  osSsh: true,               // OS SSH 경로(디스크·네트워크·HBA 를 주는 유일한 경로)
  idracTelemetry: true,      // iDRAC 텔레메트리 경로(CPU·MEM·IO — 새 자격증명 0)
  /*
   * 텔레메트리 **전수 모드**(v2.551 — 사용자 요청): 리포트 목록을 열거해 NIC·FC 통계까지 읽는다.
   * 켜면 OS 계정이 없는 서버도 네트워크·HBA 값이 나온다. 왕복이 늘지만 목록 캐시(6시간) +
   * 주기당 목록 조회 예산으로 주기를 넘기지 않는다(`redfish.js` 의 예산 계산 주석 참조).
   * ⚠ 끄면 v2.550 처럼 `SystemUsage` 하나만 읽는다 — 회선이 아주 좁은 법인의 탈출구로 남긴다.
   */
  idracFullTelemetry: true,
  /*
   * ⚠⚠ **Enterprise 라이선스 대체 수집**(v2.554 — 사용자 신고 "내가 가진건 enterprise 라이선스라서,
   * 엔터프라이즈 라이선스 대상 서버도 수집하는 기능 추가로 만들어줘").
   *
   * 텔레메트리(`SystemUsage`)는 **Datacenter 전용**이라(사용자 확인) Enterprise 서버는 CPU·메모리가
   * 영원히 `—` 였다. 이 스위치를 켜면 **표준 Redfish 센서 + iDRAC SSH(racadm)** 로 대체 수집한다.
   *
   * ⚠⚠ **`enterpriseAck` 없이는 켜지지 않는다**(사용자 지시: "시스템에 부하는 있겠지만, 사용할
   *   것이냐고 물어보고 사용하겠다고 하면 기능을 구현한다"). BMC 는 약한 프로세서라 주기마다
   *   센서 GET 4회 + SSH 세션 1개가 붙는다 — 화면이 그 부하를 먼저 말하고 관리자가 동의해야 한다.
   *   `normalizeSettings` 가 `enabled && ack` 로 못 박으므로 **그 논리곱을 지우지 말 것.**
   * ⚠ `enterpriseMode` — `auto`(기본: API 로 못 읽은 것만 SSH) · `api` · `ssh`.
   *   SSH 만 고르면 세션이 항상 열린다(부하가 가장 크다) — 회선·장비를 보며 고르게 한다.
   * ⚠ 이 경로는 **iDRAC 경로의 확장**이다 — `idracTelemetry` 를 끄면 함께 돌지 않는다
   *   (그 설정이 'iDRAC 로 수집할지' 를 정하는 축이다).
   */
  enterpriseEnabled: false,
  enterpriseAck: false,
  enterpriseAckAt: 0,
  enterpriseAckBy: '',
  enterpriseMode: 'auto',
  /*
   * 임계 초과 알림(v2.551 — 사용자 요청). ⚠ **기본 꺼짐**이다: 200대 × 5분이면 하루 5.76만 판정이라
   * 폭주 위험이 실재한다. 켜기 전에 임계·지속·재알림을 확인하게 한다.
   *  · `alertSustainMin` — 연속 초과가 이만큼 지속돼야 알린다(한 주기 스파이크 무시)
   *  · `alertRepeatHours` — 같은 서버·같은 지표의 재알림 억제
   */
  alertEnabled: false,
  alertPct: 90,
  alertSustainMin: 15,
  alertRepeatHours: 6,
});

/** 하한·상한은 서버가 강제한다(화면 입력을 믿지 않는다). */
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 6 * 3_600_000;

let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 3_000;

// v2.631(EDGE2631-01): 중앙에서는 이 파일이 **배포 원본**이다. 손상이면 기본값(꺼짐·빈 법인)으로 떨어지는데, 그 기본값을
//   배포 라우트가 200 으로 내려보내면 전 엣지의 수집이 꺼진다 — 로드 오류를 기억해 /api/central/bmusage-config 가 503 으로 답한다.
const _localErr = makeSettingsLoadError(FILE, { label: '베어메탈 사용률 설정', confirm: () => saveBmUsageSettings({}) });
const _distErr = makeSettingsLoadError(DIST_FILE, { label: '베어메탈 사용률 배포', confirm: ({ by } = {}) => saveDistribution({}, by || '') });
function readFile() {
  if (!fs.existsSync(FILE())) { _localErr.missing(); return {}; }
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (!raw || typeof raw !== 'object') throw new Error('객체가 아닌 JSON 값');
    _localErr.ok();
    return raw;
  } catch (e) { _localErr.corrupt(e); if (fs.existsSync(FILE())) preserveCorrupt(FILE(), e.message); return {}; } // v2.582 ARCH-1: 손상이면 보존 후 기본값 — 법인 opt-in·Enterprise 동의 기록(누가·언제)이 든 사용자 설정이라 조용히 버리지 않는다
}

/**
 * v2.631(EDGE2631-01): 배포에 쓰는 설정 두 파일(배포 켬/제외 · 로컬 설정) 중 하나라도 못 읽었으면 그 사유. 둘 다 읽었으면 null.
 *   중앙 배포 라우트만 이 값을 본다 — 중앙 자신의 로컬 동작은 예전처럼 기본값(꺼짐)이다.
 */
export function bmUsageSettingsLoadError() {
  loadDistribution();
  readFile();
  const d = _distErr.get(); const l = _localErr.get();
  if (d) return { at: d.at, reason: `배포 설정(bmusage-distribute.json): ${d.reason}` };
  if (l) return { at: l.at, reason: `사용률 설정(bmusage-settings.json): ${l.reason}` };
  return null;
}

/** 정규화(순수) — 테스트가 하한·상한을 고정한다. */
export function normalizeSettings(raw = {}) {
  const corps = {};
  const src = raw.corps && typeof raw.corps === 'object' ? raw.corps : {};
  for (const [k, v] of Object.entries(src)) {
    const id = String(k || '').trim();
    if (id && v) corps[id] = true;          // 켠 것만 남긴다(false 를 쌓아 두지 않는다)
  }
  return {
    enabled: !!raw.enabled,
    corps,
    includeUnassigned: !!raw.includeUnassigned,
    includeVirtualization: raw.includeVirtualization === true,
    intervalMs: clampSetting(raw.intervalMs, { min: MIN_INTERVAL_MS, max: MAX_INTERVAL_MS, def: DEFAULTS.intervalMs }),
    // 원시 보존은 행 수를 직접 정한다 — 하한 7일(그 아래면 증가 추세를 못 본다), 상한 365일.
    idracFullTelemetry: raw.idracFullTelemetry !== false,
    /*
     * ⚠⚠ **동의 없이는 켜지지 않는다**(위 DEFAULTS 주석). 이 논리곱이 사용자 지시의 집행부다 —
     *   화면이 부하를 고지하고 관리자가 `enterpriseAck` 를 보내야 대체 수집이 돈다.
     *   `enterpriseAck` 자체는 기록으로 남긴다(끄고 다시 켤 때 누가·언제 동의했는지 보이게).
     */
    enterpriseAck: raw.enterpriseAck === true,
    enterpriseEnabled: raw.enterpriseEnabled === true && raw.enterpriseAck === true,
    enterpriseAckAt: Number(raw.enterpriseAckAt) > 0 ? Math.round(Number(raw.enterpriseAckAt)) : 0,
    enterpriseAckBy: String(raw.enterpriseAckBy || '').trim().slice(0, 64),
    enterpriseMode: ['auto', 'api', 'ssh'].includes(String(raw.enterpriseMode || '').trim()) ? String(raw.enterpriseMode).trim() : DEFAULTS.enterpriseMode,
    alertEnabled: raw.alertEnabled === true,
    alertPct: clampSetting(raw.alertPct, { min: 50, max: 100, def: DEFAULTS.alertPct }),
    alertSustainMin: clampSetting(raw.alertSustainMin, { min: 0, max: 240, def: DEFAULTS.alertSustainMin }),
    alertRepeatHours: clampSetting(raw.alertRepeatHours, { min: 1, max: 168, def: DEFAULTS.alertRepeatHours }),
    rawRetentionDays: clampSetting(raw.rawRetentionDays, { min: 7, max: 365, def: DEFAULTS.rawRetentionDays }),
    dailyRetentionDays: clampSetting(raw.dailyRetentionDays, { min: 30, max: 365 * 10, def: DEFAULTS.dailyRetentionDays }),
    osSsh: raw.osSsh === undefined ? DEFAULTS.osSsh : !!raw.osSsh,
    idracTelemetry: raw.idracTelemetry === undefined ? DEFAULTS.idracTelemetry : !!raw.idracTelemetry,
  };
}

/** 이 노드의 **로컬 파일** 값(중앙 사본을 겹치지 않은 것). 중앙은 곧 이것이 배포 원본이다. */
export function loadLocalBmUsageSettings() { return normalizeSettings(readFile()); }

/** 유효 설정 — 엣지가 중앙 배포를 받고 있으면 배포 키만 중앙 값으로 덮는다(Enterprise 는 언제나 로컬). */
export function loadBmUsageSettings() {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_MS) return _cache;
  const local = readFile();
  const copy = readCentralCopy();
  _cache = normalizeSettings(copy ? { ...local, ...pickDistributed(copy.settings) } : local);
  _cacheAt = now;
  return _cache;
}

/* ── v2.627 중앙 배포 ─────────────────────────────────────────────────────────── */
function pickDistributed(src = {}) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const k of DISTRIBUTED_KEYS) if (Object.hasOwn(src, k)) out[k] = src[k];
  return out;
}
const t = (v) => String(v ?? '').trim();
// v2.682(R3E-06): 인출 기록 Map 키 — 공유 토큰 ?agent= 원문 길이가 무제한이라 .slice 만 하면 SlicedString 이 원문을 붙잡는다(v2.606 capStr 규약).
const lowerAgent = (v) => capStr(t(v).slice(0, 256).toLowerCase(), 128);

let _copy; // undefined = 아직 안 읽음 · null = 없음
function readCentralCopy() {
  if (_copy !== undefined) return _copy;
  try {
    const j = JSON.parse(fs.readFileSync(CENTRAL_COPY_FILE(), 'utf8'));
    _copy = j && typeof j === 'object' && j.settings && typeof j.settings === 'object' ? j : null;
  } catch (e) { if (fs.existsSync(CENTRAL_COPY_FILE())) preserveCorrupt(CENTRAL_COPY_FILE(), e.message); _copy = null; }
  return _copy;
}

/** 배포 원본의 서명 — 엣지가 '적용한 판' 을 중앙에 알려 화면이 '적용됨/대기' 를 가른다. */
export function settingsSig(settings = {}) {
  const pick = pickDistributed(normalizeSettings(settings));
  const ordered = {};
  for (const k of DISTRIBUTED_KEYS) ordered[k] = k === 'corps' ? Object.keys(pick.corps || {}).sort() : pick[k];
  return crypto.createHash('sha1').update(JSON.stringify(ordered)).digest('hex').slice(0, 16);
}

/** 엣지: 중앙이 내려준 배포 값 적용. 바뀌었을 때만 true(그때만 파일을 쓰고 폴러를 재무장한다). */
export function applyCentralBmUsage({ settings, sig } = {}) {
  if (!settings || typeof settings !== 'object') throw new Error('배포 설정 본문 없음');
  const picked = pickDistributed(normalizeSettings(settings));
  const s = t(sig) || settingsSig(picked);
  const cur = readCentralCopy();
  if (cur && cur.sig === s) { cur.at = Date.now(); return false; }
  const next = { managed: true, at: Date.now(), sig: s, settings: picked };
  fs.mkdirSync(path.dirname(CENTRAL_COPY_FILE()), { recursive: true });
  atomicWriteFileSync(CENTRAL_COPY_FILE(), JSON.stringify(next, null, 2), { mode: 0o600 });
  _copy = next; _cache = null;
  notifyChange();
  return true;
}

/** 엣지: 중앙이 배포를 끄거나 이 엣지를 제외했다 — 사본을 지워 로컬 설정으로 되돌린다. 바뀌었으면 true. */
export function clearCentralBmUsage() {
  const cur = readCentralCopy();
  if (!cur) return false;
  try { fs.rmSync(CENTRAL_COPY_FILE(), { force: true }); } catch { /* 다음 판정에서 다시 본다 */ }
  _copy = null; _cache = null;
  notifyChange();
  return true;
}

/** 이 노드가 지금 중앙 배포값을 쓰는가 — 화면 배너·설정 잠금의 근거. */
export function bmUsageCentralState() {
  const c = readCentralCopy();
  return c ? { managed: true, at: c.at || 0, sig: c.sig || '', keys: [...DISTRIBUTED_KEYS] } : { managed: false };
}

/** 중앙: 배포 설정(켬/끔 + 제외 엣지). 손상이면 보존 후 **꺼짐**(켜진 척하지 않는다). */
export function loadDistribution() {
  if (!fs.existsSync(DIST_FILE())) { _distErr.missing(); return normalizeDistribution({}); }
  try {
    const j = JSON.parse(fs.readFileSync(DIST_FILE(), 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('객체가 아닌 JSON 값');
    _distErr.ok();
    return normalizeDistribution(j);
  } catch (e) { _distErr.corrupt(e); if (fs.existsSync(DIST_FILE())) preserveCorrupt(DIST_FILE(), e.message); return normalizeDistribution({}); }
}
export function normalizeDistribution(raw = {}) {
  // v2.628(SEC2628-03): 엣지 이름은 외부 값이다 — '__proto__'·'constructor' 가 프로토타입을 건드리거나 상속 속성으로
  //   '제외됨' 이 되지 않게 프로토타입 없는 객체에 담고, 조회는 자기 속성만(isExcluded) 본다.
  const excluded = Object.create(null);
  const src = raw && typeof raw.excluded === 'object' && raw.excluded ? raw.excluded : {};
  for (const [k, v] of Object.entries(src)) { const a = lowerAgent(k); if (a && v === true) excluded[a] = true; }
  return { enabled: raw?.enabled === true, excluded, updatedAt: Number(raw?.updatedAt) > 0 ? Number(raw.updatedAt) : 0, updatedBy: t(raw?.updatedBy).slice(0, 64) };
}
export function saveDistribution(patch = {}, by = '') {
  const cur = loadDistribution();
  const next = normalizeDistribution({
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
    excluded: patch.excluded && typeof patch.excluded === 'object' ? patch.excluded : cur.excluded,
    updatedAt: Date.now(), updatedBy: by,
  });
  fs.mkdirSync(path.dirname(DIST_FILE()), { recursive: true });
  atomicWriteFileSync(DIST_FILE(), JSON.stringify(next, null, 2), { mode: 0o600 });
  _distErr.ok();
  return next;
}

const isExcluded = (d, a) => Object.hasOwn(d.excluded, a) && d.excluded[a] === true;

/** 중앙이 한 엣지에 내려줄 값. 배포 원본은 **중앙의 로컬 설정**이다(중앙은 사본을 갖지 않는다). */
export function distributeFor(agent) {
  const d = loadDistribution();
  if (!d.enabled) return { distribute: false, reason: 'off' };
  if (isExcluded(d, lowerAgent(agent))) return { distribute: false, reason: 'excluded' };
  const settings = pickDistributed(loadLocalBmUsageSettings());
  return { distribute: true, settings, sig: settingsSig(settings) };
}

/* 엣지별 마지막 인출(인메모리 — 중앙 재시작 직후엔 비어 있고 화면이 그 사실을 말한다). */
const _pulls = new Map();
const _startedAt = Date.now();
const PULLS_MAX = 512;
const PULL_ACTIVE_MS = 60 * 60_000;       // v2.632 A6-2632-03: 이 안에 인출한 미검증 기록은 새 미검증 이름이 밀어내지 못한다
const UNKNOWN_UNVERIFIED_ROWS_MAX = 32;   // v2.632 A6-2632-03: 등록부에 없는 미검증 이름은 이만큼만 행으로(나머지는 개수만)
let _pullsOmitted = 0;                    // 상한으로 거절한 미검증 인출 수(프로세스 수명 누계)
// v2.628(SEC2628-02): 공유 토큰 인출의 이름은 검증되지 않았다(v2.589 규약) — verified 로 구분하고, 개별 토큰으로 검증된
//   기록을 미검증 인출이 덮지 않게 한다(공유 토큰으로 남의 이름을 대 '적용됨' 을 만들 수 없게). 화면이 미검증을 밝힌다.
// v2.629(A1-2629-04): 그 보호가 **영구 잠금** 이면 엣지가 개별 토큰 → 공유 토큰으로 바뀐 뒤(토큰 폐기·재발급 전 구간) 행이
//   중앙 재시작 때까지 옛 시각·옛 판으로 굳는다. 검증 기록이 `VERIFIED_HOLD_MS`(1시간 — 배포 인출 기본 10분의 6배) 넘게
//   갱신되지 않았으면 미검증 인출이 덮는다. 덮은 기록은 verified:false 이고 `lapsedVerifiedAt` 에 옛 검증 시각을 남긴다.
export const VERIFIED_HOLD_MS = 60 * 60_000;
export function recordBmUsagePull(agent, { appliedSig = '', version = '', reason = '', verified = false, deliveredSig = '', now = Date.now() } = {}) {
  const a = lowerAgent(agent);
  if (!a) return;
  const prev = _pulls.get(a);
  if (!verified && prev?.verified && now - (prev.at || 0) <= VERIFIED_HOLD_MS) return;
  if (!_pulls.has(a) && _pulls.size >= PULLS_MAX) {
    // v2.632(감사 A6-2632-03): 상한 퇴출이 검증 여부를 보지 않아, 공유 토큰으로 임의 ?agent= 이름 512개를 대면 **개별 토큰으로
    //   검증된 실제 엣지의 기록**이 밀려났다(화면 '인출 기록 없음'). 퇴출은 미검증부터 — 검증된 새 기록은 가장 오래된 미검증을,
    //   미검증 새 기록은 최근 PULL_ACTIVE_MS 안에 인출하지 않은 미검증만 밀어낸다(살아 있는 엣지는 10분마다 인출한다).
    //   밀어낼 것이 없으면 미검증 새 기록은 **거절**하고 개수를 밝힌다(v2.589 pullStats · v2.593 R2593-04 와 같은 규약).
    let victim = null;
    for (const [k, p] of _pulls) {
      if (p.verified) continue;
      if (!verified && now - (p.at || 0) < PULL_ACTIVE_MS) continue;
      victim = k; break;   // Map 은 삽입 순 = 가장 오래 갱신되지 않은 것부터
    }
    if (victim == null && verified) victim = _pulls.keys().next().value;
    if (victim == null) { _pullsOmitted += 1; return; }
    _pulls.delete(victim);
  }
  _pulls.delete(a);
  const lapsedVerifiedAt = !verified && prev?.verified ? prev.at : (!verified ? prev?.lapsedVerifiedAt || 0 : 0);
  _pulls.set(a, { agent: capStr(t(agent), 128), at: now, appliedSig: capStr(t(appliedSig), 32), version: capStr(t(version), 32), reason: capStr(t(reason), 32), verified: verified === true, deliveredSig: capStr(t(deliveredSig), 32), ...(lapsedVerifiedAt ? { lapsedVerifiedAt } : {}) });
}
/** 화면용 — 알려진 엣지 이름(대소문자 무시)과 인출 기록을 합친다. */
export function distributionStatus(knownNames = []) {
  const d = loadDistribution();
  const cur = settingsSig(loadLocalBmUsageSettings());
  const names = new Map();
  for (const n of knownNames || []) { const k = lowerAgent(n); if (k && !names.has(k)) names.set(k, t(n)); }
  // v2.632(감사 A6-2632-03): 등록부에 없는 **미검증** 이름(공유 토큰이 ?agent= 로 댄 것)은 최근 것 UNKNOWN_UNVERIFIED_ROWS_MAX 개만
  //   행으로 싣고 나머지는 개수만 밝힌다 — 가짜 이름 512행이 배포 현황을 덮지 않게. 검증된 이름은 전부 싣는다.
  const unknownUnverified = [];
  for (const [k, p] of _pulls) {
    if (names.has(k)) continue;
    if (p.verified) names.set(k, p.agent || k); else unknownUnverified.push([k, p]);
  }
  unknownUnverified.sort((x, y) => (y[1].at || 0) - (x[1].at || 0));
  for (const [k, p] of unknownUnverified.slice(0, UNKNOWN_UNVERIFIED_ROWS_MAX)) names.set(k, p.agent || k);
  const unknownUnverifiedOmitted = Math.max(0, unknownUnverified.length - UNKNOWN_UNVERIFIED_ROWS_MAX);
  const rows = [...names].map(([k, name]) => {
    const p = _pulls.get(k) || null;
    const excluded = isExcluded(d, k);
    let state;
    if (!d.enabled || excluded) state = excluded ? 'excluded' : 'off';
    else if (!p) state = 'no-pull';
    else if (p.appliedSig && p.appliedSig === cur) state = 'applied';
    // v2.628(R2628-05): 엣지는 받기 전 판을 알린다 — 마지막 응답이 지금 판을 보냈으면 '전달됨'(적용 확인은 다음 인출).
    else if (p.deliveredSig && p.deliveredSig === cur) state = 'delivered';
    else state = 'pending';
    return { agent: name, excluded, lastPullAt: p?.at || 0, appliedSig: p?.appliedSig || '', state, verified: p ? p.verified === true : null, lapsedVerifiedAt: p?.lapsedVerifiedAt || null, pullReason: p?.reason || '' };
  }).sort((a, b) => a.agent.localeCompare(b.agent));
  return { ...d, sig: cur, keys: [...DISTRIBUTED_KEYS], rows, since: _startedAt, unknownUnverifiedOmitted, pullsOmitted: _pullsOmitted };
}

/*
 * ⚠⚠ v2.583 감사 #36 — 저장 **패치**에서 숫자 필드의 '빈 값·0(하한 > 0 인 필드)' 은 **미지정**이다.
 *   화면 숫자칸을 비우고 나가면 `Number('') === 0` 이 PUT 되고, clampInt 가 그것을 **하한으로 승격**해
 *   원시 보존 90→7일 · 롤업 5년→30일로 줄였다 — 다음 prune 이 그 차이만큼 이력을 **지운다**(되돌릴 수 없다).
 *   storage/intervals.js v2.409 의 '빈 값·0 은 하한으로 승격하지 않고 미지정으로 버린다' 와 같은 규칙이다.
 *   정규화(normalizeSettings)의 하한 강제는 그대로 둔다 — 이 필터는 **패치 입력**에만 건다.
 */
const PATCH_NUM_MIN = Object.freeze({
  intervalMs: MIN_INTERVAL_MS, rawRetentionDays: 7, dailyRetentionDays: 30,
  alertPct: 50, alertSustainMin: 0, alertRepeatHours: 1,
});
export function dropUnspecifiedNumbers(body = {}) {
  const out = { ...(body && typeof body === 'object' ? body : {}) };
  const dropped = [];
  for (const [k, lo] of Object.entries(PATCH_NUM_MIN)) {
    if (!Object.hasOwn(out, k)) continue;
    const v = out[k];
    const blank = v == null || (typeof v === 'string' && v.trim() === '');
    const n = blank ? NaN : Number(v);
    if (blank || !Number.isFinite(n) || (lo > 0 && n === 0)) { delete out[k]; dropped.push(k); }
  }
  return { patch: out, dropped };
}

// v2.591 L10: 값이 바뀌면 무장된 타이머를 즉시 재무장하게 알린다(v2.409 '값 변경 시 즉시 재무장' 규약 — vmseries·curuser 와 같은 형태).
//   없으면 주기를 길게 둔 뒤 줄여도 옛 주기(최대 6시간)가 지나야 새 주기가 먹었다.
const _listeners = new Set();
export function onBmUsageSettingsChange(cb) { _listeners.add(cb); return () => _listeners.delete(cb); }
function notifyChange() { for (const cb of _listeners) { try { cb(); } catch { /* 리스너 실패가 저장을 막지 않는다 */ } } }
/**
 * 저장은 **로컬 파일**에 한다. v2.627: 이 엣지가 중앙 배포를 받는 중이면 배포 키는 저장하지 않고 `ignoredCentralManaged` 로
 * 돌려준다(화면이 '중앙이 정한 값이라 무시했다' 를 말한다 — 저장해도 다음 계산에서 중앙 값이 이기므로 조용히 버리면 거짓이다).
 */
export function saveBmUsageSettings(body = {}) {
  const { patch } = dropUnspecifiedNumbers(body);
  const ignoredCentralManaged = [];
  if (readCentralCopy()) for (const k of DISTRIBUTED_KEYS) if (Object.hasOwn(patch, k)) { delete patch[k]; ignoredCentralManaged.push(k); }
  const local = normalizeSettings({ ...normalizeSettings(readFile()), ...patch });
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  atomicWriteFileSync(FILE(), JSON.stringify(local, null, 2), { mode: 0o600 });
  _localErr.ok();
  _cache = null;
  const next = loadBmUsageSettings();
  notifyChange();
  if (!ignoredCentralManaged.length) return next;
  const out = { ...next };
  Object.defineProperty(out, 'ignoredCentralManaged', { value: ignoredCentralManaged, enumerable: false });
  return out;
}

/** env 로 강제 끄기(현장 탈출구). `BMUSAGE_ENABLED=false` 면 설정과 무관하게 꺼진다. */
export function bmUsageEnabled() {
  const env = String(process.env.BMUSAGE_ENABLED || '').trim().toLowerCase();
  if (env === 'false' || env === '0') return false;
  if (env === 'true' || env === '1') return true;
  return demoOn(loadBmUsageSettings().enabled);
}

/**
 * Enterprise 대체 수집이 **실제로 돌아야 하는가**(순수). 한 곳에서만 판정한다 —
 * 폴러·라우트·화면이 각자 `enabled && ack` 를 쓰면 한 곳을 고칠 때 갈라진다.
 */
export function enterpriseActive(settings = loadBmUsageSettings()) {
  const env = String(process.env.BMUSAGE_ENTERPRISE || '').trim().toLowerCase();
  if (env === 'false' || env === '0') return false;          // 현장 탈출구(장비 부하가 문제일 때)
  return !!(settings.enterpriseEnabled && settings.enterpriseAck && settings.idracTelemetry);
}

export function _resetForTest() { _cache = null; _cacheAt = 0; _copy = undefined; _pulls.clear(); _pullsOmitted = 0; }
