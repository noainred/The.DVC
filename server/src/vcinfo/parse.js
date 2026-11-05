// vCenter 알람 · 최근 작업 · 권한 목록(v2.898) — 순수 파서 · 정제. 수집(collect.js) · 엣지 수신 정제(central) · 라우트가 같은 모양을 쓴다.
//
// 모양(캐시 · 엣지 push · API 공통 — 종류마다 { at, items, error, ... }. at 이 null 이면 아직 읽지 않음):
//   alarms: { at, items:[{ alarm, name, entityType, entity, entityName, status:'red'|'yellow'|'gray'|'green'|null, time, ack, ackBy, ackTime }], omitted, error }
//   tasks:  { at, items:[{ key, op, entityType, entity, entityName, state, progress, queued, started, completed, user, reason, error }], error }
//   perms:  { at, items:[{ entityType, entity, entityName, principal, group, roleId, role, propagate }], roles:[{ id, name, label, system, privileges }], omitted, error }
//   - 못 읽은 값은 null(지어내지 않는다). 시각은 ms epoch.
//   - 권한 목록(사용자 · 그룹 이름)은 관리자 판본에서만 응답에 싣는다(라우트 — isAdminDetailUser). 이 모듈은 가리지 않는다.
// 정규식은 전부 '[^<]*'(다음 '<' 에서 멈춘다) 또는 길이 상한이 있는 반복이고, 입력 길이를 먼저 자른다(정규식 규칙).
import { xmlUnescape } from '../vcenter/soapParse.js';
import { flatStr } from '../util/capStr.js';   // v2.899(점검 E2): 캐시에 남는 글자는 응답 원문을 붙잡지 않게 평탄화

export const VCINFO_LIMITS = Object.freeze({ alarms: 500, tasks: 200, perms: 1000, roles: 200, xml: 4_000_000 });
const MOREF_RE = /^[\w.:-]{1,64}$/;
const TYPE_RE = /^[A-Za-z]{1,48}$/;
const STATUS = new Set(['red', 'yellow', 'gray', 'green']);
const TASK_STATES = new Set(['queued', 'running', 'success', 'error']);

// ⚠ v2.899(점검 E2 — 재현): xmlUnescape · trim · slice 는 바꿀 것이 없으면 응답 원문의 부분 문자열(SlicedString)을 돌려준다 —
//   작업 버퍼(24시간) · 권한 목록 캐시가 회차마다 SOAP 응답 원문 전체를 붙잡았다(util/capStr.js 와 같은 메커니즘). 평탄화해서 넣는다.
const capTxt = (s, n) => {
  if (s == null) return null;
  const t = xmlUnescape(String(s)).trim();
  return t ? flatStr(t.slice(0, n)) : null;
};
const tsOf = (s) => { if (!s) return null; const t = Date.parse(s); return Number.isFinite(t) && t > 0 ? t : null; };
const first = (blk, tag) => {
  const m = new RegExp(`<${tag}(?:\\s[^>]{0,200})?>([^<]*)</${tag}>`).exec(blk);
  return m ? m[1] : null;
};
// v2.899(점검 E1): 속성 순서와 무관하게 받는다(xsi:type 이 type 앞이든 뒤든) — 속성 칸은 200자까지(선형). 'type=' 앞은 공백이어야 한다(xsi:type 과 구분).
const ATTR_TYPE_RE = /(?:^|\s)type="([A-Za-z]{1,48})"/;
const refOf = (blk, tag) => {
  const m = new RegExp(`<${tag}(\\s[^>]{0,200})>([^<]{1,64})</${tag}>`).exec(blk);
  const t = m ? ATTR_TYPE_RE.exec(m[1])?.[1] : null;
  const r = m ? m[2].trim() : '';
  return t && MOREF_RE.test(r) ? { type: flatStr(t), ref: flatStr(r) } : null;
};
/** 첫 open(정규식) 부터 그 뒤 첫 close(글자)까지 — indexOf 로 찾는다(되짚는 반복 없이 선형). 없으면 ''. */
function between(s, open, close) {
  const i = s.search(open);
  if (i < 0) return '';
  const j = s.indexOf(close, i);
  return j < 0 ? '' : s.slice(i, j + close.length);
}
/** 배열 속성 XML 을 원소 블록으로 — 원소 이름은 타입 이름(<AlarmState>) 또는 속성 이름(<triggeredAlarmState>) 둘 다 받는다(layoutFileBlocks 와 같은 판단). */
const blocks = (xml, names) => String(xml || '').slice(0, VCINFO_LIMITS.xml).split(new RegExp(`<(?:${names.join('|')})(?=[\\s>])`)).slice(1);

