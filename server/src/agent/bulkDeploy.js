/**
 * agent/bulkDeploy.js — Edge 노드 **대량 배포 실행기**(v2.432, 사용자 요구 '엣지노드 배포를 대용량으로
 * 할 수 있게 … 입력 전에 배포하는 기능').
 *
 * 기존 `POST /agent-deploy/deploy-all` 과 무엇이 다른가:
 *  1. **저장(등록) 전에 배포한다** — 붙여넣은 목록을 대상 레지스트리에 넣지 않고 그대로 설치한다.
 *     성공한 노드만 나중에 저장·수집 서버 등록(옵션). 실패한 노드가 레지스트리를 더럽히지 않는다.
 *  2. **비동기 잡** — deploy-all 은 전 노드가 끝날 때까지 HTTP 응답 하나를 붙잡고 있어서(노드당
 *     SFTP 수십 MB + install.sh) 28대 규모면 프록시 유휴 타임아웃에 걸려 결과를 통째로 잃는다.
 *     여기서는 runId 를 즉시 돌려주고 화면이 폴링한다(SAN 연결 테스트 v2.421 과 같은 골격).
 *  3. **동시성 제한 + 노드당 타임아웃(세션 실제 절단) + 취소**. CLAUDE.md 성능/SSH 규약:
 *     `withDeadline` 의 signal 을 creds 로 넘겨 기한이 지나면 SSH 세션을 끊는다(결과만 포기하는
 *     Promise.race 금지). 동시 수는 낮게 잡는다 — 전송이 무겁고 고RTT 회선을 공유하기 때문.
 *
 * 보안: 자격증명은 실행 중 클로저에만 있고 **잡 상태·응답 어디에도 남기지 않는다**(auth 방식만 표시).
 */
import { reqTimeoutMs } from './envTimeout.js';
import { deployAgent } from './deploy.js';
import { saveTarget, findTargetByHost, recordResult } from './deployRegistry.js';
import { autoRegisterCollector } from './autoRegister.js';
import { ipBlockReason } from '../collector/registry.js';
import { poolRun as pool } from '../util/pool.js'; // v2.579(ARCH-01): 동시성 풀 단일 소스 — 손으로 쓴 사본 제거(첫 rejection 전파 = 예전과 같은 의미)

const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.AGENT_DEPLOY_CONCURRENCY) || 2));
const NODE_TIMEOUT_MS = reqTimeoutMs(process.env.AGENT_DEPLOY_TIMEOUT_MS, 900_000, { min: 60_000, max: 2 * 3_600_000 }); // 기본 15분(SFTP + install.sh)
const KEEP_RUNS = 5;

const _runs = new Map();   // runId → run
let _active = null;        // 진행 중 runId (전역 재진입 가드)

