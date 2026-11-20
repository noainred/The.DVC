/**
 * 예약 복원(v2.768 점검 R3-C5-02) — 백업 복원의 JSON 설정 파일을 **다음 기동 때, 다른 모듈이 파일을 읽기 전에** 적용한다.
 *
 * 왜 필요한가(재현): 예전 복원은 CONFIG_DIR 의 파일만 덮고 '재시작 필요' 라고 안내했다. 그런데 파일을 인메모리로 들고 있는 모듈
 *   (central/agentTokens.js 의 touch — 엣지 인증마다 60초 스로틀 저장, bulletin/store.js 의 공감·댓글 저장, auth 의 OTP 카운터 저장 등)
 *   이 재시작 전에 한 번만 저장해도 **메모리의 복원 전 판본으로 파일을 되돌렸다**(토큰 edge-b 복원 → edge-a 의 다음 pull → 파일에서 edge-b
 *   재소실 · 재시작해도 없음). 엣지 28곳이면 touch 저장이 약 2초마다라 '복원 → 수동 재시작' 사이에 거의 확실히 덮인다. 자동 재시작만으로도
 *   부족하다 — graceful 종료 중에도 저장(종료 flush)이 돈다.
 *
 * 그래서: 복원은 JSON 파일을 `CONFIG_DIR/backups/.restore-staged.json` 한 파일에 원자적으로 **예약**만 하고, 기동 시 index.js 의
 *   두 번째 import(`./backup/stagedRestoreBoot.js` — 첫 번째는 logbuffer.js)가 그 파일을 적용한다. ESM 은 import 를 적힌 순서대로
 *   깊이 우선으로 평가하므로 그 뒤에 오는 어떤 모듈의 로드보다 먼저다(회귀 테스트가 실제 자식 프로세스로 확인한다).
 *   ⚠ 이 모듈은 `node:` 내장과 `util/atomicWrite.js`(무의존 leaf)만 import 한다 — config.js 를 import 하면 config.js 가 먼저 평가돼
 *     db-location.json 등을 복원 전 판본으로 읽는다. CONFIG_DIR 판정은 config.js 와 같은 식을 쓰고 테스트가 둘을 대조한다.
 *   `.env` 는 예약하지 않는다 — systemd EnvironmentFile 이 프로세스보다 먼저 읽으므로 기동 중 적용하면 한 번 더 재시작해야 반영된다.
 *   .env 는 인메모리 판본으로 다시 쓰는 모듈이 없다(central/token.js 는 매번 파일을 읽어 고친다) — 복원 때 바로 쓴다(service.js).
 *
 * 적용 규칙
 *   - 파일 이름은 다시 검사한다(예약 파일도 디스크의 입력이다): basename 과 같고 `..`·경로 구분자 없음·`.json` 만·제외 목록 밖.
 *   - 적용 전에 예약 파일을 `.restore-applying.json` 으로 옮겨(claim) **한 번만** 적용한다 — 지우기에 실패해 매 기동마다 다시 적용돼
 *     그 사이의 설정 변경을 영원히 되돌리는 일이 없게. 적용 도중 죽어 claim 파일이 남으면 다시 적용하지 않고 상태에 '중단됨' 으로 알린다.
 *   - 결과는 콘솔(로그 화면)과 `backups/.restore-last.json` 에 남긴다(화면이 '적용됨 · 실패 N개' 를 보여 준다).
 *   - v2.769(점검 R4-D1-2): 폐기 상태를 담은 두 파일은 백업 판본을 그대로 쓰지 않고 **현재 파일과 맞춰** 쓴다(reconcileForApply).
 *     users.json 은 계정별 tokenVersion = max(현재, 백업)+1(백업 이후 폐기한 세션 부활 방지 — 전원 재로그인),
 *     central-agent-tokens.json 은 현재 파일 우선 병합(백업에만 있는 항목은 되살리되 개수를 경고). 제외 목록에 넣지 않는 이유:
 *     새 서버 재해 복구에서 전 엣지 토큰·계정이 유실된다.
 *   - 114회차(복원 대상 전수): 파일마다 복원 동작이 정해져 있다 — 합침(reconcileForApply) · 제외(RESTORE_EXCLUDE) · 지금 파일이 있으면 그대로
 *     (RESTORE_KEEP_CURRENT — 보낸 회차 · 실행 원장 · 커서) · 그대로. 분류표는 `test/restoreSweep114.test.js` 에 있고, 새 `*.json` 이름이 표에 없으면 그 시험이 실패한다.
 *     어느 경우든 **지금 파일이 없으면(새 서버 재해 복구) 백업 그대로**다(제외만 빼고).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { KEY_FILE_NAME, mergeRedactedKeyStore } from '../bmusage/onboard/keyBundle.js';   // v3.9.0 반증 D5: 적용 시점 다시 합치기
// 114회차: 판정 코어는 하나 — 두 모듈 다 무의존 leaf 다(signing.js 는 node:crypto 만 · groupRetention.js 는 names.js 만 — config.js 를 싣지 않는다 · 시험이 고정).
import { scheduleSignRequired } from '../rma/signing.js';           // 서명이 필요한(셸을 주기 실행하는) 점검인가
import { keepOtpReasons } from '../bareos/groupRetention.js';      // 보관 개수 저장이 본인 OTP 를 받는 저장인가(지워질 범위가 넓어지는가)

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** config.js 의 configDir 과 같은 식(테스트가 대조한다) — config.js 를 import 하지 않으려고 따로 둔다. */
export function resolveConfigDir() { return process.env.CONFIG_DIR || path.resolve(SERVER_ROOT, 'config'); }

export const STAGED_NAME = '.restore-staged.json';
export const APPLYING_NAME = '.restore-applying.json';
export const LAST_NAME = '.restore-last.json';
/** 수집 데이터(설정 아님) — 백업에서 빼고 복원하지 않는다. backup/service.js 의 DENY_NAMES 가 이 집합을 쓴다(한 벌). */
export const DATA_FILE_NAMES = new Set(['central-inventory.json', 'central-agent-config.json', 'ipam-scan-history.json', 'ipam-scan-results.json']);
/**
 * 복원하지 않는 파일 — 되돌리면 보안이 후퇴한다.
 *   session-state.json: 로그아웃한 세션 폐기 목록·notBefore(auth/sessionState.js). 백업 시점 판본으로 되돌리면 그 뒤에 폐기한 토큰이
 *   만료 전까지 다시 통과한다.
 */
export const RESTORE_EXCLUDE = new Map([
  ['session-state.json', '세션 폐기 목록 — 되돌리면 백업 이후 로그아웃한 세션이 되살아난다'],
  // v2.809(반증 M-2): 서명 확인 시한부 끄기 — 되돌리면 소유자가 다시 켠 뒤에도 OTP 재인증 없이 '꺼짐' 이 되살아난다
  ['upgrade-signature-override.json', '업그레이드 서명 확인 끄기 — 되돌리면 다시 켠 서명 확인이 OTP 재인증 없이 꺼진다'],
  // Bareos 재해 복구 2차: 복구 순서 실행 상태 — 진행 중에 만든 백업을 되살리면 멈췄거나 끝난 회차가 '진행 중' 으로 돌아와 OTP 없이 남은 VM 을 다시 보낸다
  ['bareos-dr-runs.json', 'Bareos 재해 복구 실행 상태 — 되돌리면 멈췄거나 끝난 회차가 되살아나 OTP 없이 복원을 다시 보낸다'],
  // v3.9.0 SSH 공용 접속: 법인 키 사용 중지(긴급 조치) — 백업 시점 판본으로 되돌리면 그 뒤에 건 사용 중지가 OTP 없이 풀린다
  ['ssh-access-state.json', 'SSH 키 사용 중지(긴급 조치) · 계층 지정 · 공통 계정 정지 기록 — 되돌리면 백업 이후에 건 사용 중지 · 계정 정지가 풀리고, 계층 지정(저장 비밀을 서버에 묶는 값)이 OTP 없이 되살아난다'],
  // 98회차(긴급중단 손상 결정의 형제 — 재현): 긴급중단은 관리자 2명 OTP 로만 켜고 끈다. 복원은 소유자 한 사람 · OTP 없음이라 백업 시점 판본(꺼짐)이
  //   2인 승인으로 켠 긴급중단을 재시작 뒤 풀었다(켜짐 판본은 지금 꺼진 수집을 멈춘다). 상태는 지금 파일 그대로 둔다.
  ['emergency-stop.json', '긴급중단 상태 — 2인 승인(관리자 2명 OTP)으로만 켜고 끈다. 되돌리면 백업 시점 판본이 그 결정을 뒤집는다'],
  // 98회차: 세션 보안 신뢰 사본은 복원하지 않는다 — 복원한 security-session.json(약화 금지로 맞춘 값)을 기동 때 정상으로 읽으면 사본이 그 값으로 다시 맞춰진다.
  //   백업 판본(옛 · 약한 값)을 그대로 쓰면 본 파일을 못 읽는 기동에서 그 옛 값으로 돌았다.
  ['security-session.trusted.json', '세션 보안 설정의 신뢰 사본 — 복원한 본 파일을 정상으로 읽을 때 다시 맞춰진다(옛 판본으로 되돌리지 않는다)'],
  // 114회차(재현): 실행 중 스캔 기록 — 백업은 스캔이 도는 중에도 만들어진다(정기 · 변경 감시 · 복원 전). 그 판본을 되살리면 이미 끝난 스캔이
  //   '재시작으로 중단됨' 이 되어 기동 2분 뒤 다시 돌고(iDRAC 대역 · IP 스캔 · 아이실론 du — 시작 48시간 안), 이번 재시작이 실제로 끊은 스캔의 기록은 사라졌다.
  ['scan-journal.json', '실행 중 스캔 기록 — 되돌리면 이미 끝난 스캔을 재시작으로 끊긴 것으로 보고 다시 돌린다'],
]);
/**
 * 114회차(복원 대상 전수 — 재현): **지금 파일이 있으면 복원하지 않는** 실행 기록 — 폴러 · 예약 틱이 스스로 쓰는 '이미 한 일' 의 원장(보낸 회차 · 알린 사건 ·
 *   읽은 위치 · 실행 기록)이다. 백업 판본(더 옛 기록)으로 덮으면 이미 보낸 메일 · 이미 돈 회차 · 이미 알린 사건을 다시 하고(재현: Bareos 복원 검증이 같은 날 다시 돈다 ·
 *   VM 구성 점검 메일이 같은 날 다시 나간다), 백업 뒤에 생긴 기록(진행 중인 실행 추적 포함)은 사라졌다. 이 파일들은 사람이 되돌리려는 설정이 아니다.
 *   지금 파일이 **없을 때만**(ENOENT — 새 서버 재해 복구) 백업 판본을 쓴다. 있으면 읽히든 아니든 그대로 둔다(손상 · 읽기 오류의 처리는 그 모듈 로더가 한다 —
 *   로더가 '오늘은 멈춘다' 로 닫아 둔 손상본을 옛 기록으로 덮지 않는다).
 *   ⚠ **함께 복원되는 설정 파일과 같은 시점이어야 맞는 상태**는 넣지 않는다(백업 판본끼리가 한 벌이다 — svcmon-trial.json(시험 점검 대기 ↔ svcmon.json) ·
 *     ipam-vcrange-migration.json(1회 이전 기록 ↔ 스캔 대역) · bm-onboard-applied.json(엣지 적용 원장 ↔ 등록부) · central-svcmon-assign.json).
 *     여기 넣는 것은 시각 · 바깥 세계(보낸 메일 · Director · 복원되지 않는 DB · 이 호스트)에 묶인 기록뿐이다.
 *   ⚠ 새 상태 파일을 만들면 여기(또는 RESTORE_EXCLUDE · reconcileForApply)에 넣을지 정한다 — `test/restoreSweep114.test.js` 분류표가 빠진 이름을 잡는다.
 *   ⚠ 120회차 정직 기록(실측 — 빈 설정 디렉터리 · DATA_SOURCE=live 로 19분 기동): **'새 서버 = 지금 파일 없음' 이 아니다.** 새 설치는 기동 11분 안에(넷은 4분 안에) 이 표의
 *     bareos-mail-state · vm-backup-mail-state · focusmon-alert-state · storage-inspect-state · veeam-license-alert-state 다섯을 스스로 만든다(빈 원장 · since = 설치 시각).
 *     복원은 사람이 로그인한 뒤에야 하므로 재해 복구에서 그 다섯은 백업 원장이 아니라 **새 설치의 빈 원장**으로 남는다 — 발송 이력 표시가 비고 진행 중이던 알림은
 *     한 번 다시 나갈 수 있다(since 기반 메일 원장은 새 since 가 오히려 지난 실패를 쏟지 않는다). 백업 원장이 필요하면 그 파일을 치운 뒤 다시 복원한다.
 */
