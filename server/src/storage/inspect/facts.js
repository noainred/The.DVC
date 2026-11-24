/**
 * storage/inspect/facts.js — 점검 **사실(facts)** 만들기 · 정제(v2.965 · 순수).
 *
 * 흐름: 장비 출력(SSH 텍스트 · `--format json` · REST JSON) + 이미 있는 수집 스냅샷 → facts(아는 필드만) → judge.js 가 판정.
 *  · facts 의 값이 null 이면 '못 읽음' 이고 `why[키]` 에 사유를 적는다(판정은 확인 불가 — 0 · 정상으로 바꾸지 않는다).
 *  · 엣지가 보낸 facts 는 `sanitizeFacts` 로 다시 자른다(아는 키 · 객체만 · 수는 수로 · 문자열 상한 · 목록 상한) — 중앙 정제 화이트리스트.
 *  · 파서는 입력 길이를 먼저 자르고 줄 단위 · 앵커 있는 짧은 정규식만 쓴다(ReDoS 규칙).
 *
 * ⚠⚠ 정직 기록 — **실장비 출력 미확인**: `isi … --format json` 의 행 모양(필드 이름) · REST `cluster/nodes` 의 drives/status 하위 필드 ·
 *   `sysctl efs.gmp.group` · `isi_hw_status` · `gmirror status` 텍스트 모양은 문서 인용과 기억으로 짠 추정이다. 모양을 못 알아보면 null(확인 불가 —
 *   '출력 형식 미인식')로 남기고 정상으로 칠하지 않는다. 첫 실장비 점검의 '원본 출력' 으로 보정할 것(README §2).
 *   스냅샷에서 가져오는 값(isi status 의 Cluster Health · Critical Events · 잡 · VHS · 노드 플래그)은 기존 수집기가 실물 표본으로 고정한 파서의 결과다.
 */
import { numOrNull } from '../../util/numOrNull.js';
import { capStr } from '../../util/capStr.js';
import { healthWord } from '../healthWord.js';

const TEXT_MAX = 4 * 1024 * 1024;
const str = (v, n) => (typeof v === 'string' || typeof v === 'number' ? capStr(v, n) : '');  // 이력에 상주 — 평탄화(util/capStr.js)
const int = (v, lo = 0, hi = 1e9) => { const n = numOrNull(v); return n == null || !Number.isFinite(n) ? null : Math.max(lo, Math.min(hi, Math.round(n))); };
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** JSON 문자열 → 값(실패하면 null). 앞뒤 잡문자(경고 줄)가 있으면 첫 [ 또는 { 부터 다시 시도한다(정규식 없이 indexOf). */
export function jsonOf(text) {
  if (text == null) return null;
  if (typeof text !== 'string') return text;
  const t = text.slice(0, TEXT_MAX).trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* 아래 */ }
  const a = t.indexOf('['); const o = t.indexOf('{');
  const i = a < 0 ? o : o < 0 ? a : Math.min(a, o);
  if (i <= 0) return null;
  try { return JSON.parse(t.slice(i)); } catch { return null; }
}
/** 배열 꺼내기 — 배열이면 그대로, 객체면 keys 중 첫 배열. */
export function listOf(v, keys = []) {
  if (Array.isArray(v)) return v;
  if (!isObj(v)) return null;
  for (const k of keys) if (Array.isArray(v[k])) return v[k];
  return null;
}
const firstOf = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return null; };
const linesOf = (text) => String(text ?? '').slice(0, TEXT_MAX).split(/\r?\n/);
/** 'cluster-3: 내용' · 'node-3: 내용' · 'mycluster-12: 내용'(isi_for_array 접두) → [lnn, 내용]. 접두가 없으면 [null, 줄]. */
export function arrayPrefix(line) {
  const l = String(line).slice(0, 2000);
  const m = /^([A-Za-z0-9_.]+(?:-[A-Za-z0-9_.]+)*)-(\d{1,4}):\s?(.*)$/.exec(l);
  return m ? [Number(m[2]), m[3]] : [null, l];
}

/* ── 스냅샷(기존 수집값) ───────────────────────────────────────────── */
/**
 * 최신 수집 스냅샷 → facts 일부(cluster-health · events · node-state · capacity · pools · vhs · jobs). 스냅샷이 없거나 그 절을 못 읽었으면 why 에 사유.
 * SSH 스냅샷: extra.clusterHealth · extra.criticalEvents(critical 만) · extra.jobs · extra.vhsBytes. REST 스냅샷: 노드 상태 · alerts.unresolved(심각도 없음).
 */
