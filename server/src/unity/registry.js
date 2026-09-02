/**
 * Unity 스토리지 장비 레지스트리 — CONFIG_DIR/unity.json(0600, 자격증명 보관).
 *
 * vcenter/registry.js 와 동일한 관례를 따른다(보안 불변조건 — server/CLAUDE.md):
 *  - 원자적 쓰기(atomicWriteFileSync) + 로드 손상 시 preserveCorrupt 후 빈 값 반환.
 *    로드가 손상을 조용히 []로 넘기면 다음 저장이 온전한 원본을 덮어써 자격증명이 영구 유실된다.
 *  - secretVault 로 저장 시 봉인(sealSecretsDeep) / 로드 시 복호(openSecretsDeep).
 *  - 응답에는 비밀번호를 싣지 않는다(redact → hasPassword 만 노출).
 *  - 외부 입력 host 를 네트워크로 찌르므로 등록·테스트 양쪽에서 ssrfBlockReason 통과 필수.
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js';
import { ssrfBlockReason } from '../collector/registry.js';
import { getBasicInfo, getSystem, getPools } from './restClient.js';
import { config } from '../config.js';

const FILE = path.join(config.configDir, 'unity.json');

export function loadRegistry() {
  if (!fs.existsSync(FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return openSecretsDeep(Array.isArray(parsed?.arrays) ? parsed.arrays : []); // 메모리는 항상 평문
  } catch (e) {
    // 손상본을 조용히 []로 반환하면 다음 저장이 빈 목록으로 덮어써 전 자격증명이 소실된다.
    preserveCorrupt(FILE, e.message);
    return [];
  }
}

function saveRegistry(list) {
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep({ arrays: list }), null, 2), { mode: 0o600 });
}

/** 비밀번호 제거 + hasPassword 노출(UI용). */
export function redact(a) {
  const { password, ...rest } = a;
  return { ...rest, hasPassword: Boolean(password) };
}

export const listRegistry = () => loadRegistry().map(redact);

