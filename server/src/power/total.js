/**
 * power/total.js — 전체 소비 전력 합산(v2.664, **순수 모듈** — 테스트로 고정).
 *
 * 사용자 요청: "소비전력 → iDRAC 에서 수집한 모든 서버의 소비전력 + CVP 에서 수집한 모든 네트워크 장비의 소비 전력 +
 *   스토리지 장비 소비 전력" · "특수기능에 전체 소비 전력 카드를 만들고 서버/네트워크/스토리지 전력 사용량 취합".
 * Overview 카드와 특수 기능 '전체 소비 전력' 이 **이 함수 하나**를 쓴다(두 화면의 숫자가 갈라지지 않게).
 *
 * 정직성 규칙:
 *  · 읽은 값만 더한다. 못 읽은 장비는 0 W 가 아니라 **미측정**으로 따로 센다(0 은 '전원이 꺼졌다' 는 거짓).
 *  · 서버는 iDRAC·OME·엣지 실측만(vCenter 추정 `source:'vcenter'` 은 뺀다 — 요청이 'iDRAC 에서 수집한' 이다).
 *  · 네트워크는 CVP PSU **입력 전력(inW)** 합이다. 입력이 없고 출력만 있으면 출력을 쓰되 그 대수를 `outputOnly` 로 밝힌다
 *    (출력은 입력보다 작다 — 효율 손실만큼 과소). ⚠ 필드 이름은 실장비 미확인 추정(cvp/parse.js PSU_POWER_FIELDS).
 *  · 스토리지는 수집기가 `extra.power.watts` 를 실은 장비만 더한다. v2.667 부터 경로는 `storage/power.js POWER_PATHS` 가
 *    소유한다(Unity SSH·REST · PowerStore · XtremIO · Isilon · PowerMax/VMAX). 경로가 있는데 못 읽은 장비는 **사유별로**
 *    (`unreadBy`) 세고, 경로가 없는 조합(VPLEX·SSH 수집 방식 일부)은 `unsupported`(+`unsupportedBy`) 로 센다.
 *    ⚠ Unity SSH 외의 전원 필드는 실장비 미확인 — 못 읽은 장비는 응답에 있던 키(seenKeys)를 `issues` 로 싣는다.
 *  · 오래된 값은 '현재' 가 아니다 — 경계(ms)를 넘긴 장비는 `stale` 로 빼고 개수를 밝힌다.
 */
import { numOrNull } from '../util/numOrNull.js';
import { powerPathOf, noPathReason } from '../storage/power.js';

export const NET_STALE_MS = 6 * 3_600_000;      // CVP 부품(PSU)은 부품 주기로 읽는다 — 6시간을 넘으면 현재값이 아니다
export const STORAGE_STALE_MS = 6 * 3_600_000;  // 스토리지 기본 수집 주기 1시간 — 6배
export const UNASSIGNED = '';
export const ISSUE_MAX = 200;   // 못 읽은 장비 목록 상한 — 넘친 개수는 issuesOmitted 로 밝힌다

const w0 = (v) => { const n = numOrNull(v); return n != null && n >= 0 && n < 1_000_000 ? n : null; };

/**
 * CVP 장비 1대 → { watts, basis:'input'|'output'|null, psus, read, partial? } (순수 — partial 은 일부만 읽었을 때만 true 로 싣는다).
 * v2.680 A-05: 빈 슬롯(state 'absent')은 PSU 로 세지 않는다. 장착된 PSU 중 일부만 읽었으면 `partial:true` 다 —
 *   예전에는 psus 와 read 를 비교하지 않아 PSU 2개 중 1개만 읽은 스위치가 절반 전력으로 '측정' 에 들어갔다(부분 합을 합계라 말함).
 */
export function cvpDevicePower(d) {
  const parts = Array.isArray(d?.partsList) ? d.partsList : null;
  if (!parts) return { watts: null, basis: null, psus: 0, read: 0 };
  let inSum = 0; let inN = 0; let outSum = 0; let outN = 0; let psus = 0;
  for (const p of parts) {
    if (!p || p.kind !== 'psu') continue;
    if (p.state === 'absent') continue;
    psus += 1;
    const i = w0(p.power?.inW); const o = w0(p.power?.outW);
    if (i != null) { inSum += i; inN += 1; } else if (o != null) { outSum += o; outN += 1; }
  }
  const read = inN + outN;
  const pf = read > 0 && read < psus ? { partial: true } : {};   // 온전하면 필드를 싣지 않는다(예전 응답 모양 그대로)
  if (inN) return { watts: Math.round(inSum + outSum), basis: outN ? 'mixed' : 'input', psus, read, ...pf };
  if (outN) return { watts: Math.round(outSum), basis: 'output', psus, read, ...pf };
  return { watts: null, basis: null, psus, read: 0 };
}

