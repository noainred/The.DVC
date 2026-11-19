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
 *   v3.24(서버 접속 — 설계 docs/design/server-access §4.6): os('linux'|'windows'|'' — 계층 지정의 OS 종류) · inherit({ key, at, by } — 계층 지정을 물려받아도 된다는
 *   **승인** · 설정 소유자 등급 + 본인 OTP 를 지난 `setBmServerInherit` 만 세운다). 승인은 그때의 주소 · 포트 · OS(`inheritKeyOf`)에 묶인다 — 셋 중 하나라도 바뀌면
 *   어느 쓰기 경로로 바뀌었든 승인이 저절로 효력을 잃는다(`inheritActive` — 저장 비밀을 OTP 없이 새 주소 · 다른 OS 로 보내지 않게). 엣지가 수집하는 서버(agent)는 물려받지 않는다.
 * 설정: { intervalMinutes } — 사용자가 정하는 수집 주기(기본 10분, 1~1440 클램프).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { ssrfBlockReason } from '../collector/registry.js'; // v2.537: 등록 시 SSRF 정적 가드
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { makeLoadError, filterObjectElements } from '../util/registryCore.js'; // v2.613 PERSIST2613-04
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js';
import { sanitizeMounts } from './collect.js';
import { accessMoved } from '../util/secretCarry.js'; // v2.607 LEFT2607-06
import { normalizeBmGroups, groupsOf } from './agg.js';
import { datacenterInputIssue } from './corp.js'; // v2.915: 법인(선택) — 설계 bm-san-compare §4.4
import { bindOfWrite, addrKey } from '../bmusage/onboard/bindRule.js'; // 7b r3(R-N1): 비밀을 주소에 묶는 판정 하나(choke point)

const FILE = path.join(config.configDir, 'bm-storage.json');
const DEFAULT_INTERVAL_MIN = 10;

let cache = null;
// v2.613 PERSIST2613-04: 로드 오류 상태·원소 필터는 util/registryCore.js 하나(다른 등록부 4벌과 같은 판정). 예전에는 원소 null 하나에
//   아래 groups 변형이 던져 **파일 전체를 손상으로 보존하고 목록을 비웠다**(정상 서버까지 소실 — 스크래치 CONFIG_DIR 재현).
const loadErr = makeLoadError();
export function registryLoadError() { load(); return loadErr.get(); }

// 결정(78 남긴 것 ①): parse 실패(형식 · 복호 · 마이그레이션 포함 — 예전 try 블록과 같은 범위)만 손상이다.
const parseDb = (text) => {
  const j = JSON.parse(text);
  const servers = filterObjectElements(openSecretsDeep(Array.isArray(j?.servers) ? j.servers : [])).list; // 객체 원소만 — 변형 루프가 null 에서 던지지 않게
  // v2.340 저장분(단일 group 문자열) → groups 배열 마이그레이션(로드 시 정규화 — 다음 저장에 영속).
  for (const s of servers) { if (!Array.isArray(s.groups)) s.groups = groupsOf(s); delete s.group; }
  return { servers, settings: j?.settings || {} };
};
const WHAT = 'OS 계정 등록부(bm-storage.json)';
function load() {
  if (cache && !loadErr.readPending()) return cache;
  // 손상은 보존본으로 옮기고(사유 포함) 오류를 세운다(loadErr.read). 결정(78 남긴 것 ①): 읽기 오류는 원본을 그대로 두고 · 캐시하지 않고 · 쓰기를 거절한다.
  const r = loadErr.read(FILE, parseDb);
  cache = r.kind === 'ok' ? r.value : null;
  if (!cache) { loadErr.checkCorruptOnly(FILE); cache = { servers: [], settings: {} }; }
  return cache;
}
/** 결정(78 남긴 것 ①): 읽기 오류 중의 쓰기 거절(409) 또는 null — 로드를 먼저 한다(첫 호출이 쓰기여도 상태가 서게). */
export function registryWriteRefusal() { load(); return loadErr.writeRefusal(WHAT); }

