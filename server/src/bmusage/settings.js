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
  /*
   * v2.919(리눅스 성능 1단계): USE 판정 기준값 — **이 노드(법인 엣지)의 설정**이고 API 가 내려준다(화면에 박지 않는다).
   *   판정은 bmusage/useJudge.js 하나가 이 값으로 한다. ⚠ 중앙 배포(DISTRIBUTED_KEYS)에는 아직 넣지 않았다 — 넣으면 배포 서명이 바뀌어
   *   구버전 엣지가 영원히 '적용 대기' 로 보인다(혼재 버전 호환). 배포는 엣지가 전부 이 판으로 오른 뒤의 일이다.
   */
  perf: null,   // normalizeSettings 가 PERF_DEFAULTS 로 채운다
  /*
   * v2.922(3a 단계 — 설계 README §4.4 사용자 확정 2026-11-06): 저장 구조·장치별 이력·피크 수집 설정. perf 와 같이 **이 노드의 설정**이고
   *   중앙 배포 키(DISTRIBUTED_KEYS)에는 넣지 않는다(넣으면 배포 서명이 바뀌어 구버전 엣지가 ‘적용 대기’ 로 남는다 — perf 와 같은 이유).
   */
  store: null,  // normalizeSettings 가 STORE_DEFAULTS 로 채운다
  /*
   * v2.923(4단계 — 진단 스냅샷 · 설계 README §4.1): 사람이 누를 때만 도는 SSH 1회 · 읽기 전용. 이 노드(법인 엣지)의 설정이고 배포 키에 넣지 않는다(perf · store 와 같은 이유).
   *   법인 · 엣지 · Bareos 는 1:1:1 이라 ‘법인당 하루 상한’ 은 그 법인을 수집하는 노드가 지킨다(중앙 직접 수집분은 중앙이).
   */
  snapshot: null, // normalizeSettings 가 SNAPSHOT_DEFAULTS 로 채운다
});

/**
 * v2.923 — 진단 스냅샷 기본값. dailyCorpMax 20(법인당 24시간 안 실행 상한 — 임의 시작값 · 추정) · topN 10(프로세스 상위 N) · dmesgLines 50(커널 로그 최근 N줄).
 *   보존 7일은 설계 고정값(SNAPSHOT_KEEP_DAYS — 설정으로 늘리지 않는다: 프로세스 이름 · 커널 로그가 쌓인다).
 */
export const SNAPSHOT_DEFAULTS = Object.freeze({ dailyCorpMax: 20, topN: 10, dmesgLines: 50 });
const SNAPSHOT_LIMITS = Object.freeze({ dailyCorpMax: [1, 500], topN: [3, 30], dmesgLines: [10, 200] });
export const SNAPSHOT_KEEP_DAYS = 7;
export function normalizeSnapshotSettings(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [k, [min, max]] of Object.entries(SNAPSHOT_LIMITS)) out[k] = clampSetting(src[k], { min, max, def: SNAPSHOT_DEFAULTS[k] });
  return out;
}

/**
 * v2.922 — 저장 구조·피크 기본값(설계 §4.4 · PROFILES §6 끝 ‘피크 수집 3안’ · §9 · §10).
 *  · rawDays 30(5분 원시 · 월 파일) — 실제 보존은 min(이 값, 기존 rawRetentionDays)다(기존 키를 더 짧게 둔 현장의 결정을 늘리지 않는다).
 *  · hourlyDays 365(1시간 롤업) · 1일 롤업은 기존 dailyRetentionDays(5년) 그대로 · 장치 5분 14일 · 장치 1시간 90일(설계).
 *  · deviceMax 32(서버당 장치 수 상한 — 넘으면 ‘상한 초과 n’) · partitionIo 꺼짐(파티션 I/O 는 옵트인) · blkqMax 64(##BLKQ 장치 수 — D7).
 *  · peakWindowS 10(A 안: 같은 SSH 세션 안 1초 간격 창 — 0 이면 끔. 세션 예산이 모자라면 줄이고 행에 적는다).
 *  · peakSampler 꺼짐(B 안 — 서버 샘플러 파일 수거. 이번 단계는 수거 구획·형식 명세·해시 **기록** 자리만 — 파일 머리 줄의 sha256 은 자기 신고 값이라
 *    설정값과 같아도 위조 방지가 아니다(반증 D13). 스크립트 실물 대조·배포는 7단계).
 *  · portTolPct 5(CVP 양쪽 대조 ⑤ 의 어긋남 기준 — 설계 ‘예 5%’ · 임의 시작값).
 */
