// vCenter 알람 · 최근 작업 · 권한 목록 갱신(v2.897). 인벤토리 수집 한 주기 안에서(soapClient runAux) vCenter 마다 종류별 주기로 한 번.
// 캐시는 인메모리다(재시작 뒤 첫 주기에 다시 읽는다). 실패는 격리한다(인벤토리 수집은 성공) — 실패하면 직전 값을 유지하고 오류를 싣는다
// (조용히 비우지 않는다). 전부 읽기 전용 호출이다: RetrieveProperties(rootFolder.triggeredAlarmState · TaskManager.recentTask · Task.info ·
// Alarm.info.name · AuthorizationManager.roleList · 이름) + AuthorizationManager.RetrieveAllPermissions. 상태를 바꾸는 호출은 없다.
//
// 이 캐시는 스냅샷의 vCenter 객체에 싣지 않는다 — /vcenters 등 모든 인증 사용자 응답에 vCenter 객체가 통째로 나가므로(권한 목록이 새면 안 된다).
// 엣지는 inventoryPush 가 push 본문의 vcenter.vcInfo 로 보내고, 중앙은 정제해 이 캐시에 넣은 뒤 vcenter 객체에서 지운다(central.js).
import { parseObjectContent } from '../vcenter/soapParse.js';
import { parseTriggeredAlarms, parseTaskInfo, parsePermissions, parseRoleList, nameMapOf, mergeTasks, VCINFO_LIMITS,
  parseTopologyNodes, parseReplication, parseApplianceUpdate, parsePendingUpdates, parseVlcmCompliance, restErrText, VCREST_LIMITS } from './parse.js';
import { VCenterClient } from '../vcenter/restClient.js';   // v2.897 ④(restClient 는 soapClient 를 import 하지 않는다 — 순환 없음)

/** 종류별 갱신 주기(ms) — 화면은 API 의 refreshMs 로 말한다(숫자를 화면에 박지 않는다). */
export const VCINFO_REFRESH_MS = Object.freeze({ alarms: 5 * 60_000, tasks: 3 * 60_000, perms: 6 * 3_600_000, linked: 6 * 3_600_000, updates: 6 * 3_600_000, vlcm: 6 * 3_600_000 });
/** ④ REST 묶음(Linked Mode · 업데이트 · vLCM)의 예산 — 클러스터마다 2번 왕복(고RTT 800ms+)이라 SOAP 묶음과 따로 둔다. */
export const VCREST_BUDGET_MS = 30_000;
export const VCINFO_KIND_LIST = Object.freeze(['alarms', 'tasks', 'perms', 'linked', 'updates', 'vlcm']);
/** 중단 · 시한 실패는 '이번에 못 읽었다' — 주기를 기다리지 않고 이 간격 뒤 다시 읽는다(tags 의 TAG_RETRY_MS 와 같은 판단). */
export const VCINFO_RETRY_MS = 5 * 60_000;
export const VCINFO_BUDGET_MS = 20_000;
const ALARM_NAME_TTL_MS = 6 * 3_600_000;
const NAME_TYPES = new Set(['VirtualMachine', 'HostSystem', 'Datastore', 'ClusterComputeResource', 'ComputeResource', 'Datacenter', 'Folder', 'ResourcePool',
  'VirtualApp', 'Network', 'DistributedVirtualPortgroup', 'VmwareDistributedVirtualSwitch', 'DistributedVirtualSwitch', 'StoragePod', 'OpaqueNetwork']);
const NAME_LOOKUP_MAX = 400;

const _byVc = new Map();     // vcId -> { alarms, tasks, perms, source:'local'|'edge', agent? }
const _alarmNames = new Map(); // vcId -> Map(alarmRef -> { name, at })

