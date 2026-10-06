// VM 이동 이력(A7)·구성 변경(A8) — 이벤트 본문에서 화면이 쓰는 몇 필드만 뽑는다(v2.702, 순수).
// vCenter 이벤트 수집(vcenter/soapClient.js parseEventsXml)이 이 함수를 불러 행에 `detail`(JSON) 을 싣는다.
// 대상 종류가 아니면 null — 모든 이벤트에 상세를 붙이면 장기 보관 DB 가 커진다.
import { xmlUnescape } from '../vcenter/soapParse.js';

export const MOVE_TYPES = Object.freeze(['VmMigratedEvent', 'DrsVmMigratedEvent', 'VmRelocatedEvent']);
export const RECONFIG_TYPES = Object.freeze(['VmReconfiguredEvent']);
export const PERM_TYPES = Object.freeze(['PermissionAddedEvent', 'PermissionRemovedEvent', 'PermissionUpdatedEvent', 'RoleAddedEvent', 'RoleRemovedEvent', 'RoleUpdatedEvent']);
/** 상세를 싣고 부분 인덱스로 찾는 종류 전부 — logs/db.js 의 부분 인덱스·조회가 이 목록에서 만든 같은 SQL 리터럴을 쓴다. */
export const TRACKED_TYPES = Object.freeze([...MOVE_TYPES, ...RECONFIG_TYPES, ...PERM_TYPES]);
/** SQL `IN (...)` 리터럴 — 이름은 정규식 [A-Za-z]+ 로 고정돼 있어 인용이 안전하다(테스트가 고정). */
export const TRACKED_SQL = `(${TRACKED_TYPES.map((t) => `'${t}'`).join(',')})`;

/**
 * v2.706(C5·C4) · v2.707(C6) — '운영 이벤트' 종류. 추적 이벤트(위)와 **다른 부분 인덱스**(idx_events_ops)를 쓴다 —
 * 같은 인덱스에 종류를 더하면 옛 DB 의 인덱스 조건이 새 조회 조건을 덮지 못해 INDEXED BY 가 실패한다.
 *  · LIFE  : VM 생성·복제·배포·등록·삭제(인벤토리 제거 포함)·이름 변경(C5)
 *  · AVAIL : VM 전원·재설정·HA 재시작·게스트 재부팅/종료(C6 가용성 — v2.707 이 읽는다. 인덱스는 한 번만 만든다)
 *  · HOSTOPS: 호스트 유지보수 모드·연결 끊김·종료(C4 '예기치 않은 재부팅' 판정)
 */
export const LIFE_TYPES = Object.freeze(['VmCreatedEvent', 'VmClonedEvent', 'VmDeployedEvent', 'VmRegisteredEvent', 'VmRemovedEvent', 'VmRenamedEvent']);
export const AVAIL_TYPES = Object.freeze(['VmPoweredOnEvent', 'VmPoweredOffEvent', 'VmSuspendedEvent', 'VmResettingEvent', 'VmGuestRebootEvent',
  'VmGuestShutdownEvent', 'VmRestartedOnAlternateHostEvent', 'VmDasBeingResetEvent', 'VmFailedToPowerOnEvent']);
export const HOSTOPS_TYPES = Object.freeze(['EnteringMaintenanceModeEvent', 'EnteredMaintenanceModeEvent', 'ExitMaintenanceModeEvent',
  'HostConnectionLostEvent', 'HostShutdownEvent']);
export const OPS_TYPES = Object.freeze([...LIFE_TYPES, ...AVAIL_TYPES, ...HOSTOPS_TYPES]);
export const OPS_SQL = `(${OPS_TYPES.map((t) => `'${t}'`).join(',')})`;
export const DETAIL_MAX = 4096;
const TEXT_MAX = 1500;

