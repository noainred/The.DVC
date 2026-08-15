/**
 * Collector registry — the list of remote collector agents (one per datacenter)
 * the central portal pulls power from. Stored in CONFIG_DIR/collectors.json
 * (0600; holds per-agent tokens). Edited via the admin API.
 */

import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // 자격증명 저장 방식(평문/암호화, v2.296) — 로드 시 복호·저장 시 봉인
import { bumpFleetRev } from '../insights/fleetRev.js';

const FILE = path.join(config.configDir, 'collectors.json');

/**
 * id가 대소문자만 다른 중복 수집서버를 하나로 병합한다. 엣지 자기등록(v2.117~)이 소문자
 * 이름('gm1')으로 등록하는데 기존 수동 등록이 대문자('GM1')라 id 비교가 대소문자를 구분해
 * 별개 항목으로 쌓이던 문제(같은 엣지가 2번 표시·이중 pull) 정리. 생존자는 vcenterId(관리자
 * 매핑)가 있는 쪽 우선, 없으면 먼저 온 것. 빈 필드는 다른 쪽 값으로 채운다.
 */
function dedupeByIdCase(list) {
  const groups = new Map(); const order = [];
  for (const c of list) {
    const k = String(c.id || '').toLowerCase();
    if (!groups.has(k)) { groups.set(k, []); order.push(k); }
    groups.get(k).push(c);
  }
  let changed = false;
  const out = [];
  for (const k of order) {
    const g = groups.get(k);
    if (g.length === 1) { out.push(g[0]); continue; }
    changed = true;
    const base = g.find((c) => String(c.vcenterId || '').trim()) || g[0];
    const merged = { ...base };
    for (const c of g) {
      if (c === base) continue;
      for (const f of ['vcenterId', 'datacenter', 'name', 'url', 'token']) {
        if (!String(merged[f] || '').trim() && String(c[f] || '').trim()) merged[f] = c[f];
      }
    }
    out.push(merged);
  }
  return { list: out, changed };
}

export function loadCollectors() {
  if (!fs.existsSync(FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const arr = openSecretsDeep(Array.isArray(parsed?.collectors) ? parsed.collectors : []); // v2.296 토큰 복호(메모리 평문)
    // 대소문자 중복을 로드 시 자동 정리(최초 1회 병합·영속화, 이후엔 중복이 없어 재저장 안 함).
    const { list, changed } = dedupeByIdCase(arr);
    if (changed) { try { save(list); } catch { /* best effort — 다음 로드에서 재시도 */ } }
    return list;
  } catch (e) {
    // save() 주석대로 손상 시 다음 저장이 빈 목록으로 덮어써 전 수집서버·토큰이 유실된다 →
    // 손상본을 .corrupt로 보존(자기등록으로 쓰기 빈도가 높아 노출 창이 큰 파일).
    preserveCorrupt(FILE, e.message);
    return [];
  }
}

function save(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  // 원자적 쓰기 — 크래시/정전 시 부분기록으로 collectors.json이 손상되면 loadCollectors가
  // []를 반환하고 다음 저장이 빈 목록으로 덮어써 전 수집서버·토큰이 영구 유실된다(자기등록으로
  // 쓰기 빈도가 늘어 노출 창이 커짐). atomicWrite(임시파일+rename)로 방지.
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep({ collectors: list }), null, 2), { mode: 0o600 }); // 암호화 모드면 token 봉인
  bumpFleetRev(); // 수집서버 vcenterId 매핑 변경 → fleet/finops 캐시 즉시 무효화
}

export function redact(c) {
  const { token, ...rest } = c;
  return { ...rest, hasToken: Boolean(token) };
}

export function listCollectors() {
  return loadCollectors().map(redact);
}

// ── SSRF 가드 ────────────────────────────────────────────────────────────────
// 차단 대상: 링크로컬/클라우드 메타데이터(169.254.0.0/16 = AWS/GCP/Azure 169.254.169.254),
// IPv6 링크로컬(fe80::/10)·ULA(fc00::/7), 루프백(127.0.0.0/8, ::1), 미지정(0.0.0.0/8, ::).
// ★ RFC1918 사설(10/8, 172.16/12, 192.168/16)은 계속 허용해야 한다 — 이 제품의 수집 서버·
//   vCenter·iDRAC이 전부 사내망에 있어 차단하면 정상 기능이 통째로 깨진다(의도적 허용).
// 호스트 문자열에 정규식만 걸면 ::ffff:169.254.169.254(IPv4-mapped)·2852039166(10진수)·
// 0xA9FEA9FE(16진수)·0177.0.0.1(8진수) 같은 대체 표기로 그대로 우회된다 → 호스트를 실제 IP
// 값으로 정규화(언랩/진수 변환)한 뒤 대역을 비교한다.

