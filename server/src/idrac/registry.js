/**
 * iDRAC registry — the managed list of Dell servers whose power draw we collect
 * over Redfish. Stored in CONFIG_DIR/idrac.json (gitignored, 0600, holds
 * credentials) so it survives upgrades and stays outside the app dir.
 *
 * Each entry maps an iDRAC endpoint to one or more ESXi host names so the portal
 * can show "this host's server power" when a host is clicked. Edited through the
 * admin API; supports CSV/JSON bulk import.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { ssrfBlockReason } from '../collector/registry.js'; // v2.537: 등록 시 SSRF 정적 가드
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeLoadError, autoWriteRefusal, manualRemoteWriteRefusal } from '../util/registryCore.js'; // v2.743(감사 EDGE-01): 형제 등록부와 같은 로드 오류 판정(corruptOnlyReason 포함) · v2.744(EDGE-03) 자동 저장 거절
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // 자격증명 저장 방식(평문/암호화, v2.296) — 로드 시 복호·저장 시 봉인
import { describeError } from '../util/errors.js';
import { retryTransient } from '../util/resilientFetch.js';
import { fetchPower, fetchInventory } from './redfish.js';
import { testOme } from './ome.js';
import { expandIpList } from './iprange.js';
import { bumpFleetRev } from '../insights/fleetRev.js';
import { removeInventory } from './invCache.js';
import { removeSensorDetail } from './sensorDetailCache.js';
import { clearSensorSeries } from './sensorStore.js';
import { parseCsvRows } from '../util/csv.js';
import { accessMoved, dropCarriedSecrets } from '../util/secretCarry.js'; // v2.503: 접속처 변경 시 저장 비밀 폐기(공용 판정)

// 삭제된 서버의 파생 캐시 정리 — 안 하면 인벤토리(디스크 영속)와 센서 시계열(메모리, 서버당
// 최대 1440샘플×64센서)이 프로세스 수명 내내 남아 서버 등록/삭제 반복 시 무한 증식한다.
function dropDerivedCaches(ids) {
  for (const id of ids) {
    try { removeInventory(id); } catch { /* best effort */ }
    try { removeSensorDetail(id); } catch { /* best effort */ }
    try { clearSensorSeries(id); } catch { /* best effort */ }
  }
}

const FILE = path.join(config.configDir, 'idrac.json');

/** v2.742(감사 DEV-01): 스캔 엔트리 id 정규화 — 글자 128자, 제어 문자가 있으면 버린다(빈 문자열 = 표지 없음). */
function cleanScanRangeId(v) {
  const s = String(v ?? '').trim();
  if (!s || s.length > 128 || [...s].some((c) => c.charCodeAt(0) < 32)) return '';
  return s;
}

