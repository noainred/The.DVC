/**
 * Horizon Connection Server 연동 — 라이선스 만료일 확인 전용(가벼운 통합).
 *
 * 등록: CONFIG_DIR/horizon.json (자격증명 포함 → 0600, 원자적 쓰기).
 * 조회: Horizon 8 REST API — POST /rest/login → GET /rest/config/v1/licenses → POST /rest/logout.
 *   응답 필드는 버전에 따라 다르므로(expiration_time | subscription_slice_expiry 등) 방어적으로
 *   정규화한다. 만료 시각은 epoch ms, 없으면 영구/구독 미표기.
 * 캐시: 연결 서버당 10분 인메모리 캐시 — '라이선스 만료일 확인' 화면을 열 때마다 고RTT 로그인
 *   왕복이 발생하지 않게 한다(만료일은 분 단위로 변하는 값이 아님).
 */

import fs from 'node:fs';
import path from 'node:path';
import { Agent } from 'undici';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // 자격증명 저장 방식(평문/암호화, v2.296) — 로드 시 복호·저장 시 봉인
import { describeError } from '../util/errors.js';
import { ssrfBlockReason, ssrfBlockReasonResolved } from '../collector/registry.js';
import { ssrfLookup } from '../util/ssrfLookup.js';   // v2.506: DNS 리바인딩(TOCTOU) 차단
import { normRequestTimeoutMs } from '../vcenter/soapParse.js'; // v2.598 T2598-03: 요청 시한 [1초, 10분]
import { accessMoved, dropCarriedSecrets } from '../util/secretCarry.js'; // v2.503: 접속처 변경 시 저장 비밀 폐기(공용 판정)

const FILE = path.join(config.configDir, 'horizon.json');
// 사내 Horizon은 사설 인증서가 일반적 — 기본은 TLS 검증 생략, HORIZON_TLS_VERIFY=true로 강제 가능(NSX와 동일 패턴).
// v2.506(감사 S1 #2): DNS 리바인딩(TOCTOU) 차단 — 검증을 `lookup` 안에서 해 소켓이 실제로 쓸
// 주소를 그 순간에 검사한다. SNI(`servername`)·Host·인증서 검증은 원래 호스트명을 그대로 쓴다.
// 자세한 근거는 util/ssrfLookup.js 머리말.
export const HORIZON_TLS_VERIFY = process.env.HORIZON_TLS_VERIFY === 'true';
/*
 * ⚠ v2.574 SEC-16 — **기본값(검증 off)은 그대로 둔다. 다만 조용하지 않게 한다.**
 * 2026-09-21 감사가 "TLS 검증 기본 OFF + AD 도메인 계정" 을 지적했다. 사실이지만, 이 저장소는
 * 장비·어플라이언스 수집기에 대해 **"기본은 자체서명 허용(기존 동작), env 로 켠다"** 를 명시적
 * 규약으로 채택해 두었다(server/CLAUDE.md M-4 — `STORAGE_TLS_VERIFY`·`SANSWITCH_TLS_VERIFY`,
 * `sanswitch/collectors/fosRest.js:26`·`storage/collectors/isilon.js:22` 가 같은 형태다).
 * 기본을 뒤집으면 자체서명 커넥션 서버를 쓰는 **모든 현장에서 Horizon 수집이 즉시 죽는다** —
 * 그것은 감사 지적을 고치는 것이 아니라 장애를 만드는 것이다.
 *
 * 그래서 고친 것은 **정직성**이다: `resilientFetch` 가 `WAN_TLS_INSECURE=true` 일 때 하는 것처럼
 * 기동 시 한 번 경고하고, 상태(`horizonTlsInfo`)로 화면이 말할 수 있게 한다.
 * ⚠ 기본을 켜려면 **별건**으로 다룰 것 — 현장 인증서 실태를 확인하고 마이그레이션 안내가 필요하다.
 */
