/**
 * guestdisk/settings.js — 게스트 디스크 회수 리포트 설정 (`guest-disk.json`, v2.459).
 *
 * 비밀 값이 없는 설정이라 봉인 대상은 아니지만, 손상 시 조용히 빈 값으로 넘기면 다음 저장이
 * 관리자 설정을 지우므로 다른 스토어와 같이 원자적 쓰기 + preserveCorrupt 를 지킨다.
 *
 * 기본은 **꺼짐(opt-in)** 이다 — 5,850 VM 규모에서 게스트 디스크 벌크 조회는 부하가 있으므로,
 * 업그레이드만으로 주기 수집이 켜지면 안 된다. 관리자가 설정에서 켜야 폴러가 돈다.
 */
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, safeLoadText } from '../util/atomicWrite.js';
import { makeJsonFileReader } from '../util/jsonFileRead.js';   // 97회차 F14: 읽기 오류 ≠ 손상
import { corruptOnlyReason } from '../util/registryCore.js';   // 100회차(97 ③ 결정): 본 파일 없음 + 손상 보존본만 = 아직 못 읽은 설정
import { numOrNull } from '../util/numOrNull.js';
import { parseJsonObject } from '../util/jsonObject.js'; // v3.17.2: 객체가 아닌 JSON(수 · 글자 · 배열)은 깨진 JSON 과 같이 — 손상 보존 경로로

const FILE = path.join(config.configDir, 'guest-disk.json');

/** 보관 일수 상한(저장 판정과 같은 값). 97회차 F14 후속: 설정을 못 읽는 동안의 이력 정리는 이 상한으로 한다(멈춤에도 상한 — 83 R1). */
export const RETENTION_MAX_DAYS = 3650;
export const DEFAULTS = Object.freeze({
  enabled: false,          // 주기 수집(폴러) 켜기 — 기본 꺼짐(opt-in)
  intervalHours: 12,       // 수집 주기(시간). 게스트 파티션은 천천히 변하므로 자주 볼 필요가 없다.
  changeThresholdGB: 1,    // 파티션 used 가 이만큼 바뀔 때만 추이 행을 남긴다(diff-저장).
  retentionDays: 180,      // part_series/vm_series 보존 기간(prune).
  minReclaimGB: 0,         // 기본 0 = 전체 표시(회수 여유가 작아도 보이게). 필요 시 올려서 좁힌다.
});