export const STORE_DEFAULTS = Object.freeze({
  rawDays: 30, hourlyDays: 365, devRawDays: 14, devHourlyDays: 90,
  deviceMax: 32, partitionIo: false, blkqMax: 64,
  peakWindowS: 10, peakSampler: false, peakSamplerSha256: '',
  // 피크 창 주기 예산 — 예상 주기 소요가 주기 × 이 비율을 넘으면 창을 줄인다(peakPlan.js · 0.7 은 메인 지시값). peakWindowS 는 그 상한이다.
  peakCycleRatio: 0.7,
  portTolPct: 5,
});
const STORE_LIMITS = Object.freeze({
  rawDays: [7, 365, false], hourlyDays: [30, 730, false], devRawDays: [1, 60, false], devHourlyDays: [7, 365, false],
  deviceMax: [1, 256, false], blkqMax: [1, 1_024, false], peakWindowS: [0, 30, false], peakCycleRatio: [0.3, 0.95, true], portTolPct: [0.5, 100, true],
});
/** 저장 구조 설정 정규화(순수) — 모르는 키는 버리고, 빈 칸은 기본값(clampSetting 규약). sha256 은 64자리 16진수만(아니면 ''). */
export function normalizeStoreSettings(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [k, [min, max, frac]] of Object.entries(STORE_LIMITS)) out[k] = clampSetting(src[k], { min, max, def: STORE_DEFAULTS[k], round: !frac });
  // peakWindowS 0 = 끔 — clampSetting 의 '0 은 미지정' 규약과 달리 명시적 0 을 지킨다(끄는 값이다).
  if (src.peakWindowS === 0 || src.peakWindowS === '0') out.peakWindowS = 0;
  out.partitionIo = src.partitionIo === true;
  out.peakSampler = src.peakSampler === true;
  const sha = String(src.peakSamplerSha256 || '').trim().toLowerCase();
  out.peakSamplerSha256 = /^[0-9a-f]{64}$/.test(sha) ? sha : '';
  return out;
}
/** 실효 원시 보존(일) — 월 파일 5분 원시. 기존 키(rawRetentionDays)를 더 짧게 둔 현장은 그 값을 따른다(늘리지 않는다). */
export function effectiveRawDays(s = {}) {
  const a = Number(s?.store?.rawDays) || STORE_DEFAULTS.rawDays;
  const b = Number(s?.rawRetentionDays) || a;
  return Math.max(1, Math.min(a, b));
}

/**
 * v2.919 — USE 판정 기준값 기본(설계 §4.2). ⚠ ‘(추정)’ 표시는 공식 권고가 아니라 **임의 시작값**이라는 뜻이다 — 현장에서 조정한다.
 *  · 사용률 warn 80 / bad 90(설계) · 런큐/코어 1.0 / 2.0(설계) · 평균 대기열 2(설계) / 4(추정) · PSI full 10초 5% / 20%(설계)
 *  · PSI cpu some 10초 20% / 50%(추정 — cpu 는 full 이 시스템 수준에서 0 이라 some 을 쓴다) · 스왑 아웃 1 / 100 pages/s(추정)
 *  · TCP 재전송 1% / 5%(추정) · 오류·드롭: 증가분 > 0 → warn, `errRepeatBad` 주기 연속 증가 → bad(설계 ‘반복 → bad’ — 3 은 추정)
 *  · OS↔iDRAC CPU 불일치 15%p(설계 — 임의 시작값) · 흡기 온도 27 / 35℃(추정 — ASHRAE 권장 상한 · A2 허용 상한) · 전력 cap 대비 90 / 98%(추정)
 */
