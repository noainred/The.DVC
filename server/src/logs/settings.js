/**
 * vCenter 로그 보관 설정 — CONFIG_DIR/vcenter-logs.json. 보관 기간(retentionDays)을 여기서 지정.
 */

import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { makeJsonFileReader } from '../util/jsonFileRead.js';   // 92회차 F3: 읽기 오류 ≠ 손상(결정 G2 공용 판정 — 손상만 preserveCorrupt)
import { numOrNull } from '../util/numOrNull.js';

const FILE = path.join(config.configDir, 'vcenter-logs.json');

const DEFAULTS = {
  enabled: true,
  pollIntervalMin: 10,     // 수집 주기(분)
  retentionDays: 365,      // 장기 보관 기간(일) — 0이면 무제한
  maxSizeMB: 1024,         // DB 용량 상한(MB) — 초과 시 오래된 것부터 삭제. 0이면 무제한
  maxPerPoll: 5000,        // 1회 폴링당 vCenter별 최대 수집 이벤트
  minSeverity: 'info',     // info|warning|error (그 이상만 저장)
  storagePath: '',         // 저장 디렉터리(빈값=CONFIG_DIR). 각 포탈(엣지/중앙)이 자기 데이터만 로컬 보관
};

/**
 * v2.603(감사 TIM2603-01 — 재현): 로드 경로에도 저장과 **같은 범위**를 적용한다. 예전에는 파일 값을 그대로 펼쳐서, 손으로
 * 고친 파일·복원한 백업의 `pollIntervalMin` 0·''·'abc'·음수·거대값이 `logs/poller.js schedule()` 의 setInterval 로 가
 * **1ms 루프**가 됐다(Node 는 0·NaN·음수·2^31 초과를 1ms 로 본다 — 재현: 0 → 0ms, 'abc' → NaN, -5 → -300000,
 * 40000 → 2400000000). v2.602 loginMonitor(TIM2602-04)와 같은 규칙: 숫자 아님·빈 값은 기본값, 범위 밖은 자른다.
 * 보존일·용량은 0 이 '무제한' 이라는 뜻이므로 0 은 그대로 두고, 음수는 0 이 아니라 **기본값**이다(오설정을 '무제한' 으로
 * 넓히지 않는다).
 */
function normalizeLoaded(p) {
  const num = (v, d, lo, hi, { zeroOk = false } = {}) => {
    const n = numOrNull(v);
    if (n == null || n < 0 || (n === 0 && !zeroOk)) return d;
    return Math.max(lo, Math.min(hi, n));
  };
  return {
    enabled: p.enabled != null ? !!p.enabled : DEFAULTS.enabled,
    pollIntervalMin: num(p.pollIntervalMin, DEFAULTS.pollIntervalMin, 1, 1440),
    retentionDays: num(p.retentionDays, DEFAULTS.retentionDays, 0, 3650, { zeroOk: true }),
    maxSizeMB: num(p.maxSizeMB, DEFAULTS.maxSizeMB, 0, 1024 * 1024, { zeroOk: true }),
    maxPerPoll: num(p.maxPerPoll, DEFAULTS.maxPerPoll, 100, 50000),
    minSeverity: ['info', 'warning', 'error'].includes(p.minSeverity) ? p.minSeverity : DEFAULTS.minSeverity,
    storagePath: typeof p.storagePath === 'string' ? p.storagePath.trim() : DEFAULTS.storagePath,
  };
}

/*
 * 92회차 F3(중간 — 재현): 예전 catch 하나는 **읽기 오류**(EACCES · EIO · EMFILE · EISDIR)도 손상으로 보고 온전한 vcenter-logs.json 을
 *   `.corrupt` 로 옮긴 뒤 기본값(보관 365일 · 용량 1,024MB · 저장 위치 CONFIG_DIR)을 **프로세스 수명 동안 캐시**했다 — 다음 정리 주기가
 *   관리자가 길게(최대 3,650일 · 큰 용량) 잡아 둔 로그를 기본값 기준으로 지웠고(복구 불가), 옮겨진 파일 때문에 재시작해도 기본값이었다.
 *   이제 손상만 옮기고, 읽기 오류면 원본을 두고 · 캐시하지 않고(30초마다 다시 읽음) · logSettingsUnknown() 이 참인 동안 폴러가 수집 · 정리를
 *   건너뛴다(저장 위치도 모른다 — 기본 위치에 새 DB 를 만들어 쓰지 않게) · 저장은 거절한다(logSettingsRefusal).
 */