if (!HORIZON_TLS_VERIFY) {
  console.warn('[horizon] ⚠ HTTPS 인증서 검증이 꺼져 있습니다(기본값) — 커넥션 서버로 AD 계정이 전송되는 경로입니다. 사설 CA 를 신뢰시키고 HORIZON_TLS_VERIFY=true 로 켜는 것을 권장합니다.');
}
/** 화면·진단이 '지금 검증 중인가' 를 말할 수 있게 한다(조용한 약한 설정 금지). */
export const horizonTlsInfo = () => ({ verify: HORIZON_TLS_VERIFY, env: 'HORIZON_TLS_VERIFY' });
const dispatcher = new Agent({ connect: { rejectUnauthorized: HORIZON_TLS_VERIFY, lookup: ssrfLookup } });

export function loadHorizon() {
  if (!fs.existsSync(FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return openSecretsDeep(Array.isArray(parsed?.servers) ? parsed.servers : []); // v2.296 자격증명 복호
  } catch { preserveCorrupt(FILE); return []; } // v2.322: 손상본 보존(Horizon 자격증명 유실 방지)
}

function saveHorizon(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep({ servers: list }), null, 2), { mode: 0o600 }); // 암호화 모드면 password 봉인
}

export function redactHorizon(s) { const { password, ...rest } = s; return { ...rest, hasPassword: Boolean(password) }; }
export function listHorizon() { return loadHorizon().map(redactHorizon); }

