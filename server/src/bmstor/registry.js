/**
 * bmstor/registry.js — 베어메탈 스토리지 서버 목록 + 설정(v2.340).
 * CONFIG_DIR/bm-storage.json (0600, 원자적 쓰기, 손상 보존, v2.296 비밀 봉인) —
 * 수집 서버/배포 대상 레지스트리와 동일 계약.
 *
 * 서버: { id, name, host, port, username, password, agent(엣지 이름 — 빈 값=중앙 직접),
 *         groups(합산 그룹 배열 — 최대 3개, v2.344), mounts:[절대경로...], enabled,
 *         keyRef(SSH 키 저장소 키 id — 7b) · credRef(법인 공통 계정 id — 7b) · vcenterId(법인 — 7b 온보딩) ·
 *         collectVia('edge'|'central'|'auto' — 7b 온보딩이 기록 · 경계 판정은 agent 그대로) · viaChangedAt · note · onboardAt }
 *   ⚠ 7b: keyRef · credRef 는 **비밀 참조**다 — 접속처(host · port · 계정)가 바뀌면 요청이 다시 고르지 않는 한 승계하지 않는다(secretCarry 와 같은 판정).
 * 설정: { intervalMinutes } — 사용자가 정하는 수집 주기(기본 10분, 1~1440 클램프).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { ssrfBlockReason } from '../collector/registry.js'; // v2.537: 등록 시 SSRF 정적 가드
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeLoadError, filterObjectElements } from '../util/registryCore.js'; // v2.613 PERSIST2613-04
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js';
import { sanitizeMounts } from './collect.js';
import { accessMoved } from '../util/secretCarry.js'; // v2.607 LEFT2607-06
import { normalizeBmGroups, groupsOf } from './agg.js';

const FILE = path.join(config.configDir, 'bm-storage.json');
const DEFAULT_INTERVAL_MIN = 10;

let cache = null;
// v2.613 PERSIST2613-04: 로드 오류 상태·원소 필터는 util/registryCore.js 하나(다른 등록부 4벌과 같은 판정). 예전에는 원소 null 하나에
//   아래 groups 변형이 던져 **파일 전체를 손상으로 보존하고 목록을 비웠다**(정상 서버까지 소실 — 스크래치 CONFIG_DIR 재현).
const loadErr = makeLoadError();
export function registryLoadError() { load(); return loadErr.get(); }

function load() {
  if (cache) return cache;
  try {
    if (fs.existsSync(FILE)) {
      const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      const servers = filterObjectElements(openSecretsDeep(Array.isArray(j?.servers) ? j.servers : [])).list; // 객체 원소만 — 변형 루프가 null 에서 던지지 않게
      // v2.340 저장분(단일 group 문자열) → groups 배열 마이그레이션(로드 시 정규화 — 다음 저장에 영속).
      for (const s of servers) { if (!Array.isArray(s.groups)) s.groups = groupsOf(s); delete s.group; }
      cache = { servers, settings: j?.settings || {} };
    }
  } catch (e) { preserveCorrupt(FILE, e?.message); loadErr.set(e); cache = null; }
  if (!cache) { loadErr.checkCorruptOnly(FILE); cache = { servers: [], settings: {} }; }
  return cache;
}

function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep({ servers: cache.servers, settings: cache.settings }), null, 2), { mode: 0o600 });
  loadErr.clear(); // v2.612 LEFT2612-01 과 같은 규칙
}

const redact = ({ password, ...rest }) => ({ ...rest, hasPassword: Boolean(password) });

export function listBmServers() { return load().servers.map(redact); }
/** 폴러 전용 원본(비밀 포함, 클론) — API 응답에 절대 그대로 내보내지 말 것. */
export function listBmServersRaw() { return structuredClone(load().servers); }

export function getBmSettings() {
  const s = load().settings || {};
  const iv = Number(s.intervalMinutes);
  return { intervalMinutes: Number.isFinite(iv) && iv >= 1 ? Math.min(1440, Math.round(iv)) : DEFAULT_INTERVAL_MIN };
}

export function saveBmSettings(body = {}) {
  const iv = Number(body.intervalMinutes);
  if (!Number.isFinite(iv) || iv < 1 || iv > 1440) return { ok: false, reason: '수집 주기는 1~1440분 사이여야 합니다.' };
  const data = load();
  data.settings = { ...data.settings, intervalMinutes: Math.round(iv) };
  persist();
  return { ok: true, settings: getBmSettings() };
}