export function getVcInfo(vcId) { return _byVc.get(vcId) || null; }
/** 엣지 push 용 — 이 포탈이 가진 그 vCenter 의 값(직접 읽었거나 하위 엣지에서 받은 것 — 중계 구성에서도 위로 전달된다). 중앙의 수신 정제가 다시 좁힌다. */
export function vcInfoForPush(vcId) {
  const e = _byVc.get(vcId);
  if (!e) return null;
  const out = {};
  for (const k of VCINFO_KIND_LIST) if (e[k]) out[k] = stripRetry(e[k]);
  return Object.keys(out).length ? out : null;
}
const stripRetry = (k) => { const { retryAt, ...rest } = k; void retryAt; return rest; };
/**
 * 중앙 수신(central.js) — 정제된 값만. **받은 것으로 통째로 바꾼다**: 엣지가 그 종류를 아직 안 읽었으면 키가 없고, 엣지가 캐시를 비웠으면
 * (접속처 변경 · 삭제) vcInfo 자체가 없다 — 그때 중앙도 엣지 출처 항목을 지운다(옛 vCenter 의 권한 목록을 계속 보이지 않게).
 * 이 포탈이 직접 읽은 항목(source 'local')은 엣지 push 로 지우지 않는다(direct vCenter 는 central.js 가 미리 거부한다).
 */
export function putFromEdge(vcId, info, agent) {
  const prev = _byVc.get(vcId);
  if (prev && prev.source === 'local') return;
  if (!info || typeof info !== 'object' || !Object.keys(info).length) { if (prev) _byVc.delete(vcId); return; }
  _byVc.set(vcId, { ...info, source: 'edge', agent: String(agent || '').slice(0, 64) || null, pushAt: Date.now() });
}
/** 캐시에 있는 vCenter id(hostcfg/cache.js syncVcConfigCaches 가 등록부에 없는 것을 지운다). */
export function vcInfoIds() { return [..._byVc.keys()]; }
export function vcInfoStatus() {
  const out = [];
  for (const [vcId, e] of _byVc) {
    out.push({ vcenterId: vcId, source: e.source, ...Object.fromEntries(VCINFO_KIND_LIST.map((k) => [k, e[k] ? { at: e[k].at ?? null, n: Array.isArray(e[k].items) ? e[k].items.length : null, error: e[k].error ?? null } : null])) });
  }
  return { vcenters: out.slice(0, 64), omitted: Math.max(0, out.length - 64) };
}
/** 그 vCenter 의 캐시를 버린다 — 삭제됐거나 접속처가 바뀌었다(hostcfg/cache.js syncVcConfigCaches). */
export function dropVcCache(vcId) { _byVc.delete(vcId); _alarmNames.delete(vcId); }
export function _resetVcInfo() { _byVc.clear(); _alarmNames.clear(); }

/**
 * TaskManager.recentTask(ArrayOfManagedObjectReference) → Task moref. 기존 parseMorefs 는 '[^>]*' 를 두 번 써 닫히지 않은 원소가 반복되면
 * 2차 시간이다(반증 하-4 — 96KB 653ms). 여기서는 원소 모양을 고정하고(속성은 type · 선택 xsi:type) 길이를 먼저 자른다(선형).
 */
export function taskRefsOf(xml) {
  const out = [];
  const re = /<ManagedObjectReference(?: xsi:type="ManagedObjectReference")? type="Task">([\w.:-]{1,64})<\/ManagedObjectReference>/g;
  const s = String(xml || '').slice(0, 1_000_000);
  let m;
  while ((m = re.exec(s)) && out.length < 1000) out.push(m[1]);
  return out;
}
const msg = (e) => String(e?.message || e || '조회 실패').slice(0, 300);
const isTransient = (err, signal) => !!signal?.aborted || err?.name === 'AbortError' || err?.name === 'TimeoutError'
  || /abort|timed? ?out|timeout|데드라인|시한|중단/i.test(String(err?.message || err || ''));
// 다음 시도: retryAt 이 있으면 그때(실패 · 건너뜀은 항상 retryAt 을 단다), 없으면 마지막 성공(at) + 주기. 한 번도 성공하지 못한 종류도
//   retryAt(주기 뒤)까지는 묻지 않는다 — 권한 부족 vCenter 에 매 수집 주기 요청을 보내지 않게.
export const vcInfoDue = (k, kind, now) => !k || (k.retryAt != null ? now >= k.retryAt : now - (k.at ?? 0) >= VCINFO_REFRESH_MS[kind]);

