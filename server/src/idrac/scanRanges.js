/**
 * 법인(DataCenter)별 iDRAC 스캔 대역 저장소 — 각 법인에 귀속된 iDRAC IP 대역과 그 대역 스캔에
 * 쓸 iDRAC 계정/비밀번호를 저장한다. 주기 스캐너(scanPoller)가 이 대역을 돌며 Dell iDRAC을
 * 자동 발견·등록(해당 법인으로 귀속 = '법인 DB')한다. iDRAC은 인증이 필요하므로 대역별
 * 계정/비밀번호를 함께 보관한다.
 *
 * ★ 한 법인에 서비스가 여러 개 존재하고 서비스별로 에이전트가 다를 수 있다. 따라서 저장 단위는
 *   '법인'이 아니라 '엔트리(id)'이며, 한 법인(datacenterId) 아래 여러 엔트리(서비스별 대역·계정·
 *   에이전트)를 둘 수 있다.
 *
 * 저장: CONFIG_DIR/idrac-scan-ranges.json (0600, 비밀번호 평문 — idrac.json과 동일 관례)
 *   { entries: { [id]: { datacenterId, service, ranges:string[], username, password, agent, enabled, mode, updatedAt, lastRun } } }
 *   - id     : 엔트리 고유키(UUID). 구버전 마이그레이션 시에는 datacenterId를 그대로 id로 승계.
 *   - service: 서비스명(라벨). 한 법인 내 여러 엔트리를 구분(빈 값 허용).
 *   - agent  : '' 또는 '__local__' = 중앙 포탈이 직접 스캔. 그 외 = 해당 에이전트에 위임.
 *   - mode   : 등록 모드(merge 기본).
 *   - ilo    : (v2.610, 선택) HPE iLO 계정 { username, password }. 있으면 같은 대역 스캔이 Dell iDRAC 과 HPE iLO 를
 *              **한 번에** 찾는다 — 서비스 루트(무인증)로 벤더를 가른 뒤 그 벤더 계정으로만 로그인한다. password 는
 *              secretVault 가 필드 이름(password)으로 봉인한다(중첩 객체도 대상). 없으면 예전과 같다.
 *   - (구버전 호환) 과거 법인별 저장(`{ datacenters: {[dcId]: e} }`)·vCenter별 저장(`{ vcenters: {...} }`)도 읽어들인다.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // 자격증명 저장 방식(평문/암호화, v2.296) — 로드 시 복호·저장 시 봉인
import { accessMoved, dropCarriedSecrets } from '../util/secretCarry.js'; // v2.606 LEFT2606-02: 대역·엣지·계정이 바뀌면 저장 비밀번호 폐기

const FILE = path.join(config.configDir, 'idrac-scan-ranges.json');

let cache = null;
let cacheMtime = -1;

// 구버전(법인/‌vCenter 키) 저장을 엔트리(id) 저장으로 승계. id는 기존 키(datacenterId)를 그대로 써
// 안정적으로 유지한다(기존 lastRun/설정 보존).
function migrateLegacyMap(map) {
  const entries = {};
  for (const [dcId, e] of Object.entries(map || {})) {
    if (!e || typeof e !== 'object') continue;
    entries[dcId] = {
      datacenterId: dcId,
      service: String(e.service || '').trim(),
      ranges: Array.isArray(e.ranges) ? e.ranges : [],
      username: e.username || '',
      password: e.password || '',
      agent: e.agent || '',
      enabled: e.enabled !== false,
      mode: e.mode || 'merge',
      updatedAt: e.updatedAt || null,
      lastRun: e.lastRun || null,
    };
  }
  return entries;
}

function read() {
  let mtime = -1;
  try { mtime = fs.statSync(FILE).mtimeMs; } catch { mtime = 0; }
  if (cache && mtime === cacheMtime) return cache;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    let entries;
    if (j && typeof j.entries === 'object' && j.entries) entries = j.entries; // 현행 포맷
    else if (j && typeof j.datacenters === 'object' && j.datacenters) entries = migrateLegacyMap(j.datacenters); // 구: 법인 키
    else if (j && typeof j.vcenters === 'object' && j.vcenters) entries = migrateLegacyMap(j.vcenters); // 구: vCenter 키
    else entries = {};
    cache = { entries: openSecretsDeep(entries) }; // v2.296 스캔 계정 복호(메모리 평문)
  } catch { preserveCorrupt(FILE); cache = { entries: {} }; } // v2.322: 손상본 보존(스캔 계정 유실 방지)
  cacheMtime = mtime;
  return cache;
}

/**
 * 저장. 실패하면 오류 문구를 돌려준다(성공이면 null).
 * ⚠ v2.583(감사 카탈로그 N3 — 실행으로 확인): 예전에는 실패를 콘솔에만 찍고 메모리 캐시는 이미 바꾼 뒤라 라우트가
 *   200 + 감사로그 'iDRAC 스캔 대역 저장' 을 남겼다 — 화면은 저장됐다고 말하고 **재시작하면 사라졌다**(v2.560
 *   clearHangs 와 같은 정직성 유형). 이제 디스크에 쓴 뒤에만 캐시를 바꾸고, 사용자 저장 경로는 실패를 400 으로 돌려준다.
 */