export const PERF_DEFAULTS = Object.freeze({
  utilWarn: 80, utilBad: 90,
  runqWarn: 1, runqBad: 2,
  queueWarn: 2, queueBad: 4,
  psiFullWarn: 5, psiFullBad: 20,
  psiCpuSomeWarn: 20, psiCpuSomeBad: 50,
  swapOutWarn: 1, swapOutBad: 100,
  retransWarn: 1, retransBad: 5,
  errRepeatBad: 3,
  cpuMismatchPct: 15,
  inletWarnC: 27, inletBadC: 35,
  powerCapWarnPct: 90, powerCapBadPct: 98,
  // v2.919(반증 D5): 경로가 있는 칸 중 판정한 칸이 이 비율(%) 미만이면 ‘정상’ 대신 ‘대부분 못 읽음’(50 은 추정 시작값).
  minJudgedPct: 50,
});
/** 기준값 범위(서버가 강제 — 화면 입력을 믿지 않는다). [min, max, 소수 허용] */
const PERF_LIMITS = Object.freeze({
  utilWarn: [1, 100, false], utilBad: [1, 100, false],
  runqWarn: [0.1, 64, true], runqBad: [0.1, 64, true],
  queueWarn: [0.1, 1_024, true], queueBad: [0.1, 1_024, true],
  psiFullWarn: [0.1, 100, true], psiFullBad: [0.1, 100, true],
  psiCpuSomeWarn: [0.1, 100, true], psiCpuSomeBad: [0.1, 100, true],
  swapOutWarn: [0.1, 1e7, true], swapOutBad: [0.1, 1e7, true],
  retransWarn: [0.01, 100, true], retransBad: [0.01, 100, true],
  errRepeatBad: [1, 1_000, false],
  cpuMismatchPct: [1, 100, false],
  inletWarnC: [10, 60, false], inletBadC: [10, 70, false],
  powerCapWarnPct: [10, 100, false], powerCapBadPct: [10, 100, false],
  minJudgedPct: [0, 100, false],
});
/** 기준값 정규화(순수) — 모르는 키는 버리고, 빈 칸은 기본값(clampSetting 규약), warn 이 bad 보다 크면 bad 를 warn 으로 올린다. */
export function normalizePerfThresholds(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [k, [min, max, frac]] of Object.entries(PERF_LIMITS)) {
    out[k] = clampSetting(src[k], { min, max, def: PERF_DEFAULTS[k], round: !frac });
  }
  for (const base of ['util', 'runq', 'queue', 'psiFull', 'psiCpuSome', 'swapOut', 'retrans', 'inlet', 'powerCap']) {
    const w = base === 'inlet' ? 'inletWarnC' : base === 'powerCap' ? 'powerCapWarnPct' : `${base}Warn`;
    const b = base === 'inlet' ? 'inletBadC' : base === 'powerCap' ? 'powerCapBadPct' : `${base}Bad`;
    if (out[w] > out[b]) out[b] = out[w];
  }
  return out;
}

/** 하한·상한은 서버가 강제한다(화면 입력을 믿지 않는다). */
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 6 * 3_600_000;

let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 3_000;