/** 여러 타입의 객체 이름을 한 번에 — 하나라도 없는 객체(방금 지워짐)가 있으면 vCenter 가 요청 전체를 거부하므로 실패는 이름 없음으로 둔다. */
async function lookupNames(c, refs) {
  const uniq = [...new Map(refs.filter((r) => r && NAME_TYPES.has(r.type)).map((r) => [`${r.type}:${r.ref}`, r])).values()].slice(0, NAME_LOOKUP_MAX);
  if (!uniq.length) return new Map();
  const types = [...new Set(uniq.map((r) => r.type))];
  const body = `<RetrieveProperties xmlns="urn:vim25"><_this type="PropertyCollector">${c.sc.propertyCollector}</_this><specSet>`
    + types.map((t) => `<propSet><type>${t}</type><pathSet>name</pathSet></propSet>`).join('')
    + uniq.map((r) => `<objectSet><obj type="${r.type}">${r.ref}</obj></objectSet>`).join('')
    + '</specSet></RetrieveProperties>';
  try { return nameMapOf(parseObjectContent(await c.callRaw(body))); } catch { return new Map(); }
}

async function readAlarms(c, vcId, now) {
  const root = c.sc?.rootFolder;
  if (!root) throw new Error('rootFolder 없음');
  const objs = await c.retrieveObjectProps('Folder', root, ['triggeredAlarmState']);
  const { items, omitted } = parseTriggeredAlarms(objs[0]?.props?.triggeredAlarmState || '');
  // 알람 정의 이름 — 정의는 거의 바뀌지 않으므로 6시간 기억한다(매 갱신마다 묻지 않게).
  const names = _alarmNames.get(vcId) || new Map();
  const need = [...new Set(items.map((a) => a.alarm))].filter((r) => { const n = names.get(r); return !n || now - n.at > ALARM_NAME_TTL_MS; });
  if (need.length) {
    try {
      for (const o of await c.retrieveManyObjectProps('Alarm', need, ['info.name'])) {
        const n = typeof o.props?.['info.name'] === 'string' ? o.props['info.name'].trim().slice(0, 256) : '';
        if (n) names.set(o.ref, { name: n, at: now });
      }
    } catch { /* 이름을 못 읽어도 알람은 싣는다(이름 null — 화면이 정의 참조를 보인다) */ }
    _alarmNames.set(vcId, names);
  }
  const ent = await lookupNames(c, items.map((a) => ({ type: a.entityType, ref: a.entity })));
  for (const a of items) { a.name = names.get(a.alarm)?.name || null; a.entityName = ent.get(`${a.entityType}:${a.entity}`) || null; }
  items.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  return { at: now, items, omitted, error: null };
}

async function readTasks(c, prev, now) {
  const tm = c.sc?.taskManager;
  if (!tm) throw new Error('taskManager 없음');
  const objs = await c.retrieveObjectProps('TaskManager', tm, ['recentTask']);
  const refs = taskRefsOf(objs[0]?.props?.recentTask).slice(0, VCINFO_LIMITS.tasks);
  let fresh = [];
  if (refs.length) {
    // 작업은 끝나면 곧 사라진다 — 목록과 info 사이에 지워진 작업이 있으면 vCenter 가 요청 전체를 거부한다(ManagedObjectNotFound).
    //   그때는 하나씩 다시 묻지 않고(왕복 N 번) 이번 갱신을 실패로 두고 직전 버퍼를 유지한다 — 다음 주기에 다시 읽는다.
    const infos = await c.retrieveManyObjectProps('Task', refs, ['info']);
    fresh = infos.map((o) => parseTaskInfo(o.props?.info)).filter(Boolean);
  }
  return { at: now, items: mergeTasks(prev?.items, fresh, { now }), error: null };
}

