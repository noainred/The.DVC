/**
 * vCenter registry — read/write the managed list of vCenters in
 * config/vcenters.json (the same file the live collector polls), with
 * validation, password redaction for API responses, and a connection test.
 *
 * Edited through the admin API so operators can register/manage vCenters from
 * the portal instead of hand-editing the file. The file is gitignored and
 * written 0600 because it holds credentials.
 */

import path from 'node:path';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { makeLoadError } from '../util/registryCore.js'; // 118회차: 읽기 오류 ≠ 손상(공용 판정 — 결정 78 남긴 것 ① · 116회차 nsx/registry.js 와 같은 규칙)
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // 자격증명 저장 방식(평문/암호화, v2.296) — 로드 시 복호·저장 시 봉인
import { VCenterClient, vcAuthGuard } from './restClient.js';
import { describeError } from '../util/errors.js';
import { geocode } from './geocode.js';
import { normRequestTimeoutMs } from './soapParse.js'; // v2.598 T2598-03: 요청 시한 [1초, 10분] (0 = 기본값)
import { config, noteVcenterConfigText, lastVcenterConfigText } from '../config.js';
import { accessMoved, dropCarriedSecrets } from '../util/secretCarry.js'; // v2.503: 접속처 변경 시 저장 비밀 폐기(공용 판정)

// User registry lives in CONFIG_DIR (default app/server/config) so it can be
// kept outside the app dir (e.g. /etc/vmware-portal) to survive upgrades.
const FILE = path.join(config.configDir, 'vcenters.json');

import { REGIONS } from '../util/regions.js'; // v2.575 IMP-10 — 단일 소스

/*
 * 118회차(재현 — 97회차 스윕이 '다른 점검 범위' 로 남긴 등록부 · 116회차 F1 의 형제): 예전에는 읽기와 JSON.parse 를 catch 하나로 받아 **읽기 오류**
 *   (EMFILE · EIO · EACCES · EISDIR)도 손상으로 보고 온전한 vcenters.json(전 vCenter 접속 계정 · 비밀번호)을 `.corrupt.*` 로 옮긴 뒤 빈 목록으로 돌았다.
 *   이 등록부는 캐시 없이 화면 조회 · 점검 폴러마다 읽으므로 일시 오류 **한 번**에 원본이 사라졌고, 수집 경로(config.js loadVcenterConfig — 같은 파일을
 *   따로 읽는다)는 그 뒤로 '파일 없음 = vCenter 0개' 로 돌았다(수집 캐시 · 위임 인벤토리 삭제). 다음 등록은 한 건짜리 파일을 썼다.
 *   판정은 공용(util/registryCore.js makeLoadError.read — 읽기 단계 실패 = read-error · parse 실패 = corrupt):
 *    - read-error: 원본을 옮기지 않는다 · **마지막으로 읽은 목록**을 돌려준다(한 번도 못 읽었으면 빈 목록 — 그 사실은 `registryLoadError()` 가 말한다) ·
 *      쓰기(등록 · 수정 · 삭제 · 가져오기)는 거절한다(`registry-unreadable`) · 30초 간격으로 다시 읽고, 읽히면 풀린다.
 *    - corrupt(JSON 형식): 예전과 같다(보존본으로 옮기고 빈 목록 — 관리자 저장이 새 등록부를 만든다). 이제 그 사실도 `registryLoadError()` 에 남는다.
 *    - 파일 없음 · `vcenters` 가 배열이 아님: 예전과 같다(빈 목록 · 오류 아님).
 *   봉인 해제(openSecretsDeep)는 던지지 않는다 — 키를 못 쓰면 그 칸이 '' 로 열리고(secretVault 계약) 파일은 그대로이며, 저장은 sealSecretsDeep 가 거절한다(SECRETS_KEY_MISSING).
 *   ⚠ 캐시는 두지 않는다(매 호출 디스크 읽기 그대로) — 호출부가 받은 목록을 고쳐 쓰고(add · update · import), 외부 편집 · 복원 · 정책 전환(migrateSecretFiles)이
 *     파일을 직접 바꾼다. 마지막 목록은 **원문**(봉인본 그대로)으로 들고 읽기 오류 때만 다시 푼다(호출부와 객체를 나누지 않는다 · 평소 경로에 복제 비용 없음).
 *     그 원문은 config.js 한 곳에 둔다(noteVcenterConfigText — 수집 경로 loadVcenterConfig 와 같은 값. 두 벌이면 저장 직후에 서로 다른 목록을 준다).
 */