function normalize(body, existing = null) {
  const e = existing ? { ...existing } : {};
  const id = String(body.id ?? e.id ?? '').trim();
  const name = String(body.name ?? e.name ?? id).trim();
  const host = String(body.host ?? e.host ?? '').trim().replace(/\/+$/, '');
  const username = String(body.username ?? e.username ?? '').trim();
  const domain = String(body.domain ?? e.domain ?? '').trim();
  if (!id) return [null, 'id는 필수입니다.'];
  if (id.length > 128 || [...id].some((c) => c.charCodeAt(0) < 32)) return [null, 'id에 사용할 수 없는 문자가 있습니다.'];
  if (!/^https?:\/\//.test(host)) return [null, 'host는 https://커넥션서버 형식이어야 합니다.'];
  // SSRF 방어 — 저장된 host는 이후 서버가 자격증명을 붙여 호출하므로 링크로컬/메타데이터·
  // 루프백·미지정 주소는 등록 단계에서 막는다. 사내 IP(RFC1918)·FQDN은 그대로 통과한다.
  const ssrf = ssrfBlockReason(host);
  if (ssrf) return [null, `host: ${ssrf}`];
  if (!username) return [null, 'username은 필수입니다.'];
  if (!domain) return [null, 'domain(AD 도메인)은 필수입니다.'];
  const entry = {
    id, name, host, username, domain,
    password: body.password ? String(body.password) : e.password || '',
    enabled: body.enabled !== undefined ? body.enabled !== false : (e.enabled !== false),
    // v2.598 T2598-03: 상한 없으면 2^31ms 이상에서 AbortSignal.timeout 이 1ms 가 되어 모든 요청이 즉시 끊긴다.
    timeoutMs: normRequestTimeoutMs(body.timeoutMs ?? e.timeoutMs) || 15_000,
  };
  if (!entry.password) return [null, 'password는 필수입니다.'];

  // ⚠ 보안 불변조건(v2.503, 감사 S1 #6) — **접속처가 바뀌면 저장 비밀을 승계하지 않는다.**
  // 판정은 `util/secretCarry.js` 하나로 한다(각자 구현하면 다음 스토어에서 또 빠진다 — v2.500 H1/H2/H4).
  // 이 파일은 v2.500 에서 '추정' 으로만 남아 있던 나머지 스토어 중 하나이고, 이번에 코드로 확인됐다:
  // `{host:'https://vc.attacker.example', password:''}` 로 저장하면 host 만 바뀌고 저장 비밀번호가
  // 그대로 남아, 다음 수집 주기에 **운영 계정·비밀번호가 그 호스트로 평문 전송**된다.
  // v2.480 의 "연결 테스트는 host 를 저장값으로 고정" 은 테스트 라우트만 막으므로 저장 1회로 우회된다.
  // 버린 키는 호출부가 `droppedSecrets` 로 받아 '비밀번호를 다시 입력하세요' 를 안내한다.
  const droppedSecrets = existing && accessMoved(existing, body, ['host', 'username', 'domain'])
    ? dropCarriedSecrets(entry, body, ['password']) : [];
  return [entry, null, droppedSecrets];
}

/**
 * 저장 검증의 **단일 소스**(v2.525) — 대량 가져오기 드라이런이 이걸 쓴다.
 *
 * `upsertHorizon` 과 **같은 `normalize` · 같은 existing 조회**를 거치므로 '드라이런 통과 =
 * 저장 성공' 계약이 성립한다. 여기서 규칙을 복제하면(예: 라우트에서 별도 검사) 두 판정이
 * 갈라져 '검증 통과 → 저장 예외' 가 된다(v2.513 규약).
 *
 * @returns {string|null} 사람용 사유, 문제 없으면 null
 */
export function horizonInputIssue(body) {
  const list = loadHorizon();
  const id = String(body?.id ?? '').trim();
  const idx = list.findIndex((s) => s.id === id);
  const [, err] = normalize(body || {}, idx >= 0 ? list[idx] : null);
  return err || null;
}

export function upsertHorizon(body) {
  const list = loadHorizon();
  const id = String(body.id || '').trim();
  const idx = list.findIndex((s) => s.id === id);
  // 수정 시 비번을 비우면 normalize가 기존 비번을 물려받는다(신규만 password 필수 오류).
  const [entry, err, droppedSecrets] = normalize(body, idx >= 0 ? list[idx] : null);
  if (err) return { ok: false, reason: err };
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  saveHorizon(list);
  cache.delete(id); // 자격증명 변경 즉시 반영
  return { ok: true, server: redactHorizon(entry), droppedSecrets };
}

export function removeHorizon(id) {
  const list = loadHorizon();
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return { ok: false, reason: `없는 Horizon 서버: ${id}` };
  saveHorizon(next);
  cache.delete(id);
  return { ok: true };
}

async function hzFetch(url, opts, timeoutMs) {
  const res = await fetch(url, { ...opts, dispatcher, signal: AbortSignal.timeout(timeoutMs) });
  return res;
}

/**
 * 로그인 → 작업 → 로그아웃을 **한 곳에서** 처리한다(v2.525).
 *
 * 왜 공용인가: 세션(실시간 사용자) 수집이 추가되면서 같은 로그인·TLS·SSRF 설정이 두 곳에
 * 필요해졌다. 복사하면 `dispatcher`(사설 인증서·DNS 리바인딩 가드)와 로그아웃 누락 방지가
 * 두 갈래로 갈라진다 — 이 저장소는 그 유형의 사고를 겪었다(v2.506 svcmon).
 *
 * `fn(get, tok)` 의 `get(pathname, { query })` 는 Bearer 를 붙인 GET 을 돌려준다(Response 그대로 —
 * 호출부가 상태코드로 원인을 구분할 수 있게. 여기서 삼키면 '401 인지 404 인지' 를 잃는다).
 */
export async function withHorizonSession(s, fn) {
  const timeoutMs = s.timeoutMs > 0 ? s.timeoutMs : 15_000;
  const login = await hzFetch(`${s.host}/rest/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username: s.username, password: s.password, domain: s.domain }),
  }, timeoutMs);
  if (!login.ok) {
    const e = new Error(`Horizon 로그인 실패 (HTTP ${login.status})${login.status === 401 ? ' — 계정/도메인 확인' : ''}`);
    e.httpStatus = login.status;
    throw e;
  }
  const tok = await login.json().catch(() => ({}));
  const bearer = { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' };
  const get = (pathname, { query = null, timeout = timeoutMs } = {}) => {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    return hzFetch(`${s.host}${pathname}${qs}`, { headers: bearer }, timeout);
  };
  try {
    return await fn(get, tok);
  } finally {
    // 세션 누수 방지 — 로그아웃은 베스트에포트.
    hzFetch(`${s.host}/rest/logout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: tok.refresh_token || '' }),
    }, 5_000).catch(() => {});
  }
}