const now = () => Date.now();
const newId = () => `bulk-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 응답용 정제 — 자격증명은 절대 넣지 않는다. */
function viewItem(it) {
  return {
    line: it.line, host: it.host, port: it.port, username: it.username, agentName: it.agentName,
    collectorDatacenter: it.collectorDatacenter, portalPort: it.portalPort, auth: it.auth,
    status: it.status, reason: it.reason || '', active: it.active || '', installer: it.installer || '',
    glibc: it.glibc || '', ms: it.ms || 0, startedAt: it.startedAt || 0, finishedAt: it.finishedAt || 0,
    saved: it.saved || null, collector: it.collector || null, log: it.log || '',
  };
}
export function viewRun(run) {
  if (!run) return null;
  const items = run.items.map(viewItem);
  return {
    ok: true, runId: run.id, status: run.status, at: run.at, finishedAt: run.finishedAt || 0,
    by: run.by, total: items.length,
    counts: {
      queued: items.filter((i) => i.status === 'queued').length,
      running: items.filter((i) => i.status === 'running').length,
      ok: items.filter((i) => i.status === 'ok').length,
      fail: items.filter((i) => i.status === 'fail').length,
      cancelled: items.filter((i) => i.status === 'cancelled').length,
    },
    opts: { saveTargets: run.opts.saveTargets, registerCollector: run.opts.registerCollector, portalPort: run.opts.portalPort, installerPath: run.opts.installerPath || '' },
    items,
  };
}

export function getRun(runId) { return viewRun(_runs.get(runId)); }
export function listRuns() {
  return [..._runs.values()].sort((a, b) => b.at - a.at).map((r) => ({
    runId: r.id, status: r.status, at: r.at, finishedAt: r.finishedAt || 0, by: r.by, total: r.items.length,
    ok: r.items.filter((i) => i.status === 'ok').length, fail: r.items.filter((i) => i.status === 'fail').length,
  }));
}
export function activeRunId() { return _active; }
export function cancelRun(runId) {
  const run = _runs.get(runId);
  if (!run) return { ok: false, reason: '실행을 찾을 수 없습니다.' };
  if (run.status !== 'running') return { ok: false, reason: `이미 ${run.status} 상태입니다.` };
  run.cancelled = true;
  for (const ac of run.aborts.values()) { try { ac.abort(); } catch { /* */ } }
  return { ok: true, runId };
}
export function _resetForTest() { _runs.clear(); _active = null; }


/**
 * 대량 배포 시작. rows 는 parseTargetsText 결과(자격증명 포함) — **호출부가 admin 게이트/감사 책임**.
 * @param {Array} rows
 * @param {{saveTargets?:boolean, registerCollector?:boolean, portalPort?:number, installerPath?:string,
 *          by?:string, concurrency?:number, timeoutMs?:number, deploy?:Function}} opts
 *        deploy: 테스트 주입용(기본 deployAgent).
 * @returns {{ok:boolean, runId?:string, reason?:string}}
 */
export function startBulkDeploy(rows, opts = {}) {
  if (_active && _runs.get(_active)?.status === 'running') {
    return { ok: false, reason: `이미 대량 배포가 진행 중입니다(${_active}). 완료 또는 취소 후 다시 시도하세요.`, runId: _active };
  }
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.host);
  if (!list.length) return { ok: false, reason: '배포할 대상이 없습니다.' };
  if (list.length > 500) return { ok: false, reason: `한 번에 최대 500대까지입니다(${list.length}대 요청).` };

  const run = {
    id: newId(), at: now(), status: 'running', by: String(opts.by || ''), cancelled: false,
    aborts: new Map(),
    opts: {
      saveTargets: opts.saveTargets !== false,
      registerCollector: opts.registerCollector !== false,
      portalPort: Number(opts.portalPort) || 4000,
      installerPath: opts.installerPath || '',
    },
    items: list.map((r) => ({
      line: r._line || 0, host: r.host, port: Number(r.port) || 22, username: r.username || 'root',
      agentName: r.agentName || '', collectorDatacenter: r.collectorDatacenter || '',
      portalPort: Number(r.portalPort) || Number(opts.portalPort) || 4000,
      auth: r.privateKey ? 'key' : r.password ? 'password' : '',
      status: 'queued', _row: r,   // _row 는 비밀 포함 — viewItem 이 절대 노출하지 않는다
    })),
  };
  _runs.set(run.id, run);
  _active = run.id;
  // 보관 상한 — 오래된 완료 run 정리
  for (const old of [..._runs.values()].sort((a, b) => b.at - a.at).slice(KEEP_RUNS)) _runs.delete(old.id);

  const deploy = typeof opts.deploy === 'function' ? opts.deploy : deployAgent;
  const timeoutMs = Math.max(10_000, Number(opts.timeoutMs) || NODE_TIMEOUT_MS);
  const limit = Math.max(1, Math.min(8, Number(opts.concurrency) || CONCURRENCY));

  // 백그라운드 실행 — 호출부는 runId 만 받고 즉시 응답한다.
  (async () => {
    try {
      await pool(run.items, limit, async (item) => {
        if (run.cancelled) { item.status = 'cancelled'; item.reason = '사용자 취소'; return; }
        const blocked = ipBlockReason(item.host);
        if (blocked) { item.status = 'fail'; item.reason = blocked; return; }
        item.status = 'running'; item.startedAt = now();
        const t0 = now();
        // 노드당 기한 + 취소를 한 signal 로 — withSsh 가 이 signal 로 **세션을 실제로 끊는다**(v2.417 규약).
        const ac = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
        run.aborts.set(item.host, ac);
        const failReason = (msg) => (run.cancelled ? '사용자 취소'
          : timedOut ? `배포 타임아웃(${Math.round(timeoutMs / 60_000)}분) — 세션을 끊었습니다.` : msg);
        try {
          const r = await deploy({ ...item._row, signal: ac.signal },
            { installerPath: item._row.installerPath || run.opts.installerPath, port: item.portalPort });
          item.active = r.active || ''; item.installer = r.installer || ''; item.glibc = r.glibc || '';
          item.log = String(r.log || '').slice(-2000);
          if (r.ok) {
            item.status = 'ok';
            if (run.opts.saveTargets) item.saved = saveOne(item, run);
            if (run.opts.registerCollector) {
              try { item.collector = autoRegisterCollector(item._row, item.portalPort); }
              catch (e) { item.collector = { registered: false, reason: e.message }; }
            }
          } else {
            // deployAgent 는 예외를 삼키고 {ok:false} 를 돌려주므로 취소/타임아웃도 여기로 온다.
            item.status = run.cancelled ? 'cancelled' : 'fail';
            item.reason = failReason(r.reason || '실패');
          }
        } catch (e) {
          item.status = run.cancelled ? 'cancelled' : 'fail';
          item.reason = failReason(e.message);
        } finally {
          clearTimeout(timer);
          run.aborts.delete(item.host);
          item.ms = now() - t0; item.finishedAt = now();
        }
      });
    } finally {
      for (const it of run.items) if (it.status === 'queued' || it.status === 'running') { it.status = 'cancelled'; it.reason = it.reason || '중단됨'; }
      run.status = run.cancelled ? 'cancelled' : 'done';
      run.finishedAt = now();
      for (const it of run.items) delete it._row;   // 비밀 즉시 폐기
      if (_active === run.id) _active = null;
    }
  })();

  return { ok: true, runId: run.id };
}

/** 성공한 노드만 대상 레지스트리에 저장(기존 항목이면 갱신). 실패는 배포 결과에 영향 주지 않는다. */
function saveOne(item, run) {
  try {
    const r = item._row;
    const id = findTargetByHost(r.host, r.port, r.username)?.id;
    const input = {
      id, host: r.host, port: r.port, username: r.username, agentName: r.agentName,
      centralUrl: r.centralUrl, collectorDatacenter: r.collectorDatacenter, advertiseUrl: r.advertiseUrl,
      portalPort: item.portalPort, installerPath: r.installerPath || run.opts.installerPath,
      autoUpgrade: r.autoUpgrade, pushInventory: r.pushInventory, enabled: r.enabled !== false,
    };
    if (r.password) input.password = r.password;
    if (r.privateKey) input.privateKey = r.privateKey;
    if (r.passphrase) input.passphrase = r.passphrase;
    if (r.centralToken) input.centralToken = r.centralToken;
    if (r.collectorToken) input.collectorToken = r.collectorToken;
    const s = saveTarget(input);
    if (s.ok && s.target?.id) { try { recordResult(s.target.id, { ok: true, active: item.active }); } catch { /* */ } }
    return s.ok ? { saved: true, id: s.target?.id || id || '', updated: !!id } : { saved: false, reason: s.reason };
  } catch (e) { return { saved: false, reason: e.message }; }
}