const KEEP_LEDGER = '보낸 회차 · 알린 사건 기록 — 되돌리면 이미 보낸 알림을 다시 보낸다';
const KEEP_RUN = '실행 회차 · 실행 기록 — 되돌리면 이미 돈 작업을 다시 돌리거나 진행 중인 실행의 추적을 잃는다';
const KEEP_CURSOR = '읽은 위치 · 기준선 — 되돌리면 이미 처리한 구간을 다시 처리한다';
export const RESTORE_KEEP_CURRENT = new Map([
  // 메일 · 알림 발송 기록
  ...['alerts-state.json', 'backup-stale-alert-state.json', 'bareos-digest-state.json', 'bareos-health-state.json', 'bareos-mail-state.json',
    'bm-perf-alert-state.json', 'bmusage-alert-state.json', 'focusmon-alert-state.json', 'guestpart-mail-state.json', 'ipam-report-state.json',
    'isidu-digest-state.json', 'isidu-mail-state.json', 'issue-filter-mail-state.json', 'issue-notify-state.json', 'san-storage-notify-state.json',
    'san-storage-report-state.json', 'storage-usage-mail-state.json', 'veeam-license-alert-state.json', 'vm-backup-mail-state.json', 'vm-hygiene-state.json',
  ].map((n) => [n, KEEP_LEDGER]),
  // 예약 실행 회차 · 실행 기록(작업 원장)
  ...['bareos-rehearsal-state.json', 'storage-inspect-state.json', 'xfer-speed-schedule-state.json', 'ipscan-agent-state.json',
    'bareos-install-jobs.json', 'provision-runs.json', 'veeam-backup-runs.json', 'storage-inspect-runs.json', 'ipam-scan-runs.json', 'focusmon-audit.json',
    'upgrade-status.json', 'upgrade-kept-bundles.json', 'upgrade-signature-log.json', 'edge-token-apply-log.json',
  ].map((n) => [n, KEEP_RUN]),
  // 수집 커서 · 증분 기준선
  ...['diskbad-cursors.json', 'vcenter-logs-cursor.json', 'cvp-push.json', 'isidu-push.json', 'sanswitch-perf-push.json', 'net-issues-state.json', 'ipam-change-baseline.json',
  ].map((n) => [n, KEEP_CURSOR]),
]);
/** 114회차: 인증 실패 정지 기록(util/authGuard.js createAuthGuard 의 파일 — 도구마다 `<도구>-auth-stops.json`). reconcileAuthStopsText 가 합친다. */
export const AUTH_STOPS_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}-auth-stops\.json$/;
/**
 * 114회차(재현): 설정과 실행 결과가 한 파일에 섞인 스토어(backup/service.js MIXED_STATE_FILES) 가운데 **마지막 실행 시각으로 다음 실행을 정하는** 것 —
 *   백업 판본의 옛 `last*` 를 그대로 쓰면 재시작 직후 '아직 안 돌았다' 로 보고 다시 돌린다(게스트 조사 = 도메인 계정으로 게스트 재로그인 · OS 스캔 = 전 VM 재스캔 ·
 *   일일 보고 = 같은 날 다시 발송 · 연속 캡처 · iDRAC 대역). 정의(설정)는 백업 것, 실행 필드(`last*` · useCount — service.js RUN_FIELD_RE 와 같은 규칙)는 지금 것.
 */
export const RESTORE_RUN_FIELDS_CURRENT = new Set(['capture-monitors.json', 'os-scan.json', 'guest-scans.json', 'daily-report.json', 'idrac-scan-ranges.json']);
/** 예약 파일 읽기 상한 — 번들 해제 상한(64MB)의 JSON 이스케이프 팽창까지 감안한 여유. 넘으면 적용하지 않는다. */
export const STAGED_MAX_BYTES = 512 * 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/;

/** 예약·적용 대상 이름 판정(순수) — 문제가 있으면 사유 문자열, 없으면 null. */
export function stagedNameIssue(name) {
  if (typeof name !== 'string' || !name) return '이름 없음';
  if (path.basename(name) !== name || name.includes('/') || name.includes('\\') || name.includes('..')) return '경로 포함';
  if (!NAME_RE.test(name)) return '허용되지 않는 문자';
  if (path.extname(name).toLowerCase() !== '.json') return '.json 아님';
  if (DATA_FILE_NAMES.has(name)) return '수집 데이터';
  if (RESTORE_EXCLUDE.has(name)) return '복원 제외';
  return null;
}

/*
 * v2.769(점검 R4-D1-2): 적용 시점 병합(순수 — 텍스트 → 텍스트). v2.768 이 복원을 실제로 적용되게 만들면서 노출된 폐기 상태 부활을 막는다.
 *   현재 파일을 못 읽으면(없음·손상) 백업이 유일한 원천이다 — users 는 그래도 +1(백업 시점 토큰 무효), 토큰은 백업 전부(개수 경고).
 *   백업 판본이 기대한 모양이 아니면 손대지 않는다(예전과 같은 동작 — 그 파일의 로드 손상 보존 규칙이 처리한다).
 */
const parseJson = (t) => { try { return JSON.parse(String(t)); } catch { return null; } };
const tvOf = (u) => { const n = Number(u?.tokenVersion); return Number.isSafeInteger(n) && n > 0 ? n : 0; };

/** users.json — 계정별 tokenVersion = max(현재, 백업)+1. @returns {{ text:string, bumped:number }} */
export function reconcileUsersText(backupText, currentText) {
  const b = parseJson(backupText);
  if (!b || !Array.isArray(b.users)) return { text: String(backupText), bumped: 0 };
  const cur = parseJson(currentText);
  const curTv = new Map();
  for (const u of Array.isArray(cur?.users) ? cur.users : []) if (u && typeof u.username === 'string') curTv.set(u.username, tvOf(u));
  let bumped = 0;
  const users = b.users.map((u) => {
    if (!u || typeof u !== 'object' || typeof u.username !== 'string') return u;
    bumped += 1;
    return { ...u, tokenVersion: Math.max(tvOf(u), curTv.get(u.username) || 0) + 1 };
  });
  return { text: JSON.stringify({ ...b, users }, null, 2), bumped };
}

const agentKey = (a) => String(a ?? '').trim().toLowerCase();
/** central-agent-tokens.json — 현재 파일 우선 병합. @returns {{ text:string, revived:string[], currentUnreadable:boolean }} */
export function reconcileAgentTokensText(backupText, currentText) {
  const b = parseJson(backupText);
  if (!b || !Array.isArray(b.tokens)) return { text: String(backupText), revived: [], currentUnreadable: false };
  const cur = parseJson(currentText);
  const curList = Array.isArray(cur?.tokens) ? cur.tokens.filter((t) => t && typeof t === 'object' && t.agent && t.hash) : null;
  const have = new Set((curList || []).map((t) => agentKey(t.agent)));
  const tokens = [...(curList || [])];
  const revived = [];
  for (const t of b.tokens) {
    if (!t || typeof t !== 'object' || !t.agent || !t.hash) continue;
    const k = agentKey(t.agent);
    if (have.has(k)) continue; // 같은 엣지는 현재 항목(재발급한 새 토큰)이 이긴다
    have.add(k); tokens.push(t); revived.push(String(t.agent).slice(0, 64));
  }
  return { text: JSON.stringify({ ...b, tokens }, null, 2), revived, currentUnreadable: curList === null };
}

/**
 * bareos-groups.json — 그룹 정의는 백업 것, **회차 기록은 더 늦은 쪽**(v2.830 버그 점검 S7 — 백업은 정의가 바뀔 때 만들어져 lastKey 가 며칠 묵는다.
 * 그대로 되돌리면 복원 뒤 6시간 안에 기동할 때 이미 돈 회차를 다시 보냈다 — 한 번 이하 위반). 회차 열쇠는 'YYYY-MM-DD HH:MM' 이라 글자 비교 = 시각 비교.
 * 복원본의 보내는 중 표지(sending)는 비운다(그때 보내던 실행은 지금 것이 아니다 — 거짓 '재시작' 경고).
 * @returns {{ text:string, kept:number }}
 */
/*
 * 114회차 F1(재현 — 데이터 삭제): 그룹 정의를 백업 것으로 쓰면서 **보관 개수(keep)** 도 그대로 되돌렸다. 보관 개수를 정하거나 줄이는 저장은 본인 OTP 다
 *   (routes/api/bareosGroups.js keepOtpGate — '지운 회차는 복원할 수 없다'). 복원은 OTP 를 묻지 않으므로 백업(최근 3회) → 지금(최근 30회 · 제한 없음)인 그룹이
 *   복원 뒤 최근 3회가 되어 다음 그룹 실행 뒤 정리가 그보다 오래된 백업을 카탈로그에서 지웠다. 지금 원장이 있으면 **지워질 범위가 넓어지지 않게** 맞춘다:
 *   판정은 저장 라우트와 같은 keepOtpReasons(prev = 지금 그룹) — OTP 를 받았을 저장이면 지금 값(지금 그룹이 없거나 제한 없음이면 제한 없음)으로 두고,
 *   그래도 OTP 사유가 남으면(기록이 있을 수 있는 VM 을 더함 — 잡 유무는 기동 때 알 수 없어 있다고 본다) 제한 없음으로 둔다. 줄이려면 화면에서 본인 OTP 로.
 *   지금 원장이 없거나 읽히지 않으면(새 서버 재해 복구) 백업 그대로다(읽기 오류는 reconcileForApply 가 던진다).
 */
const keepNum = (v) => (Number.isInteger(v) && v > 0 ? v : null);
function keepForRestore(g, prev) {
  const want = keepNum(g.keep);
  if (want == null) return null;
  const vmIds = Array.isArray(g.vmIds) ? g.vmIds : [];
  const prevN = prev ? { ...prev, keep: keepNum(prev.keep) } : null;
  if (!keepOtpReasons(prevN, { keep: want, vmIds }).length) return want;
  const now = prevN ? prevN.keep : null;                       // 지금 그룹이 없거나 제한 없음 → 제한 없음
  const safe = now == null ? null : Math.max(want, now);       // 줄이지 않는다
  return safe != null && !keepOtpReasons(prevN, { keep: safe, vmIds }).length ? safe : null;
}
export function reconcileBareosGroupsText(backupText, currentText) {
  const b = parseJson(backupText);
  if (!b || !Array.isArray(b.groups)) return { text: String(backupText), kept: 0, keepHeld: [] };
  const cur = parseJson(currentText);
  const curList = Array.isArray(cur?.groups) ? cur.groups.filter((g) => g && typeof g === 'object' && typeof g.id === 'string') : null;
  const curKey = new Map((curList || []).map((g) => [g.id, typeof g.lastKey === 'string' ? g.lastKey : '']));
  const curById = curList ? new Map(curList.map((g) => [g.id, g])) : null;
  let kept = 0; const keepHeld = [];
  const groups = b.groups.map((g) => {
    if (!g || typeof g !== 'object') return g;
    const mine = typeof g.lastKey === 'string' ? g.lastKey : '';
    const now = curKey.get(g.id) || '';
    const next = { ...g, sending: null };
    if (now > mine) { next.lastKey = now; kept += 1; }
    if (curById) {   // 114회차 F1
      const k = keepForRestore(g, curById.get(g.id) || null);
      if (k !== keepNum(g.keep)) { next.keep = k; keepHeld.push(String(g.name || g.id || '').slice(0, 60)); }
    }
    return next;
  });
  return { text: JSON.stringify({ ...b, groups }), kept, keepHeld };
}

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