// v2.596(감사 CLAMP2596-03 — 재현): 빈 칸('')이 Number('')=0 → 하한 1시간이 되어 12시간 주기가 1시간이 됐다(게스트 수집 12배).
const clampNum = (v, lo, hi, dflt) => {
  const n = numOrNull(v) ?? NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

let cache = null;

/*
 * 97회차 F14(재현 — EISDIR): 예전 catch 하나는 **읽기 오류**(EACCES · EIO · EISDIR)도 손상으로 보고 온전한 원본을 `.corrupt.*` 로 옮긴 뒤 기본값을 캐시했다 —
 *   보관 일수가 기본값(180일)이 되어 다음 정리(prune)가 사용자가 늘려 둔 기간의 이력을 지웠고(되돌릴 수 없다), 다음 저장이 기본값 위에 썼다.
 *   판정은 공용 읽기(util/jsonFileRead.js): 읽기 오류는 원본을 두고 · 캐시하지 않고(30초 간격 재읽기) · 저장을 거절하고(409) · 정리는 저장 상한(RETENTION_MAX_DAYS)으로만 한다.
 *   손상은 예전처럼 보존본으로 옮기고 기본값으로 돌되, 표지를 세워 정리를 저장 상한으로만 한다(진짜 보관 일수는 보존본에 있다 — 추측으로 지우지 않는다).
 *   100회차: 재시작 뒤(본 파일 없음 + 손상 보존본만)에도 같은 표지 — 관리자가 다시 저장하면 풀린다.
 */
const _reader = makeJsonFileReader(() => FILE, { parse: parseJsonObject, tag: 'guestdisk' });
let _loadError = null;   // { at, reason, readError? }
export function load() {
  if (cache) return cache;
  const out = structuredClone(DEFAULTS);
  const r = _reader.read();
  if (r.kind === 'read-error') {
    _loadError = { at: _loadError?.readError ? _loadError.at : Date.now(), readError: true, reason: `게스트 디스크 설정(guest-disk.json) 파일을 읽지 못했습니다(읽기 오류 ${String(r.error?.code || '').slice(0, 32)}) — 원본은 그대로 둡니다 · 저장을 멈추고 이력 정리는 최대 보관 일수(${RETENTION_MAX_DAYS}일)로만 합니다(30초마다 다시 읽음)` };
    return out;   // 캐시하지 않는다
  }
  if (r.kind === 'corrupt') {
    _loadError = { at: Date.now(), reason: `게스트 디스크 설정(guest-disk.json) 파일이 손상돼 보존본으로 옮겼습니다 — 기본값으로 돌고 이력 정리는 최대 보관 일수(${RETENTION_MAX_DAYS}일)로만 합니다(저장하면 풀림)` };
    console.warn(`[guestdisk] 설정 로드 실패 — 원본을 .corrupt 로 보존하고 기본값으로 시작합니다(이력 정리는 저장 전까지 최대 보관 일수 ${RETENTION_MAX_DAYS}일로만): ${safeLoadText(r.error) || '사유 미상'}`);
  } else if (r.kind === 'missing' && corruptOnlyReason(FILE)) {
    // 100회차(97회차 남긴 것 ③ — 결정 · 재현): 손상으로 보존본만 남긴 뒤 재시작하면 '파일 없음' 이라 표지가 사라져 기본 보관 일수(180일)로 이력을 지웠다
    //   (늘려 둔 보관 일수는 보존본에만 있다). 본 파일이 없고 그 보존본이 남아 있으면 관리자가 다시 저장할 때까지 같은 표지를 세운다(저장은 허용 —
    //   readError 아님 · 저장하면 본 파일이 생겨 풀린다. 보존본을 치워도 풀린다 — veeam/backupMarks marksCorruptKept 와 같은 판정).
    _loadError = { at: _loadError?.corruptKept ? _loadError.at : Date.now(), corruptKept: true, reason: `게스트 디스크 설정(guest-disk.json) 파일이 없고 손상 보존본만 남아 있습니다 — 기본값으로 돌고 이력 정리는 최대 보관 일수(${RETENTION_MAX_DAYS}일)로만 합니다(설정을 다시 저장하면 풀림)` };
  } else _loadError = null;
  if (r.kind === 'ok') {
    const p = r.value;
    if (typeof p.enabled === 'boolean') out.enabled = p.enabled;
    if (p.intervalHours != null) out.intervalHours = clampNum(p.intervalHours, 1, 168, DEFAULTS.intervalHours);
    if (p.changeThresholdGB != null) out.changeThresholdGB = clampNum(p.changeThresholdGB, 0.1, 100, DEFAULTS.changeThresholdGB);
    if (p.retentionDays != null) out.retentionDays = clampNum(p.retentionDays, 7, RETENTION_MAX_DAYS, DEFAULTS.retentionDays);
    if (p.minReclaimGB != null) out.minReclaimGB = clampNum(p.minReclaimGB, 0, 10000, DEFAULTS.minReclaimGB);
  }
  cache = out;
  return cache;
}
/** 97회차 F14 · 100회차: 설정을 못 읽었으면(읽기 오류 · 이 프로세스에서 본 손상 · 본 파일 없이 손상 보존본만) `{ at, reason, readError?, corruptKept? }`, 아니면 null — 이력 정리(prune)는 이 값이 있으면 저장 상한(RETENTION_MAX_DAYS)으로만 한다(메인 검토 — 건너뛰면 무한 증식). */
export function settingsLoadError() { load(); return _loadError; }

export function save(body = {}) {
  if (settingsLoadError()?.readError) throw Object.assign(new Error(`게스트 디스크 설정(guest-disk.json) 파일을 읽지 못한 상태라 저장하지 않았습니다 — 읽기 오류이고 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽습니다).`), { status: 409, code: 'settings-unreadable' });   // 97회차 F14
  const next = structuredClone(load());
  if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
  if (body.intervalHours != null) next.intervalHours = clampNum(body.intervalHours, 1, 168, next.intervalHours);
  if (body.changeThresholdGB != null) next.changeThresholdGB = clampNum(body.changeThresholdGB, 0.1, 100, next.changeThresholdGB);
  if (body.retentionDays != null) next.retentionDays = clampNum(body.retentionDays, 7, RETENTION_MAX_DAYS, next.retentionDays);
  if (body.minReclaimGB != null) next.minReclaimGB = clampNum(body.minReclaimGB, 0, 10000, next.minReclaimGB);
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next; _loadError = null; _reader.reset();
  return next;
}

export function invalidate() { cache = null; _loadError = null; _reader.reset(); }
export const _FILE = FILE;