async function readPerms(c, now) {
  const am = c.sc?.authorizationManager;
  if (!am) throw new Error('authorizationManager 없음');
  const xml = await c.callRaw(`<RetrieveAllPermissions xmlns="urn:vim25"><_this type="AuthorizationManager">${am}</_this></RetrieveAllPermissions>`);
  const { items, omitted } = parsePermissions(xml);
  let roles = [];
  try {
    const r = await c.retrieveObjectProps('AuthorizationManager', am, ['roleList']);
    roles = parseRoleList(r[0]?.props?.roleList || '');
  } catch { /* 역할 이름을 못 읽으면 roleId 만 보인다 */ }
  const byId = new Map(roles.map((r) => [r.id, r]));
  const ent = await lookupNames(c, items.map((p) => ({ type: p.entityType, ref: p.entity })));
  for (const p of items) { const r = byId.get(p.roleId); p.role = r ? (r.label || r.name) : null; p.entityName = ent.get(`${p.entityType}:${p.entity}`) || null; }
  return { at: now, items, roles, omitted, error: null };
}

/**
 * @param c 로그인된 SOAP 클라이언트 · vc 등록 항목
 * @returns 이 vCenter 의 캐시(종류별 — 갱신한 것만 새 값)
 */
export async function refreshVcInfo(c, vc, { now = Date.now(), signal = null, budgetMs = VCINFO_BUDGET_MS } = {}) {
  const prev = _byVc.get(vc.id);
  const cur = prev && prev.source === 'local' ? { ...prev } : { source: 'local' };
  const deadline = Date.now() + budgetMs;   // 예산은 실제 시계로 잰다(now 는 기록 · 주기 판정용 — 테스트가 고정한다)
  const jobs = [
    ['alarms', () => readAlarms(c, vc.id, now)],
    ['tasks', () => readTasks(c, cur.tasks, now)],
    ['perms', () => readPerms(c, now)],
  ];
  await runJobs(cur, jobs, now, deadline, signal);
  _byVc.set(vc.id, cur);
  return cur;
}

async function runJobs(cur, jobs, now, deadline, signal) {
  for (const [kind, fn] of jobs) {
    if (!vcInfoDue(cur[kind], kind, now)) continue;
    if (signal?.aborted || Date.now() >= deadline) { cur[kind] = { ...(cur[kind] || { at: null, items: [] }), retryAt: now + VCINFO_RETRY_MS }; continue; }
    try {
      cur[kind] = await fn();
    } catch (err) {
      // 직전 값을 지우지 않는다 — 오류만 싣는다. 중단 · 시한이면 짧게(VCINFO_RETRY_MS), 권한 부족 같은 실패는 주기 뒤에 다시.
      const keep = cur[kind] || { at: null, items: [] };
      cur[kind] = { ...keep, error: kind === 'linked' || kind === 'updates' || kind === 'vlcm' ? restErrText(err) : msg(err), retryAt: now + (isTransient(err, signal) ? VCINFO_RETRY_MS : VCINFO_REFRESH_MS[kind]) };
    }
  }
}

