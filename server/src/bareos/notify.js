/**
 * bareos/notify.js — Bareos 백업 실패 알림 메일(v2.822, 메일 종류 'bareos-backup').
 *
 * 사용자 요청(2026-10-30 '프로그램 개선' — 백업 실패 알림 메일): Bareos 실행이 오류·경고로 끝나도 화면을 열기 전에는 몰랐다.
 * 모양은 vmclone/notify.js(VM 백업 실패 메일)를 따른다 — 공용 메일 경로(sendPortalMail)·1분 틱·대상별 커서·첫 실행은 '지금부터'.
 *
 * 동작(중앙 전용 — 엣지는 기동하지 않는다. SMTP 설정은 중앙에 있다):
 *  · 1분마다 백업 대상 원장(bareos-jobs.json)을 본다 — 폴러가 Director 카탈로그로 갱신한 lastRun·restores 를 읽기만 한다(Director 에 닿지 않는다).
 *  · 알리는 것: 끝난(T·W·E·f·A…) 백업 실행 중 **오류·경고**, 끝난 복원 중 **오류**. 취소(A)는 사람이 한 일이라 알리지 않는다.
 *  · 커서는 대상마다 **jobid**(Bareos 가 단조 증가로 매긴다) — 카탈로그 시각은 Director 현지 시각이고 시간대가 없어 기준으로 쓰지 않는다.
 *    처음 보는 대상은 포탈 시계로 기록한 checkedAt 이 since(이 기능을 처음 켠 시각) 이후일 때만 알린다 — 업그레이드하자마자 지난 실패를 쏟지 않는다.
 *  · 끝나지 않은 실행(R·C…)으로는 커서를 옮기지 않는다 — 같은 jobid 가 나중에 오류로 끝나도 알린다.
 *  · 보내지 못하면(수신자 없음·SMTP 오류) 커서를 옮기지 않는다(다음 틱 재시도 — 메일 서비스의 속도 제한·인증 정지가 폭주를 막는다).
 *    메일이 꺼져 있거나 이 종류가 꺼져 있으면 옮긴다(나중에 켰을 때 쌓인 실패를 한꺼번에 보내지 않게).
 *  · 데모(mock) 인벤토리·데모 대상(demo:true)은 보내지 않는다.
 * 한계(정직 기록): Bareos 스케줄이 돌린 실행은 폴러의 대조 틱(기본 10틱 — 약 10분)마다 '대상별 최신 1건' 만 원장에 들어온다 —
 *   그 사이에 같은 대상이 두 번 실패하면 최신 1건만 알린다. 포탈이 시작한 실행은 pending 으로 따로 추적하고 끝난 실행 목록(finishedRuns)에
 *   남아 빠지지 않는다(v2.822.3 C2-2 — 그 전에는 더 큰 jobid 가 lastRun 이면 빠졌다).
 *
 * v2.885 '원인' 칸(2026-11-04 사용자 선택 — 메일만 보고 원인을 알게): 보내기 전에 실패 · 경고로 끝난 **백업** 실행의 첫 오류 줄을
 *   v2.872 묶음 로그(ops.logs — Director 마다 한 번 · 엣지 대행 · 이 잡의 실행인지 확인)로 읽어 줄 + 해석(issueHints.js — 웹과 같은 표)을 싣는다.
 *   · 읽기는 trigger 'timer'(인증 정지된 Director 에 닿지 않는다 — 자동 재시도 금지) · Director 마다 LOGS_MAX · 한 통 CAUSE_MAX 까지 · 시한 LOGS_DEADLINE_MS.
 *   · 못 읽어도 메일은 보낸다(원인 칸에 '못 읽음 — 사유'). 원인을 지어내지 않는다 — 첫 오류 줄이 없으면 '오류 줄 없음'(0 이 아니라 없음).
 *   · 복원 행은 읽지 않는다(묶음 로그는 백업 잡 이름으로 그 실행인지 확인한다 — 복원 잡은 이름이 달라 거부된다).
 *   · 읽은 원인은 상태 파일 causes 에 남겨(CAUSE_KEEP) 다시 보내기 · 일일 요약(digest.js cachedCause)이 Director 에 다시 묻지 않고 쓴다.
 * 상태 파일: CONFIG_DIR/bareos-mail-state.json → { since, runs: { <대상 id>: jobid(커서) }, seen: { <대상 id>: [커서보다 큰 판정한 jobid] },
 *   restores: { <대상 id>: jobid }, causes: { '<Director id>:<jobid>': { line, at } }, history: [...] } (비밀 없음)
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { store } from '../store.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { sendPortalMail } from '../mail/service.js';
import { load as loadMailCfg } from '../mail/settings.js';
import { localStamp } from '../util/dayKey.js';
import { listJobs, registryLoadError, MAX_JOBS } from './registry.js';
import { loadSettings, directorById, jobDirectorId, settingsLoadError } from './settings.js';
import { isFinalStatus } from './names.js';
import { onDirector } from './service.js';
import { LOGS_MAX } from './ops.js';
import { issueHint } from './issueHints.js';

export const MAIL_KIND = 'bareos-backup';
export const TICK_MS = 60_000;
const MAX_ROWS = 50;
// v2.847 D2-4(2회차 점검 — 재현): 원장 상한(MAX_JOBS 3,000)보다 작으면(예전 2,000) 재시작마다 밀려난 대상의 커서가 사라져 같은 실패를 다시 알렸다.
//   원장 밖 키는 tick 이 지우므로 원장 상한 + 여유면 넘치지 않는다.
const KEYS_MAX = MAX_JOBS + 500;
const HISTORY_MAX = 30;
const LEVEL = { F: 'Full', I: 'Incremental', D: 'Differential' };
/** v2.885 한 통에 원인을 읽는 실행 수 상한(Director 마다는 LOGS_MAX) · 남겨 두는 원인 수 · 줄 길이. */
export const CAUSE_MAX = 30;
const CAUSE_KEEP = 400;
const CAUSE_LINE_MAX = 400;
/** v2.885 반증 M3: 메일 전용 읽기 시한 — 화면 묶음 로그의 LOGS_DEADLINE_MS(엣지 인출 + 회신 — 기본 7분)를 기다리면 느린 법인 하나가 전 법인 메일을 늦췄다. */
export const CAUSE_DEADLINE_MS = 120_000;
/** 원인 기록이 유효한 기간(반증 M1 — 오래된 기록은 쓰지 않는다) · 못 읽음 기억(반증 M2 — 메일이 나가지 못하는 동안 같은 행을 매 분 다시 묻지 않는다). */
export const CAUSE_TTL_MS = 7 * 86_400_000;
export const MISS_TTL_MS = 30 * 60_000;
// 반증 L1: 엣지 회신 문자열은 줄바꿈 · 양방향 제어 문자를 남긴다 — 글 본문에 가짜 행을 만들지 않게 공백으로
const oneLine = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, max);

