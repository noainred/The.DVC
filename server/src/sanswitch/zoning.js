/**
 * sanswitch/zoning.js — Brocade FOS 조닝(cfgshow) 파서 + 관계 분석(순수, v2.511).
 *
 * 사용자 요청: "SAN switch 조닝 정보를 그림으로". 그림은 **관계**를 그리는 것이라 zone 멤버가
 * 있어야 한다 — v2.510 까지는 `switchshow` 헤더의 **활성 설정 이름 한 줄**(`zoning: ON (cfg1)`)만
 * 있었고 `zones: 0` 은 하드코딩이었다. 여기서 `cfgshow` 를 실제로 읽는다.
 *
 * ── 입력 형식(사용자 제공 실장비 출력 2벌로 확정, 2026-09-15) ──────────────────
 * 두 섹션이 순서대로 온다. 같은 파일 안에서 **멤버 표기가 섞인다** — 아래 네 형태를 모두 봤다:
 *
 *   Defined configuration:
 *    cfg:   cfg1        ZONE_A;              ← 이름과 첫 멤버가 **같은 줄**
 *                   ZONE_B;                  ← 이어지는 멤버(줄당 하나, 끝에 ';')
 *    zone:  ZONE_A
 *                   ESX14_HBA1_0_P41; Unity_SPB0_p9      ← 한 줄에 '; ' 로 둘(별칭 이름)
 *    zone:  ZONE_C
 *                   10:00:00:10:9b:c2:53:96; 50:06:01:60:4c:e4:0b:f8   ← 한 줄에 '; ' 로 둘(WWN)
 *    zone:  ZONE_D
 *                   58:cc:f0:91:4d:22:0c:8b  ← 줄당 하나(WWN, 세미콜론 없음)
 *                   c0:01:44:87:a8:0e:8a:00
 *    alias: Unity_SPA0_p8
 *                   50:06:01:60:4c:e4:0b:f8  ← 별칭 1개 ↔ WWN 1개
 *
 *   Effective configuration:                  ← 별칭이 **이미 WWN 으로 풀린** 활성 설정
 *    cfg:   cfg1
 *    zone:  ZONE_A
 *                   10:00:00:10:9b:c2:11:11
 *                   c0:01:44:87:a7:a5:00:00
 *
 * 그래서 멤버 수집은 '줄바꿈 + 세미콜론' 둘 다로 쪼갠다. 한쪽만 보면 그 현장에서만 맞는다.
 *
 * ── 역할(이니시에이터/타깃) 판정은 이름 규약에 기대지 않는다 ────────────────────
 * 이 현장의 zone 이름은 `<호스트>_H1_SW3_S13_SW1_D9_<타깃>` 처럼 규칙적이지만, **그 규칙은 이
 * 현장의 것**이라 파서가 의존하면 다른 법인에서 조용히 틀린다. 대신 **그래프 구조**를 쓴다:
 *   · SAN 조닝은 이니시에이터끼리 묶지 않는다 → zone 그래프는 본질적으로 **이분 그래프**다.
 *   · 연결 요소마다 2-색칠(BFS)을 하면 양쪽이 **자동으로** 갈린다.
 *   · 어느 색이 이니시에이터인지만 정하면 되고, 거기에만 보조 신호(NAA 형식·OUI·이름)를 쓴다.
 *
 * ⚠ VPLEX 같은 **가상화 계층은 양쪽에 다 있다**(호스트에겐 타깃 `VPLEX_FE`, 어레이에겐
 *   이니시에이터 `VPLEX_BE` — 사용자가 준 두 출력이 정확히 그 두 경우다). 이런 노드는 2-색칠에서
 *   **양쪽 색과 모두 인접**하게 나타나므로 `middle`(중간 계층)로 분류해 가운데 열에 그린다.
 *   억지로 2열로 밀면 그림이 사실과 달라진다.
 *
 * ⚠ OUI 표는 **보조 신호이고 검증하지 못했다**(훈련 지식 기반). 그래서 ① 단독으로 역할을 정하지
 *   않고 ② 판정 결과에 `basis` 문자열을 붙여 화면이 근거를 밝히게 하며 ③ 화면에서 사용자가
 *   좌/우를 뒤집을 수 있게 한다. 확신이 없으면 'unknown' 으로 두고 그렇게 표시한다.
 */