export function factsFromSnapshot(snap) {
  const facts = {}; const why = {};
  if (!isObj(snap)) {
    for (const k of ['health', 'events', 'nodeState', 'capacity', 'pools', 'jobs']) why[k] = '수집 스냅샷이 없습니다(이 장비를 아직 한 번도 수집하지 못했습니다)';
    return { facts, why };
  }
  const ex = isObj(snap.extra) ? snap.extra : {};
  const sec = isObj(snap.sections) ? snap.sections : {};
  facts.version = str(snap.version, 40) || null;
  const list = Array.isArray(snap.nodes?.list) ? snap.nodes.list : [];
  facts.nodeCount = int(snap.nodes?.count, 0, 512) ?? (list.length || null);
  // 1 클러스터 건강
  const hw = str(ex.clusterHealth, 24).trim().toUpperCase();
  if (hw) facts.health = { word: hw, derived: false };
  else if (list.length) {
    const bad = list.filter((n) => healthWord(String(n?.health ?? '')) === 'bad').length;
    const unk = list.filter((n) => healthWord(String(n?.health ?? '')) === 'unknown').length;
    facts.health = { word: bad ? 'ATTENTION' : unk ? '' : 'OK', derived: true, ...(unk && !bad ? { unknownNodes: unk } : {}) };
    if (unk && !bad) why.health = `노드 ${unk}대의 상태를 읽지 못했습니다(REST — Cluster Health 대신 노드 상태로 판단)`;
  } else why.health = sec.nodes && sec.nodes !== 'ok' ? `노드 절을 읽지 못했습니다: ${str(sec.nodes, 120)}` : '스냅샷에 클러스터 건강 · 노드 상태가 없습니다';
  // 3 미해결 이벤트(스냅샷 — SSH 는 Critical Events 절 = critical 만, REST 는 전체 건수 · 심각도 없음)
  const unresolved = numOrNull(snap.alerts?.unresolved);
  if (unresolved != null) {
    facts.events = ex.collectMethod === 'ssh' || hw
      ? { total: unresolved, critical: unresolved, warning: null, severityKnown: true, source: 'isi-status' }
      : { total: unresolved, critical: null, warning: null, severityKnown: false, source: 'rest-count' };
  } else why.events = sec.alerts && sec.alerts !== 'ok' ? str(sec.alerts, 160) : '스냅샷에 미해결 이벤트 수가 없습니다';
  // 4 노드 상태
  if (list.length) {
    const bad = []; let unknown = 0;
    for (const n of list.slice(0, 64)) {
      const h = String(n?.health ?? '');
      const w = healthWord(h);
      if (w === 'bad') bad.push({ lnn: int(n?.id, 0, 4096), state: str(h, 24) });
      else if (w === 'unknown') unknown += 1;
    }
    facts.nodeState = { total: list.length, bad, unknown };
  } else why.nodeState = '스냅샷에 노드 목록이 없습니다';
  // 12 · 13 용량
  const cap = isObj(snap.capacity) ? snap.capacity : null;
  if (cap && numOrNull(cap.pct) != null) facts.capacity = { pct: numOrNull(cap.pct), totalBytes: numOrNull(cap.totalBytes), usedBytes: numOrNull(cap.usedBytes) };
  else why.capacity = sec.capacity && sec.capacity !== 'ok' ? str(sec.capacity, 160) : '스냅샷에 용량 사용률이 없습니다';
  if (Array.isArray(snap.pools) && snap.pools.length) facts.pools = snap.pools.slice(0, 32).map((p) => ({ name: str(p?.name, 60), pct: numOrNull(p?.pct) }));
  else why.pools = sec.pools && sec.pools !== 'ok' ? str(sec.pools, 160) : '스냅샷에 노드 풀이 없습니다';
  // 14 가상 핫 스페어(SSH isi status 의 VHS 크기 — 실물 표본으로 고정된 파서). REST 는 runner 가 settings 로 채운다.
  const vb = numOrNull(ex.vhsBytes); const tot = numOrNull(cap?.totalBytes);
  if (ex.collectMethod === 'ssh' && vb != null) facts.vhs = { enabled: vb > 0, pct: tot > 0 ? Math.round((vb / tot) * 1000) / 10 : null, bytes: vb, source: 'isi-status' };
  // 18 · 19 잡(SSH isi status 의 Running · Paused · Failed jobs)
  if (ex.collectMethod === 'ssh' && isObj(ex.jobs)) facts.jobs = jobsFromIsiStatus(ex.jobs);
  return { facts, why };
}
/** isi status 잡 절(parseIsiStatus 결과) → { failed, running }. 잡 이름은 'FlexProtect[1234]' 꼴. */
export function jobsFromIsiStatus(j) {
  const nm = (x) => str(x?.job, 60);
  const running = [...(Array.isArray(j?.running) ? j.running : []), ...(Array.isArray(j?.paused) ? j.paused : [])].slice(0, 20)
    .map((x) => ({ name: nm(x), phase: str(x?.phase, 24), progress: str(x?.state || x?.phase, 24) }));
  const failed = (Array.isArray(j?.failed) ? j.failed : []).slice(0, 20).map((x) => ({ name: nm(x), detail: str(x?.detail, 80) }));
  return { failed, running };
}