registerStateFile('bareos-mail-state.json');
const FILE = () => path.join(config.configDir, 'bareos-mail-state.json');   // ⚠ 리터럴 형태 유지 — scripts/config-doc.mjs 가 이 모양으로 찾는다
const isEdge = () => !!(config.agent.centralUrl && config.agent.centralToken);
const isMock = () => store.get()?.source === 'mock';

// v2.822.3(C2-11·P2-9): 넘치면 **최근** 키를 남긴다(예전에는 앞의 2,000개 — 오래된 것만 남아 최근 대상이 재시작마다 같은 실패를 다시 받았다)
const numMap = (o) => {
  const out = {};
  for (const [k, v] of Object.entries(o && typeof o === 'object' && !Array.isArray(o) ? o : {}).slice(-KEYS_MAX)) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0) out[k] = n;
  }
  return out;
};
const SEEN_KEEP = 50;
const seenMap = (o) => {
  const out = {};
  for (const [k, v] of Object.entries(o && typeof o === 'object' && !Array.isArray(o) ? o : {}).slice(-KEYS_MAX)) {
    if (Array.isArray(v)) out[k] = v.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(-SEEN_KEEP);
  }
  return out;
};

/**
 * v2.885 원인 기록 — 키 'Director id:원장 세대(runsEpoch · 없으면 0):jobid' · 값 { line: 첫 오류 줄(없으면 null — 읽었는데 오류 줄이 없다), job: 잡 이름, at }.
 * 반증 M1(재현): 키가 'Director:jobid' 뿐이면 재설치(카탈로그를 지워 jobid 가 1 부터)로 같은 번호를 받은 다른 VM 에 옛 원인이 붙었다 —
 * 세대를 키에 넣고, 쓸 때는 잡 이름이 같고 CAUSE_TTL_MS 안일 때만 쓴다. 넘치면 최근 것을 남긴다.
 */
