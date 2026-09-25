/**
 * Collector registry — the list of remote collector agents (one per datacenter)
 * the central portal pulls power from. Stored in CONFIG_DIR/collectors.json
 * (0600; holds per-agent tokens). Edited via the admin API.
 */

import { trimTrailingSlashes, COLLECTOR_URL_MAX } from '../util/trimSlashes.js';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { ipBlockReason, ssrfBlockReason, ssrfBlockReasonResolved } from '../util/ssrfBlock.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // 자격증명 저장 방식(평문/암호화, v2.296) — 로드 시 복호·저장 시 봉인
import { bumpFleetRev } from '../insights/fleetRev.js';
import { readJsonCapped } from '../util/readCapped.js'; // v2.604 CEN2604-01: 자기등록 검증 ping 응답 크기 상한
import { resilientFetch } from '../util/resilientFetch.js'; // v2.613 DEPS2613-03: 동적 import 에서 정적으로(순환 없음)
import { accessMoved, dropCarriedSecrets } from '../util/secretCarry.js'; // v2.503: url 변경 시 저장 토큰 폐기

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

/**
 * 이름 또는 id 로 수집 서버 한 항목을 찾는다(대소문자·앞뒤 공백 무시 — 등록부 규약. v2.613 EDGE2613-08).
 * `central/edgeLogPull.js findCollector` 와 `central/idracScanPush.js findCollectorForAgent` 두 벌이던 것을 하나로 —
 * 둘 다 이 함수를 재수출한다. ⚠ 원본(`loadCollectors`, 토큰 포함)을 돌려준다 — `listCollectors()` 는 토큰을 가리므로
 * 그것으로 찾으면 엣지 호출이 X-Collector-Token 없이 나가 403 이 된다. 없으면 null. 등록부를 못 읽으면 loadCollectors 가
 * 돌려주는 대로(빈 목록 → null)다.
 */
export function findCollectorByName(agent) {
  const key = String(agent ?? '').trim().toLowerCase();
  if (!key) return null;
  const norm = (v) => String(v ?? '').trim().toLowerCase();
  return loadCollectors().find((c) => norm(c.id) === key || norm(c.name) === key) || null;
}

// ── SSRF 가드 ────────────────────────────────────────────────────────────────
// SSRF 차단 판정은 v2.579 에 `util/ssrfBlock.js` 로 옮겼다(ARCH-02 — util 이 collector 를 import 하던
// 역방향 의존·순환 제거). 호출부 29곳을 위해 같은 이름을 **재수출**한다. ⚠ `export { } from` 이 아니라
// import + export 다 — 이 파일의 `normalize()` 가 `ssrfBlockReason` 을 직접 쓴다.
export { ipBlockReason, ssrfBlockReason, ssrfBlockReasonResolved };

/**
 * 응답 엣지 정체 ↔ 등록 항목 대조(v2.424, 순수). 엣지가 export/ping 에 실은 agent 이름이 등록 id/표시이름과 다르면
 * 그 URL 이 **다른 엣지**에 닿고 있다는 뜻이다 — 엣지A 포워딩(A:4068→B)이 A 자신(:4000)으로 되돌아오거나, B 의
 * 자기등록이 peer IP(A) 로 URL 을 유도해 A 를 가리키는 경우. 구버전 엣지(agent 없음)는 판정하지 않는다(null).
 * @returns null(일치/판정불가) | { agent, hostname, reason }
 */
export function identityIssue(entry, data = {}, otherIds = []) {
  const agent = String(data?.agent || '').trim();
  if (!agent || !entry) return null;
  const norm = (v) => String(v || '').trim().toLowerCase();
  // v2.428: DC 이름은 대조에서 뺀다 — 포워딩이 중계 엣지 자신으로 되돌아오면 응답 agent(gm1)가 IRS 항목의 DC(gm1)와 같아
  //         불일치를 못 잡았다(구성도 미스매치 #9). 다른 등록 항목의 id 와 같으면 확실한 불일치.
  const other = (otherIds || []).map(norm).find((v) => v && v === norm(agent) && v !== norm(entry.id));
  const ok = !other && [entry.id, entry.name].map(norm).filter(Boolean).some((v) => v === norm(agent));
  if (ok) return null;
  return { agent, hostname: String(data?.hostname || ''), reason: `이 URL 에 응답한 엣지는 '${agent}'${data?.hostname ? `(${data.hostname})` : ''} 인데 등록 항목은 '${entry.id}' 입니다${other ? ` — '${agent}' 은 다른 수집 서버 항목입니다(포워딩이 그 엣지, 대개 중계 엣지 자신으로 감)` : ' — 포트포워딩이 다른 엣지로 가거나, 자기등록 URL 이 중계 엣지를 가리킵니다'}.` };
}

