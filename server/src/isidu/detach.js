/**
 * isidu/detach.js — 아이실론에서 du 를 **분리 실행**한다(v2.737, 사용자 선택 '③ 아이실론 분리 실행').
 *
 * 왜: du 는 수십 분 걸릴 수 있고 SSH 세션에 묶여 돌았다 — 포탈이 업그레이드로 재시작하면 세션이 끊기며 du 도 함께 끝나 그 조사가 통째로 사라졌다.
 *   이제 du 를 장비에서 `nohup` 으로 띄워 세션과 떼고, 결과를 장비의 임시 파일에 남긴다. 포탈은 같은 세션에서 끝날 때까지 상태를 묻고,
 *   재시작으로 끊기면 다음 기동이 작업 id(실행 중 스캔 기록 — util/scanJournal)로 **같은 작업에 다시 붙어** 결과를 받는다.
 *
 * ── 장비에 남기는 것(정직 기록) ─────────────────────────────────────────────────
 *  · 디렉터리 `/tmp/dvc-isidu-<uid>`(권한 700 — umask 077) 아래 작업 파일 6개: <id>.out(du 출력) · .err(오류 줄) · .rc(종료코드) · .pid(감싼 셸) ·
 *    .dpid(du) · .rc.tmp(종료코드를 원자적으로 쓰기 위한 임시). 결과를 받으면 **그 작업 파일을 지운다**. 받지 못한 작업의 파일은 다음 실행이
 *    2일 지난 것을 지운다(`find -mtime +2`). 디렉터리가 이 계정 소유가 아니거나 심볼릭 링크면 분리 실행을 하지 않는다(다른 계정이 만든 경로에 쓰지 않는다).
 *  · 포탈 쪽 시한에 걸리면 장비의 du 를 **멈춘다**(kill — v2.417 '시한은 세션을 실제로 끊는다' 의 분리 실행 판). 포탈이 재시작으로 끝날 때는
 *    멈추지 않는다(그것이 이 기능의 목적이다).
 *  · 분리 실행을 시작하지 못하면(nohup 없음·/tmp 쓰기 불가·셸 차이) **예전처럼 세션에 묶어 실행**한다(`attached-fallback` + 사유) — 개선이 퇴행이 되지 않게.
 *  · ⚠ 실장비 OneFS 에서 확인하지 못했다 — 명령은 POSIX sh 만 쓴다(`sh -c` 로 감싸 로그인 셸이 zsh·csh 여도 같은 문법이 되게 한다).
 *    `nohup`·`kill -0`·`find -mtime`·`mv`·`head -c` 는 FreeBSD 기본 도구다.
 *
 * ── 규칙 ────────────────────────────────────────────────────────────────────
 *  · 셸에 넣는 값은 우리가 만든 작업 id([A-Za-z0-9_-])와 du 명령(경로는 settings.pathIssue 가 작은따옴표·$·백틱·역슬래시를 금지한다)뿐이다.
 *    작은따옴표로 감쌀 때는 `shq` 하나를 쓴다('"'"' 이스케이프 — 중첩해도 깨지지 않는다).
 */
import crypto from 'node:crypto';
import { duCommand } from './parse.js';

export const DETACH_BASE = '/tmp/dvc-isidu';
export const JOB_RE = /^[A-Za-z0-9_-]{1,80}$/;
export const POLL_MIN_MS = 3_000;
export const POLL_MAX_MS = 15_000;
/** v2.740 A-03: 상태 출력을 연속으로 못 읽으면 실패로 끊는 횟수. */
export const UNKNOWN_MAX = 3;

/** 작은따옴표 인용(POSIX). */
export const shq = (s) => `'${String(s).replace(/'/g, `'"'"'`)}'`;

