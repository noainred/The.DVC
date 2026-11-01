/**
 * bareos/ops.js — Director 에 닿는 일의 **작업 표**(v2.823 법인별 Director).
 *
 * 각 작업은 `(session, args, { signal }) → 결과` 이고 Director 쪽 판단만 한다(원장·범위·OTP·감사는 부르는 쪽 — service.js·라우트·폴러).
 * 같은 표를 2차 릴리스의 엣지 대행(법인 엣지가 자기 Director 에 실행)도 그대로 쓴다 — 그래서 인자는 직렬화할 수 있는 값만 받고,
 * 원장 객체·함수를 넘기지 않는다. 명령 문자열은 지금처럼 director.js·names.js 관문만 조립한다.
 *
 *  - `MUTATING`: Director 상태를 바꾸는 작업(엣지 대행에서 회신이 없으면 '결과 모름' — 다시 보내지 않는다).
 */
import { BareosConsoleError, jsonRpcErrorText } from './console.js';
import {
  parseBanner, probe, catalogLists, addJob as directorAddJob, runJob, jobStatus, jobStates, recentJobs, setJobEnabled, cancelJob, jobHistory, jobRuns, jobLog, runRestore, deleteJobIds,
} from './director.js';
import { pruneSelection } from './groupRetention.js';
import { parseStatusRaw, parseDirStatusRaw, rawHead } from './liveParse.js';
import { jobNameFor, isFinalStatus, isResourceName } from './names.js';
import { chainFromHistory, chainIssue } from './restore.js';
import { POLICY_CMDS, POLICY_KEYS, NORMALIZE as POLICY_NORMALIZE, deniedText, normVolumeRows } from './policyParse.js';

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

/** v2.830 runJobs 한 번에 보내는 잡 수 상한 — 그룹 상한(groups.MAX_MEMBERS)을 부르는 쪽이 이 크기로 나눠 보낸다. */
export const RUN_JOBS_MAX = 50;
/** v2.833 진행 현황판 한 번에 묻는 FD 수(법인 하나 = 보통 FD 하나). */
export const LIVE_CLIENTS_MAX = 20;