/**
 * 수집 토큰을 싣는 요청의 기본 fetch(v2.506, 적대적 검증) — **전역 fetch 를 쓰지 않는다.**
 * 전역 fetch 는 기본 디스패처라 DNS 리바인딩 차단 lookup 이 없다. 이 함수의 요청에는
 * `X-Collector-Token` 이 실리므로, 검사 후 이름이 사내 주소로 재해석되면 그 토큰이 내부로 나간다.
 * `resilientFetch`(wanAgent, lookup 탑재)를 쓰되 재시도는 0 으로 둔다 — 이 검증은 '닿는가' 를
 * 보는 것이고 재시도가 판정을 흐리기 때문이다(기존 동작과 같게 유지).
 * v2.613 DEPS2613-03: 정적 import 다 — 예전 주석의 '순환 회피 지연 로드' 는 v2.579 ARCH-02(ssrfBlock 분리) 뒤로 되돌이 경로가
 *   없어 사실이 아니었다(util/resilientFetch.js 는 util/ 만 import 한다).
 */
async function tokenFetch(u, init) {
  return resilientFetch(u, { ...init, retries: 0 });
}

/**
 * peer IP 로 유도한 자기등록 URL 검증(v2.424). 그 URL 의 /api/collector/ping 을 엣지의 토큰으로 두드려
 * ① 403 → 그 주소는 다른 엣지(중계/NAT 장비) ② 응답 agent ≠ name → 다른 엣지 ③ 불통 → 중앙이 못 닿는 주소.
 * 반환 { ok:true } | { ok:false, reason }. fetchImpl 은 테스트 주입용.
 */
/** 자기등록 검증 ping 응답 상한 — ping 본문은 수백 바이트다(v2.604 CEN2604-01). */
export const VERIFY_PING_MAX_BYTES = 64 * 1024;

