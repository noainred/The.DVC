/**
 * views/vcd/vcdTabs.js — vCenter 상세의 vSphere Client 식 탭 12개(v2.895 — 승인 시안 `docs/design/vcenter-tabs` ①~⑦ · 기본값 1~7).
 *
 * 순수 모듈(vitest 고정): 탭 목록 · 옛 키 호환 · 하위 칸 · 탭 본문이 쓰는 묶음 · 문구. 화면은 VCenterDetail.jsx 와 vcd/*Tab.jsx.
 *  - 탭 키는 안정 식별자다(브라우저 기억값). 'trend'(옛 '추이')는 모니터 › 성능으로 옮겼다 — 옛 기억값은 normTab 이 바꿔 준다.
 *  - 값을 지어내지 않는다: 못 읽은 수치는 null('—'), 수집하지 않는 것은 '수집하지 않음' 으로 말한다(원인을 단정하지 않는다).
 *  - 포탈 알람은 vCenter 자체 알람이 아니라 포탈이 수집값으로 판정한 규칙이다(vcenter/soapClient.js 의 mkAlarm) — 문구가 그 사실을 말한다.
 */
import { numOrNull } from '../../numOrNull.js';

export const VCD_TABS = Object.freeze([
  { k: 'summary', label: '요약' },
  { k: 'monitor', label: '모니터' },
  { k: 'configure', label: '구성' },
  { k: 'perms', label: '사용 권한' },
  { k: 'datacenter', label: '데이터 센터' },
  { k: 'hosts', label: '호스트 및 클러스터' },
  { k: 'vms', label: 'VM' },
  { k: 'storage', label: '데이터스토어' },
  { k: 'network', label: '네트워크' },
  { k: 'linked', label: '연결된 vCenter Server 시스템' },
  { k: 'extensions', label: '확장 프로그램' },
  { k: 'updates', label: '업데이트' },
]);

/** 처음 여는 탭 — 지금까지의 기본('호스트 및 클러스터')을 바꾸지 않는다. 마지막으로 본 탭은 브라우저에 기억한다(사람별 편의). */
export const DEFAULT_TAB = 'hosts';
export const TAB_STORE_KEY = 'vcd.tab';

const TAB_KEYS = new Set(VCD_TABS.map((t) => t.k));

/** 기억값·외부 값 → 탭 키. 옛 'trend' 는 모니터(성능 하위 칸)로, 모르는 값은 기본 탭으로. */
export function normTab(k) {
  if (k === 'trend') return 'monitor';
  return TAB_KEYS.has(k) ? k : DEFAULT_TAB;
}

/** localStorage 등 — 사생활 모드·차단에서 throw 할 수 있다(규약: try/catch). */
export function loadTab(storage) {
  try { return normTab(storage?.getItem?.(TAB_STORE_KEY) || ''); } catch { return DEFAULT_TAB; }
}
export function saveTab(storage, k) {
  try { storage?.setItem?.(TAB_STORE_KEY, normTab(k)); } catch { /* 기억 못 해도 화면은 동작한다 */ }
}

/** 모니터 하위 칸 — vSphere 순서(문제 및 알람 · 이벤트 · 작업 · 성능). 성능 = 예전 '추이' 탭 그대로. */
export const MONITOR_SUBS = Object.freeze([
  { k: 'alarms', label: '문제 및 알람' },
  { k: 'events', label: '이벤트' },
  { k: 'tasks', label: '작업' },
  { k: 'perf', label: '성능' },
]);

/**
 * 구성 하위 칸 — 기존 특수 기능(도구 키)의 데이터를 이 vCenter 로 거른다. tool 이 없으면 수집하지 않는 칸.
 * 도구 권한이 없으면 부르지 않고 권한 안내를 보인다(기본값 5 — 숨기지 않는다).
 */