/** 등록 host('https://10.0.0.5' 등)의 주소 부분. 못 읽으면 ''. */
function hostAddrOf(host) {
  const h = String(host || '').trim();
  if (!h) return '';
  try { return new URL(/^https?:\/\//i.test(h) ? h : `https://${h}`).hostname.replace(/^\[|\]$/g, ''); }
  catch { return ''; }
}

/**
 * v2.742(감사 DEV-01): 스캔 '교체'(replace-datacenter)가 지울 수 있는 기존 항목 판정 — **그 스캔 엔트리가 등록한 서버만**.
 *   한 법인에 서비스별 스캔 엔트리를 여럿 두는 것이 설계인데(scanRanges.js 머리말), 예전 교체는 법인 전체를 지워 같은 법인의 다른
 *   엔트리가 등록한 서버(자격증명·인벤토리·센서 시계열 포함)를 매 주기 지웠다. 이제 지우는 것은
 *   ① 같은 엔트리 id 표지(scanRangeId)가 붙은 항목 ② 표지가 없는 옛 스캔 등록 항목 중 **주소가 그 엔트리 대역 안**에 있는 것뿐이다.
 *   ②의 '옛 스캔 등록' 은 registerScanned 가 늘 만들던 모양(id == 접속 주소)으로 가린다 — id 를 사람이 정한 수동 등록과
 *   다른 엔트리 표지가 붙은 항목·OME 연결은 남긴다. 대역을 모르면(ranges 없음) ②는 아무것도 지우지 않는다(추측하지 않는다).
 * @returns {(s:object) => boolean}
 */
export function makeScanReplaceScope({ scanRangeId = '', ranges = null } = {}) {
  const rid = cleanScanRangeId(scanRangeId);
  const text = Array.isArray(ranges) ? ranges.filter(Boolean).join('\n') : String(ranges || '');
  let ipSet = null;
  if (text.trim()) { try { ipSet = new Set(expandIpList(text).ips); } catch { ipSet = null; } }
  return (s) => {
    if (!s || s.type === 'ome') return false;
    const tag = cleanScanRangeId(s.scanRangeId);
    if (tag) return !!rid && tag === rid;
    if (!ipSet || !ipSet.size) return false;
    const addr = hostAddrOf(s.host);
    return !!addr && String(s.id) === addr && ipSet.has(addr);
  };
}

// copy-on-read 캐시 — 분석 라우트들이 요청 하나에서 loadRegistry()를 여러 번 부르며 매번
// readFileSync+JSON.parse(수백~수천 엔트리)를 반복했다. mtime/size 가 같으면 파싱을 건너뛰고
// '구조 복사본'을 돌려준다(호출부는 지금처럼 자유롭게 수정→save 가능 — 공유 객체 아님).
let _regCache = null; // { mtimeMs, size, servers }

/**
 * v2.743(감사 EDGE-01): 등록부 파일을 **읽지 못했다**는 사실(형제 등록부 storage·sanswitch·pdu·cvp·bmstor 와 같은 `util/registryCore.js`
 *   판정). 예전에는 손상 → preserveCorrupt → 빈 목록 뒤에 아무 표지가 없어, 엣지 `/api/collector/export` 가 200 + `servers:[]`·전력 0 을
 *   보냈고 중앙 puller 가 그것을 정상 pull 로 받아 **그 법인의 위임 서버·원격 전력을 통째로 지웠다**(재현). 원본은 `.corrupt.<시각>` 으로
 *   옮겨지므로 다음 pull·재시작 뒤에도 계속 0대였다 — 그래서 '원본 없이 보존본만 남은' 경우(corruptOnlyReason)도 못 읽은 것으로 본다.
 *   풀리는 때: 저장이 성공했을 때(saveRegistry) · 다시 나타난 파일을 정상으로 읽었을 때(사람이 보존본을 되돌린 경우).
 */
const loadErr = makeLoadError();
/** @returns {null|{at:number, reason:string}} 못 읽었으면 사유. 판정 비용: 파일이 있으면 loadRegistry 캐시, 없으면 설정 폴더 목록 1회. */
export function registryLoadError() {
  loadRegistry();
  loadErr.checkCorruptOnly(FILE); // 오류가 이미 있거나 파일이 있으면 아무것도 하지 않는다
  return loadErr.get();
}

export function loadRegistry() {
  // ⚠ 파일이 없을 때의 corruptOnlyReason 판정(설정 폴더 목록)은 여기서 하지 않는다 — loadRegistry 는 요청·폴러마다 불리고,
  //   iDRAC 등록이 없는 엣지는 파일이 없는 것이 정상이다. 판정은 registryLoadError() 가 한다(export 라우트가 부른다).
  if (!fs.existsSync(FILE)) { _regCache = null; return []; }
  try {
    const st = fs.statSync(FILE);
    if (!_regCache || _regCache.mtimeMs !== st.mtimeMs || _regCache.size !== st.size) {
      const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      _regCache = { mtimeMs: st.mtimeMs, size: st.size, servers: openSecretsDeep(Array.isArray(parsed?.servers) ? parsed.servers : []) }; // 캐시는 평문 보관(v2.296) — 소비 코드 무변경
      loadErr.clear(); // v2.743(EDGE-01): 파일을 정상으로 읽었다(보존본을 되돌린 경우 포함)
    }
    return structuredClone(_regCache.servers);
  } catch (e) {
    preserveCorrupt(FILE, e?.message); // v2.322: 파싱 실패 시 손상본 보존(빈 목록 반환이 다음 저장으로 전 자격증명 소거 방지)
    loadErr.set(e); // v2.743(EDGE-01): 조용한 빈 목록 금지 — export 가 이 사유로 503 을 낸다
    _regCache = null;
    return [];
  }
}

function saveRegistry(list) {
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep({ servers: list }), null, 2), { mode: 0o600 }); // 암호화 모드면 password 봉인
  loadErr.clear(); // v2.743(EDGE-01): 저장이 성공하면 그때부터는 관리자가 다시 만든 목록이 진실이다(형제 등록부와 같다)
  // 방금 쓴 내용으로 캐시 즉시 동기화(다음 읽기의 재파싱 회피). 실패 시 캐시 무효화가 안전.
  try {
    const st = fs.statSync(FILE);
    _regCache = { mtimeMs: st.mtimeMs, size: st.size, servers: structuredClone(list) };
  } catch { _regCache = null; }
  // 레지스트리(서버 vcenterId·멤버십) 변경은 통합 인벤토리/전력 집계에 영향 → 플릿 캐시 무효화.
  bumpFleetRev();
}

/** Strip the password before returning an entry to the client. */
export function redact(s) {
  const { password, ...rest } = s;
  return { ...rest, hasPassword: Boolean(password) };
}

export function listRegistry() {
  return loadRegistry().map(redact);
}