function write(data) {
  try {
    atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep(data), null, 2), { mode: 0o600 }); // 암호화 모드면 password 봉인(복제 — cache 평문 유지)
    cache = data;
    try { cacheMtime = fs.statSync(FILE).mtimeMs; } catch { cacheMtime = -1; }
    return null;
  } catch (e) {
    console.error('[idrac-scan-ranges] 저장 실패:', e.message);
    cache = data; // 실행 이력(lastRun) 같은 내부 갱신은 메모리에라도 남긴다 — 사용자 저장 경로는 아래에서 되돌린다
    return e.message || String(e);
  }
}

const normRanges = (r) => (Array.isArray(r) ? r : String(r || '').split(/[\n,]/))
  .map((s) => String(s).trim()).filter(Boolean);

/** 비밀번호 제거 + hasPassword 노출(UI용). */
function redact(id, e) {
  const { password, ...rest } = e;
  const ilo = normIlo(rest.ilo);
  return {
    id,
    datacenterId: rest.datacenterId || '',
    service: rest.service || '',
    ranges: rest.ranges || [],
    username: rest.username || '',
    agent: rest.agent || '',
    dispatch: rest.dispatch === 'push' ? 'push' : 'poll', // 위임 전달 방식: poll(에이전트 폴링) | push(중앙→엣지 직접)
    enabled: rest.enabled !== false,
    mode: rest.mode || 'merge',
    updatedAt: rest.updatedAt || null,
    lastRun: rest.lastRun || null,
    hasPassword: Boolean(password),
    // v2.610: iLO 계정은 계정명과 '비밀번호 있음' 만(평문 미노출).
    iloUsername: ilo.username,
    iloHasPassword: Boolean(ilo.password),
  };
}

/** v2.610: 저장된 iLO 계정 정규화 — 항상 { username, password } 모양(빈 문자열 허용). */
function normIlo(v) {
  return { username: String(v?.username ?? '').trim(), password: typeof v?.password === 'string' ? v.password : '' };
}
/** v2.610: 스캔에 쓸 수 있는 계정이 하나라도 있는가(Dell 또는 iLO). */
function scanCredsOf(e) {
  const dell = Boolean(String(e?.username || '').trim() && String(e?.password || ''));
  const i = normIlo(e?.ilo);
  const ilo = Boolean(i.username && i.password);
  return { dell, ilo, any: dell || ilo, iloCred: ilo ? i : null };
}
/**
 * 폴러가 쓰는 실행 엔트리(비밀번호 포함). enabledScanRanges·수동 단건·법인 전체 스캔이 **같은 모양**을 쓰게 한다
 * (예전에는 세 곳이 각자 조립해 필드를 더할 때마다 한 곳씩 빠졌다).
 */
export function scanEntryRuntime(id, e) {
  const c = scanCredsOf(e);
  return {
    id,
    datacenterId: String(e.datacenterId || '').trim(),
    service: e.service || '',
    ranges: (e.ranges || []).filter(Boolean),
    username: c.dell ? String(e.username || '').trim() : '',
    password: c.dell ? (e.password || '') : '',
    ilo: c.iloCred,
    agent: String(e.agent || '').trim(),
    dispatch: e.dispatch === 'push' ? 'push' : 'poll',
    mode: e.mode || 'merge',
  };
}
/** v2.610: 스캔 가능 여부(대역 + 어느 한쪽 계정). 사유 문구는 호출부가 쓴다. */
export function scanEntryReady(e) {
  return Boolean((e?.ranges || []).filter(Boolean).length) && scanCredsOf(e).any;
}