export const CONFIGURE_SUBS = Object.freeze([
  { k: 'licenses', label: '라이선스', tool: 'licenses', group: '설정' },
  { k: 'clusters', label: '클러스터 HA · DRS', tool: 'cluster-check', group: '설정' },
  { k: 'tags', label: '태그 · 사용자 지정 속성', tool: 'vm-tags', group: '설정' },
  { k: 'advanced', label: '고급 설정', tool: null, group: '설정' },
  { k: 'certs', label: '인증서', tool: 'cert-expiry', group: '보안' },
  { k: 'hostcfg', label: '호스트 구성 점검', tool: 'host-hygiene', group: '점검' },
]);

/** 포탈 알람 규칙(수집기가 판정 — 문구는 규칙 이름만). 화면 각주에 쓴다. 숫자는 수집기 코드의 판정선이다. */
export const PORTAL_ALARM_RULE_TEXT = '포탈이 수집값으로 판정한 규칙 — 호스트 끊김 · 유지보수 · CPU 90% 초과 · 메모리 92% 초과 · 데이터스토어 90%(경고)/95%(심각) 초과 · 데이터스토어 접근 불가. vCenter 자체 트리거 알람은 수집하지 않습니다.';

export const SEV_LABEL = Object.freeze({ critical: '심각', warning: '경고', info: '정보' });
export const SEV_BADGE = Object.freeze({ critical: 'red', warning: 'amber', info: 'blue' });

/** 알람 심각도별 개수 — 모르는 심각도는 정보로 세지 않고 따로(other). */
export function alarmCounts(items) {
  const out = { critical: 0, warning: 0, info: 0, other: 0, total: 0 };
  for (const a of Array.isArray(items) ? items : []) {
    if (!a || typeof a !== 'object') continue;
    out.total++;
    if (a.severity === 'critical' || a.severity === 'warning' || a.severity === 'info') out[a.severity]++;
    else out.other++;
  }
  return out;
}

/** 이 vCenter 의 알람만(서버가 이미 거르지만 다른 vCenter 행이 섞여도 보이지 않게 한 번 더). */
export function alarmsOf(items, vcenterId) {
  return (Array.isArray(items) ? items : []).filter((a) => a && a.vcenterId === vcenterId);
}

/** 라이선스 키 — 뒤 5자만 보인다(시안 기본값). 없으면 '—'. */
export function maskLicenseKey(key) {
  const s = typeof key === 'string' ? key.trim() : '';
  if (!s) return '—';
  const tail = s.replace(/[^A-Za-z0-9]/g, '').slice(-5);
  return tail ? `…-${tail}` : '—';
}

/** 라이선스 사용률(%) — 사용·총량 중 하나라도 못 읽었거나 총량이 0 이하면 null(0% 로 지어내지 않는다). */
export function licenseUsePct(l) {
  const used = numOrNull(l?.used);
  const total = numOrNull(l?.total);
  if (used == null || total == null || !(total > 0)) return null;
  return Math.round((used / total) * 100);
}

/** 만료 문구 — 'never'·빈 값·해석 불가를 구분한다. now 는 테스트 고정용. */
export function licenseExpiryText(expires, now = Date.now()) {
  const s = typeof expires === 'string' ? expires.trim() : '';
  if (!s) return { text: '—', days: null, sev: null };
  if (/^(never|영구|perpetual)$/i.test(s)) return { text: '영구', days: null, sev: 'ok' };
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return { text: s.slice(0, 32), days: null, sev: null };
  const days = Math.floor((t - now) / 86_400_000);
  const sev = days < 0 ? 'expired' : days <= 30 ? 'crit' : days <= 90 ? 'warn' : 'ok';
  return { text: `${s.slice(0, 10)} · ${days < 0 ? `만료 ${-days}일 지남` : `D-${days}`}`, days, sev };
}

/**
 * 데이터 센터 탭 — 호스트를 vSphere 데이터센터(`vcDatacenter`, 수집기가 클러스터 부모를 따라 찾은 이름) › 클러스터로 묶는다.
 * 클러스터 밖 독립 호스트처럼 데이터센터를 못 따라간 호스트(null)는 어느 데이터센터에도 더하지 않고 `unknown` 묶음으로 따로 센다.
 * vmCountOf(h) 는 호출부의 VM 수 판정('Off VM 포함' 설정)을 그대로 쓰게 받는다.
 */
