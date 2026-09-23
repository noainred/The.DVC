/**
 * NSX Manager registry — read/write the managed list in CONFIG_DIR/nsx.json,
 * with validation, password redaction, and a connectivity test. Edited through
 * the admin API. The file is written 0600 because it holds credentials.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { ssrfBlockReason } from '../collector/registry.js'; // v2.537: 등록 시 SSRF 정적 가드
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // 자격증명 저장 방식(평문/암호화, v2.296) — 로드 시 복호·저장 시 봉인
import { NsxClient, nsxAuthGuard } from './client.js';
import { ensureNsxDial } from './proxy.js';
import { describeError } from '../util/errors.js';
import { retryTransient } from '../util/resilientFetch.js';
import { accessMoved, dropCarriedSecrets } from '../util/secretCarry.js'; // v2.503: 접속처 변경 시 저장 비밀 폐기(공용 판정)

const FILE = path.join(config.configDir, 'nsx.json');
import { normRequestTimeoutMs } from '../vcenter/soapParse.js'; // v2.598 T2598-03: 요청 시한 [1초, 10분] (0 = 기본값)
import { REGIONS } from '../util/regions.js'; // v2.575 IMP-10 — 단일 소스

export function loadRegistry() {
  if (!fs.existsSync(FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return openSecretsDeep(Array.isArray(parsed?.managers) ? parsed.managers : []); // v2.296 자격증명 복호(메모리 평문)
  } catch (e) {
    // save() 주석대로 손상 시 다음 저장이 빈 목록으로 덮어써 전 NSX 매니저가 유실된다 →
    // 손상본을 .corrupt로 보존해 로드/저장 비대칭(쓰기만 원자적, 로드는 무보존)을 해소.
    preserveCorrupt(FILE, e.message);
    return [];
  }
}

function saveRegistry(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  // 원자적 쓰기 — 자격증명(NSX 매니저 계정/비번) 파일이 부분기록으로 손상되면 로드가 []를
  // 반환하고 다음 저장이 빈 목록으로 덮어써 전 매니저가 영구 유실된다.
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep({ managers: list }), null, 2), { mode: 0o600 }); // 암호화 모드면 password 봉인
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
  const [entry, err] = normalize(body);
  if (err) return { ok: false, reason: err };
  if (list.some((m) => m.id === entry.id)) return { ok: false, reason: `이미 존재하는 id: ${entry.id}` };
  list.push(entry);
  saveRegistry(list);
  return { ok: true, manager: redact(entry) };
}

export function updateManager(id, body) {
  const list = loadRegistry();
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
  const next = list.filter((m) => m.id !== id);
  if (next.length === list.length) return { ok: false, reason: `없는 NSX Manager: ${id}` };
  saveRegistry(next);
  return { ok: true };
}

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
    if (saved) { savedEntry = saved; entry = { ...saved, ...body, password: saved.password, host: saved.host }; } // v2.480(3차 감사 S6): 저장 비밀번호를 물려받는 테스트는 host 도 저장값으로 고정 — body.host 만 공격자 IP 로 바꿔 평문 비밀번호를 받는 경로 차단(PDU S-1 과 같은 규칙)
  }
  const usedSaved = !!savedEntry && String(entry.username || '') === String(savedEntry.username || '');
  if (!entry.host || !entry.username || !entry.password) {
    return { ok: false, reason: 'host/username/password가 필요합니다.' };
  }
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