const CAUSE_KEY_RE = /^[A-Za-z0-9._-]{1,80}:\d{1,15}:\d{1,12}$/;
const JOB_RE = /^[A-Za-z0-9._-]{1,128}$/;
const causeKey = (dir, epoch, jobid) => `${dir}:${Number(epoch) || 0}:${jobid}`;
const causeMap = (o) => {
  const out = {};
  for (const [k, v] of Object.entries(o && typeof o === 'object' && !Array.isArray(o) ? o : {}).slice(-CAUSE_KEEP)) {
    if (!CAUSE_KEY_RE.test(k) || !v || typeof v !== 'object' || !JOB_RE.test(String(v.job || ''))) continue;
    out[k] = { line: typeof v.line === 'string' ? oneLine(v.line, CAUSE_LINE_MAX) : null, job: String(v.job), at: Number(v.at) || 0 };
  }
  return out;
};
/** 기록이 이 행에 쓸 만한가(잡 이름 · 기한). */
const usable = (c, jobName, now) => !!c && c.job === jobName && now - (Number(c.at) || 0) < CAUSE_TTL_MS;

let _state = null;
function state() {
  if (_state) return _state;
  try {
    if (fs.existsSync(FILE())) {
      const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('형식 오류');
      _state = { since: Number(raw.since) || Date.now(), runs: numMap(raw.runs), seen: seenMap(raw.seen), restores: numMap(raw.restores), epochs: numMap(raw.epochs), causes: causeMap(raw.causes), history: (Array.isArray(raw.history) ? raw.history : []).slice(0, HISTORY_MAX) };
      return _state;
    }
  } catch { preserveCorrupt(FILE()); }
  // 처음(또는 손상) — 지금부터 센다. 기준 시각을 바로 남긴다(첫 발송이 실패한 채 재시작해도 since 가 밀리지 않게).
  _state = { since: Date.now(), runs: {}, seen: {}, restores: {}, epochs: {}, causes: {}, history: [] };
  save();
  return _state;
}
function save() {
  try { atomicWriteFileSync(FILE(), JSON.stringify(state()), { mode: 0o600 }); }
  catch (e) { console.warn(`[bareos] 실패 메일 상태를 저장하지 못했습니다(${e?.message || e})`); }
}

/**
 * 끝난 실행의 판정(순수): { advance: 커서를 이 jobid 로 옮기는가, alert: 알릴 대상인가 }.
 * 끝나지 않은 실행은 둘 다 아니다. 커서가 있으면 그보다 큰 jobid 만 · 커서가 없으면(처음 보는 대상) 커서는 옮기되 알림은
 * 포탈 시계로 적은 checkedAt 이 since 이후일 때만(지난 실패를 쏟지 않는다).
 */
function judge(rec, mark, since) {
  const id = Number(rec?.jobid) || 0;
  if (!id || !isFinalStatus(rec?.status)) return { advance: false, alert: false };
  if (mark) return id > mark ? { advance: true, alert: true } : { advance: false, alert: false };
  return { advance: true, alert: (Number(rec.checkedAt) || Number(rec.at) || 0) > since };
}