/** Folder(rootFolder) 'triggeredAlarmState' XML → [{alarm, entityType, entity, status, time, ack, ackBy, ackTime}] (이름은 collect 가 채운다). */
export function parseTriggeredAlarms(xml) {
  const out = [];
  let omitted = 0; let unreadable = 0;
  for (const blk of blocks(xml, ['AlarmState', 'triggeredAlarmState'])) {
    const alarm = refOf(blk, 'alarm');
    const ent = refOf(blk, 'entity');
    if (!alarm || !ent) { unreadable += 1; continue; }   // v2.899(점검 E1): 못 읽은 원소는 센다 — '알람 없음' 과 구분
    if (out.length >= VCINFO_LIMITS.alarms) { omitted += 1; continue; }
    const st = first(blk, 'overallStatus');
    const ack = first(blk, 'acknowledged');
    out.push({
      alarm: alarm.ref, name: null, entityType: ent.type, entity: ent.ref, entityName: null,
      status: STATUS.has(st) ? st : null,
      time: tsOf(first(blk, 'time')),
      ack: ack === 'true' ? true : ack === 'false' ? false : null,
      ackBy: capTxt(first(blk, 'acknowledgedByUser'), 128),
      ackTime: tsOf(first(blk, 'acknowledgedTime')),
    });
  }
  return { items: out, omitted, unreadable };
}

/** TaskManager 'recentTask' 의 Task 하나의 'info'(TaskInfo) XML → 작업 행. 필드 순서(vim25): … entity → entityName → state → … error → result → progress → reason → queueTime … */
export function parseTaskInfo(xml) {
  const s = String(xml || '').slice(0, 200_000);
  const key = capTxt(first(s, 'key'), 64);
  if (!key) return null;
  // error(LocalizedMethodFault) 안에는 fault 필드로 <reason> 이 올 수 있다(DasConfigFault 등 — 반증 하-2) — 오류 블록을 먼저 떼어 낸다.
  //   그 뒤 result · reason 안에도 같은 이름 태그가 있을 수 있다(TaskReasonAlarm.entityName) — 그 앞까지만 본다.
  const errBlk = between(s, /<error(?=[\s>])/, '</error>');
  const rest = errBlk ? s.replace(errBlk, '') : s;
  const cut = rest.search(/<(?:result|reason)(?=[\s>])/);
  const head = cut >= 0 ? rest.slice(0, cut) : rest;
  const ent = refOf(head, 'entity');
  const state = first(head, 'state');
  const rs = rest.search(/<reason(?=[\s>])/);
  const reasonBlk = rs >= 0 ? between(rest.slice(rs), /<reason(?=[\s>])/, '</reason>') : '';
  const reasonType = reasonBlk ? /^<reason[^>]{0,200}xsi:type="(TaskReason\w{1,32})"/.exec(reasonBlk)?.[1] || null : null;
  const prog = first(head, 'progress');
  const progress = prog != null && /^\d{1,3}$/.test(prog) ? Math.min(100, Number(prog)) : null;
  return {
    key,
    op: capTxt(first(head, 'descriptionId'), 128) || capTxt(first(head, 'name'), 128),
    entityType: ent?.type || null, entity: ent?.ref || null,
    entityName: capTxt(first(head, 'entityName'), 128),
    state: TASK_STATES.has(state) ? state : null,
    progress,
    queued: tsOf(first(s, 'queueTime')), started: tsOf(first(s, 'startTime')), completed: tsOf(first(s, 'completeTime')),
    user: reasonType === 'TaskReasonUser' ? capTxt(first(reasonBlk, 'userName'), 128) : null,
    reason: reasonType === 'TaskReasonUser' ? 'user' : reasonType === 'TaskReasonSchedule' ? 'schedule' : reasonType === 'TaskReasonAlarm' ? 'alarm' : reasonType === 'TaskReasonSystem' ? 'system' : null,
    error: errBlk ? capTxt(first(errBlk, 'localizedMessage'), 300) || '오류(메시지 없음)' : null,
  };
}

