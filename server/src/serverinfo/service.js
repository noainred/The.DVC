/**
 * serverinfo/service.js — 기능 ‘서버 정보’(설계 docs/design/server-access §4.1 안 C — 별도 기능 · 공통 코어를 불러 쓴다 · §4.5 · D3).
 *
 * 하는 일: 등록된 서버(bm-storage 등록부 — 서버 접속 화면과 같은 목록)에서 **기본 구성 + 디스크**를 읽어 보관하고 보여 준다.
 *  · 읽기는 사람이 누를 때만(한 번에 최대 READ_BATCH_MAX 대 · 동시 READ_CONCURRENCY 대 · **일괄은 하나씩** — 반증 F3) — 주기 수집은 하지 않는다(다음 단계에서 정한다).
 *    일괄은 시작만 하고 돌려준다(라우트 202 — 응답 없는 서버가 섞이면 수 분이 걸린다 · 반증 F4). 진행은 화면 조회(job)로 본다.
 *    서버 단독 비밀번호는 일괄 문(readServer.makeCredGate)을 지난다 — 같은 계정명 · 비밀번호의 N대가 틀린 비밀번호를 N번 보내지 않게(반증 F2).
 *  · 접속 · 계정 · 비밀은 코어(`sshaccess/readServer.js`)가 한다 — 이 모듈은 명령 묶음(profiles)과 해석 · 보관 · 화면 모양만.
 *  · 엣지가 수집하는 서버는 중앙에서 읽지 않는다(그 엣지 포탈의 같은 화면 — 비밀은 법인 밖으로 나가지 않는다).
 *  · 데모(mock) 서버(mock- id)는 합성 값(데모 화면이 비지 않게) — 사람이 등록한 서버는 mock 모드에서도 실제로 읽는다(bm-storage 와 같은 규칙).
 */
import { listBmServersRaw, registryLoadError } from '../bmstor/registry.js';
import { effectiveAccountOf } from '../bmusage/onboard/refs.js';
import { readServer, makeCredGate } from '../sshaccess/readServer.js';
import { SERVER_INFO_PLAN, parseFor } from './profiles.js';
import * as SI from './store.js';
import { isMockMode, isDemoId } from '../mock/demo/storage.js';
import { demoServerInfo } from './demo.js';
import { poolRun } from '../util/pool.js';   // 동시성 풀은 공용 하나(arch2579)

export const FEATURE = 'server-info';
export const READ_BATCH_MAX = 50;
export const READ_CONCURRENCY = 4;
const t = (v, n = 256) => String(v ?? '').trim().slice(0, n);
/** 지금 도는 일괄(하나) — { startedAt, by, total, done, ids:Set } · 없으면 null. */
let job = null;

/** 화면 한 번에 필요한 것(비밀 없음). */
export function buildView() {
  const regErr = registryLoadError();
  if (regErr) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'OS 계정 등록부(bm-storage.json)를 읽지 못했습니다.' };
  const servers = listBmServersRaw();
  SI.pruneTo(servers.map((s) => s.id));
  const rows = servers.map((s) => {
    const ef = effectiveAccountOf(s);
    const r = SI.getResult(s.id);
    return {
      id: s.id, name: s.name || s.host, host: s.host, port: Number(s.port) || 22, corp: t(s.vcenterId, 128), os: s.os === 'windows' ? 'windows' : (s.os === 'linux' ? 'linux' : ''),
      agent: t(s.agent, 64), enabled: s.enabled !== false, demo: isDemoId(s.id), reading: !!job?.ids.has(s.id),
      account: { source: ef.source, pending: !!ef.pending, unreadable: !!ef.unreadable },
      result: r || null,
    };
  });
  return { ok: true, servers: rows, limits: { batch: READ_BATCH_MAX, concurrency: READ_CONCURRENCY }, storeError: SI.storeLoadError() || '',
    job: job ? { startedAt: job.startedAt, by: job.by, total: job.total, done: job.done } : null };
}