// ── ④ REST 묶음 ──────────────────────────────────────────────────────────────
async function readLinked(rc, now) {
  const nodes = parseTopologyNodes(await rc.topologyNodes());
  let domain = null; let replication = []; let replError = null;
  if (nodes[0]) { try { const i = await rc.topologyNode(nodes[0].node); domain = typeof (i?.value ?? i)?.domain === 'string' ? String((i.value ?? i).domain).slice(0, 255) : null; } catch { /* 도메인만 모른다 */ } }
  try { replication = parseReplication(await rc.topologyReplication()); } catch (e) { replError = restErrText(e); }
  return { at: now, nodes, domain, replication, error: null, replError };
}
async function readUpdates(rc, now) {
  const st = parseApplianceUpdate(await rc.applianceUpdate());
  let pending = []; let pendingError = null;
  // 마지막 확인 결과만(LAST_CHECK) — 새 확인(외부 저장소 조회)을 일으키지 않는다. 확인한 적이 없으면 404 일 수 있다(추정) — 그 사실만 싣는다.
  try { pending = parsePendingUpdates(await rc.applianceUpdatePending()); } catch (e) { pendingError = restErrText(e); }
  return { at: now, ...st, pending, error: null, pendingError };
}
async function readVlcm(rc, clusters, prev, now, deadline) {
  const prevBy = new Map((prev?.items || []).map((x) => [x.cluster, x]));
  const items = [];
  // 시한에 걸려 일부만 읽었으면 다음 시도는 오래 전에 읽은(또는 못 읽은) 클러스터부터 — 앞쪽만 계속 읽지 않게.
  const list = clusters.slice(0, VCREST_LIMITS.clusters).sort((a, b) => (prevBy.get(a.ref)?.at ?? 0) - (prevBy.get(b.ref)?.at ?? 0));
  let cut = 0;
  for (const cl of list) {
    if (Date.now() >= deadline) { const p = prevBy.get(cl.ref); if (p) items.push(p); cut += 1; continue; }
    const row = { cluster: cl.ref, name: cl.name || null, at: now, enabled: null, status: null, impact: null, scanTime: null, counts: null, nc: [], error: null };
    try {
      const en = await rc.vlcmEnablement(cl.ref);
      row.enabled = (en?.value ?? en)?.enabled === true ? true : (en?.value ?? en)?.enabled === false ? false : null;
      // 이미지로 관리하지 않는 클러스터(베이스라인)는 준수를 묻지 않는다 — 스캔을 일으키지도 않는다(마지막 결과만 읽는 GET).
      if (row.enabled === true) Object.assign(row, parseVlcmCompliance(await rc.vlcmCompliance(cl.ref)));
    } catch (e) { row.error = restErrText(e); }
    items.push(row);
  }
  if (cut) return { at: now, items, omitted: Math.max(0, clusters.length - list.length), error: null, partial: cut, retryAt: now + VCINFO_RETRY_MS };
  return { at: now, items, omitted: Math.max(0, clusters.length - list.length), error: null };
}

/**
 * ④ REST 묶음 갱신 — 셋 중 하나라도 때가 됐을 때만 REST 세션을 연다(로그인 거부는 그 종류들의 오류로만 — 주기 정지로 올리지 않는다:
 * 같은 계정의 SOAP 로그인이 방금 성공했다. tags/collect.js 와 같은 판단).
 * @param clusters [{ref, name}] 이 vCenter 의 클러스터(SOAP 수집이 이미 가진 moref)
 */
export async function refreshVcRest(vc, clusters, { now = Date.now(), signal = null, budgetMs = VCREST_BUDGET_MS, client = null } = {}) {
  const prev = _byVc.get(vc.id);
  const cur = prev && prev.source === 'local' ? { ...prev } : { ...(prev || {}), source: 'local' };
  const kinds = ['linked', 'updates', 'vlcm'].filter((k) => vcInfoDue(cur[k], k, now));
  if (!kinds.length) return cur;
  const deadline = Date.now() + budgetMs;
  const rc = client || new VCenterClient(vc, { signal });   // client 는 테스트 주입용
  try {
    await rc.login();
  } catch (err) {
    for (const k of kinds) cur[k] = { ...(cur[k] || { at: null }), error: `REST 로그인 실패 — ${restErrText(err)}`, retryAt: now + (isTransient(err, signal) ? VCINFO_RETRY_MS : VCINFO_REFRESH_MS[k]) };
    _byVc.set(vc.id, cur);
    return cur;
  }
  try {
    await runJobs(cur, [
      ['linked', () => readLinked(rc, now)],
      ['updates', () => readUpdates(rc, now)],
      ['vlcm', () => readVlcm(rc, Array.isArray(clusters) ? clusters : [], cur.vlcm, now, deadline)],
    ], now, deadline, signal);
  } finally {
    await rc.logout();
  }
  _byVc.set(vc.id, cur);
  return cur;
}
