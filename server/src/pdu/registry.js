/**
 * pdu/registry.js — PDU(APC Rack PDU 2G) 장비 등록 — `CONFIG_DIR/pdu-devices.json`(0600).
 *
 * 한 등록 = NMC 한 대(호스트 하나). 그 아래 데이지체인 PDU·센서 수량은 **저장하지 않는다** —
 * 수집기가 장비에 물어 자동 탐지한다(사용자 요구: '자동으로 확인해서 연결된 센서 수량만큼').
 * 그래서 현장에서 센서를 추가해도 포탈 설정을 고칠 필요가 없다.
 *
 * 보안 불변조건(server/CLAUDE.md):
 *  - password 는 secretVault 봉인 대상 → SECRET_FILES 에 'pdu-devices.json' 등록 필요.
 *  - atomicWriteFileSync + 로드 손상 시 preserveCorrupt(조용한 빈값 반환 금지).
 *  - 응답에는 비밀번호를 싣지 않는다(redact → hasPassword).
 *  - 외부 입력 host 를 네트워크로 찌르므로 ssrfBlockReason 통과 필수.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js';
import { ssrfBlockReason } from '../collector/registry.js';
import { accessMoved, secretProvided } from '../util/secretCarry.js'; // v2.607 SEC2607-07

const FILE = path.join(config.configDir, 'pdu-devices.json');

let _cache = null;

/**
 * v2.612 LEFT2612-01: 등록부 파일을 읽지 못했으면(손상 → preserveCorrupt) 그 사실을 기억한다. 설정 pull 라우트
 *   (routes/central.js)가 이 값을 보고 503 으로 답한다 — 빈 목록을 ok:true 로 내려보내면 엣지가 장비 목록·스냅샷을
 *   통째로 지운다. 다음 저장이 성공하면 풀린다(그때부터는 관리자가 다시 만든 목록이 진실이다).
 */
let _loadError = null;
export function registryLoadError() { load(); return _loadError; }
// v2.612 LEFT2612-01: 파일이 없는데 손상 보존본(<파일>.corrupt.<시각>)만 있으면 재시작 뒤에도 '못 읽음' 이다 — 여기서 빈 목록으로
//   출발하면 재시작 한 번으로 엣지 목록 삭제가 되살아난다. 관리자가 한 번 저장하면(파일이 생기면) 풀린다.
function corruptOnlyReason(file) {
  try {
    const dir = path.dirname(file); const base = path.basename(file) + '.corrupt.';
    const hit = fs.readdirSync(dir).filter((n) => n.startsWith(base)).sort().pop();
    return hit ? `등록부 파일이 없고 손상 보존본(${hit})만 있습니다` : null;
  } catch { return null; }
}

function load() {
  if (_cache) return _cache;
  if (!fs.existsSync(FILE)) { const why = corruptOnlyReason(FILE); if (why) _loadError = { at: Date.now(), reason: why }; _cache = { devices: [] }; return _cache; }
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    _cache = { devices: openSecretsDeep(Array.isArray(parsed?.devices) ? parsed.devices : []) };
  } catch (e) {
    // 손상본을 조용히 []로 넘기면 다음 저장이 원본을 덮어써 자격증명이 영구 유실된다.
    preserveCorrupt(FILE, e.message);
    _loadError = { at: Date.now(), reason: String(e?.message || e).slice(0, 200) };
    _cache = { devices: [] };
  }
  return _cache;
}

function save(devices) {
  _cache = { devices };
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep({ devices }), null, 2), { mode: 0o600 });
  _loadError = null; // v2.612 LEFT2612-01
}

export function redact(d) {
  const { password, ...rest } = d;
  return { ...rest, hasPassword: Boolean(password) };
}

export function listDevices() { return load().devices.map(redact); }
/** 수집기 전용(비밀번호 포함). 라우트 응답에 그대로 쓰지 말 것. */
export function getDeviceWithSecret(id) { return load().devices.find((d) => d.id === id) || null; }
export function listDevicesWithSecrets() { return load().devices.map((d) => ({ ...d })); }

