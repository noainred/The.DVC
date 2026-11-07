/**
 * sanswitch/attribution.js — 가상화 호스트 ↔ SAN 조닝·트래픽 **귀속 엔진**(순수, v2.920 — 설계 docs/design/san-cvp-traffic/README.md §4.1).
 *
 * 무엇을 하나: 호스트 HBA 의 WWN 을 SAN 스위치 스냅샷의 포트(attached)·조닝(zones)·네임서버 역할(nsRoles)에 대조해
 *   ① 이 HBA 가 어느 스위치 어느 포트에 로그인해 있고 ② 어느 zone 으로 어느 스토리지(타깃)에 허용돼 있으며
 *   ③ 그 포트가 기간 동안 보낸 바이트(perfDb portBytesMulti)가 **어느 스토리지의 것인지** 를 신뢰도와 함께 나눈다.
 *
 * 신뢰도 규약(화면의 ●/◐ 표기와 같다 — 조닝 그림 CONFIDENCE_LABEL 과 한 식구):
 *   · confirmed(● 확정) — 그 HBA 포트가 닿을 수 있는 스토리지가 **하나**이고 타깃 역할이 네임서버로 확정됐다. 포트 카운터 전부가 그 스토리지다.
 *       멀티패스의 경로별 타깃 WWN(hcfg.mp.targets — v2.920 수집)이 있으면 '지금 살아 있는 경로의 타깃' 으로 후보를 좁힌다(조닝 2개 → 실제 1개면 확정).
 *   · measured(● 실측 비율 — v2.933 C-①) — 후보가 2개 이상이고 그 호스트의 **ESXi 경로 카운터**(storpath — 경로별 읽기·쓰기)가 그 어댑터의 타깃별
 *       전송량을 쟀으면 그 비율로 나눈다(기간 안 표본 합 · 바이트 합은 스위치 포트 카운터). 라이선스가 필요 없다.
 *   · estimated(◐ 추정) — 실측이 없으면 **IPF 보정**(sanswitch/ipf.js — 행합 = 초기자 포트 · 열합 = 타깃 포트, v2.933)으로, IPF 를 못 쓰면
 *       (미수렴 · 후보 타깃 포트가 이 스위치에 없음) **같은 스위치의 타깃 포트 바이트 비율**(A 단계)로 나눈다. 어느 방식인지 row.split 이 말한다.
 *       nsRoles 가 빈 패브릭은 타깃 역할 자체가 추정이라 후보가 하나여도 추정이다(없는 근거를 만들지 않는다).
 *   · unsplit(— 분배 불가) — 후보가 2개 이상인데 타깃 포트 바이트가 전부 없거나 0 이라 비율을 만들 수 없다. 합계에는 들어가되 어느 스토리지에도 주지 않는다.
 *   · none — zone 은 있는데 타깃 쪽 끝점이 없다(초기자끼리만 묶였거나 타깃이 어느 스위치에도 없다) / zone 이 없다.
 *   · zoned-only(조닝만) — zone 멤버이지만 어느 스위치에도 로그인해 있지 않다(정리 후보 — 통계에 넣지 않는다).
 *   · unseen — 어느 스냅샷에서도 이 WWN 을 못 봤다(수집 범위 밖 스위치·FC 가 아닌 HBA).
 *   측정값(bytes)이 없는 포트는 **0 이 아니라 null** 이고 measured:false 로 센다(첫 수집·수집 공백 — perfDb 규약). 확정분·추정분은 따로 더하고 한 숫자로 합치지 않는다.
 *   방향: 호스트 F_Port 의 스위치 Tx(outBps) = 읽기(스토리지 → 호스트) · Rx(inBps) = 쓰기. 기간 바이트는 portperfshow 합산값이라 방향이 없다.
 *
 * 스토리지 식별: 타깃 포트의 attachedName → storageKey(벤더 심볼릭 'SYMMETRIX::시리얼') → 등록 스토리지 시리얼 일치(registered) — perfDb·storage-summary 와 같은 판정.
 *   평평한 이름(::' 없음)은 포트마다 다른 식별 키가 되어 한 어레이가 여러 행으로 나뉠 수 있다 — kind 가 'host'/'unknown' 이면 화면이 '어레이 미확인' 으로 말한다.
 *
 * 입력은 전부 순수 값이다(DB·레지스트리는 라우트가 읽어 넘긴다) — 테스트 server/test/sanAttrib2920.test.js.
 */
