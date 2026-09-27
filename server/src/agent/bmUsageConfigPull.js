/**
 * agent/bmUsageConfigPull.js — 중앙 → 엣지 '베어메탈 사용률' 설정 배포(v2.627).
 *
 * 사용자 요청 "한번에 켜는 기능" · 선택 "중앙 설정이 엣지를 따른다": 베어메탈 사용률 설정은 v2.550 부터 **각 엣지 로컬**이라
 * 28곳을 켜려면 28번 들어가야 했다. 중앙 관리자가 배포를 켜면 엣지는 이 워커로 배포 키(켬·법인·ESXi 포함·경로·주기·보존·
 * 알림)를 받아 로컬 설정 위에 겹친다. **Enterprise 대체 수집은 배포하지 않는다**(v2.554 — 그 엣지 관리자의 동의가 필요하다).
 *
 * 규약(partFaultConfigPull 과 같다): 실패는 로그 1줄 후 다음 주기 — **마지막으로 받은 사본을 유지**한다(한 번의 회선 장애가
 * 28곳의 수집 설정을 로컬로 되돌리면 안 된다). 중앙이 `distribute:false`(끔·이 엣지 제외)를 **명시**할 때만 사본을 지운다.
 * 404(구버전 중앙·central 기능 꺼짐)도 사본을 건드리지 않는다.
 *
 * ⚠ v2.628(감사 EDGE2628-04): 예전 404 경로는 '엣지 로컬 설정 사용' 이라 기록했지만 사본은 지우지 않아 **계속 겹쳐 적용됐다**
 *   (상태가 거짓말). '사본이 있을 수 없다' 는 전제도 틀렸다 — 중앙 다운그레이드·central 기능 끔(404 '비활성화')이면 사본이 남는다.
 *   설계(사본은 명시적 distribute:false 로만 지운다)는 유지하고 **상태를 사실대로** 쓴다: 사본이 있으면 `keptCopy:true` +
 *   '마지막 중앙 배포 사본을 계속 적용', 없으면 '로컬 설정 사용'. 404 는 어느 종류든 `ok:false` 다(배포를 받지 못했다).
 *   CENTRAL_URL/TOKEN 이 없는 노드(엣지 → 중앙 전환)는 워커가 돌지 않으므로 사본을 정리할 주체가 없다 — 사본이 남아 있으면
 *   `staleCopy:true` 로 기록하고 콘솔에 남긴다(지우지는 않는다 — 판단은 관리자 몫).
 */
import { config, clampIntervalMs, currentVersion } from '../config.js';
import { classifyCentral404 } from './central404.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { readJsonCapped } from '../util/readCapped.js';
import { applyCentralBmUsage, clearCentralBmUsage, bmUsageCentralState } from '../bmusage/settings.js';
import { agentHeaders, withAgentQuery } from './agentNameCarry.js'; // v2.629 A6-01: 원문 이름 헤더는 한글 이름에서 fetch 가 던진다
const _logOnce = createChangeLogger({ windowMs: 10 * 60_000 });

const PULL_MS = clampIntervalMs(Number(process.env.AGENT_BMUSAGE_CONFIG_PULL_MS) || 10 * 60_000, 10 * 60_000, 60_000);
let timer = null; let running = false; let last = null;

function configured() { return !!(config.agent.centralUrl && config.agent.centralToken); }
export function bmUsageConfigPullStatus() {
  const central = bmUsageCentralState();
  // 구성이 없는데 사본이 남아 있으면(엣지 → 중앙 전환) 매 조회마다 사실대로 말한다 — 기동 시점 기록만 믿지 않는다.
  if (!configured()) {
    return { configured: false, intervalMs: PULL_MS, central,
      last: { at: last?.kind === 'not-configured' ? last.at : 0, ok: false, skipped: true, kind: 'not-configured', staleCopy: !!central.managed,
        note: central.managed ? 'CENTRAL_URL/CENTRAL_TOKEN 이 없는데 마지막 중앙 배포 사본이 남아 계속 적용됩니다 — 이 노드는 배포를 받을 수 없습니다' : 'CENTRAL_URL/CENTRAL_TOKEN 없음 — 엣지 로컬 설정 사용' } };
  }
  return { configured: true, intervalMs: PULL_MS, last, central };
}

