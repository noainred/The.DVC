/**
 * Apply / remove a remote-access mapping on its assigned proxy (HAProxy), via
 * the Data Plane API or SSH auto-deploy. Shared by the remote routes and the
 * ephemeral-mapping expiry job.
 */

import { getProxyById, listMappings, setMappingStatus, mappingConfigIssue, removeMapping, DEPLOY_CMD_MAPPING_TEXT, MAPPING_TEARDOWN_PENDING, MAPPING_TEARDOWN_TEXT } from './registry.js';
import { applyMapping, removeMapping as haproxyRemove } from './dataplane.js';
import { deployToProxy } from './deploy.js';

const proxyOf = (m) => getProxyById(m.proxyId);

// HAProxy 변경(Data Plane 트랜잭션/SSH 배포)을 전역 직렬화한다. 동시 원격접속이 많을 때
// 병렬 트랜잭션은 Data Plane 버전 충돌을 일으키고, 동시 graceful reload가 누적되면 HAProxy
// 프로세스가 죽거나 메모리 폭증으로 서버가 리붓된다. 한 번에 하나씩 처리해 reload를 직렬화.
let _chain = Promise.resolve();
function serialize(fn) {
  const run = _chain.then(fn, fn);
  _chain = run.then(() => {}, () => {}); // 에러가 나도 체인이 끊기지 않게
  return run;
}

/**
 * v2.770(점검 R5-E5-4): SSH 배포가 성공하면 블록에 들어간 매핑만 active 다 — 형식이 깨진 매핑은 buildConfigBlock 이 건너뛰므로
 *   active 로 표시하면 '열렸다' 는 거짓이 된다. 그 매핑은 사유와 함께 error 로 남긴다(삭제하면 사라진다).
 */
export function markDeployed(ms) {
  for (const m of ms) {
    const bad = mappingConfigIssue(m);
    setMappingStatus(m.id, bad ? 'error' : 'active', bad ? `HAProxy 블록에서 제외 — ${bad}` : null);
  }
}

/*
 * 보안 잔여 11-27 M1(설계 반증 must): 배포 명령이 허용 형식 밖이라 SSH 배포가 **접속 전에 거절**되면(code 'deploy-cmd-invalid') 매핑 철거(삭제 · 만료)가
 *   HAProxy 의 listen 을 닫지 못한다. 예전 철거는 결과를 버리고 등록부만 지워, 업그레이드 전까지 배포가 되던 현장에서 **만료된 임시 접근의 공개 포트가
 *   열린 채 남았다**(모든 배포가 거절되므로 다음 배포가 블록을 다시 만들어 치우지도 않는다 — fail-open). 이제 그 매핑은 지우지 않고 '철거 보류' 로 남긴다:
 *   · 블록에서는 빼고(다음 성공 배포가 그 listen 을 닫는다) · 공개 포트는 계속 차지하며(아직 열려 있다) · 게이트웨이 접속 · quick-connect 재사용은 막는다.
 *   · 만료 작업이 매 주기 다시 철거하고, 성공한 SSH 배포는 그 중계의 보류 매핑을 등록부에서 지운다(블록에 없었으니 닫혔다).
 *   일시 장애(접속 실패 등)는 예전 그대로 지운다 — 다음 성공 배포가 등록부에서 블록을 다시 만들어 닫는다(스스로 낫는다). 거절은 스스로 낫지 않는다.
 */
export { MAPPING_TEARDOWN_PENDING as TEARDOWN_PENDING, MAPPING_TEARDOWN_TEXT as TEARDOWN_PENDING_TEXT };   // 상태 이름 · 문구는 등록부 하나(게이트웨이도 본다)
const proxyKey = (m) => m.proxyId || 'default';
/** SSH 배포 블록에 넣을 매핑 — 그 중계의 매핑 중 철거 보류 · (철거 중인) 자기 자신을 뺀다. */
export function deployMappingsFor(proxyId, exceptId = null) {
  return listMappings().filter((m) => proxyKey(m) === proxyId && m.id !== exceptId && m.status !== MAPPING_TEARDOWN_PENDING);
}
/** SSH 배포 성공 뒤: 블록에 들어간 매핑 상태(markDeployed) + 그 중계의 철거 보류 매핑을 등록부에서 지운다(블록에 없었으니 listen 이 닫혔다). */
export function finishSshDeploy(proxyId, ms, { exceptId = null } = {}) {
  if (ms) markDeployed(ms);
  for (const m of listMappings().filter((x) => proxyKey(x) === proxyId && x.status === MAPPING_TEARDOWN_PENDING && x.id !== exceptId)) {
    removeMapping(m.id);
    console.log(`[remote] 철거 보류 매핑 정리: ${m.name} (공개 포트 ${m.publicPort})`);
  }
}

/** Provision a mapping on its proxy. (HAProxy 변경은 직렬화) */
export function provision(mapping) {
  return serialize(() => doProvision(mapping));
}

async function doProvision(mapping) {
  const proxy = proxyOf(mapping);
  if (proxy.dataplane?.enabled) {
    try { await applyMapping(proxy.dataplane, mapping); setMappingStatus(mapping.id, 'active', null); }
    catch (err) { setMappingStatus(mapping.id, 'error', err.message); }
  } else if (proxy.deploy?.enabled) {
    const ms = deployMappingsFor(proxy.id);
    const d = await deployToProxy(proxy.deploy, ms, { bindAddress: proxy.dataplane?.bindAddress || '*' });
    if (d.ok) finishSshDeploy(proxy.id, ms);
    // 보안 잔여 11-27 M1(반증 S-3): 매핑 상태는 소유자(비관리자일 수 있다)에게 보인다 — 명령 형식 거절은 구성 단서 없는 문구로(관리자는 설정 화면에서 사유를 본다)
    else setMappingStatus(mapping.id, 'error', d.code === 'deploy-cmd-invalid' ? DEPLOY_CMD_MAPPING_TEXT : d.reason);
  } else {
    setMappingStatus(mapping.id, 'manual', `프록시 '${proxy.name}' Data Plane/SSH 배포 미사용 — 수동 설정 필요`);
  }
}

/**
 * Remove a mapping from its proxy (call BEFORE deleting it from the registry). (직렬화)
 * → { ok:true } | { ok:false, held:true, reason, code }(철거 보류 — 호출부는 등록부에서 **지우지 않는다**) | { ok:false, reason }(일시 실패 — 예전처럼 지운다).
 */
export function deprovision(mapping) {
  return serialize(() => doDeprovision(mapping));
}

async function doDeprovision(mapping) {
  const proxy = proxyOf(mapping);
  if (proxy.dataplane?.enabled) {
    try { await haproxyRemove(proxy.dataplane, mapping); } catch { /* best effort */ }
    return { ok: true };
  }
  if (proxy.deploy?.enabled) {
    const ms = deployMappingsFor(proxy.id, mapping.id);
    const d = await deployToProxy(proxy.deploy, ms, { bindAddress: proxy.dataplane?.bindAddress || '*' }).catch((e) => ({ ok: false, reason: String(e?.message || e) }));
    if (d.ok) { finishSshDeploy(proxy.id, null, { exceptId: mapping.id }); return { ok: true }; }
    if (d.code === 'deploy-cmd-invalid') {
      setMappingStatus(mapping.id, MAPPING_TEARDOWN_PENDING, MAPPING_TEARDOWN_TEXT);
      return { ok: false, held: true, code: d.code, reason: d.reason };
    }
    return { ok: false, reason: d.reason };
  }
  return { ok: true };
}