/* ────────────────────────── 파싱 ────────────────────────── */

const WWN_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){7}$/i;
const DP_RE = /^\d{1,3},\d{1,3}$/;              // Domain,Port 멤버
const NAME_RE = /^[A-Za-z0-9_$^\-.]{1,64}$/;    // FOS 오브젝트 이름 허용 문자

/** WWN 표준형(소문자 콜론). WWN 이 아니면 null. */
export function normWwn(s) {
  const t = String(s || '').trim().toLowerCase();
  if (WWN_RE.test(t)) return t;
  const bare = t.replace(/[^0-9a-f]/g, '');
  if (bare.length === 16) return bare.match(/.{2}/g).join(':');
  return null;
}

export const memberKind = (s) => {
  const t = String(s || '').trim();
  if (normWwn(t)) return 'wwn';
  if (DP_RE.test(t)) return 'domainPort';
  if (NAME_RE.test(t)) return 'alias';
  return 'unknown';
};

/** 멤버 문자열(여러 줄·세미콜론 혼합) → 배열. 빈 항목·끝 세미콜론 제거. */
export function splitMembers(text) {
  return String(text || '')
    .split(/[;\n\r]+/)
    .map((x) => x.trim())
    .filter((x) => x && x !== '...')
    .map((x) => normWwn(x) || x);
}

/**
 * cfgshow 전문 파싱.
 * @returns {{
 *   sections: string[],                       // 본 섹션 이름(정직: 출력이 잘렸는지 알 수 있게)
 *   truncated: boolean,                       // '--More--' 로 잘린 흔적
 *   defined: { cfgs: {}, zones: {}, aliases: {} },
 *   effective: { cfg: string, zones: {} },
 * }}
 */
export function parseCfgShow(text) {
  const lines = String(text || '').split(/\r?\n/);
  const defined = { cfgs: {}, zones: {}, aliases: {} };
  const effective = { cfg: '', zones: {} };
  const sections = [];
  let inEffective = false;
  let cur = null;   // { bucket, name }
  let truncated = false;

  const bucketFor = (kind) => {
    if (inEffective) return kind === 'zone' ? effective.zones : null;   // 활성 섹션엔 alias 가 없다
    return kind === 'cfg' ? defined.cfgs : kind === 'zone' ? defined.zones : defined.aliases;
  };

  for (const raw of lines) {
    const line = String(raw).replace(/\s+$/, '');
    if (!line.trim()) continue;
    // 페이저 흔적 — 출력이 잘렸다는 사실을 숨기지 않는다.
    if (/^-{2}\s*More\s*-{2}/i.test(line.trim()) || /\(byte\s+\d+\)/i.test(line)) { truncated = true; continue; }

    let m;
    if ((m = line.match(/^\s*(Defined|Effective)\s+configuration:/i))) {
      inEffective = /^effective$/i.test(m[1]);
      sections.push(m[1].toLowerCase());
      cur = null;
      continue;
    }
    if ((m = line.match(/^\s*(cfg|zone|alias|qloop|fcalias)\s*:\s*(\S+)\s*(.*)$/i))) {
      const kind = m[1].toLowerCase() === 'fcalias' ? 'alias' : m[1].toLowerCase();
      const name = m[2];
      const rest = m[3] || '';
      if (kind === 'cfg' && inEffective) { effective.cfg = name; cur = null; continue; }
      const bucket = bucketFor(kind === 'qloop' ? 'zone' : kind);
      if (!bucket) { cur = null; continue; }
      if (!bucket[name]) bucket[name] = [];
      cur = { bucket, name };
      // `cfg: cfg1  ZONE_A;` 처럼 이름 뒤에 멤버가 붙어 오는 형식(실장비 확인).
      if (rest.trim()) bucket[name].push(...splitMembers(rest));
      continue;
    }
    // 들여쓴 이어지는 멤버 줄
    if (cur && /^\s+\S/.test(line)) { cur.bucket[cur.name].push(...splitMembers(line)); continue; }
    cur = null;
  }
  // 중복 제거(같은 멤버가 두 번 적힌 설정이 있다)
  for (const b of [defined.cfgs, defined.zones, defined.aliases, effective.zones]) {
    for (const k of Object.keys(b)) b[k] = [...new Set(b[k])];
  }
  return { sections, truncated, defined, effective };
}