/**
 * 114회차(재현): 인증 실패 정지 기록(`<도구>-auth-stops.json` — util/authGuard.js)은 백업 판본으로 **풀지 않는다**. 백업에 없는 지금의 정지(백업 뒤에 거부된
 *   자격증명)가 사라지면 다음 주기에 그 장비 전부가 같은 틀린 계정으로 한 번씩 다시 로그인한다 — 한 계정을 여러 장비가 쓰면 그 한 주기가 계정 잠금 임계를 넘는다
 *   (자동 재시도 금지 — v2.535 · v2.847). 규칙(장비 id 마다): 지금에만 있으면 지금 기록 · 백업에만 있으면 백업 기록(더 닫는 쪽) ·
 *   둘 다 있고 자격 지문(credHash)이 같으면 지금 기록(더 늦은 시도 수 · 시각) · 다르면 백업 기록(함께 복원되는 등록부의 자격증명에 맞는 쪽 —
 *   정지는 기록의 지문과 지금 자격이 같을 때만 걸리고, 다르면 수집기가 스스로 지우고 한 번 시도한다).
 *   지금 파일이 없거나 객체로 읽히지 않으면 백업 그대로. 읽기 오류는 reconcileForApply 가 던진다.
 * @returns {{ text:string, keptStops:number }}
 */
export function reconcileAuthStopsText(backupText, currentText) {
  const b = parseJson(backupText);
  const c = parseJson(currentText);
  if (!isObj(b) || !isObj(c)) return { text: String(backupText), keptStops: 0 };
  const out = { ...b }; let keptStops = 0;
  for (const [id, rec] of Object.entries(c)) {
    if (!isObj(rec) || id === '__proto__') continue;
    const bak = Object.hasOwn(b, id) && isObj(b[id]) ? b[id] : null;
    if (bak && bak.credHash !== rec.credHash) continue;
    if (!bak) keptStops += 1;
    out[id] = rec;
  }
  return { text: JSON.stringify(out, null, 2), keptStops };
}

/**
 * 114회차(재현): 실행 필드(`last*` · useCount)를 지금 파일에서 가져온다(순수 · 재귀). 객체는 같은 키끼리, 배열은 원소가 `id` 를 가진 객체일 때 같은 id 끼리 맞춘다
 *   (맞출 수 없는 배열은 백업 그대로). 지금 쪽에 그 실행 필드가 없으면 백업 값을 둔다. 깊이 상한 12(설정 파일은 얕다).
 */
const RUN_FIELD_R = /^(last[A-Z]|useCount$)/;   // backup/service.js RUN_FIELD_RE 와 같은 규칙(시험이 대조)
const idOfItem = (x) => (isObj(x) && (typeof x.id === 'string' || typeof x.id === 'number') ? String(x.id) : null);
function carryRunFields(b, c, depth = 0) {
  if (depth > 12) return b;
  if (Array.isArray(b)) {
    if (!Array.isArray(c)) return b;
    const byId = new Map();
    for (const x of c) { const k = idOfItem(x); if (k != null && !byId.has(k)) byId.set(k, x); }
    return b.map((x) => { const k = idOfItem(x); return k != null && byId.has(k) ? carryRunFields(x, byId.get(k), depth + 1) : x; });
  }
  if (!isObj(b) || !isObj(c)) return b;
  const out = {};
  for (const [k, v] of Object.entries(b)) {
    if (k === '__proto__') continue;
    if (!Object.hasOwn(c, k)) out[k] = v;
    else out[k] = RUN_FIELD_R.test(k) ? c[k] : carryRunFields(v, c[k], depth + 1);
  }
  for (const [k, v] of Object.entries(c)) if (RUN_FIELD_R.test(k) && !Object.hasOwn(b, k)) out[k] = v;   // 백업 뒤 처음 돈 기록
  return out;
}
/** @returns {{ text:string, changed:boolean }} 지금 파일이 없거나 읽히지 않으면 백업 그대로. */
export function reconcileRunFieldsText(backupText, currentText) {
  const b = parseJson(backupText);
  const c = parseJson(currentText);
  if (b == null || typeof b !== 'object' || c == null || typeof c !== 'object') return { text: String(backupText), changed: false };
  const text = JSON.stringify(carryRunFields(b, c), null, 2);
  const changed = text !== JSON.stringify(b, null, 2);
  return { text: changed ? text : String(backupText), changed };   // 바뀐 것이 없으면 글자 그대로
}

/**
 * 114회차(재현): VM 백업 잡(vm-clone.json) — 잡 정의는 백업 것, **실행 원장은 지금 것**. 백업 판본을 그대로 쓰면
 *   ① 옛 lastRun 때문에 재시작 직후 오늘 백업이 한 번 더 돌고(vmclone/store.js isDue — 매일 HH:MM · N시간 간격) ② 클론 원장(clones — 보존정책이 지울 수 있는
 *   유일한 목록)이 백업 시점으로 돌아가 그 뒤에 만든 사본이 원장에서 빠지고(고아 — 스토리지가 샌다) 이미 지운 사본이 다시 목록에 오르며
 *   ③ 백업 때 돌던 실행 표지(running)가 되살아나 '재시작으로 중단' 으로 보고 스냅샷 정리 · 재실행을 한다.
 *   규칙: 두 파일에 다 있는 잡(id)은 clones · lastRun · history · running 을 지금 것으로 · 작업 기록(ops)도 지금 것 · 백업에만 있는 잡은 running 만 비운다
 *   (그때 돌던 실행은 지금 것이 아니다 — 지금 파일이 없는 재해 복구에서도). 지금 파일이 읽히지 않으면 그 밖은 백업 그대로.
 * @returns {{ text:string, keptRuns:number }}
 */
const VMCLONE_RUN_KEYS = ['clones', 'lastRun', 'history', 'running'];
export function reconcileVmCloneText(backupText, currentText) {
  const b = parseJson(backupText);
  if (!isObj(b) || !Array.isArray(b.jobs)) return { text: String(backupText), keptRuns: 0 };
  const c = parseJson(currentText);
  const cur = isObj(c) && Array.isArray(c.jobs) ? new Map(c.jobs.filter((j) => idOfItem(j) != null).map((j) => [String(j.id), j])) : null;
  let keptRuns = 0; let touched = false;
  const jobs = b.jobs.map((j) => {
    if (!isObj(j)) return j;
    const now = cur && idOfItem(j) != null ? cur.get(String(j.id)) : null;
    if (!now) { if (!Object.hasOwn(j, 'running') || j.running == null) return j; touched = true; const n = { ...j }; delete n.running; return n; }
    const n = { ...j };
    for (const k of VMCLONE_RUN_KEYS) { if (Object.hasOwn(now, k)) n[k] = now[k]; else delete n[k]; }
    keptRuns += 1; touched = true;
    return n;
  });
  const out = { ...b, jobs };
  if (cur && Array.isArray(c.ops)) { out.ops = c.ops; touched = true; }
  return { text: touched ? JSON.stringify(out, null, 2) : String(backupText), keptRuns };
}

/**
 * 114회차(재현): 호스트 접근 제어(host-access.json) — 초안(draft)은 백업 것, **이 호스트의 방화벽 적용 기록**(applied · pending · revertedAt/By)은 지금 것.
 *   복원은 방화벽 명령을 돌리지 않는다 — 그런데 적용 기록까지 백업 판본으로 바꾸면 화면의 '적용됨' 이 실제 방화벽(백업 뒤 본인 OTP 로 확정한 규칙)과 달라지고,
 *   직전 적용분(applied.rich — 다음 적용이 지울 관리 대상) · 포탈이 내린 sshd 표지(sshdStopped)가 틀려진다. 또 변경 감시 백업은 적용 10초 뒤에 만들어져
 *   **확정 대기(pending)** 를 담는다 — 그 판본을 되살리면 기동이 기한 지난 대기를 보고 방화벽을 다시 읽어 들인다(--reload).
 *   지금 파일이 없거나 읽히지 않으면 백업 그대로이되 확정 대기만 비운다(그때의 대기는 지금 것이 아니다).
 * @returns {{ text:string, keptState:boolean, droppedPending:boolean }}
 */
const HOST_STATE_KEYS = ['applied', 'pending', 'revertedAt', 'revertedBy'];
export function reconcileHostAccessText(backupText, currentText) {
  const b = parseJson(backupText);
  if (!isObj(b)) return { text: String(backupText), keptState: false, droppedPending: false };
  const c = parseJson(currentText);
  const out = { ...b };
  if (!isObj(c)) {
    if (b.pending == null) return { text: String(backupText), keptState: false, droppedPending: false };
    out.pending = null;
    return { text: JSON.stringify(out, null, 2), keptState: false, droppedPending: true };
  }
  for (const k of HOST_STATE_KEYS) { if (Object.hasOwn(c, k)) out[k] = c[k]; else delete out[k]; }
  const keptState = HOST_STATE_KEYS.some((k) => JSON.stringify(out[k] ?? null) !== JSON.stringify(b[k] ?? null));
  return { text: keptState ? JSON.stringify(out, null, 2) : String(backupText), keptState, droppedPending: b.pending != null && out.pending == null };
}

/**
 * 114회차(110 결정 ① — 재현 · 권장안): 원격 명령 점검 스케줄(rma-schedules.json) — **셸을 주기 실행하는 점검**(script · ssh — rma/signing.js scheduleSignRequired)을
 *   넣거나 고치는 저장은 설정 소유자 등급 + 본인 OTP 다(routes/api/rma.js shellScheduleGate). 지우는 것은 OTP 가 없고, 복원은 OTP 를 묻지 않는다 — 백업 판본을
 *   그대로 쓰면 백업 뒤에 지우거나 끄거나 고친 그 점검이 되살아나 엣지가 다시 주기 실행했다. 그런 점검은 **지금도 같은 내용(점검 · 인수 · 인스턴스 · 주기)으로
 *   켜져 있을 때만** 켜진 채 복원하고, 아니면 꺼서(enabled:false) 복원한다(정의는 남긴다 — 화면에서 본인 OTP 로 다시 켠다). 고친 법인은 버전을 올려 엣지가 다시 받는다.
 *   지금 파일이 없거나 읽히지 않으면(재해 복구) 백업 그대로. 읽기 오류는 reconcileForApply 가 던진다.
 * @returns {{ text:string, disabled:number }}
 */
const sortedJson = (v) => JSON.stringify(v, (_k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x)) ?? 'null';
const sameShellTest = (a, b) => String(a.test) === String(b.test) && sortedJson(a.args ?? {}) === sortedJson(b.args ?? {})
  && String(a.instance || '').trim().toLowerCase() === String(b.instance || '').trim().toLowerCase() && Number(a.intervalSec) === Number(b.intervalSec);