const _reader = makeJsonFileReader(() => FILE, {
  tag: 'vclogs-settings',
  parse: (t) => { const p = JSON.parse(t); if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('객체가 아님'); return p; },   // 형식 불일치도 손상(예전 판정 그대로 — null 포함)
});
let cache = null;
let _readError = false;
export function loadLogSettings() {
  if (cache) return cache;
  const r = _reader.read();
  if (r.kind === 'read-error') { _readError = true; return { ...DEFAULTS }; }   // 캐시하지 않는다 — 기본값은 '모름' 의 자리 표시일 뿐
  _readError = false;
  cache = r.kind === 'ok' ? normalizeLoaded(r.value) : { ...DEFAULTS };   // 파일 없음 · 손상(보존본으로 옮김)은 예전처럼 기본값
  return cache;
}
/** 92회차 F3: 설정 파일을 읽지 못했다(읽기 오류) — 보관 기간 · 용량 · 저장 위치를 모른다. 폴러는 이 동안 수집 · 정리를 건너뛴다. */
export function logSettingsUnknown() { loadLogSettings(); return _readError && !cache; }
/** 92회차 F3: 읽기 오류 중의 저장 거절 사유 또는 null. */
export function logSettingsRefusal() {
  if (!logSettingsUnknown()) return null;
  return { ok: false, code: 'settings-unreadable', readError: true, reason: `vCenter 로그 보관 설정 파일(${path.basename(FILE)})을 읽지 못해 저장하지 않았습니다 — 읽기 오류이고 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽고, 읽히면 저장이 다시 열립니다).` };
}

export function saveLogSettings(body = {}) {
  // 92회차 F3: 읽기 오류 중에는 기본값 위에 쓰지 않는다(원본은 디스크에 그대로). 던지지 않고 거절 본문을 돌려준다 — 호출 라우트(PUT /admin/vclogs/settings)가
  //   async 라 던지면 응답이 나가지 않는다. 화면은 requireChanged 로 ok:false 의 사유를 그대로 보인다(_pathChanged 가 없어 DB 를 다시 열지 않는다).
  const refused = logSettingsRefusal();
  if (refused) return { ...refused };
  const cur = loadLogSettings();
  const next = {
    enabled: body.enabled != null ? !!body.enabled : cur.enabled,
    pollIntervalMin: Math.max(1, Math.min(1440, Number(body.pollIntervalMin) || cur.pollIntervalMin)),
    // Number(undefined)=NaN이고 NaN ?? x = NaN(??는 null/undefined만 잡음) → 부분 수정(예:
    // enabled만 토글) 시 보관기간/용량이 NaN→null로 영속화돼 prune·용량제한이 조용히 영구
    // 정지, DB 무한 증식. 유한 숫자일 때만 채택하고 아니면 기존값 유지.
    // v2.586 — 빈 칸('')·null 도 '미지정' 이다. `Number('') === 0` 이고 0 은 **무제한**이라, 칸을 비우고
    //   저장하면 prune·용량 상한이 화면의 '저장됨' 과 함께 조용히 멈췄다. 명시적 0 만 무제한이다.
    retentionDays: Math.max(0, Math.min(3650, numOrNull(body.retentionDays) ?? cur.retentionDays)),
    maxSizeMB: Math.max(0, Math.min(1024 * 1024, numOrNull(body.maxSizeMB) ?? cur.maxSizeMB)),
    maxPerPoll: Math.max(100, Math.min(50000, Number(body.maxPerPoll) || cur.maxPerPoll)),
    minSeverity: ['info', 'warning', 'error'].includes(body.minSeverity) ? body.minSeverity : cur.minSeverity,
    storagePath: typeof body.storagePath === 'string' ? body.storagePath.trim() : cur.storagePath,
  };
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  const pathChanged = next.storagePath !== cur.storagePath;
  cache = next;
  return { ...next, _pathChanged: pathChanged };
}

/** 테스트 전용 — 로드 캐시를 비워 다음 load 가 파일을 다시 읽게 한다. */
export function _resetLogSettingsForTest() { cache = null; _readError = false; _reader.reset(); }