/**
 * 새로 알릴 줄 모으기(순수 — 테스트 고정).
 * @param {object[]} jobs  registry.listJobs() 결과
 * @param {{since:number, runs:Record<string,number>, restores:Record<string,number>}} st
 * @returns {{ rows: object[], marks: { runs: Record<string,number>, restores: Record<string,number> } }}
 *   marks: 대상마다 새로 본 '끝난' 실행의 가장 큰 jobid(알릴 것이 없어도 옮긴다 — 성공·취소로 커서 전진)
 */
export function collectBareosFailures(jobs, st) {
  const rows = [];
  const marks = { runs: {}, seen: {}, restores: {}, epochs: {} };
  const since = Number(st?.since) || 0;
  for (const j of jobs || []) {
    if (!j || j.demo) continue;
    // v2.822.3(C2-2 — 재현): lastRun 하나만 보면 포탈이 시작한 실행이 끝날 때 더 큰 jobid(대기 중인 스케줄 실행)가 lastRun 이라 그 실패가 빠졌다.
    //   끝난 실행 목록(registry finishedRuns)과 lastRun 을 jobid 순으로 보고, 판정한 jobid 는 seen 에 둔다. 커서(floor)는 진행 중인
    //   포탈 실행 앞에서 멈춘다(그 실행이 나중에 끝나도 커서보다 커서 판정된다).
    // v2.846 D-1: 원장이 이 대상의 실행 기록을 새로 시작했으면(재설치 뒤 다시 등록 — jobid 가 1 부터) 커서 · seen · 복원 커서를 지운다.
    //   지운 뒤 첫 판정은 '처음 보는 대상' 규칙(포탈 시계 since 이후만 알림 — 지난 실패를 쏟지 않는다)
    const epoch = Number(j.runsEpoch) || 0;
    const reset = epoch > 0 && (Number(st?.epochs?.[j.id]) || 0) !== epoch;
    if (reset) { marks.epochs[j.id] = epoch; marks.runs[j.id] = 0; marks.seen[j.id] = []; marks.restores[j.id] = 0; }
    const floor = reset ? 0 : Number(st?.runs?.[j.id]) || 0;
    const seen = new Set(!reset && Array.isArray(st?.seen?.[j.id]) ? st.seen[j.id] : []);
    const byId = new Map();
    for (const x of [...(Array.isArray(j.finishedRuns) ? j.finishedRuns : []), j.lastRun]) if (x?.jobid && !byId.has(Number(x.jobid))) byId.set(Number(x.jobid), x);
    let maxJudged = 0; const judged = [];
    for (const [jid, r] of [...byId].sort((a, b) => a[0] - b[0])) {
      if (seen.has(jid)) continue;
      const jr = judge(r, floor, since);
      if (!jr.advance) continue;
      maxJudged = Math.max(maxJudged, jid); judged.push(jid);
      if (jr.alert && (r.state === 'error' || r.state === 'warning')) {
        rows.push({ kind: 'backup', state: r.state, status: r.status, jobid: jid, at: Number(r.checkedAt) || 0, ended: r.endedAt || null,
          level: LEVEL[r.level] || '', jobName: j.bareosJob, vmName: j.vmName, vcenterId: j.vcenterId, directorId: j.directorId || '', client: j.client || '', errors: r.errors ?? null, epoch: epoch });
      }
    }
    if (maxJudged) {
      const inflight = Number(j.pending?.jobid) || 0;
      const newFloor = inflight && inflight < maxJudged ? Math.max(floor, inflight - 1) : Math.max(floor, maxJudged);
      if (newFloor !== floor) marks.runs[j.id] = newFloor;
      const keep = [...seen, ...judged].filter((x) => x > newFloor).sort((a, b) => a - b).slice(-SEEN_KEEP);
      if (keep.length || seen.size) marks.seen[j.id] = keep;
    }
    const restMark = reset ? 0 : Number(st?.restores?.[j.id]) || 0;
    let restMax = 0;
    for (const x of Array.isArray(j.restores) ? j.restores : []) {
      const jx = judge(x, restMark, since);
      if (!jx.advance) continue;
      restMax = Math.max(restMax, Number(x.jobid));
      if (jx.alert && x.state === 'error') {
        rows.push({ kind: 'restore', state: 'error', status: x.status, jobid: Number(x.jobid), at: Number(x.checkedAt) || Number(x.at) || 0, ended: x.endedAt || null,
          level: '', jobName: j.bareosJob, vmName: j.vmName, vcenterId: j.vcenterId, directorId: j.directorId || '', client: x.client || j.client || '', mode: x.mode || '', errors: null });
      }
    }
    if (restMax) marks.restores[j.id] = restMax;
  }
  rows.sort((a, b) => a.at - b.at || a.jobid - b.jobid);
  return { rows, marks };
}