/** RetrieveAllPermissions 응답 XML → [{entityType, entity, principal, group, roleId, propagate}]. */
export function parsePermissions(xml) {
  const out = [];
  let omitted = 0;
  const s = String(xml || '').slice(0, VCINFO_LIMITS.xml);
  // 응답 원소는 <returnval>…</returnval> — Permission 은 중첩 원소가 없다(entity · principal · group · roleId · propagate).
  //   split 으로 나누고 각 조각의 첫 '</returnval>' 까지만 본다(선형).
  for (const part of s.split(/<returnval(?=[\s>])/).slice(1)) {
    const end = part.indexOf('</returnval>');
    if (end < 0) continue;
    const blk = part.slice(0, end);
    const ent = refOf(blk, 'entity');
    const principal = capTxt(first(blk, 'principal'), 256);
    const roleId = first(blk, 'roleId');
    if (!ent || !principal || roleId == null || !/^-?\d{1,10}$/.test(roleId.trim())) continue;
    if (out.length >= VCINFO_LIMITS.perms) { omitted += 1; continue; }
    const g = first(blk, 'group'); const p = first(blk, 'propagate');
    out.push({ entityType: ent.type, entity: ent.ref, entityName: null, principal, group: g === 'true' ? true : g === 'false' ? false : null, roleId: Number(roleId), role: null, propagate: p === 'true' ? true : p === 'false' ? false : null });
  }
  return { items: out, omitted };
}

/** AuthorizationManager 'roleList' XML → [{id, name, label, system, privileges}]. 권한(privilege) 이름은 싣지 않고 개수만. */
export function parseRoleList(xml) {
  const out = [];
  for (const blk of blocks(xml, ['AuthorizationRole', 'roleList'])) {
    const id = first(blk, 'roleId');
    if (id == null || !/^-?\d{1,10}$/.test(id.trim())) continue;
    if (out.length >= VCINFO_LIMITS.roles) break;
    const sys = first(blk, 'system');
    let privileges = 0;
    const pr = /<privilege>/g;
    while (pr.exec(blk)) privileges += 1;
    out.push({ id: Number(id), name: capTxt(first(blk, 'name'), 128), label: capTxt(first(blk, 'label'), 128), system: sys === 'true' ? true : sys === 'false' ? false : null, privileges });
  }
  return out;
}

/** RetrieveProperties('name') 결과 [{type, ref, props:{name}}] → Map('Type:ref' → 이름). */
export function nameMapOf(objs) {
  const m = new Map();
  for (const o of Array.isArray(objs) ? objs : []) {
    const n = capTxt(o?.props?.name, 128);
    if (o?.type && o?.ref && n) m.set(`${o.type}:${o.ref}`, n);
  }
  return m;
}

/** 작업 버퍼 보관 기간(화면은 API 의 limits.keepMs 로 말한다). */
export const TASK_KEEP_MS = 24 * 3_600_000;
/**
 * 작업 버퍼 병합 — 새로 읽은 것이 같은 key 를 덮고, keepMs 보다 오래된 것(끝났든 아니든)과 상한 밖은 버린다(최신 순).
 * 실행 중 · 대기로 기억한 작업이 새 목록(recentTask)에서 끝난 모습을 보이지 않고 사라졌으면 상태를 모른다(null) — 영원히 '실행 중' 으로 두지 않는다(반증 하-3).
 */
export function mergeTasks(prev, fresh, { now = Date.now(), keepMs = TASK_KEEP_MS, max = VCINFO_LIMITS.tasks } = {}) {
  const byKey = new Map();
  const freshKeys = new Set((Array.isArray(fresh) ? fresh : []).map((t) => t?.key).filter(Boolean));
  for (const t of Array.isArray(prev) ? prev : []) {
    if (!t?.key) continue;
    byKey.set(t.key, !freshKeys.has(t.key) && (t.state === 'running' || t.state === 'queued') ? { ...t, state: null, progress: null, lost: true } : t);
  }
  for (const t of Array.isArray(fresh) ? fresh : []) if (t?.key) byKey.set(t.key, t);
  const when = (t) => t.completed ?? t.started ?? t.queued ?? 0;
  return [...byKey.values()]
    .filter((t) => !(when(t) && now - when(t) > keepMs))
    .sort((a, b) => when(b) - when(a))
    .slice(0, max);
}