/** UI용 목록(비밀번호 마스킹). 법인→서비스 순 정렬. */
export function listScanRanges() {
  const map = read().entries || {};
  return Object.entries(map)
    .map(([id, e]) => redact(id, e))
    .sort((a, b) => (a.datacenterId || '').localeCompare(b.datacenterId || '') || (a.service || '').localeCompare(b.service || ''));
}

/** 폴러용 — 비밀번호 포함 원본(클론). enabled+ranges+username+password 있는 것만. */
export function enabledScanRanges() {
  const map = read().entries || {};
  const out = [];
  for (const [id, e] of Object.entries(map)) {
    if (e.enabled === false) continue;
    const ranges = (e.ranges || []).filter(Boolean);
    if (!ranges.length) continue;
    // 계정(iDRAC 또는 v2.610 iLO) 이 하나도 없으면 인증 불가 → 건너뜀(스캔 보류)
    if (!scanCredsOf(e).any) continue;
    out.push(scanEntryRuntime(id, e));
  }
  return out;
}

/** 단건 원본(비밀번호 포함) — 폴러/수동 스캔에서 사용. id로 조회. */
export function getScanRangeRaw(id) {
  const e = (read().entries || {})[String(id || '').trim()];
  return e ? structuredClone({ id: String(id).trim(), ...e }) : null;
}

/** 한 법인(datacenterId)에 속한 모든 엔트리 원본(비밀번호 포함). '법인 전체 스캔'용. */
export function scanRangesForDatacenter(datacenterId) {
  const id = String(datacenterId || '').trim();
  const map = read().entries || {};
  return Object.entries(map)
    .filter(([, e]) => String(e.datacenterId || '').trim() === id)
    .map(([eid, e]) => structuredClone({ id: eid, ...e }));
}

/**
 * 저장/수정. body: { id?, datacenterId, service?, ranges?, username?, password?, agent?, enabled?, mode? }.
 * id가 있고 기존에 존재하면 수정, 없으면 새 엔트리 생성(UUID 발급). 비밀번호는 빈 문자열이면 기존 유지.
 */
