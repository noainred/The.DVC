/**
 * bareos/ops.js — Director 에 닿는 일의 **작업 표**(v2.823 법인별 Director).
 *
 * 각 작업은 `(session, args, { signal }) → 결과` 이고 Director 쪽 판단만 한다(원장·범위·OTP·감사는 부르는 쪽 — service.js·라우트·폴러).
 * 같은 표를 2차 릴리스의 엣지 대행(법인 엣지가 자기 Director 에 실행)도 그대로 쓴다 — 그래서 인자는 직렬화할 수 있는 값만 받고,
 * 원장 객체·함수를 넘기지 않는다. 명령 문자열은 지금처럼 director.js·names.js 관문만 조립한다.
 *
 *  - `MUTATING`: Director 상태를 바꾸는 작업(엣지 대행에서 회신이 없으면 '결과 모름' — 다시 보내지 않는다).
 */
import { BareosConsoleError } from './console.js';
import {
  probe, catalogLists, addJob as directorAddJob, runJob, jobStatus, jobStates, recentJobs, setJobEnabled, cancelJob, jobHistory, jobRuns, jobLog, runRestore,
} from './director.js';
import { jobNameFor, isFinalStatus, isResourceName } from './names.js';
import { chainFromHistory, chainIssue } from './restore.js';

const fail = (code, msg) => new BareosConsoleError(code, msg);
const invalid = (msg) => { const e = new Error(msg); e.code = 'invalid'; return e; };

/** 세션째 쓸 수 없게 된 오류(이후 VM 도 같은 이유로 실패한다) — 일괄 등록이 여기서 멈춘다. */
export const SESSION_DEAD = new Set(['closed', 'timeout', 'aborted', 'protocol', 'too-large', 'connect', 'tls', 'auth', 'pam', 'blocked']);

/** 같은 이름이 있으면 접미사(r2…r5)로 다시 — 옛 잡(지운 대상의 비활성 잡)의 옵션은 바뀌었을 수 있어 '입양' 하지 않는다. */
async function addOne(s, it) {
  for (const sfx of ['', 'r2', 'r3', 'r4', 'r5']) {
    const name = jobNameFor(it.vcenterId, it.moref, sfx);
    if (!name) throw fail('invalid', 'VM 관리 id(moref)로 잡 이름을 만들 수 없습니다.');
    const r = await directorAddJob(s, { ...it.base, name });
    if (!r.exists) return r;
  }
  throw fail('invalid', '같은 VM 의 Bareos 잡이 Director 에 이미 여러 개 있습니다 — Director 의 bareos-dir.d/job 아래 pv-… 파일을 정리한 뒤 다시 시도하세요.');
}