export function reconcileRmaSchedulesText(backupText, currentText) {
  const b = parseJson(backupText);
  const c = parseJson(currentText);
  if (!isObj(b) || !isObj(b.agents) || !isObj(c) || !isObj(c.agents)) return { text: String(backupText), disabled: 0 };
  const lcName = (k) => String(k || '').trim().toLowerCase();
  const curAgents = new Map(Object.entries(c.agents).map(([k, a]) => [lcName(k), a]));
  const verOf = (a) => { const n = Math.floor(Number(a?.version)); return Number.isFinite(n) && n > 0 ? n : 0; };
  let disabled = 0; const agents = {};
  for (const [name, a] of Object.entries(b.agents)) {
    if (name === '__proto__') continue;
    if (!isObj(a) || !Array.isArray(a.tests)) { agents[name] = a; continue; }
    const now = curAgents.get(lcName(name));
    const nowTests = new Map((isObj(now) && Array.isArray(now.tests) ? now.tests : []).filter((t) => isObj(t) && t.id != null).map((t) => [String(t.id), t]));
    let n = 0;
    const tests = a.tests.map((t) => {
      if (!isObj(t) || !scheduleSignRequired(t.test) || t.enabled === false) return t;
      const cur = nowTests.get(String(t.id));
      if (cur && cur.enabled !== false && sameShellTest(cur, t)) return t;
      n += 1;
      return { ...t, enabled: false };
    });
    agents[name] = n ? { ...a, tests, version: Math.max(verOf(a), verOf(now)) + 1 } : a;
    disabled += n;
  }
  return { text: disabled ? JSON.stringify({ ...b, agents }, null, 2) : String(backupText), disabled };
}

/**
 * 114회차(110 결정 ② — 재현 · 권장안): 통합 계정(credentials.json) — 등록 · 수정 · 삭제는 본인 OTP 재인증이다(routes/api/credentials.js reauth). 백업 판본을
 *   그대로 쓰면 ① 백업 뒤에 지운 계정이 되살아나고 ② 좁힌 사용 범위(agents · hosts)가 넓은 옛 범위로 돌아가 브로커(/api/central/rma-credential)가 다시 내줬다.
 *   규칙: 지금 파일에 없는 계정(id)은 되살리지 않는다 · 두 파일에 다 있는 계정은 백업 내용(이름 · 비밀)에 **범위는 좁은 쪽** — 지금이 '*' 면 백업 목록,
 *   백업이 '*' 면 지금 목록, 그 밖은 두 목록에 **글자 그대로** 다 있는 항목만(CIDR · *.접미사의 포함 관계는 따지지 않는다 — 더 좁아질 뿐 넓어지지 않는다).
 *   지금 파일이 없거나 읽히지 않으면(재해 복구 · 손상) 백업 그대로. 읽기 오류는 reconcileForApply 가 던진다. 비밀 칸(봉인 값)은 건드리지 않는다.
 * @returns {{ text:string, dropped:number, narrowed:number }}
 */
const scopeList = (v) => (Array.isArray(v) ? v : []).map((x) => String(x ?? '').trim()).filter(Boolean);
function narrowScope(bak, now) {
  const b = scopeList(bak); const n = scopeList(now);
  const ns = new Set(n.map((x) => x.toLowerCase())); const bs = new Set(b.map((x) => x.toLowerCase()));
  if (ns.has('*')) return { list: b, changed: false };
  if (bs.has('*')) return { list: n, changed: true };
  const list = b.filter((x) => ns.has(x.toLowerCase()));
  return { list, changed: list.length !== b.length };
}
export function reconcileCredentialsText(backupText, currentText) {
  const b = parseJson(backupText);
  const c = parseJson(currentText);
  if (!isObj(b) || !Array.isArray(b.items) || !isObj(c) || !Array.isArray(c.items)) return { text: String(backupText), dropped: 0, narrowed: 0 };
  const cur = new Map(c.items.filter((x) => isObj(x) && x.id != null).map((x) => [String(x.id), x]));
  let dropped = 0; let narrowed = 0; const items = [];
  for (const it of b.items) {
    if (!isObj(it) || it.id == null) continue;   // id 없는 항목은 브로커가 찾지 못한다 — 싣지 않는다
    const now = cur.get(String(it.id));
    if (!now) { dropped += 1; continue; }
    const hosts = narrowScope(it.hosts, now.hosts); const agents = narrowScope(it.agents, now.agents);
    if (hosts.changed || agents.changed) { narrowed += 1; items.push({ ...it, hosts: hosts.list, agents: agents.list }); } else items.push(it);
  }
  if (!dropped && !narrowed && items.length === b.items.length) return { text: String(backupText), dropped: 0, narrowed: 0 };
  return { text: JSON.stringify({ ...b, items }, null, 2), dropped, narrowed };
}

/**
 * 120회차(114 가 '남긴 것' 으로 둔 OPEN — 재현): Bareos 복원 검증 정책(bareos-rehearsal.json) — 저장은 본인 OTP 다(routes/api/bareosBackup.js PUT …/rehearsal).
 *   백업 판본을 그대로 쓰면 OTP 로 꺼 둔 검증이 복원으로 다시 켜져 매주 법인마다 검증용 VM 을 만들었고(재현: 지금 끔 · 백업 켬 → 로더가 켬 · 법인마다 10대),
 *   줄여 둔 대수(perCorp)도 옛 값으로 늘었다. 복원으로는 **켜지 않고 · 대수를 늘리지 않는다**(끄기 · 줄이기 · 요일 · 시각 · 데이터스토어 지정은 백업 그대로).
 *   지금 파일이 없거나 정책 객체로 읽히지 않으면(새 서버 재해 복구 · 손상) 백업 그대로. 읽기 오류는 reconcileForApply 가 던진다.
 * @returns {{ text:string, heldOff:boolean, heldPerCorp:boolean }}
 */
export function reconcileRehearsalText(backupText, currentText) {
  const b = parseJson(backupText);
  const c = parseJson(currentText);
  const none = { text: String(backupText), heldOff: false, heldPerCorp: false };
  if (!isObj(b) || !isObj(c) || b.enabled !== true) return none;
  if (c.enabled !== true) return { text: JSON.stringify({ ...b, enabled: false }, null, 2), heldOff: true, heldPerCorp: false };
  const bn = Number(b.perCorp); const cn = Number(c.perCorp);
  if (Number.isInteger(bn) && Number.isInteger(cn) && cn >= 1 && bn > cn) return { text: JSON.stringify({ ...b, perCorp: cn }, null, 2), heldOff: false, heldPerCorp: true };
  return none;
}

/** 적용할 내용을 현재 파일과 맞춘다 — 대상이 아니면 그대로. @returns {{ content:string, warning?:{file,reason}, info?:object }} */
/**
 * v2.842(반증 F1 — 재현): security-session.json 의 `bareosSetupOtp`(Bareos 자동 설정 쓰기 단계 본인 OTP 재확인)는 복원으로 **켜기만** 한다(순수).
 *   복원 라우트는 소유자 등급만 보고 OTP 를 묻지 않는다 — 백업 판본(끔)을 그대로 쓰면 소유자가 다시 켠 뒤에도 OTP 없이 '끔' 이 되살아났다
 *   (설정 변경 시 자동 백업이 켜져 있어 끈 시기의 백업은 거의 늘 있다). 파일 통째 제외(v2.809 서명 끄기 선례)는 같은 파일의 다른 설정까지 막아 쓰지 않는다.
 *   결과가 끔인 경우는 백업도 끔이고 **지금 파일도 명시적으로 끔**일 때뿐이다(지금 파일이 없거나 못 읽으면 켬 — 재해 복구 새 서버도 켬으로 시작).
 * @returns {{ text: string, forcedOn: boolean }}
 */
/**
 * 전체 점검 9회차(V-20 — 재현): 같은 파일의 다른 '소유자 + 본인 OTP' 설정도 복원으로 **약해지지 않게** 맞춘다 — 복원 라우트는 OTP 를 묻지 않는데
 *   백업 판본을 그대로 쓰면 OTP 로 바꾼 로그인 방식(password_only → otp_only)이 되돌아가고, 지운 설정 소유자가 되살아나고, 켠 단일 세션 · 유휴 로그아웃이 꺼졌다
 *   (v2.842 F1 과 같은 종류 — server/CLAUDE.md '새 OTP 로 끄는 설정은 RESTORE_EXCLUDE 또는 reconcileForApply').
 *   ⓐ loginPolicy 는 강도 순(otp_only > 미설정(레거시) > otp_or_password > password_only)으로 더 강한 쪽 ⓑ settingsOwners 는 지금 목록에 있는 계정만
 *   ⓒ idleLogoutEnabled · singleSession 은 켜기만 ⓓ idleLogoutMin · sessionMaxHours 는 더 짧은 쪽(0 = 무제한이 가장 약하다).
 *   지금 파일이 없거나 못 읽으면 기본값(엄격)과 견준다 — 재해 복구 새 서버도 약한 값으로 시작하지 않는다(소유자 목록만은 백업 그대로 — 새 서버의 소유자 복구 경로).
 */
const POLICY_RANK = Object.freeze({ otp_only: 3, otp_or_password: 1, password_only: 0 });   // 그 밖(null · 모르는 값) = 레거시(2)
const policyRank = (v) => (Object.hasOwn(POLICY_RANK, v) ? POLICY_RANK[v] : 2);
const OWNER_RE = /^[A-Za-z0-9._@-]{2,64}$/;
const ownersOf = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x || '').trim()).filter((x) => OWNER_RE.test(x)))] : []);
const minutesOf = (v, dflt) => { const n = Number(v); return v !== '' && v !== null && v !== undefined && Number.isFinite(n) && n > 0 ? n : dflt; };
const maxHoursOf = (v) => { const n = Number(v); return v === '' || v === null || v === undefined || !Number.isFinite(n) || n <= 0 ? Infinity : n; };   // 0 · 없음 = 무제한
export function reconcileSecuritySessionText(backupText, currentText) {
  let b;
  try { b = JSON.parse(String(backupText)); } catch { return { text: backupText, forcedOn: false, kept: [] }; }   // 깨진 판본은 로더가 손상 보존 → 기본값(엄격)
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { text: backupText, forcedOn: false, kept: [] };
  let c = null;
  try { c = JSON.parse(String(currentText)); if (!c || typeof c !== 'object' || Array.isArray(c)) c = null; } catch { c = null; }
  const out = { ...b }; const kept = [];
  // v2.842: bareosSetupOtp — 끔은 백업도 끔이고 지금 파일도 명시적으로 끔일 때만
  if (b.bareosSetupOtp === false && !(c && c.bareosSetupOtp === false)) { out.bareosSetupOtp = true; kept.push('bareosSetupOtp'); }
  const curPolicy = c ? c.loginPolicy : null;
  if (policyRank(b.loginPolicy) < policyRank(curPolicy)) { out.loginPolicy = Object.hasOwn(POLICY_RANK, curPolicy) ? curPolicy : null; kept.push('loginPolicy'); }
  if (c && Array.isArray(b.settingsOwners)) {
    const cur = new Set(ownersOf(c.settingsOwners).length ? ownersOf(c.settingsOwners) : ['noainred']);   // 지금 저장값이 없으면 기본(loadConfiguredSecurity 와 같게)
    const bo = ownersOf(b.settingsOwners);
    const inter = bo.filter((x) => cur.has(x));
    if (inter.length !== bo.length) { out.settingsOwners = inter; kept.push('settingsOwners'); }
  }
  const boolOf = (o, k, dflt) => (o && o[k] !== undefined ? !!o[k] : dflt);
  if (!boolOf(b, 'idleLogoutEnabled', true) && boolOf(c, 'idleLogoutEnabled', true)) { out.idleLogoutEnabled = true; kept.push('idleLogoutEnabled'); }
  if (!boolOf(b, 'singleSession', false) && boolOf(c, 'singleSession', false)) { out.singleSession = true; kept.push('singleSession'); }
  const curIdle = minutesOf(c?.idleLogoutMin, 30);
  if (minutesOf(b.idleLogoutMin, 30) > curIdle) { out.idleLogoutMin = curIdle; kept.push('idleLogoutMin'); }
  const curMax = maxHoursOf(c?.sessionMaxHours);
  if (maxHoursOf(b.sessionMaxHours) > curMax) { out.sessionMaxHours = curMax; kept.push('sessionMaxHours'); }
  return { text: kept.length ? JSON.stringify(out, null, 2) : backupText, forcedOn: kept.includes('bareosSetupOtp'), kept };
}