/**
 * The set of ESXi host names an entry should match against, lower-cased.
 * Includes explicit hostNames plus the server name and service tag as
 * convenience aliases.
 */
export function matchKeys(entry) {
  const keys = new Set();
  for (const n of entry.hostNames || []) if (n) keys.add(String(n).trim().toLowerCase());
  if (entry.name) keys.add(String(entry.name).trim().toLowerCase());
  if (entry.serviceTag) keys.add(String(entry.serviceTag).trim().toLowerCase());
  return [...keys];
}

/** Validate + normalize an incoming server payload. Returns [entry, error]. */
function normalize(body, existing = null) {
  const e = existing ? { ...existing } : {};
  const id = String(body.id ?? e.id ?? '').trim();
  const name = String(body.name ?? e.name ?? '').trim();
  let host = String(body.host ?? e.host ?? '').trim();
  const username = String(body.username ?? e.username ?? '').trim();
  const type = (body.type ?? e.type ?? 'idrac') === 'ome' ? 'ome' : 'idrac';

  if (!id) return [null, 'id는 필수입니다.'];
  if (id.length > 128 || [...id].some((c) => c.charCodeAt(0) < 32)) return [null, 'id에 사용할 수 없는 문자가 있습니다.'];
  if (!name) return [null, 'name(서버 표시 이름)은 필수입니다.'];
  if (!host) return [null, type === 'ome' ? 'OME 주소(host)는 필수입니다.' : 'iDRAC 주소(host)는 필수입니다.'];
  if (!username) return [null, 'username은 필수입니다.'];

  // Accept a bare IP/hostname and normalize to https://host.
  if (!/^https?:\/\//.test(host)) host = `https://${host}`;
  host = host.replace(/\/+$/, '');
  // v2.537(인증·인가 3차 감사): 루프백·링크로컬·우회표기 차단 — storage/sanswitch/pdu 등록부와 같은 규칙.
  // 이 등록부는 v2.536 까지 host 를 **검사 없이** 받았다(형식 정규화만). 폴러가 그 host 로 Redfish
  // 자격증명(Basic/Digest)을 보내므로 등록 = 접속이다. bulkAddByIps·registerScanned 도 importServers
  // → normalize 를 지나므로 여기 한 곳이 전 경로를 덮는다(우회 경로를 만들지 말 것).
  const ssrf = ssrfBlockReason(host);
  if (ssrf) return [null, `host 거부: ${ssrf}`];

  // hostNames: ESXi host name(s) this iDRAC maps to. Accept array or
  // comma/space/newline-separated string. (OME auto-discovers devices, so
  // hostNames is optional/ignored there.)
  let hostNames = body.hostNames ?? e.hostNames ?? [];
  if (typeof hostNames === 'string') hostNames = hostNames.split(/[,\n\r]+/);
  hostNames = [...new Set((hostNames || []).map((h) => String(h).trim()).filter(Boolean))];

  const entry = {
    id, name, host, username, type,
    password: body.password ? String(body.password) : e.password || '',
    serviceTag: String(body.serviceTag ?? e.serviceTag ?? '').trim(),
    vcenterId: String(body.vcenterId ?? e.vcenterId ?? '').trim(), // 명시 지정 시 전력이 이 vCenter로 귀속(이름·태그 매칭보다 우선)
    datacenterId: String(body.datacenterId ?? e.datacenterId ?? '').trim(), // 소속 법인(DataCenter) — iDRAC 스캔으로 수집한 물리 서버의 법인 귀속
    hostNames,
    enabled: body.enabled != null ? Boolean(body.enabled) : (e.enabled != null ? e.enabled : true),
  };
  // v2.610: BMC 벤더 — 'hpe'(iLO) 만 기록한다. 없으면 Dell iDRAC(예전 항목 전부가 그렇다 — 파일을 바꾸지 않는다).
  //   v2.611 정정(감사 RECENT2611-06): 예전 주석은 '폴러는 이 값으로 Dell 전용 경로를 건너뛴다' 였는데 **사실이 아니다** —
  //   `idrac/poller.js` 는 vendor 를 보지 않는다(표준 Redfish 경로라 HPE 에도 그대로 돈다). 이 값을 실제로 읽는 곳은
  //   `bmusage/targets.js`(HPE 에 Dell 전용 racadm 대체 경로를 걸지 않는다) · `idrac/redfish.js` 의 서비스태그 추출
  //   (HPE 는 SerialNumber 우선) · `idrac/scanPoller.js`·`localScan.js`(replace 강등 판정 — v2.743 부터 hasHpeInScanReplaceScope) 다.
  //   그래서 이 값이 사라지면(가져오기 replace) 그 판단이 조용히 Dell 쪽으로 돌아간다 — CSV 가져오기도 vendor 열을 받는다.
  const vendor = normVendor(body.vendor !== undefined ? body.vendor : e.vendor);
  if (vendor) entry.vendor = vendor;
  // v2.742(감사 DEV-01): 이 서버를 등록한 **스캔 엔트리 id**(idrac-scan-ranges.json 의 엔트리 키) — 'replace-datacenter' 교체가
  //   법인 전체가 아니라 그 엔트리가 등록한 서버만 지우게 하는 표지다. 없으면(수동 등록·구버전 스캔 등록) 필드를 만들지 않는다
  //   (예전 항목의 파일 모양을 바꾸지 않는다). 수동 편집·병합 가져오기는 저장값을 이어받는다.
  const scanRangeId = cleanScanRangeId(body.scanRangeId !== undefined ? body.scanRangeId : e.scanRangeId);
  if (scanRangeId) entry.scanRangeId = scanRangeId;

  // ⚠ 보안 불변조건(v2.503, 감사 S1 #6) — **접속처가 바뀌면 저장 비밀을 승계하지 않는다.**
  // 판정은 `util/secretCarry.js` 하나로 한다(각자 구현하면 다음 스토어에서 또 빠진다 — v2.500 H1/H2/H4).
  // 이 파일은 v2.500 에서 '추정' 으로만 남아 있던 나머지 스토어 중 하나이고, 이번에 코드로 확인됐다:
  // `{host:'https://vc.attacker.example', password:''}` 로 저장하면 host 만 바뀌고 저장 비밀번호가
  // 그대로 남아, 다음 수집 주기에 **운영 계정·비밀번호가 그 호스트로 평문 전송**된다.
  // v2.480 의 "연결 테스트는 host 를 저장값으로 고정" 은 테스트 라우트만 막으므로 저장 1회로 우회된다.
  // 버린 키는 호출부가 `droppedSecrets` 로 받아 '비밀번호를 다시 입력하세요' 를 안내한다.
  const droppedSecrets = existing && accessMoved(existing, body, ['host', 'username'])
    ? dropCarriedSecrets(entry, body, ['password']) : [];
  return [entry, null, droppedSecrets];
}

export function addServer(body) {
  const list = loadRegistry();
  const [entry, err] = normalize(body);
  if (err) return { ok: false, reason: err };
  if (list.some((s) => s.id === entry.id)) return { ok: false, reason: `이미 존재하는 id: ${entry.id}` };
  list.push(entry);
  saveRegistry(list);
  return { ok: true, server: redact(entry) };
}

export function updateServer(id, body) {
  const list = loadRegistry();
  const idx = list.findIndex((s) => s.id === id);
  if (idx === -1) return { ok: false, reason: `없는 서버: ${id}` };
  const [entry, err, droppedSecrets] = normalize({ ...body, id }, list[idx]);
  if (err) return { ok: false, reason: err };
  list[idx] = entry;
  saveRegistry(list);
  return { ok: true, server: redact(entry), droppedSecrets };
}

export function removeServer(id) {
  const list = loadRegistry();
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return { ok: false, reason: `없는 서버: ${id}` };
  saveRegistry(next);
  dropDerivedCaches([id]);
  return { ok: true };
}

/**
 * Import a list of servers. `mode` 'merge' (default) upserts by id; 'replace'
 * swaps the whole registry. Returns { ok, mode, added, updated, skipped[], total }.
 */
export function importServers(incoming, mode = 'merge', { replaceScope = null } = {}) {
  if (!Array.isArray(incoming)) return { ok: false, reason: 'servers 배열을 찾을 수 없습니다.' };
  const existing = loadRegistry();
  // mode:
  //  - 'replace'            : 레지스트리 전체 교체(기존 모두 삭제 후 incoming만)
  //  - 'replace-vcenter'    : incoming에 등장한 소속 vCenter의 기존 항목만 삭제 후 교체(다른 vCenter는 유지)
  //  - 'replace-datacenter' : incoming에 등장한 소속 법인(DataCenter)의 기존 항목만 삭제 후 교체(다른 법인은 유지)
  //  - 'merge'(기본)        : id 기준 upsert
  // 먼저 incoming을 검증해 '유효 항목'만 추린다(검증 실패 항목은 skip).
  const skipped = [];
  const valid = [];
  let scopeKept = null; // v2.742: replace-datacenter + replaceScope 일 때 범위 밖이라 남긴 같은 법인 항목 수
  for (const raw of incoming) {
    const base = mode === 'replace' ? null : existing.find((s) => s.id === raw?.id);
    const [entry, err] = normalize(raw || {}, base);
    if (err) { skipped.push({ id: raw?.id || '(id 없음)', reason: err }); continue; }
    valid.push(entry);
  }
  let result;
  if (mode === 'replace') result = [];
  else if (mode === 'replace-vcenter') {
    // 삭제 대상 vCenter는 '유효한 incoming'이 실제 존재하는 vCenter로 한정한다.
    // (검증 실패로 0건이 된 vCenter의 기존 데이터를 통째로 지우는 사고 방지)
    const vcs = new Set(valid.map((e) => String(e.vcenterId || '').trim()).filter(Boolean));
    result = vcs.size ? existing.filter((s) => !vcs.has(String(s.vcenterId || '').trim())) : [...existing];
  } else if (mode === 'replace-datacenter') {
    // incoming에 등장한 법인(DataCenter)의 기존 항목만 삭제 후 교체(다른 법인은 유지).
    // 유효 incoming이 0건이면 기존을 지우지 않음(블립으로 인한 대량 삭제 방지).
    const dcs = new Set(valid.map((e) => String(e.datacenterId || '').trim()).filter(Boolean));
    // v2.742(감사 DEV-01): replaceScope(스캔 등록 경로가 준다)가 있으면 그 법인 안에서도 **범위 안 항목만** 지운다 —
    //   같은 법인의 다른 스캔 엔트리 등록·수동 등록을 남긴다. 없으면(직접 가져오기) 예전처럼 법인 전체를 교체한다.
    const scoped = typeof replaceScope === 'function';
    const drop = (s) => dcs.has(String(s.datacenterId || '').trim()) && (!scoped || replaceScope(s));
    result = dcs.size ? existing.filter((s) => !drop(s)) : [...existing];
    if (scoped && dcs.size) scopeKept = existing.filter((s) => dcs.has(String(s.datacenterId || '').trim()) && !replaceScope(s)).length;
  } else result = [...existing];
  // 안전장치: 'replace'인데 유효 incoming이 0건이면 전체 삭제하지 않는다(빈/전부무효 CSV로
  // 등록 서버·자격증명이 소실되는 사고 방지). replace-vcenter/datacenter는 위에서 이미 0건 가드됨.
  if (mode === 'replace' && valid.length === 0) {
    return { ok: false, mode, added: 0, updated: 0, skipped, total: existing.length, reason: '가져올 유효한 서버가 없어 전체 교체를 취소했습니다(기존 목록 유지).' };
  }
  let added = 0, updated = 0;
  for (const entry of valid) {
    const idx = result.findIndex((s) => s.id === entry.id);
    if (idx >= 0) { result[idx] = entry; updated++; } else { result.push(entry); added++; }
  }
  saveRegistry(result);
  // replace 계열로 밀려난(교체로 사라진) 서버의 파생 캐시도 정리 — removeServer/deleteServers와 동일.
  const keptIds = new Set(result.map((s) => s.id));
  const droppedIds = existing.filter((s) => !keptIds.has(s.id)).map((s) => s.id);
  if (droppedIds.length) dropDerivedCaches(droppedIds);
  return { ok: true, mode, added, updated, skipped, total: result.length, ...(scopeKept != null ? { removed: droppedIds.length, scopeKept } : {}) };
}

/**
 * Bulk-register Dell servers from an IP list that all share the same iDRAC
 * credentials. `ips` is free-form text (one per line; ranges and CIDR allowed).
 * Each IP becomes a server whose id/name/host is the IP and whose hostNames
 * includes the IP (so a host registered by IP auto-matches). Returns a summary
 * including the import result and any IP-parse errors.
 */
export function bulkAddByIps(body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username) return { ok: false, reason: 'username은 필수입니다.' };
  if (!password) return { ok: false, reason: 'password는 필수입니다.' };

  const { ips, errors, truncated } = expandIpList(body.ips || '');
  if (!ips.length) return { ok: false, reason: 'IP를 한 개 이상 입력하세요.', ipErrors: errors };

  const prefix = String(body.namePrefix || '').trim();
  const vcenterId = String(body.vcenterId || '').trim();
  const servers = ips.map((ip) => ({
    id: ip,
    name: prefix ? `${prefix}${ip}` : ip,
    host: ip,
    username,
    password,
    hostNames: [ip],
    vcenterId,
    enabled: true,
  }));
  const result = importServers(servers, body.mode === 'replace' ? 'replace' : 'merge');
  return { ...result, expanded: ips.length, ipErrors: errors, truncated };
}