// ── 엣지 수신 정제 ──────────────────────────────────────────────────────────────
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const ts = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const bool = (v) => (v === true || v === false ? v : null);
const ref = (v) => (typeof v === 'string' && MOREF_RE.test(v) ? v : null);
const typ = (v) => (typeof v === 'string' && TYPE_RE.test(v) ? v : null);
const int = (v) => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const cnt = (v) => { const n = int(v); return n != null && n >= 0 ? n : 0; };
const head = (k) => ({ at: ts(k.at), error: str(k.error, 300) });

function sanAlarms(k) {
  if (!isObj(k)) return null;
  const items = (Array.isArray(k.items) ? k.items : []).slice(0, VCINFO_LIMITS.alarms).filter(isObj).map((x) => ({
    alarm: ref(x.alarm), name: str(x.name, 256), entityType: typ(x.entityType), entity: ref(x.entity), entityName: str(x.entityName, 128),
    status: STATUS.has(x.status) ? x.status : null, time: ts(x.time), ack: bool(x.ack), ackBy: str(x.ackBy, 128), ackTime: ts(x.ackTime),
  }));
  return { ...head(k), items, omitted: cnt(k.omitted), ...(cnt(k.unreadable) ? { unreadable: cnt(k.unreadable) } : {}) };
}
function sanTasks(k) {
  if (!isObj(k)) return null;
  const items = (Array.isArray(k.items) ? k.items : []).slice(0, VCINFO_LIMITS.tasks).filter(isObj).map((x) => ({
    key: str(x.key, 64), op: str(x.op, 128), entityType: typ(x.entityType), entity: ref(x.entity), entityName: str(x.entityName, 128),
    state: TASK_STATES.has(x.state) ? x.state : null, progress: int(x.progress) != null && x.progress >= 0 && x.progress <= 100 ? x.progress : null,
    queued: ts(x.queued), started: ts(x.started), completed: ts(x.completed), user: str(x.user, 128),
    reason: ['user', 'schedule', 'alarm', 'system'].includes(x.reason) ? x.reason : null, error: str(x.error, 300), ...(x.lost === true ? { lost: true } : {}),
  })).filter((x) => x.key);
  return { ...head(k), items };
}
function sanPerms(k) {
  if (!isObj(k)) return null;
  const items = (Array.isArray(k.items) ? k.items : []).slice(0, VCINFO_LIMITS.perms).filter(isObj).map((x) => ({
    entityType: typ(x.entityType), entity: ref(x.entity), entityName: str(x.entityName, 128), principal: str(x.principal, 256),
    group: bool(x.group), roleId: int(x.roleId), role: str(x.role, 128), propagate: bool(x.propagate),
  })).filter((x) => x.principal && x.roleId != null);
  const roles = (Array.isArray(k.roles) ? k.roles : []).slice(0, VCINFO_LIMITS.roles).filter(isObj).map((x) => ({
    id: int(x.id), name: str(x.name, 128), label: str(x.label, 128), system: bool(x.system), privileges: cnt(x.privileges),
  })).filter((x) => x.id != null);
  return { ...head(k), items, roles, omitted: cnt(k.omitted) };
}

/** 엣지가 보낸 vcInfo → 같은 모양으로 다시 좁힌다. 객체가 아니면 null(= 받지 않음). 종류가 없으면 그 키를 싣지 않는다. */
export function sanitizeVcInfo(v) {
  if (!isObj(v)) return null;
  const out = {};
  if (Object.hasOwn(v, 'alarms')) out.alarms = sanAlarms(v.alarms);
  if (Object.hasOwn(v, 'tasks')) out.tasks = sanTasks(v.tasks);
  if (Object.hasOwn(v, 'perms')) out.perms = sanPerms(v.perms);
  if (Object.hasOwn(v, 'pools')) out.pools = sanitizePools(v.pools);   // v2.899 리소스 풀
  return sanitizeVcRestInfo(v, out);   // v2.898 ④ linked · updates · vlcm
}