/**
 * 전체 점검 9회차(V-20): 자격증명 저장 방식(secrets-policy.json · 신뢰 사본)도 복원으로 **약해지지 않게** — 지금이 암호화인데 백업이 평문이면 지금 파일 그대로
 *   (평문 백업을 되돌리면 그 뒤 저장하는 새 비밀이 평문이 됐다 · 바꾸려면 소유자 + 본인 OTP). 지금 파일이 없거나 못 읽으면 백업 그대로(재해 복구 — 정책 로더의 S-07 판정이 맡는다).
 */
export function reconcileSecretsPolicyText(backupText, currentText) {
  let c = null; let b = null;
  try { c = JSON.parse(String(currentText)); } catch { c = null; }
  try { b = JSON.parse(String(backupText)); } catch { b = null; }
  if (c && c.mode === 'encrypted' && !(b && b.mode === 'encrypted')) return { text: String(currentText), keptCurrent: true };
  return { text: backupText, keptCurrent: false };
}

/**
 * 88회차 F7(재현): 연동 키(api-keys.json)의 **폐기 · 삭제는 복원으로 되돌리지 않는다** — 백업 판본을 그대로 쓰면 백업 이후 폐기(유출 등)하고 지운 키가
 *   다시 'ok' 로 통과했다(전 함대 조회 자격증명 — 엣지 토큰 reconcileAgentTokensText · users.json tokenVersion 과 같은 종류).
 *   규칙: 키마다 백업 판본을 쓰되 ① 지금 파일에서 폐기된 키는 폐기 그대로(revokedAt · revokedBy) ② 지금 파일에 없는 키(= 백업 이후 폐기하고 지운 키 —
 *   산 키는 지울 수 없다, publicapi/keys.js deleteApiKey)는 되살리지 않는다 ③ 백업 이후 발급한 키(지금에만 있음)는 남긴다.
 *   지금 파일이 없거나 깨졌으면(새 서버 재해 복구) 백업 그대로. 읽기 오류면 reconcileForApply 가 던진다(이 파일만 적용하지 않는다).
 * @returns {{ text:string, keptRevoked:number, dropped:number, currentUnreadable:boolean }}
 */
export function reconcileApiKeysText(backupText, currentText) {
  const b = parseJson(backupText);
  if (!b || !Array.isArray(b.keys)) return { text: String(backupText), keptRevoked: 0, dropped: 0, currentUnreadable: false };
  const cur = parseJson(currentText);
  const curList = Array.isArray(cur?.keys) ? cur.keys.filter((k) => k && typeof k === 'object' && k.id != null) : null;
  if (!curList) return { text: String(backupText), keptRevoked: 0, dropped: 0, currentUnreadable: true };
  const curById = new Map(curList.map((k) => [String(k.id), k]));
  const seen = new Set();
  const keys = [];
  let keptRevoked = 0; let dropped = 0;
  for (const k of b.keys) {
    if (!k || typeof k !== 'object' || k.id == null) continue;
    const id = String(k.id);
    const now = curById.get(id);
    if (!now) { dropped += 1; continue; }
    seen.add(id);
    if (now.revokedAt && !k.revokedAt) { keys.push({ ...k, revokedAt: now.revokedAt, revokedBy: now.revokedBy || '' }); keptRevoked += 1; }
    else keys.push(k);
  }
  for (const k of curList) if (!seen.has(String(k.id))) keys.push(k);
  return { text: JSON.stringify({ ...b, keys }, null, 2), keptRevoked, dropped, currentUnreadable: false };
}

/**
 * 88회차 F6(재현): AD 설정(auth.json)의 정책 카운터(policyEpoch)도 복원으로 **되돌리지 않는다** — AD 토큰은 발급 당시 `카운터.매핑지문` 을 싣고
 *   지금 값과 같을 때만 유효하다(auth/ad.js S-08). 백업 판본을 그대로 쓰면 백업 이후 매핑을 바꿔 무효가 된 AD 세션(예: 관리자 그룹에서 빠진 계정의
 *   admin 토큰)이 만료 전까지 되살아났다(users.json 의 tokenVersion 과 같은 종류 — reconcileUsersText). 카운터 = max(지금, 백업) + 1 — 복원 뒤 AD 세션은
 *   전부 다시 로그인한다. 지금 파일을 **읽지 못하면**(ENOENT 아님) 던져서 이 파일만 적용하지 않는다(지금 카운터를 모른 채 낮은 값을 쓰지 않게).
 * @returns {{ text:string, bumped:boolean, epoch?:number }}
 */
export function reconcileAdConfigText(backupText, currentText) {
  let b;
  try { b = JSON.parse(String(backupText)); } catch { return { text: backupText, bumped: false }; }   // 깨진 판본은 로더가 손상 보존 → env 기본값(카운터 0 — AD 토큰은 'ep' 가 맞지 않아 무효)
  if (!b || typeof b !== 'object' || Array.isArray(b) || !b.ad || typeof b.ad !== 'object' || Array.isArray(b.ad)) return { text: backupText, bumped: false };
  let c = null;
  try { c = JSON.parse(String(currentText)); } catch { c = null; }
  const ep = (o) => { const n = Math.floor(Number(o?.ad?.policyEpoch)); return Number.isFinite(n) && n > 0 ? n : 0; };
  const epoch = Math.max(ep(b), ep(c)) + 1;
  return { text: JSON.stringify({ ...b, ad: { ...b.ad, policyEpoch: epoch } }, null, 2), bumped: true, epoch };
}

/**
 * 91회차(88회차 남긴 것 ① · 결정 — 권장안): 장비 신뢰(peer-trust.json)도 복원으로 **약해지지 않게** 맞춘다 — 복원 라우트는 OTP 를 묻지 않는데(정책을 observe 로
 *   바꾸는 것은 소유자 + 본인 OTP — 91회차) 백업 판본을 그대로 쓰면 ① 백업 뒤 enforce 로 닫은 정책이 observe 로 돌아가고 ② 백업 뒤 회수(거부)한 지문이 다시
 *   신뢰 지문으로 통과했다(가로챈 장비 · 유출된 키 — F7 연동 키 폐기와 같은 종류, v2.842 '켜기만' 규칙).
 *   규칙: ⓐ 정책은 지금이 enforce 면 enforce(켜기만) ⓑ 지금 파일에서 거부된 지문은 백업 판본의 신뢰 · 대기 지문에서 빼고 거부 목록에 남긴다 ⓒ 백업 이후 생긴 항목(지금에만 있음)은 남긴다.
 *   지금 파일이 없거나 깨졌으면(재해 복구 · 손상 — 로더가 enforce 로 닫는다) 백업 그대로. 읽기 오류면 reconcileForApply 가 던진다(이 파일만 적용하지 않는다).
 *   ⚠ 이 모듈은 기동 때 다른 모듈보다 먼저 돈다(stagedRestoreBoot) — security/peerTrust.js 를 import 하지 않는다(config · audit 를 먼저 싣는다). 키 · 지문은 파일에 쓰인
 *   정규형(peerTrust 가 쓸 때 정규화한다)을 가볍게 맞춰 비교한다.
 */
const PEER_KINDS_R = ['ssh', 'tls'];
const peerKeyR = (e) => `${e.kind}|${String(e.host ?? '').trim().toLowerCase()}|${Math.floor(Number(e.port))}`;
const peerFpR = (kind, fp) => {
  const t = String(fp ?? '').slice(0, 200).trim();   // 지문은 200자 안(peerTrust normalizeFingerprint 상한) — 정규식 전에 자른다
  if (kind === 'ssh') return t.replace(/^sha256:/i, '').replace(/=+$/, '');
  return t.replace(/^sha256:/i, '').replace(/[\s:]/g, '').toUpperCase();
};
const peerTrustedListR = (e) => {
  const out = [];
  if (Array.isArray(e?.trusted)) for (const t of e.trusted) out.push(t); else if (e?.trusted && typeof e.trusted === 'object') out.push(e.trusted);
  if (Array.isArray(e?.trustedMore)) for (const t of e.trustedMore) out.push(t);
  return out.filter((t) => t && typeof t === 'object');
};
const PEER_TRUSTED_MAX_R = 8;   // peerTrust TRUSTED_MAX 와 같은 값(로더는 넘긴 꼬리를 버린다)
/*
 * 110회차(재현): 두 파일에 다 있는 장비는 백업 항목을 그대로 쓰고 지금 거부한 지문만 뺐다 — 그래서
 *   ① **지금 승인된 지문을 버렸다**: 백업의 신뢰 지문이 전부 회수된 장비(지금 [B 승인] · A 거부 / 백업 [A 승인])는 신뢰 지문이 하나도 없는 항목이 되어,
 *     observe 에서 처음 보는 지문 X 가 '관찰' 로 **통과**했다(복원 전에는 '바뀐 지문' 으로 거부 — 신뢰 지문이 있는 장비의 다른 지문은 정책과 무관하게 거부한다).
 *   ② 두 종류 정책을 함께 지킬 때 첫 종류(ssh)의 origin 을 백업 값으로 되덮었다(화면이 enforce 인데 'upgrade-migration' · 'load-error' 를 말한다).
 *   ③ (결정 → 권장안) 교체 승인(replace)으로 뺀 지문이 신뢰 지문으로 되살아났다(키 교체는 '그 지문 하나만 남긴다' — 거부 목록에는 없어 ⓑ 가 잡지 못했다).
 *   규칙(두 파일에 다 있는 장비 — 지금보다 약해지지 않게):
 *     신뢰 = (백업 신뢰 − 지금 거부 − 지금 이력의 교체로 뺀 지문) ∪ 지금 신뢰 · 거부 = (백업 거부 − 지금 신뢰) ∪ 지금 거부 · 대기 = 백업 대기(거부됐거나 이미 신뢰면 비움).
 *   교체로 뺀 지문은 거부 목록에 넣지 않는다(다시 보이면 '바뀐 지문' 으로 승인 대기 — peerTrust approvePeer 와 같게). 이력은 장비마다 8건이라 그보다 오래된 교체는 모른다(정직 기록).
 */
