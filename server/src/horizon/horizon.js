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
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // 자격증명 저장 방식(평문/암호화, v2.296) — 로드 시 복호·저장 시 봉인
import { describeError } from '../util/errors.js';
import { ssrfBlockReason, ssrfBlockReasonResolved } from '../collector/registry.js';

const FILE = path.join(config.configDir, 'horizon.json');
// 사내 Horizon은 사설 인증서가 일반적 — 기본은 TLS 검증 생략, HORIZON_TLS_VERIFY=true로 강제 가능(NSX와 동일 패턴).
const dispatcher = new Agent({ connect: { rejectUnauthorized: process.env.HORIZON_TLS_VERIFY === 'true' } });

export function loadHorizon() {
  if (!fs.existsSync(FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return openSecretsDeep(Array.isArray(parsed?.servers) ? parsed.servers : []); // v2.296 자격증명 복호
  } catch { return []; }
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
    timeoutMs: Math.max(0, Math.round(Number(body.timeoutMs ?? e.timeoutMs) || 0)) || 15_000,
  };
  if (!entry.password) return [null, 'password는 필수입니다.'];
  return [entry, null];
}

export function upsertHorizon(body) {
  const list = loadHorizon();
  const id = String(body.id || '').trim();
  const idx = list.findIndex((s) => s.id === id);
  // 수정 시 비번을 비우면 normalize가 기존 비번을 물려받는다(신규만 password 필수 오류).
  const [entry, err] = normalize(body, idx >= 0 ? list[idx] : null);
  if (err) return { ok: false, reason: err };
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  saveHorizon(list);
  cache.delete(id); // 자격증명 변경 즉시 반영
  return { ok: true, server: redactHorizon(entry) };
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

/** 한 Connection Server의 라이선스 조회(로그인→조회→로그아웃). 반환: 정규화 배열. */
export async function fetchHorizonLicenses(s) {
  const timeoutMs = s.timeoutMs > 0 ? s.timeoutMs : 15_000;
  const login = await hzFetch(`${s.host}/rest/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username: s.username, password: s.password, domain: s.domain }),
  }, timeoutMs);
  if (!login.ok) throw new Error(`Horizon 로그인 실패 (HTTP ${login.status})${login.status === 401 ? ' — 계정/도메인 확인' : ''}`);
  const tok = await login.json().catch(() => ({}));
  const bearer = { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' };
  try {
    const r = await hzFetch(`${s.host}/rest/config/v1/licenses`, { headers: bearer }, timeoutMs);
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
  } finally {
    // 세션 누수 방지 — 로그아웃은 베스트에포트.
    hzFetch(`${s.host}/rest/logout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: tok.refresh_token || '' }),
    }, 5_000).catch(() => {});
  }
}

// ── 캐시 + 취합 ──────────────────────────────────────────────────────────────
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
    if (saved) entry = { ...saved, ...body, password: body.password || saved.password };
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
