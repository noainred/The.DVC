/**
 * 물리(베어메탈) GPU 서버 등록부 — 가상화하지 않은 서버를 IP+계정으로 등록해 SSH(nvidia-smi)로
 * GPU를 수집한다. CONFIG_DIR/gpu-physical.json (0600, 비밀번호 포함)에 저장하며, 클라이언트로
 * 내보낼 때는 비밀번호를 가린다.
 *
 *   server: { id, name, host, port, username, password, os, vcenterId, enabled }
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // 자격증명 저장 방식(평문/암호화, v2.296) — 로드 시 복호·저장 시 봉인
import { makeLoadError, filterObjectElements, summarizeRegistryError } from '../util/registryCore.js'; // 95회차 F1: 공용 등록부 읽기(손상 · 읽기 오류 구분)
import { accessMoved, dropCarriedSecrets } from '../util/secretCarry.js'; // v2.503: 접속처 변경 시 저장 비밀 폐기
import { usableIp } from './sshCollect.js';

const FILE = path.join(config.configDir, 'gpu-physical.json');

let cache = null;

/*
 * 전체 점검 95회차 F1(재현 — 36회차 '남긴 것'): 예전 로더는 읽기 · 파싱 · 복호를 catch 하나로 받아 **읽기 오류**(EISDIR · EACCES · EIO)도 손상으로 보고
 *   온전한 원본(SSH 계정 파일)을 `.corrupt.*` 로 옮긴 뒤 빈 목록으로 돌았다 — 다음 등록 한 번이 그 한 건만 든 파일을 썼다(다른 서버 계정은 보존본에만).
 *   손상도 화면 · API 어디에도 표지가 없었고(재시작 뒤에는 보존본만 남아 '등록 없음'), 원소 null 하나에 목록 · 등록 · 폴러가 매번 TypeError 였다.
 *   이제 판정은 공용 등록부 읽기(util/registryCore.js makeLoadError.read — bmstor · idrac 등록부와 같다): 손상 = 보존 + 표지(관리자 저장이 새 등록부를 만든다 — v2.612),
 *   읽기 오류 = 원본 유지 · 캐시하지 않음 · 쓰기 거절(409), 객체 원소만.
 */
const loadErr = makeLoadError();
const WHAT = '물리 GPU 서버 등록부(gpu-physical.json)';
const parsePhysical = (text) => {
  const j = JSON.parse(text);
  if (j == null || typeof j !== 'object' || Array.isArray(j)) throw new Error('등록부가 객체가 아닙니다');
  return filterObjectElements(openSecretsDeep(Array.isArray(j.servers) ? j.servers : [])).list;   // v2.296 SSH 계정 복호
};

export function loadPhysical() {
  if (cache && !loadErr.readPending()) return cache;
  const r = loadErr.read(FILE, parsePhysical);   // 손상이면 preserveCorrupt(사유 포함) — v2.322 손상본 보존 규칙 그대로
  cache = r.kind === 'ok' ? r.value : null;
  if (!cache) { loadErr.checkCorruptOnly(FILE); cache = []; }
  return cache;
}
/** 95회차 F1: 로드 오류(손상 · 읽기 오류 · 보존본만 있음) 또는 null — 로드를 먼저 한다. */
export function physicalRegistryLoadError() { loadPhysical(); return loadErr.get(); }
/**
 * 95회차 F1: 다른 등록부와 같은 이름의 표지 — 설정 연동(linkcheck/settingsLinks.js noteLoadError)이 이 이름을 찾는다. 없으면 파일 판정(손상 보존본)만 보아
 *   **읽기 오류**(원본 그대로 · 빈 목록) 동안 연동 대상이 '설정에서 사라짐' 으로 판정됐다.
 */
export const registryLoadError = physicalRegistryLoadError;
/** 95회차 F1: 화면용 요약(원문 조각 없음 — summarizeRegistryError) 또는 null. */
export function physicalRegistryLoadErrorSummary() {
  const e = physicalRegistryLoadError();
  if (!e) return null;
  const s = summarizeRegistryError(e);
  return { at: Number.isFinite(e.at) ? e.at : null, code: s?.code || null, text: s?.text || '사유 미상', readError: e.readError === true };
}
/** 95회차 F1: 읽기 오류 중의 쓰기 거절(409 본문) 또는 null. */
export function physicalWriteRefusal() { loadPhysical(); return loadErr.writeRefusal(WHAT); }

function persist(next) {
  loadErr.assertWritable(WHAT);   // 95회차 F1: 마지막 방어선 — 어느 경로도 읽기 오류 중에 원본을 덮지 않는다(던진다)
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep({ servers: next }), null, 2), { mode: 0o600 }); // 암호화 모드면 password 봉인
  try { fs.chmodSync(FILE, 0o600); } catch { /* best effort */ }
  // 95회차 F1: 메모리는 쓰기 성공 뒤에만 바꾼다(봉인 거절 · 디스크 오류면 화면 · 폴러가 저장되지 않은 항목을 쓰지 않게 — 21 · 22회차 규약)
  cache = next;
  loadErr.clear();   // v2.612 LEFT2612-01 과 같은 규칙 — 관리자 저장이 손상 표지를 푼다
}

/** 비밀번호를 가린 목록(클라이언트용). */
export function listPhysical() {
  return loadPhysical().map((s) => ({
    id: s.id, name: s.name, host: s.host, port: s.port || 22, username: s.username || '',
    os: s.os || 'linux', vcenterId: s.vcenterId || '', enabled: s.enabled !== false, hasPassword: !!s.password,
    gpuModels: s.gpuModels || [],
  }));
}