/**
 * 저장과 동일 규칙의 입력 검증(단일 소스) — CSV 드라이런(v2.341)도 이 함수를 쓴다.
 * 통과 시 null, 실패 시 사유 문자열. (정규화 값은 saveBmServer 가 다시 계산 — 검증은 순수하게)
 */
export function bmServerInputIssue(body = {}) {
  const host = String(body.host || '').trim();
  if (!host) return 'host는 필수입니다.';
  if (host.length > 253 || /[\s'"`;|&<>$\\]/.test(host)) return 'host에 사용할 수 없는 문자가 있습니다.';
  // v2.537: SSH 대상도 루프백·링크로컬은 거부한다(storage/registry.js 와 같은 방식 — URL 파서 재사용).
  { const ssrf = ssrfBlockReason(`https://${host}`); if (ssrf) return `host 거부: ${ssrf}`; }
  const port = body.port === undefined || body.port === '' ? 22 : Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'SSH 포트가 올바르지 않습니다.';
  const username = String(body.username ?? 'root').trim() || 'root';
  if (/[\s'"`;|&<>$\\]/.test(username)) return '계정에 사용할 수 없는 문자가 있습니다.';
  const { mounts, errors } = sanitizeMounts(body.mounts);
  if (errors.length) return errors[0];
  if (!mounts.length) return '측정할 마운트 포인트를 1개 이상 입력하세요(예: / 또는 /data).';
  if (mounts.length > 64) return '마운트 포인트는 서버당 최대 64개입니다.';
  // 멀티 그룹(v2.344): 최대 3개 — 배열/문자열(쉼표·세미콜론 구분) 모두 허용, 구형 group 하위호환.
  const { error: gErr } = normalizeBmGroups(body.groups !== undefined ? body.groups : body.group);
  if (gErr) return gErr;
  // 7b: 참조 칸은 id 꼴만(존재 판정은 호출부 — 키 저장소를 이 등록부가 import 하지 않는다).
  if (body.keyRef !== undefined && body.keyRef !== '' && !REF_RE.key.test(String(body.keyRef))) return 'SSH 키 참조가 올바르지 않습니다.';
  if (body.credRef !== undefined && body.credRef !== '' && !REF_RE.acc.test(String(body.credRef))) return '공통 계정 참조가 올바르지 않습니다.';
  if (body.collectVia !== undefined && body.collectVia !== '' && !COLLECT_VIA.includes(String(body.collectVia))) return '수집 경로는 edge · central · auto 중 하나입니다.';
  if (body.note !== undefined && String(body.note).length > 500) return '메모는 500자까지입니다.';
  return null;
}

/** 7b: 참조 id 꼴(키 저장소 `k_` · 공통 계정 `a_` + 12 hex). */
export const REF_RE = Object.freeze({ key: /^k_[0-9a-f]{12}$/, acc: /^a_[0-9a-f]{12}$/ });
export const COLLECT_VIA = Object.freeze(['edge', 'central', 'auto']);

/** 추가/수정 — id 있으면 수정(빈 비밀번호는 기존 유지), 없으면 신규. 검증은 저장과 단일 소스. */
export function saveBmServer(body = {}) {
  const data = load();
  const r = applyServerInput(data, body, { now: Date.now() });
  if (!r.ok) return r;
  persist();
  return r;
}

/** 등록 상한(대). 7b 온보딩 일괄 적용도 같은 상한. */
export const MAX_BM_SERVERS = 1000;

/**
 * 한 행을 메모리의 data 에 반영한다(쓰지 않는다 — saveBmServer · applyBmServerBatch 가 한 번 persist). 검증은 bmServerInputIssue 하나.
 * @returns {{ok:true, server:object, created:boolean, droppedSecrets?:string[]} | {ok:false, reason:string}}
 */
function applyServerInput(data, body = {}, { now = Date.now() } = {}) {
  const issue = bmServerInputIssue(body);
  if (issue) return { ok: false, reason: issue };
  const host = String(body.host || '').trim();
  const port = body.port === undefined || body.port === '' ? 22 : Number(body.port);
  const username = String(body.username ?? 'root').trim() || 'root';
  const { mounts } = sanitizeMounts(body.mounts);

  const existing = body.id ? data.servers.find((s) => s.id === body.id) : null;
  if (!existing && data.servers.length >= MAX_BM_SERVERS) return { ok: false, reason: '서버는 최대 1,000대까지 등록할 수 있습니다.' };
  const server = existing || { id: crypto.randomBytes(5).toString('hex') };
  const droppedSecrets = [];
  // v2.479(감사 S-2): host 변경 시 비밀번호 이월 금지. v2.607(감사 LEFT2607-06): host 만 보던 것을 공용 판정
  //   (host·port·username)으로 — 계정·포트를 바꿔도 옛 비밀번호가 새 계정으로 시도됐다. agent 변경은 승계한다(위임 수집에 필요).
  const hostChanged = !!existing && accessMoved(
    { host: existing.host, port: Number(existing.port) || 22, username: existing.username || 'root' },
    { host, port, username }, ['host', 'port', 'username']);
  server.host = host;
  server.port = port;
  server.username = username;
  server.name = String(body.name || '').trim() || host;
  server.agent = String(body.agent || '').trim();
  // 위임 전달 방식(v2.341): poll(에이전트 폴링 — NAT 뒤 엣지 표준, iDRAC/IP스캔과 동일) | push(중앙→엣지 직접).
  server.dispatch = body.dispatch === 'push' ? 'push' : 'poll';
  // 멀티 그룹(v2.344): groups 배열이 진실의 원천(최대 3개 — bmServerInputIssue 가 선검증).
  // 구형 클라이언트가 group(단일 문자열)만 보내도 수용. 미전달이면 기존 그룹 유지(무관 편집이
  // 그룹을 지우지 않게). 저장은 groups 만 쓰고 legacy group 필드는 제거(v2.340 저장분 마이그레이션).
  if (body.groups !== undefined || body.group !== undefined) {
    server.groups = normalizeBmGroups(body.groups !== undefined ? body.groups : body.group).groups;
  } else if (!Array.isArray(server.groups)) {
    server.groups = groupsOf(server);
  }
  delete server.group;
  server.mounts = mounts;
  server.enabled = body.enabled !== false;
  // 빈/마스킹 비밀번호는 기존 유지(편집 시 재입력 강요 안 함) — 신규인데 비었으면 빈 값 저장(무비번 SSH 허용 안 하는 서버는 수집 실패로 표시됨).
  if (body.password !== undefined && body.password !== '' && body.password !== '********') server.password = String(body.password);
  else if (!existing || hostChanged) {                    // 신규 또는 접속처 변경 → 빈 값(재입력 필요)
    if (existing && server.password) droppedSecrets.push('password');
    server.password = '';
  }
  // 7b: 키 · 공통 계정 참조 — 요청이 칸을 주면 그 값(빈 값 = 해제), 안 주면 기존 유지. ⚠ 접속처가 바뀌면 요청이 다시 고르지 않는 한 버린다.
  for (const f of ['keyRef', 'credRef']) {
    if (body[f] !== undefined) { const v = String(body[f] || '').trim(); if (v) server[f] = v; else delete server[f]; }
    else if (hostChanged && server[f]) { droppedSecrets.push(f); delete server[f]; }
  }
  if (body.vcenterId !== undefined) { const v = String(body.vcenterId || '').trim().slice(0, 128); if (v) server.vcenterId = v; else delete server.vcenterId; }
  if (body.collectVia !== undefined) {
    const v = COLLECT_VIA.includes(String(body.collectVia)) ? String(body.collectVia) : '';
    if (v && v !== server.collectVia) { if (server.collectVia || existing) server.viaChangedAt = now; server.collectVia = v; }
    else if (!v) delete server.collectVia;
  }
  if (body.note !== undefined) { const v = String(body.note || '').trim().slice(0, 500); if (v) server.note = v; else delete server.note; }
  // 7b: 인증 방식 고정 — 'password' 면 공통 계정에 기본 키가 있어도 비밀번호로(onboard/refs.js resolveOsAuth). 빈 값 = 키 우선(기본).
  if (body.osAuth !== undefined) { if (body.osAuth === 'password') server.osAuth = 'password'; else delete server.osAuth; }
  if (body.onboardAt !== undefined && Number(body.onboardAt) > 0) server.onboardAt = Number(body.onboardAt);
  if (!existing) data.servers.push(server);
  return { ok: true, server: redact(server), created: !existing, ...(droppedSecrets.length ? { droppedSecrets } : {}) };
}

/**
 * 7b 온보딩 일괄 적용 — 행마다 applyServerInput 후 **한 번** 원자적으로 쓴다(1,000행이 1,000번 쓰지 않게).
 * 등록부를 못 읽었으면 쓰지 않는다(registry-unreadable — 빈 목록으로 덮어 보존본의 서버를 잃지 않게). 한 행이라도 실패하면 **아무것도 쓰지 않는다**(전부 또는 없음).
 * @param {object[]} inputs  saveBmServer 와 같은 본문(id 있으면 갱신)
 * @returns {{ok:true, results:object[]} | {ok:false, reason:string, code?:string, index?:number}}
 */
export function applyBmServerBatch(inputs = [], { now = Date.now(), removeIds = [] } = {}) {
  const data = load();
  if (loadErr.get()) return { ok: false, code: 'registry-unreadable', reason: 'OS 계정 등록부(bm-storage.json)를 읽지 못해 적용하지 않았습니다.' };
  const before = structuredClone(data.servers);
  const results = [];
  // 7b: 경로 변경(중앙 → 엣지)으로 이 노드에서 빼는 항목 — 같은 한 번 쓰기 안에서.
  const drop = new Set((Array.isArray(removeIds) ? removeIds : []).map((x) => String(x)));
  const removed = drop.size ? data.servers.filter((x) => drop.has(String(x.id))).map((x) => x.id) : [];
  if (drop.size) data.servers = data.servers.filter((x) => !drop.has(String(x.id)));
  for (let i = 0; i < inputs.length; i += 1) {
    const r = applyServerInput(data, inputs[i] || {}, { now });
    if (!r.ok) { data.servers = before; return { ok: false, reason: r.reason, index: i }; }
    results.push(r);
  }
  try { persist(); } catch (e) { data.servers = before; throw e; }
  return { ok: true, results, removed };
}

/** 7b: 키 · 공통 계정 참조 수(사용처) — 원본에서 센다. */
export function bmServerRefCounts() {
  const byKey = new Map(); const byAcc = new Map();
  for (const s of load().servers) {
    if (s.keyRef) byKey.set(s.keyRef, (byKey.get(s.keyRef) || 0) + 1);
    if (s.credRef) byAcc.set(s.credRef, (byAcc.get(s.credRef) || 0) + 1);
  }
  return { byKey, byAcc };
}

/** 7b 키 회전: 서버의 keyRef 를 from → to 로(한 번 쓰기). 바꾼 서버 id 목록. 등록부를 못 읽었으면 쓰지 않는다. */
export function replaceBmServerKeyRefs(fromId, toId) {
  const data = load();
  if (loadErr.get()) return { ok: false, code: 'registry-unreadable', reason: 'OS 계정 등록부를 읽지 못해 키 참조를 바꾸지 않았습니다.' };
  const ids = [];
  for (const s of data.servers) if (s.keyRef === fromId) { s.keyRef = toId; ids.push(s.id); }
  if (ids.length) persist();
  return { ok: true, ids };
}

export function removeBmServer(id) {
  const data = load();
  const next = data.servers.filter((s) => s.id !== id);
  if (next.length === data.servers.length) return { ok: false, reason: '서버를 찾을 수 없습니다.' };
  data.servers = next;
  persist();
  return { ok: true };
}

/**
 * v2.708 데모(mock) 시드 전용 — 서버 목록이 **비어 있을 때만** 넣는다(id 는 호출부가 `mock-` 접두).
 * 검증은 bmServerInputIssue 단일 소스. 손상 보존 상태면 시드하지 않는다.
 * @returns {{seeded:number, skipped:number, reason?:string}}
 */
export function seedBmServersIfEmpty(list) {
  const data = load();
  if (loadErr.get()) return { seeded: 0, skipped: 0, reason: 'registry-unreadable' };
  if (data.servers.length) return { seeded: 0, skipped: 0, reason: 'not-empty' };
  let skipped = 0;
  for (const b of Array.isArray(list) ? list : []) {
    if (!b || typeof b !== 'object' || !String(b.id || '').startsWith('mock-') || bmServerInputIssue(b)) { skipped += 1; continue; }
    data.servers.push({
      id: String(b.id), host: String(b.host).trim(), port: 22, username: String(b.username || 'root'),
      name: String(b.name || b.host), agent: '', dispatch: 'poll',
      groups: normalizeBmGroups(b.groups).groups, mounts: sanitizeMounts(b.mounts).mounts,
      enabled: b.enabled !== false, password: String(b.password || ''),
    });
  }
  if (data.servers.length) persist();
  return { seeded: data.servers.length, skipped };
}