/** 입력 검증. 반환 문자열 = 오류 사유, null = 통과. */
export function deviceInputIssue(input = {}) {
  const host = String(input.host || '').trim();
  if (!String(input.name || '').trim()) return '표시명을 입력하세요.';
  if (!host) return 'host(IP/호스트명)를 입력하세요.';
  if (!String(input.username || '').trim()) return '계정을 입력하세요.';
  const port = Number(input.sshPort ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'SSH 포트가 올바르지 않습니다(1~65535).';
  const ssrf = ssrfBlockReason(host);           // 루프백/링크로컬/우회표기 차단
  if (ssrf) return `host 거부: ${ssrf}`;
  return null;
}

function normalize(input, existing = null) {
  const e = existing || {};
  return {
    id: String(input.id || e.id || `pdu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`),
    name: String(input.name ?? e.name ?? '').trim(),
    host: String(input.host ?? e.host ?? '').trim(),
    username: String(input.username ?? e.username ?? '').trim(),
    // 빈 비밀번호는 기존 유지(편집 시 재입력 강요하지 않음) — 단 **host 가 바뀌면 이월 금지**(v2.479, 감사 S-1):
    // 이월하면 host 만 공격자 IP 로 바꾼 뒤 다음 폴링이 저장 비밀번호로 그 호스트에 SSH 로그인한다
    // (uagmon M3 · relaytopo v2.435 · storage/sanswitch 와 같은 규칙).
    password: input.password ? String(input.password)
      : ((input.host !== undefined && String(input.host).trim() !== String(e.host || '').trim()) ? '' : (e.password || '')),
    sshPort: Number(input.sshPort ?? e.sshPort ?? 22) || 22,
    datacenterId: String(input.datacenterId ?? e.datacenterId ?? '').trim(),
    // 수집 주체: '' = 중앙 직접, 그 외 = 그 엣지 이름에 위임(스토리지/SAN 스위치와 동일 규약)
    agent: String(input.agent ?? e.agent ?? '').trim(),
    enabled: input.enabled !== undefined ? input.enabled !== false : (e.enabled !== false),
    note: String(input.note ?? e.note ?? '').trim().slice(0, 500),
    updatedAt: Date.now(),
  };
}

/** 등록/수정. id 가 있으면 수정, 없으면 신규. */
export function saveDevice(input = {}) {
  const issue = deviceInputIssue(input);
  if (issue) return { ok: false, reason: issue };
  const list = load().devices.slice();
  const idx = input.id ? list.findIndex((d) => d.id === input.id) : -1;
  const entry = normalize(input, idx >= 0 ? list[idx] : null);
  // v2.607(감사 SEC2607-07·LEFT2607-06): normalize 는 host 변경만 비밀번호를 비운다 — 계정·SSH 포트를 바꿔도 옛
  //   비밀번호가 새 계정·포트로 시도됐다. 공용 판정(host·username·sshPort)으로 한 번 더 본다. agent(수집 엣지) 변경은
  //   승계한다(위임 수집에 필요, 장비는 같다). 버린 사실은 droppedSecrets 로 응답에 싣는다.
  let droppedSecrets = [];
  if (idx >= 0 && !secretProvided(input.password)) {
    const e = list[idx];
    const moved = accessMoved({ host: e.host, username: e.username || '', port: Number(e.sshPort) || 22 },
      { host: entry.host, username: entry.username, port: entry.sshPort }, ['host', 'username', 'port']);
    if (moved) { if (e.password) droppedSecrets = ['password']; entry.password = ''; }
  }
  // 같은 host 중복 등록 방지(다른 id 로 같은 장비를 두 번 폴링하면 부하만 는다).
  const dup = list.find((d) => d.id !== entry.id && d.host.toLowerCase() === entry.host.toLowerCase());
  if (dup) return { ok: false, reason: `이미 등록된 host 입니다: ${entry.host} (${dup.name})` };
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  save(list);
  return { ok: true, device: redact(entry), ...(droppedSecrets.length ? { droppedSecrets } : {}) };
}

export function deleteDevice(id) {
  const list = load().devices;
  const next = list.filter((d) => d.id !== id);
  if (next.length === list.length) return { ok: false, reason: '없는 장비입니다.' };
  save(next);
  return { ok: true };
}

/**
 * 이 노드가 실제로 수집할 장비들.
 *  - 중앙(엣지 아님): agent 가 비어 있는 장비만(위임분은 엣지가 맡는다)
 *  - 엣지: 자기 이름으로 위임된 장비만
 * 스토리지 `devicesForThisNode` 와 같은 규약.
 */
export function devicesForThisNode({ devices = load().devices, agentName = config.agent.name, isEdge = !!config.agent.centralUrl } = {}) {
  const me = String(agentName || '').trim().toLowerCase();
  return devices.filter((d) => {
    if (d.enabled === false) return false;
    const a = String(d.agent || '').trim().toLowerCase();
    return isEdge ? (a && a === me) : !a;
  });
}

/** 중앙이 특정 엣지에 내려줄 장비 목록(비밀번호 포함 — 개별 토큰 인증 경로에서만 호출). */
export function devicesForAgent(agentName) {
  const me = String(agentName || '').trim().toLowerCase();
  if (!me) return [];
  return load().devices.filter((d) => d.enabled !== false && String(d.agent || '').trim().toLowerCase() === me);
}

/** 엣지가 중앙에서 받은 목록으로 로컬 파일을 교체(pull 적용). */
export function applyPulledDevices(list) {
  if (!Array.isArray(list)) return { ok: false, reason: '목록이 배열이 아닙니다.' };
  // v2.597(감사 L2597-05 — 재현): 이번 목록에서 빠진 id 를 돌려준다 — 엣지가 그 스냅샷을 바로 지우게(storage EF-3 형제).
  const before = new Set(load().devices.map((d) => String(d.id)));
  const next = list.map((d) => normalize(d));
  save(next);
  const now = new Set(next.map((d) => String(d.id)));
  return { ok: true, count: list.length, removed: [...before].filter((id) => !now.has(id)) };
}

export function _resetForTest() { _cache = null; _loadError = null; }