/* ── SSH 텍스트 파서 ──────────────────────────────────────────────── */
/**
 * `sysctl efs.gmp.group` → { inGroup, total, down:[] }. 예(추정): `efs.gmp.group: <2,272>: { 1-3:0-14, 4:0-13, smb: 1-4, nfs: 1-4 }`.
 * 중괄호 안 '노드범위:드라이브범위' 원소의 노드 번호를 모으고, `down: 5` 같은 원소는 down 으로 센다. total 은 스냅샷 노드 수(없으면 본 노드 수).
 */
export function parseGroup(text, totalNodes = null) {
  const t = String(text ?? '').slice(0, 64 * 1024);
  const a = t.indexOf('{'); const b = t.indexOf('}', a + 1);
  if (a < 0 || b < 0) return null;
  const inner = t.slice(a + 1, b);
  const nodes = new Set(); const down = new Set();
  const addRange = (spec, set) => {
    for (const part of String(spec).split(/[,\s]+/).filter(Boolean)) {
      const m = /^(\d{1,4})(?:-(\d{1,4}))?$/.exec(part);
      if (!m) continue;
      const lo = Number(m[1]); const hi = m[2] ? Number(m[2]) : lo;
      for (let i = lo; i <= Math.min(hi, lo + 512); i += 1) set.add(i);
    }
  };
  for (const el of inner.split(',').map((s) => s.trim()).filter(Boolean)) {
    const nd = /^(\d{1,4}(?:-\d{1,4})?):\d/.exec(el);
    if (nd) { addRange(nd[1], nodes); continue; }
    const dn = /^down:\s*([\d\s,-]{1,200})$/.exec(el);
    if (dn) addRange(dn[1], down);
  }
  if (!nodes.size && !down.size) return null;
  for (const d of down) nodes.delete(d);
  const total = int(totalNodes, 1, 4096) ?? (nodes.size + down.size);
  return { inGroup: nodes.size, total, down: [...down].sort((x, y) => x - y).slice(0, 64) };
}
/** `isi_for_array -s 'gmirror status'` → { total, bad:[lnn] }. COMPLETE 만 정상, DEGRADED · 그 밖 상태는 bad. 노드 접두가 없으면 null. */
export function parseBootMirror(text) {
  const per = new Map();
  for (const line of linesOf(text)) {
    const [lnn, rest] = arrayPrefix(line);
    if (lnn == null) continue;
    const m = /^\s*mirror\/\S+\s+(\S+)/i.exec(String(rest).slice(0, 400));
    if (!m) continue;
    const ok = /^COMPLETE$/i.test(m[1]);
    per.set(lnn, (per.get(lnn) ?? true) && ok);
  }
  if (!per.size) return null;
  return { total: per.size, bad: [...per].filter(([, ok]) => !ok).map(([l]) => l).sort((x, y) => x - y).slice(0, 64) };
}
/**
 * `isi_for_array -s "isi_hw_status | grep -i -A3 'Power Supplies'"` → { total, bad:[{lnn,text}] }. KB 000020717 의 명령을 노드마다.
 * 'Power Supplies' 머리 뒤 줄에서 공급 장치 줄(PS · PSU · Supply)을 세고 good/ok 가 아니면 bad. 모양을 못 알아보면 null.
 */