// v2.631(EDGE2631-01): 중앙에서는 이 파일이 **배포 원본**이다. 손상이면 기본값(꺼짐·빈 법인)으로 떨어지는데, 그 기본값을
//   배포 라우트가 200 으로 내려보내면 전 엣지의 수집이 꺼진다 — 로드 오류를 기억해 /api/central/bmusage-config 가 503 으로 답한다.
const _localErr = makeSettingsLoadError(FILE, { label: '베어메탈 사용률 설정', confirm: () => saveBmUsageSettings({}) });
const _distErr = makeSettingsLoadError(DIST_FILE, { label: '베어메탈 사용률 배포(전체 배포 · 제외 · 중앙 켜기 — 기본값으로 확정하면 모두 비워집니다)', confirm: ({ by } = {}) => saveDistribution({}, by || '') });
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
    perf: normalizePerfThresholds(raw.perf),   // v2.919
    store: normalizeStoreSettings(raw.store),   // v2.922
    snapshot: normalizeSnapshotSettings(raw.snapshot),   // v2.923
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
/*
 * v2.927 '중앙에서 켜기'(사용자 요청 "중앙에서 엣지를 켜는 기능 추가" · 선택: 엣지별 버튼) — `perEdge: { [agent소문자]: { on, at, by, corps } }`.
 *   전체 배포(위 enabled)를 켜지 않고 **한 엣지만** 중앙이 켠다. 내려가는 값은 중앙 로컬 설정의 배포 키 **전부**이되 켜기 = true ·
 *   법인 = **저장 때 확정한 그 엣지 법인**(`corps` — 관리자가 확인 상자에서 본 목록). ⚠ 엣지 코드는 바꾸지 않는다 — 2.627 이상 엣지의
 *   applyCentralBmUsage 는 받은 본문을 normalizeSettings 로 채워 배포 키 **전부**를 덮으므로(빠진 키는 기본값이 된다), 일부 키만 보내면
 *   엣지의 주기·보존이 기본값으로 바뀐다. 그래서 주기·보존·경로·알림도 중앙 값으로 바뀐다 — 화면 확인 문구가 그 사실을 말한다.
 * ⚠⚠ 법인은 **저장 때 확정**한다(반증 F2·F3): 인출 때 매핑을 다시 계산하면 점검중 · 비활성 · push 전 · fleet 만료 · 중앙 재기동 같은 순간 상태에
 *   법인이 빠지고, 0 이면 엣지가 사본을 지워 수집이 꺼졌다. 저장 목록을 그대로 보내고, 지금 매핑과 다르면 화면이 '다시 확인' 을 받는다.
 *   법인 없는 항목은 만들 수 없다(라우트가 400 no-corps) — 손으로 고친 파일의 빈 항목은 버리고 개수를 밝힌다(perEdgeOmitted).
 * ⚠⚠ 우선순위(조용한 우선순위 금지 — 결정과 근거, 테스트 `bmUsageEdgeOn2927.test.js`):
 *   ① 전체 배포 켜짐 + 제외 아님 → 전체 배포(v2.627 동작 그대로 — 기존 구성의 동작을 바꾸지 않는다). 그 엣지의 중앙 켜기는 **가려지고**
 *      상태 행이 `perEdgeSuperseded` 로 밝힌다. 이미 전체 배포를 받는 엣지에 새로 켜기를 저장하는 것은 409(`conflict:'all'`)로 막는다.
 *   ② 중앙 켜기 → 이 엣지만 켜기(개별 토큰 인출에만 — 아래 distributeFor).
 *   ③ 제외 · 꺼짐 → 엣지 로컬.
 *   · 제외와 중앙 켜기는 **같은 엣지에 동시에 둘 수 없다**(저장이 양방향 409 — '이 엣지는 로컬 설정' 과 '중앙이 켠다' 는 서로 반대 지시다).
 *     관리자가 하나를 먼저 풀게 한다. 파일을 손으로 고쳐 둘 다 생기면 **제외가 이긴다**(장비 부하를 더하지 않는 쪽 · 행 `conflict:true`).
 * ⚠ 손상 파일의 '기본값으로 확정'(설정 파일 점검 — saveDistribution({}))은 전체 배포 · 제외 · 중앙 켜기를 **모두 비운다**(라벨이 말한다).
 */