/**
 * Register iDRACs discovered by a range scan. Each found item carries identity
 * (ip, serviceTag, hostName, model); the shared username/password are applied
 * to all. hostNames includes the discovered hostname + IP for auto-matching.
 */
export function registerScanned(found, username, password, mode = 'merge', vcenterId = '', datacenterId = '', { ilo = null, scanRangeId = '', scanRanges = null, auto = false, manualRemote = null } = {}) {
  if (!Array.isArray(found) || !found.length) return { ok: false, reason: '등록할 iDRAC가 없습니다.' };
  // v2.744(감사 EDGE-03 — 재현): **사람이 아닌 경로**(엣지 현지 스캔·할당 스캐너·주기 스캔 — 호출부가 auto:true 를 준다)는
  //   등록부를 읽지 못한 상태에서 저장하지 않는다. 손상된 빈 목록 위에 발견분만 저장하면 saveRegistry 가 '읽지 못함' 표지를 지워
  //   v2.743 엣지 export 503 보호가 풀리고, 다음 pull 에서 중앙이 그 엣지의 수동 등록·다른 엔트리 서버를 지웠다(검증 a7 재현).
  //   관리자 화면의 등록(routes/admin/idracScan.js)은 auto 를 주지 않는다 — 사람이 다시 만든 목록이 진실이다(saveRegistry 주석).
  // v2.744(회귀 검토 GD-R3): 위임 등록 잡(agent/idracScanWorker.js 의 register)은 **자동 경로가 아니다** — 중앙 관리자가 '등록' 을 눌러야만
  //   만들어진다(routes/admin/idracScan.js register-scanned 의 위임 분기가 유일한 생성처). 그 경로는 `manualRemote`(그 엣지 이름)를 주고,
  //   손상 등록부에는 여전히 저장하지 않되 사유를 '자동' 이 아니라 '사람이 요청한 등록 — 이 노드의 등록부가 손상' 으로 말한다
  //   (registryCore manualRemoteWriteRefusal). 요청한 사람은 이 노드의 등록부를 보지 못했으므로 덮어쓰지 않는 원칙은 같다.
  if (auto || manualRemote) {
    const err = registryLoadError();
    const refusal = auto
      ? autoWriteRefusal(err, 'iDRAC 등록부(idrac.json)')
      : manualRemoteWriteRefusal(err, 'iDRAC 등록부(idrac.json)', { node: typeof manualRemote === 'string' ? manualRemote : '' });
    if (refusal) return { ...refusal, added: 0, updated: 0, refused: found.length };
  }
  // v2.610: HPE iLO 로 발견된 항목은 **iLO 계정**으로 등록한다(Dell 계정을 붙이면 폴러가 매 주기 iLO 에 실패 로그인한다).
  //   계정이 없는 벤더의 항목은 등록하지 않고 개수를 밝힌다(skippedNoCreds).
  const iloU = String(ilo?.username || '').trim();
  const iloP = typeof ilo?.password === 'string' ? ilo.password : '';
  const credOf = (f) => (f?.vendor === 'hpe' ? (iloU && iloP ? [iloU, iloP] : null) : (username && password ? [username, password] : null));
  const usable = found.filter((f) => credOf(f));
  const skippedNoCreds = found.length - usable.length;
  if (!usable.length) return { ok: false, reason: 'username/password가 필요합니다.', skippedNoCreds };
  const vc = String(vcenterId || '').trim();
  const dc = String(datacenterId || '').trim();
  const rid = cleanScanRangeId(scanRangeId);
  const servers = usable.map((f) => ({
    id: f.ip,
    // 표시 이름은 hostname으로 통일한다: iDRAC이 보고한 HostName이 있으면 그걸 쓰고,
    // 없으면 IP(주소)로 대체한다. 서비스태그는 이름으로 쓰지 않는다(서비스태그 열에만 표시).
    // 과거엔 hostName 없으면 serviceTag를 이름으로 써서 '어떤 건 이름=태그'로 뒤섞였다.
    name: f.hostName || f.ip,
    host: f.ip,
    username: credOf(f)[0],
    password: credOf(f)[1],
    vendor: f.vendor === 'hpe' ? 'hpe' : '',
    serviceTag: f.serviceTag || '',
    hostNames: [f.hostName, f.ip].filter(Boolean),
    vcenterId: vc,
    datacenterId: dc, // 법인(DataCenter) 스캔으로 발견 → 그 법인에 귀속(법인 DB)
    // v2.742(감사 DEV-01): 어느 스캔 엔트리가 등록했는지 — 교체(replace-datacenter)가 그 엔트리의 등록만 지우게 한다.
    ...(rid ? { scanRangeId: rid } : {}),
    enabled: true,
  }));
  // v2.742(감사 DEV-01): 스캔 등록의 replace-datacenter 는 **언제나** 범위를 준다 — 엔트리 id·대역을 모르는 호출(구버전 중앙의 잡 등)이면
  //   범위가 비어 아무것도 지우지 않는다(= 병합). 법인 전체 교체로 떨어지지 않게 한다.
  const r = importServers(servers, mode, mode === 'replace-datacenter' ? { replaceScope: makeScanReplaceScope({ scanRangeId: rid, ranges: scanRanges }) } : {});
  return skippedNoCreds ? { ...r, skippedNoCreds } : r;
}