/**
 * @param {object} i
 * @param {object[]} i.servers   allMeasuredPower() 항목 { serverId, serverName, watts, ts, source, vcenterId, datacenterId }
 * @param {object[]} i.network   CVP 장비 행(rowToDevice 모양) + corp { corpId, corpName }
 * @param {object[]} i.storage   { id, name, type, datacenterId, snap } — 등록부 + 최신 스냅샷
 * @param {(vcId:string)=>string} [i.dcOfVc]  vCenter → DataCenter id(서버 귀속 보강)
 * @param {Map<string,string>} [i.dcName]
 * @param {number} [i.now]
 * @param {number} [i.itemMax]  목록 상한(카테고리별)
 * @param {number|null} [i.serversRegistered]  v2.680 A-06: 서버 분석 등록(활성 · OME 콘솔 제외 · 엣지 보고분 포함) 대수 — 분모.
 *   주지 않으면(null) 분모를 모른다고 밝힌다(devices·unread 가 null — 예전 응답 모양 호환).
 */
export function buildPowerTotal({ servers = [], network = [], storage = [], dcOfVc = () => '', dcName = new Map(), now = Date.now(), itemMax = 200, serversRegistered = null } = {}) {
  const corps = new Map();
  const corpOf = (id) => {
    const k = String(id || UNASSIGNED);
    if (!corps.has(k)) corps.set(k, { corpId: k, corpName: k ? (dcName.get(k) || k) : '', servers: 0, network: 0, storage: 0, total: 0, devices: 0 });
    return corps.get(k);
  };
  const add = (cat, corpId, watts) => { const c = corpOf(corpId); c[cat] += watts; c.total += watts; c.devices += 1; };

  // ① 서버 — iDRAC 실측(vCenter 추정 제외).
  const srv = { watts: 0, measured: 0, excludedVcenter: 0, ome: 0, devices: null, unread: null, items: [] };
  for (const e of servers || []) {
    if (!e) continue;
    if (e.source === 'vcenter') { srv.excludedVcenter += 1; continue; }
    const w = w0(e.watts);
    if (w == null) continue;
    const corp = String(e.datacenterId || dcOfVc(String(e.vcenterId || '')) || '');
    srv.watts += w; srv.measured += 1; add('servers', corp, w);
    if (e.source === 'ome') srv.ome += 1;
    srv.items.push({ id: String(e.serverId), name: e.serverName || String(e.serverId), watts: Math.round(w), corpId: corp, source: e.source, ts: numOrNull(e.ts) });
  }

  // v2.680 A-06: 서버도 분모를 밝힌다 — 예전에는 measured 만 있어 iDRAC 이 무더기로 멈추면(2시간 넘은 값은 빠진다) 합계가 조용히
  //   줄어 '전력 감소' 처럼 보였다. 분모 = 서버 분석 등록(활성 · OME 콘솔 제외), 못 읽음 = 분모 − (iDRAC·엣지 실측 대수).
  //   OME 로만 읽힌 장비는 등록부에 개별 서버로 없으므로 빼고 센다. ⚠ 같은 박스가 iDRAC·엣지 두 경로로 등록돼 있으면 분모가
  //   그만큼 커서 못 읽음이 실제보다 클 수 있다(정직 기록 — 전력은 중복 제거로 한 번만 더한다).
  const reg = numOrNull(serversRegistered);
  if (reg != null && reg >= 0) {
    srv.devices = Math.round(reg);
    srv.unread = Math.max(0, srv.devices - (srv.measured - srv.ome));
  }

  // ② 네트워크 — CVP PSU.
  // v2.680 A-05: partial = 장착 PSU 중 일부만 읽은 장비(전력은 더하되 '측정' 이 아니다 — 합계가 실제보다 작다는 뜻).
  const net = { watts: 0, devices: 0, measured: 0, partial: 0, partialWatts: 0, unread: 0, stale: 0, outputOnly: 0, items: [] };
  for (const d of network || []) {
    if (!d) continue;
    net.devices += 1;
    const at = numOrNull(d.partsAt) ?? numOrNull(d.collectedAt);
    const p = cvpDevicePower(d);
    if (p.watts == null) { net.unread += 1; continue; }
    if (at == null || now - at > NET_STALE_MS) { net.stale += 1; continue; }
    if (p.basis === 'output') net.outputOnly += 1;
    net.watts += p.watts; add('network', d.corp?.corpId || '', p.watts);
    if (p.partial) { net.partial += 1; net.partialWatts += p.watts; } else net.measured += 1;
    net.items.push({ id: `${d.cvpId}/${d.key}`, name: d.hostname || d.key, model: d.model || '', watts: p.watts, basis: p.basis, psus: p.psus, read: p.read, ...(p.partial ? { partial: true } : {}), corpId: d.corp?.corpId || '', ts: at });
  }

  // ③ 스토리지 — 수집기가 실은 extra.power(v2.667: 못 읽은 사유를 extra.powerProbe 로 받는다).
  // v2.682 R3D-03: partial = 일부 부품(PSU·노드)의 값을 못 읽은 장비 — 전력은 더하되 '측정' 이 아니다(네트워크 A-05 와 같은 규칙).
  const sto = { watts: 0, devices: 0, measured: 0, partial: 0, partialWatts: 0, unsupported: 0, unread: 0, stale: 0, byType: {}, unreadBy: {}, unsupportedBy: {}, items: [], issues: [], issuesOmitted: 0 };
  const issue = (d, t, state, reason, extra = {}) => {
    if (sto.issues.length >= ISSUE_MAX) { sto.issuesOmitted += 1; return; }
    sto.issues.push({ id: String(d.id), name: d.name || String(d.id), type: t, method: d.collectMethod || '', corpId: String(d.datacenterId || ''), state, reason, ...extra });
  };
  for (const d of storage || []) {
    if (!d || d.enabled === false) continue;
    sto.devices += 1;
    const t = String(d.type || '');
    const bt = sto.byType[t] || (sto.byType[t] = { devices: 0, measured: 0 });
    bt.devices += 1;
    const ex = d.snap?.extra || {};
    const pw = ex.power;
    const w = pw && typeof pw === 'object' ? w0(pw.watts) : null;
    if (w == null) {
      const path = powerPathOf(d);
      if (!path) {
        const why = noPathReason(d);
        sto.unsupported += 1; sto.unsupportedBy[why] = (sto.unsupportedBy[why] || 0) + 1;
        continue;
      }
      // 경로가 있는데 못 읽었다 — 사유: 스냅샷 없음 / 수집 실패 / 수집기가 사유를 실음 / 전원을 보고하지 않음(구버전 수집기).
      const pr = ex.powerProbe && typeof ex.powerProbe === 'object' ? ex.powerProbe : null;
      const reason = !d.snap ? 'no-snapshot' : d.snap.ok === false ? 'collect-failed' : pr ? String(pr.reason || 'request-failed') : 'not-reported';
      sto.unread += 1; sto.unreadBy[reason] = (sto.unreadBy[reason] || 0) + 1;
      issue(d, t, 'unread', reason, pr ? { source: String(pr.source || '').slice(0, 200), detail: String(pr.detail || '').slice(0, 200), seenKeys: Array.isArray(pr.seenKeys) ? pr.seenKeys.slice(0, 20).map(String) : [] } : { source: path });
      continue;
    }
    // v2.680 F-06: extra.power.at 은 엣지 시계 원본이라 중앙이 자르지 않는다 — 시계가 빠른 엣지가 push 를 멈추면 마지막 값이
    //   6시간 경계 안에 영원히 남았다. 중앙 수신 때 잘린 snap.collectedAt 과 둘 다 있으면 **더 이른 쪽**을 쓰고,
    //   미래 시각은 지금으로 본다(미래를 '더 신선하다' 로 읽지 않는다).
    const pAt = numOrNull(pw.at); const cAt = numOrNull(d.snap?.collectedAt);
    let at = pAt != null && cAt != null ? Math.min(pAt, cAt) : (pAt ?? cAt);
    if (at != null && at > now) at = now;
    if (at == null || now - at > STORAGE_STALE_MS) { sto.stale += 1; issue(d, t, 'stale', 'stale', { ts: at }); continue; }
    const part = pw.partial === true;
    sto.watts += w; add('storage', d.datacenterId || '', w);
    if (part) { sto.partial += 1; sto.partialWatts += w; } else { sto.measured += 1; bt.measured += 1; }
    const miss = numOrNull(pw.missing);
    sto.items.push({ id: String(d.id), name: d.name || String(d.id), type: t, watts: Math.round(w), scope: pw.scope || '', basis: pw.basis || '', source: String(pw.source || '').slice(0, 200), corpId: String(d.datacenterId || ''), ts: at,
      ...(part ? { partial: true, missing: miss != null && miss > 0 ? Math.round(miss) : null } : {}) });
  }

  const trim = (x) => {
    const all = x.items.sort((a, b) => b.watts - a.watts);
    return { ...x, watts: Math.round(x.watts), items: all.slice(0, itemMax), omitted: Math.max(0, all.length - itemMax) };
  };
  const byCorp = [...corps.values()].map((c) => ({ ...c, servers: Math.round(c.servers), network: Math.round(c.network), storage: Math.round(c.storage), total: Math.round(c.total) }))
    .sort((a, b) => b.total - a.total);
  const s = trim(srv); const n = trim(net); const t = trim(sto);
  t.partialWatts = Math.round(t.partialWatts);
  return { totalWatts: s.watts + n.watts + t.watts, servers: s, network: n, storage: t, byCorp, at: now };
}