// ── v2.898 ④ REST(읽기 전용): Linked Mode 구성원 · 어플라이언스 업데이트 · vLCM 이미지 준수 ─────────────────────────────
// 모양:
//   linked:  { at, nodes:[{ node, type, partners:[] }], domain, replication:[{ node, partner, available, replicating, lag }], error, replError }
//   updates: { at, state, version, lastCheck, pending:[{ version, name, severity, priority, type, releaseDate, reboot, sizeMB }], error, pendingError }
//   vlcm:    { at, items:[{ cluster, name, enabled, status, impact, scanTime, counts:{compliant,nonCompliant,incompatible,unavailable}, nc:[{id,name}], error }], omitted, error }
// REST 응답은 /api 의 맨몸 JSON 이지만 옛 래핑({value}) 도 받는다. 모르는 값은 null.
export const VCREST_LIMITS = Object.freeze({ nodes: 32, partners: 16, pending: 30, clusters: 64, nc: 100 });
const UPD_STATES = new Set(['UP_TO_DATE', 'UPDATES_PENDING', 'STAGE_IN_PROGRESS', 'INSTALL_IN_PROGRESS', 'INSTALL_FAILED', 'ROLLBACK_IN_PROGRESS']);
const VLCM_STATUS = new Set(['COMPLIANT', 'NON_COMPLIANT', 'INCOMPATIBLE', 'UNAVAILABLE']);
const unwrap = (v) => (isObj(v) && Object.hasOwn(v, 'value') && Object.keys(v).length === 1 ? v.value : v);
const strU = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const tsStr = (v) => (typeof v === 'string' ? tsOf(v) : ts(v));
const enumOf = (v, re) => (typeof v === 'string' && re.test(v) ? v : null);

export function parseTopologyNodes(raw) {
  const arr = unwrap(raw);
  return (Array.isArray(arr) ? arr : []).filter(isObj).slice(0, VCREST_LIMITS.nodes).map((n) => ({
    node: strU(n.node, 255),
    type: enumOf(n.type, /^[A-Z_]{1,32}$/),
    partners: (Array.isArray(n.replication_partners) ? n.replication_partners : []).map((x) => strU(x, 255)).filter(Boolean).slice(0, VCREST_LIMITS.partners),
  })).filter((n) => n.node);
}
export function parseReplication(raw) {
  const arr = unwrap(raw);
  return (Array.isArray(arr) ? arr : []).filter(isObj).slice(0, VCREST_LIMITS.nodes * 4).map((r) => ({
    node: strU(r.node, 255), partner: strU(r.replication_partner, 255),
    available: r.partner_available === true ? true : r.partner_available === false ? false : null,
    replicating: r.replicating === true ? true : r.replicating === false ? false : null,
    lag: typeof r.change_lag === 'number' && Number.isFinite(r.change_lag) && r.change_lag >= 0 ? Math.trunc(r.change_lag) : null,
  })).filter((r) => r.node);
}
export function parseApplianceUpdate(raw) {
  const v = unwrap(raw);
  if (!isObj(v)) return { state: null, version: null, lastCheck: null };
  return { state: UPD_STATES.has(v.state) ? v.state : enumOf(v.state, /^[A-Z_]{1,40}$/), version: strU(v.version, 64), lastCheck: tsStr(v.latest_query_time) };
}
export function parsePendingUpdates(raw) {
  const arr = unwrap(raw);
  return (Array.isArray(arr) ? arr : []).filter(isObj).slice(0, VCREST_LIMITS.pending).map((u) => ({
    version: strU(u.version, 64), name: strU(u.name, 200) || strU(u.description?.default_message, 200),
    severity: enumOf(u.severity, /^[A-Z_]{1,20}$/), priority: enumOf(u.priority, /^[A-Z_]{1,20}$/), type: enumOf(u.update_type, /^[A-Z_]{1,20}$/),
    releaseDate: tsStr(u.release_date), reboot: u.reboot_required === true ? true : u.reboot_required === false ? false : null,
    sizeMB: typeof u.size === 'number' && Number.isFinite(u.size) && u.size >= 0 ? Math.round(u.size) : null,
  })).filter((u) => u.version);
}
/** 준수 결과 → 상태 · 호스트 집합 수 · 미준수 호스트(이름은 host_info) — 상세 구성요소(base_image · components …)는 싣지 않는다. */
export function parseVlcmCompliance(raw) {
  const v = unwrap(raw);
  if (!isObj(v)) return { status: null, impact: null, scanTime: null, counts: null, nc: [] };
  const ids = (k) => (Array.isArray(v[k]) ? v[k].filter((x) => typeof x === 'string' && MOREF_RE.test(x)) : null);
  const info = isObj(v.host_info) ? v.host_info : {};
  const nameOf = (id) => strU(isObj(info[id]) ? info[id].name : null, 128);
  const nc = [...(ids('non_compliant_hosts') || []), ...(ids('incompatible_hosts') || [])].slice(0, VCREST_LIMITS.nc).map((id) => ({ id, name: nameOf(id) }));
  const n = (k) => { const a = ids(k); return a ? a.length : null; };
  return {
    status: VLCM_STATUS.has(v.status) ? v.status : null,
    impact: enumOf(v.impact, /^[A-Z_]{1,40}$/),
    scanTime: tsStr(v.scan_time),
    counts: { compliant: n('compliant_hosts'), nonCompliant: n('non_compliant_hosts'), incompatible: n('incompatible_hosts'), unavailable: n('unavailable_hosts') },
    nc,
  };
}
/** REST 오류 → 화면 문구(상태 코드로만 가른다 — 원문은 200자까지만 붙인다). */
export function restErrText(err, what = '') {
  const st = err?.status;
  const raw = String(err?.message || err || '').slice(0, 200);
  if (st === 401 || st === 403) return `권한 없음(${st})${what ? ` — ${what}` : ''}`;
  if (st === 404) return '이 vCenter 에 이 API 가 없습니다(404 — 버전이 낮거나 사용하지 않는 기능)';
  if (st === 503) return '서비스를 쓸 수 없습니다(503)';
  return raw || '조회 실패';
}