/** 한 Connection Server의 라이선스 조회(로그인→조회→로그아웃). 반환: 정규화 배열. */
export async function fetchHorizonLicenses(s) {
  return withHorizonSession(s, async (get) => {
    const r = await get('/rest/config/v1/licenses');
    if (!r.ok) throw new Error(`라이선스 조회 실패 (HTTP ${r.status})`);
    const data = await r.json();
    // 단일 객체 또는 배열 두 형태 모두 수용.
    const arr = Array.isArray(data) ? data : [data];
    return arr.filter(Boolean).map((l) => ({
      name: l.license_edition || l.edition || 'Horizon License',
      usageModel: l.licensed_usage_model || l.usage_model || '',
      // 정식 만료(expiration_time) 우선, 구독 슬라이스 만료(subscription_slice_expiry) 폴백. epoch ms.
      expiry: Number(l.expiration_time) > 0 ? Number(l.expiration_time)
        : Number(l.subscription_slice_expiry) > 0 ? Number(l.subscription_slice_expiry) : null,
      isExpired: l.is_expired === true || String(l.license_health || '').toUpperCase() === 'EXPIRED',
      key: l.license_key ? `${String(l.license_key).slice(0, 5)}-…-${String(l.license_key).slice(-5)}` : '',
    }));
  });
}

const cache = new Map(); // id -> { at, licenses, error }
const TTL_MS = 10 * 60_000;

/** 등록된 모든(활성) Horizon 서버의 라이선스 행 취합 — 오래된 항목만 병렬 갱신. */
export async function collectHorizonLicenses({ force = false } = {}) {
  const servers = loadHorizon().filter((s) => s.enabled !== false);
  const now = Date.now();
  await Promise.all(servers.map(async (s) => {
    const c = cache.get(s.id);
    if (!force && c && now - c.at < TTL_MS) return;
    try { cache.set(s.id, { at: Date.now(), licenses: await fetchHorizonLicenses(s), error: null }); }
    catch (e) { cache.set(s.id, { at: Date.now(), licenses: c?.licenses || [], error: describeError(e).message }); }
  }));
  const rows = []; const errors = [];
  for (const s of servers) {
    const c = cache.get(s.id);
    if (!c) continue;
    if (c.error) errors.push({ id: s.id, name: s.name, reason: c.error });
    for (const l of c.licenses || []) rows.push({ server: s, lic: l });
  }
  return { rows, errors, servers: servers.length };
}

/** 연결 테스트(등록 전/후). 저장된 항목 id만 주면 저장 자격증명 사용. */
export async function testHorizon(body) {
  let entry = body;
  if (!entry.password && entry.id) {
    const saved = loadHorizon().find((s) => s.id === entry.id);
    if (saved) entry = { ...saved, ...body, password: saved.password, host: saved.host }; // v2.480(3차 감사 S6): 저장 비밀번호를 물려받는 테스트는 host 도 저장값으로 고정 — body.host 만 공격자 IP 로 바꿔 평문 비밀번호를 받는 경로 차단(PDU S-1 과 같은 규칙)
  }
  if (!entry.host || !entry.username || !entry.password || !entry.domain) {
    return { ok: false, reason: 'host/username/password/domain이 필요합니다.' };
  }
  // 연결 테스트는 normalize()를 거치지 않으므로(저장 전 임의 host 수용) 여기서 같은 SSRF 가드를
  // 적용한다 — 미저장 host로 링크로컬/루프백을 찔러 보는 통로가 되지 않게. 이 경로는 async라
  // DNS 해석까지 검사하는 resolved 가드로 '이름 기반 우회'(169.254.169.254로 해석되는 FQDN)도 차단.
  const ssrf = await ssrfBlockReasonResolved(String(entry.host));
  if (ssrf) return { ok: false, reason: `host: ${ssrf}` };
  const started = Date.now();
  try {
    const lic = await fetchHorizonLicenses(entry);
    return { ok: true, ms: Date.now() - started, licenses: lic.length, first: lic[0]?.name || '' };
  } catch (e) {
    const d = describeError(e);
    return { ok: false, reason: d.message, hint: d.hint, ms: Date.now() - started };
  }
}