/**
 * 다수 서버의 소속 vCenter를 일괄 지정/해제. ids 미지정 시 전체 적용.
 * Returns { ok, updated }.
 */
export function assignVcenter({ ids = null, vcenterId = '' } = {}) {
  const vc = String(vcenterId || '').trim();
  const list = loadRegistry();
  const want = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
  let updated = 0;
  for (const s of list) {
    if (want && !want.has(String(s.id))) continue;
    if (s.vcenterId !== vc) { s.vcenterId = vc; updated++; }
  }
  if (updated) saveRegistry(list);
  return { ok: true, updated, total: list.length };
}

/**
 * 서버 일괄 삭제. { all:true } 전체 삭제, { vcenterId } 해당 소속 vCenter 서버만 삭제
 * (빈 vcenterId는 '미지정' 서버를 삭제). Returns { ok, removed, total }.
 */
export function deleteServers({ all = false, vcenterId = undefined } = {}) {
  const list = loadRegistry();
  let next;
  if (all) {
    next = [];
  } else if (vcenterId !== undefined) {
    const vc = String(vcenterId || '').trim();
    next = list.filter((s) => String(s.vcenterId || '').trim() !== vc);
  } else {
    return { ok: false, reason: '삭제 대상(all=true 또는 vcenterId)이 필요합니다.' };
  }
  const removed = list.length - next.length;
  saveRegistry(next);
  const kept = new Set(next.map((s) => s.id));
  dropDerivedCaches(list.filter((s) => !kept.has(s.id)).map((s) => s.id));
  return { ok: true, removed, total: next.length };
}