export async function pullBmUsageConfigNow() {
  if (running) return { ok: false, reason: 'pull 진행 중' };
  running = true;
  try {
    const applied = bmUsageCentralState().sig || '';
    const url = `${config.agent.centralUrl}/api/central/bmusage-config?agent=${encodeURIComponent(config.agent.name)}&applied=${encodeURIComponent(applied)}`;
    const res = await resilientFetch(url, {
      method: 'GET', timeoutMs: 30_000, retries: 1,
      headers: { ...agentHeaders(config.agent.name), 'X-Central-Token': config.agent.centralToken, 'X-Agent-Version': currentVersion() },
    });
    if (res.status === 404) {
      const c = await classifyCentral404(res);
      const keptCopy = !!bmUsageCentralState().managed;
      last = { at: Date.now(), ok: false, applied: false, kind: c.kind, keptCopy,
        note: keptCopy ? `${c.reason} — 마지막 중앙 배포 사본을 계속 적용합니다(중앙이 배포 해제를 명시할 때만 지웁니다)` : `${c.reason} — 엣지 로컬 설정 사용` };
      if (_logOnce(c.kind, c.reason)) console.warn(`[bmusage-pull] ${c.reason}`);
      return last;
    }
    if (!res.ok) throw new Error(`bmusage-config -> ${res.status}`);
    const body = await readJsonCapped(res, 256 * 1024);
    if (!body || typeof body !== 'object' || typeof body.distribute !== 'boolean') throw new Error('배포 본문 형식 오류');
    if (body.distribute) {
      const changed = applyCentralBmUsage({ settings: body.settings, sig: body.sig });
      if (changed) console.log(`[bmusage-pull] 중앙 배포 적용 — enabled=${!!body.settings?.enabled} 법인 ${Object.keys(body.settings?.corps || {}).length}곳`);
      last = { at: Date.now(), ok: true, managed: true, changed, sig: body.sig || '' };
    } else {
      const changed = clearCentralBmUsage();
      if (changed) console.log(`[bmusage-pull] 중앙 배포 해제(${body.reason || '-'}) — 엣지 로컬 설정으로 돌아갑니다`);
      last = { at: Date.now(), ok: true, managed: false, changed, reason: String(body.reason || '').slice(0, 32) };
    }
    return last;
  } catch (e) {
    last = { at: Date.now(), ok: false, error: String(e?.message || e).slice(0, 300), keptCopy: bmUsageCentralState().managed };
    if (_logOnce('fail', last.error)) console.warn(`[bmusage-pull] 실패(마지막 배포 사본 유지): ${last.error}`);
    return last;
  } finally { running = false; }
}

export function startBmUsageConfigPull() {
  if (timer) return;
  if (!configured()) {
    const managed = !!bmUsageCentralState().managed;
    last = { at: Date.now(), ok: false, skipped: true, kind: 'not-configured', staleCopy: managed,
      note: managed ? 'CENTRAL_URL/CENTRAL_TOKEN 이 없는데 마지막 중앙 배포 사본이 남아 계속 적용됩니다 — 이 노드는 배포를 받을 수 없습니다' : 'CENTRAL_URL/CENTRAL_TOKEN 없음 — 엣지 로컬 설정 사용' };
    if (managed) console.warn(`[bmusage-pull] ${last.note}(사본 파일 bmusage-central.json 을 지우면 로컬 설정으로 돌아갑니다)`);
    else console.log('[bmusage-pull] 비활성 — CENTRAL_URL/CENTRAL_TOKEN 없음(중앙 자신이면 정상)');
    return;
  }
  setTimeout(() => pullBmUsageConfigNow().catch(() => {}), 45_000).unref?.();
  timer = setInterval(() => { if (!running) pullBmUsageConfigNow().catch(() => {}); }, PULL_MS);
  timer.unref?.();
  console.log(`[bmusage-pull] started — ${Math.round(PULL_MS / 60_000)}분 주기`);
}