/** 입력 검증/정규화. 반환 [entry, error]. */
function normalize(body, existing = null) {
  const e = existing ? { ...existing } : {};
  const id = String(body.id ?? e.id ?? '').trim();
  const name = String(body.name ?? e.name ?? '').trim();
  const host = String(body.host ?? e.host ?? '').trim();
  const username = String(body.username ?? e.username ?? '').trim();

  if (!id) return [null, 'id는 필수입니다.'];
  if (id.length > 128 || [...id].some((c) => c.charCodeAt(0) < 32)) return [null, 'id에 사용할 수 없는 문자가 있습니다.'];
  if (!name) return [null, 'name(표시 이름)은 필수입니다.'];
  if (!/^https?:\/\//.test(host)) return [null, 'host는 https://... 형식이어야 합니다.'];
  if (!username) return [null, 'username은 필수입니다.'];
  const ssrf = ssrfBlockReason(host); // SSRF 가드(불변조건) — 링크로컬/루프백/우회표기 차단
  if (ssrf) return [null, `host 거부: ${ssrf}`];

  return [{
    id, name, host, username,
    // 빈 비밀번호는 기존 값 유지(편집 시 재입력 강요하지 않음)
    password: body.password ? String(body.password) : e.password || '',
    datacenterId: String(body.datacenterId ?? e.datacenterId ?? '').trim(),
    enabled: body.enabled !== undefined ? body.enabled !== false : (e.enabled !== false),
  }, null];
}

export function addUnity(body) {
  const list = loadRegistry();
  const [entry, err] = normalize(body);
  if (err) return { ok: false, reason: err };
  if (list.some((a) => a.id === entry.id)) return { ok: false, reason: `이미 존재하는 id: ${entry.id}` };
  list.push(entry);
  saveRegistry(list);
  return { ok: true, unity: redact(entry) };
}

export function updateUnity(id, body) {
  const list = loadRegistry();
  const idx = list.findIndex((a) => a.id === id);
  if (idx === -1) return { ok: false, reason: `없는 Unity: ${id}` };
  const [entry, err] = normalize({ ...body, id }, list[idx]);
  if (err) return { ok: false, reason: err };
  list[idx] = entry;
  saveRegistry(list);
  return { ok: true, unity: redact(entry) };
}

export function removeUnity(id) {
  const list = loadRegistry();
  const next = list.filter((a) => a.id !== id);
  if (next.length === list.length) return { ok: false, reason: `없는 Unity: ${id}` };
  saveRegistry(next);
  return { ok: true };
}

/** 실패 단계·오류코드별 한국어 조치 안내(화면에서 원인을 바로 알 수 있게). 순수 함수. */
export function hintFor(step, err) {
  const code = err?.code || '';
  const msg = String(err?.message || '');
  if (code === 'REDIRECT' || code === 'NOT_JSON') {
    return '이 주소는 Unity Unisphere REST 가 아닙니다. 실제 Unity 관리 IP인지, 앞단에 SSO/리버스 프록시가 없는지 확인하세요.';
  }
  if (code === '401') return '계정/비밀번호를 확인하세요(Unisphere 로컬 계정 권장).';
  if (code === '403') return '이 계정에 조회 권한이 없습니다. operator(읽기) 이상 권한을 부여하세요.';
  if (/timeout|abort/i.test(msg)) return '응답이 없습니다 — 방화벽(TCP 443)과 경로를 확인하세요.';
  if (/ECONNREFUSED|refused/i.test(msg)) return '연결이 거부되었습니다 — IP/포트를 확인하세요.';
  if (/certificate|self.signed|TLS|SSL/i.test(msg)) return '인증서 오류입니다. UNITY_TLS_STRICT=true 로 검증을 켠 상태라면 신뢰할 수 있는 인증서가 필요합니다.';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return '호스트 이름을 찾을 수 없습니다 — DNS/주소를 확인하세요.';
  if (step === 'collect') return '로그인은 되었지만 풀 조회가 실패했습니다 — 계정의 권한 범위를 확인하세요.';
  return '';
}

/** 사람이 읽는 단계 이름(응답에 함께 실어 UI가 그대로 표시). */
export const STEP_LABEL = {
  validate: '입력값',
  reach: '도달성',
  auth: '인증',
  collect: '데이터 조회',
};

/**
 * 연결 테스트 — 등록 화면의 [연결 테스트] 버튼이 호출.
 * 저장 전(폼 값)에도, 저장 후(id 로 저장된 비번 사용)에도 동작한다.
 * 3단계로 나눠 '어디서' 실패했는지 정확히 알려준다.
 */
export async function testConnection(body) {
  let entry = body;
  // 비밀번호를 안 보내면 저장된 값 사용 → 재입력 없이 재테스트(vCenter testConnection 과 동일)
  if (!entry.password && entry.id) {
    const saved = loadRegistry().find((a) => a.id === entry.id);
    if (saved) entry = { ...saved, ...body, password: body.password || saved.password };
  }
  if (!entry.host || !entry.username || !entry.password) {
    return { ok: false, step: 'validate', stepLabel: STEP_LABEL.validate, reason: 'host/username/password가 필요합니다.' };
  }
  const ssrf = ssrfBlockReason(entry.host);
  if (ssrf) return { ok: false, step: 'validate', stepLabel: STEP_LABEL.validate, reason: `host 거부: ${ssrf}` };

  const started = Date.now();
  let step = 'reach';
  try {
    // ① 도달성(무인증) — 네트워크/TLS/대상이 Unity 인지
    const info = await getBasicInfo(entry);
    // ② 인증 — 계정/비밀번호/권한
    step = 'auth';
    const sys = await getSystem(entry);
    // ③ 수집 가능성 — 실제로 쓸 데이터가 나오는지
    step = 'collect';
    const pools = await getPools(entry);

    return {
      ok: true,
      ms: Date.now() - started,
      model: sys?.model || info?.model || 'Unity',
      name: sys?.name || '',
      serialNumber: sys?.serialNumber || '',
      oeVersion: info?.softwareVersion || '',
      apiVersion: info?.apiVersion || '',
      pools: pools.length,
    };
  } catch (err) {
    return {
      ok: false,
      step,
      stepLabel: STEP_LABEL[step] || step,
      code: err?.code || '',
      ms: Date.now() - started,
      reason: err?.message || '알 수 없는 오류',
      hint: hintFor(step, err),
    };
  }
}