/**
 * v2.885 실패 · 경고 백업 행에 첫 오류 줄을 붙인다(행을 고친다). 기록(causes)에 있으면 다시 읽지 않는다.
 * @param {object[]} rows collectBareosFailures 의 rows
 * @param {(row:object) => string} dirOf 행 → Director id
 * @param {{ causes: object, misses?: Map<string,{reason:string,at:number}>, read: (dirId:string, items:object[]) => Promise<object[]>, now?: number }} o
 *   read 는 Director 하나의 묶음 로그 회신({ key, ok, firstError, code, message }[]) — 던지면 그 Director 의 행은 '못 읽음'.
 *   misses: 못 읽은 행의 기억(MISS_TTL_MS 안이면 다시 묻지 않는다 — 반증 M2).
 * @returns {Promise<{ asked: number, read: number, failed: number }>}
 */
export async function attachCauses(rows, dirOf, { causes, misses = new Map(), read, now = Date.now() }) {
  const byDir = new Map();
  let budget = CAUSE_MAX;
  for (const r of rows) {
    if (r.kind !== 'backup') continue;
    const dir = String(dirOf(r) || '');
    const key = causeKey(dir, r.epoch, r.jobid);
    if (dir && usable(causes[key], r.jobName, now)) { r.cause = { line: causes[key].line }; continue; }
    if (!dir) { r.causeMiss = 'Director 를 알 수 없습니다'; continue; }
    const m = misses.get(key);
    if (m && now - m.at < MISS_TTL_MS) { r.causeMiss = m.reason; continue; }
    const list = byDir.get(dir) || [];
    if (budget <= 0 || list.length >= LOGS_MAX) { r.causeMiss = '한 통에 읽는 상한 밖 — 포탈에서 확인하세요'; continue; }
    budget -= 1; list.push(r); byDir.set(dir, list);
  }
  const stat = { asked: 0, read: 0, failed: 0 };
  await Promise.all([...byDir.entries()].map(async ([dir, list]) => {
    stat.asked += list.length;
    let res = null;
    try { res = await read(dir, list.map((r, k) => ({ key: k, jobid: r.jobid, name: r.jobName }))); }
    catch (e) {
      const why = oneLine(e?.message || e || '읽지 못했습니다', 160);
      for (const r of list) { r.causeMiss = why; misses.set(causeKey(dir, r.epoch, r.jobid), { reason: why, at: now }); }
      stat.failed += list.length; return;
    }
    const byKey = new Map((Array.isArray(res) ? res : []).map((x) => [x?.key, x]));
    list.forEach((r, k) => {
      const x = byKey.get(k);
      const key = causeKey(dir, r.epoch, r.jobid);
      if (!x || !x.ok) { r.causeMiss = oneLine(x?.message || 'Director 회신에 이 실행이 없습니다', 160); misses.set(key, { reason: r.causeMiss, at: now }); stat.failed += 1; return; }
      const line = typeof x.firstError === 'string' && x.firstError ? oneLine(x.firstError, CAUSE_LINE_MAX) : null;
      r.cause = { line };
      causes[key] = { line, job: String(r.jobName || ''), at: now };
      misses.delete(key);
      stat.read += 1;
    });
  }));
  for (const [k, c] of Object.entries(causes)) if (now - (Number(c?.at) || 0) >= CAUSE_TTL_MS) delete causes[k];
  const keys = Object.keys(causes);
  if (keys.length > CAUSE_KEEP) for (const k of keys.slice(0, keys.length - CAUSE_KEEP)) delete causes[k];
  for (const [k, m] of misses) if (now - m.at >= MISS_TTL_MS) misses.delete(k);
  return stat;
}