/**
 * Parse a CSV with header columns: name, host, username, password, serviceTag,
 * hostNames (hostNames may be ';'-separated). Returns an array of server objects.
 * 비밀번호 등 값에 쉼표·따옴표·줄바꿈이 있으면 "..."로 감싸면 온전히 보존된다.
 */
export function parseCsv(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const out = [];
  for (const cells of rows.slice(1)) {
    const row = {};
    // 비밀번호는 앞뒤 공백이 유의미할 수 있어 trim하지 않는다(다른 필드만 trim).
    header.forEach((h, i) => { const v = cells[i] ?? ''; row[h] = h === 'password' ? v : v.trim(); });
    if (!row.name && !row.host) continue;
    out.push({
      id: row.id || row.servicetag || row.name || row.host,
      name: row.name || row.host,
      host: row.host,
      username: row.username,
      password: row.password,
      serviceTag: row.servicetag || row.service_tag || '',
      vcenterId: row.vcenterid || row.vcenter || row.vcenter_id || '',
      hostNames: (row.hostnames || row.host_names || row.esxi || '').split(/[;|]/).map((s) => s.trim()).filter(Boolean),
      // v2.611(감사 RECENT2611-06): vendor 열(선택) — 'hpe' 만 값으로 인정한다(normVendor). 열이 없으면 undefined 라
      //   merge 는 기존 vendor 를 유지하고, replace 는 예전처럼 비운다(Dell). 예전에는 열 자체를 읽지 않아 replace 가져오기가
      //   HPE 표시를 지웠고, 그 결과 bmusage 의 HPE 제외(racadm 대체 경로)가 풀렸다.
      ...(Object.hasOwn(row, 'vendor') ? { vendor: normVendor(row.vendor) } : {}),
    });
  }
  return out;
}