// 루프백 차단은 새로 추가된 규칙이라, 중앙+엣지를 한 서버에 올린 랩/데모 구성
// (remoteBase=http://127.0.0.1:4000/dl, 수집서버=http://localhost:4000 등)을 막을 수 있다.
// 정상 배포를 깨지 않도록 SSRF_ALLOW_LOOPBACK=true 로 opt-out 제공(기본은 차단).
const allowLoopback = () => String(process.env.SSRF_ALLOW_LOOPBACK || '').toLowerCase() === 'true';

/**
 * 8/10/16진수·축약 IPv4 표기(2852039166, 0xA9FEA9FE, 0177.0.0.1, 10.1)를 점표기로 정규화.
 * IPv4 표기가 아니면(=DNS 이름) null. new URL()도 대부분 정규화해 주지만, URL을 거치지 않는
 * 호스트 문자열(DNS 해석 결과·relayProbe의 host:port)에도 같은 규칙을 적용하려면 필요하다.
 */
function toDottedIPv4(raw) {
  let h = String(raw || '').trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1); // FQDN 표기의 트레일링 도트
  if (!h) return null;
  const parts = h.split('.');
  if (parts.length > 4) return null;
  const nums = [];
  for (const p of parts) {
    let n;
    if (/^0x[0-9a-f]+$/.test(p)) n = parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^[0-9]+$/.test(p)) n = Number(p);
    else return null; // 숫자 표기가 아니면 IP가 아니다
    if (!Number.isSafeInteger(n) || n < 0) return null;
    nums.push(n);
  }
  const last = nums.pop();
  if (nums.some((n) => n > 255)) return null;
  if (last >= 256 ** (4 - nums.length)) return null; // 마지막 조각이 남은 옥텟을 모두 표현
  let v = last;
  for (let i = 0; i < nums.length; i++) v += nums[i] * 256 ** (3 - i);
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
}

