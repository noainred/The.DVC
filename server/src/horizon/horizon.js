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

import { trimTrailingSlashes } from '../util/trimSlashes.js'; // v2.685: 테스트 host 끝 슬래시(선형)
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from 'undici';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // 자격증명 저장 방식(평문/암호화, v2.296) — 로드 시 복호·저장 시 봉인
import { describeError } from '../util/errors.js';
import { ssrfBlockReason, ssrfBlockReasonResolved } from '../collector/registry.js';
import { ssrfLookup } from '../util/ssrfLookup.js';   // v2.506: DNS 리바인딩(TOCTOU) 차단
import { normRequestTimeoutMs, effectiveRequestTimeoutMs } from '../vcenter/soapParse.js'; // v2.598 T2598-03: 요청 시한 [1초, 10분]
import { accessMoved, dropCarriedSecrets } from '../util/secretCarry.js'; // v2.503: 접속처 변경 시 저장 비밀 폐기(공용 판정)

const FILE = path.join(config.configDir, 'horizon.json');
import { NO_REDIRECT, refuseRedirect } from '../util/noRedirect.js';
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

/**
 * 커넥션 서버 주소 정규화(v2.685, 사용자 요청 "ip만 넣어도 자동으로 https 등 필요한 거 붙이게"):
 *  · 스킴이 없으면 https:// 를 붙인다(http:// 를 직접 적었으면 그대로 둔다).
 *  · 붙여 넣은 경로·쿼리·계정 조각(/admin/, /rest/login 등)은 떼고 origin 만 남긴다 — API 경로는 이 모듈이 붙인다.
 *  · 해석하지 못하면 원문(다듬은 것)을 돌려준다 — 검증이 그 사유를 말한다(지어내지 않는다).
 * 저장·연결 테스트·대량 등록이 이 함수 하나를 쓴다(접속처 비교 accessMoved 도 정규화된 값으로 — 표기만 다른 같은 주소에서 비밀번호를 버리지 않게).
 */