/** Test connectivity + read current power for a server (uses stored pw if blank). */
export async function testServer(body) {
  let entry = body;
  if (!entry.password && entry.id) {
    const saved = loadRegistry().find((s) => s.id === entry.id);
    if (saved) entry = { ...saved, ...body, password: saved.password, host: saved.host }; // v2.480(3차 감사 S6): 저장 비밀번호를 물려받는 테스트는 host 도 저장값으로 고정 — body.host 만 공격자 IP 로 바꿔 평문 비밀번호를 받는 경로 차단(PDU S-1 과 같은 규칙)
  }
  if (!entry.host || !entry.username || !entry.password) {
    return { ok: false, reason: 'host/username/password가 필요합니다.' };
  }
  // normalize host the same way as save
  let host = String(entry.host).trim();
  if (!/^https?:\/\//.test(host)) host = `https://${host}`;
  const normalized = { ...entry, host: host.replace(/\/+$/, '') };
  const started = Date.now();
  try {
    if (entry.type === 'ome') {
      const r = await testOme(normalized);
      return { ok: true, ms: r.ms, devices: r.devices, auth: r.auth, watts: r.sampleWatts, type: 'ome' };
    }
    // 고RTT 블립으로 '연결 실패' 오판되지 않도록 전력 확인은 1회 재시도.
    const r = await retryTransient(() => fetchPower(normalized));
    let info = null;
    try { info = await fetchInventory(normalized); } catch { /* power test still succeeds */ }
    return { ok: true, ms: Date.now() - started, watts: r.watts, model: r.model, serviceTag: r.serviceTag, powerState: r.powerState, info };
  } catch (err) {
    const d = describeError(err);
    return { ok: false, reason: d.message, hint: d.hint, code: d.code, ms: Date.now() - started };
  }
}

/** v2.610: BMC 벤더 정규화 — 'hpe' 만 값으로 남긴다(Dell 은 기본값이라 빈 문자열). 모르는 값은 버린다. */
export function normVendor(v) {
  const t = String(v ?? '').trim().toLowerCase();
  return (t === 'hpe' || t === 'hp' || t === 'ilo') ? 'hpe' : '';
}

/**
 * v2.610: 등록 항목이 HPE iLO 인가.
 * v2.611(감사 RECENT2611-06): v2.610 에는 호출부가 **0곳**이었다(주석만 '폴러가 쓴다' 고 적었다). 지금은
 *   hasHpeInDatacenter·hasHpeInScanReplaceScope(v2.743 — replace 강등 판정은 이쪽)가 쓴다.
 */
export function isHpeEntry(entry) { return normVendor(entry?.vendor) === 'hpe'; }

/**
 * v2.611: 이 법인(datacenterId)에 HPE 로 등록된 서버가 있는가.
 * ⚠ v2.743(감사 LEFT-01): replace 강등 판정에는 더 쓰지 않는다 — v2.742 DEV-01 뒤로 교체 범위가 **엔트리 단위**라 법인 전체를 보면
 *   범위 밖 HPE(다른 엔트리 등록·수동 등록 — 교체가 지우지 않는다) 하나 때문에 Dell 전용 엔트리의 replace 가 매번 merge 로 떨어져
 *   그 범위의 퇴역 등록이 남았다. 강등 판정은 아래 hasHpeInScanReplaceScope 다. 이 함수는 법인 단위 질의로 남긴다.
 */
export function hasHpeInDatacenter(datacenterId) {
  const dc = String(datacenterId || '').trim();
  if (!dc) return false;
  try { return loadRegistry().some((s) => String(s.datacenterId || '').trim() === dc && isHpeEntry(s)); }
  catch { return false; }
}

/**
 * v2.743(감사 LEFT-01): 이 스캔 엔트리의 '교체'(replace-datacenter)가 **실제로 지울 수 있는** 등록 중에 HPE 가 있는가 — iLO 계정 없는
 *   스캔은 HPE 를 found 에 넣지 못하므로(미지원 서버) 그런 HPE 가 있을 때만 replace 를 merge 로 강등해야 한다.
 *   술어는 교체 자신과 **같은 것**이다: importServers 의 drop = '그 법인' ∧ makeScanReplaceScope({scanRangeId, ranges}) — registerScanned 가
 *   교체에 넘기는 것과 같은 인자(엔트리 id·대역)를 받는다. 법인이 비면 교체가 아무것도 지우지 않으므로 false.
 *   예기치 않은 오류는 **true**(강등 = 지우지 않는 쪽)로 둔다 — false 로 두면 지워질 수 있는 HPE 를 못 본 채 replace 가 돈다.
 * @returns {boolean}
 */
export function hasHpeInScanReplaceScope({ datacenterId = '', scanRangeId = '', ranges = null } = {}) {
  const dc = String(datacenterId || '').trim();
  if (!dc) return false;
  try {
    const inScope = makeScanReplaceScope({ scanRangeId, ranges });
    return loadRegistry().some((s) => String(s.datacenterId || '').trim() === dc && isHpeEntry(s) && inScope(s));
  } catch { return true; }
}

/**
 * v2.611(감사 COL2611-01): HPE 서버의 서비스태그 교정 — **1회성**.
 *   v2.610 스캔은 HPE 의 `Systems.SKU`(주문 제품번호 — 같은 모델이면 전부 같다)를 serviceTag 로 등록했다. 등록부 값은
 *   partfault·bmusage 의 장비 키에서 인벤토리보다 먼저라 추출을 고쳐도 남는다. 인벤토리 조회가 **HPE 이고 등록부 태그가
 *   SKU 와 글자 그대로 같을 때만** 등록부를 SerialNumber 로 바꾼다(사람이 손으로 넣은 값·Dell 은 건드리지 않는다).
 * @returns {boolean} 바꿨으면 true
 */
export function correctHpeServiceTag(id, { sku = '', serial = '' } = {}) {
  const k = String(sku || '').trim();
  const sn = String(serial || '').trim();
  if (!k || !sn || k === sn) return false;
  const list = loadRegistry();
  const e = list.find((x) => x.id === id);
  if (!e || String(e.serviceTag || '').trim() !== k) return false;
  e.serviceTag = sn;
  saveRegistry(list);
  console.log(`[idrac] ${id}: HPE 서비스태그를 제품번호(SKU ${k})에서 시리얼(${sn})로 교정했습니다(v2.611 — 한 번만).`);
  return true;
}