export const OPS = Object.freeze({
  /** 접속 확인(배너·버전·클라이언트). */
  probe: (s) => probe(s),
  /** 매핑 드롭다운 원천(.clients·.storages·.pools·.schedule·.jobdefs·.filesets). */
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

  /**
   * v2.830 백업 그룹 실행 — 세션 하나로 순차(VM 마다 접속하지 않는다 — 고RTT 법인에서 TLS 왕복을 아낀다). 한 잡의 실패는 나머지를 막지 않고,
   * 세션째 끊기면(SESSION_DEAD) 남은 것은 '건너뜀'(보내지 않았다 — 실행되지 않았다). storage·pool 은 그 실행에만 쓰는 지정.
   * 옛 엣지는 이 작업 종류를 몰라 '알 수 없는 작업' 으로 거절한다(지정을 조용히 버리고 잡 기본 스토리지로 돌리는 일이 없다).
   * @param {{ items: { key:number, job:string, level:string, storage?:string, pool?:string }[] }} a
   * @returns {Promise<{ key, ok, jobid?, code?, message? }[]>}
   */
  async runJobs(s, { items = [] } = {}) {
    const out = [];
    let dead = '';
    for (const it of items.slice(0, RUN_JOBS_MAX)) {
      if (dead) { out.push({ key: it.key, ok: false, code: 'skipped', message: `건너뜀 — ${dead}` }); continue; }
      try {
        out.push({ key: it.key, ok: true, jobid: await runJob(s, { job: it.job, level: it.level, storage: it.storage || '', pool: it.pool || '' }) });
      } catch (e) {
        out.push({ key: it.key, ok: false, code: e?.code || 'error', message: String(e?.message || e).slice(0, 300) });
        if (SESSION_DEAD.has(e?.code)) dead = `Director 연결 문제로 멈췄습니다(${e.code})`;
      }
    }
    return out;
  },
  /**
   * v2.831 백업 그룹 보관 개수 정리 — 잡마다 이력을 읽고(groupRetention.pruneSelection — 체인 기준 Full 앞의 끝난 실행만) 지운 뒤 **다시 읽어**
   * 실제로 사라진 jobid 만 '지움' 으로 돌려준다(delete 응답 모양에 기대지 않는다). 세션 하나로 순차 · 세션째 끊기면 남은 것은 건너뜀.
   * 옛 엣지는 이 작업 종류를 몰라 '알 수 없는 작업' 으로 거절한다(아무것도 지우지 않는다).
   * @param {{ items: { key:number, job:string, keep:number, since?:number }[] }} a  since = 원장 잡 등록 시각(그보다 먼저 시작한 행은 지우지 않는다)
   * @returns {Promise<{ key, ok, deleted?:number[], kept?, good?, baseJobid?, baseAt?, reason?, more?, code?, message? }[]>}
   */
  async pruneJobs(s, { items = [] } = {}) {
    const out = [];
    let dead = '';
    for (const it of items.slice(0, RUN_JOBS_MAX)) {
      if (dead) { out.push({ key: it.key, ok: false, code: 'skipped', message: `건너뜀 — ${dead}` }); continue; }
      let sent = null;   // delete 를 보낸 jobid — 그 뒤 실패하면 '지웠는지 모름' 으로 돌려준다(반증 F4 — 감사에 남기게)
      try {
        if (!isResourceName(it.job)) throw invalid('잡 이름이 올바르지 않습니다.');
        const runs = (await jobRuns(s, it.job)).filter((r) => r.name === it.job);
        const sel = pruneSelection(runs, it.keep, it.job, { since: Number.isFinite(it.since) ? it.since : null });
        let deleted = [];
        if (sel.deletable.length) {
          sent = sel.deletable;
          await deleteJobIds(s, sel.deletable);
          const left = new Set((await jobRuns(s, it.job)).map((r) => r.jobid));
          deleted = sel.deletable.filter((id) => !left.has(id));
        }
        out.push({
          key: it.key, ok: true, deleted, kept: sel.kept, good: sel.good, baseJobid: sel.baseJobid, baseAt: sel.baseAt,
          ...(sel.reason ? { reason: sel.reason } : {}), ...(sel.more ? { more: sel.more } : {}),
          ...(deleted.length < sel.deletable.length ? { notDeleted: sel.deletable.length - deleted.length } : {}),
        });
      } catch (e) {
        out.push({ key: it.key, ok: false, code: e?.code || 'error', message: String(e?.message || e).slice(0, 300), ...(sent ? { sent } : {}) });
        if (SESSION_DEAD.has(e?.code)) dead = `Director 연결 문제로 멈췄습니다(${e.code})`;
      }
    }
    return out;
  },
  /**
   * v2.843 보관 정리 **미리 보기**(읽기 전용 — 사용자 원칙 '백업은 법인 로컬': 엣지 대행 법인은 그 엣지가 로컬 Director 에서 돌린다).
   * pruneJobs 와 **같은 입력(keep·since)·같은 판정(pruneSelection)** 으로 지울 개수만 센다 — `delete` 를 보내지 않는다(MUTATING 아님 · 시험이 고정).
   * 옛 엣지는 이 작업 종류를 몰라 '알 수 없는 작업'(보내지 않음)으로 돌려준다.
   * @param {{ items: { key:number, job:string, keep:number, since?:number }[] }} a
   * @returns {Promise<{ key, ok, would?:number, more?, kept?, good?, baseJobid?, baseAt?, reason?, code?, message? }[]>}
   */
  async prunePreview(s, { items = [] } = {}) {
    const out = [];
    let dead = '';
    for (const it of items.slice(0, RUN_JOBS_MAX)) {
      if (dead) { out.push({ key: it.key, ok: false, code: 'skipped', message: `건너뜀 — ${dead}` }); continue; }
      try {
        if (!isResourceName(it.job)) throw invalid('잡 이름이 올바르지 않습니다.');
        const runs = (await jobRuns(s, it.job)).filter((r) => r.name === it.job);
        const sel = pruneSelection(runs, it.keep, it.job, { since: Number.isFinite(it.since) ? it.since : null });
        out.push({
          key: it.key, ok: true, would: sel.deletable.length, kept: sel.kept, good: sel.good, baseJobid: sel.baseJobid, baseAt: sel.baseAt,
          ...(sel.reason ? { reason: sel.reason } : {}), ...(sel.more ? { more: sel.more } : {}),
        });
      } catch (e) {
        out.push({ key: it.key, ok: false, code: e?.code || 'error', message: String(e?.message || e).slice(0, 300) });
        if (SESSION_DEAD.has(e?.code)) dead = `Director 연결 문제로 멈췄습니다(${e.code})`;
      }
    }
    return out;
  },
  /**
   * v2.833 진행 현황판 — 실행 중 잡의 진행량·속도(FD 가 들고 있다 — 카탈로그는 끝나야 바이트를 채운다). FD 마다 `status client=` 하나(읽기 전용).
   * 원문 모양은 실환경 미확인(추정) — liveParse 가 평문·JSON 둘 다 받는다. FD 하나의 실패는 나머지를 막지 않고, 세션째 끊기면 남은 것은 건너뜀.
   * @param {{ clients: string[], director?: boolean }} a  director = `status director` 도(잡마다 Director 가 보는 상태 — v2.833.1)
   * @returns {Promise<{ clients: { client, ok, jobs?, raw?, code?, message? }[], director?: { ok, jobs?, raw?, code?, message? } }>}
   */
  async liveStatus(s, { clients = [], director = false } = {}) {
    const out = [];
    let dead = '';
    // `.api json` 에서 Director 가 거부하면(ACL·FD 없음) JSON-RPC 오류 객체가 온다 — 잡 0개 '성공' 으로 보지 않는다(시험 ④)
    const raw = async (cmd) => {
      const r = typeof s.callRaw === 'function' ? await s.callRaw(cmd, { timeoutMs: 30_000, maxBytes: 2 * 1024 * 1024 })
        : JSON.stringify({ result: await s.call(cmd) });
      const head = String(r || '').trimStart();
      if (head[0] === '{') { let j = null; try { j = JSON.parse(head); } catch { j = null; } if (j?.error) throw fail('jsonrpc', jsonRpcErrorText(j.error)); }
      return r;
    };
    // v2.833.1: Director 가 보는 잡 상태(실행 중 · 마운트 대기 · 동시 실행 상한 …) — 한 번(법인 FD 수와 무관) · 원문 머리는 진단용
    let dir = null;
    if (director) {
      try { const r = await raw('status director'); dir = { ok: true, jobs: parseDirStatusRaw(r), raw: rawHead(r) }; } catch (e) {
        dir = { ok: false, code: e?.code || 'error', message: String(e?.message || e).slice(0, 300) };
        if (SESSION_DEAD.has(e?.code)) dead = `Director 연결 문제로 멈췄습니다(${e.code})`;
      }
    }
    for (const c of (Array.isArray(clients) ? clients : []).slice(0, LIVE_CLIENTS_MAX)) {
      if (dead) { out.push({ client: String(c).slice(0, 64), ok: false, code: 'skipped', message: `건너뜀 — ${dead}` }); continue; }
      if (!isResourceName(c)) { out.push({ client: String(c).slice(0, 64), ok: false, code: 'invalid', message: 'FD 이름이 올바르지 않습니다.' }); continue; }
      try {
        const r = await raw(`status client=${c}`);
        out.push({ client: c, ok: true, jobs: parseStatusRaw(r), raw: rawHead(r) });
      } catch (e) {
        out.push({ client: c, ok: false, code: e?.code || 'error', message: String(e?.message || e).slice(0, 300) });
        if (SESSION_DEAD.has(e?.code)) dead = `Director 연결 문제로 멈췄습니다(${e.code})`;
      }
    }
    return { clients: out, ...(dir ? { director: dir } : {}) };
  },
  setEnabled: (s, { name, enabled }) => setJobEnabled(s, name, !!enabled),
  history: (s, { name, limit }) => jobHistory(s, name, limit),

  /**
   * v2.839 Director 정책 수집(백업 메뉴 개편 2차-a) — 읽기 전용 명령만(policyParse.POLICY_CMDS · MUTATING 아님).
   *   명령마다 따로 — 하나가 실패해도(권한 없음 · 옛 판) 나머지는 계속 · 세션째 끊기면 남은 것은 건너뜀 · 시한 신호면 남은 것은 시작하지 않는다.
   *   `llist pools` 를 거부하면 짧은 `list pools` 로 한 번 더(보존 · 상한 칸은 모름).
   * @param {{ keys?: string[] }} a 수집할 키(필수 3 + 켜 둔 선택 명령)
   * @returns {Promise<{ results:{ [key]: { ok, ms, value?, code?, message?, fallback? } }, version }>}
   */
  async policy(s, { keys = POLICY_KEYS } = {}, { signal } = {}) {
    const want = new Set((Array.isArray(keys) ? keys : []).filter((k) => POLICY_KEYS.includes(k)));
    const results = {};
    let dead = '';
    for (const c of POLICY_CMDS) {
      if (!want.has(c.key)) continue;
      if (!dead && signal?.aborted) dead = '시한이 지나 멈췄습니다';
      if (dead) { results[c.key] = { ok: false, code: 'skipped', message: `건너뜀 — ${dead}`, ms: 0 }; continue; }
      const t0 = Date.now();
      try {
        let v; let fallback = false;
        try { v = await s.call(c.cmd, { maxBytes: 16 * 1024 * 1024 }); } catch (e) {
          if (!c.fallback || e?.code !== 'jsonrpc') throw e;
          v = await s.call(c.fallback, { maxBytes: 16 * 1024 * 1024 }); fallback = true;
        }
        results[c.key] = { ok: true, ms: Date.now() - t0, value: POLICY_NORMALIZE[c.key](v), ...(fallback ? { fallback: true } : {}) };
      } catch (e) {
        const code = e?.code === 'jsonrpc' && deniedText(e?.message) ? 'denied' : String(e?.code || 'error');
        results[c.key] = { ok: false, code, message: String(e?.message || e).slice(0, 300), ms: Date.now() - t0 };
        if (SESSION_DEAD.has(e?.code)) dead = `Director 연결 문제로 멈췄습니다(${e.code})`;
      }
    }
    let version = '';
    try { version = parseBanner(s.info?.banner || '').version || ''; } catch { version = ''; }
    return { results, version };
  },

  /**
   * v2.840 '보존 · 풀' 탭의 볼륨 목록 즉시 조회(관리자 · 1분 1회는 라우트) — `list volumes pool=<풀>` 하나(읽기 전용 · MUTATING 아님).
   * 풀 이름은 names.js 관문(리소스 이름 모양)을 지난 것만 — 공백 · 따옴표가 든 이름은 거부(콘솔 명령에 그대로 넣는다).
   * @param {{ pool: string }} a @returns {Promise<{ rows, total, truncated }>}
   */
  async volumes(s, { pool } = {}) {
    if (!isResourceName(pool)) throw invalid('풀 이름이 올바르지 않습니다.');
    return normVolumeRows(await s.call(`list volumes pool=${pool}`, { maxBytes: 8 * 1024 * 1024 }));
  },

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
   *  ① reconcile(먼저 — v2.825.1 G7): `.jobs`(이름 → enabled) + 최근 2일 실행 행. 원장에서 꺼 둔 잡이 Director 에서 켜져 있으면 다시 끈다
   *     (disable 은 Director 메모리 값이라 reload·재시작이면 다시 켜진다 — I3).
   *  ② work: 포탈이 시작한 실행의 행(llist). 한 건의 명령 거부(jsonrpc)는 그 건만 건너뛴다(C5).
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
    // v2.825.1 버그 점검(G7 — 재현): 대조를 **먼저** 한다. 예전에는 work 를 다 읽어야만 대조해, 끝나지 않은 실행이 Director 예산보다 많은 동안
    //   매 틱 잘려(cut) `.jobs`·다시 끄기·스케줄 실행 반영이 계속 밀렸다(reload 로 다시 켜진 잡이 그대로 돌고 스케줄 실행 결과·실패 메일이 멈췄다).
    //   대조는 명령 2개 + 다시 끌 이름 수만큼이라 예산을 거의 쓰지 않는다. work 가 잘린 것은 회전(attempted)이 이어 간다(C1·P1).
    let states = null;
    let recentRows = [];
    const redisabled = [];
    let rcut = false;
    let reconciled = false;
    if (reconcile && !signal?.aborted) {
      try {
        states = await jobStates(s);
        recentRows = recent ? await recentJobs(s, 2) : [];
        reconciled = true;
      } catch (e) { stop(e); }
      if (reconciled) {
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
      }
    }
    if (!fault) {
      for (const w of work) {
        if (signal?.aborted) break;
        attempted += 1;
        try { rows.push({ jobid: w.jobid, row: await jobStatus(s, w.jobid) }); } catch (e) {
          if (e?.code === 'jsonrpc') { itemErrors += 1; continue; }
          stop(e); break;
        }
      }
    }
    // cut = 요청한 대조를 끝내지 못했다(다음 틱에 다시 — P2-5). 대조를 요청하지 않았으면 work 가 잘렸는가(회전이 이어 간다).
    const cut = reconcile ? (!reconciled || rcut) : (!!fault || attempted < work.length || !!signal?.aborted);
    return {
      rows, attempted, redisabled, itemErrors, cut, reconciled,
      ...(reconciled ? { states: [...states], recent: recentRows } : {}),
      ...(fault ? { fault } : {}),
    };
  },
});

/** Director 상태를 바꾸는 작업. */
export const MUTATING = Object.freeze(new Set(['addJobs', 'disableJobs', 'runJob', 'runJobs', 'pruneJobs', 'setEnabled', 'cancel', 'restore', 'poll']));