export function normalizeHorizonHost(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return '';
  if (t.length > 2048) return t.slice(0, 2048);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
  let u;
  try { u = new URL(withScheme); } catch { return trimTrailingSlashes(t); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return trimTrailingSlashes(t);
  if (!u.hostname) return trimTrailingSlashes(t);
  return `${u.protocol}//${u.host}`;
}

function normalize(body, existing = null) {
  const e = existing ? { ...existing } : {};
  const id = String(body.id ?? e.id ?? '').trim();
  const name = String(body.name ?? e.name ?? id).trim();
  const host = normalizeHorizonHost(body.host ?? e.host ?? '');
  const username = String(body.username ?? e.username ?? '').trim();
  const domain = String(body.domain ?? e.domain ?? '').trim();
  if (!id) return [null, 'id는 필수입니다.'];
  if (id.length > 128 || [...id].some((c) => c.charCodeAt(0) < 32)) return [null, 'id에 사용할 수 없는 문자가 있습니다.'];
  if (!host) return [null, 'host(커넥션 서버 IP 또는 주소)는 필수입니다.'];
  if (!/^https?:\/\//.test(host)) return [null, `host 를 주소로 읽지 못했습니다 — IP·호스트명 또는 https://커넥션서버 형식으로 적으세요(입력: ${host.slice(0, 80)}).`];
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
  const droppedSecrets = existing && accessMoved(existing, body.host !== undefined ? { ...body, host } : body, ['host', 'username', 'domain'])
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
  const res = await fetch(url, { ...opts, redirect: NO_REDIRECT, dispatcher, signal: AbortSignal.timeout(timeoutMs) });
  return refuseRedirect(res, 'Horizon 커넥션 서버'); // v2.620 SEC2620-01
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
  const timeoutMs = effectiveRequestTimeoutMs(s.timeoutMs, 15_000); // v2.598 T2598-03: 옛 저장값(상한 이전)도 10분으로 자른다
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

/** 라이선스 조회 경로(Horizon 8 Server REST API — 공개 코드 horizon-mcp 가 2512~2606 에서 확인한 경로). */
export const LICENSE_PATH = '/rest/config/v1/licenses';

/**
 * 404 진단용 — 같은 세션으로 '다른 API 는 응답하는가' 와 커넥션 서버 버전을 본다(v2.685, 사용자 신고 HTTP 404).
 * ⚠ 정직 기록: 모니터 경로의 버전 필드 이름은 실장비로 확인하지 못했다 — 후보 이름으로 읽고 못 읽으면 null.
 */
export const PROBE_PATHS = Object.freeze(['/rest/monitor/v1/connection-servers', '/rest/monitor/connection-servers', '/rest/config/v1/connection-servers']);
export function csVersionOf(body) {
  const arr = Array.isArray(body) ? body : body ? [body] : [];
  for (const x of arr) {
    const v = x?.version || x?.details?.version || x?.connection_server_version || x?.build_version || x?.details?.build;
    if (v) return String(v).slice(0, 64);
  }
  return null;
}

/** 라이선스 응답 → 정규화 배열(순수). */
export function normalizeLicenses(data) {
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
}

/** 라이선스 조회 실패 문구 — 404 는 '로그인은 됐고 경로만 없다' 를 말한다(인증 문제로 오해하지 않게). */
export function licenseFailText(status) {
  if (status === 404) return `라이선스 조회 실패 (HTTP 404) — 로그인은 성공했지만 이 서버에 라이선스 API(${LICENSE_PATH})가 없습니다. Horizon 버전(8 2006 이상 필요)과 등록 주소가 커넥션 서버인지(UAG·로드밸런서 경로가 아닌지) 확인하세요.`;
  if (status === 403) return '라이선스 조회 거부 (HTTP 403) — 로그인은 성공했지만 이 계정에 라이선스 조회 권한이 없습니다(Horizon 관리자 역할 확인).';
  return `라이선스 조회 실패 (HTTP ${status})`;
}

/** 한 Connection Server의 라이선스 조회(로그인→조회→로그아웃). 반환: 정규화 배열. */
export async function fetchHorizonLicenses(s) {
  return withHorizonSession(s, async (get) => {
    const r = await get(LICENSE_PATH);
    if (!r.ok) { const e = new Error(licenseFailText(r.status)); e.licenseStatus = r.status; throw e; }
    return normalizeLicenses(await r.json());
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
  // v2.685: 저장과 같은 정규화(IP 만 넣어도 https:// · 붙여 넣은 경로 제거) — SSRF 검사도 그 값으로 한다.
  entry = { ...entry, host: normalizeHorizonHost(entry.host) };
  const ssrf = await ssrfBlockReasonResolved(String(entry.host));
  if (ssrf) return { ok: false, reason: `host: ${ssrf}` };
  const started = Date.now();
  try {
    // 로그인과 라이선스 조회를 나눠 말한다 — 404 는 '연결 실패' 가 아니다(사용자 신고: 등록 후 HTTP 404).
    const out = await withHorizonSession(entry, async (get) => {
      const r = await get(LICENSE_PATH);
      let csVersion = null; let probe = null;
      if (!r.ok) {
        for (const p of PROBE_PATHS) {
          try {
            const pr = await get(p);
            probe = { path: p, status: pr.status };
            if (pr.ok) { csVersion = csVersionOf(await pr.json().catch(() => null)); break; }
          } catch (e) { probe = { path: p, status: null, error: describeError(e).message }; }
        }
        return { licenseStatus: r.status, csVersion, probe };
      }
      return { lic: normalizeLicenses(await r.json()) };
    });
    if (out.lic) return { ok: true, loginOk: true, ms: Date.now() - started, licenses: out.lic.length, first: out.lic[0]?.name || '' };
    return {
      ok: true, loginOk: true, ms: Date.now() - started, licenses: null,
      licenseStatus: out.licenseStatus, licenseError: licenseFailText(out.licenseStatus),
      csVersion: out.csVersion, probe: out.probe,
    };
  } catch (e) {
    const d = describeError(e);
    return { ok: false, loginOk: e?.httpStatus ? false : null, reason: d.message, hint: d.hint, ms: Date.now() - started };
  }
}