export function parsePsuText(text) {
  const rows = []; let header = false;
  for (const line of linesOf(text)) {
    const [lnn, rest] = arrayPrefix(line);
    const r = String(rest).slice(0, 400).trim();
    if (/power supplies/i.test(r)) { header = true; continue; }
    if (!header || !r || /^-+$/.test(r)) continue;
    if (!/(^|\s)(ps|psu|supply|power supply)\s*[\dab]/i.test(r)) continue;
    const good = /\b(good|ok|normal|present)\b/i.test(r) && !/\b(fail|failed|bad|missing|absent|error|fault|not present)\b/i.test(r);
    rows.push({ lnn, text: r.slice(0, 80), good });
  }
  if (!rows.length) return null;
  return { total: rows.length, bad: rows.filter((x) => !x.good).slice(0, 64).map(({ lnn, text: tx }) => ({ lnn, text: tx })) };
}

/* ── JSON(CLI --format json · REST) 파서 ──────────────────────────── */
const lnnOf = (o) => int(firstOf(o, ['lnn', 'node', 'node_lnn', 'devid', 'id']), 0, 4096);
/** 드라이브 목록 → { total, notHealthy }. HEALTHY · L3 · JOURNAL 은 정상, EMPTY(빈 베이)는 세지 않는다(KB 000035312 의 egrep -v 와 같은 뜻). */
export function parseDrives(v) {
  const j = jsonOf(v);
  let list = listOf(j, ['drives', 'devices']);
  // REST cluster/nodes 모양: { nodes:[{ lnn, drives:[…] }] }
  const nodes = listOf(j, ['nodes']);
  if (!list && nodes) { list = []; for (const n of nodes.slice(0, 512)) for (const d of (Array.isArray(n?.drives) ? n.drives : [])) list.push({ lnn: n?.lnn ?? n?.id, ...d }); }
  if (!list) return null;
  let total = 0; const notHealthy = []; let sawState = false;
  for (const d of list.slice(0, 8192)) {
    const st = str(firstOf(d, ['ui_state', 'state', 'status', 'health']), 24).trim().toUpperCase();
    if (!st) continue;
    sawState = true;
    if (st === 'EMPTY') continue;
    total += 1;
    if (!/^(HEALTHY|L3|JOURNAL)$/.test(st)) notHealthy.push({ lnn: lnnOf(d), bay: str(firstOf(d, ['baynum', 'bay', 'lnum', 'location']), 16), state: st });
  }
  if (!sawState) return null;
  return { total, notHealthy: notHealthy.slice(0, 64) };
}
/**
 * `isi devices drive list --node-lnn all`(텍스트 — --format json 이 안 되는 판의 대체) → { total, notHealthy }.
 * 열: Lnn · Location(Bay 1) · Device · Lnum · State · Serial · Sled(KB 000047373 의 예시 머리줄). 줄 모양을 못 알아보면 null.
 */