/** 한 대 읽고 보관한다(결과 행을 돌려준다 — 비밀 · 원문 없음). */
async function readOne(s, { by, credGate }) {
  const at = Date.now();
  if (isMockMode() && isDemoId(s.id)) {
    const row = { ...demoServerInfo(s), at, by: t(by, 64) };
    SI.putResult(s.id, row);
    return row;
  }
  const r = await readServer(s.id, { feature: FEATURE, plan: SERVER_INFO_PLAN, by, trigger: 'manual', credGate });
  let row;
  if (!r.ok && !r.partial) row = { ok: false, at, by: t(by, 64), code: r.code, credCode: r.credCode || '', reason: t(r.reason, 300), os: r.os || '', via: r.via || '', auth: r.auth || null, ms: r.ms ?? null };
  else if (r.partial) {
    // 로그인은 됐는데 명령이 시한 · 상한에 걸렸다 — 받은 칸만(끝 표지가 없으니 잘림) · 실패 행이지만 base 를 함께 둔다(화면이 ‘일부만 읽음’ 으로 보인다)
    const p = parseFor(r.os, r.stdout, r.stderr);
    row = { ok: false, partial: true, at, by: t(by, 64), code: r.code, reason: t(r.reason, 300), os: r.os, via: r.via, auth: r.auth, ms: r.ms, base: p.base, disks: p.disks, fs: p.fs, failed: p.failed || [] };
  } else {
    const p = parseFor(r.os, r.stdout, r.stderr);
    const partial = p.truncated;
    row = { ok: !partial, partial, at, by: t(by, 64), code: partial ? (p.hint === 'maybe-windows' ? 'maybe-windows' : 'unparsed') : 'ok', os: r.os, via: r.via, auth: r.auth, ms: r.ms, exit: r.exit, failed: p.failed || [],
      reason: partial ? (p.hint === 'maybe-windows' ? '명령이 Windows 셸에서 돈 것 같습니다 — 서버 접속 › 계정 계층에서 이 서버의 OS 종류를 Windows 로 정하세요(저절로 바꾸지 않습니다).' : '출력이 끝까지 오지 않았거나 형식을 알아보지 못했습니다 — 읽은 칸만 보입니다.') : '',
      base: p.base, disks: p.disks, fs: p.fs };
  }
  SI.putResult(s.id, row);
  return row;
}

/**
 * 고른 서버 읽기(사람이 누름) — **시작만 하고 돌려준다**(`done` 은 끝나는 Promise — 라우트는 기다리지 않는다 · 시험이 기다린다).
 * 일괄은 하나씩(진행 중이면 429 — 같은 서버를 두 번 동시에 읽지 않게 · 동시 세션이 상한을 넘지 않게). 수집을 끈 · 엣지 서버는 코어가 거절 사유로 남긴다.
 * @returns {{ok:true, started:true, total:number, done:Promise<object>} | {ok:false, code, status, reason}}
 */
export function startRead(ids = [], { by = '' } = {}) {
  const regErr = registryLoadError();
  if (regErr) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'OS 계정 등록부(bm-storage.json)를 읽지 못해 읽지 않았습니다.' };
  const want = [...new Set((Array.isArray(ids) ? ids : []).map((x) => t(x, 64)).filter(Boolean))];
  if (!want.length) return { ok: false, code: 'no-servers', status: 400, reason: '서버를 고르세요.' };
  if (want.length > READ_BATCH_MAX) return { ok: false, code: 'too-many', status: 400, reason: `한 번에 ${READ_BATCH_MAX}대까지 읽습니다.` };
  if (job) return { ok: false, code: 'busy', status: 429, reason: `다른 읽기가 진행 중입니다(${job.done}/${job.total}대) — 끝난 뒤 다시 누르세요.` };
  const byId = new Map(listBmServersRaw().map((s) => [s.id, s]));
  const list = want.map((id) => byId.get(id)).filter(Boolean);
  if (list.length !== want.length) return { ok: false, code: 'not-found', status: 404, reason: '서버를 찾을 수 없습니다(그 사이 지워짐) — 화면을 다시 읽으세요.' };
  const cur = { startedAt: Date.now(), by: t(by, 64), total: list.length, done: 0, ids: new Set(list.map((s) => s.id)) };
  job = cur;
  const credGate = makeCredGate();
  const results = new Array(list.length);
  const done = poolRun(list, READ_CONCURRENCY, async (s, k) => {
    let r;
    try { r = await readOne(s, { by, credGate }); } catch (e) { r = { ok: false, code: 'error', reason: String(e?.message || e).slice(0, 200) }; }
    results[k] = { id: s.id, name: s.name || s.host, ok: !!r.ok, code: r.code, reason: r.reason || '' };
    cur.done += 1;
  }).then(() => ({ ok: true, results, read: results.filter((x) => x?.ok).length, failed: results.filter((x) => x && !x.ok).length }))
    .catch((e) => ({ ok: false, code: 'error', reason: String(e?.message || e).slice(0, 200) }))
    .finally(() => { if (job === cur) job = null; });
  return { ok: true, started: true, total: list.length, done };
}
/** 시험 · 내부용 — 끝날 때까지 기다린 결과. */
export async function readMany(ids = [], { by = '' } = {}) {
  const r = startRead(ids, { by });
  return r.ok ? r.done : r;
}
