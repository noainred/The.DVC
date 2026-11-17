/**
 * NSX Manager registry — read/write the managed list in CONFIG_DIR/nsx.json,
 * with validation, password redaction, and a connectivity test. Edited through
 * the admin API. The file is written 0600 because it holds credentials.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { ssrfBlockReason } from '../collector/registry.js'; // v2.537: 등록 시 SSRF 정적 가드
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { makeLoadError } from '../util/registryCore.js'; // 116회차 F1: 읽기 오류 ≠ 손상(공용 판정 — 결정 78 남긴 것 ①)
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // 자격증명 저장 방식(평문/암호화, v2.296) — 로드 시 복호·저장 시 봉인
import { NsxClient, nsxAuthGuard } from './client.js';
import { ensureNsxDial } from './proxy.js';
import { describeError } from '../util/errors.js';
import { retryTransient } from '../util/resilientFetch.js';
import { accessMoved, dropCarriedSecrets } from '../util/secretCarry.js'; // v2.503: 접속처 변경 시 저장 비밀 폐기(공용 판정)

const FILE = path.join(config.configDir, 'nsx.json');
import { normRequestTimeoutMs } from '../vcenter/soapParse.js'; // v2.598 T2598-03: 요청 시한 [1초, 10분] (0 = 기본값)
import { REGIONS } from '../util/regions.js'; // v2.575 IMP-10 — 단일 소스

/*
 * 116회차 F1(재현 — 결정 G2 · 78 ① 의 형제. 97회차 스윕이 '다른 점검 범위' 로 남긴 등록부): 예전에는 읽기와 JSON.parse 를 catch 하나로 받아
 *   **읽기 오류**(EMFILE · EACCES · EIO)도 손상으로 보고 온전한 nsx.json(매니저 계정 · 비밀번호)을 `.corrupt.*` 로 옮긴 뒤 빈 목록으로 돌았다.
 *   이 등록부는 캐시 없이 주기 수집(30초)마다 읽으므로 한 번의 일시 오류로 매니저 전부가 화면에서 사라졌고, 다음 등록이 한 건짜리 파일을 썼다.
 *   판정은 공용(util/registryCore.js makeLoadError.read — 읽기 단계 실패 = read-error · parse 실패 = corrupt):
 *    - read-error: 원본을 옮기지 않는다 · **마지막으로 읽은 목록**을 돌려준다(주기 수집이 이어진다 — 한 번도 못 읽었으면 빈 목록) ·
 *      쓰기(등록 · 수정 · 삭제)는 거절한다(`registry-unreadable`) · 30초 간격으로 다시 읽고, 읽히면 풀린다.
 *    - corrupt: 예전과 같다(보존본으로 옮기고 빈 목록 — 관리자 저장이 새 등록부를 만든다).
 */
const loadErr = makeLoadError();
const WHAT = 'NSX 등록부(nsx.json)';
let _lastGood = null;   // 마지막으로 읽은 목록(복호된 값 — 호출부가 고치지 못하게 사본으로 들고 사본으로 준다)
const parseDb = (text) => {
  const parsed = JSON.parse(text);
  return openSecretsDeep(Array.isArray(parsed?.managers) ? parsed.managers : []); // v2.296 자격증명 복호(메모리 평문)
};

export function loadRegistry() {
  const r = loadErr.read(FILE, parseDb);
  if (r.kind === 'ok') { _lastGood = structuredClone(r.value); return r.value; }
  if (r.kind === 'read-error') return _lastGood ? structuredClone(_lastGood) : [];
  // 파일 없음 · 손상(보존본으로 옮김 — save() 주석대로 조용히 빈 목록으로 넘기면 다음 저장이 원본을 덮는다): 예전과 같이 빈 목록.
  _lastGood = null;
  return [];
}
/**
 * @returns {null|{at:number, reason:string, readError?:boolean}} 등록부를 못 읽었으면(읽기 오류 · 손상 · 재시작 뒤 보존본만 남음) 그 사유.
 * 보존본 판정(설정 폴더 목록)은 여기서만 한다 — loadRegistry 는 주기 수집 · 요청마다 불리고, NSX 를 쓰지 않는 포탈은 파일이 없는 것이 정상이다(idrac/registry.js 와 같은 판단).
 */