import { normWwn, zonesFromCompact, classifyEndpoints } from './zoning.js';
import { storageKey, arraySerialOf, endpointKind, normSerial } from './endpointKey.js';
import { numOrNull } from '../util/numOrNull.js';

/** 분배 방식(화면 세그먼트) — auto: 실측 → IPF → 타깃 포트 비율 · ipf: 실측을 건너뛴다 · ratio: A 단계 방식만. */
export const SPLIT_MODES = Object.freeze(['auto', 'ipf', 'ratio']);

/**
 * v2.933(C-①): ESXi 경로 표본 가중치(storpath/history.js weightsFor · { kb: Map(`${adapter}|${wwn}` → KB) }) → 그 어댑터의 타깃 WWN 별 몫.
 *   그 어댑터 키가 하나도 없으면 null(잰 적 없음 — 0 이 아니다). 합이 0 이면(표본 창에 I/O 가 없었다) null — 비율을 만들 수 없다.
 */
export function measuredSharesOf(pw, adapter) {
  if (!pw || !(pw.kb instanceof Map) || !adapter) return null;
  const pre = `${adapter}|`;
  const m = new Map();
  for (const [k, v] of pw.kb) if (k.startsWith(pre) && Number.isFinite(v)) m.set(k.slice(pre.length), (m.get(k.slice(pre.length)) || 0) + v);
  const tot = [...m.values()].reduce((a, b) => a + b, 0);
  if (!m.size || !(tot > 0)) return null;
  return new Map([...m].map(([w, v]) => [w, v / tot]));
}

export const MAX_HBAS = 32;             // 호스트당 HBA 상한(인벤토리 hbas 는 이미 작다 — 방어)
export const MAX_TARGETS_PER_PORT = 64; // HBA 포트 하나의 후보 스토리지 상한(zone 폭주 방어)

const lc = (w) => String(w || '').toLowerCase();
const adapterShort = (k) => String(k || '').replace(/^key-vim\.host\.[A-Za-z]+-/, '').slice(0, 32);

/**
 * v2.933(C-①): 스위치 스냅샷의 라이선스 목록(REST brocade-license · SSH licenseshow)에서 Fabric Vision(Flow Vision 포함) 여부.
 *   있으면 'yes'(만료일은 장비 값) · 목록을 읽었는데 없으면 'no' · 목록을 못 읽었으면 'unknown'(rbash 계정의 licenseshow 막힘 등 — '없음' 으로 단정하지 않는다).
 */
export function fabricVisionOf(snap) {
  const lic = Array.isArray(snap?.licenses) ? snap.licenses : [];
  const hit = lic.find((l) => /fabric\s*vision|flow\s*vision/i.test(String(l?.name || '')));
  if (hit) return { state: 'yes', expires: typeof hit.expires === 'string' && hit.expires ? hit.expires.slice(0, 40) : null };
  const sec = snap?.sections ? (snap.sections.licenses ?? snap.sections.license) : undefined;
  if (lic.length || sec === 'ok') return { state: 'no' };
  return { state: 'unknown', reason: typeof sec === 'string' && sec !== 'skip' ? sec.slice(0, 120) : null };
}

/**
 * 스냅샷 → 패브릭 문맥(스위치 1대 = 문맥 1개). 호스트마다 다시 만들지 않도록 한 번 만들어 공유한다(함대 658대 × 스위치 수십 대).
 * @param {Array<object>} snapshots sanswitch 스냅샷(types.js) — ports.list[].attached · zoning · nsRoles
 * @returns {Array<{deviceId,name,datacenterId,collectedAt,portsComplete,portByWwn:Map,names:Map,aliasOf:Map,roles:Map,zonesOf:Map,zoneCount:number,nsKnown:boolean}>}
 */