const loadErr = makeLoadError();
const WHAT = 'vCenter 등록부(vcenters.json)';
let _parsedText = null;
const parseDb = (text) => {
  const parsed = JSON.parse(text);
  const list = openSecretsDeep(Array.isArray(parsed?.vcenters) ? parsed.vcenters : []); // 메모리는 항상 평문(소비 코드 무변경)
  _parsedText = text;
  return list;
};

export function loadRegistry() {
  const r = loadErr.read(FILE, parseDb);
  if (r.kind === 'ok') { noteVcenterConfigText(FILE, _parsedText); return r.value; }
  if (r.kind === 'read-error') {
    const last = lastVcenterConfigText(FILE);   // 마지막으로 읽은 원문(이 로더 · 수집 경로 · 저장 중 가장 최근)
    if (last == null) return [];
    try { return parseDb(last); } catch { return []; }
  }
  // 파일 없음 · 손상(보존본으로 옮김 — 조용히 []로 넘기면 다음 addVcenter/saveRegistry 가 빈 목록으로 덮어써 등록된 모든 vCenter 와 자격증명이 유실된다): 예전과 같이 빈 목록.
  noteVcenterConfigText(FILE, null);
  return [];
}
/**
 * @returns {null|{at:number, reason:string, readError?:boolean, code?:string}} 등록부를 못 읽었으면(읽기 오류 · 손상 · 재시작 뒤 보존본만 남음) 그 사유.
 *   읽기 오류(`readError:true`)면 loadRegistry() 는 마지막으로 읽은 목록(없으면 빈 목록)이다 — '등록 0개' 로 읽지 말 것.
 *   보존본 판정(설정 폴더 목록)은 여기서만 한다 — loadRegistry 는 화면 · 폴러마다 불리고, 등록 전 포탈은 파일이 없는 것이 정상이다.
 */
export function registryLoadError() { loadRegistry(); loadErr.checkCorruptOnly(FILE); return loadErr.get(); }
/** 읽기 오류 중의 쓰기 거절(`{ok:false, code:'registry-unreadable', readError:true, reason}`) 또는 null — 로드를 먼저 한다(첫 호출이 쓰기여도 상태가 서게). */
export function registryWriteRefusal() { loadRegistry(); return loadErr.writeRefusal(WHAT); }

function saveRegistry(list) {
  loadErr.assertWritable(WHAT); // 118회차: 마지막 방어선 — 어느 경로도 읽기 오류 중에 원본을 덮지 않는다(던진다)
  const text = JSON.stringify(sealSecretsDeep({ vcenters: list }), null, 2); // 암호화 모드면 password 봉인(깊은 복제 — 메모리 불변)
  atomicWriteFileSync(FILE, text, { mode: 0o600 });
  noteVcenterConfigText(FILE, text);   // 쓰기 성공 뒤에 — 바로 뒤의 읽기 오류가 저장 전 목록(지운 vCenter · 옛 비밀번호)을 되살리지 않게
  loadErr.clear();        // 손상 뒤의 관리자 저장이 새 등록부를 만들었다(v2.612 규약)
}

/** Strip secrets before sending an entry to the client. */
export function redact(vc) {
  const { password, ...rest } = vc;
  return { ...rest, hasPassword: Boolean(password) };
}

export function listRegistry() {
  return loadRegistry().map(redact);
}

