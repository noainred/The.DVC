/**
 * agent/bmUsageConfigPull.js — 중앙 → 엣지 '베어메탈 사용률' 설정 배포(v2.627).
 *
 * 사용자 요청 "한번에 켜는 기능" · 선택 "중앙 설정이 엣지를 따른다": 베어메탈 사용률 설정은 v2.550 부터 **각 엣지 로컬**이라
 * 28곳을 켜려면 28번 들어가야 했다. 중앙 관리자가 배포를 켜면 엣지는 이 워커로 배포 키(켬·법인·ESXi 포함·경로·주기·보존·
 * 알림)를 받아 로컬 설정 위에 겹친다. **Enterprise 대체 수집은 배포하지 않는다**(v2.554 — 그 엣지 관리자의 동의가 필요하다).
 *
 * 규약(partFaultConfigPull 과 같다): 실패는 로그 1줄 후 다음 주기 — **마지막으로 받은 사본을 유지**한다(한 번의 회선 장애가
 * 28곳의 수집 설정을 로컬로 되돌리면 안 된다). 중앙이 `distribute:false`(끔·이 엣지 제외)를 **명시**할 때만 사본을 지운다.
 * 404(구버전 중앙)는 '중앙에 이 기능이 없음' — 사본을 건드리지 않고 로컬 설정을 쓴다(사본이 있을 수 없다).
 */
import { config, clampIntervalMs, currentVersion } from '../config.js';
import { classifyCentral404 } from './central404.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { readJsonCapped } from '../util/readCapped.js';
import { applyCentralBmUsage, clearCentralBmUsage, bmUsageCentralState } from '../bmusage/settings.js';
const _logOnce = createChangeLogger({ windowMs: 10 * 60_000 });

const PULL_MS = clampIntervalMs(Number(process.env.AGENT_BMUSAGE_CONFIG_PULL_MS) || 10 * 60_000, 10 * 60_000, 60_000);
let timer = null; let running = false; let last = null;

function configured() { return !!(config.agent.centralUrl && config.agent.centralToken); }
export function bmUsageConfigPullStatus() { return { configured: configured(), intervalMs: PULL_MS, last, central: bmUsageCentralState() }; }

export async function pullBmUsageConfigNow() {
  if (running) return { ok: false, reason: 'pull 진행 중' };
  running = true;
  try {
    const applied = bmUsageCentralState().sig || '';
    const url = `${config.agent.centralUrl}/api/central/bmusage-config?agent=${encodeURIComponent(config.agent.name)}&applied=${encodeURIComponent(applied)}`;
    const res = await resilientFetch(url, {
      method: 'GET', timeoutMs: 30_000, retries: 1,
      headers: { 'X-Agent-Name': config.agent.name, 'X-Central-Token': config.agent.centralToken, 'X-Agent-Version': currentVersion() },
    });
    if (res.status === 404) {
      const c = await classifyCentral404(res);
      last = { at: Date.now(), ok: c.kind === 'no-endpoint', applied: false, kind: c.kind, note: `${c.reason} — 엣지 로컬 설정 사용` };
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
  if (!configured()) { console.log('[bmusage-pull] 비활성 — CENTRAL_URL/CENTRAL_TOKEN 없음(중앙 자신이면 정상)'); return; }
  setTimeout(() => pullBmUsageConfigNow().catch(() => {}), 45_000).unref?.();
  timer = setInterval(() => { if (!running) pullBmUsageConfigNow().catch(() => {}); }, PULL_MS);
  timer.unref?.();
  console.log(`[bmusage-pull] started — ${Math.round(PULL_MS / 60_000)}분 주기`);
}