export const PER_EDGE_MAX = 256;       // 중앙 켜기 엣지 수 상한(넘는 저장은 400 too-many — 조용히 버리지 않는다)
export const PER_EDGE_CORPS_MAX = 64;  // 한 엣지에 저장하는 법인 수 상한(법인 · vCenter · 엣지 1:1:1 이라 보통 1)
const CORP_ID_MAX = 128;
/** 법인 id 목록 정규화(순수) — 글자만 · 앞뒤 공백 제거 · 길이 상한 · 중복 제거 · 정렬. 상한을 넘으면 null(저장 거절의 근거). */
export function normalizeCorpIds(list) {
  if (!Array.isArray(list)) return [];
  const set = new Set();
  for (const v of list) { if (typeof v !== 'string') continue; const k = capStr(v.trim(), CORP_ID_MAX); if (k) set.add(k); }
  return set.size > PER_EDGE_CORPS_MAX ? null : [...set].sort();
}
const sameIds = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
export function normalizeDistribution(raw = {}) {
  // v2.628(SEC2628-03): 엣지 이름은 외부 값이다 — '__proto__'·'constructor' 가 프로토타입을 건드리거나 상속 속성으로
  //   '제외됨' 이 되지 않게 프로토타입 없는 객체에 담고, 조회는 자기 속성만(isExcluded) 본다.
  const excluded = Object.create(null);
  const src = raw && typeof raw.excluded === 'object' && raw.excluded ? raw.excluded : {};
  for (const [k, v] of Object.entries(src)) { const a = lowerAgent(k); if (a && v === true) excluded[a] = true; }
  // v2.927: 중앙 켜기도 같은 규약(프로토타입 없는 객체 · 자기 속성만 · 이름 정규화 · 켠 것만 · 개수 상한). 법인 없는 항목은 버리고 센다.
  const perEdge = Object.create(null);
  const pe = raw && typeof raw.perEdge === 'object' && raw.perEdge && !Array.isArray(raw.perEdge) ? raw.perEdge : {};
  let omitted = 0;
  for (const [k, v] of Object.entries(pe)) {
    const a = lowerAgent(k);
    if (!a || !v || typeof v !== 'object' || v.on !== true || Object.hasOwn(perEdge, a)) continue;
    const corps = normalizeCorpIds(v.corps);
    if (!corps || !corps.length || Object.keys(perEdge).length >= PER_EDGE_MAX) { omitted += 1; continue; }
    perEdge[a] = { on: true, at: Number(v.at) > 0 ? Math.round(Number(v.at)) : 0, by: t(v.by).slice(0, 64), corps };
  }
  const out = { enabled: raw?.enabled === true, excluded, perEdge, updatedAt: Number(raw?.updatedAt) > 0 ? Number(raw.updatedAt) : 0, updatedBy: t(raw?.updatedBy).slice(0, 64) };
  // 버린 항목 수 — 파일에 쓰지 않는다(열거 안 됨). 배포 현황이 밝힌다.
  Object.defineProperty(out, 'perEdgeOmitted', { value: omitted, enumerable: false });
  return out;
}
function writeDistribution(next) {
  fs.mkdirSync(path.dirname(DIST_FILE()), { recursive: true });
  atomicWriteFileSync(DIST_FILE(), JSON.stringify(next, null, 2), { mode: 0o600 });
  _distErr.ok();
  return next;
}
/** 전체 배포 켬/끔 · 제외 저장. 중앙 켜기(perEdge)는 여기서 바꾸지 않는다(setPerEdge 만 — 지금 값을 그대로 둔다). */
export function saveDistribution(patch = {}, by = '') {
  const cur = loadDistribution();
  return writeDistribution(normalizeDistribution({
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
    excluded: patch.excluded && typeof patch.excluded === 'object' ? patch.excluded : cur.excluded,
    perEdge: cur.perEdge,
    updatedAt: Date.now(), updatedBy: by,
  }));
}

const isExcluded = (d, a) => Object.hasOwn(d.excluded, a) && d.excluded[a] === true;
const perEdgeOf = (d, a) => (d.perEdge && Object.hasOwn(d.perEdge, a) && d.perEdge[a]?.on === true ? d.perEdge[a] : null);
/** v2.927: 이 이름(대소문자 무시)의 중앙 켜기 항목 — 없으면 null. 해제는 등록부와 무관하게 이것으로 찾는다(반증 F1). */
export function perEdgeFor(agent, d = loadDistribution()) { return perEdgeOf(d, lowerAgent(agent)); }

/**
 * v2.927: 제외 저장 패치가 중앙 켜기와 부딪히는 엣지(소문자 이름 목록). 비면 충돌 없음 — 라우트가 409 로 막는다.
 * @param {object} excludedPatch PUT /distribute 의 excluded 맵(통째)
 */
export function exclusionConflicts(excludedPatch, d = loadDistribution()) {
  const out = [];
  if (!excludedPatch || typeof excludedPatch !== 'object') return out;
  for (const [k, v] of Object.entries(excludedPatch)) { const a = lowerAgent(k); if (a && v === true && perEdgeOf(d, a) && !out.includes(a)) out.push(a); }
  return out;
}