function sanLinked(k) {
  if (!isObj(k)) return null;
  return { at: ts(k.at), error: str(k.error, 300), replError: str(k.replError, 300), domain: str(k.domain, 255),
    nodes: parseTopologyNodes((Array.isArray(k.nodes) ? k.nodes : []).map((x) => (isObj(x) ? { node: x.node, type: x.type, replication_partners: x.partners } : null))),
    replication: (Array.isArray(k.replication) ? k.replication : []).filter(isObj).slice(0, VCREST_LIMITS.nodes * 4).map((r) => ({
      node: str(r.node, 255), partner: str(r.partner, 255), available: bool(r.available), replicating: bool(r.replicating), lag: cnt(r.lag) || (r.lag === 0 ? 0 : null),
    })).filter((r) => r.node) };
}
function sanUpdates(k) {
  if (!isObj(k)) return null;
  return { at: ts(k.at), error: str(k.error, 300), pendingError: str(k.pendingError, 300),
    state: typeof k.state === 'string' && /^[A-Z_]{1,40}$/.test(k.state) ? k.state : null, version: str(k.version, 64), lastCheck: ts(k.lastCheck),
    pending: (Array.isArray(k.pending) ? k.pending : []).filter(isObj).slice(0, VCREST_LIMITS.pending).map((u) => ({
      version: str(u.version, 64), name: str(u.name, 200), severity: enumOf(u.severity, /^[A-Z_]{1,20}$/), priority: enumOf(u.priority, /^[A-Z_]{1,20}$/),
      type: enumOf(u.type, /^[A-Z_]{1,20}$/), releaseDate: ts(u.releaseDate), reboot: bool(u.reboot), sizeMB: int(u.sizeMB) != null && u.sizeMB >= 0 ? u.sizeMB : null,
    })).filter((u) => u.version) };
}
function sanVlcm(k) {
  if (!isObj(k)) return null;
  const c = (v) => { const n = int(v); return n != null && n >= 0 ? n : null; };
  return { at: ts(k.at), error: str(k.error, 300), omitted: cnt(k.omitted), partial: cnt(k.partial),
    items: (Array.isArray(k.items) ? k.items : []).filter(isObj).slice(0, VCREST_LIMITS.clusters).map((x) => ({
      cluster: ref(x.cluster), name: str(x.name, 128), at: ts(x.at), enabled: bool(x.enabled), status: VLCM_STATUS.has(x.status) ? x.status : null,
      impact: enumOf(x.impact, /^[A-Z_]{1,40}$/), scanTime: ts(x.scanTime),
      counts: isObj(x.counts) ? { compliant: c(x.counts.compliant), nonCompliant: c(x.counts.nonCompliant), incompatible: c(x.counts.incompatible), unavailable: c(x.counts.unavailable) } : null,
      nc: (Array.isArray(x.nc) ? x.nc : []).filter(isObj).slice(0, VCREST_LIMITS.nc).map((h) => ({ id: ref(h.id), name: str(h.name, 128) })).filter((h) => h.id),
      error: str(x.error, 300),
    })).filter((x) => x.cluster) };
}
/** sanitizeVcInfo 의 REST 3종 몫 — 같은 규칙(받은 종류만 · 객체가 아니면 null). */
export function sanitizeVcRestInfo(v, out = {}) {
  if (!isObj(v)) return out;
  if (Object.hasOwn(v, 'linked')) out.linked = sanLinked(v.linked);
  if (Object.hasOwn(v, 'updates')) out.updates = sanUpdates(v.updates);
  if (Object.hasOwn(v, 'vlcm')) out.vlcm = sanVlcm(v.vlcm);
  return out;
}