export function getPhysicalRaw(id) { return loadPhysical().find((s) => s.id === id) || null; }
export function findPhysicalByHost(host) { const h = String(host || '').trim().toLowerCase(); return loadPhysical().find((s) => (s.host || '').toLowerCase() === h) || null; }

/**
 * 전체 점검 36회차 F2 · F3(재현): 물리 GPU 서버의 접속처 판정은 **수집 경로와 같은 하나**(`usableIp` — 정규형 IPv4 · 루프백 · 링크로컬 제외).
 *   예전에는 등록 · 자동 등록이 호스트명과 루프백까지 받아 ① 자동 등록이 SSRF 가드 없이 그 주소로 SSH 접속했고 ② 폴러는 정규형 IPv4 만 써서
 *   호스트명 서버에 한 번도 접속하지 않은 채 'VMware Tools 가 IP 미보고' 라는 엉뚱한 사유를 남겼다. 사유 문구 또는 null.
 */
export function physicalHostIssue(host) {
  const h = String(host ?? '').trim();
  if (!h) return 'IP 가 필요합니다.';
  return usableIp(h) ? null : `IPv4 주소로 적으세요(${h.slice(0, 64)}) — 호스트명 · 루프백 · 링크로컬 · 비정규 표기는 수집하지 않습니다.`;
}

export function addPhysical(body = {}) {
  const host = String(body.host || '').trim();
  if (!host) return { ok: false, reason: 'IP/호스트가 필요합니다.' };
  { const why = physicalHostIssue(host); if (why) return { ok: false, reason: why }; }
  if (!body.username) return { ok: false, reason: '계정이 필요합니다.' };
  const list = loadPhysical();
  { const ref = loadErr.writeRefusal(WHAT); if (ref) return ref; }   // 95회차 F1
  const id = String(body.id || `pgpu-${crypto.randomBytes(3).toString('hex')}`).trim();
  if (list.find((s) => s.id === id)) return { ok: false, reason: '이미 존재하는 ID입니다.' };
  persist([...list, {
    id, name: String(body.name || host).trim(), host, port: Number(body.port) || 22,
    username: String(body.username).trim(), password: String(body.password || ''),
    os: ['linux', 'windows'].includes(body.os) ? body.os : 'linux',
    vcenterId: String(body.vcenterId || '').trim(), enabled: body.enabled !== false,
    gpuModels: Array.isArray(body.gpuModels) ? body.gpuModels.slice(0, 32) : [],
  }]);
  return { ok: true, id };
}

export function updatePhysical(id, body = {}) {
  const cur = getPhysicalRaw(id);
  { const ref = loadErr.writeRefusal(WHAT); if (ref) return ref; }   // 95회차 F1
  if (!cur) return { ok: false, reason: '서버를 찾을 수 없습니다.' };
  const s = { ...cur };   // 95회차 F1: 사본을 고친다 — 캐시는 쓰기 성공 뒤에만 바뀐다(persist)
  // 38회차 R4(반증 — 재현): 접속처 판정은 **어떤 칸도 바꾸기 전에** — s 는 캐시 객체라, 이름을 먼저 바꾼 뒤 거부하면 400 인데도 이름이 메모리에 남아 다음 저장에 굳었다.
  if (body.host !== undefined) { const h = String(body.host || '').trim(); if (h !== s.host) { const why = physicalHostIssue(h); if (why) return { ok: false, reason: why }; } }
  const before = { host: s.host, port: s.port, username: s.username };   // 접속처 변경 판정용(아래)
  if (body.name !== undefined) s.name = String(body.name || '').trim() || s.host;
  if (body.host !== undefined) s.host = String(body.host || '').trim();   // 판정은 위(36회차 · 38회차 R4 — 바꿀 때만 · 바꾸기 전에)
  if (body.port !== undefined) s.port = Number(body.port) || 22;
  if (body.username !== undefined) s.username = String(body.username || '').trim();
  // 빈 비밀번호 = 기존 유지
  if (body.password !== undefined && body.password !== '') s.password = String(body.password);
  // ⚠ 보안 불변조건(v2.503, 감사 S1 #6) — 접속처(host/port/username)가 바뀌었는데 새 비밀번호를
  // 주지 않았다면 저장 비밀번호를 승계하지 않는다. 이 스토어는 SSH 로 로그인해 nvidia-smi 를
  // 돌리므로, host 만 바꿔 저장하면 다음 수집에서 운영 비밀번호가 공격자 sshd 로 간다.
  // 판정은 공용(`util/secretCarry.js`) — 각자 구현하면 다음 스토어에서 또 빠진다.
  const droppedSecrets = accessMoved(before, body, ['host', 'port', 'username'])
    ? dropCarriedSecrets(s, body, ['password']) : [];
  if (body.os !== undefined && ['linux', 'windows'].includes(body.os)) s.os = body.os;
  if (body.vcenterId !== undefined) s.vcenterId = String(body.vcenterId || '').trim();
  if (body.enabled !== undefined) s.enabled = !!body.enabled;
  if (Array.isArray(body.gpuModels)) s.gpuModels = body.gpuModels.slice(0, 32);
  persist(loadPhysical().map((x) => (x === cur ? s : x)));
  return { ok: true, droppedSecrets };
}

export function removePhysical(id) {
  const list = loadPhysical();
  { const ref = loadErr.writeRefusal(WHAT); if (ref) return ref; }   // 95회차 F1
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return { ok: false, reason: '서버를 찾을 수 없습니다.' };
  persist(next);
  return { ok: true };
}