/** v2.927: 전체 배포가 덮어 중앙 켜기가 가려진 엣지(소문자 이름 목록) — 전체 배포를 켤 때 응답이 밝힌다. */
export function perEdgeSuperseded(d = loadDistribution()) {
  if (!d.enabled) return [];
  return Object.keys(d.perEdge || {}).filter((a) => perEdgeOf(d, a) && !isExcluded(d, a)).sort();
}

/**
 * v2.927: 한 엣지의 중앙 켜기 저장(법인 확정 · 다시 확인)/해제. 이름 검증(등록부)·역할·매핑은 라우트가 한다 — 여기는 정규화·충돌·원자적 쓰기.
 * @param {{corps?:string[]}} [o] 켤 때 저장할 법인(관리자가 확인한 목록 — 비면 거절)
 * @returns {{ok:true, changed:boolean, distribution:object} | {ok:false, conflict:'excluded'|'all', reason:string} | {ok:false, code:'bad-name'|'no-corps'|'too-many', reason:string}}
 */
export function setPerEdge(agent, on, by = '', { corps = null } = {}) {
  const a = lowerAgent(agent);
  if (!a) return { ok: false, code: 'bad-name', reason: '엣지 이름이 필요합니다.' };
  const cur = loadDistribution();
  const prev = perEdgeOf(cur, a);
  let ids = null;
  if (on === true) {
    if (isExcluded(cur, a)) {
      return { ok: false, conflict: 'excluded', reason: `이 엣지(${t(agent)})는 '엣지에 배포' 표에서 제외(자기 로컬 설정 사용)로 지정돼 있습니다 — 중앙 켜기와 반대 지시라 함께 둘 수 없습니다. 제외를 먼저 해제하세요.` };
    }
    if (cur.enabled) {
      return { ok: false, conflict: 'all', reason: `이 엣지(${t(agent)})는 이미 전체 배포를 받고 있습니다 — 켜짐 · 법인은 전체 배포 원본(이 중앙의 수집 설정)이 정합니다. 중앙 켜기는 전체 배포가 꺼져 있을 때 한 엣지만 켜는 기능입니다.` };
    }
    ids = normalizeCorpIds(corps);
    if (ids === null) return { ok: false, code: 'too-many', reason: `한 엣지에 저장하는 법인은 ${PER_EDGE_CORPS_MAX}곳까지입니다.` };
    if (!ids.length) return { ok: false, code: 'no-corps', reason: '이 엣지의 법인을 찾지 못해 켤 수 없습니다(켜도 수집 대상이 없습니다).' };
    if (prev && sameIds(prev.corps, ids)) return { ok: true, changed: false, distribution: cur };
    if (!prev && Object.keys(cur.perEdge).length >= PER_EDGE_MAX) return { ok: false, code: 'too-many', reason: `중앙 켜기는 ${PER_EDGE_MAX}곳까지입니다 — 쓰지 않는 엣지의 중앙 켜기를 먼저 해제하세요.` };
  } else if (!prev) {
    return { ok: true, changed: false, distribution: cur };
  }
  // ⚠ 프로토타입 없는 사본에 쓴다 — 일반 객체에 '__proto__' 이름을 대입하면 프로토타입이 바뀌고 항목이 사라진다(이름은 외부 값).
  const perEdge = Object.assign(Object.create(null), cur.perEdge);
  if (on === true) perEdge[a] = { on: true, at: Date.now(), by: t(by).slice(0, 64), corps: ids };
  else delete perEdge[a];
  const next = writeDistribution(normalizeDistribution({ enabled: cur.enabled, excluded: cur.excluded, perEdge, updatedAt: Date.now(), updatedBy: by }));
  return { ok: true, changed: true, distribution: next };
}

/**
 * v2.927: 한 엣지에 '중앙에서 켜기' 로 내려줄 설정(순수). 중앙 로컬 설정의 배포 키 **전부** + 켜기 true + 법인 = 저장한 그 엣지 법인.
 * ⚠ 일부 키만 보내지 말 것 — 구버전 엣지(2.627~)가 빠진 키를 기본값으로 채워 엣지 설정을 조용히 바꾼다(위 머리말).
 */
