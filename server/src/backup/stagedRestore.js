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
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

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
]);
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

/** 적용할 내용을 현재 파일과 맞춘다 — 대상이 아니면 그대로. @returns {{ content:string, warning?:{file,reason}, info?:object }} */
export function reconcileForApply(name, content, configDir) {
  if (name !== 'users.json' && name !== 'central-agent-tokens.json') return { content };
  let currentText = null;
  try { currentText = fs.readFileSync(path.join(configDir, name), 'utf8'); } catch { currentText = null; }
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
  let tokenVersionBumped = 0; let agentTokensRevived = [];
  for (const [name, content] of Object.entries(doc.files)) {
    const issue = stagedNameIssue(name);
    if (issue || typeof content !== 'string') { rejected.push({ file: String(name).slice(0, 200), reason: issue || '내용이 문자열이 아님' }); continue; }
    try {
      // v2.769(점검 R4-D1-2): 폐기 상태 파일은 현재 파일과 맞춘 내용을 쓴다(위 reconcileForApply).
      const rc = reconcileForApply(name, content, configDir);
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
  const line = `[backup] 예약된 복원 적용${source ? `(${source})` : ''}: ${applied.length}개 파일${failed.length ? ` · 실패 ${failed.length}개(${failed.map((f) => `${f.file}: ${f.reason}`).join(', ').slice(0, 400)})` : ''}${rejected.length ? ` · 거부 ${rejected.length}개` : ''}`;
  if (ok) console.log(line); else console.warn(line);
  if (tokenVersionBumped) console.log(`[backup] 예약 복원: 계정 ${tokenVersionBumped}개의 세션 버전을 올렸습니다 — 백업 이후 폐기한 세션이 되살아나지 않게 모든 사용자가 다시 로그인해야 합니다.`);
  for (const w of warnings) console.warn(`[backup] 예약 복원 경고 — ${w.file}: ${w.reason}`);
  return record(configDir, { at: Date.now(), ok, source, stagedAt, applied, failed, rejected, warnings, tokenVersionBumped, agentTokensRevived: agentTokensRevived.length });
}

/** 테스트 전용 — 모듈 메모리 초기화. */
export function _resetStagedRestoreState() { _pending = null; _lastApply = null; }