export const OPS = Object.freeze({
  /** 접속 확인(배너·버전·클라이언트). */
  probe: (s) => probe(s),
  /** 매핑 드롭다운 원천(.clients·.storages·.pools·.schedules·.jobdefs·.filesets). */
  catalog: (s) => catalogLists(s),

  /**
   * 잡 만들기(일괄·단건) — 세션 하나로 순차. 한 대의 실패가 나머지를 막지 않고, 세션째 끊기면(SESSION_DEAD) 남은 것은 '건너뜀'.
   * @param {{ items: { key, vcenterId, moref, base }[] }} a
   * @returns {Promise<{ key, ok, name?, code?, message? }[]>}
   */
  async addJobs(s, { items = [] } = {}) {
    const out = [];
    let dead = '';
    for (const it of items) {
      if (dead) { out.push({ key: it.key, ok: false, code: 'skipped', message: `건너뜀 — ${dead}` }); continue; }
      try {
        const r = await addOne(s, it);
        out.push({ key: it.key, ok: true, name: r.name });
      } catch (e) {
        out.push({ key: it.key, ok: false, code: e?.code || 'error', message: String(e?.message || e).slice(0, 300) });
        if (SESSION_DEAD.has(e?.code)) dead = `Director 연결 문제로 멈췄습니다(${e.code})`;
      }
    }
    return out;
  },

  /** 잡 끄기(원장 기록 실패한 고아 잡 정리) — 이름마다 결과. */
  async disableJobs(s, { names = [] } = {}) {
    const out = [];
    for (const name of names) {
      if (!isResourceName(name)) { out.push({ name, ok: false }); continue; }
      try { await setJobEnabled(s, name, false); out.push({ name, ok: true }); } catch (e) {
        out.push({ name, ok: false });
        if (SESSION_DEAD.has(e?.code)) break;
      }
    }
    return out;
  },

  runJob: (s, { job, level }) => runJob(s, { job, level }),
  setEnabled: (s, { name, enabled }) => setJobEnabled(s, name, !!enabled),
  history: (s, { name, limit }) => jobHistory(s, name, limit),

  /**
   * 취소 — 이 잡의 실행(jobid)만. 포탈이 추적 중인 실행을 Director 가 모르면(재시작·다른 Director — P5) { cleared } 로 추적만 내리게 한다.
   * 이미 끝난 실행이면 { final: row } (부르는 쪽이 결과를 원장에 반영하고 '이미 끝남' 을 알린다).
   */
  async cancel(s, { jobid, name, pendingJobid }) {
    const row = await jobStatus(s, jobid);
    if (!row && jobid === pendingJobid) return { cleared: true };
    if (!row || row.name !== name) throw invalid('이 대상의 실행이 아닙니다.');
    if (isFinalStatus(row.status)) return { final: row };
    await cancelJob(s, jobid);
    return { canceled: true };
  },

  /**
   * 작업 로그 + 그 실행의 상태 행. 백업 실행은 잡 이름이 맞아야 한다(범위 계정이 다른 잡 로그를 읽지 못하게).
   * 복원은 상태를 못 읽어도(명령 거부) 로그는 보여 준다.
   */
  async log(s, { jobid, name, isRestore }) {
    let row = null;
    if (!isRestore) {
      row = await jobStatus(s, jobid);
      if (!row || row.name !== name) throw invalid('이 대상의 실행이 아닙니다.');
    } else {
      try { row = await jobStatus(s, jobid); } catch (e) { if (e?.code !== 'jsonrpc') throw e; }
    }
    return { log: await jobLog(s, jobid), row };
  },

  /**
   * 복원 — 고른 jobid 가 이 잡의 성공한 백업(T·W, type B)인지 Director 에서 확인 → 체인은 **이 잡의 이력으로만**(v2.822 S1) → restore.
   * @returns {Promise<{ rid: number, chain: number[] }>}
   */
  async restore(s, { jobid, name, client, restoreJob, pluginOptions }) {
    const row = await jobStatus(s, jobid);
    if (!row || row.name !== name || row.type !== 'B' || !(row.state === 'ok' || row.state === 'warning')) throw invalid('고른 jobid 는 이 대상의 성공한 백업이 아닙니다.');
    const runs = (await jobRuns(s, name)).filter((r) => !r.name || r.name === name);
    const chain = chainFromHistory(runs, jobid);
    const ci = chainIssue(chain, jobid);
    if (ci) throw invalid(ci);
    const rid = await runRestore(s, { client, jobids: chain, restoreJob, pluginOptions });
    return { rid, chain };
  },

  /**
   * 상태 조회 한 번(폴러) — Director 쪽 일만 한다. 원장 반영은 부르는 쪽.
   *  ① work: 포탈이 시작한 실행의 행(llist). 한 건의 명령 거부(jsonrpc)는 그 건만 건너뛴다(C5).
   *  ② reconcile: `.jobs`(이름 → enabled) + 최근 2일 실행 행. 원장에서 꺼 둔 잡이 Director 에서 켜져 있으면 다시 끈다
   *     (disable 은 Director 메모리 값이라 reload·재시작이면 다시 켜진다 — I3).
   * v2.823 검토(C1·P1 — 재현): 세션째 오류(시한 'aborted'·끊김)는 **던지지 않고** 그때까지 읽은 행과 함께 `fault` 로 돌려준다 —
   *   던지면 읽은 행이 원장에 하나도 반영되지 않고 회전도 멈춰, 대기 실행이 많은 고RTT 법인이 매 틱 같은 앞부분만 다시 읽었다(라이브락).
   *   `attempted` = 시작한 항목 수(멈춘 항목 포함 — 걸린 한 건이 뒤를 굶기지 않게 회전은 이만큼 나아간다).
   * v2.823 검토(P3 — 재현): 다시 끌 이름은 `.jobs` 를 읽은 **뒤** `hooks.disableNow(states)` 로 그 순간의 원장에서 고른다(중앙 직접).
   *   틱 시작 사본으로 고르면 그사이 사용자가 다시 켠 잡을 Director 에서 꺼 스케줄 백업이 조용히 멈췄다. hooks 가 없으면(엣지 대행) 인자 목록.
   * @returns {Promise<{ rows, attempted, states?, recent?, redisabled, itemErrors, cut, reconciled, fault? }>}
   */
  async poll(s, { work = [], reconcile = false, disableIfEnabled = [], recent = true } = {}, { signal, disableNow } = {}) {
    const rows = [];
    let itemErrors = 0;
    let attempted = 0;
    let fault = null;
    const stop = (e) => { fault = { code: e?.code || 'error', message: String(e?.message || e).slice(0, 300) }; };
    for (const w of work) {
      if (signal?.aborted) break;
      attempted += 1;
      try { rows.push({ jobid: w.jobid, row: await jobStatus(s, w.jobid) }); } catch (e) {
        if (e?.code === 'jsonrpc') { itemErrors += 1; continue; }
        stop(e); break;
      }
    }
    const cut = !!fault || attempted < work.length || !!signal?.aborted;
    const base = { rows, attempted, itemErrors, redisabled: [], reconciled: false, ...(fault ? { fault } : {}) };
    if (!reconcile || cut) return { ...base, cut };
    let states;
    let recentRows;
    try {
      states = await jobStates(s);
      recentRows = recent ? await recentJobs(s, 2) : [];
    } catch (e) { stop(e); return { ...base, fault, cut: true }; }
    const redisabled = [];
    let rcut = false;
    let names = disableIfEnabled;
    if (typeof disableNow === 'function') { try { names = disableNow(states) || []; } catch { names = []; } }
    for (const name of names) {
      if (signal?.aborted) { rcut = true; break; }
      if (states.get(name) !== true) continue;
      try { await setJobEnabled(s, name, false); redisabled.push(name); } catch (e) {
        if (e?.code === 'jsonrpc') { itemErrors += 1; continue; }
        stop(e); rcut = true; break;
      }
    }
    // `.jobs`·최근 행은 읽었다 — 대조 반영(사라진 잡·스케줄 실행)은 한다. 다시 끄기가 잘렸으면 cut(다음 틱에 이어서).
    return { rows, attempted, states: [...states], recent: recentRows, redisabled, itemErrors, cut: rcut, reconciled: true, ...(fault ? { fault } : {}) };
  },
});

/** Director 상태를 바꾸는 작업. */
export const MUTATING = Object.freeze(new Set(['addJobs', 'disableJobs', 'runJob', 'setEnabled', 'cancel', 'restore', 'poll']));