function persist() {
  loadErr.assertWritable(WHAT); // 결정(78 남긴 것 ①): 마지막 방어선 — 어느 경로도 읽기 오류 중에 원본을 덮지 않는다(던진다)
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
  const refused = registryWriteRefusal(); if (refused) return refused;   // 결정(78 남긴 것 ①)
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
  const dcErr = datacenterInputIssue(body.datacenterId);   // v2.915: 법인 id(선택 · 64자 · 제어 문자 금지)
  if (dcErr) return dcErr;
  // 7b: 참조 칸은 id 꼴만(존재 판정은 호출부 — 키 저장소를 이 등록부가 import 하지 않는다).
  if (body.keyRef !== undefined && body.keyRef !== '' && !REF_RE.key.test(String(body.keyRef))) return 'SSH 키 참조가 올바르지 않습니다.';
  if (body.credRef !== undefined && body.credRef !== '' && !REF_RE.acc.test(String(body.credRef))) return '공통 계정 참조가 올바르지 않습니다.';
  if (body.collectVia !== undefined && body.collectVia !== '' && !COLLECT_VIA.includes(String(body.collectVia))) return '수집 경로는 edge · central · auto 중 하나입니다.';
  if (body.note !== undefined && String(body.note).length > 500) return '메모는 500자까지입니다.';
  if (body.os !== undefined && body.os !== '' && !SERVER_OS.includes(String(body.os))) return 'OS 는 linux · windows 중 하나입니다.';
  return null;
}

/** v3.24: 서버 OS 종류(계층 지정 단계). 빈 값 = 미지정. */
export const SERVER_OS = Object.freeze(['linux', 'windows']);
/**
 * 계층 지정 승인이 묶이는 값 — 주소 · 포트 · OS · **법인**(판정 하나 — 등록부 · refs · 화면). 계정은 물려받는 쪽이 정하므로 넣지 않는다.
 *   v3.24 반증 F1(재현): 법인이 빠져 있어 승인 뒤 법인 칸만 바꾸면(OTP 없는 서버 저장) **다른 법인의 공통 계정 비밀번호**가 그 서버로 갔다.
 */
export function inheritKeyOf(s = {}) {
  return `${String(s.host ?? '').trim().toLowerCase()}:${Number(s.port) || 22}|${SERVER_OS.includes(s.os) ? s.os : ''}|${String(s.vcenterId ?? '').trim()}`;
}
/** 이 서버가 지금 계층 지정을 물려받아도 되는가 — 승인이 있고, 승인 때의 주소 · 포트 · OS · 법인과 같고, 엣지 위임 서버가 아니다. */
export function inheritActive(s = {}) {
  const ih = s && typeof s.inherit === 'object' && s.inherit ? s.inherit : null;
  return !!ih && typeof ih.key === 'string' && ih.key === inheritKeyOf(s) && !String(s.agent || '').trim();
}
/** 서버가 자기 자격(키 · 공통 계정 · 비밀번호)을 갖고 있는가 — 있으면 ‘따로 정함’ 이고 계층 지정을 보지 않는다. */
export function hasOwnCred(s = {}) {
  return !!(String(s.keyRef || '').trim() || String(s.credRef || '').trim() || (typeof s.password === 'string' && s.password !== ''));
}

/** 7b: 참조 id 꼴(키 저장소 `k_` · 공통 계정 `a_` + 12 hex). */
export const REF_RE = Object.freeze({ key: /^k_[0-9a-f]{12}$/, acc: /^a_[0-9a-f]{12}$/ });
export const COLLECT_VIA = Object.freeze(['edge', 'central', 'auto']);