export function buildFabrics(snapshots = []) {
  const out = [];
  for (const snap of Array.isArray(snapshots) ? snapshots : []) {
    if (!snap || typeof snap !== 'object') continue;
    const list = Array.isArray(snap.ports?.list) ? snap.ports.list : [];
    const portByWwn = new Map(); const names = new Map();
    for (const p of list) {
      if (!p || typeof p !== 'object') continue;
      for (const w of Array.isArray(p.attached) ? p.attached : []) {
        const k = lc(w);
        if (!k) continue;
        portByWwn.set(k, p);
        if (p.attachedName) names.set(k, String(p.attachedName));
      }
    }
    const nsRoles = {};
    for (const [w, r] of Object.entries(snap.nsRoles && typeof snap.nsRoles === 'object' ? snap.nsRoles : {})) nsRoles[lc(w)] = r;
    const z = snap.zoning && typeof snap.zoning === 'object' ? snap.zoning : null;
    const zones = z?.available && Array.isArray(z.zones) ? zonesFromCompact(z) : [];
    const zonesOf = new Map(); const aliasOf = new Map();
    for (const zn of zones) {
      for (const w of zn.wwns || []) { if (!zonesOf.has(w)) zonesOf.set(w, []); zonesOf.get(w).push(zn); }
      for (const m of zn.members || []) if (m?.wwn && m.alias && !aliasOf.has(m.wwn)) aliasOf.set(m.wwn, m.alias);
    }
    const roles = zones.length ? classifyEndpoints(zones, { nsRoles, portByWwn: Object.fromEntries(portByWwn) }) : new Map();
    out.push({
      deviceId: String(snap.deviceId || ''), name: String(snap.name || snap.deviceId || ''), datacenterId: String(snap.datacenterId || ''),
      agent: snap.agent || '', collectedAt: snap.collectedAt || null,
      portsComplete: !(snap.ports?.portsOmitted > 0) && !snap.ports?.truncated,
      portByWwn, names, aliasOf, roles, zonesOf, zoneCount: zones.length, nsKnown: Object.keys(nsRoles).length > 0,
      fv: fabricVisionOf(snap),   // v2.933(C-①) Fabric Vision 라이선스
    });
  }
  return out;
}

/**
 * 타깃 WWN → 스토리지 신원. 이름은 **같은 패브릭의 포트 이름** 을 먼저, 없으면 다른 패브릭(팹 B 에 로그인한 포트), 그다음 zone 별칭.
 * @param {(serialNorm:string)=>object|null} storageOf 등록 스토리지 조회(시리얼 정규화 키)
 */
export function identityOf(wwn, fabric, fabrics, storageOf) {
  let label = fabric.names.get(wwn) || '';
  if (!label) for (const f of fabrics) { const n = f.names.get(wwn); if (n) { label = n; break; } }
  const alias = fabric.aliasOf.get(wwn) || '';
  const key = label ? storageKey(label) : '(미확인)';
  const serial = arraySerialOf(key);
  const registered = serial && typeof storageOf === 'function' ? (storageOf(normSerial(serial)) || null) : null;
  const kind = endpointKind(key, { matched: !!registered });
  const id = registered ? `st:${registered.id}` : key !== '(미확인)' ? `key:${key}` : `wwn:${wwn}`;
  const name = registered?.name || (key !== '(미확인)' ? key : (alias || wwn));
  return { id, name, key, serial, kind, registered: registered ? { id: registered.id, name: registered.name || '', type: registered.type || '', datacenterId: registered.datacenterId || '' } : null, alias };
}

/** hcfg.mp.targets(v2.920) → 어댑터별 '살아 있는 경로의 타깃 WWN' 집합. 없으면 null(모름 — 좁히지 않는다). */
export function liveTargetsByAdapter(host) {
  const list = host?.hcfg?.mp?.targets;
  if (!Array.isArray(list) || !list.length) return null;
  const out = new Map();
  for (const t of list) {
    const w = normWwn(t?.wwn); const a = adapterShort(t?.adapter);
    if (!w || !a) continue;
    if (!out.has(a)) out.set(a, new Set());
    if (Number(t.live) > 0) out.get(a).add(w);
  }
  return out;
}

/**
 * 호스트 한 대의 귀속.
 * @param {object} host 인벤토리 호스트 { id, name, vcenterId, hbas:[{name,wwn}], hcfg?:{mp?:{targets?:[]}} }
 * @param {Array} fabrics buildFabrics 결과
 * @param {{ storageOf?:Function, portBytes?:Map<string,{bytes:number|null,measuredBuckets:number,totalBuckets:number}> }} opt
 * @returns {{ hbas:[], storages:[], totals:{}, status:string }}
 */