export function saveScanRanges(body = {}) {
  const dcId = String(body.datacenterId || '').trim();
  if (!dcId) return { ok: false, reason: 'datacenterId(법인)가 필요합니다.' };
  if (dcId.length > 128 || [...dcId].some((c) => c.charCodeAt(0) < 32)) return { ok: false, reason: 'datacenterId에 사용할 수 없는 문자가 있습니다.' };
  const service = String(body.service || '').trim();
  if (service.length > 128 || [...service].some((c) => c.charCodeAt(0) < 32)) return { ok: false, reason: '서비스명에 사용할 수 없는 문자가 있습니다.' };
  const data = read();
  const id = String(body.id || '').trim() && data.entries[String(body.id).trim()] ? String(body.id).trim() : crypto.randomUUID();
  const cur = data.entries[id] || { datacenterId: dcId, service: '', ranges: [], username: '', password: '', agent: '', dispatch: 'poll', enabled: true, mode: 'merge' };
  const next = {
    datacenterId: dcId,
    service: body.service !== undefined ? service : (cur.service || ''),
    ranges: body.ranges !== undefined ? normRanges(body.ranges) : (cur.ranges || []),
    username: body.username !== undefined ? String(body.username || '').trim() : (cur.username || ''),
    // 빈 비밀번호는 기존 유지(편집 시 비번 재입력 강요하지 않음).
    password: (body.password != null && body.password !== '') ? String(body.password) : (cur.password || ''),
    agent: body.agent !== undefined ? String(body.agent || '').trim() : (cur.agent || ''),
    dispatch: body.dispatch !== undefined ? (body.dispatch === 'push' ? 'push' : 'poll') : (cur.dispatch === 'push' ? 'push' : 'poll'),
    enabled: body.enabled !== undefined ? body.enabled !== false : (cur.enabled !== false),
    mode: body.mode !== undefined ? (['merge', 'replace-datacenter'].includes(body.mode) ? body.mode : 'merge') : (cur.mode || 'merge'),
    updatedAt: Date.now(),
    lastRun: cur.lastRun || null, // 실행 이력은 보존
  };
  // v2.610: HPE iLO 계정(선택). iloUsername 을 보내면 갱신, 빈 iloPassword 는 기존 유지(Dell 비밀번호와 같은 규칙).
  //   iloClear:true 면 iLO 계정을 지운다(이후 이 대역의 HPE 는 예전처럼 '미지원 서버' 로 남는다).
  const curIlo = normIlo(cur.ilo);
  if (body.iloClear === true) {
    next.ilo = { username: '', password: '' };
  } else {
    const iu = body.iloUsername !== undefined ? String(body.iloUsername || '').trim() : curIlo.username;
    if (iu.length > 128 || [...iu].some((c) => c.charCodeAt(0) < 32)) return { ok: false, reason: 'iLO 계정에 사용할 수 없는 문자가 있습니다.' };
    const ip = (body.iloPassword != null && body.iloPassword !== '') ? String(body.iloPassword) : curIlo.password;
    next.ilo = { username: iu, password: iu ? ip : '' };   // 계정을 비우면 비밀번호도 버린다(쓸 수 없는 비밀을 쌓지 않는다)
  }
  // v2.606 LEFT2606-02: 스캔의 '접속 대상' 은 ranges 다 — 대역(정규화 집합)·수행 엣지(agent)·계정이 바뀌었는데
  //   새 비밀번호가 없으면 저장 비밀번호를 승계하지 않는다(v2.503 S-2 secretCarry 규약. 예전에는 대역만 바꿔 저장하면
  //   다음 스캔이 새 대역의 Redfish 응답 호스트마다 저장 iDRAC 비밀번호를 보냈다). 대역 '추가' 도 대상이다 —
  //   추가된 대역이 곧 새 접속처다. 폐기 사실은 응답 droppedSecrets·skipped 로 밝힌다(조용히 버리지 않는다).
  const rangeKey = (r) => [...new Set((r || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))].sort().join(',');
  const existed = Boolean(data.entries[id]);
  const moved = existed && (
    rangeKey(cur.ranges) !== rangeKey(next.ranges)
    || accessMoved({ agent: cur.agent || '', username: cur.username || '' }, { agent: next.agent, username: next.username }, ['agent', 'username']));
  const droppedSecrets = (moved && cur.password) ? dropCarriedSecrets(next, body, ['password']) : [];
  // 스키마(빈 문자열 = 비밀번호 없음)는 유지. v2.611 정정(감사 RECENT2611-02): 예전 주석은 'enabledScanRanges 가 스캔을 보류한다'
  //   였지만 iLO 계정이 남아 있으면 그 대역은 계속 스캔된다(Dell 만 보류). 안내 문구는 아래 holdText 가 계정 상태로 가른다.
  if (droppedSecrets.length) next.password = '';
  // v2.610: iLO 비밀번호도 같은 규칙 — 대역·엣지·**iLO 계정명**이 바뀌었는데 새 iLO 비밀번호가 없으면 승계하지 않는다.
  const iloMoved = existed && (rangeKey(cur.ranges) !== rangeKey(next.ranges)
    || accessMoved({ agent: cur.agent || '', username: curIlo.username }, { agent: next.agent, username: next.ilo.username }, ['agent', 'username']));
  const iloNewPw = body.iloPassword != null && body.iloPassword !== '';
  if (iloMoved && curIlo.password && !iloNewPw && next.ilo.password) {
    next.ilo = { ...next.ilo, password: '' };
    droppedSecrets.push('iloPassword');
  }
  const prevEntries = data.entries;
  data.entries = { ...data.entries, [id]: next };
  const err = write(data);
  if (err) { cache = { ...data, entries: prevEntries }; return { ok: false, reason: `저장 실패(디스크에 쓰지 못해 반영하지 않았습니다): ${err}` }; }
  const out = { ok: true, ...redact(id, next) };
  if (droppedSecrets.length) {
    out.droppedSecrets = droppedSecrets;
    out.skipped = [];
    const hold = scanHoldText(next);
    if (droppedSecrets.includes('password')) out.skipped.push({ field: 'password', reason: `스캔 대역·수행 엣지·계정이 바뀌어 저장된 비밀번호를 폐기했습니다 — 새 대역에 보낼 비밀번호를 다시 입력하세요(${hold}).` });
    if (droppedSecrets.includes('iloPassword')) out.skipped.push({ field: 'iloPassword', reason: `스캔 대역·수행 엣지·iLO 계정이 바뀌어 저장된 iLO 비밀번호를 폐기했습니다 — iLO 비밀번호를 다시 입력하세요(${hold}).` });
  }
  return out;
}