/* ────────────────────────── 해석 ────────────────────────── */

/**
 * 활성 zone 목록을 WWN 으로 푼 형태로. 활성 섹션이 있으면 그것을(이미 풀려 있다),
 * 없으면 정의 섹션의 활성 cfg 를 alias 로 풀어 만든다.
 * @returns {{ source:'effective'|'defined'|'none', cfgName:string,
 *             zones:[{ name, members:[{raw,kind,wwn,alias}], wwns:string[], unresolved:string[] }] }}
 */
export function resolveZones(parsed, { activeCfg = '' } = {}) {
  const aliases = parsed?.defined?.aliases || {};
  const aliasWwn = new Map();
  for (const [name, mem] of Object.entries(aliases)) {
    const w = mem.map(normWwn).filter(Boolean);
    if (w.length) aliasWwn.set(name, w);
  }
  const expand = (list) => {
    const members = []; const wwns = new Set(); const unresolved = [];
    for (const raw of list || []) {
      const kind = memberKind(raw);
      if (kind === 'wwn') { const w = normWwn(raw); members.push({ raw, kind, wwn: w, alias: '' }); wwns.add(w); continue; }
      if (kind === 'alias' && aliasWwn.has(raw)) {
        for (const w of aliasWwn.get(raw)) { members.push({ raw, kind: 'alias', wwn: w, alias: raw }); wwns.add(w); }
        continue;
      }
      // Domain,Port 멤버 또는 정의를 못 찾은 별칭 — 버리지 않고 '미해석' 으로 남긴다.
      members.push({ raw, kind, wwn: null, alias: kind === 'alias' ? raw : '' });
      unresolved.push(raw);
    }
    return { members, wwns: [...wwns], unresolved };
  };

  const effZones = parsed?.effective?.zones || {};
  if (Object.keys(effZones).length) {
    return {
      source: 'effective',
      cfgName: parsed.effective.cfg || activeCfg || '',
      zones: Object.entries(effZones).map(([name, list]) => ({ name, ...expand(list) })),
    };
  }
  const cfgs = parsed?.defined?.cfgs || {};
  const pick = activeCfg && cfgs[activeCfg] ? activeCfg : Object.keys(cfgs)[0] || '';
  const zoneNames = pick ? cfgs[pick] : Object.keys(parsed?.defined?.zones || {});
  const dz = parsed?.defined?.zones || {};
  const zones = (zoneNames || []).filter((n) => dz[n]).map((name) => ({ name, ...expand(dz[name]) }));
  if (!zones.length) return { source: 'none', cfgName: pick, zones: [] };
  return { source: 'defined', cfgName: pick, zones };
}

/* ────────────────────────── 역할 판정 ────────────────────────── */

/**
 * WWN 접두 → 장비군(보조 신호). **검증하지 못한 훈련 지식**이므로 단독 판정에 쓰지 않고
 * 화면에 '추정' 으로 표시한다. 맞지 않으면 화면에서 뒤집을 수 있다.
 */
export const WWN_HINTS = [
  { re: /^10:00:00:10:9b/, vendor: 'Emulex HBA', side: 'initiator' },
  { re: /^(10|20):00:00:(1b:32|c0:dd|e0:8b)/, vendor: 'QLogic HBA', side: 'initiator' },
  { re: /^(10|20):00:00:90:fa/, vendor: 'Emulex/OEM HBA', side: 'initiator' },
  { re: /^50:00:09:7/, vendor: 'Dell EMC VMAX/PowerMax', side: 'target' },
  { re: /^50:06:01:6/, vendor: 'Dell EMC Unity/VNX', side: 'target' },
  { re: /^51:4f:0c/, vendor: 'Dell EMC XtremIO', side: 'target' },
  { re: /^58:cc:f0/, vendor: 'Dell PowerStore', side: 'target' },
  { re: /^c0:01:44/, vendor: 'Dell EMC VPLEX', side: '' },   // 가상화 계층 — 한쪽으로 정하지 않는다
  { re: /^50:06:0e:80/, vendor: 'Hitachi', side: 'target' },
  { re: /^20:[0-9a-f]{2}:00:a0:b8/, vendor: 'NetApp/Engenio', side: 'target' },
  { re: /^50:0a:09:8/, vendor: 'NetApp', side: 'target' },
];