export function reconcilePeerTrustText(backupText, currentText) {
  const none = { keptPolicy: [], keptRevoked: 0, keptReplaced: 0, keptApproved: 0 };
  const b = parseJson(backupText);
  if (!b || typeof b !== 'object' || !Array.isArray(b.entries)) return { text: String(backupText), ...none };
  const c = parseJson(currentText);
  if (!c || typeof c !== 'object' || !Array.isArray(c.entries)) return { text: String(backupText), ...none };
  const bPolicy = b.policy && typeof b.policy === 'object' && !Array.isArray(b.policy) ? b.policy : {};
  const out = { ...b, policy: { ...bPolicy } };
  const keptPolicy = [];
  for (const kind of PEER_KINDS_R) {
    if (c.policy?.[kind] === 'enforce' && out.policy[kind] !== 'enforce') {
      out.policy[kind] = 'enforce'; keptPolicy.push(kind);
      // 110회차 ②: 앞 종류에서 맞춘 origin 위에 얹는다(예전에는 매번 백업 origin 에서 다시 시작해 앞 종류의 값을 잃었다)
      if (c.origin?.[kind] && typeof c.origin[kind] === 'object') out.origin = { ...(out.origin && typeof out.origin === 'object' && !Array.isArray(out.origin) ? out.origin : {}), [kind]: c.origin[kind] };
    }
  }
  const cur = new Map();
  for (const e of c.entries) if (e && typeof e === 'object' && PEER_KINDS_R.includes(e.kind)) cur.set(peerKeyR(e), e);
  const seen = new Set();
  let keptRevoked = 0; let keptReplaced = 0; let keptApproved = 0;
  const entries = b.entries.map((e) => {
    if (!e || typeof e !== 'object' || !PEER_KINDS_R.includes(e.kind)) return e;
    const key = peerKeyR(e); seen.add(key);
    const now = cur.get(key);
    if (!now) return e;
    const fpOf = (x) => peerFpR(e.kind, x?.fp);
    const objs = (v) => (Array.isArray(v) ? v.filter((r) => r && typeof r === 'object') : []);
    const nowRej = objs(now.rejected);
    const rev = new Set(nowRej.map(fpOf).filter(Boolean));
    const nowTrusted = peerTrustedListR(now).filter((t) => fpOf(t) && !rev.has(fpOf(t)));
    const nowFps = new Set(nowTrusted.map(fpOf));
    const repl = new Set();   // 지금 이력의 교체 승인이 뺀 지문(그 뒤 다시 승인해 지금 신뢰 목록에 있으면 아니다)
    for (const h of objs(now.history)) if (h.ev === 'approved-replace' && Array.isArray(h.replaced)) for (const f of h.replaced.slice(0, 64)) { const x = peerFpR(e.kind, f); if (x && !nowFps.has(x)) repl.add(x); }
    const list = peerTrustedListR(e);
    let merged = list.filter((t) => !rev.has(fpOf(t)) && !repl.has(fpOf(t)));
    const droppedRev = list.filter((t) => rev.has(fpOf(t))).length;
    const droppedRepl = list.length - merged.length - droppedRev;
    let carried = 0;
    for (const t of nowTrusted) {
      const i = merged.findIndex((x) => fpOf(x) === fpOf(t));
      if (i < 0) { merged.push(t); carried += 1; }
      else if (t.state === 'approved' && merged[i].state !== 'approved') { merged = merged.map((x, j) => (j === i ? t : x)); carried += 1; }
    }
    if (merged.length > PEER_TRUSTED_MAX_R) {   // 상한을 넘으면 지금 지문을 앞에(로더가 꼬리를 버린다 — 지금 통과하는 지문이 남게)
      merged = [...nowTrusted.map((t) => merged.find((x) => fpOf(x) === fpOf(t))), ...merged.filter((x) => !nowFps.has(fpOf(x)))].slice(0, PEER_TRUSTED_MAX_R);
    }
    const bRej = objs(e.rejected);
    const keepRej = bRej.filter((r) => !nowFps.has(fpOf(r)));   // 백업 뒤 승인한 지문의 옛 거부 기록(승인이 거부를 푼다 — approvePeer)
    const bRejFps = new Set(bRej.map(fpOf));
    const addRej = nowRej.filter((r) => !bRejFps.has(fpOf(r)));
    const pend = e.pending && typeof e.pending === 'object' ? fpOf(e.pending) : '';
    const pendRevoked = !!(pend && rev.has(pend));
    const pendDone = !!(pend && !pendRevoked && merged.some((x) => fpOf(x) === pend && x.state === 'approved'));   // 백업 뒤 승인한 대기 지문
    const sameTrusted = merged.length === list.length && merged.every((x, i) => x === list[i]);
    if (sameTrusted && keepRej.length === bRej.length && !addRej.length && !pendRevoked && !pendDone) return e;
    keptRevoked += droppedRev + (pendRevoked ? 1 : 0);
    keptReplaced += droppedRepl;
    keptApproved += carried;
    const ne = { ...e, trusted: merged[0] || null, rejected: [...keepRej, ...addRej] };
    if (!ne.rejected.length && !('rejected' in e)) delete ne.rejected;
    if (merged.length > 1) ne.trustedMore = merged.slice(1); else delete ne.trustedMore;
    if (pendRevoked || pendDone) ne.pending = null;
    return ne;
  });
  for (const [key, e] of cur) if (!seen.has(key)) entries.push(e);   // 백업 이후 생긴 항목(승인 · 거부 기록)
  out.entries = entries;
  // 120회차(재현): 정책을 enforce 로 지킨 종류에서 **관찰만 된(승인 전) 지문뿐인 장비** 수 — 그 장비는 복원 뒤 승인 전까지 접속이 거부된다('not-approved').
  //   새 설치는 기동 1초 안에 enforce(origin new-install) 파일을 스스로 만들므로, 관찰 정책 현장의 백업을 새 서버에 복원하면(재해 복구) 승인한 적 없는 장비가 전부 여기에 든다 —
  //   경고가 그 결과와 조치를 말하게 수를 돌려준다(정책 자체는 91회차 규칙대로 지금 값).
  const observedOnly = entries.filter((e) => e && typeof e === 'object' && keptPolicy.includes(e.kind)
    && peerTrustedListR(e).length > 0 && !peerTrustedListR(e).some((t) => t.state === 'approved')).length;
  return { text: JSON.stringify(out, null, 1), keptPolicy, keptRevoked, keptReplaced, keptApproved, observedOnly };
}

/** 91회차: 지금 파일을 읽는다 — 없으면 null, 그 밖의 읽기 오류(EACCES · EIO · EISDIR)는 던져서 **이 파일만 적용하지 않는다**(지금 값을 모른 채 약한 백업으로 덮지 않게). */
function readCurrentOrThrow(configDir, name, what) {
  try { return fs.readFileSync(path.join(configDir, name), 'utf8'); } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw new Error(`지금 ${what}(${name})을 읽지 못해(${String(e?.code || 'read-error').slice(0, 32)}) 복원하지 않았습니다 — 지금 값을 모른 채 백업 판본으로 덮지 않게 지금 파일을 그대로 둡니다`);
  }
}

/** 114회차: 지금 파일이 있으면 복원하지 않는 실행 기록인가 — 있으면(읽히든 아니든) 사유, 없음(ENOENT)이거나 대상이 아니면 null. */
function keepCurrentReason(configDir, name) {
  const why = RESTORE_KEEP_CURRENT.get(name);
  if (!why) return null;
  try { fs.lstatSync(path.join(configDir, name)); return why; } catch (e) { return e?.code === 'ENOENT' ? null : why; }
}