const cap = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
function inner(xml, name) {
  // 같은 이름 태그가 안에 다시 나온다(HostEventArgument 는 <host><host type="HostSystem">…</host><name>…</name></host>) —
  //   첫 닫는 태그에서 끊으면 바깥 블록의 <name> 을 놓친다. 깊이를 세어 짝이 맞는 닫는 태그를 찾는다(선형).
  if (typeof xml !== 'string') return null;
  const openTag = `<${name}`; const closeTag = `</${name}>`;
  const isOpenAt = (i) => { const c = xml.charCodeAt(i + openTag.length); return c === 32 || c === 62; };
  let i = 0; let s = -1;
  for (;;) {
    s = xml.indexOf(openTag, i);
    if (s < 0) return null;
    if (isOpenAt(s)) break;                           // <hostX> 를 <host> 로 읽지 않는다
    i = s + 1;
  }
  const open = xml.indexOf('>', s);
  if (open < 0) return null;
  if (xml.charCodeAt(open - 1) === 47) return '';     // <host/> 자기닫힘
  let depth = 1; let p = open + 1;
  for (;;) {
    const nc = xml.indexOf(closeTag, p);
    if (nc < 0) return null;
    let no = xml.indexOf(openTag, p);
    while (no >= 0 && no < nc && !isOpenAt(no)) no = xml.indexOf(openTag, no + 1);
    if (no >= 0 && no < nc) {
      const e = xml.indexOf('>', no);
      if (e < 0) return null;
      if (xml.charCodeAt(e - 1) !== 47) depth += 1;
      p = e + 1; continue;
    }
    depth -= 1;
    if (depth === 0) return xml.slice(open + 1, nc);
    p = nc + closeTag.length;
  }
}
const nameIn = (xml, el) => { const b = inner(xml, el); if (b == null) return null; const n = /<name>([^<]{0,512})<\/name>/.exec(b)?.[1]; return n ? cap(xmlUnescape(n), 128) : null; };
const text = (xml, el) => { const b = inner(xml, el); return b == null ? null : cap(xmlUnescape(b.replace(/<[^>]{0,200}>/g, ' ').replace(/\s+/g, ' ')), TEXT_MAX); };

/** 구성 변경 이벤트에서 '무엇이 바뀌었나' — 6.7+ 의 configChanges(변경 전 → 후 원문)가 먼저, 없으면 configSpec 의 아는 필드. */
const SPEC_FIELDS = ['numCPUs', 'numCoresPerSocket', 'memoryMB', 'cpuAllocation', 'memoryAllocation', 'cpuHotAddEnabled', 'memoryHotAddEnabled',
  'name', 'annotation', 'guestId', 'version', 'extraConfig', 'deviceChange', 'bootOptions', 'tools', 'flags', 'vAppConfig'];
function reconfigDetail(body) {
  const cc = inner(body, 'configChanges');
  const out = {};
  if (cc != null) {
    for (const k of ['modified', 'added', 'deleted']) { const v = text(cc, k); if (v) out[k] = v; }
  }
  const spec = inner(body, 'configSpec');
  if (spec != null) {
    const fields = SPEC_FIELDS.filter((f) => spec.includes(`<${f}>`) || spec.includes(`<${f} `));
    if (fields.length) out.fields = fields;
    const cpu = /<numCPUs>(\d{1,4})<\/numCPUs>/.exec(spec)?.[1]; if (cpu) out.numCpu = Number(cpu);
    const mem = /<memoryMB>(\d{1,9})<\/memoryMB>/.exec(spec)?.[1]; if (mem) out.memoryMB = Number(mem);
    const ops = [];
    let i = 0;
    for (;;) {
      const s = spec.indexOf('<deviceChange>', i);
      if (s < 0 || ops.length >= 10) break;
      const e = spec.indexOf('</deviceChange>', s);
      if (e < 0) break;
      const blk = spec.slice(s, e);
      i = e + 15;
      const op = /<operation>([a-z]{1,16})<\/operation>/.exec(blk)?.[1] || 'edit';
      const dev = /<device[^>]*xsi:type="(?:[\w-]{1,32}:)?([A-Za-z]\w{0,47})"/.exec(blk)?.[1] || 'device';
      ops.push(`${op} ${dev}`);
    }
    if (ops.length) out.devices = ops;
  }
  return Object.keys(out).length ? out : null;
}