export function groupByDatacenter(hosts, vmCountOf = (h) => numOrNull(h?.vmCount)) {
  const dcs = new Map();
  const unknown = { name: null, clusters: new Map(), hosts: [] };
  for (const h of Array.isArray(hosts) ? hosts : []) {
    if (!h || typeof h !== 'object') continue;
    const dcName = typeof h.vcDatacenter === 'string' && h.vcDatacenter ? h.vcDatacenter : null;
    const bucket = dcName == null ? unknown : (dcs.get(dcName) || (dcs.set(dcName, { name: dcName, clusters: new Map(), hosts: [] }), dcs.get(dcName)));
    bucket.hosts.push(h);
    const cl = h.cluster || 'standalone';
    if (!bucket.clusters.has(cl)) bucket.clusters.set(cl, []);
    bucket.clusters.get(cl).push(h);
  }
  const fin = (b) => {
    let vms = 0; let vmsKnown = 0;
    for (const h of b.hosts) { const n = vmCountOf(h); if (n != null) { vms += n; vmsKnown++; } }
    return {
      name: b.name,
      hostCount: b.hosts.length,
      vmCount: vmsKnown ? vms : null,
      clusters: [...b.clusters.entries()].sort((a, c) => a[0].localeCompare(c[0])).map(([name, hs]) => ({ name, hosts: hs })),
      hosts: b.hosts,
    };
  };
  return {
    datacenters: [...dcs.values()].sort((a, b) => a.name.localeCompare(b.name)).map(fin),
    unknown: unknown.hosts.length ? fin(unknown) : null,
  };
}

/** 확장 프로그램 — 회사 이름으로 VMware(Broadcom 포함)/타사를 가른다(필터 칩용 · 판정이 아니라 분류). */
export function extensionVendor(ext) {
  const c = `${ext?.company || ''} ${ext?.key || ''}`;
  return /vmware|broadcom|com\.vmware\./i.test(c) ? 'vmware' : 'other';
}

/**
 * 확장 프로그램 탭 상태 — /tools/solutions 의 이 vCenter 행에서.
 *  - row 없음: 범위 밖이거나 아직 목록에 없음 → 'missing'
 *  - solutionsUnread 있음: 읽지 못함('확인 불가') — '0개' 로 그리지 않는다
 *  - 그 밖: 'ok'(0개면 진짜로 등록된 확장이 없다고 vCenter 가 답한 것)
 */
export function extensionsState(row) {
  if (!row || typeof row !== 'object') return { state: 'missing', items: [] };
  if (row.solutionsUnread) return { state: 'unread', items: [], why: row.solutionsUnread.text || row.solutionsUnread.why || '', error: row.solutionsUnread.error || '' };
  const items = (Array.isArray(row.solutions) ? row.solutions : []).filter((s) => s && typeof s === 'object');
  return { state: 'ok', items };
}

/** 같은 key 가 fleet(범위 안 vCenter) 에 몇 곳·버전 몇 종 — 이 vCenter 에만 다른 버전이 있는지 보는 용도. */
export function fleetKeyStats(rows) {
  const m = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    for (const s of Array.isArray(r?.solutions) ? r.solutions : []) {
      if (!s?.key) continue;
      const e = m.get(s.key) || { vcs: new Set(), versions: new Set() };
      e.vcs.add(r.vcenterId); e.versions.add(s.version || '');
      m.set(s.key, e);
    }
  }
  const out = new Map();
  for (const [k, e] of m) out.set(k, { vcenters: e.vcs.size, versions: e.versions.size });
  return out;
}

/**
 * 업데이트 탭 — 지금 아는 것(버전 · 빌드)만. ESXi 는 버전+빌드 조합별 대수, 끊긴 호스트(버전 미보고)는 '모름' 으로 따로.
 */
export function esxiVersionRows(hosts) {
  const m = new Map();
  let unknown = 0;
  for (const h of Array.isArray(hosts) ? hosts : []) {
    if (!h) continue;
    const v = typeof h.version === 'string' && h.version && h.version !== 'unknown' ? h.version : '';
    if (!v) { unknown++; continue; }
    const key = `${v}|${h.build || ''}`;
    m.set(key, (m.get(key) || 0) + 1);
  }
  const rows = [...m.entries()].map(([k, n]) => { const [version, build] = k.split('|'); return { version, build: build || '', count: n }; })
    .sort((a, b) => b.count - a.count || b.version.localeCompare(a.version, undefined, { numeric: true }));
  return { rows, unknown };
}

