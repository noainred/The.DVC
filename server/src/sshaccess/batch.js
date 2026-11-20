/**
 * sshaccess/batch.js — 등록 서버 여러 대에 코어(readServer)를 돌리는 **일괄 틀 하나**(v3.30 · ‘서버 정보’ 에서 뽑아 ‘서버 명령 실행’ 과 같이 쓴다).
 *
 * 규칙(서버 정보 반증 F2 · F3 · F4 그대로 — `server/src/serverinfo/CLAUDE.md`):
 *  · 일괄은 **기능마다 하나씩**(진행 중이면 429 — 같은 서버를 두 번 동시에 붙지 않게 · 동시 세션이 상한을 넘지 않게).
 *  · **시작만 하고 돌려준다**(`done` 은 끝나는 Promise — 라우트는 기다리지 않고 202 · 화면이 `view()` 로 진행을 본다).
 *  · 서버 단독 비밀번호는 일괄 하나에 일괄 문 하나(`makeCredGate` — 같은 계정명 · 비밀번호 N대가 틀린 비밀번호를 N번 보내지 않게).
 *  · 서버 고르기는 **등록부 id 만**(주소 · 계정 · 명령을 받지 않는다) · 등록부를 못 읽으면 503 · 사이에 지워진 서버가 섞이면 404(하나도 돌리지 않는다).
 * 접속 · 계정 · 비밀 · 엣지 · 수집 끔 판정은 코어가 한다 — 이 모듈은 고르기 · 동시성 · 진행만.
 */
import { listBmServersRaw, registryLoadError } from '../bmstor/registry.js';
import { makeCredGate } from './readServer.js';
import { poolRun } from '../util/pool.js';   // 동시성 풀은 공용 하나(arch2579)

const t = (v, n = 256) => String(v ?? '').trim().slice(0, n);

/**
 * @param {{max:number, concurrency:number, text:{busy:string, tooMany:string, registry:string}}} o
 *   text — 기능 말투(‘읽기’ · ‘실행’). busy 뒤에 진행 수가 붙는다.
 */
export function createServerBatch({ max, concurrency, text }) {
  /** 지금 도는 일괄(하나) — { startedAt, by, total, done, ids:Set, meta } · 없으면 null. */
  let job = null;
  return {
    max, concurrency,
    /** 화면용(비밀 없음). */
    view() { return job ? { startedAt: job.startedAt, by: job.by, total: job.total, done: job.done, ...(job.meta ? { meta: job.meta } : {}) } : null; },
    has(id) { return !!job?.ids.has(id); },
    /**
     * @param {string[]} ids  등록부 id
     * @param {(server:object, ctx:{by:string, credGate:Function, index:number}) => Promise<object>} runOne  한 대 — 결과 행({ok, code, reason})을 돌려준다(던지면 'error')
     * @param {{by?:string, meta?:object}} o  meta — 화면에 함께 보일 일괄 설명(비밀 없음)
     * @returns {{ok:true, started:true, total:number, done:Promise<object>} | {ok:false, code:string, status:number, reason:string}}
     */
    start(ids = [], runOne, { by = '', meta = null } = {}) {
      if (registryLoadError()) return { ok: false, code: 'registry-unreadable', status: 503, reason: text.registry };
      const want = [...new Set((Array.isArray(ids) ? ids : []).map((x) => t(x, 64)).filter(Boolean))];
      if (!want.length) return { ok: false, code: 'no-servers', status: 400, reason: '서버를 고르세요.' };
      if (want.length > max) return { ok: false, code: 'too-many', status: 400, reason: text.tooMany };
      if (job) return { ok: false, code: 'busy', status: 429, reason: `${text.busy}(${job.done}/${job.total}대) — 끝난 뒤 다시 누르세요.` };
      const byId = new Map(listBmServersRaw().map((s) => [s.id, s]));
      const list = want.map((id) => byId.get(id)).filter(Boolean);
      if (list.length !== want.length) return { ok: false, code: 'not-found', status: 404, reason: '서버를 찾을 수 없습니다(그 사이 지워짐) — 화면을 다시 읽으세요.' };
      const cur = { startedAt: Date.now(), by: t(by, 64), total: list.length, done: 0, ids: new Set(list.map((s) => s.id)), meta };
      job = cur;
      const credGate = makeCredGate();
      const results = new Array(list.length);
      const done = poolRun(list, concurrency, async (s, k) => {
        let r;
        try { r = await runOne(s, { by, credGate, index: k }); } catch (e) { r = { ok: false, code: 'error', reason: String(e?.message || e).slice(0, 200) }; }
        results[k] = { id: s.id, name: s.name || s.host, ok: !!r?.ok, code: r?.code || 'error', reason: r?.reason || '' };
        cur.done += 1;
      }).then(() => ({ ok: true, results, okCount: results.filter((x) => x?.ok).length, failed: results.filter((x) => x && !x.ok).length }))
        .catch((e) => ({ ok: false, code: 'error', reason: String(e?.message || e).slice(0, 200) }))
        .finally(() => { if (job === cur) job = null; });
      return { ok: true, started: true, total: list.length, done };
    },
  };
}