/** v2.706(C5): VM 생성·삭제 계열 — 종류 · 호스트 · 데이터스토어 · 원본(복제 원본 VM·배포 템플릿) · 이름 변경 전후. */
export const LIFE_KIND = Object.freeze({
  VmCreatedEvent: 'create', VmClonedEvent: 'clone', VmDeployedEvent: 'deploy', VmRegisteredEvent: 'register', VmRemovedEvent: 'remove', VmRenamedEvent: 'rename',
});
function lifeDetail(t, body) {
  const out = { kind: LIFE_KIND[t] };
  const host = nameIn(body, 'host'); if (host) out.host = host;
  const ds = nameIn(body, 'ds'); if (ds) out.ds = ds;
  const src = t === 'VmClonedEvent' ? nameIn(body, 'sourceVm') : t === 'VmDeployedEvent' ? nameIn(body, 'srcTemplate') : null;
  if (src) out.source = src;
  if (t === 'VmRenamedEvent') {
    const o = /<oldName>([^<]{1,512})<\/oldName>/.exec(body)?.[1]; const n = /<newName>([^<]{1,512})<\/newName>/.exec(body)?.[1];
    if (o) out.oldName = cap(xmlUnescape(o), 128);
    if (n) out.newName = cap(xmlUnescape(n), 128);
  }
  return out;
}

/** 이동 종류 — DRS 가 먼저, 그 다음 호스트·데이터스토어가 바뀌었는지. 이름을 모르면 이벤트 종류로만 말한다. */
export function moveKind(type, d) {
  if (type === 'DrsVmMigratedEvent') return 'drs';
  const hostMoved = d?.from && d?.to ? d.from !== d.to : null;
  const dsMoved = d?.fromDs && d?.toDs ? d.fromDs !== d.toDs : null;
  if (hostMoved && dsMoved) return 'both';
  if (hostMoved) return 'vmotion';
  if (dsMoved) return 'svmotion';
  return type === 'VmRelocatedEvent' ? 'relocate' : 'vmotion';
}

/** @returns {object|null} 이벤트 상세(JSON 직렬화 가능) — 대상 종류가 아니면 null. */
export function eventDetail(type, body) {
  const t = String(type || '').replace(/^.*:/, '');
  if (typeof body !== 'string') return null;
  if (MOVE_TYPES.includes(t)) {
    const d = { from: nameIn(body, 'sourceHost'), to: nameIn(body, 'host'), fromDs: nameIn(body, 'sourceDatastore'), toDs: nameIn(body, 'ds') };
    return { ...d, kind: moveKind(t, d) };
  }
  if (RECONFIG_TYPES.includes(t)) return reconfigDetail(body);
  if (LIFE_TYPES.includes(t)) return lifeDetail(t, body);
  if (PERM_TYPES.includes(t)) {
    const principal = /<principal>([^<]{1,256})<\/principal>/.exec(body)?.[1];
    const out = {
      principal: principal ? cap(xmlUnescape(principal), 128) : null,
      role: nameIn(body, 'role'),
      group: /<group>(true|false)<\/group>/.exec(body)?.[1] === 'true' ? true : null,
      propagate: /<propagate>(true|false)<\/propagate>/.exec(body)?.[1] === 'true' ? true : null,
    };
    return out;
  }
  return null;
}

/** DB 에 싣는 문자열(상한) — 넘치면 텍스트 필드를 줄인다(잘린 JSON 을 저장하지 않는다). */
export function detailJson(d) {
  if (!d) return null;
  let s = JSON.stringify(d);
  if (s.length <= DETAIL_MAX) return s;
  const slim = { ...d };
  for (const k of ['modified', 'added', 'deleted']) if (slim[k]) slim[k] = cap(slim[k], 400);
  s = JSON.stringify(slim);
  return s.length <= DETAIL_MAX ? s : JSON.stringify({ truncated: true, kind: d.kind ?? null });
}

/** 저장된 상세 문자열 → 객체(손상·형식 불일치는 null). */
export function parseDetail(s) {
  if (typeof s !== 'string' || !s) return null;
  try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}