/** IPv6 문자열을 16비트 8그룹으로 확장(::ffff:1.2.3.4 형태 포함). IPv6가 아니면 null. */
function expandIPv6(raw) {
  const h = String(raw || '').trim().toLowerCase().replace(/%.*$/, ''); // fe80::1%eth0 zone id 제거
  if (!h.includes(':')) return null;
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s) => {
    if (!s) return [];
    const seg = s.split(':');
    const out = [];
    for (let i = 0; i < seg.length; i++) {
      const g = seg[i];
      if (g.includes('.')) {
        if (i !== seg.length - 1) return null; // 점표기 IPv4는 맨 끝에만 올 수 있다
        const d = toDottedIPv4(g);
        if (!d) return null;
        const o = d.split('.').map(Number);
        out.push((o[0] << 8) | o[1], (o[2] << 8) | o[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...Array(fill).fill(0), ...tail];
}

function ipv4BlockReason(dotted) {
  const [a, b] = dotted.split('.').map(Number);
  if (a === 169 && b === 254) return '링크로컬/메타데이터 주소는 사용할 수 없습니다.';
  if (a === 127) return allowLoopback() ? null : '루프백 주소(127.x)는 사용할 수 없습니다(필요하면 SSRF_ALLOW_LOOPBACK=true).';
  if (a === 0) return '0.0.0.0(미지정) 주소는 사용할 수 없습니다.';
  return null; // RFC1918 등 사내 대역은 허용
}

function ipv6BlockReason(g) {
  const zeros = (from, to) => g.slice(from, to).every((x) => x === 0);
  const v4 = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.');
  if (g.every((x) => x === 0)) return '미지정(::) 주소는 사용할 수 없습니다.';
  if (zeros(0, 7) && g[7] === 1) return allowLoopback() ? null : '루프백 주소(::1)는 사용할 수 없습니다(필요하면 SSRF_ALLOW_LOOPBACK=true).';
  // IPv4-mapped(::ffff:a.b.c.d)·NAT64(64:ff9b::/96)·IPv4-compatible(::a.b.c.d)은 IPv4로 언랩해
  // 같은 규칙을 적용 — ::ffff:169.254.169.254 로 메타데이터를 치는 우회를 막는다.
  if (zeros(0, 5) && g[5] === 0xffff) return ipv4BlockReason(v4);
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return ipv4BlockReason(v4);
  if (zeros(0, 6)) return ipv4BlockReason(v4);
  if ((g[0] & 0xffc0) === 0xfe80) return '링크로컬/메타데이터 주소는 사용할 수 없습니다.'; // fe80::/10
  if ((g[0] & 0xfe00) === 0xfc00) return 'ULA(fc00::/7) 주소는 사용할 수 없습니다.';
  return null;
}

/**
 * 호스트(또는 IP) 문자열 1개에 대한 차단 사유. IP 리터럴이 아니면(=DNS 이름) null을 반환하고,
 * 이름의 실제 해석 검사는 ssrfBlockReasonResolved가 담당한다.
 */
export function ipBlockReason(hostOrIp) {
  const host = String(hostOrIp || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return 'URL의 호스트가 올바르지 않습니다.';
  const v4 = toDottedIPv4(host);
  if (v4) return ipv4BlockReason(v4);
  const g = expandIPv6(host);
  if (g) return ipv6BlockReason(g);
  // 잘 알려진 루프백 이름은 해석 없이도 막는다(DNS 조회가 불가한 동기 경로 대비).
  if (!allowLoopback() && (host === 'localhost' || host.endsWith('.localhost'))) {
    return '루프백 이름(localhost)은 사용할 수 없습니다(필요하면 SSRF_ALLOW_LOOPBACK=true).';
  }
  return null;
}

/**
 * URL 문자열을 받아 차단 사유(문자열) 또는 null(허용) 반환. 여러 경로에서 공용으로 쓴다.
 * 동기 함수 — 호출부가 많아 시그니처를 유지한다(DNS 해석까지 보려면 아래 async 버전 사용).
 */
export function ssrfBlockReason(urlStr) {
  let u;
  // 스킴이 없는 'host:port'만 http://를 붙인다(이미 스킴이 있으면 그대로 → 비-http 스킴을 제대로 거부).
  try { u = new URL(/:\/\//.test(String(urlStr)) ? urlStr : `http://${urlStr}`); }
  catch { return 'URL 형식이 올바르지 않습니다.'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'http/https URL만 허용됩니다.';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return 'URL의 호스트가 올바르지 않습니다.';
  return ipBlockReason(host);
}

/**
 * ssrfBlockReason + DNS 해석 결과까지 검사(차단 대역으로 해석되는 이름 차단).
 * 동기 버전을 쓰는 기존 호출부를 바꾸지 않기 위해 별도 async 함수로 추가했다.
 * - 해석 실패(ENOTFOUND/타임아웃)는 차단 사유로 보지 않는다 — 일시적 DNS 장애로 정상 등록·저장을
 *   막으면 안 되고, 실제 요청 단계에서 어차피 실패한다.
 * - DNS rebinding(검사 후 재해석)까지는 막지 못하는 best-effort 가드다.
 */
export async function ssrfBlockReasonResolved(urlStr) {
  const sync = ssrfBlockReason(urlStr);
  if (sync) return sync;
  let host = '';
  try { host = new URL(/:\/\//.test(String(urlStr)) ? urlStr : `http://${urlStr}`).hostname.replace(/^\[|\]$/g, ''); }
  catch { return 'URL 형식이 올바르지 않습니다.'; }
  if (toDottedIPv4(host) || expandIPv6(host)) return null; // 이미 IP 리터럴 → 위에서 검사 완료
  let addrs = [];
  try { addrs = await dns.promises.lookup(host, { all: true, verbatim: true }); }
  catch { return null; }
  for (const a of addrs) {
    const r = ipBlockReason(a.address);
    if (r) return `${r} (DNS 해석: ${host} → ${a.address})`;
  }
  return null;
}

function normalize(body, existing = null) {
  const e = existing ? { ...existing } : {};
  const id = String(body.id ?? e.id ?? '').trim();
  const name = String(body.name ?? e.name ?? '').trim();
  let url = String(body.url ?? e.url ?? '').trim();
  const datacenter = String(body.datacenter ?? e.datacenter ?? '').trim();
  // 이 수집서버가 보고하는 원격 호스트를 귀속시킬 vCenter(전력 집계에서 '미매핑' 방지). 선택.
  const vcenterId = String(body.vcenterId ?? e.vcenterId ?? '').trim();

  if (!id) return [null, 'id는 필수입니다.'];
  if (id.length > 128 || [...id].some((c) => c.charCodeAt(0) < 32)) return [null, 'id에 사용할 수 없는 문자가 있습니다.'];
  if (!name) return [null, 'name(표시 이름)은 필수입니다.'];
  if (!url) return [null, '수집 서버 URL은 필수입니다.'];
  if (!/^https?:\/\//.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, '');
  // URL 형식 검증 — http/https + 유효 호스트만 허용(잘못된 스킴/입력 차단).
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return [null, 'http/https URL만 허용됩니다.'];
    if (!u.hostname) return [null, '수집 서버 URL의 호스트가 올바르지 않습니다.'];
  } catch { return [null, '수집 서버 URL 형식이 올바르지 않습니다.']; }
  // SSRF 방어는 공용 가드로 일원화(대체 진수·IPv4-mapped 우회 표기까지 차단). 수집 서버는
  // 사설 IP(192.168.x.x 등)에 두므로 RFC1918 사설 대역은 계속 허용된다.
  const ssrf = ssrfBlockReason(url);
  if (ssrf) return [null, `수집 서버 URL: ${ssrf}`];

  const entry = {
    id, name, url, datacenter, vcenterId,
    token: body.token ? String(body.token) : e.token || '',
    enabled: body.enabled != null ? Boolean(body.enabled) : (e.enabled != null ? e.enabled : true),
  };
  return [entry, null];
}

// managed=true: 관리자가 UI에서 직접 등록/수정한 항목(=수동 고정). 엣지 자기등록이 URL/토큰을
// 덮어쓰지 않는다(NAT/포트포워딩으로 관리자가 URL·토큰을 실제 값과 다르게 지정하는 경우 보존).
export function addCollector(body, { managed = false } = {}) {
  const list = loadCollectors();
  const [entry, err] = normalize(body);
  if (err) return { ok: false, reason: err };
  // 대소문자 무시 중복 방지 — 'GM1'이 있으면 'gm1' 추가를 막는다(같은 엣지 이중 등록 방지).
  const dupe = list.find((c) => String(c.id).toLowerCase() === String(entry.id).toLowerCase());
  if (dupe) return { ok: false, reason: `이미 존재하는 id: ${dupe.id}` };
  entry.managed = Boolean(managed);
  list.push(entry);
  save(list);
  return { ok: true, collector: redact(entry) };
}

export function updateCollector(id, body, { managed } = {}) {
  const list = loadCollectors();
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) return { ok: false, reason: `없는 수집 서버: ${id}` };
  const [entry, err] = normalize({ ...body, id }, list[idx]);
  if (err) return { ok: false, reason: err };
  // managed 명시 시 갱신, 아니면 기존 값 보존(자기등록이 고정 플래그를 지우지 않게).
  entry.managed = managed != null ? Boolean(managed) : Boolean(list[idx].managed);
  list[idx] = entry;
  save(list);
  return { ok: true, collector: redact(entry) };
}

/**
 * 엣지 자기등록(EDGE_MODE=all) upsert — 같은 id(에이전트 이름)가 있으면 URL/토큰/DC를
 * 갱신하고, 없으면 추가한다. 관리자가 수동 등록한 항목의 enabled/vcenterId는 보존.
 * ★ 관리자가 수동 수정(managed=true)한 항목은 URL/토큰을 덮어쓰지 않는다 — 저장한 값이
 *   다음 자기등록 주기에 원복되던 버그 방지. (관리자 편집이 곧 '이 값으로 고정' 의사표시)
 */
export function upsertCollectorFromAgent({ name, url, token, datacenter = '' } = {}) {
  const id = String(name || '').trim();
  if (!id) return { ok: false, reason: 'name(에이전트 이름)은 필수입니다.' };
  const list = loadCollectors();
  // 대소문자 무시 매칭 — 'gm1' 자기등록이 기존 'GM1'을 새 항목으로 추가해 중복되던 것 방지.
  // 기존 항목의 실제 id를 그대로 두고 URL/토큰만 갱신한다(관리자 매핑·표시이름 보존).
  const existing = list.find((c) => String(c.id).toLowerCase() === id.toLowerCase());
  if (existing) {
    if (existing.managed) return { ok: true, collector: redact(existing), skipped: 'managed' };
    return updateCollector(existing.id, { url, token, datacenter: datacenter || existing.datacenter, name: existing.name || existing.id }, { managed: false });
  }
  return addCollector({ id, name: id, url, token, datacenter, enabled: true }, { managed: false });
}

export function removeCollector(id) {
  const list = loadCollectors();
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) return { ok: false, reason: `없는 수집 서버: ${id}` };
  save(next);
  return { ok: true };
}