/** 새 작업 id — 대상 id(RE_ID) + 시각 + 난수. 셸에 그대로 들어가므로 형식을 지킨다. */
export function newJobId(targetId) {
  const base = String(targetId || 't').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 't';
  return `${base}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

const dirExpr = `"${DETACH_BASE}-$(id -u)"`;
const jobVar = (jobId) => {
  if (!JOB_RE.test(String(jobId || ''))) throw new Error('작업 id 형식이 잘못됐습니다');
  return `J=${dirExpr}/${jobId}`;
};

/** 분리 실행 시작 명령 — 성공하면 `DVC-STARTED <pid>` 한 줄을 낸다. */
export function startCommand(t, jobId) {
  const du = duCommand(t.path, t.sizeMode);
  // du 를 백그라운드로 두고 그 pid 를 남긴 뒤 기다린다 — 종료코드를 .rc.tmp 에 쓰고 mv 로 바꿔(반쯤 쓴 rc 를 읽지 않게).
  const job = `${du} > "$1.out" 2> "$1.err" & echo $! > "$1.dpid"; wait $!; echo $? > "$1.rc.tmp" && mv "$1.rc.tmp" "$1.rc"`;
  const inner = [
    'umask 077',
    `D=${dirExpr}`,
    'mkdir -p "$D" 2>/dev/null',
    'if [ -L "$D" ] || [ ! -d "$D" ] || [ ! -O "$D" ]; then echo "DVC-NODIR"; exit 4; fi',
    'find "$D" -type f -mtime +2 -exec rm -f {} + 2>/dev/null',
    jobVar(jobId),
    'rm -f "$J.out" "$J.err" "$J.rc" "$J.rc.tmp" "$J.pid" "$J.dpid"',
    // ⚠ `&` 는 그 자체가 명령 끝이다 — 뒤에 '; ' 를 붙이면 `&;` 가 되어 POSIX sh 문법 오류다(초판이 그랬고 실제 셸 테스트가 잡았다 —
    //   분리 실행이 언제나 실패해 세션에 묶은 실행으로 떨어졌다). 줄바꿈으로 잇지 않는 것은 csh 로그인 셸이 따옴표 안 줄바꿈을 거부해서다.
    `nohup sh -c ${shq(job)} dvc "$J" < /dev/null > /dev/null 2>&1 & P=$!`,
    'echo "$P" > "$J.pid"',
    'echo "DVC-STARTED $P"',
  ].join('; ');
  return `sh -c ${shq(inner)}`;
}

/** 상태 명령 — DVC-DONE <rc> · DVC-RUNNING · DVC-GONE(pid 는 있는데 프로세스도 결과도 없음) · DVC-NONE(작업 파일 없음). */
export function statusCommand(jobId) {
  // ⚠ v2.787.1: 프로세스가 없다고 본 **뒤에** rc 를 한 번 더 본다 — 작업 셸은 rc 를 mv 로 만든 다음 끝나므로, 첫 rc 확인과 kill -0 사이에
  //   작업이 끝나면 정상 완료를 GONE 으로 오판했다(CI 간헐 실패 — 고아를 바로 거두는 환경에서만 드러난다). 이 재확인을 빼지 말 것.
  const inner = `${jobVar(jobId)}; if [ -f "$J.rc" ]; then echo "DVC-DONE $(cat "$J.rc")"; elif [ -f "$J.pid" ] && kill -0 "$(cat "$J.pid")" 2>/dev/null; then echo DVC-RUNNING; elif [ -f "$J.rc" ]; then echo "DVC-DONE $(cat "$J.rc")"; elif [ -f "$J.pid" ]; then echo DVC-GONE; else echo DVC-NONE; fi`;
  return `sh -c ${shq(inner)}`;
}
export const readOutCommand = (jobId) => `sh -c ${shq(`${jobVar(jobId)}; cat "$J.out"`)}`;
export const readErrCommand = (jobId) => `sh -c ${shq(`${jobVar(jobId)}; head -c 65536 "$J.err" 2>/dev/null`)}`;
export const cleanupCommand = (jobId) => `sh -c ${shq(`${jobVar(jobId)}; rm -f "$J.out" "$J.err" "$J.rc" "$J.rc.tmp" "$J.pid" "$J.dpid"`)}`;
/** 작업 멈춤(du 와 감싼 셸 둘 다) + 파일 정리. */
export const killCommand = (jobId) => `sh -c ${shq(`${jobVar(jobId)}; for f in "$J.dpid" "$J.pid"; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; done; rm -f "$J.out" "$J.err" "$J.rc" "$J.rc.tmp" "$J.pid" "$J.dpid"`)}`;

/** 상태 출력 해석(순수). */
export function parseStatus(stdout) {
  const s = String(stdout || '');
  const d = /DVC-DONE\s+(-?\d+)/.exec(s);
  if (d) return { state: 'done', rc: Number(d[1]) };
  if (/DVC-RUNNING/.test(s)) return { state: 'running' };
  if (/DVC-GONE/.test(s)) return { state: 'gone' };
  if (/DVC-NONE/.test(s)) return { state: 'none' };
  return { state: 'unknown', raw: s.trim().slice(0, 200) };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || new Error('aborted')); return; }
    const h = setTimeout(() => { signal?.removeEventListener?.('abort', on); resolve(); }, ms);
    const on = () => { clearTimeout(h); reject(signal.reason || new Error('aborted')); };
    signal?.addEventListener?.('abort', on, { once: true });
  });
}

/**
 * 한 세션 안에서 분리 실행 → 끝날 때까지 상태 확인 → 결과 받기 → 정리.
 * @param {object} api withSsh 가 준 세션(exec)
 * @param {object} t 실행 정보
 * @param {{cmdMs:number, attachJob?:string|null, onJob?:(job:{id:string})=>void, signal?:AbortSignal, started?:number, now?:()=>number, pollMinMs?:number}} o
 * @returns {Promise<{x:{stdout:string, stderr:string, code:number|null}, mode:'detached'|'attached-fallback', attached:boolean, jobId:string|null, detachFallback?:string}>}
 *   던지는 오류에는 `jobId` 가 붙는다(호출부가 시한 실패 때 작업을 멈출 수 있게).
 */
export async function runDetached(api, t, { cmdMs, attachJob = null, onJob = null, signal = null, started = Date.now(), now = () => Date.now(), pollMinMs = POLL_MIN_MS } = {}) {
  const deadline = started + Math.max(10_000, Number(cmdMs) || 0);
  let jobId = attachJob && JOB_RE.test(String(attachJob)) ? String(attachJob) : null;
  let attached = false;
  if (jobId) {
    const st = parseStatus((await api.exec(statusCommand(jobId), 20_000)).stdout);
    if (st.state === 'done' || st.state === 'running') attached = true;
    else jobId = null; // 끝난 흔적이 없다(재부팅·정리) — 새로 시작한다
  }
  if (!jobId) {
    const id = newJobId(t.id);
    const s = await api.exec(startCommand(t, id), 20_000);
    const m = /DVC-STARTED\s+(\d+)/.exec(s?.stdout || '');
    if (!m) {
      // 분리 실행을 못 한다 — 예전처럼 세션에 묶어 실행한다(사유를 남긴다).
      const why = /DVC-NODIR/.test(s?.stdout || '') ? `임시 디렉터리(${DETACH_BASE}-<uid>)를 이 계정 소유로 만들 수 없습니다`
        : (String(s?.stderr || s?.stdout || '').trim().split('\n')[0] || `종료코드 ${s?.code ?? '?'}`).slice(0, 200);
      const left = Math.max(10_000, deadline - now());
      const x = await api.exec(duCommand(t.path, t.sizeMode), left, { long: true });
      return { x, mode: 'attached-fallback', attached: false, jobId: null, detachFallback: why };
    }
    jobId = id;
    try { onJob?.({ id: jobId }); } catch { /* 기록 실패는 조사를 막지 않는다 */ }
  }
  let delay = pollMinMs;
  let rc = null;
  let unknownRun = 0;
  try {
    for (;;) {
      const st = parseStatus((await api.exec(statusCommand(jobId), 20_000)).stdout);
      if (st.state === 'done') { rc = st.rc; break; }
      if (st.state === 'gone') throw new Error('장비에서 du 작업이 결과 없이 끝났습니다(장비 재시작·강제 종료 가능성)');
      if (st.state === 'none') throw new Error('장비에서 du 작업 파일을 찾지 못했습니다(/tmp 정리 가능성)');
      // v2.740 A-03: 상태 명령은 표지 넷 중 하나를 반드시 찍는다 — 연속으로 못 읽으면 셸·출력이 깨진 것이다.
      // 예전에는 시한(최대 3시간)까지 '진행 중' 으로 매달렸다. 장비의 작업은 멈추고 원문을 사유로 남긴다.
      if (st.state === 'unknown') {
        if (++unknownRun >= UNKNOWN_MAX) {
          await api.exec(killCommand(jobId), 20_000).catch(() => {});
          throw new Error(`du 작업 상태를 ${UNKNOWN_MAX}번 연속 읽지 못했습니다 — 장비의 du 작업을 멈췄습니다(상태 출력: ${st.raw || '빈 출력'})`);
        }
      } else unknownRun = 0;
      if (now() + delay > deadline) {
        await api.exec(killCommand(jobId), 20_000).catch(() => {});
        throw new Error(`du 시한 초과(${Math.round((deadline - started) / 60_000)}분) — 장비의 du 작업을 멈췄습니다`);
      }
      await sleep(delay, signal);
      delay = Math.min(POLL_MAX_MS, delay * 2);
    }
    const out = await api.exec(readOutCommand(jobId), 120_000);
    const err = await api.exec(readErrCommand(jobId), 30_000);
    await api.exec(cleanupCommand(jobId), 20_000).catch(() => {});
    return { x: { stdout: out?.stdout || '', stderr: err?.stdout || '', code: rc }, mode: 'detached', attached, jobId };
  } catch (e) {
    if (e && typeof e === 'object') e.jobId = jobId;
    throw e;
  }
}