export function wwnHint(wwn) {
  const w = normWwn(wwn) || '';
  return WWN_HINTS.find((h) => h.re.test(w)) || null;
}

/** NAA 형식 — `1x:`/`2x:` 는 IEEE 48비트 매핑(HBA 가 주로 쓴다), `5x:` 는 IEEE Registered. */
export function naaClass(wwn) {
  const w = normWwn(wwn) || '';
  const n = w.slice(0, 1);
  if (n === '1' || n === '2') return 'ieee48';
  if (n === '5' || n === '6') return 'registered';
  if (n === 'c') return 'other';
  return '';
}

/**
 * zone 그래프를 2-색칠해 양쪽을 자동 분리한다(연결 요소별).
 * @returns Map<wwn, { comp:number, color:0|1|null, conflict:boolean }>
 *   conflict=true 는 홀수 사이클 — 같은 색끼리 zone 된 것으로, 가상화 계층이거나 설정 오류다.
 */
export function twoColor(zones) {
  const adj = new Map();
  const add = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
  for (const z of zones) {
    for (const a of z.wwns) { if (!adj.has(a)) adj.set(a, new Set()); for (const b of z.wwns) if (a !== b) add(a, b); }
  }
  const out = new Map();
  let comp = 0;
  for (const start of adj.keys()) {
    if (out.has(start)) continue;
    comp++;
    out.set(start, { comp, color: 0, conflict: false });
    const q = [start];
    while (q.length) {
      const cur = q.shift();
      const c = out.get(cur).color;
      for (const nb of adj.get(cur) || []) {
        if (!out.has(nb)) { out.set(nb, { comp, color: c === 0 ? 1 : 0, conflict: false }); q.push(nb); continue; }
        if (out.get(nb).color === c) { out.get(nb).conflict = true; out.get(cur).conflict = true; }
      }
    }
  }
  return out;
}

/**
 * 엔드포인트별 역할 판정.
 * 우선순위: ① 스위치가 실제로 본 것(nsshow FCP 역할) ② 2-색칠 + 색별 보조신호 다수결
 * ③ 보조신호 단독(추정) ④ unknown. 충돌(홀수 사이클) 노드는 'middle'.
 *
 * @param zones resolveZones().zones
 * @param ctx { nsRoles: {wwn:'initiator'|'target'}, portByWwn: {wwn:PortRow} }
 * @returns Map<wwn, { side, basis, confidence:'confirmed'|'inferred'|'guess'|'none', comp, conflict, hint }>
 */