// ── v2.899: 리소스 풀 예약 · 제한 · 공유(ResourcePool.config.cpuAllocation · memoryAllocation — 6시간마다) ──────────────
//   pools: { at, items:[{ ref, name, owner, root, cpu:{res,limit,expandable,shares,level}, mem:{…} }], omitted, error }
//   CPU 는 MHz, 메모리는 MB(vSphere ResourceAllocationInfo 단위). limit -1 = 무제한(그대로 -1). 못 읽은 값은 null.
export const POOLS_MAX = 500;
const SHARE_LEVELS = new Set(['low', 'normal', 'high', 'custom']);
const intTag = (x, t) => { const v = first(x, t); return v != null && /^-?\d{1,15}$/.test(v.trim()) ? Number(v) : null; };
export function parseAllocation(xml) {
  if (typeof xml !== 'string' || !xml) return null;
  // shares 는 <shares><shares>N</shares><level>…</level></shares> 로 중첩된다 — 글자만 든 안쪽 <shares> 와 하나뿐인 <level> 을 바로 읽는다.
  const lv = first(xml, 'level');
  const ex = first(xml, 'expandableReservation');
  return {
    res: intTag(xml, 'reservation'), limit: intTag(xml, 'limit'),
    expandable: ex === 'true' ? true : ex === 'false' ? false : null,
    shares: intTag(xml, 'shares'),
    level: lv && SHARE_LEVELS.has(lv) ? lv : null,
  };
}
/** RetrieveProperties 결과 [{ref, props}] → 풀 행. 루트 풀(부모가 클러스터 · 단독 호스트 — 'domain-' 으로 시작)은 root:true(클러스터 용량 그 자체라 예약 값이 크다). */
export function parsePools(objs) {
  const out = [];
  for (const o of Array.isArray(objs) ? objs : []) {
    if (!o?.ref || !MOREF_RE.test(o.ref)) continue;
    const p = o.props || {};
    const parent = typeof p.parent === 'string' ? p.parent.trim() : '';
    const owner = typeof p.owner === 'string' && MOREF_RE.test(p.owner.trim()) ? p.owner.trim() : null;
    out.push({ ref: o.ref, name: capTxt(p.name, 128), owner, root: parent ? parent.startsWith('domain-') : null,
      cpu: parseAllocation(p['config.cpuAllocation']), mem: parseAllocation(p['config.memoryAllocation']) });
  }
  return out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}
const sanAlloc = (a) => (isObj(a) ? {
  res: int(a.res), limit: int(a.limit), expandable: bool(a.expandable), shares: int(a.shares) != null && a.shares >= 0 ? a.shares : null,
  level: typeof a.level === 'string' && SHARE_LEVELS.has(a.level) ? a.level : null,
} : null);
export function sanitizePools(k) {
  if (!isObj(k)) return null;
  return { at: ts(k.at), error: str(k.error, 300), omitted: cnt(k.omitted),
    items: (Array.isArray(k.items) ? k.items : []).filter(isObj).slice(0, POOLS_MAX).map((x) => ({
      ref: ref(x.ref), name: str(x.name, 128), owner: ref(x.owner), root: bool(x.root), cpu: sanAlloc(x.cpu), mem: sanAlloc(x.mem),
    })).filter((x) => x.ref) };
}