export function parseDrivesText(text) {
  let total = 0; const notHealthy = []; let rows = 0;
  for (const line of linesOf(text)) {
    const m = /^\s*(\d{1,4})\s+(Bay\s+\S{1,8}|\S{1,16})\s+(\S{1,40})\s+(\d{1,4})\s+([A-Z][A-Z_]{1,23})\b/.exec(String(line).slice(0, 400));
    if (!m) continue;
    rows += 1;
    const st = m[5];
    if (st === 'EMPTY') continue;
    total += 1;
    if (!/^(HEALTHY|L3|JOURNAL)$/.test(st)) notHealthy.push({ lnn: Number(m[1]), bay: m[2].replace(/\s+/g, ' ').slice(0, 16), state: st });
  }
  return rows ? { total, notHealthy: notHealthy.slice(0, 64) } : null;
}
const BAD_WORD = /\b(fail|failed|failure|bad|error|fault|replace|missing|absent|degraded|critical|not ?present|low)\b/i;
const GOOD_WORD = /\b(good|ok|healthy|normal|charged|ready|pass(ed)?|present|enabled|full)\b/i;
/** 배터리(isi batterystatus list --format json · REST nodes[].status.batterystatus) → { total, bad }. status 류 필드의 낱말로 판단. */
export function parseBatteries(v) {
  const j = jsonOf(v);
  let list = listOf(j, ['batterystatus', 'batteries', 'nodes']);
  if (!list) return null;
  const rows = [];
  for (const raw of list.slice(0, 512)) {
    const o = isObj(raw?.status?.batterystatus) ? { lnn: raw.lnn ?? raw.id, ...raw.status.batterystatus } : isObj(raw?.batterystatus) ? { lnn: raw.lnn ?? raw.id, ...raw.batterystatus } : raw;
    if (!isObj(o)) continue;
    if (o.supported === false || o.present === false) continue; // 배터리 없는 노드(NVRAM 이 없는 모델)는 세지 않는다
    const texts = Object.entries(o).filter(([k, val]) => /status|result|state|health/i.test(k) && (typeof val === 'string')).map(([, val]) => String(val).slice(0, 40));
    if (!texts.length) continue;
    const joined = texts.join(' ');
    const bad = BAD_WORD.test(joined) && !/\b(n\/a|none)\b/i.test(joined);
    rows.push({ lnn: lnnOf(o), text: joined.slice(0, 80), bad });
  }
  if (!rows.length) return null;
  return { total: rows.length, bad: rows.filter((r) => r.bad).slice(0, 64).map(({ lnn, text }) => ({ lnn, text })) };
}
/** 전원(REST nodes[].status.powersupplies.supplies[]) → { total, bad }. good 불리언이 있으면 그것, 없으면 status 낱말. */
export function parseRestPsu(v) {
  const nodes = listOf(jsonOf(v), ['nodes']);
  if (!nodes) return null;
  const rows = [];
  for (const n of nodes.slice(0, 512)) {
    const ps = n?.status?.powersupplies;
    const sup = Array.isArray(ps?.supplies) ? ps.supplies : null;
    if (!sup) continue;
    for (const s of sup.slice(0, 16)) {
      const good = typeof s?.good === 'boolean' ? s.good : (GOOD_WORD.test(String(s?.status ?? '')) && !BAD_WORD.test(String(s?.status ?? '')));
      rows.push({ lnn: int(n?.lnn ?? n?.id, 0, 4096), text: str(`${s?.name ?? s?.id ?? ''} ${s?.status ?? ''}`.trim(), 80), good });
    }
  }
  if (!rows.length) return null;
  return { total: rows.length, bad: rows.filter((r) => !r.good).slice(0, 64).map(({ lnn, text }) => ({ lnn, text })) };
}
/** 네트워크 인터페이스 → { configured, down }. 구성됨 = IP 가 있거나 풀에 속함. up 이 아니면 down. */
export function parseIfaces(v) {
  const list = listOf(jsonOf(v), ['interfaces']);
  if (!list) return null;
  let configured = 0; const down = []; let sawStatus = false;
  for (const i of list.slice(0, 4096)) {
    const ips = firstOf(i, ['ip_addrs', 'ip_addresses', 'ips']);
    const owners = firstOf(i, ['owners', 'pools']);
    const has = (Array.isArray(ips) && ips.length > 0) || (Array.isArray(owners) && owners.length > 0);
    const st = str(firstOf(i, ['status', 'state', 'link_status']), 24).trim();
    if (st) sawStatus = true;
    if (!has) continue;
    configured += 1;
    if (st && !/^up$/i.test(st)) down.push({ lnn: lnnOf(i), name: str(firstOf(i, ['name', 'iface', 'interface']), 32), status: st });
  }
  if (!sawStatus) return null;
  return { configured, down: down.slice(0, 64) };
}
/** HealthCheck 평가 목록 → { evaluations, failed, lastAt }. 결과 낱말에 FAIL · CRITICAL · EMERGENCY 가 있으면 실패로 센다. */
export function parseHealthcheck(v) {
  const list = listOf(jsonOf(v), ['evaluations']);
  if (!list) return null;
  // v2.965 반증 F12: 기준은 '최근 평가에 FAIL 없음' — 체크리스트마다 **가장 최근 평가 하나만** 본다(180일 전 FAIL + 어제 PASS 는 정상).
  //   시각이 없는 평가는 목록 뒤쪽을 최근으로 본다(같은 체크리스트 안에서 — 시각 있는 평가가 있으면 그쪽이 이긴다).
  const latest = new Map(); let lastAt = null;
  list.slice(0, 2000).forEach((e, idx) => {
    const res = str(firstOf(e, ['overall_status', 'result', 'status', 'run_status']), 24).trim();
    const t = numOrNull(firstOf(e, ['start_time', 'started', 'time', 'end_time']));
    const ms = t == null ? null : (t < 1e12 ? t * 1000 : t);
    if (ms != null && (lastAt == null || ms > lastAt)) lastAt = ms;
    const cl = str(firstOf(e, ['checklist_id', 'checklist', 'item']), 60);
    const key = cl || `#${idx}`;
    const cur = latest.get(key);
    const newer = !cur || (ms != null && (cur.ms == null || ms >= cur.ms)) || (ms == null && cur.ms == null);
    if (newer) latest.set(key, { ms, res, id: str(firstOf(e, ['id', 'evaluation_id']), 40), checklist: cl });
  });
  const failed = [...latest.values()].filter((x) => /fail|critical|emergency/i.test(x.res)).map((x) => ({ id: x.id, checklist: x.checklist, result: x.res }));
  return { evaluations: list.length, failed: failed.slice(0, 20), lastAt };
}
/** NTP 서버 목록 → { servers }. */
export function parseNtp(v) {
  const list = listOf(jsonOf(v), ['servers']);
  return list ? { servers: list.length } : null;
}
/** storagepool settings → { enabled, pct, drives }. virtual_hot_spare_limit_percent · _limit_drives 중 하나라도 0 보다 크면 켜짐. */
export function parseVhsSettings(v) {
  let j = jsonOf(v);
  if (isObj(j?.settings)) j = j.settings;
  if (!isObj(j)) return null;
  const pct = numOrNull(firstOf(j, ['virtual_hot_spare_limit_percent', 'vhs_limit_percent']));
  const drives = numOrNull(firstOf(j, ['virtual_hot_spare_limit_drives', 'vhs_limit_drives']));
  if (pct == null && drives == null) return null;
  return { enabled: (pct || 0) > 0 || (drives || 0) > 0, pct, drives, source: 'settings' };
}
/** 스냅샷 목록 → { count, usedBytes, largestBytes, partial }. 쪽 넘김(resume)이 남았으면 partial — 합계는 하한. */
export function parseSnapshots(v) {
  const j = jsonOf(v);
  const list = listOf(j, ['snapshots']);
  if (!list) return null;
  let used = 0; let largest = null; let sized = 0;
  for (const s of list.slice(0, 200_000)) {
    const b = numOrNull(firstOf(s, ['size', 'size_bytes', 'bytes']));
    if (b == null || b < 0) continue;
    sized += 1; used += b; if (largest == null || b > largest) largest = b;
  }
  if (list.length && !sized) return null;
  // 반증 F15: 크기를 못 읽은 행을 뺐으면 합계는 하한 — partial 로 밝힌다.
  return { count: list.length, usedBytes: used, largestBytes: largest, partial: !!(isObj(j) && j.resume) || sized < Math.min(list.length, 200_000) || list.length > 200_000 };
}
/** SyncIQ 정책 수. */
export function parseSyncPolicies(v) {
  const list = listOf(jsonOf(v), ['policies']);
  return list ? { policies: list.length } : null;
}
/** SyncIQ 보고서 → 지난 7일 { reports, failed, failedPolicies }. 시각은 초 또는 밀리초. */
export function parseSyncReports(v, { now = Date.now(), days = 7 } = {}) {
  const j = jsonOf(v);
  const list = listOf(j, ['reports']);
  if (!list) return null;
  const from = now - days * 86_400_000;
  let reports = 0; let failed = 0; const fp = new Set();
  for (const r of list.slice(0, 20_000)) {
    const t0 = numOrNull(firstOf(r, ['start_time', 'end_time', 'started', 'time']));
    if (t0 == null) continue;
    const ms = t0 < 1e12 ? t0 * 1000 : t0;
    if (ms < from || ms > now + 3_600_000) continue;
    reports += 1;
    if (/fail|error/i.test(str(firstOf(r, ['state', 'status', 'result']), 24))) { failed += 1; const p = str(firstOf(r, ['policy_name', 'policy', 'name']), 60); if (p) fp.add(p); }
  }
  // 반증 F11: 쪽 넘김(resume)이 남았으면 읽은 쪽만 셌다 — partial(실패 0 을 정상으로 단정하지 않는다).
  return { reports, failed, failedPolicies: [...fp].slice(0, 20), partial: !!(isObj(j) && j.resume) || list.length > 20_000 };
}
/** 미해결 이벤트 그룹 → { total, critical, warning, severityKnown }. emergency 는 critical 로 센다. */
export function parseEventGroups(v) {
  const j = jsonOf(v);
  const list = listOf(j, ['eventgroups', 'events', 'groups']);
  if (!list) return null;
  let critical = 0; let warning = 0; let sev = 0;
  for (const e of list.slice(0, 20_000)) {
    if (e?.resolved === true) continue;
    const s = str(firstOf(e, ['severity', 'level']), 16).toLowerCase();
    if (!s) continue;
    sev += 1;
    if (/crit|emerg/.test(s)) critical += 1; else if (/warn/.test(s)) warning += 1;
  }
  const total = list.filter((e) => e?.resolved !== true).length;
  return { total, critical: sev ? critical : null, warning: sev ? warning : null, severityKnown: sev > 0, source: 'event-groups', partial: !!(isObj(j) && j.resume) || list.length > 20_000 };
}
/** 잡 엔진(REST job/jobs · isi job jobs list --format json) → { failed, running }. */
export function parseJobs(v) {
  const list = listOf(jsonOf(v), ['jobs']);
  if (!list) return null;
  const failed = []; const running = [];
  for (const j of list.slice(0, 500)) {
    const st = str(firstOf(j, ['state', 'status']), 24).toLowerCase();
    const name = str(firstOf(j, ['type', 'name', 'job']), 60);
    if (/fail/.test(st)) failed.push({ name, detail: st });
    else if (/run|pause|wait/.test(st)) running.push({ name, phase: str(firstOf(j, ['current_phase', 'phase']), 24), progress: str(firstOf(j, ['progress', 'percent']), 24) || st });
  }
  return { failed: failed.slice(0, 20), running: running.slice(0, 20) };
}