export function classifyEndpoints(zones, ctx = {}) {
  const nsRoles = ctx.nsRoles || {};
  const colors = twoColor(zones);
  // 색별로 보조신호 표를 만든다 — 개별 노드가 아니라 **색 전체**의 다수결로 방향을 정한다.
  const tally = new Map(); // `${comp}|${color}` → { initiator, target }
  for (const [wwn, c] of colors) {
    if (c.color == null) continue;
    const key = `${c.comp}|${c.color}`;
    if (!tally.has(key)) tally.set(key, { initiator: 0, target: 0 });
    const t = tally.get(key);
    const ns = nsRoles[wwn];
    if (ns === 'initiator') t.initiator += 3;
    else if (ns === 'target') t.target += 3;
    const h = wwnHint(wwn);
    if (h?.side === 'initiator') t.initiator += 1;
    else if (h?.side === 'target') t.target += 1;
    else if (naaClass(wwn) === 'ieee48') t.initiator += 0.5;
  }
  const out = new Map();
  for (const [wwn, c] of colors) {
    const ns = nsRoles[wwn];
    const h = wwnHint(wwn);
    // ⚠ 순서가 중요하다: **확정 정보(네임서버)가 구조 추론보다 먼저**다. 반대로 두면 다중
    //   이니시에이터 zone(삼각형)이 전부 'middle' 로 덮여 그 결함을 영영 못 찾는다(테스트가 잡음).
    // 'both'(Initiator+Target)는 실제로 양쪽 역할을 겸하는 장비다 — 한쪽 열에 넣으면 거짓이
    // 되므로 가운데 열로 보낸다. 이것은 **확정**이다(추론으로 middle 이 된 것과 근거가 다르다).
    if (ns === 'both') { out.set(wwn, { side: 'middle', basis: '스위치 네임서버가 이니시에이터·타깃 겸용으로 보고', confidence: 'confirmed', comp: c.comp, conflict: c.conflict, hint: h }); continue; }
    if (ns === 'initiator' || ns === 'target') { out.set(wwn, { side: ns, basis: '스위치 네임서버가 보고한 FC4 역할', confidence: 'confirmed', comp: c.comp, conflict: c.conflict, hint: h }); continue; }
    if (c.conflict) { out.set(wwn, { side: 'middle', basis: '양쪽 색과 모두 연결 — 가상화 계층(예: VPLEX)이거나 같은 역할끼리 zone 됨', confidence: 'inferred', comp: c.comp, conflict: true, hint: h }); continue; }
    const t = tally.get(`${c.comp}|${c.color}`) || { initiator: 0, target: 0 };
    const other = tally.get(`${c.comp}|${c.color === 0 ? 1 : 0}`) || { initiator: 0, target: 0 };
    const mine = t.initiator - t.target;
    const theirs = other.initiator - other.target;
    if (mine === 0 && theirs === 0) { out.set(wwn, { side: 'unknown', basis: '역할을 가리킬 근거가 없습니다(네임서버 역할·WWN 단서 모두 없음)', confidence: 'none', comp: c.comp, conflict: false, hint: h }); continue; }
    const side = (mine > theirs) ? 'initiator' : (mine < theirs) ? 'target' : 'unknown';
    const basis = h ? `zone 그래프 2분할 + WWN 단서(${h.vendor}) — 추정` : 'zone 그래프 2분할 + 같은 쪽 다른 WWN 의 단서 — 추정';
    out.set(wwn, { side, basis, confidence: side === 'unknown' ? 'none' : 'inferred', comp: c.comp, conflict: false, hint: h });
  }
  return out;
}

/* ────────────────────────── 그래프 · 매트릭스 ────────────────────────── */

const labelOf = (wwn, ctx) => ctx.names?.[wwn] || ctx.aliasOf?.[wwn] || wwn;

/**
 * 화면이 그대로 그릴 수 있는 형태로 만든다.
 * @returns { nodes:[{wwn,label,alias,side,basis,confidence,degree,port,online,hint}],
 *            links:[{a,b,zone}], columns:{left,middle,right}, zonesTotal, unresolvedTotal }
 */
export function buildZoneGraph(zones, ctx = {}) {
  const roles = classifyEndpoints(zones, ctx);
  const degree = new Map();
  const links = [];
  for (const z of zones) {
    const w = z.wwns;
    for (const a of w) degree.set(a, (degree.get(a) || 0) + 1);
    for (let i = 0; i < w.length; i++) for (let j = i + 1; j < w.length; j++) links.push({ a: w[i], b: w[j], zone: z.name });
  }
  const aliasOf = {};
  for (const z of zones) for (const m of z.members) if (m.wwn && m.alias && !aliasOf[m.wwn]) aliasOf[m.wwn] = m.alias;
  const nctx = { ...ctx, aliasOf: { ...aliasOf, ...(ctx.aliasOf || {}) } };

  const nodes = [...degree.keys()].map((wwn) => {
    const r = roles.get(wwn) || { side: 'unknown', basis: '', confidence: 'none' };
    const port = ctx.portByWwn?.[wwn] || null;
    return {
      wwn, label: labelOf(wwn, nctx), alias: nctx.aliasOf[wwn] || '',
      side: r.side, basis: r.basis, confidence: r.confidence, conflict: !!r.conflict, comp: r.comp,
      hint: r.hint ? r.hint.vendor : '',
      degree: degree.get(wwn) || 0,
      port: port ? (port.slotPort ?? String(port.index)) : null,
      online: port ? port.state === 'online' : null,
    };
  }).sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label));

  const columns = {
    left: nodes.filter((n) => n.side === 'initiator').map((n) => n.wwn),
    middle: nodes.filter((n) => n.side === 'middle' || n.side === 'unknown').map((n) => n.wwn),
    right: nodes.filter((n) => n.side === 'target').map((n) => n.wwn),
  };
  return {
    nodes, links, columns,
    zonesTotal: zones.length,
    unresolvedTotal: zones.reduce((a, z) => a + z.unresolved.length, 0),
  };
}