/** v2.885 원인 칸 글(순수) — { text, hint }. 읽지 않은 행(복원)은 '—'. */
export function causeText(r) {
  if (r?.cause) return r.cause.line ? { text: r.cause.line, hint: issueHint(r.cause.line) } : { text: '오류 줄 없음(로그에 Fatal error · Error 줄이 없습니다)', hint: '' };
  if (r?.causeMiss) return { text: `못 읽음 — ${r.causeMiss}`, hint: '' };
  return { text: '—', hint: '' };
}

/** v2.885 일일 요약용 — 실패 메일이 읽어 둔 원인(없으면 null · 읽었는데 오류 줄이 없으면 { line: null }). Director 에 묻지 않는다 · 세대 · 잡 이름 · 기한이 맞을 때만. */
export function cachedCause(dirId, jobid, { epoch = 0, jobName = '', now = Date.now() } = {}) {
  const c = state().causes?.[causeKey(dirId, epoch, jobid)];
  return usable(c, jobName, now) ? { line: c.line } : null;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const RESTORE_MODE = { original: '원래 VM 덮어쓰기', newVm: '새 VM', localVmdk: 'FD 로컬 VMDK' };
const what = (r) => (r.kind === 'restore' ? `복원(${RESTORE_MODE[r.mode] || '—'})` : `백업${r.level ? ` ${r.level}` : ''}`);
const result = (r) => `${r.state === 'warning' ? '경고' : '오류'} · ${r.status || '?'}`;

/**
 * 메일 본문(순수). 값은 전부 esc · 인라인 스타일 · 포탈 링크 없음(메뉴 경로를 글로 적는다).
 * v2.823: 법인 Director 열 — dirName(row) 가 그 행의 Director 이름('' 이면 '—').
 */
export function renderBareosMail(rows, vcName = (id) => id, dirName = () => '') {
  const shown = rows.slice(0, MAX_ROWS);
  const more = rows.length - shown.length;
  const vms = [...new Set(rows.map((r) => r.vmName))];
  const nWarn = rows.filter((r) => r.state === 'warning').length;
  const nErr = rows.length - nWarn;
  const head = [nErr ? `실패 ${nErr}건` : '', nWarn ? `경고 ${nWarn}건` : ''].filter(Boolean).join(' · ');
  const subject = `[Bareos 백업] ${head} — ${vms.slice(0, 3).join(', ')}${vms.length > 3 ? ` 외 ${vms.length - 3}` : ''}`;
  const td = (v, extra = '') => `<td style="padding:4px 8px${extra}">${v}</td>`;
  // v2.885 원인 칸: 첫 오류 줄(고정폭) + 해석(→) — 줄이 길어도 표가 옆으로 끝없이 늘지 않게 칸 너비 상한
  const causeCell = (r) => { const c = causeText(r); return td(`<span style="font-family:monospace;font-size:11.5px">${esc(c.text)}</span>${c.hint ? `<br><span style="color:#475569">→ ${esc(c.hint)}</span>` : ''}`, ';max-width:520px;word-break:break-word'); };
  const tr = shown.map((r) => `<tr>${td(esc(r.at ? localStamp(r.at) : '—'), ';white-space:nowrap')}${td(esc(dirName(r) || '—'))}${td(esc(vcName(r.vcenterId)))}${td(`<b>${esc(r.vmName)}</b>`)}${td(esc(what(r)))}${td(esc(result(r)))}${causeCell(r)}${td(esc(r.jobid))}${td(esc(r.jobName))}${td(esc(r.client || '—'))}</tr>`).join('');
  const th = ['확인 시각', '법인 Director', 'vCenter', 'VM', '종류', '결과', '원인(첫 오류 줄)', 'jobid', 'Bareos 잡', '사이트 FD'].map((h) => `<th style="padding:4px 8px">${h}</th>`).join('');
  const html = `<div style="font-family:sans-serif;font-size:13px">`
    + `<p>Bareos VM 백업에서 확인이 필요한 실행이 ${rows.length}건 있습니다(${head}). 작업 로그는 포탈 › Backup 현황 › Bareos(특수 기능 › Backup 현황 · Bareos)의 백업 대상 표 '로그' 에서 볼 수 있습니다.</p>`
    + `<table style="border-collapse:collapse;font-size:12.5px" border="1" cellspacing="0"><thead><tr style="background:#f1f5f9">${th}</tr></thead><tbody>${tr}</tbody></table>`
    + (more > 0 ? `<p>그 밖에 ${more}건은 메일에 싣지 않았습니다 — 포탈에서 확인하세요.</p>` : '')
    + `<p style="color:#64748b">확인 시각은 포탈이 결과를 읽은 시각입니다. 이 메일은 설정 › 메일 발송의 'Bareos 백업 실패' 종류로 보냈습니다. 같은 1분 확인 주기의 항목은 한 통으로 묶습니다.</p></div>`;
  const text = [`Bareos 백업 ${head}`, ...shown.map((r) => { const c = causeText(r); return [[r.at ? localStamp(r.at) : '—', dirName(r) || '—', vcName(r.vcenterId), r.vmName, what(r), result(r), `jobid ${r.jobid}`, r.jobName].join(' · '), `  원인: ${c.text}`, ...(c.hint ? [`  → ${c.hint}`] : [])].join('\n'); }), ...(more > 0 ? [`그 밖에 ${more}건`] : [])].join('\n');
  return { subject, html, text };
}

/**
 * v2.908 백업 실패 구독(이슈 자동 등록 — issues/alertIssues.js). 새로 판정한 실패 행(백업 · 복원)을 준다 — 메일 발송 여부 · 커서와 무관하게
 * 판정한 그 틱에 한 번(메일이 실패해 다음 틱에 같은 행이 다시 오면 구독자가 jobid 로 거른다). 이 모듈이 이슈를 모르게 한다.
 */
const _failListeners = new Set();
export function onBareosFailures(fn) { if (typeof fn === 'function') _failListeners.add(fn); return () => _failListeners.delete(fn); }

let _busy = false;
let _timer = null;
let _last = null;   // { at, sent, rows, reason }

export async function tick(now = Date.now()) {
  if (_busy || isMock()) return;
  _busy = true;
  try {
    const st = state();
    const jobs = listJobs();   // v2.847 C2-4: 원장 깊은 복사는 틱마다 한 번(예전 두 번 — 두 번째는 id 만 썼다)
    const { rows, marks } = collectBareosFailures(jobs, st);
    if (rows.length && _failListeners.size) for (const fn of _failListeners) { try { fn(rows.map((r) => ({ ...r })), now); } catch { /* 구독자 오류는 메일과 무관 */ } }
    const advance = () => {
      Object.assign(st.runs, marks.runs); Object.assign(st.restores, marks.restores); st.epochs = Object.assign(st.epochs || {}, marks.epochs);
      st.seen = st.seen || {};
      for (const [k, v] of Object.entries(marks.seen || {})) { if (v.length) st.seen[k] = v; else delete st.seen[k]; }
      save();
    };
    // C2-11: 원장에서 지운 대상의 커서는 정리한다(원장을 읽었을 때만 — 손상으로 빈 목록이면 지우면 안 된다)
    if (!registryLoadError()) {
      const ids = new Set(jobs.map((j) => j.id));
      let pruned = false;
      for (const m of [st.runs, st.restores, st.seen || {}, st.epochs || {}]) for (const k of Object.keys(m)) if (!ids.has(k)) { delete m[k]; pruned = true; }
      if (pruned) save();
    }
    const moved = Object.keys(marks.runs).length + Object.keys(marks.restores).length + Object.keys(marks.seen || {}).length + Object.keys(marks.epochs || {}).length;
    if (!rows.length) { if (moved) advance(); return; }   // 성공·취소만 새로 끝났다 — 커서만 옮긴다
    const cfg = loadMailCfg();
    if (!cfg?.enabled || cfg?.kinds?.[MAIL_KIND]?.enabled === false) { advance(); _last = { at: now, sent: false, rows: rows.length, reason: '메일 발송 또는 이 종류가 꺼져 있습니다' }; return; }
    const names = new Map((store.get()?.vcenters || []).map((v) => [String(v.id), v.name || v.id]));
    let settings = null;
    try { settings = loadSettings(); } catch { /* 이름만 비운다 */ }
    const dirName = (r) => (settings ? directorById(jobDirectorId(r, settings), settings)?.name || '' : '');
    // v2.885 원인 칸 — 못 읽어도 보낸다(원인 칸에 사유). 메일에 싣는 행만 읽는다(반증 L2).
    //   반증 L6: loadSettings 는 던지지 않고 빈 설정을 준다 — 설정 파일 손상이면 Director 를 모르므로 묻지 않고 그 사유를 적는다
    st.causes = st.causes || {};
    const shownRows = rows.slice(0, MAX_ROWS);
    let setErr = null; try { setErr = settingsLoadError(); } catch { setErr = true; }
    if (setErr) { for (const r of shownRows) if (r.kind === 'backup') r.causeMiss = 'Bareos 설정(Director 등록부)을 읽지 못했습니다'; }
    else {
      try { await attachCauses(shownRows, (r) => jobDirectorId(r, settings), { causes: st.causes, misses: _misses, now, read: _readCauses }); }
      catch { /* 원인 칸만 비운다 */ }
    }
    const m = renderBareosMail(rows, (id) => names.get(String(id)) || id, dirName);
    const r = await sendPortalMail({ kind: MAIL_KIND, subject: m.subject, html: m.html, text: m.text, by: 'system' });
    _last = { at: now, sent: !!r?.ok, rows: rows.length, ...(r?.ok ? {} : { reason: String(r?.reason || '발송 실패').slice(0, 200) }) };
    if (r?.ok) {
      advance();
      st.history.unshift({ at: now, rows: rows.length, subject: m.subject.slice(0, 200) });
      st.history.splice(HISTORY_MAX);
      save();
    }
    // 실패면 커서를 옮기지 않는다 — 다음 틱에 같은 줄을 다시 보낸다.
  } catch (e) {
    _last = { at: now, sent: false, rows: 0, reason: String(e?.message || e).slice(0, 200) };
  } finally { _busy = false; }
}

/** 마지막 틱 결과(화면 없음 — 테스트·진단용. 발송 이력은 설정 › 메일 발송이 말한다). */
export function bareosMailStatus() { return _last ? { ..._last } : null; }

export function startBareosMail() {
  if (_timer || isEdge()) return;
  _timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  _timer.unref?.();
}

// v2.885 묶음 로그 읽기(Director 하나) — 주기 작업이라 trigger 'timer'(인증 정지된 Director 에 닿지 않는다) · 메일 전용 시한(반증 M3)
const readCausesReal = (dirId, items) => onDirector(dirId, 'logs', { items }, { trigger: 'timer', signal: AbortSignal.timeout(CAUSE_DEADLINE_MS) });
let _readCauses = readCausesReal;
const _misses = new Map();   // 못 읽음 기억(메모리 — 재시작하면 다시 묻는다)
export function _setCauseReaderForTest(fn) { _readCauses = fn || readCausesReal; }

export function _resetForTest() { _state = null; _busy = false; _last = null; _misses.clear(); }