/** Validate and normalize an incoming vCenter payload. Returns [entry, error]. */
function normalize(body, existing = null) {
  const e = existing ? { ...existing } : {};
  const id = String(body.id ?? e.id ?? '').trim();
  const name = String(body.name ?? e.name ?? '').trim();
  const host = String(body.host ?? e.host ?? '').trim();
  const username = String(body.username ?? e.username ?? '').trim();

  // id may come from an imported vcenters.json and can contain '/', '.', etc.
  // (it is URL-encoded on the client), so only reject empty/oversized/control chars.
  if (!id) return [null, 'id는 필수입니다.'];
  if (id.length > 128 || [...id].some((c) => c.charCodeAt(0) < 32)) return [null, 'id에 사용할 수 없는 문자가 있습니다.'];
  if (!name) return [null, 'name(표시 이름)은 필수입니다.'];
  if (!/^https?:\/\//.test(host)) return [null, 'host는 https://... 형식이어야 합니다.'];
  if (!username) return [null, 'username은 필수입니다.'];

  const loc = body.location || e.location || {};
  const region = REGIONS.includes(loc.region) ? loc.region : (loc.region || 'Unknown');
  const city = String(loc.city || '').trim();
  const country = String(loc.country || '').trim();
  let lat = loc.lat != null && loc.lat !== '' ? Number(loc.lat) : undefined;
  let lon = loc.lon != null && loc.lon !== '' ? Number(loc.lon) : undefined;
  // Auto-plot on the map: if no coordinates were given, derive them from the
  // city/country name via the offline geocoder.
  if ((lat == null || Number.isNaN(lat)) && (lon == null || Number.isNaN(lon)) && (city || country)) {
    const g = geocode(city, country);
    if (g) { lat = g.lat; lon = g.lon; }
  }

  // Per-vCenter collection tuning (for high-RTT / many-site environments).
  const intRaw = body.pollIntervalSec ?? e.pollIntervalSec;
  const toRaw = body.timeoutMs ?? e.timeoutMs;
  const pollIntervalSec = intRaw != null && intRaw !== '' ? Math.max(0, Math.round(Number(intRaw) || 0)) : 0; // 0 = global default
  // v2.598 T2598-03: 상한 없이 저장하면 2^31ms 이상에서 모든 요청이 1ms 에 abort 된다 — [1초, 10분] 으로 자른다.
  const timeoutMs = normRequestTimeoutMs(toRaw);          // 0 = 30s default
  const enabled = body.enabled !== undefined ? body.enabled !== false : (e.enabled !== false);
  // 수집 방식: 'direct'(중앙이 직접 폴링) | 'site'(현장 서버가 수집해 중앙으로 push)
  const collectMode = (body.collectMode ?? e.collectMode) === 'site' ? 'site' : 'direct';
  // 점검중: 수집을 일시 중단하고 '연결 실패'가 아닌 '점검중'으로 표시(알림·불가 카운트 제외).
  const maintenance = body.maintenance !== undefined
    ? (body.maintenance === true || body.maintenance === 'true')
    : (e.maintenance === true);

  const entry = {
    id, name, host, username,
    // keep existing password if not provided / blank
    password: body.password ? String(body.password) : e.password || '',
    location: { city, country, region, lat, lon },
    enabled, pollIntervalSec, timeoutMs, collectMode, maintenance,
  };

  // ⚠ 보안 불변조건(v2.503, 감사 S1 #6) — **접속처가 바뀌면 저장 비밀을 승계하지 않는다.**
  // 판정은 `util/secretCarry.js` 하나로 한다(각자 구현하면 다음 스토어에서 또 빠진다 — v2.500 H1/H2/H4).
  // 이 파일은 v2.500 에서 '추정' 으로만 남아 있던 나머지 스토어 중 하나이고, 이번에 코드로 확인됐다:
  // `{host:'https://vc.attacker.example', password:''}` 로 저장하면 host 만 바뀌고 저장 비밀번호가
  // 그대로 남아, 다음 수집 주기에 **운영 계정·비밀번호가 그 호스트로 평문 전송**된다.
  // v2.480 의 "연결 테스트는 host 를 저장값으로 고정" 은 테스트 라우트만 막으므로 저장 1회로 우회된다.
  // 버린 키는 호출부가 `droppedSecrets` 로 받아 '비밀번호를 다시 입력하세요' 를 안내한다.
  const droppedSecrets = existing && accessMoved(existing, body, ['host', 'username'])
    ? dropCarriedSecrets(entry, body, ['password']) : [];
  return [entry, null, droppedSecrets];
}

export function addVcenter(body) {
  const list = loadRegistry();
  { const ref = loadErr.writeRefusal(WHAT); if (ref) return ref; }   // 118회차: 읽기 오류 중에는 저장하지 않는다(원본을 한 건짜리로 덮지 않게)
  const [entry, err] = normalize(body);
  if (err) return { ok: false, reason: err };
  if (list.some((v) => v.id === entry.id)) return { ok: false, reason: `이미 존재하는 id: ${entry.id}` };
  list.push(entry);
  saveRegistry(list);
  return { ok: true, vcenter: redact(entry) };
}

export function updateVcenter(id, body) {
  const list = loadRegistry();
  { const ref = loadErr.writeRefusal(WHAT); if (ref) return ref; }   // 118회차
  const idx = list.findIndex((v) => v.id === id);
  if (idx === -1) return { ok: false, reason: `없는 vCenter: ${id}` };
  const [entry, err, droppedSecrets] = normalize({ ...body, id }, list[idx]);
  if (err) return { ok: false, reason: err };
  list[idx] = entry;
  saveRegistry(list);
  return { ok: true, vcenter: redact(entry), droppedSecrets };
}

export function removeVcenter(id) {
  const list = loadRegistry();
  { const ref = loadErr.writeRefusal(WHAT); if (ref) return ref; }   // 118회차
  const next = list.filter((v) => v.id !== id);
  if (next.length === list.length) return { ok: false, reason: `없는 vCenter: ${id}` };
  saveRegistry(next);
  return { ok: true };
}

/**
 * Import an existing vcenters.json. `mode`:
 *   - 'merge'   : add new entries, update existing ones by id (default)
 *   - 'replace' : replace the whole registry with the imported list
 * Returns a summary { ok, mode, added, updated, skipped[], total }.
 */
export function importVcenters(incoming, mode = 'merge') {
  if (!Array.isArray(incoming)) return { ok: false, reason: 'vcenters 배열을 찾을 수 없습니다 ({ "vcenters": [...] } 형식 필요).' };
  const existing = loadRegistry();
  { const ref = loadErr.writeRefusal(WHAT); if (ref) return ref; }   // 118회차: 전체 교체도 — 읽히지 않는 원본을 보존본 없이 덮지 않는다
  const result = mode === 'replace' ? [] : [...existing];
  let added = 0, updated = 0;
  const skipped = [];
  for (const raw of incoming) {
    const base = mode === 'replace' ? null : existing.find((v) => v.id === raw?.id);
    const [entry, err] = normalize(raw || {}, base);
    if (err) { skipped.push({ id: raw?.id || '(id 없음)', reason: err }); continue; }
    const idx = result.findIndex((v) => v.id === entry.id);
    if (idx >= 0) { result[idx] = entry; updated++; } else { result.push(entry); added++; }
  }
  // 안전장치: 'replace'인데 유효 항목이 하나도 없으면(빈 배열/전부 무효) 레지스트리를 통째로
  // 비우지 않는다 — 실수로 빈 파일을 replace 임포트해 등록 vCenter·자격증명이 소실되는 것 방지.
  if (mode === 'replace' && result.length === 0) {
    return { ok: false, mode, added: 0, updated: 0, skipped, total: existing.length, reason: '가져올 유효한 vCenter가 없어 전체 교체를 취소했습니다(기존 목록 유지).' };
  }
  saveRegistry(result);
  return { ok: true, mode, added, updated, skipped, total: result.length };
}

/**
 * Test connectivity to a vCenter (REST login). Uses the stored password when
 * the payload omits it (so you can re-test a saved entry without re-typing).
 */
/** 91회차 ⓐ: 저장 비밀번호를 물려받지 않는 연결 테스트 사유(NSX · iDRAC · Horizon 도 같은 문구). */
export const CARRY_MOVED_REASON = '접속 주소나 계정이 저장값과 달라 저장된 비밀번호를 쓰지 않습니다 — 비밀번호를 입력해 주세요.';
export async function testConnection(body, { pinSavedHost = false } = {}) {
  let entry = body;
  // v2.630 AUTHZ2630-02: 범위 관리자는 새 vCenter 를 시험할 수 없다(v2.607) — 그런데 범위 안 id 에 body.password·body.host 를
  //   함께 넣으면 저장값을 물려받지 않아 body.host 로 로그인했다(중앙에서 임의 호스트·포트 SOAP 로그인 = 도달성 프로빙).
  //   pinSavedHost 면 비밀번호 입력 여부와 무관하게 접속처(host·port)를 저장값으로 고정한다.
  if (pinSavedHost) {
    const saved = body.id ? loadRegistry().find((v) => v.id === body.id) : null;
    if (!saved) return { ok: false, reason: '저장된 vCenter 를 찾을 수 없습니다.' };
    entry = { ...body, host: saved.host, port: saved.port };
  }
  // v2.590: 저장된 비밀번호로 한 테스트가 성공하면 인증 실패 정지를 푼다(비밀번호를 vCenter 쪽에서 되돌린 경우 —
  // 포탈 값이 바뀌지 않아 credHash 자동 재개가 걸리지 않는다). 입력한 새 비밀번호로 성공한 것은 **저장값이 맞다는
  // 증거가 아니므로** 풀지 않는다(풀면 주기 수집이 틀린 저장값으로 다시 로그인한다).
  let usedSaved = false;
  if (!entry.password && entry.id) {
    const saved = loadRegistry().find((v) => v.id === entry.id);
    // 91회차 ⓐ(89회차 결정 — 권장안): 저장 경로(normalize — host · username 이 바뀌면 비밀을 버린다 · secretCarry)와 같은 판정. 예전에는 body.username 이
    //   저장값과 달라도 저장 비밀번호를 물려받아 **다른 계정명으로 저장 비밀번호를 보냈고**, 성공하면 저장 계정의 인증 정지까지 풀었다.
    //   주소가 다른 것도 같다(예전에는 저장 주소로 몰래 바꿔 시험해 입력한 주소의 결과처럼 보였다) — 비밀번호를 다시 입력하게 한다.
    if (saved && accessMoved(saved, body, ['host', 'username'])) return { ok: false, reason: CARRY_MOVED_REASON };
    if (saved) { usedSaved = true; entry = { ...saved, ...entry, password: saved.password, host: saved.host, port: saved.port }; } // v2.480(3차 감사 S6): 저장 비밀번호를 물려받는 테스트는 host 도 저장값으로 고정 — body.host 만 공격자 IP 로 바꿔 평문 비밀번호를 받는 경로 차단(PDU S-1 과 같은 규칙)
  }
  if (!entry.host || !entry.username || !entry.password) {
    return { ok: false, reason: 'host/username/password가 필요합니다.' };
  }
  const client = new VCenterClient(entry);
  const started = Date.now();
  try {
    await client.login();
    await client.logout();
    const authStopCleared = usedSaved ? vcAuthGuard.clearAuthStop(entry.id) : false;
    return { ok: true, ms: Date.now() - started, ...(authStopCleared ? { authStopCleared: true } : {}) };
  } catch (err) {
    const d = describeError(err);
    return { ok: false, reason: d.message, hint: d.hint, code: d.code, ms: Date.now() - started };
  }
}

/**
 * VM/네트워크/호스트 id(`${vcenterId}:${moref}`)에서 moref 를 잘라낸다(v2.447, 감사 B1).
 *
 * ⚠️ `split(':')` 금지: vCenter id 자체에 콜론이 들어갈 수 있어(위 유효성 검사가 허용한다)
 * `split(':').slice(1).join(':')` 은 `apac:vc01:vm-123` 에서 `vc01:vm-123` 을 돌려준다.
 * 그 잘못된 moref 로 SOAP 를 호출하면 GPU 수집·OS 스캔·게스트 계정·VM 복제가 전량 실패한다.
 * 알려진 프리픽스 길이로 자르는 것만이 안전하다(vmExport.js·dsBrowse.js 가 쓰던 방식을 공용화).
 *
 * @param {string} id        `${vcenterId}:${moref}`
 * @param {string} vcenterId 그 객체의 vcenterId(스냅샷 객체의 `vcenterId` 필드)
 * @returns {string} moref. vcenterId 를 모르거나 프리픽스가 맞지 않으면 첫 콜론 뒤 전체(최선 추정).
 */
export function morefOf(id, vcenterId) {
  const s = String(id || '');
  const vc = String(vcenterId || '');
  if (vc && s.startsWith(`${vc}:`)) return s.slice(vc.length + 1);
  const i = s.indexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}