export function perEdgeSettings(local, corpIds = []) {
  const s = pickDistributed(normalizeSettings(local || {}));
  const corps = {};
  for (const id of corpIds || []) { const k = t(id); if (k) corps[k] = true; }
  return { ...s, enabled: true, corps };
}

/**
 * 중앙이 한 엣지에 내려줄 값. 배포 원본은 **중앙의 로컬 설정**이다(중앙은 사본을 갖지 않는다).
 * v2.927: `mode` 를 더한다('all' | 'per-edge' | 'off' | 'excluded') — 구버전 엣지는 distribute·settings·sig·reason 만 읽으므로 무시한다.
 *   중앙 켜기 판의 법인은 **저장 목록**이다 — 인출 때 매핑을 다시 계산하지 않는다(매핑이 순간적으로 비어도 엣지를 끄지 않는다).
 * @param {string} agent
 * @param {{verified?:boolean}} [o] verified — **개별 토큰으로 인증된 이름**인가(공유 토큰의 ?agent= 는 남의 이름을 댈 수 있다 — 중앙 켜기 설정을 내주지 않는다).
 */
export function distributeFor(agent, { verified = false } = {}) {
  const d = loadDistribution();
  const a = lowerAgent(agent);
  const excluded = isExcluded(d, a);
  if (d.enabled && !excluded) {
    const settings = pickDistributed(loadLocalBmUsageSettings());
    return { distribute: true, mode: 'all', settings, sig: settingsSig(settings) };
  }
  const pe = perEdgeOf(d, a);
  if (pe && !excluded) {
    if (verified !== true) return { distribute: false, mode: 'per-edge', reason: 'per-edge-unverified' };
    const settings = perEdgeSettings(loadLocalBmUsageSettings(), pe.corps);
    return { distribute: true, mode: 'per-edge', settings, sig: settingsSig(settings) };
  }
  if (!d.enabled) return { distribute: false, mode: 'off', reason: 'off', ...(pe ? { conflict: true } : {}) };
  return { distribute: false, mode: 'excluded', reason: 'excluded', ...(pe ? { conflict: true } : {}) };
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
/**
 * 화면용 — 알려진 엣지 이름(대소문자 무시)과 인출 기록을 합친다.
 * v2.927: 행마다 **그 엣지에 실제로 보낼 판의 서명**과 엣지가 알린 판을 비교한다 — 전역 서명 하나와 비교하면 중앙 켜기(법인이 엣지마다
 *   다르다) 행은 영원히 '대기' 다. 행에 `mode`('all'|'per-edge'|'excluded'|'off') · 중앙 켜기 기록(저장 법인 `savedCorps`) · 지금 매핑(`corps`) ·
 *   둘이 다른가(`corpsChanged` — 화면이 '다시 확인' 을 받는다)를 싣는다.
 * @param {string[]} knownNames 등록부 이름
 * @param {{edgeCorps?:(agent:string)=>string[], tokenAgents?:Set<string>}} [o] edgeCorps — 지금 매핑(bmusage/edgeCorps.js) · tokenAgents — 개별 토큰이 발급된 이름(소문자)
 */
export function distributionStatus(knownNames = [], { edgeCorps = null, tokenAgents = null } = {}) {
  const d = loadDistribution();
  const local = loadLocalBmUsageSettings();
  const cur = settingsSig(local);
  const names = new Map();
  for (const n of knownNames || []) { const k = lowerAgent(n); if (k && !names.has(k)) names.set(k, t(n)); }
  // v2.927: 중앙 켜기가 저장된 이름은 등록부에서 빠졌어도 행으로 싣는다(켜 둔 지시가 화면에서 사라지지 않게 — 해제는 등록부와 무관하게 된다).
  for (const k of Object.keys(d.perEdge || {})) if (!names.has(k)) names.set(k, k);
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
  const corpsOf = typeof edgeCorps === 'function' ? edgeCorps : null;
  const rows = [...names].map(([k, name]) => {
    const p = _pulls.get(k) || null;
    const excluded = isExcluded(d, k);
    const pe = perEdgeOf(d, k);
    const now = corpsOf ? normalizeCorpIds(corpsOf(name)) : null;
    let mode; let sig = ''; let state = '';
    if (d.enabled && !excluded) { mode = 'all'; sig = cur; }
    else if (pe && !excluded) { mode = 'per-edge'; sig = settingsSig(perEdgeSettings(local, pe.corps)); }
    else mode = excluded ? 'excluded' : 'off';
    // v2.927: 배포를 끄거나 제외 · 중앙 켜기 해제 직후에는 엣지가 아직 사본을 쥐고 있다(다음 인출에 지운다) — '꺼짐' 이라 단정하지 않는다.
    if (mode === 'off' || mode === 'excluded') state = p?.deliveredSig ? 'releasing' : mode;
    else if (!p) state = 'no-pull';
    // v2.927: 중앙 켜기는 개별 토큰 인출에만 내준다 — 마지막 인출이 공유 토큰(이름 미검증)이면 받지 못했다.
    else if (mode === 'per-edge' && p.verified !== true) state = 'unverified';
    else if (p.appliedSig && p.appliedSig === sig) state = 'applied';
    // v2.628(R2628-05): 엣지는 받기 전 판을 알린다 — 마지막 응답이 지금 판을 보냈으면 '전달됨'(적용 확인은 다음 인출).
    else if (p.deliveredSig && p.deliveredSig === sig) state = 'delivered';
    else state = 'pending';
    return {
      agent: name, excluded, lastPullAt: p?.at || 0, appliedSig: p?.appliedSig || '', state, verified: p ? p.verified === true : null,
      lapsedVerifiedAt: p?.lapsedVerifiedAt || null, pullReason: p?.reason || '',
      mode, sig, corps: now,
      perEdge: !!pe, perEdgeAt: pe?.at || 0, perEdgeBy: pe?.by || '', savedCorps: pe ? pe.corps : null,
      // 지금 매핑이 저장 목록과 다르다(지금 매핑을 모르면 null) — 인출은 저장 목록 그대로 · 화면이 '다시 확인' 을 받는다.
      corpsChanged: pe && now ? !sameIds(pe.corps, now) : (pe ? null : false),
      perEdgeSuperseded: !!pe && mode === 'all', conflict: !!pe && excluded,
      tokenIssued: tokenAgents instanceof Set ? tokenAgents.has(k) : null,
    };
  }).sort((a, b) => a.agent.localeCompare(b.agent));
  // 중앙 켜기로 내려갈 값(법인 제외) — 화면 확인 문구가 '무엇이 중앙 값으로 바뀌는지' 를 이 값으로 말한다(숫자를 화면에 박지 않는다).
  const { corps: _c, ...perEdgeBase } = perEdgeSettings(local, []);
  return { ...d, sig: cur, keys: [...DISTRIBUTED_KEYS], rows, since: _startedAt, unknownUnverifiedOmitted, pullsOmitted: _pullsOmitted, perEdgeBase, perEdgeOmitted: d.perEdgeOmitted || 0, perEdgeMax: PER_EDGE_MAX };
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
  const prevLocal = normalizeSettings(readFile());
  // v2.919: 기준값은 **키 단위로** 겹친다(일부만 보내도 나머지는 직전 값 — 통째로 바꾸면 보내지 않은 기준이 기본값으로 되돌아간다).
  if (patch.perf && typeof patch.perf === 'object' && !Array.isArray(patch.perf)) patch.perf = { ...prevLocal.perf, ...patch.perf };
  else delete patch.perf;
  // v2.922: 저장 구조 설정도 키 단위로 겹친다(perf 와 같은 이유).
  if (patch.store && typeof patch.store === 'object' && !Array.isArray(patch.store)) patch.store = { ...prevLocal.store, ...patch.store };
  else delete patch.store;
  // v2.923: 진단 스냅샷 설정도 키 단위로 겹친다.
  if (patch.snapshot && typeof patch.snapshot === 'object' && !Array.isArray(patch.snapshot)) patch.snapshot = { ...prevLocal.snapshot, ...patch.snapshot };
  else delete patch.snapshot;
  const local = normalizeSettings({ ...prevLocal, ...patch });
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