/**
 * 매트릭스(행=이니시에이터 쪽, 열=타깃 쪽). 셀 값은 그 조합을 잇는 zone 수.
 * middle(가상화 계층)은 **행·열 양쪽에** 넣는다 — 한쪽에만 두면 절반이 안 보인다.
 */
export function buildZoneMatrix(graph) {
  const byWwn = new Map(graph.nodes.map((n) => [n.wwn, n]));
  const rows = graph.nodes.filter((n) => n.side === 'initiator' || n.side === 'middle' || n.side === 'unknown');
  const cols = graph.nodes.filter((n) => n.side === 'target' || n.side === 'middle');
  const rIdx = new Map(rows.map((n, i) => [n.wwn, i]));
  const cIdx = new Map(cols.map((n, i) => [n.wwn, i]));
  const cells = new Map(); // `${r}|${c}` → { n, zones:[] }
  const put = (rw, cw, zone) => {
    const r = rIdx.get(rw); const c = cIdx.get(cw);
    if (r == null || c == null) return;
    const k = `${r}|${c}`;
    if (!cells.has(k)) cells.set(k, { r, c, n: 0, zones: [] });
    const e = cells.get(k); e.n++; if (e.zones.length < 8) e.zones.push(zone);
  };
  for (const l of graph.links) {
    const A = byWwn.get(l.a); const B = byWwn.get(l.b);
    if (!A || !B) continue;
    put(l.a, l.b, l.zone);
    put(l.b, l.a, l.zone);   // 어느 쪽이 행인지 모를 때(middle·unknown)를 위해 양방향 시도
  }
  return { rows, cols, cells: [...cells.values()] };
}

/* ────────────────────────── 결함 점검 ────────────────────────── */

/**
 * 조닝 위생 점검. **판단 근거만 제시하고 '지우세요' 라고 말하지 않는다**(고아 VMDK v2.505 규약).
 * @param ctx { portByWwn, loggedInWwns:Set }
 */
export function zoneFindings(zones, graph, ctx = {}) {
  const logged = ctx.loggedInWwns instanceof Set ? ctx.loggedInWwns : new Set(ctx.loggedInWwns || []);
  const byWwn = new Map(graph.nodes.map((n) => [n.wwn, n]));
  const out = [];
  for (const z of zones) {
    // ⚠ `members`(원문 표기)만 세면, 호출자가 WWN 목록만 넘긴 zone 이 '멤버 0개' 로 오판된다.
    //   둘 중 큰 쪽을 멤버 수로 본다(테스트에서 실제로 걸린 결함).
    const total = Math.max((z.members || []).length, (z.wwns || []).length);
    if (total < 2) { out.push({ zone: z.name, kind: 'single-member', severity: 'warn', text: `멤버가 ${total}개 — 통신 상대가 없습니다.` }); continue; }
    const inits = z.wwns.filter((w) => byWwn.get(w)?.side === 'initiator');
    if (inits.length > 1) out.push({ zone: z.name, kind: 'multi-initiator', severity: 'warn', text: `이니시에이터로 판정된 멤버가 ${inits.length}개 — single-initiator 규약에서 벗어납니다(판정은 추정이니 확인 필요).` });
    if (z.unresolved.length) out.push({ zone: z.name, kind: 'unresolved', severity: 'info', text: `미해석 멤버 ${z.unresolved.length}개: ${z.unresolved.slice(0, 3).join(', ')}${z.unresolved.length > 3 ? ' …' : ''} (별칭 정의가 출력에 없거나 Domain,Port 표기)` });
    if (logged.size) {
      const off = z.wwns.filter((w) => !logged.has(w));
      if (off.length === z.wwns.length) out.push({ zone: z.name, kind: 'all-offline', severity: 'warn', text: '멤버 전원이 이 패브릭에 로그인해 있지 않습니다(다른 패브릭 소속이거나 미사용 zone).' });
      else if (off.length) out.push({ zone: z.name, kind: 'member-offline', severity: 'info', text: `로그인하지 않은 멤버 ${off.length}개 — 장비가 꺼져 있거나 다른 스위치에 붙어 있습니다.` });
    }
  }
  return out;
}