export function registryLoadError() { loadRegistry(); loadErr.checkCorruptOnly(FILE); return loadErr.get(); }
/** 읽기 오류 중의 쓰기 거절(`{ok:false, code:'registry-unreadable', reason}`) 또는 null — 로드를 먼저 한다(첫 호출이 쓰기여도 상태가 서게). */
export function registryWriteRefusal() { loadRegistry(); return loadErr.writeRefusal(WHAT); }

function saveRegistry(list) {
  loadErr.assertWritable(WHAT); // 마지막 방어선 — 어느 경로도 읽기 오류 중에 원본을 덮지 않는다(던진다)
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  // 원자적 쓰기 — 자격증명(NSX 매니저 계정/비번) 파일이 부분기록으로 손상되면 로드가 []를
  // 반환하고 다음 저장이 빈 목록으로 덮어써 전 매니저가 영구 유실된다.
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep({ managers: list }), null, 2), { mode: 0o600 }); // 암호화 모드면 password 봉인
  loadErr.clear();   // 손상 뒤의 관리자 저장이 새 등록부를 만들었다(v2.612 규약)
}

export function redact(m) {
  const { password, ...rest } = m;
  return { ...rest, hasPassword: Boolean(password) };
}

export function listRegistry() {
  return loadRegistry().map(redact);
}