/**
 * v2.611(감사 RECENT2611-02): 비밀번호 폐기 뒤 '무엇이 보류되고 무엇이 계속되는가'(순수). 예전에는 Dell 비밀번호를 버리면
 *   무조건 '이 항목의 스캔은 보류됩니다' 라고 했는데, iLO 계정이 남아 있으면 enabledScanRanges 가 그 대역을 계속 스캔한다
 *   (거짓 안내). 계정 상태로 가른다. 웹 `views/idrac/scanRunText.js scanHoldNote` 가 같은 판정이다.
 */
export function scanHoldText(e) {
  const c = scanCredsOf(e);
  if (c.dell && c.ilo) return '입력 전에도 두 계정으로 스캔은 계속됩니다';
  if (c.ilo) return '입력 전까지 Dell(iDRAC) 스캔은 보류되고, HPE(iLO) 스캔은 계속됩니다';
  if (c.dell) return '입력 전까지 HPE(iLO) 스캔은 보류되고, Dell(iDRAC) 스캔은 계속됩니다';
  return '입력 전까지 이 항목의 스캔은 보류됩니다';
}

/** 삭제. id로 삭제. */
export function removeScanRanges(id) {
  const key = String(id || '').trim();
  const data = read();
  if (!data.entries[key]) return { ok: false, reason: '없는 항목' };
  const rest = { ...data.entries };
  delete rest[key];
  const err = write({ ...data, entries: rest });
  if (err) { cache = data; return { ok: false, reason: `삭제 실패(디스크에 쓰지 못해 반영하지 않았습니다): ${err}` }; }
  return { ok: true };
}

/**
 * 마지막으로 '어느 엔트리든' 스캔이 실행된 시각(ms). 없으면 0.
 * 재시작(업그레이드) 후 '아직 주기가 안 됐으면 스캔을 앞당기지 않기' 위한 기준값.
 */
export function lastScanCycleAt() {
  const map = read().entries || {};
  let max = 0;
  for (const e of Object.values(map)) {
    const at = e?.lastRun?.at;
    if (typeof at === 'number' && at > max) max = at;
  }
  return max;
}

/** 폴러가 실행 결과를 기록(per-엔트리 lastRun). 저장 충돌 없이 lastRun만 갱신. */
export function recordScanRangeRun(id, run) {
  const key = String(id || '').trim();
  const data = read();
  const cur = data.entries[key];
  if (!cur) return; // 도중에 삭제됐으면 무시
  data.entries = { ...data.entries, [key]: { ...cur, lastRun: { at: Date.now(), ...run } } };
  write(data);
}

/**
 * 위임 스캔의 **결과**를 그 대역 엔트리에 반영한다(v2.441).
 *
 * 왜 필요했나: 위임(에이전트/PUSH) 스캔은 폴러가 **잡을 던진 시점**에만 lastRun 을 남겼고
 * (`delegated:true, found:null`), 나중에 에이전트가 결과를 회신하면 스캔 로그(phase=result)에만
 * 적재하고 이 엔트리는 갱신하지 않았다. 그래서 '법인별 iDRAC 장비 스캔' 표의 '최근 결과' 열이
 * 19개 법인 대부분에서 영원히 `위임(AZ) · 시각` 으로만 보이고 **몇 대를 찾았는지·성공했는지**
 * 알 수 없었다(사용자 지적). 회신 시 reqId 로 짝을 찾아 실제 수치를 채운다.
 *
 * 짝 맞춤은 lastRun.reqId — 던질 때 함께 저장한다. 이후 같은 엔트리를 다시 스캔하면 reqId 가
 * 새 값으로 덮이므로, 늦게 도착한 옛 결과가 새 실행을 덮어쓰지 않는다.
 * @returns {boolean} 반영했으면 true
 */
export function recordScanRangeRunByReqId(reqId, run) {
  const rid = String(reqId || '').trim();
  if (!rid) return false;
  const data = read();
  const hit = Object.entries(data.entries).find(([, e]) => String(e?.lastRun?.reqId || '') === rid);
  if (!hit) return false;
  const [key, cur] = hit;
  // 던질 때 남긴 값(agent/dispatch/reqId/dispatchedAt)은 유지하고 결과 수치만 덮는다.
  data.entries = { ...data.entries, [key]: { ...cur, lastRun: { ...cur.lastRun, ...run, at: Date.now() } } };
  write(data);
  return true;
}