/** @returns {{ content?:string, keep?:string, warning?:{file,reason}, info?:object }}  keep = 쓰지 않고 지금 파일을 그대로 둔다(사유) */
export function reconcileForApply(name, content, configDir) {
  { const keep = keepCurrentReason(configDir, name); if (keep) return { keep }; }   // 114회차: 실행 기록 — 지금 파일이 있으면 그대로
  if (name === 'security-session.json') {
    // 91회차(88 F6 · F7 반증 — 형제): 지금 파일의 **읽기 오류**를 '없음' 으로 보면 기본값과 견줘 백업의 약한 값(예: 지금 otp_only · 백업 레거시)이 그대로 들어갔다
    //   (원자 쓰기는 읽지 못한 원본도 대체한다). 없음(ENOENT)만 기본값과 견주고, 읽기 오류면 이 파일만 적용하지 않는다.
    const cur = readCurrentOrThrow(configDir, name, '세션 보안 설정');
    // 100회차(98회차 반증 — 재현): 본 파일이 없거나 객체로 읽히지 않으면 돌고 있는 값은 **신뢰 사본**(security-session.trusted.json — 98회차)이다.
    //   예전에는 이때 기본값과 견줘, 사본의 otp_only · 단일 세션 · 총 상한 8시간 · 소유자 목록을 백업의 약한 값(레거시 · 끔 · 무제한 · 소유자 추가)으로
    //   OTP 없이 내렸다. 사본과 견준다(사본을 못 읽으면 이 파일만 적용하지 않는다 — 지금 값을 모른 채 덮지 않는 91회차 규칙). 둘 다 없으면 예전과 같다(기본값과 견줌).
    const objText = (t) => { try { const j = JSON.parse(String(t)); return j && typeof j === 'object' && !Array.isArray(j) ? t : null; } catch { return null; } };
    const effective = objText(cur) ?? objText(readCurrentOrThrow(configDir, 'security-session.trusted.json', '세션 보안 신뢰 사본')) ?? cur;
    const r = reconcileSecuritySessionText(content, effective);
    const others = r.kept.filter((k) => k !== 'bareosSetupOtp');
    if (r.forcedOn && !others.length) return { content: r.text, info: { bareosSetupOtpKeptOn: true }, warning: { file: name, reason: '백업에는 Bareos 자동 설정 본인 OTP 재확인이 꺼져 있었지만 복원으로는 끄지 않습니다(켬으로 적용) — 끄려면 설정 › 보안 › 세션 보안에서 본인 OTP 로 저장하세요.' } }
    if (r.kept.length) {
      return { content: r.text, info: { ...(r.forcedOn ? { bareosSetupOtpKeptOn: true } : {}), securityKept: r.kept },
        warning: { file: name, reason: `백업 판본이 지금보다 약한 보안 설정(${r.kept.join(' · ')})을 담고 있어 그 값은 지금 수준으로 두었습니다 — 복원은 본인 OTP 를 묻지 않으므로 약하게 되돌리지 않습니다(바꾸려면 설정 › 세션 보안에서 소유자 + 본인 OTP).` } };
    }
    return { content: r.text };
  }
  if (name === 'peer-trust.json') {   // 91회차(88회차 남긴 것 ①)
    const cur = readCurrentOrThrow(configDir, name, '장비 신뢰 목록');
    const r = reconcilePeerTrustText(content, cur);
    if (!r.keptPolicy.length && !r.keptRevoked && !r.keptReplaced && !r.keptApproved) return { content: r.text };
    const parts = [];
    if (r.keptPolicy.length) parts.push(`정책은 지금 값(승인된 지문만 허용 — ${r.keptPolicy.join(' · ')})을 유지했습니다`);
    // 120회차(재현 — 새 설치 위 재해 복구): 결과와 조치를 말한다 — 예전 문구는 '유지했습니다' 뿐이라 복원 뒤 승인한 적 없는 장비의 접속이 거부되는 까닭을 알 수 없었다
    if (r.observedOnly) parts.push(`그래서 관찰만 된(승인 전) 지문의 장비 ${r.observedOnly}대는 승인 전까지 접속이 거부됩니다(설정 › 장비 신뢰에서 지문을 확인한 뒤 ‘관찰 지문 일괄 승인’ 을 하거나, 정책을 관찰로 바꾸려면 소유자 + 본인 OTP)`);
    if (r.keptRevoked) parts.push(`백업 이후 거부(회수)한 지문 ${r.keptRevoked}개는 신뢰 목록으로 되살리지 않았습니다`);
    if (r.keptReplaced) parts.push(`백업 이후 교체 승인으로 뺀 지문 ${r.keptReplaced}개는 되살리지 않았습니다`);   // 110회차
    if (r.keptApproved) parts.push(`백업 이후 승인 · 관찰한 지문 ${r.keptApproved}개는 그대로 두었습니다`);
    return { content: r.text, info: { peerTrustKeptPolicy: r.keptPolicy, peerTrustKeptRevoked: r.keptRevoked, peerTrustKeptReplaced: r.keptReplaced, peerTrustKeptApproved: r.keptApproved, peerTrustObservedOnly: r.observedOnly },
      warning: { file: name, reason: `${parts.join(' · ')} — 복원은 본인 OTP 를 묻지 않으므로 장비 신뢰를 약하게 되돌리지 않습니다.` } };
  }
  if (name === 'api-keys.json') {   // 88회차 F7
    let cur = null;
    try { cur = fs.readFileSync(path.join(configDir, name), 'utf8'); } catch (e) {
      if (e?.code !== 'ENOENT') throw new Error(`지금 연동 키 파일(api-keys.json)을 읽지 못해(${String(e?.code || 'read-error').slice(0, 32)}) 복원하지 않았습니다 — 폐기 기록을 모른 채 되돌리지 않게 지금 파일을 그대로 둡니다`);
      cur = null;
    }
    const r = reconcileApiKeysText(content, cur);
    const out = { content: r.text, info: { apiKeysKeptRevoked: r.keptRevoked, apiKeysDropped: r.dropped } };
    if (r.keptRevoked || r.dropped) out.warning = { file: name, reason: `백업 이후 폐기한 연동 키 ${r.keptRevoked}개는 폐기 그대로 두고, 폐기하고 지운 키 ${r.dropped}개는 되살리지 않았습니다 — 복원은 키 폐기를 되돌리지 않습니다(필요하면 새로 발급하세요).` };
    return out;
  }
  if (name === 'auth.json') {   // 88회차 F6
    let cur = null;
    try { cur = fs.readFileSync(path.join(configDir, name), 'utf8'); } catch (e) {
      if (e?.code !== 'ENOENT') throw new Error(`지금 AD 설정(auth.json)을 읽지 못해(${String(e?.code || 'read-error').slice(0, 32)}) 복원하지 않았습니다 — 정책 카운터를 모른 채 되돌리지 않게 지금 파일을 그대로 둡니다`);
      cur = null;
    }
    const r = reconcileAdConfigText(content, cur);
    return r.bumped
      ? { content: r.text, info: { adPolicyEpochBumped: r.epoch }, warning: { file: name, reason: 'AD 정책 카운터를 지금보다 올려 적용했습니다 — 백업 이후 매핑을 바꿔 끝난 AD 세션이 되살아나지 않게 AD 계정은 모두 다시 로그인합니다.' } }
      : { content: r.text };
  }
  if (name === 'secrets-policy.json' || name === 'secrets-policy.trusted.json') {
    // 91회차: 읽기 오류를 '없음' 으로 보면 지금 암호화인 정책 파일(읽지 못함)을 평문 백업으로 덮었다 — 복원 뒤 로더는 읽히는 평문 정책을 쓴다(S-07 의 직전 · 신뢰 값 복구가
    //   닿지 않는다). 없음(재해 복구)만 백업 그대로, 읽기 오류면 이 파일만 적용하지 않는다.
    const cur = readCurrentOrThrow(configDir, name, '자격증명 저장 방식 정책');
    // 110회차(100회차 세션 보안의 형제 — 재현): 본 파일이 없거나 정책으로 읽히지 않으면(손상 보존으로 치워진 뒤 — 로더는 정책 파일을 스스로 다시 쓰지 않는다)
    //   돌고 있는 값은 **짝 파일**(신뢰 사본 ↔ 본 파일 — secretVault S-07)이다. 예전에는 이때 '없음' 으로 보고 평문 백업을 그대로 써, 신뢰 사본으로 돌던 암호화가
    //   OTP 없이 평문이 됐다(다음 기동이 그 평문 정책을 정상으로 읽고 신뢰 사본까지 평문으로 맞췄다). 짝 파일과 견준다(짝을 못 읽으면 이 파일만 적용하지 않는다).
    //   둘 다 정책이 아니면 예전과 같다(백업 그대로 — 재해 복구 · 잠금 상태의 판정은 정책 로더가 맡는다).
    const polText = (t) => { try { const j = JSON.parse(String(t)); return j && typeof j === 'object' && !Array.isArray(j) && (j.mode === 'plain' || j.mode === 'encrypted') ? t : null; } catch { return null; } };
    const sibling = name === 'secrets-policy.json' ? 'secrets-policy.trusted.json' : 'secrets-policy.json';
    const effective = polText(cur) ?? polText(readCurrentOrThrow(configDir, sibling, '자격증명 저장 방식 정책(짝 파일)')) ?? cur;
    const r = reconcileSecretsPolicyText(content, effective);
    return r.keptCurrent
      ? { content: r.text, info: { secretsPolicyKept: true }, warning: { file: name, reason: '백업은 자격증명 평문 저장이지만 지금은 암호화라 지금 방식을 유지했습니다 — 복원은 본인 OTP 를 묻지 않으므로 약하게 되돌리지 않습니다.' } }
      : { content: r.text };
  }
  if (name === 'bareos-groups.json') {
    // 110회차(91회차 R2 의 형제 — 재현): 읽기 오류를 '없음' 으로 보면 지금 회차 기록(lastKey)을 모른 채 백업의 묵은 기록으로 덮는다(이미 돈 회차를 다시 보낸다 — v2.830 S7).
    const cur = readCurrentOrThrow(configDir, name, 'Bareos 백업 그룹');
    const r = reconcileBareosGroupsText(content, cur);
    const out = { content: r.text, info: { bareosGroupSlotsKept: r.kept, bareosGroupKeepHeld: r.keepHeld.length } };
    // 114회차 F1: 보관 개수를 정하거나 줄이는 저장은 본인 OTP — 복원으로는 지워질 범위를 넓히지 않는다
    if (r.keepHeld.length) out.warning = { file: name, reason: `백업 판본의 보관 개수가 지금보다 오래된 백업을 더 지우게 되는 그룹 ${r.keepHeld.length}개(${r.keepHeld.slice(0, 5).join(', ')}${r.keepHeld.length > 5 ? ' …' : ''})는 보관 개수를 지금 값(없으면 제한 없음)으로 두었습니다 — 복원은 본인 OTP 를 묻지 않으므로 백업을 지우는 쪽으로 되돌리지 않습니다(줄이려면 백업 그룹 화면에서 본인 OTP 로 저장하세요).` };
    return out;
  }
  // ── 114회차(복원 대상 전수) ────────────────────────────────────────────────────────────────
  if (AUTH_STOPS_RE.test(name)) {
    const r = reconcileAuthStopsText(content, readCurrentOrThrow(configDir, name, '인증 실패 정지 기록'));
    return { content: r.text, info: { authStopsKept: r.keptStops } };
  }
  if (RESTORE_RUN_FIELDS_CURRENT.has(name)) {
    const r = reconcileRunFieldsText(content, readCurrentOrThrow(configDir, name, '설정(마지막 실행 기록 포함)'));
    return { content: r.text, info: { runFieldsKept: r.changed } };
  }
  if (name === 'vm-clone.json') {
    const r = reconcileVmCloneText(content, readCurrentOrThrow(configDir, name, 'VM 백업 잡'));
    return { content: r.text, info: { vmCloneRunsKept: r.keptRuns } };
  }
  if (name === 'host-access.json') {
    const r = reconcileHostAccessText(content, readCurrentOrThrow(configDir, name, '호스트 접근 제어 설정'));
    const out = { content: r.text, info: { hostAccessStateKept: r.keptState, hostAccessPendingDropped: r.droppedPending } };
    if (r.keptState || r.droppedPending) {
      const parts = [];
      if (r.keptState) parts.push('초안만 백업 판본으로 되돌리고 이 호스트의 방화벽 적용 기록(적용됨 · 확정 대기)은 지금 것을 그대로 두었습니다');
      if (r.droppedPending) parts.push('백업에 들어 있던 확정 대기는 되살리지 않았습니다');
      out.warning = { file: name, reason: `${parts.join(' · ')} — 복원은 방화벽을 바꾸지 않습니다(초안을 적용하려면 설정 › 호스트 접근 제어에서 본인 OTP 로 적용 · 확정하세요).` };
    }
    return out;
  }
  if (name === 'rma-schedules.json') {   // 110 결정 ①
    const r = reconcileRmaSchedulesText(content, readCurrentOrThrow(configDir, name, '원격 명령 점검 스케줄'));
    const out = { content: r.text, info: { rmaShellTestsDisabled: r.disabled } };
    if (r.disabled) out.warning = { file: name, reason: `외부 스크립트 · SSH 점검 ${r.disabled}개는 지금 같은 내용으로 켜져 있지 않아 꺼진 채로 복원했습니다 — 이 점검을 넣거나 고치는 것은 설정 소유자 + 본인 OTP 라 복원으로 다시 돌리지 않습니다(특수 기능 › 원격 명령에서 본인 OTP 로 다시 켜세요).` };
    return out;
  }
  if (name === 'credentials.json') {   // 110 결정 ②
    const r = reconcileCredentialsText(content, readCurrentOrThrow(configDir, name, '통합 계정'));
    const out = { content: r.text, info: { credentialsDropped: r.dropped, credentialsNarrowed: r.narrowed } };
    // 120회차(반증): 빠져나갈 길을 '새 서버로 옮기는 중' 에만 적어, 실수로 지운 계정(비밀을 다시 알 수 없는 경우)을 되살리려는 운영자가 길이 없다고 읽었다 —
    //   같은 방법(지금 파일을 치우고 다시 복원)이 그 경우에도 통하고, 그때 잃는 것(백업 뒤에 등록 · 고친 계정)을 함께 밝힌다.
    if (r.dropped || r.narrowed) out.warning = { file: name, reason: `백업 이후 지운 통합 계정 ${r.dropped}개는 되살리지 않았고, 사용 범위(법인 · 대상)가 지금보다 넓은 계정 ${r.narrowed}개는 좁은 쪽 범위로 두었습니다 — 계정 등록 · 범위 변경은 본인 OTP 라 복원으로 넓히지 않습니다(필요하면 통합 계정 관리에서 다시 등록 · 수정하세요. 실수로 지운 계정을 되살려야 하거나 새 서버로 옮기는 중이라 백업의 계정이 전부 필요하면 설정 디렉터리의 지금 credentials.json 을 치운 뒤 다시 복원하면 백업 그대로 들어갑니다 — 이때 백업 뒤에 등록 · 고친 계정은 백업 판본으로 바뀝니다).` };
    return out;
  }
  if (name === 'bareos-rehearsal.json') {   // 120회차(114 OPEN — 재현)
    const r = reconcileRehearsalText(content, readCurrentOrThrow(configDir, name, 'Bareos 복원 검증 정책'));
    const out = { content: r.text, info: { rehearsalHeldOff: r.heldOff, rehearsalHeldPerCorp: r.heldPerCorp } };
    if (r.heldOff) out.warning = { file: name, reason: '백업에는 복원 검증이 켜져 있었지만 지금은 꺼져 있어 꺼진 채로 복원했습니다 — 정책 저장은 본인 OTP 라 복원으로 다시 켜지 않습니다(Backup 현황 · Bareos 의 복원 검증 정책에서 본인 OTP 로 켜세요).' };
    else if (r.heldPerCorp) out.warning = { file: name, reason: '백업 판본의 복원 검증 대수(법인마다)가 지금보다 많아 지금 값으로 두었습니다 — 정책 저장은 본인 OTP 라 복원으로 늘리지 않습니다(Backup 현황 · Bareos 의 복원 검증 정책에서 본인 OTP 로 바꾸세요).' };
    return out;
  }
  // v3.9.0(반증 D5): SSH 키 저장소는 **적용 시점의 지금 파일**과 다시 합친다 — 예약 때 합친 값으로 쓰면 예약 뒤 본인 OTP 로 좁힌 폴더 · 기능 · 퇴역이
  //   되돌아가고, 예약 뒤 등록한 키(번들에 없음)는 개인키째 사라졌다. 합치는 규칙은 mergeRedactedKeyStore 하나(지금 키의 폴더 · 기능 · 상태 유지 · 번들에 없는 지금 키 남김).
  if (name === KEY_FILE_NAME) {
    let cur = '';
    try { cur = fs.readFileSync(path.join(configDir, name), 'utf8'); } catch (e) {
      // 79회차 반증(재현): 읽기 오류(EACCES · EIO)를 '없음' 으로 보고 합치면 번들의 키가 전부 빠진 파일이 지금 봉인본(유일한 사본)을 덮는다 —
      //   던져서 이 파일만 적용하지 않는다(applyStagedRestore 가 failed 로 남긴다 · 지금 파일 그대로).
      if (e?.code !== 'ENOENT') throw new Error(`지금 SSH 키 저장소를 읽지 못해(${String(e?.code || 'read-error').slice(0, 32)}) 복원하지 않았습니다 — 지금 파일(봉인본 — 유일한 사본)을 그대로 둡니다`);
      cur = '';
    }
    const m = mergeRedactedKeyStore(String(content), cur);
    return { content: m.text, info: { sshKeysKept: (m.kept || []).length, sshKeysDropped: (m.dropped || []).length } };
  }
  if (name !== 'users.json' && name !== 'central-agent-tokens.json') return { content };
  // 110회차(91회차 R2 의 형제 — 재현): 지금 파일의 **읽기 오류**(EACCES · EIO)를 '없음' 으로 보면 ① users.json 은 지금 세션 버전을 모른 채 백업 값 + 1 을 써
  //   그 사이에 폐기한 세션(버전이 두 번 이상 오른 계정의 중간 버전 토큰)이 되살아날 수 있고 ② 엣지 토큰은 백업 이후 폐기한 토큰을 전부 되살리고 다시 발급한 토큰을 잃는다
  //   (원자 쓰기는 읽지 못한 원본도 대체한다). 없음(ENOENT — 재해 복구)만 예전대로, 읽기 오류면 이 파일만 적용하지 않는다.
  const currentText = readCurrentOrThrow(configDir, name, name === 'users.json' ? '계정 파일' : '엣지 토큰 파일');
  if (name === 'users.json') {
    const r = reconcileUsersText(content, currentText);
    return { content: r.text, info: { tokenVersionBumped: r.bumped } };
  }
  const r = reconcileAgentTokensText(content, currentText);
  const out = { content: r.text, info: { agentTokensRevived: r.revived } };
  if (r.revived.length) {
    out.warning = { file: name, reason: `백업에만 있던 엣지 토큰 ${r.revived.length}개를 되살렸습니다(${r.revived.slice(0, 10).join(', ')}${r.revived.length > 10 ? ' …' : ''})${r.currentUnreadable ? ' — 현재 토큰 파일이 없거나 읽지 못했습니다' : ''}. 백업 이후 폐기한 토큰이면 엣지 토큰 화면에서 다시 폐기하세요.` };
  }
  return out;
}