/** Validate + normalize an incoming NSX Manager payload. Returns [entry, error]. */
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
  // v2.537: 루프백·링크로컬·우회표기 차단(형식만 보던 것을 storage/sanswitch/pdu 와 같은 규칙으로).
  { const ssrf = ssrfBlockReason(host); if (ssrf) return [null, `host 거부: ${ssrf}`]; }
  if (!username) return [null, 'username은 필수입니다.'];

  const loc = body.location || e.location || {};
  const region = REGIONS.includes(loc.region) ? loc.region : (loc.region || 'Unknown');

  const intRaw = body.pollIntervalSec ?? e.pollIntervalSec;
  const toRaw = body.timeoutMs ?? e.timeoutMs;
  const pollIntervalSec = intRaw != null && intRaw !== '' ? Math.max(0, Math.round(Number(intRaw) || 0)) : 0;
  const timeoutMs = normRequestTimeoutMs(toRaw); // v2.598 T2598-03: 상한 없으면 2^31ms 이상에서 요청이 1ms 에 abort
  const enabled = body.enabled !== undefined ? body.enabled !== false : (e.enabled !== false);

  const entry = {
    id, name, host, username,
    password: body.password ? String(body.password) : e.password || '',
    vcenterId: String(body.vcenterId ?? e.vcenterId ?? '').trim(),
    // 다른 법인의 NSX를 등록된 HAProxy(중계 서버) 경유로 연결. 빈 값 = 직접 연결.
    proxyId: String(body.proxyId ?? e.proxyId ?? '').trim(),
    location: { region },
    enabled, pollIntervalSec, timeoutMs,
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

export function addManager(body) {
  const list = loadRegistry();
  { const ref = loadErr.writeRefusal(WHAT); if (ref) return ref; }   // 116회차 F1: 읽기 오류 중에는 저장하지 않는다(원본을 한 건짜리로 덮지 않게)
  const [entry, err] = normalize(body);
  if (err) return { ok: false, reason: err };
  if (list.some((m) => m.id === entry.id)) return { ok: false, reason: `이미 존재하는 id: ${entry.id}` };
  list.push(entry);
  saveRegistry(list);
  return { ok: true, manager: redact(entry) };
}

export function updateManager(id, body) {
  const list = loadRegistry();
  { const ref = loadErr.writeRefusal(WHAT); if (ref) return ref; }   // 116회차 F1
  const idx = list.findIndex((m) => m.id === id);
  if (idx === -1) return { ok: false, reason: `없는 NSX Manager: ${id}` };
  const [entry, err, droppedSecrets] = normalize({ ...body, id }, list[idx]);
  if (err) return { ok: false, reason: err };
  list[idx] = entry;
  saveRegistry(list);
  return { ok: true, manager: redact(entry), droppedSecrets };
}

export function removeManager(id) {
  const list = loadRegistry();
  { const ref = loadErr.writeRefusal(WHAT); if (ref) return ref; }   // 116회차 F1
  const next = list.filter((m) => m.id !== id);
  if (next.length === list.length) return { ok: false, reason: `없는 NSX Manager: ${id}` };
  saveRegistry(next);
  return { ok: true };
}

const CARRY_MOVED_REASON = '접속 주소나 계정이 저장값과 달라 저장된 비밀번호를 쓰지 않습니다 — 비밀번호를 입력해 주세요.';   // 91회차 ⓐ — vcenter/registry.js 와 같은 문구
/** Test connectivity to an NSX Manager (login). Uses the stored password when omitted. */
export async function testConnection(body) {
  let entry = body;
  // v2.591(감사 R-N1): 저장된 비밀번호로 한 테스트가 성공하면 인증 실패 정지를 푼다 — vCenter testConnection 과
  //   같은 모양(`authStopCleared`). NSX 쪽에서 잠금이 풀린 경우 포탈 비밀번호는 그대로라 credHash 자동 재개가 걸리지
  //   않고, 수동 수집 경로도 없어 **이것이 유일한 복구 경로**다(화면 문구가 이미 그렇게 안내하고 있었다).
  //   입력한 새 비밀번호·다른 계정으로 성공한 것은 **저장값이 맞다는 증거가 아니므로** 풀지 않는다.
  let savedEntry = null;
  if (!entry.password && entry.id) {
    const saved = loadRegistry().find((m) => m.id === entry.id);
    // 91회차 ⓐ: 저장 경로(host · username 이 바뀌면 비밀을 버린다)와 같은 판정 — 다른 계정명 · 주소로 저장 비밀번호를 보내지 않는다.
    if (saved && accessMoved(saved, body, ['host', 'username'])) return { ok: false, reason: CARRY_MOVED_REASON };
    if (saved) { savedEntry = saved; entry = { ...saved, ...body, password: saved.password, host: saved.host }; } // v2.480(3차 감사 S6): 저장 비밀번호를 물려받는 테스트는 host 도 저장값으로 고정 — body.host 만 공격자 IP 로 바꿔 평문 비밀번호를 받는 경로 차단(PDU S-1 과 같은 규칙)
  }
  const usedSaved = !!savedEntry && String(entry.username || '') === String(savedEntry.username || '');
  if (!entry.host || !entry.username || !entry.password) {
    return { ok: false, reason: 'host/username/password가 필요합니다.' };
  }
  // 전체 점검 33회차 F1 의 형제(P1): 등록(normalize)과 같은 SSRF 정적 가드 — IP 리터럴은 ssrfLookup 을 타지 않는다.
  { const ssrf = ssrfBlockReason(String(entry.host)); if (ssrf) return { ok: false, reason: `host 거부: ${ssrf}` }; }
  const started = Date.now();
  try {
    // 고RTT 블립으로 '연결 안 됨' 오판되지 않도록 일시 오류는 1회 재시도.
    const viaProxy = await retryTransient(async () => {
      const dial = await ensureNsxDial(entry); // proxyId가 있으면 HAProxy 경유로 테스트
      const client = new NsxClient(entry, dial);
      await client.ping();
      return !!dial;
    });
    const authStopCleared = usedSaved ? nsxAuthGuard.clearAuthStop(savedEntry.id) : false;
    return { ok: true, ms: Date.now() - started, viaProxy, ...(authStopCleared ? { authStopCleared: true } : {}) };
  } catch (err) {
    const d = describeError(err);
    return { ok: false, reason: d.message, hint: d.hint, code: d.code, ms: Date.now() - started };
  }
}