/**
 * 저장·전송용 상한(v2.511). 대형 패브릭은 zone 이 수천 개다 — 스냅샷은 매 주기 직렬화되고
 * 엣지 push 로 고RTT 회선을 탄다(`push.js`). 상한을 넘으면 **자르고 그 사실을 밝힌다**
 * (조용히 줄이면 '왜 일부만 보이지' 가 된다 — CLAUDE.md '조용한 상한 금지').
 */
export const ZONE_LIMITS = {
  zones: Math.max(50, Number(process.env.SANSW_ZONE_MAX) || 4000),
  aliases: Math.max(50, Number(process.env.SANSW_ALIAS_MAX) || 8000),
  membersPerZone: 64,
};

/**
 * 수집기가 스냅샷에 넣을 형태로 압축. 파서 원본(defined 전체)을 그대로 실으면 대형 패브릭에서
 * 스냅샷이 수 MB 가 된다 — 화면이 쓰는 것만 남긴다.
 * @returns { effectiveConfig, source, zones:[{name,members:string[]}], aliases:{}, counts, truncated, limited }
 */
export function compactZoning(parsed, resolved, { limits = ZONE_LIMITS } = {}) {
  const zones = resolved.zones.slice(0, limits.zones).map((z) => ({
    name: z.name,
    // 해석된 WWN 우선, 미해석 멤버(Domain,Port·정의 없는 별칭)도 원문 그대로 남긴다.
    members: [...z.wwns, ...z.unresolved].slice(0, limits.membersPerZone),
    aliasOf: Object.fromEntries(z.members.filter((m) => m.wwn && m.alias).map((m) => [m.wwn, m.alias])),
  }));
  const aliasEntries = Object.entries(parsed?.defined?.aliases || {}).slice(0, limits.aliases);
  return {
    effectiveConfig: resolved.cfgName || '',
    source: resolved.source,
    zones,
    aliases: Object.fromEntries(aliasEntries.map(([k, v]) => [k, v.map(normWwn).filter(Boolean)])),
    counts: {
      zones: resolved.zones.length,
      definedZones: Object.keys(parsed?.defined?.zones || {}).length,
      aliases: Object.keys(parsed?.defined?.aliases || {}).length,
      cfgs: Object.keys(parsed?.defined?.cfgs || {}).length,
    },
    truncated: !!parsed?.truncated,
    limited: resolved.zones.length > limits.zones || Object.keys(parsed?.defined?.aliases || {}).length > limits.aliases,
  };
}

/** compactZoning 결과 → resolveZones 와 같은 형태(화면·분석이 같은 함수를 쓰게). */
export function zonesFromCompact(z) {
  return (z?.zones || []).map((row) => {
    const wwns = []; const unresolved = []; const members = [];
    for (const raw of row.members || []) {
      const w = normWwn(raw);
      if (w) { wwns.push(w); members.push({ raw, kind: 'wwn', wwn: w, alias: row.aliasOf?.[w] || '' }); }
      else { unresolved.push(raw); members.push({ raw, kind: memberKind(raw), wwn: null, alias: memberKind(raw) === 'alias' ? raw : '' }); }
    }
    return { name: row.name, members, wwns: [...new Set(wwns)], unresolved };
  });
}

/** 화면 요약 숫자. */
export function zoneSummary(parsed, resolved, graph) {
  const defZones = Object.keys(parsed?.defined?.zones || {}).length;
  const effZones = Object.keys(parsed?.effective?.zones || {}).length;
  return {
    cfgName: resolved.cfgName, source: resolved.source,
    definedZones: defZones, effectiveZones: effZones,
    aliases: Object.keys(parsed?.defined?.aliases || {}).length,
    cfgs: Object.keys(parsed?.defined?.cfgs || {}).length,
    zones: resolved.zones.length,
    endpoints: graph.nodes.length,
    initiators: graph.columns.left.length,
    targets: graph.columns.right.length,
    middle: graph.nodes.filter((n) => n.side === 'middle').length,
    unknown: graph.nodes.filter((n) => n.side === 'unknown').length,
    links: graph.links.length,
    unresolved: graph.unresolvedTotal,
    truncated: !!parsed?.truncated,
  };
}