const backupsDir = (configDir) => path.join(configDir, 'backups');
let _pending = null;   // 이 프로세스가 예약한 내용의 요약 { stagedAt, source, files:[이름] }
let _lastApply = null; // 이 프로세스 기동 때의 적용 결과

/**
 * JSON 설정 파일들을 다음 기동 때 적용하도록 예약한다(원자 쓰기 — 이미 예약된 것이 있으면 바꾼다).
 * @param {Record<string,string>} files { 이름: 내용 } — 호출부(restoreCentral)가 이름·확장자를 이미 걸렀어도 여기서 다시 검사한다.
 * @returns {{ stagedAt:number, files:string[], replaced:boolean, dropped:{file:string,reason:string}[] }}
 */
export function stageRestore(files, { configDir = resolveConfigDir(), source = null } = {}) {
  const clean = {};
  // v2.769(점검 R4-D1-3): 거른 이름과 사유를 돌려준다 — 예전엔 조용히 버려 복원 결과(failed·excluded) 어디에도 안 실렸다.
  const dropped = [];
  for (const [name, content] of Object.entries(files || {})) {
    const issue = stagedNameIssue(name);
    if (issue) { dropped.push({ file: String(name).slice(0, 200), reason: issue }); continue; }
    clean[name] = String(content);
  }
  const file = path.join(backupsDir(configDir), STAGED_NAME);
  const replaced = fs.existsSync(file);
  const stagedAt = Date.now();
  const src = typeof source === 'string' ? source.slice(0, 200) : null;
  atomicWriteFileSync(file, JSON.stringify({ v: 1, stagedAt, source: src, files: clean }), { mode: 0o600 });
  _pending = { stagedAt, source: src, files: Object.keys(clean) };
  return { stagedAt, files: Object.keys(clean), replaced, dropped };
}

/** 예약 취소. 예약이 없었으면 had:false. */
export function cancelStagedRestore({ configDir = resolveConfigDir() } = {}) {
  const file = path.join(backupsDir(configDir), STAGED_NAME);
  let had = false;
  try { fs.unlinkSync(file); had = true; } catch (e) { if (e?.code !== 'ENOENT') throw e; }
  _pending = null;
  return { ok: true, had };
}

function readLast(configDir) {
  const file = path.join(backupsDir(configDir), LAST_NAME);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    // 손상(파일 없음이 아님)은 옆으로 보존한다 — 다음 적용 기록이 덮기 전에 사람이 볼 수 있게(server/CLAUDE.md 로드 손상 보존 규칙).
    if (e?.code !== 'ENOENT') preserveCorrupt(file, e?.message || 'JSON');
    return null;
  }
}

/** 화면용 상태 — 예약(재시작 대기)·이번 기동의 적용 결과(없으면 마지막 기록)·중단된 적용 흔적. 예약 파일 본문은 읽지 않는다(20초 폴링). */
export function stagedRestoreStatus({ configDir = resolveConfigDir() } = {}) {
  const dir = backupsDir(configDir);
  let pending = null;
  try {
    const st = fs.statSync(path.join(dir, STAGED_NAME));
    pending = _pending ? { ..._pending, size: st.size } : { stagedAt: st.mtimeMs, source: null, files: null, size: st.size };
  } catch { pending = null; }
  const interrupted = fs.existsSync(path.join(dir, APPLYING_NAME));
  return { pending, last: _lastApply || readLast(configDir), interrupted };
}

function record(configDir, result) {
  _lastApply = result;
  try { atomicWriteFileSync(path.join(backupsDir(configDir), LAST_NAME), JSON.stringify(result), { mode: 0o600 }); }
  catch (e) { console.warn(`[backup] 예약 복원 결과 기록 실패: ${e?.code || e?.message || e}`); }
  return result;
}

/**
 * 기동 시 예약 복원 적용 — 던지지 않는다(기동을 막지 않는다). 예약이 없으면 null.
 * @returns {null | { at:number, ok:boolean, source:(string|null), stagedAt:(number|null), applied:string[], failed:{file,reason}[], rejected:{file,reason}[], warnings?:{file,reason}[], tokenVersionBumped?:number, agentTokensRevived?:number, reason?:string }}
 */
export function applyStagedRestore({ configDir = resolveConfigDir() } = {}) {
  const dir = backupsDir(configDir);
  const staged = path.join(dir, STAGED_NAME);
  const claim = path.join(dir, APPLYING_NAME);
  try {
    if (!fs.existsSync(staged)) return null;
    if (fs.existsSync(claim)) {
      // 앞 기동의 적용이 도중에 끊겼다 — 같은 내용을 또 적용하지 않는다(새 예약은 그 흔적을 치운 뒤에만).
      console.error(`[backup] 예약 복원을 적용하지 않습니다 — 이전 적용이 중단된 흔적(${APPLYING_NAME})이 있습니다. 확인 뒤 backups/ 의 두 파일을 정리하세요.`);
      return record(configDir, { at: Date.now(), ok: false, source: null, stagedAt: null, applied: [], failed: [], rejected: [], reason: 'interrupted' });
    }
    // 한 번만 적용 — 먼저 claim 으로 옮긴다. 옮기지 못하면 적용하지 않는다(매 기동 재적용 방지).
    fs.renameSync(staged, claim);
  } catch (e) {
    console.error(`[backup] 예약 복원 준비 실패(적용 안 함): ${e?.code || e?.message || e}`);
    return record(configDir, { at: Date.now(), ok: false, source: null, stagedAt: null, applied: [], failed: [], rejected: [], reason: String(e?.code || e?.message || e).slice(0, 200) });
  }
  let doc = null;
  try {
    const st = fs.statSync(claim);
    if (st.size > STAGED_MAX_BYTES) throw new Error(`예약 파일이 상한(${STAGED_MAX_BYTES}바이트)을 넘습니다`);
    doc = JSON.parse(fs.readFileSync(claim, 'utf8'));
    if (!doc || typeof doc !== 'object' || doc.v !== 1 || !doc.files || typeof doc.files !== 'object' || Array.isArray(doc.files)) throw new Error('예약 파일 형식이 아닙니다');
  } catch (e) {
    // 원문 조각(JSON.parse 메시지 — 설정 내용)은 싣지 않는다. 파일은 옆으로 치워 둔다(사람이 볼 수 있게).
    const reason = e instanceof SyntaxError ? 'JSON 형식 오류' : String(e?.message || e).slice(0, 200);
    try { fs.renameSync(claim, path.join(dir, `${STAGED_NAME}.bad-${Date.now()}`)); } catch { /* */ }
    console.error(`[backup] 예약 복원을 적용하지 않습니다 — ${reason}`);
    return record(configDir, { at: Date.now(), ok: false, source: null, stagedAt: null, applied: [], failed: [], rejected: [], reason });
  }
  const applied = []; const failed = []; const rejected = []; const warnings = [];
  const kept = [];   // 114회차: 지금 파일을 그대로 둔 실행 기록 [{file, reason}] — 조용히 빼지 않는다(적용 수가 예약 수보다 적은 까닭)
  let tokenVersionBumped = 0; let agentTokensRevived = [];
  for (const [name, content] of Object.entries(doc.files)) {
    const issue = stagedNameIssue(name);
    if (issue || typeof content !== 'string') { rejected.push({ file: String(name).slice(0, 200), reason: issue || '내용이 문자열이 아님' }); continue; }
    try {
      // v2.769(점검 R4-D1-2): 폐기 상태 파일은 현재 파일과 맞춘 내용을 쓴다(위 reconcileForApply).
      const rc = reconcileForApply(name, content, configDir);
      if (rc.keep) { kept.push({ file: name, reason: rc.keep }); continue; }
      atomicWriteFileSync(path.join(configDir, name), rc.content); applied.push(name);
      if (rc.warning) warnings.push(rc.warning);
      if (rc.info?.tokenVersionBumped) tokenVersionBumped = rc.info.tokenVersionBumped;
      if (rc.info?.agentTokensRevived) agentTokensRevived = rc.info.agentTokensRevived;
    } catch (e) { failed.push({ file: name, reason: String(e?.code || e?.message || e).slice(0, 200) }); }
  }
  try { fs.unlinkSync(claim); } catch (e) { console.warn(`[backup] 예약 복원 파일 정리 실패(다시 적용하지는 않음): ${e?.code || e?.message || e}`); }
  const source = typeof doc.source === 'string' ? doc.source.slice(0, 200) : null;
  const stagedAt = Number.isFinite(doc.stagedAt) ? doc.stagedAt : null;
  const ok = failed.length === 0 && rejected.length === 0;
  const line = `[backup] 예약된 복원 적용${source ? `(${source})` : ''}: ${applied.length}개 파일${failed.length ? ` · 실패 ${failed.length}개(${failed.map((f) => `${f.file}: ${f.reason}`).join(', ').slice(0, 400)})` : ''}${rejected.length ? ` · 거부 ${rejected.length}개` : ''}${kept.length ? ` · 실행 기록 ${kept.length}개는 지금 파일 유지` : ''}`;
  if (ok) console.log(line); else console.warn(line);
  if (tokenVersionBumped) console.log(`[backup] 예약 복원: 계정 ${tokenVersionBumped}개의 세션 버전을 올렸습니다 — 백업 이후 폐기한 세션이 되살아나지 않게 모든 사용자가 다시 로그인해야 합니다.`);
  for (const w of warnings) console.warn(`[backup] 예약 복원 경고 — ${w.file}: ${w.reason}`);
  return record(configDir, { at: Date.now(), ok, source, stagedAt, applied, failed, rejected, warnings, kept, tokenVersionBumped, agentTokensRevived: agentTokensRevived.length });
}

/** 테스트 전용 — 모듈 메모리 초기화. */
export function _resetStagedRestoreState() { _pending = null; _lastApply = null; }