export function attributeHost(host, fabrics = [], { storageOf = null, portBytes = null, pathWeights = null, ipf = null, split = 'auto' } = {}) {
  const hbas = (Array.isArray(host?.hbas) ? host.hbas : []).slice(0, MAX_HBAS)
    .map((h) => ({ name: String(h?.name || ''), wwn: normWwn(h?.wwn), type: String(h?.type || ''), model: String(h?.model || ''), speedGbps: numOrNull(h?.speedGbps) }));
  const mp = liveTargetsByAdapter(host);
  const bytesOf = (deviceId, port) => (portBytes instanceof Map ? (portBytes.get(`${deviceId}|${port}`) || null) : null);
  const rows = [];        // HBA 포트 행(패브릭별)
  const storages = new Map();
  const stRow = (idn) => {
    let s = storages.get(idn.id);
    if (!s) {
      s = { id: idn.id, name: idn.name, key: idn.key, serial: idn.serial, kind: idn.kind, registered: idn.registered,
        confirmedBytes: null, estimatedBytes: null, measuredBytes: null, confirmedPorts: [], estimatedPorts: [], measuredPorts: [], unsplitPorts: [], unmeasuredPorts: [], zonedOnlyPorts: [],
        nowRead: null, nowWrite: null, nowReadEst: null, nowWriteEst: null, targetPorts: [], fabrics: [], zones: [] };
      storages.set(idn.id, s);
    }
    return s;
  };
  const add = (o, k, v) => { if (v == null) return; o[k] = (o[k] ?? 0) + v; };
  const pushU = (arr, v) => { if (!arr.includes(v)) arr.push(v); };

  for (const hba of hbas) {
    if (!hba.wwn) { rows.push({ hba: hba.name, wwn: null, status: 'no-wwn', conf: 'none', measured: false, bytes: null, basis: 'WWN 이 없는 어댑터(FC 가 아니거나 못 읽음)' }); continue; }
    const w = hba.wwn;
    // 행은 **로그인한 스위치**마다 하나다. zone 은 패브릭 전체가 같은 설정을 보고하므로(팹 A 의 스위치 A1·A2 가 같은 zone 을 갖는다) 로그인하지 않은
    //   같은 패브릭 스위치에서 '조닝만' 을 만들면 정상 호스트가 조닝만 N건으로 부풀려진다(v2.920 Chromium 데모에서 발견 — 로그인 22 · 조닝만 64).
    //   '조닝만' 은 어느 스위치에도 로그인이 없을 때 **한 행**(zone 을 가진 첫 스위치 기준 · zone 을 가진 스위치 수를 밝힌다)이다.
    const loggedIn = fabrics.filter((f) => f.portByWwn.has(w));
    const zonedIn = loggedIn.length ? [] : fabrics.filter((f) => f.zonesOf.has(w));
    if (!loggedIn.length && !zonedIn.length) { rows.push({ hba: hba.name, wwn: w, status: 'unseen', conf: 'none', measured: false, bytes: null, basis: '수집된 SAN 스위치 어디에도 이 WWN 이 없습니다(수집 범위 밖 스위치이거나 미연결)' }); continue; }
    for (const f of (loggedIn.length ? loggedIn : zonedIn.slice(0, 1))) {
      const port = f.portByWwn.get(w) || null;
      const zonedFabrics = port ? null : zonedIn.length;
      const role = f.roles.get(w) || null;
      const zones = f.zonesOf.get(w) || [];
      // 후보 스토리지 — zone 파트너 중 타깃 쪽(target·middle·unknown). 초기자는 제외(같은 zone 의 다른 호스트).
      const cands = new Map();   // id → { idn, wwns:Set, roleConfirmed:boolean }
      let roleEstimated = false;
      for (const zn of zones) {
        for (const p of zn.wwns || []) {
          if (p === w) continue;
          const r = f.roles.get(p) || { side: 'unknown', confidence: 'none' };
          if (r.side === 'initiator') continue;
          if (r.confidence !== 'confirmed') roleEstimated = true;
          const idn = identityOf(p, f, fabrics, storageOf);
          if (!cands.has(idn.id)) { if (cands.size >= MAX_TARGETS_PER_PORT) continue; cands.set(idn.id, { idn, wwns: new Set(), zones: [] }); }
          const c = cands.get(idn.id); c.wwns.add(p); if (!c.zones.includes(zn.name)) c.zones.push(zn.name);
        }
      }
      // 멀티패스 경로별 타깃(있으면) — 지금 살아 있는 경로의 타깃이 있는 후보만 남긴다.
      const live = mp?.get(hba.name) || null;
      let basis = zones.length ? `zone ${zones.length}개` : 'zone 없음';
      let narrowed = false;
      if (live && live.size && cands.size > 1) {
        const keep = [...cands.values()].filter((c) => [...c.wwns].some((x) => live.has(x)));
        if (keep.length) { for (const [id, c] of cands) if (!keep.includes(c)) cands.delete(id); narrowed = true; basis += ` → 살아 있는 멀티패스 타깃으로 ${keep.length}개`; }
      }
      const b = port ? bytesOf(f.deviceId, port.index) : null;
      const bytes = b ? numOrNull(b.bytes) : null;
      const measured = bytes != null;
      const nowRead = port ? numOrNull(port.outBps) : null;
      const nowWrite = port ? numOrNull(port.inBps) : null;
      let conf; let shares = []; let splitBy = null; let splitInfo = null;
      if (!port) conf = 'zoned-only';
      else if (!cands.size) conf = 'none';
      else if (cands.size === 1) { conf = roleEstimated ? 'estimated' : 'confirmed'; shares = [[cands.keys().next().value, 1]]; if (roleEstimated) basis += ' · 타깃 역할이 네임서버 확정이 아님'; }
      else {
        // v2.933(C-①) ① 실측 비율 — ESXi 경로 카운터(그 어댑터의 타깃 WWN 별 전송량). 경로가 없는 후보는 실측 0 이다(그 어댑터로 그 타깃에 간 I/O 가 없다).
        const ms = split === 'auto' ? measuredSharesOf(pathWeights, hba.name) : null;
        if (ms) {
          shares = [...cands.values()].map((c) => [c.idn.id, [...c.wwns].reduce((a, tw) => a + (ms.get(tw) || 0), 0)]);
          const tot = shares.reduce((a, [, v]) => a + v, 0);
          if (tot > 0) {
            shares = shares.map(([id, v]) => [id, v / tot]);
            conf = 'measured'; splitBy = 'measured';
            splitInfo = { samples: pathWeights.samples ?? null, firstAt: pathWeights.firstAt ?? null, lastAt: pathWeights.lastAt ?? null, outside: Math.round((1 - tot) * 1000) / 1000 };
            basis += ` · 후보 ${cands.size}개 — ESXi 경로 카운터 비율로 분배(표본 ${pathWeights.samples ?? '—'}개)`;
            if (tot < 0.999) basis += ` · 후보 밖 타깃 몫 ${Math.round((1 - tot) * 100)}% 제외`;
          } else shares = [];
        }
        // ② IPF — 이 스위치의 행합(초기자 포트) · 열합(타깃 포트)을 함께 맞춘 몫. 후보마다 이 스위치에 타깃 포트가 있어야 쓴다.
        if (!splitBy && split !== 'ratio' && ipf?.byRow instanceof Map) {
          const ip = ipf.byRow.get(`${f.deviceId}|${w}`);
          if (ip && [...cands.values()].every((c) => [...c.wwns].some((tw) => ip.shares.has(tw)))) {
            const raw = [...cands.values()].map((c) => [c.idn.id, [...c.wwns].reduce((a, tw) => a + (ip.shares.get(tw) || 0), 0)]);
            const tot = raw.reduce((a, [, v]) => a + v, 0);
            if (tot > 0) {
              shares = raw.map(([id, v]) => [id, v / tot]);
              conf = 'estimated'; splitBy = 'ipf';
              const fs = (ipf.fabrics || []).find((x) => x.group === ip.group) || null;
              splitInfo = { elsewhere: Math.round((ip.elsewhere || 0) * 1000) / 1000, iter: fs?.iter ?? null, residual: fs?.residual ?? null };
              basis += ` · 후보 ${cands.size}개 — IPF 보정(행합 · 열합 맞춤${fs ? ` · 반복 ${fs.iter} · 잔차 ${(fs.residual * 100).toFixed(1)}%` : ''})`;
              if ((ip.elsewhere || 0) >= 0.01) basis += ` · 다른 스위치 타깃 몫 ${Math.round(ip.elsewhere * 100)}% 는 후보 사이에 다시 나눔`;
            }
          }
        }
        // ③ 같은 스위치의 타깃 포트 바이트 비율(A 단계)
        if (!splitBy) {
          const wts = [...cands.values()].map((c) => {
            let sum = null;
            for (const tw of c.wwns) { const tp = f.portByWwn.get(tw); if (!tp) continue; const tb = bytesOf(f.deviceId, tp.index); const v = tb ? numOrNull(tb.bytes) : null; if (v != null) sum = (sum ?? 0) + v; }
            return [c.idn.id, sum];
          });
          const tot = wts.reduce((a, [, v]) => a + (v ?? 0), 0);
          /*
           * v2.932(점검 A1-04 — main): 후보 중 하나라도 타깃 포트 바이트를 **읽지 못했으면**(첫 수집 · 수집 공백 · 타깃이 같은 패브릭의 다른 스위치) 나누지 않는다.
           *   예전에는 못 읽은 후보를 0 으로 더해 그 후보 share 0 · estimatedBytes 0 B, 측정된 후보에 share 1 을 몰아줬다('못 읽은 값은 0 이 아니다').
           *   측정된 후보만으로 나누면 여전히 과귀속이라(반증) unsplit 로 두고 몇 개를 못 읽었는지 근거에 밝힌다.
           */
          const unread = wts.filter(([, v]) => v == null).length;
          if (tot > 0 && !unread) { conf = 'estimated'; splitBy = 'ratio'; shares = wts.map(([id, v]) => [id, v / tot]); basis += ` · 후보 ${cands.size}개 — 타깃 포트 바이트 비율로 분배${split !== 'ratio' && ipf ? '(IPF 를 쓸 수 없음)' : ''}`; }
          else if (unread && unread < wts.length) { conf = 'unsplit'; basis += ` · 후보 ${cands.size}개 — 그중 ${unread}개의 타깃 포트 바이트를 읽지 못해 나누지 못함`; }
          else { conf = 'unsplit'; basis += ` · 후보 ${cands.size}개 — 타깃 포트 바이트가 없어 나누지 못함`; }
        }
      }
      const row = {
        hba: hba.name, wwn: w, type: hba.type, model: hba.model, speedGbps: hba.speedGbps,
        switch: { deviceId: f.deviceId, name: f.name, datacenterId: f.datacenterId, agent: f.agent, collectedAt: f.collectedAt },
        port: port ? { index: port.index, slotPort: port.slotPort ?? null, name: port.name || '', state: port.state || '', speed: port.speed || '' } : null,
        role: role ? { side: role.side, confidence: role.confidence, basis: role.basis } : null,
        zones: zones.slice(0, 20).map((z) => z.name), zoneCount: zones.length,
        targets: [...cands.values()].map((c) => ({ id: c.idn.id, name: c.idn.name, kind: c.idn.kind, registered: !!c.idn.registered, wwns: [...c.wwns], zones: c.zones, share: shares.find(([id]) => id === c.idn.id)?.[1] ?? null })),
        status: port ? 'logged-in' : 'zoned-only', conf, basis: zonedFabrics ? `${basis} · 로그인 없음(zone 을 가진 스위치 ${zonedFabrics}대)` : basis, narrowed, measured, bytes,
        split: splitBy, splitInfo,
        ...(zonedFabrics ? { zonedFabrics } : {}),
        measuredBuckets: b?.measuredBuckets ?? null, totalBuckets: b?.totalBuckets ?? null, nowRead, nowWrite,
        mp: live ? { live: live.size } : null,
      };
      rows.push(row);
      // 스토리지 행 누적
      for (const c of cands.values()) {
        const s = stRow(c.idn);
        pushU(s.fabrics, f.deviceId);
        for (const zn of c.zones) pushU(s.zones, zn);
        for (const tw of c.wwns) { const tp = f.portByWwn.get(tw); if (tp && !s.targetPorts.some((x) => x.deviceId === f.deviceId && x.port === tp.index)) s.targetPorts.push({ deviceId: f.deviceId, switch: f.name, port: tp.index, slotPort: tp.slotPort ?? null, wwn: tw }); }
        const share = shares.find(([id]) => id === c.idn.id)?.[1] ?? null;
        const tag = `${hba.name}@${f.name}`;
        if (conf === 'zoned-only') pushU(s.zonedOnlyPorts, tag);
        else if (conf === 'confirmed') {
          pushU(s.confirmedPorts, tag);
          if (measured) add(s, 'confirmedBytes', bytes); else pushU(s.unmeasuredPorts, tag);
          add(s, 'nowRead', nowRead); add(s, 'nowWrite', nowWrite);
        } else if (conf === 'estimated' || conf === 'measured') {
          pushU(conf === 'measured' ? s.measuredPorts : s.estimatedPorts, tag);
          if (measured) add(s, conf === 'measured' ? 'measuredBytes' : 'estimatedBytes', bytes * share); else pushU(s.unmeasuredPorts, tag);
          if (nowRead != null) add(s, 'nowReadEst', nowRead * share); if (nowWrite != null) add(s, 'nowWriteEst', nowWrite * share);
        } else if (conf === 'unsplit') { pushU(s.unsplitPorts, tag); if (!measured) pushU(s.unmeasuredPorts, tag); }
      }
    }
  }
  const totals = { hostBytes: null, confirmedBytes: null, estimatedBytes: null, pathMeasuredBytes: null, unsplitBytes: null, unattributedBytes: null, measuredPorts: 0, unmeasuredPorts: 0, loggedIn: 0, zonedOnly: 0, unseen: 0, nowRead: null, nowWrite: null };
  for (const r of rows) {
    if (r.status === 'logged-in') { totals.loggedIn += 1; if (r.measured) totals.measuredPorts += 1; else totals.unmeasuredPorts += 1; }
    else if (r.status === 'zoned-only') totals.zonedOnly += 1;
    else if (r.status === 'unseen') totals.unseen += 1;
    if (r.measured) {
      add(totals, 'hostBytes', r.bytes);
      if (r.conf === 'confirmed') add(totals, 'confirmedBytes', r.bytes);
      else if (r.conf === 'estimated') add(totals, 'estimatedBytes', r.bytes);
      else if (r.conf === 'measured') add(totals, 'pathMeasuredBytes', r.bytes);   // v2.933 — totals.measuredPorts(측정된 포트 수)와 이름이 겹치지 않게
      else if (r.conf === 'unsplit') add(totals, 'unsplitBytes', r.bytes);
      else add(totals, 'unattributedBytes', r.bytes);
    }
    add(totals, 'nowRead', r.nowRead); add(totals, 'nowWrite', r.nowWrite);
  }
  const tot3 = (x) => (x.confirmedBytes ?? 0) + (x.measuredBytes ?? 0) + (x.estimatedBytes ?? 0);
  const stList = [...storages.values()].sort((a, b) => tot3(b) - tot3(a) || a.name.localeCompare(b.name));
  const status = !hbas.length ? 'no-hba' : !rows.some((r) => r.status === 'logged-in' || r.status === 'zoned-only') ? 'unseen' : rows.some((r) => r.status === 'logged-in') ? 'ok' : 'zoned-only';
  return { host: { id: host?.id ?? null, name: host?.name ?? '', vcenterId: host?.vcenterId ?? null }, hbas: rows, storages: stList, totals, status, mpTargets: mp ? [...mp.values()].reduce((a, s) => a + s.size, 0) : null };
}