/* ── 정제(엣지 → 중앙 · 저장 직전) ─────────────────────────────────── */
export const FACT_KEYS = Object.freeze(['version', 'nodeCount', 'health', 'group', 'events', 'nodeState', 'drives', 'bootMirror', 'psu', 'battery', 'ifaces',
  'healthcheck', 'ntp', 'capacity', 'pools', 'vhs', 'snapshots', 'jobs', 'synciq']);
const arr = (v, n, f) => (Array.isArray(v) ? v.slice(0, n).map(f).filter((x) => x != null) : []);
// 반증 F3: 판정에 쓰는 목록 · 개수가 빠졌거나 모양이 틀리면 그 사실 전체를 버린다(null → 확인 불가). 0 · [] 로 채우면 '정상' 이 된다.
const isArr = Array.isArray;
const lnnOrNull = (v) => int(v, 0, 4096);
const numN = (v) => { const n = numOrNull(v); return n == null || !Number.isFinite(n) ? null : n; };
const SAN = {
  version: (v) => str(v, 40) || null,
  nodeCount: (v) => int(v, 0, 4096),
  health: (v) => (isObj(v) ? { word: str(v.word, 24).toUpperCase(), derived: v.derived === true, ...(int(v.unknownNodes, 0, 4096) ? { unknownNodes: int(v.unknownNodes, 0, 4096) } : {}) } : null),
  group: (v) => (isObj(v) && int(v.inGroup) != null && int(v.total) != null && (v.down == null || isArr(v.down)) ? { inGroup: int(v.inGroup, 0, 4096), total: int(v.total, 0, 4096), down: arr(v.down, 64, lnnOrNull) } : null),
  events: (v) => (isObj(v) && int(v.total) != null ? { total: int(v.total), critical: int(v.critical), warning: int(v.warning), severityKnown: v.severityKnown === true && int(v.critical) != null, source: str(v.source, 24), partial: v.partial === true } : null),
  nodeState: (v) => (isObj(v) && int(v.total) > 0 && isArr(v.bad) && int(v.unknown) != null ? { total: int(v.total, 0, 4096), bad: arr(v.bad, 64, (x) => (isObj(x) ? { lnn: lnnOrNull(x.lnn), state: str(x.state, 24) } : null)), unknown: int(v.unknown, 0, 4096) } : null),
  drives: (v) => (isObj(v) && int(v.total) > 0 && isArr(v.notHealthy) ? { total: int(v.total), notHealthy: arr(v.notHealthy, 64, (x) => (isObj(x) ? { lnn: lnnOrNull(x.lnn), bay: str(x.bay, 16), state: str(x.state, 24) } : null)) } : null),
  bootMirror: (v) => (isObj(v) && int(v.total) > 0 && isArr(v.bad) ? { total: int(v.total, 0, 4096), bad: arr(v.bad, 64, lnnOrNull) } : null),
  psu: (v) => (isObj(v) && int(v.total) > 0 && isArr(v.bad) ? { total: int(v.total), bad: arr(v.bad, 64, (x) => (isObj(x) ? { lnn: lnnOrNull(x.lnn), text: str(x.text, 80) } : null)) } : null),
  battery: (v) => (isObj(v) && int(v.total) > 0 && isArr(v.bad) ? { total: int(v.total), bad: arr(v.bad, 64, (x) => (isObj(x) ? { lnn: lnnOrNull(x.lnn), text: str(x.text, 80) } : null)) } : null),
  ifaces: (v) => (isObj(v) && int(v.configured) != null && isArr(v.down) ? { configured: int(v.configured), down: arr(v.down, 64, (x) => (isObj(x) ? { lnn: lnnOrNull(x.lnn), name: str(x.name, 32), status: str(x.status, 24) } : null)) } : null),
  healthcheck: (v) => (isObj(v) && int(v.evaluations) != null && isArr(v.failed) ? { evaluations: int(v.evaluations), failed: arr(v.failed, 20, (x) => (isObj(x) ? { id: str(x.id, 40), checklist: str(x.checklist, 60), result: str(x.result, 24) } : null)), lastAt: numN(v.lastAt) } : null),
  ntp: (v) => (isObj(v) && int(v.servers) != null ? { servers: int(v.servers, 0, 1000) } : null),
  capacity: (v) => (isObj(v) && numN(v.pct) != null ? { pct: Math.max(0, Math.min(1000, numN(v.pct))), totalBytes: numN(v.totalBytes), usedBytes: numN(v.usedBytes) } : null),
  pools: (v) => (Array.isArray(v) ? arr(v, 32, (x) => (isObj(x) ? { name: str(x.name, 60), pct: numN(x.pct) } : null)) : null),
  vhs: (v) => (isObj(v) ? { enabled: typeof v.enabled === 'boolean' ? v.enabled : null, pct: numN(v.pct), bytes: numN(v.bytes), drives: numN(v.drives), source: str(v.source, 16) } : null),
  snapshots: (v) => (isObj(v) && int(v.count) != null && numN(v.usedBytes) != null ? { count: int(v.count), usedBytes: numN(v.usedBytes), largestBytes: numN(v.largestBytes), partial: v.partial === true } : null),
  jobs: (v) => (isObj(v) && isArr(v.failed) && isArr(v.running) ? { failed: arr(v.failed, 20, (x) => (isObj(x) ? { name: str(x.name, 60), detail: str(x.detail, 80) } : null)), running: arr(v.running, 20, (x) => (isObj(x) ? { name: str(x.name, 60), phase: str(x.phase, 24), progress: str(x.progress, 24) } : null)) } : null),
  synciq: (v) => (isObj(v) && int(v.policies) != null && (int(v.policies) === 0 || (int(v.reports) != null && int(v.failed) != null)) ? { policies: int(v.policies), reports: int(v.reports) ?? 0, failed: int(v.failed) ?? 0, failedPolicies: arr(v.failedPolicies, 20, (x) => str(x, 60) || null), partial: v.partial === true } : null),
};
/** facts · why 정제 — 아는 키만 · 객체만 · 상한. 모르는 키 · 객체가 아닌 값은 버린다. */
export function sanitizeFacts(raw) {
  const facts = {}; const why = {};
  const src = isObj(raw?.facts) ? raw.facts : {};
  for (const k of FACT_KEYS) {
    if (!Object.hasOwn(src, k) || src[k] == null) continue;
    const v = SAN[k](src[k]);
    if (v != null) facts[k] = v;
  }
  const w = isObj(raw?.why) ? raw.why : {};
  for (const k of FACT_KEYS) if (typeof w[k] === 'string' && w[k]) why[k] = capStr(w[k], 160);  // 반증 F2: 평탄화 — 잘린 조각이 엣지 본문 원문을 붙잡지 않게
  return { facts, why };
}