export async function verifyDerivedCollectorUrl({ url, name, datacenter = '', token }, fetchImpl = tokenFetch) {
  let why = '';
  try {
    const pr = await fetchImpl(`${trimTrailingSlashes(String(url))}/api/collector/ping`, { headers: { Accept: 'application/json', 'X-Collector-Token': String(token || '') }, signal: AbortSignal.timeout(8_000) });
    if (pr.status === 403 || pr.status === 401) why = `유도한 주소 ${url} 이(가) 이 엣지의 토큰을 거부(403) — 그 주소는 다른 엣지(중계/NAT 장비)입니다`;
    else if (!pr.ok) why = `유도한 주소 ${url} 응답 HTTP ${pr.status}`;
    else {
      // ⚠ v2.604(감사 CEN2604-01): 응답은 **상한까지만** 읽는다. 예전 `pr.json()` 은 해제 후 크기 상한이 없어 공유 토큰
      //   보유자가 urlHint 로 gzip 폭탄 주소(사내 대역은 SSRF 가드가 허용한다)를 주면 중앙 RSS 가 수 GB 로 올랐다. 그리고
      //   JSON 이 아니면 `{}` 로 삼켜 identityIssue 가 null(=일치) → **검증 통과** 가 됐다. 이제 파싱 실패·ok 아님·agent 없음은
      //   전부 '검증 실패' 다(v2.424 이후의 엣지는 ping 에 agent 를 싣는다).
      let j = null;
      try { j = await readJsonCapped(pr, VERIFY_PING_MAX_BYTES, '엣지 ping 응답'); } catch (e) { why = `유도한 주소 ${url} 응답을 읽지 못함(${String(e?.message || e).slice(0, 160)})`; }
      if (!why) {
        if (!j || typeof j !== 'object' || Array.isArray(j) || j.ok !== true) why = `유도한 주소 ${url} 응답이 수집 서버 ping 형식이 아닙니다`;
        else if (typeof j.agent !== 'string' || !j.agent.trim()) why = `유도한 주소 ${url} 에 응답한 엣지가 이름(agent)을 보고하지 않습니다(엣지 업그레이드 필요)`;
        else {
          const iss = identityIssue({ id: name, name, datacenter }, j);
          if (iss) why = `유도한 주소 ${url} 에 응답한 엣지가 '${iss.agent.slice(0, 128)}' (이 엣지 '${name}' 아님)`;
        }
      }
    }
  } catch (e) { why = `유도한 주소 ${url} 에 중앙이 닿지 못함(${e.message})`; }
  if (!why) return { ok: true };
  return { ok: false, reason: `${why}. NAT/포워딩 뒤 엣지는 portal.env 에 EDGE_ADVERTISE_URL=http://<중앙에서 닿는 주소>:<포트> 를 지정하세요(중계 엣지의 포워딩 포트).` };
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
  // v2.611 LEFT2611-06: 길이 상한 + 선형 끝 '/' 제거 — 정규식 끝-슬래시 치환은 긴 입력에서 O(n²) 였다(4만 자 620ms).
  if (url.length > COLLECTOR_URL_MAX) return [null, `수집 서버 URL이 너무 깁니다(${COLLECTOR_URL_MAX}자 이하).`];
  if (!/^https?:\/\//.test(url)) url = `http://${url}`;
  url = trimTrailingSlashes(url);
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
  // ⚠ 보안 불변조건(v2.503, 감사 S1 #6) — 접속처(url)가 바뀌면 저장 토큰을 승계하지 않는다.
  // 수집 서버 토큰은 중앙이 그 URL 로 **자격증명을 실어 호출**하는 열쇠다(v2.500 C-1 이 막은
  // `/register-collector` 횡탈과 같은 자산). 저장 요청 1회로 url 만 바꾸면 그 토큰이 새 주소로
  // 간다 — v2.480 의 '연결 테스트는 저장값 고정' 은 테스트 라우트만 막으므로 우회된다.
  const droppedSecrets = existing && accessMoved(existing, body, ['url'])
    ? dropCarriedSecrets(entry, body, ['token']) : [];
  return [entry, null, droppedSecrets];
}

/**
 * CSV 가져오기 드라이런용 검증(v2.338) — 실제 저장(add/update)과 **같은 normalize 규칙**을
 * 저장 없이 돌려 오류 문구만 돌려준다(null=통과). 규칙을 복제하지 않아 드라이런 통과 =
 * 실제 저장 성공이 보장된다(SSRF/URL/필수값 검증 포함).
 */
export function collectorInputIssue(body, existing = null) {
  const [, err] = normalize(body, existing);
  return err || null;
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
  const [entry, err, droppedSecrets] = normalize({ ...body, id }, list[idx]);
  if (err) return { ok: false, reason: err };
  // managed 명시 시 갱신, 아니면 기존 값 보존(자기등록이 고정 플래그를 지우지 않게).
  entry.managed = managed != null ? Boolean(managed) : Boolean(list[idx].managed);
  list[idx] = entry;
  save(list);
  // v2.607(통합): url 이 바뀌어 저장 토큰을 폐기했으면 그 사실을 응답에 싣는다 — 화면(droppedSecretText)이 '다시 입력' 을 안내한다.
  //   예전에는 normalize 가 돌려준 목록을 여기서 버려, 다음 pull 이 빈 토큰으로 403 이 될 때까지 아무도 몰랐다.
  return { ok: true, collector: redact(entry), ...(droppedSecrets?.length ? { droppedSecrets } : {}) };
}

/**
 * 엣지 자기등록(EDGE_MODE=all) upsert — 같은 id(에이전트 이름)가 있으면 URL/토큰/DC를
 * 갱신하고, 없으면 추가한다. 관리자가 수동 등록한 항목의 enabled/vcenterId는 보존.
 * ★ 관리자가 수동 수정(managed=true)한 항목은 URL/토큰을 덮어쓰지 않는다 — 저장한 값이
 *   다음 자기등록 주기에 원복되던 버그 방지. (관리자 편집이 곧 '이 값으로 고정' 의사표시)
 */
export function upsertCollectorFromAgent({ name, url, token, datacenter = '', unverified = false, shared = false } = {}) {
  const id = String(name || '').trim();
  if (!id) return { ok: false, reason: 'name(에이전트 이름)은 필수입니다.' };
  const list = loadCollectors();
  // 대소문자 무시 매칭 — 'gm1' 자기등록이 기존 'GM1'을 새 항목으로 추가해 중복되던 것 방지.
  // 기존 항목의 실제 id를 그대로 두고 URL/토큰만 갱신한다(관리자 매핑·표시이름 보존).
  const existing = list.find((c) => String(c.id).toLowerCase() === id.toLowerCase());
  if (existing) {
    if (existing.managed) return { ok: true, collector: redact(existing), skipped: 'managed' };
    const r = updateCollector(existing.id, { url, token, datacenter: datacenter || existing.datacenter, name: existing.name || existing.id }, { managed: false });
    if (r.ok) markSelfRegVerification(existing.id, unverified);
    return r;
  }
  // v2.604(감사 CEN2604-04): **공유 토큰**의 새 이름 생성은 개수를 묶는다. 예전에는 상한이 없어 공유 토큰 하나로 수집 서버
  //   항목 150개를 만들 수 있었다(검증 실패한 urlHint 도 '미검증' 으로 저장). 기존 항목 갱신은 막지 않는다.
  //   미검증 새 항목은 작게(SELF_REG_UNVERIFIED_MAX), 자기등록 항목 전체는 넉넉히(SELF_REG_MAX — 현장 28곳·30+ 확장).
  if (shared) {
    const selfReg = list.filter((c) => !c.managed);
    if (selfReg.length >= SELF_REG_MAX) return { ok: false, capped: true, reason: `자기등록 수집 서버가 상한(${SELF_REG_MAX}개)에 닿아 새 이름 '${id}' 을 받지 않습니다 — 관리자가 설정 › 수집 서버에서 등록하거나 엣지별 개별 토큰을 쓰세요.` };
    if (unverified && selfReg.filter((c) => c.selfRegUnverified).length >= SELF_REG_UNVERIFIED_MAX) return { ok: false, capped: true, reason: `검증되지 않은 자기등록이 상한(${SELF_REG_UNVERIFIED_MAX}개)에 닿아 새 이름 '${id}' 을 받지 않습니다 — 등록 URL(EDGE_ADVERTISE_URL)이 이 엣지에 닿는지 확인하거나 관리자가 직접 등록하세요.` };
  }
  const r = addCollector({ id, name: id, url, token, datacenter, enabled: true }, { managed: false });
  if (r.ok) markSelfRegVerification(id, unverified);
  return r;
}

/** 자기등록 개수 상한(v2.604 CEN2604-04) — 공유 토큰의 새 이름 생성에만 적용한다. */
export const SELF_REG_MAX = Math.max(8, Number(process.env.CENTRAL_SELF_REGISTER_MAX) || 256);
export const SELF_REG_UNVERIFIED_MAX = Math.max(1, Number(process.env.CENTRAL_SELF_REGISTER_UNVERIFIED_MAX) || 16);

/**
 * 자기등록 검증 결과를 항목에 남긴다(v2.604 CEN2604-04). `selfRegUnverified` 가 있는 항목은 중앙이 '아는 엣지' 로 세지 않는다
 * (routes/central.js edgeNameKnown) — 공유 토큰이 검증에 실패한 urlHint 로 이름을 만들어 넣고 그 이름으로 v2.601 '미검증 제한'
 * 을 우회하던 것을 막는다. 검증에 성공하면 표식을 지운다. 이 표식이 없는 옛 항목은 예전처럼 '아는 엣지' 다(호환).
 */
function markSelfRegVerification(id, unverified) {
  const list = loadCollectors();
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) return;
  const had = !!list[idx].selfRegUnverified;
  if (had === !!unverified) return;
  if (unverified) list[idx].selfRegUnverified = true; else delete list[idx].selfRegUnverified;
  save(list);
}

export function removeCollector(id) {
  const list = loadCollectors();
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) return { ok: false, reason: `없는 수집 서버: ${id}` };
  save(next);
  return { ok: true };
}