/** 추가/수정 — id 있으면 수정(빈 비밀번호는 기존 유지), 없으면 신규. 검증은 저장과 단일 소스. */
export function saveBmServer(body = {}) {
  const refused = registryWriteRefusal(); if (refused) return refused;   // 결정(78 남긴 것 ①): 읽지 못한 빈 목록에 넣지 않는다
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
  // 7b r3(재검증 R-N1) — **choke point**: 키 · 공통 계정 참조를 주소에 묶는(새 항목 · 주소 이동 · 다른 참조 · 같은 주소의 인증 방식 변경) 쓰기는
  //   게이트(설정 소유자 등급 + 본인 OTP)를 통과한 호출이 세운 `bindApproved === true` 가 있을 때만 묶는다. 없으면 주소가 바뀐 쓰기는 참조를 버리고,
  //   같은 주소면 기존 참조 · 인증 방식을 그대로 둔다(bindRefused). 판정은 bindRule.bindOfWrite 하나(분석 · bm-storage 라우트와 같은 함수).
  const bind = bindOfWrite(existing, body);
  const bindRefused = bind.binds && body.bindApproved !== true;
  const detach = (f) => body[f] !== undefined && !String(body[f] || '').trim();   // 떼기는 묶음이 아니다 — 거절돼도 뗀다
  const kept = (f) => (bind.moved || detach(f) ? '' : String(existing?.[f] || ''));
  const refOut = bindRefused ? { credRef: kept('credRef'), keyRef: kept('keyRef') } : { credRef: bind.cred, keyRef: bind.key };
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
  // v2.915(설계 §4.4): 법인(DataCenter id · 선택). 미전달이면 기존 유지(무관 편집이 지우지 않게) · 빈 문자열이면 지운다(폼의 '선택 안 함').
  if (body.datacenterId !== undefined) server.datacenterId = String(body.datacenterId || '').trim().slice(0, 64);
  else if (typeof server.datacenterId !== 'string') server.datacenterId = '';
  server.mounts = mounts;
  server.enabled = body.enabled !== false;
  // 빈/마스킹 비밀번호는 기존 유지(편집 시 재입력 강요 안 함) — 신규인데 비었으면 빈 값 저장(무비번 SSH 허용 안 하는 서버는 수집 실패로 표시됨).
  if (body.password !== undefined && body.password !== '' && body.password !== '********') server.password = String(body.password);
  else if (!existing || hostChanged) {                    // 신규 또는 접속처 변경 → 빈 값(재입력 필요)
    if (existing && server.password) droppedSecrets.push('password');
    server.password = '';
  }
  // 7b: 키 · 공통 계정 참조 — 요청이 칸을 주면 그 값(빈 값 = 해제), 안 주면 기존 유지. ⚠ 접속처가 바뀌면 요청이 다시 고르지 않는 한 버린다.
  //   r3: 값은 위 choke point 판정(refOut)이 정한다 — 요청이 떼지 않았는데 사라지는 참조는 droppedSecrets 로 알린다.
  for (const f of ['keyRef', 'credRef']) {
    const v = refOut[f];
    if (v) server[f] = v;
    else if (server[f]) { if (!detach(f)) droppedSecrets.push(f); delete server[f]; }
  }
  if (body.vcenterId !== undefined) { const v = String(body.vcenterId || '').trim().slice(0, 128); if (v) server.vcenterId = v; else delete server.vcenterId; }
  if (body.collectVia !== undefined) {
    const v = COLLECT_VIA.includes(String(body.collectVia)) ? String(body.collectVia) : '';
    if (v && v !== server.collectVia) { if (server.collectVia || existing) server.viaChangedAt = now; server.collectVia = v; }
    else if (!v) delete server.collectVia;
  }
  if (body.note !== undefined) { const v = String(body.note || '').trim().slice(0, 500); if (v) server.note = v; else delete server.note; }
  // 7b: 인증 방식 고정 — 'password' 면 공통 계정에 기본 키가 있어도 비밀번호로(onboard/refs.js resolveOsAuth). 빈 값 = 키 우선(기본).
  if (body.osAuth !== undefined && !(bindRefused && !bind.moved)) { if (body.osAuth === 'password') server.osAuth = 'password'; else delete server.osAuth; }
  if (body.onboardAt !== undefined && Number(body.onboardAt) > 0) server.onboardAt = Number(body.onboardAt);
  // v3.24: OS 종류 — 칸을 주면 그 값(빈 값 = 미지정), 안 주면 기존 유지. 바뀌면 계층 지정 승인은 저절로 효력을 잃는다(inheritActive — 승인 칸은 요청이 세울 수 없다).
  if (body.os !== undefined) { const v = SERVER_OS.includes(String(body.os)) ? String(body.os) : ''; if (v) server.os = v; else delete server.os; }
  // v2.993(OS 주소 제안 — 설계 bm-folders §13 ②): '주소만' 표지 — 새 항목에서 요청이 true 를 줄 때만 세운다(계정 · 비밀번호 없이 주소만 기록).
  //   이 표지가 있는 동안 사용률 수집 색인(bmusage/targets.js indexOsHosts)이 이 항목을 쓰지 않는다(계정 없는 SSH 시도 · 엣지 위임 이탈 방지).
  //   계정이 생기면(비밀번호 · 키 · 공통 계정 참조) 표지를 지운다 — 그때부터 보통 항목. false 를 주면 지운다.
  if (!existing && body.addrOnly === true) server.addrOnly = true;
  else if (body.addrOnly === false) delete server.addrOnly;
  if (server.addrOnly && (server.password || server.keyRef || server.credRef || inheritActive(server))) delete server.addrOnly;
  // v3.24 반증 F5(재현): 자기 자격이 생기면 계층 승인을 지운다 — 남겨 두면 위 단계 지정이 바뀌는 동안(이 서버는 ‘따로 정함’ 이라 확인 대상에서 빠진다)
  //   묻혀 있다가 OTP 없는 ‘떼기’ 한 번으로 새 지정의 비밀번호를 물려받았다. 다시 물려받으려면 소유자 + OTP 승인.
  if (hasOwnCred(server)) delete server.inherit;
  if (!existing) data.servers.push(server);
  return { ok: true, server: redact(server), created: !existing, ...(droppedSecrets.length ? { droppedSecrets } : {}), ...(bindRefused ? { bindRefused: true } : {}) };
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

/**
 * v3.9.0 SSH 공용 접속 — **같은 주소**에서 이 서버가 쓸 키만 바꾼다(키 회전 `replaceBmServerKeyRefs` 와 같은 꼴 — 접속처 불변이라 choke point 를 지나지 않는다).
 *  · keyRef 빈 값 = 서버 키를 떼고 공통 계정의 기본 키(또는 비밀번호)를 따른다. 키를 고르면 '비밀번호 고정'(osAuth) 표지를 지운다(고른 키가 쓰이게).
 *  · `expectAddr` = 화면이 본 접속처(host · port · 계정 — bindRule.addrKey). 다르면 409 — 낡은 화면에서 고른 키를 바뀐 주소에 묶지 않는다(점검 A-8).
 *  · ⚠ 비밀을 주소에 묶는 쓰기다 — 부르는 곳은 `sshaccess/service.js` 하나(설정 소유자 등급 + 본인 OTP 라우트 뒤 · 소스 스윕 테스트가 고정).
 *  · 등록부를 못 읽었으면 쓰지 않는다. 쓰기에 실패하면 메모리도 되돌린다.
 * @returns {{ok:true, previous:{keyRef:string, osAuth:string, addrOnly:boolean, addr:string}} | {ok:false, code:string, status?:number, reason:string}}
 */
export function setBmServerKeyRef(id, keyRef, { expectAddr = null } = {}) {
  const data = load();
  if (loadErr.get()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'OS 계정 등록부를 읽지 못해 키를 바꾸지 않았습니다.' };
  const s = data.servers.find((x) => x.id === String(id || ''));
  if (!s) return { ok: false, code: 'not-found', status: 404, reason: '서버를 찾을 수 없습니다.' };
  const addr = addrKey(s.host, s.port, s.username);
  if (expectAddr != null && addr !== String(expectAddr)) return { ok: false, code: 'moved', status: 409, reason: '서버 주소 · 포트 · 계정이 바뀌었습니다 — 화면을 다시 읽으세요.' };
  const k = String(keyRef || '').trim();
  if (k && !REF_RE.key.test(k)) return { ok: false, code: 'bad-ref', reason: 'SSH 키 참조가 올바르지 않습니다.' };
  const previous = { keyRef: String(s.keyRef || ''), osAuth: s.osAuth === 'password' ? 'password' : '', addrOnly: s.addrOnly === true, addr, inherit: s.inherit ? { ...s.inherit } : null };
  const had = { keyRef: s.keyRef, osAuth: s.osAuth, addrOnly: s.addrOnly, inherit: s.inherit };
  if (k) s.keyRef = k; else delete s.keyRef;
  delete s.osAuth;
  if (s.addrOnly && (s.password || s.keyRef || s.credRef)) delete s.addrOnly;
  if (hasOwnCred(s)) delete s.inherit;   // v3.24 반증 F5: 자기 자격이 생기면 계층 승인을 지운다(되돌리기는 previous.inherit)
  try { persist(); } catch (e) {
    for (const f of ['keyRef', 'osAuth', 'addrOnly', 'inherit']) { if (had[f] === undefined) delete s[f]; else s[f] = had[f]; }
    return { ok: false, code: e?.code === 'SECRETS_POLICY_UNAVAILABLE' ? 'SECRETS_POLICY_UNAVAILABLE' : 'write-failed', status: 503, reason: `OS 계정 등록부를 쓰지 못했습니다(${String(e?.code || e?.message || e).slice(0, 60)}).` };
  }
  return { ok: true, previous };
}
/**
 * 되돌리기 — setBmServerKeyRef 가 돌려준 previous 그대로(키 · 비밀번호 고정 · 주소만 표지).
 * ⚠ 그 사이 접속처가 바뀌었으면(다른 관리자가 주소를 고침 — 등록부가 참조를 이미 버렸다) **되돌리지 않는다** — 옛 키를 새 주소에 다시 묶는 길이 된다(점검 A-1 · C-4).
 */
export function restoreBmServerKeyRef(id, previous = {}) {
  const data = load();
  if (loadErr.get()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'OS 계정 등록부를 읽지 못해 되돌리지 못했습니다.' };
  const s = data.servers.find((x) => x.id === String(id || ''));
  if (!s) return { ok: false, code: 'not-found', status: 404, reason: '서버가 그 사이 지워졌습니다.' };
  if (addrKey(s.host, s.port, s.username) !== String(previous.addr || '')) return { ok: false, code: 'moved', status: 409, reason: '그 사이 서버 주소 · 포트 · 계정이 바뀌어 되돌리지 않았습니다(옛 키를 새 주소에 묶지 않음) — 서버 설정을 확인하세요.' };
  const had = { keyRef: s.keyRef, osAuth: s.osAuth, addrOnly: s.addrOnly, inherit: s.inherit };
  if (previous.keyRef) s.keyRef = previous.keyRef; else delete s.keyRef;
  if (previous.osAuth === 'password') s.osAuth = 'password'; else delete s.osAuth;
  if (previous.addrOnly) s.addrOnly = true; else delete s.addrOnly;
  if (previous.inherit) s.inherit = { ...previous.inherit };   // 그 사이 OS · 법인이 바뀌었으면 승인 키가 달라 저절로 효력이 없다(inheritActive)
  try { persist(); } catch (e) {
    for (const f of ['keyRef', 'osAuth', 'addrOnly', 'inherit']) { if (had[f] === undefined) delete s[f]; else s[f] = had[f]; }
    return { ok: false, code: 'write-failed', status: 503, reason: `되돌리지 못했습니다(${String(e?.code || e?.message || e).slice(0, 60)}).` };
  }
  return { ok: true };
}

/**
 * v3.24 계층 지정 — 이 서버가 법인 › OS 종류의 지정을 물려받도록 **승인**(on) · 승인 거두기(off).
 *  · ⚠ 저장 비밀(공통 계정)을 주소에 묶는 쓰기다 — 부르는 곳은 `sshaccess/service.js` 하나(설정 소유자 등급 + 본인 OTP 라우트 뒤 · 소스 스윕).
 *  · `expectAddr` = 화면이 본 접속처(bindRule.addrKey) — 다르면 409(낡은 화면의 승인을 바뀐 주소에 묶지 않게 — setBmServerKeyRef 와 같은 규칙).
 *  · clearOwn: ‘물려받기로 되돌리기’ — 서버 자기 자격 참조(키 · 공통 계정 · 비밀번호 고정)를 떼고 승인한다. 서버 비밀번호도 지운다(남아 있으면 ‘따로 정함’ 으로 남는다).
 *  · 엣지가 수집하는 서버는 물려받지 않는다(그 엣지가 자기 계정 · 키로 접속한다).
 * @returns {{ok:true, previous:object} | {ok:false, code:string, status?:number, reason:string}}  previous 는 비밀을 담지 않는다(되돌리기는 메모리의 previousSecret 로)
 */
export function setBmServerInherit(id, { on = true, clearOwn = false, expectAddr = null, expectKey = null, by = '', now = Date.now() } = {}) {
  const data = load();
  if (loadErr.get()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'OS 계정 등록부를 읽지 못해 바꾸지 않았습니다.' };
  const s = data.servers.find((x) => x.id === String(id || ''));
  if (!s) return { ok: false, code: 'not-found', status: 404, reason: '서버를 찾을 수 없습니다.' };
  if (String(s.agent || '').trim()) return { ok: false, code: 'edge-delegated', status: 409, reason: '엣지가 수집하는 서버입니다 — 계정은 그 엣지 포탈에서 정합니다(비밀은 법인 밖으로 나가지 않습니다).' };
  const addr = addrKey(s.host, s.port, s.username);
  if (expectAddr != null && addr !== String(expectAddr)) return { ok: false, code: 'moved', status: 409, reason: '서버 주소 · 포트 · 계정이 바뀌었습니다 — 화면을 다시 읽으세요.' };
  // v3.24 반증 F8: 승인은 화면이 본 승인 키(주소 · 포트 · OS · 법인)와 같을 때만 — 본 뒤 OS · 법인이 바뀌면 소유자가 본 것과 다른 단계를 승인하게 된다.
  if (on && expectKey != null && inheritKeyOf(s) !== String(expectKey)) return { ok: false, code: 'moved', status: 409, reason: '서버의 OS 종류 · 법인이 바뀌었습니다 — 화면을 다시 읽으세요.' };
  const FIELDS = ['inherit', 'keyRef', 'credRef', 'osAuth', 'addrOnly', 'password'];
  const had = Object.fromEntries(FIELDS.map((f) => [f, s[f] === undefined ? undefined : structuredClone(s[f])]));
  if (on) {
    if (!clearOwn && hasOwnCred(s)) return { ok: false, code: 'has-own', status: 409, reason: '이 서버는 따로 정한 계정이 있습니다 — ‘물려받기로 되돌리기’ 로 그 계정을 떼면서 승인하세요.' };
    if (clearOwn) { delete s.keyRef; delete s.credRef; delete s.osAuth; s.password = ''; }
    s.inherit = { key: inheritKeyOf(s), at: now, by: String(by || '').slice(0, 64) };
    delete s.addrOnly;
  } else {
    delete s.inherit;
  }
  try { persist(); } catch (e) {
    for (const f of FIELDS) { if (had[f] === undefined) delete s[f]; else s[f] = had[f]; }
    return { ok: false, code: e?.code === 'SECRETS_POLICY_UNAVAILABLE' ? 'SECRETS_POLICY_UNAVAILABLE' : 'write-failed', status: 503, reason: `OS 계정 등록부를 쓰지 못했습니다(${String(e?.code || e?.message || e).slice(0, 60)}).` };
  }
  return { ok: true, previous: { addr, inherit: had.inherit ? { ...had.inherit } : null, keyRef: had.keyRef || '', credRef: had.credRef || '', osAuth: had.osAuth || '', addrOnly: had.addrOnly === true, hadPassword: !!had.password } };
}

/**
 * v3.24 ‘따로 정하기 — 다른 공통 계정’: **같은 주소**에서 이 서버가 쓸 공통 계정만 바꾼다(키 고르기 `setBmServerKeyRef` 와 같은 꼴).
 *   서버에 고정한 키 · 비밀번호 고정 · 계층 승인은 뗀다(고른 계정이 그대로 쓰이게). 서버 비밀번호는 건드리지 않는다(공통 계정이 비밀을 가진다 — saveAccount 가 강제).
 *  · ⚠ 비밀을 주소에 묶는 쓰기 — 부르는 곳은 sshaccess/service.js 하나(설정 소유자 등급 + OTP 라우트 뒤). 접속 확인에 실패하면 서비스가 restoreBmServerCredRef 로 되돌린다.
 */
export function setBmServerCredRef(id, credRef, { expectAddr = null } = {}) {
  const data = load();
  if (loadErr.get()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'OS 계정 등록부를 읽지 못해 바꾸지 않았습니다.' };
  const s = data.servers.find((x) => x.id === String(id || ''));
  if (!s) return { ok: false, code: 'not-found', status: 404, reason: '서버를 찾을 수 없습니다.' };
  if (String(s.agent || '').trim()) return { ok: false, code: 'edge-delegated', status: 409, reason: '엣지가 수집하는 서버입니다 — 계정은 그 엣지 포탈에서 정합니다.' };
  const addr = addrKey(s.host, s.port, s.username);
  if (expectAddr != null && addr !== String(expectAddr)) return { ok: false, code: 'moved', status: 409, reason: '서버 주소 · 포트 · 계정이 바뀌었습니다 — 화면을 다시 읽으세요.' };
  const c = String(credRef || '').trim();
  if (!REF_RE.acc.test(c)) return { ok: false, code: 'bad-ref', reason: '공통 계정 참조가 올바르지 않습니다.' };
  const FIELDS = ['credRef', 'keyRef', 'osAuth', 'inherit', 'addrOnly'];
  const had = Object.fromEntries(FIELDS.map((f) => [f, s[f] === undefined ? undefined : structuredClone(s[f])]));
  s.credRef = c; delete s.keyRef; delete s.osAuth; delete s.inherit; delete s.addrOnly;
  try { persist(); } catch (e) {
    for (const f of FIELDS) { if (had[f] === undefined) delete s[f]; else s[f] = had[f]; }
    return { ok: false, code: 'write-failed', status: 503, reason: `OS 계정 등록부를 쓰지 못했습니다(${String(e?.code || e?.message || e).slice(0, 60)}).` };
  }
  return { ok: true, previous: { addr, credRef: had.credRef || '', keyRef: had.keyRef || '', osAuth: had.osAuth || '', inherit: had.inherit ? { ...had.inherit } : null, addrOnly: had.addrOnly === true } };
}
/** 되돌리기(setBmServerCredRef · setBmServerInherit 의 previous). 그 사이 접속처가 바뀌었으면 되돌리지 않는다(restoreBmServerKeyRef 와 같은 규칙). */
export function restoreBmServerAccess(id, previous = {}) {
  const data = load();
  if (loadErr.get()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'OS 계정 등록부를 읽지 못해 되돌리지 못했습니다.' };
  const s = data.servers.find((x) => x.id === String(id || ''));
  if (!s) return { ok: false, code: 'not-found', status: 404, reason: '서버가 그 사이 지워졌습니다.' };
  if (addrKey(s.host, s.port, s.username) !== String(previous.addr || '')) return { ok: false, code: 'moved', status: 409, reason: '그 사이 서버 주소 · 포트 · 계정이 바뀌어 되돌리지 않았습니다 — 서버 설정을 확인하세요.' };
  const FIELDS = ['credRef', 'keyRef', 'osAuth', 'inherit', 'addrOnly'];
  const had = Object.fromEntries(FIELDS.map((f) => [f, s[f] === undefined ? undefined : structuredClone(s[f])]));
  for (const f of ['credRef', 'keyRef', 'osAuth']) { if (previous[f]) s[f] = previous[f]; else delete s[f]; }
  if (previous.inherit) s.inherit = { ...previous.inherit }; else delete s.inherit;
  if (previous.addrOnly) s.addrOnly = true; else delete s.addrOnly;
  try { persist(); } catch (e) {
    for (const f of FIELDS) { if (had[f] === undefined) delete s[f]; else s[f] = had[f]; }
    return { ok: false, code: 'write-failed', status: 503, reason: `되돌리지 못했습니다(${String(e?.code || e?.message || e).slice(0, 60)}).` };
  }
  return { ok: true };
}

/** v3.24 OS 종류 쓰기(같은 주소 — OS 만). OS 가 바뀌면 계층 승인은 저절로 효력을 잃는다(inheritActive). */
export function setBmServerOs(id, os) {
  const data = load();
  if (loadErr.get()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'OS 계정 등록부를 읽지 못해 바꾸지 않았습니다.' };
  const s = data.servers.find((x) => x.id === String(id || ''));
  if (!s) return { ok: false, code: 'not-found', status: 404, reason: '서버를 찾을 수 없습니다.' };
  const v = String(os || '');
  if (v && !SERVER_OS.includes(v)) return { ok: false, code: 'bad-os', reason: 'OS 는 linux · windows 중 하나입니다.' };
  const had = s.os;
  if (v) s.os = v; else delete s.os;
  if (had === s.os) return { ok: true, changed: false };
  try { persist(); } catch (e) {
    if (had === undefined) delete s.os; else s.os = had;
    return { ok: false, code: 'write-failed', status: 503, reason: `OS 계정 등록부를 쓰지 못했습니다(${String(e?.code || e?.message || e).slice(0, 60)}).` };
  }
  return { ok: true, changed: true };
}

/** v3.24 OS 종류 여러 대(제안 일괄 적용) — 한 번 쓰기. map: id → 'linux' | 'windows'. 모르는 id · 값은 건너뛴다. */
export function setBmServersOs(map = {}) {
  const data = load();
  if (loadErr.get()) return { ok: false, code: 'registry-unreadable', status: 503, reason: 'OS 계정 등록부를 읽지 못해 바꾸지 않았습니다.' };
  const had = new Map();
  for (const s of data.servers) {
    const v = Object.hasOwn(map, s.id) ? String(map[s.id] || '') : null;
    if (v == null || !SERVER_OS.includes(v) || s.os === v) continue;
    had.set(s.id, s.os); s.os = v;
  }
  if (!had.size) return { ok: true, changed: 0 };
  try { persist(); } catch (e) {
    for (const s of data.servers) if (had.has(s.id)) { const h = had.get(s.id); if (h === undefined) delete s.os; else s.os = h; }
    return { ok: false, code: 'write-failed', status: 503, reason: `OS 계정 등록부를 쓰지 못했습니다(${String(e?.code || e?.message || e).slice(0, 60)}).` };
  }
  return { ok: true, changed: had.size };
}

export function removeBmServer(id) {
  const refused = registryWriteRefusal(); if (refused) return refused;   // 결정(78 남긴 것 ①): '서버를 찾을 수 없습니다' 보다 먼저
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
      datacenterId: String(b.datacenterId || '').trim().slice(0, 64),   // v2.915: 데모 법인(데모 vCenter 의 DataCenter)
      enabled: b.enabled !== false, password: String(b.password || ''),
    });
  }
  if (data.servers.length) persist();
  return { seeded: data.servers.length, skipped };
}