/** 'major.minor' 비교 — ESXi 가 vCenter 보다 높은 판이면 지원되지 않는 조합(문구는 사실만 — '확인 필요'). */
export function versionNewer(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10));
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10));
  if (!Number.isFinite(pa[0]) || !Number.isFinite(pb[0])) return null;
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0; const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** 권한 · 역할 변경 이벤트만(구성 변경 이력의 분류 '권한' — 서버 reports/changes.js 와 같은 분류명). */
export const PERM_CATEGORY = '권한';
export function permEvents(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.category === PERM_CATEGORY);
}

/** GB → 'N GB' / 'N.N TB' — 못 읽은 값(null·빈 값)은 단위 없는 '—'(0 GB 로 지어내지 않는다). */
export function gbText(gb) {
  const n = numOrNull(gb);
  if (n == null) return '—';
  return n >= 1024 ? `${(n / 1024).toFixed(1)} TB` : `${Math.round(n).toLocaleString()} GB`;
}

/**
 * 요약 › 인벤토리 숫자 — 받은 목록에서만 센다. 목록을 못 받았으면(ok=false) 그 칸은 null('—').
 * 데이터스토어 용량 합은 사용량을 읽은 것만 더하고 못 읽은 수를 따로 둔다(부분 합을 전체처럼 말하지 않게).
 */
export function inventoryCounts({ hosts, vms, datastores, networks, hostsOk, vmsOk, dsOk, netOk }) {
  const H = Array.isArray(hosts) ? hosts : []; const V = Array.isArray(vms) ? vms : [];
  const D = Array.isArray(datastores) ? datastores : []; const N = Array.isArray(networks) ? networks : [];
  const dc = hostsOk ? groupByDatacenter(H) : null;
  let capGB = 0; let usedGB = 0; let dsUnread = 0;
  for (const d of D) {
    const c = numOrNull(d?.capacityGB); const u = numOrNull(d?.usedGB);
    if (c == null || u == null || d?.accessible === false) { dsUnread++; continue; }
    capGB += c; usedGB += u;
  }
  return {
    datacenters: dc ? dc.datacenters.length : null,
    dcUnknownHosts: dc && dc.unknown ? dc.unknown.hostCount : 0,
    clusters: hostsOk ? new Set(H.filter((h) => h.cluster && h.cluster !== 'standalone').map((h) => h.cluster)).size : null,
    hosts: hostsOk ? H.length : null,
    hostsConnected: hostsOk ? H.filter((h) => h.connectionState === 'CONNECTED').length : null,
    hostsDisconnected: hostsOk ? H.filter((h) => h.connectionState === 'DISCONNECTED' || h.connectionState === 'NOT_RESPONDING').length : null,
    hostsMaint: hostsOk ? H.filter((h) => h.connectionState === 'MAINTENANCE').length : null,
    vms: vmsOk ? V.length : null,
    vmsOn: vmsOk ? V.filter((v) => v.powerState === 'POWERED_ON').length : null,
    vmsOff: vmsOk ? V.filter((v) => v.powerState !== 'POWERED_ON' && !v.template).length : null,
    templates: vmsOk ? V.filter((v) => v.template).length : null,
    datastores: dsOk ? D.length : null,
    dsInaccessible: dsOk ? D.filter((d) => d?.accessible === false).length : null,
    networks: netOk ? N.length : null,
    storage: dsOk ? { capGB: capGB || null, usedGB: capGB ? usedGB : null, pct: capGB > 0 ? Math.round((usedGB / capGB) * 100) : null, unread: dsUnread } : null,
  };
}

/** 이벤트 시각 → 'MM-DD HH:mm'(못 읽으면 '—'). */
export function shortTs(ts) {
  const n = typeof ts === 'number' ? ts : Date.parse(ts || '');
  if (!Number.isFinite(n)) return '—';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