/**
 * 함대(호스트 여러 대) 귀속 — SAN 도구 '호스트 귀속' 보기. 호스트마다 attributeHost 를 돌리고 호스트 × 스토리지 행과 스토리지 소계를 만든다.
 * @returns {{ rows:[], storages:[], hosts:[], counts:{} }}
 */
export function attributeFleet(hosts = [], fabrics = [], opt = {}) {
  const rows = []; const byStorage = new Map(); const hostRows = []; const zonedOnly = [];
  const counts = { hosts: 0, noHba: 0, unseen: 0, ok: 0, zonedOnly: 0, confirmedPairs: 0, measuredPairs: 0, estimatedPairs: 0, unsplitPairs: 0, zonedOnlyPairs: 0, ipfPorts: 0, ratioPorts: 0, measuredSplitPorts: 0 };
  for (const h of Array.isArray(hosts) ? hosts : []) {
    const r = attributeHost(h, fabrics, { ...opt, pathWeights: typeof opt.pathWeightsOf === 'function' ? opt.pathWeightsOf(h) : null });
    for (const x of r.hbas) { if (x.split === 'ipf') counts.ipfPorts += 1; else if (x.split === 'ratio') counts.ratioPorts += 1; else if (x.split === 'measured') counts.measuredSplitPorts += 1; }
    counts.hosts += 1;
    if (r.status === 'no-hba') counts.noHba += 1; else if (r.status === 'unseen') counts.unseen += 1; else if (r.status === 'zoned-only') counts.zonedOnly += 1; else counts.ok += 1;
    hostRows.push({ id: r.host.id, name: r.host.name, vcenterId: r.host.vcenterId, status: r.status, totals: r.totals, hbas: r.hbas.length, mpTargets: r.mpTargets });
    for (const s of r.storages) {
      const hasTraffic = s.confirmedPorts.length || s.measuredPorts.length || s.estimatedPorts.length || s.unsplitPorts.length;
      // 짝의 근거 — 가장 약한 포트 근거를 따른다(추정이 하나라도 섞이면 추정 · 실측과 확정만이면 실측 · 확정만이면 확정).
      const conf = s.estimatedPorts.length ? 'estimated'
        : s.measuredPorts.length ? 'measured'
          : s.confirmedPorts.length ? (s.unsplitPorts.length ? 'estimated' : 'confirmed')
            : s.unsplitPorts.length ? 'unsplit' : 'zoned-only';
      const measuredAny = s.confirmedBytes != null || s.estimatedBytes != null || s.measuredBytes != null;
      const row = { hostId: r.host.id, hostName: r.host.name, vcenterId: r.host.vcenterId, storageId: s.id, storageName: s.name, kind: s.kind, registered: !!s.registered,
        conf, confirmedBytes: s.confirmedBytes, estimatedBytes: s.estimatedBytes, measuredBytes: s.measuredBytes, measured: measuredAny, nowRead: s.nowRead, nowWrite: s.nowWrite,
        ports: { confirmed: s.confirmedPorts.length, measured: s.measuredPorts.length, estimated: s.estimatedPorts.length, unsplit: s.unsplitPorts.length, unmeasured: s.unmeasuredPorts.length, zonedOnly: s.zonedOnlyPorts.length }, fabrics: s.fabrics };
      if (!hasTraffic) { zonedOnly.push({ ...row, zones: s.zones.slice(0, 8) }); counts.zonedOnlyPairs += 1; continue; }
      rows.push(row);
      if (conf === 'confirmed') counts.confirmedPairs += 1; else if (conf === 'measured') counts.measuredPairs += 1; else if (conf === 'estimated') counts.estimatedPairs += 1; else if (conf === 'unsplit') counts.unsplitPairs += 1;
      let st = byStorage.get(s.id);
      if (!st) { st = { id: s.id, name: s.name, key: s.key, kind: s.kind, registered: s.registered, confirmedBytes: null, estimatedBytes: null, measuredBytes: null, hosts: 0, hostsConfirmed: 0, hostsMeasured: 0, hostsEstimated: 0, hostsUnsplit: 0, unmeasuredHosts: 0, fabrics: [] }; byStorage.set(s.id, st); }
      st.hosts += 1;
      if (conf === 'confirmed') st.hostsConfirmed += 1; else if (conf === 'measured') st.hostsMeasured += 1; else if (conf === 'estimated') st.hostsEstimated += 1; else st.hostsUnsplit += 1;
      if (s.confirmedBytes != null) st.confirmedBytes = (st.confirmedBytes ?? 0) + s.confirmedBytes;
      if (s.estimatedBytes != null) st.estimatedBytes = (st.estimatedBytes ?? 0) + s.estimatedBytes;
      if (s.measuredBytes != null) st.measuredBytes = (st.measuredBytes ?? 0) + s.measuredBytes;
      if (!measuredAny) st.unmeasuredHosts += 1;
      for (const f of s.fabrics) if (!st.fabrics.includes(f)) st.fabrics.push(f);
    }
  }
  const tot3 = (x) => (x.confirmedBytes ?? 0) + (x.measuredBytes ?? 0) + (x.estimatedBytes ?? 0);
  const storages = [...byStorage.values()].sort((a, b) => tot3(b) - tot3(a) || a.name.localeCompare(b.name));
  return { rows, storages, hosts: hostRows, zonedOnly, counts };
}
