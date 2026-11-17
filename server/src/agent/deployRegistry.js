/**
 * Saved agent-deploy targets (CONFIG_DIR/agent-deploy-targets.json, 0600) so a
 * datacenter host's SSH + agent settings can be stored once and (re)deployed —
 * individually or in bulk — without re-entering everything each time.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeJsonFileReader } from '../util/jsonFileLoad.js'; // 85회차 F1: 읽기 오류 ≠ 손상(공용 판정)
import { corruptOnlyReason } from '../util/registryCore.js'; // 87회차 ⓐ(85 결정): 손상 상태도 등록부 규칙(결정 78 ①)과 같게
import { capStr } from '../util/capStr.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // 자격증명 저장 방식(평문/암호화, v2.296) — 로드 시 복호·저장 시 봉인
import { accessMoved, dropCarriedSecrets } from '../util/secretCarry.js';
import { envPairs, envPairsIssue } from './deploy.js';

const FILE = path.join(config.configDir, 'agent-deploy-targets.json');
/**
 * 응답에서 가리고, 저장 시 '빈 값 = 기존 유지' 로 다루는 비밀 필드.
 * v2.435: `centralToken`·`collectorToken` 추가(감사 지적) — 예전에는 두 토큰이 `GET /agent-deploy/targets`
 * 응답과 저장 응답에 **평문으로** 실려 나갔다. 중앙 토큰이 새면 그 토큰을 가진 누구나 엣지→중앙 API 를
 * 호출할 수 있고, 수집 토큰이 새면 그 엣지의 수집 데이터를 그대로 당겨갈 수 있다.
 * 화면은 `hasCentralToken`/`hasCollectorToken` 플래그로 저장 여부만 보고, 빈 값을 보내면 기존 값이 유지된다.
 */
const SECRET_KEYS = ['password', 'privateKey', 'centralToken', 'collectorToken'];
const FIELDS = ['host', 'port', 'username', 'password', 'privateKey', 'agentName',
  'centralUrl', 'centralToken', 'collectorToken', 'collectorDatacenter', 'installerPath', 'portalPort', 'autoUpgrade', 'pushInventory', 'enabled', 'advertiseUrl'];

let cache = null;

/*
 * 85회차 F1(재현 — EACCES): 예전 load() 는 읽기 · 파싱 · 복호를 catch 하나로 받아 **읽기 오류**(EACCES · EIO · EISDIR)도 손상으로 보고
 *   온전한 원본(SSH root 비밀번호 · CENTRAL_TOKEN · COLLECTOR_TOKEN)을 `.corrupt.<시각>` 으로 옮긴 뒤 빈 목록으로 돌았다 — 화면은 대상 0개였고,
 *   다음 저장(대상 추가 · 대량 배포 저장 · 토큰 자동 적용의 배포 기록 맞춤)이 그 한 건만 든 파일을 썼다(나머지는 보존본에만).
 *   이제 공용 판정(util/jsonFileLoad.js)으로 가른다 — 읽기 오류는 원본을 두고 · 캐시하지 않고(30초 간격으로 다시 읽는다) · 그동안 쓰기를
 *   거절한다(code 'registry-unreadable'). 손상(파싱 실패)은 예전처럼 보존본으로 옮기고 빈 목록에서 시작한다(v2.322 규칙 그대로).
 */
const _reader = makeJsonFileReader(() => FILE, { parse: (t) => JSON.parse(t), preserve: false, tag: 'agent-deploy' });
let _readErr = null;   // { at, code } — 읽기 오류가 서 있는 동안만
/*
 * 87회차 ⓐ(85회차 결정 — 권장안: 등록부 결정 78 ① 과 같은 규칙): 손상(파싱 실패)도 **표지**를 세운다 — 예전에는 보존본으로 옮긴 뒤 아무 표지 없이 빈 목록이라
 *   화면이 '저장된 대상 0개' 였고, 토큰 자동 적용의 '배포 기록 맞춤'(자동 경로)이 그 엣지 하나만 든 새 등록부를 써 손상 사실까지 지웠다.
 *   규칙: 손상 · 보존본만 남음(재시작 뒤)은 표지 유지 → 관리자 저장(화면 · CSV · 배포 저장)은 새 등록부를 만들며 표지를 푼다(v2.612 규약) ·
 *   자동 경로(`saveTarget(body, { auto: true })`)는 거절한다(registryCore autoWriteRefusal 과 같은 뜻). 읽기 오류는 위 85 F1 그대로(모든 쓰기 거절).
 */
let _corruptErr = null;   // { at, code:'corrupt'|'corrupt-only' } — 관리자 저장이 풀 때까지

function load() {
  if (cache) return cache;
  const r = _reader.read();
  if (r.kind === 'read-error') {
    _readErr = { at: _readErr?.at || Date.now(), code: capStr(r.error?.code, 32) || 'read-error' };
    return [];   // 캐시하지 않는다 — 이 빈 목록 위의 쓰기는 writeRefusal 이 막는다
  }
  _readErr = null;
  if (r.kind === 'corrupt') preserveCorrupt(FILE, r.error?.message); // v2.322 손상본 보존
  if (r.kind === 'corrupt') _corruptErr = { at: Date.now(), code: 'corrupt' };   // 87회차 ⓐ: 표지
  else if (r.kind === 'missing' && !_corruptErr) { let why = null; try { why = corruptOnlyReason(FILE); } catch { why = null; } if (why) _corruptErr = { at: Date.now(), code: 'corrupt-only' }; }
  cache = r.kind === 'ok' ? openSecretsDeep(r.value?.targets || []) : []; // v2.296 배포 SSH/토큰 복호
  if (!Array.isArray(cache)) cache = [];
  return cache;
}

/** 85회차 F1: 등록부를 읽지 못한 동안의 쓰기 거절(읽을 수 있으면 null). */
function writeRefusal() {
  load();
  if (!_readErr) return null;
  return { ok: false, code: 'registry-unreadable', reason: `배포 대상 등록부(agent-deploy-targets.json)를 읽지 못했습니다(${_readErr.code}) — 원본을 그대로 두고 저장하지 않았습니다. 파일 권한 · 디스크를 확인하세요(30초마다 다시 읽습니다)` };
}
/**
 * 85회차 F1: 지금 읽기 오류({ at, code, readError:true }) 또는 null — 화면 · 진단이 '대상 0개' 를 사실대로 말하게.
 * 87회차 ⓐ: 손상 · 보존본만 남음도 싣는다({ at, code:'corrupt'|'corrupt-only', corrupt:true } — 관리자 저장이 풀 때까지).
 */
export function deployTargetsLoadError() {
  load();
  if (_readErr) return { ..._readErr, readError: true };
  return _corruptErr ? { ..._corruptErr, corrupt: true } : null;
}
/** 87회차 ⓐ: 자동 경로의 쓰기 거절(손상 · 보존본만 남음 동안) — 관리자 저장만 새 등록부를 만든다. */
function autoWriteRefusal() {
  if (!_corruptErr) return null;
  return { ok: false, code: 'registry-unreadable', reason: `배포 대상 등록부(agent-deploy-targets.json)가 손상돼 보존본(.corrupt.*)으로 옮겨진 상태라 자동으로 저장하지 않았습니다 — 보존본을 되돌리고 재시작하거나, 설정 › Edge 노드 포탈 설치에서 대상을 다시 저장하세요(관리자 저장이 새 등록부를 만듭니다).` };
}

function persist() {
  if (_readErr) throw Object.assign(new Error('배포 대상 등록부를 읽지 못한 상태라 저장하지 않습니다(원본 보호)'), { code: 'registry-unreadable' }); // 85회차 F1: 마지막 방어선
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep({ targets: cache }), null, 2), { mode: 0o600 }); // 암호화 모드면 password/privateKey/토큰 봉인
  try { fs.chmodSync(FILE, 0o600); } catch { /* mode는 신규생성 시에만 적용 — 덮어쓰기에도 0600 보장 */ }
  _corruptErr = null;   // 87회차 ⓐ: 저장 성공이 손상 표지를 푼다(자동 경로는 위 autoWriteRefusal 이 여기 오기 전에 막는다)
}

const redact = (t) => {
  const out = { ...t };
  for (const k of SECRET_KEYS) { out[`has${k[0].toUpperCase()}${k.slice(1)}`] = !!t[k]; delete out[k]; }
  // gpuGuest는 enabled/대상/계정은 보여주되 비밀번호는 가린다(has* 플래그로 저장 여부만 표시).
  if (t.gpuGuest && typeof t.gpuGuest === 'object') {
    const g = t.gpuGuest;
    out.gpuGuest = {
      ...g,
      vcenterPass: '', guestPass: '',
      hasVcenterPass: !!g.vcenterPass, hasGuestPass: !!g.guestPass,
    };
  }
  return out;
};

export function listTargets() { return load().map(redact); }
export function getTargetRaw(id) { return load().find((t) => t.id === id) || null; }
// CSV 내보내기(비밀 포함, v2.339) 전용 원본 목록 — 호출부가 requireSettingsOwner + 감사로그 책임.
export function listTargetsRaw() { return structuredClone(load()); }
// 같은 호스트(+SSH포트/계정)로 저장된 대상 — 배포 시 중복 생성 없이 기존 대상을 upsert 하기 위함.
export function findTargetByHost(host, port, username) {
  const h = String(host || '').trim();
  if (!h) return null;
  return load().find((t) => String(t.host || '').trim() === h
    && String(t.port || 22) === String(port || 22)
    && String(t.username || '') === String(username || '')) || null;
}

export function saveTarget(body = {}, { auto = false } = {}) {
  if (!body.host) return { ok: false, reason: 'host는 필수입니다.' };
  const refused = writeRefusal(); if (refused) return refused;   // 85회차 F1
  if (auto) { const ar = (load(), autoWriteRefusal()); if (ar) return ar; }   // 87회차 ⓐ: 손상 동안 자동 경로(토큰 자동 적용의 배포 기록 맞춤)는 쓰지 않는다
  const list = load();
  const existing = body.id ? list.find((t) => t.id === body.id) : null;
  // 85회차 F2(v2.879 F4 가 '기존 동작' 으로 남긴 것): 캐시 객체를 직접 고치지 않고 사본 위에서 고친다 — 저장이 실패하면(ENOSPC · 봉인 정책 잠금)
  //   예전에는 메모리만 새 값(새 host · 버린 비밀 · 새 토큰)인 채 남아 '실패' 응답 뒤에도 대상 표 · 배포 · 상태 확인이 그 값을 썼다(재시작하면 되돌아감).
  const target = existing ? structuredClone(existing) : { id: crypto.randomBytes(5).toString('hex'), enabled: true };
  // v2.601(감사 LO2601-01): 저장 시점에 env 블록 주입을 거부한다 — 값에 개행·NUL 이 있으면 배포 때 원격 portal.env 에
  // 새 키 줄이 생긴다. **병합 전**에 본다(existing 은 캐시 객체라 병합 뒤 거부하면 메모리 값이 이미 바뀐 채 남는다).
  const envIssue = envPairsIssue(envPairs({ ...(existing || {}), ...body }, 0));
  if (envIssue) return { ok: false, reason: envIssue };
  // ⚠ 보안(v2.500 감사 H1): SSH 접속처가 바뀌면 승계된 비밀을 버린다 — 판정은 **필드 병합 전**에
  // 해야 한다(병합 후에는 이전 값을 알 수 없다). 이 검사가 없던 v2.339~2.499 는
  // `{id:<기존>, host:'attacker', password:''}` 저장 후 상태확인/배포만 부르면 저장된 root 비밀번호와
  // CENTRAL_TOKEN·COLLECTOR_TOKEN 이 공격자 호스트로 나갔다. 규칙 설명은 util/secretCarry.js.
  const moved = accessMoved(existing, body, ['host', 'port', 'username']);
  for (const k of FIELDS) {
    if (body[k] === undefined) continue;
    // keep stored secret when UI sends an empty/redacted value
    if (SECRET_KEYS.includes(k) && (body[k] === '' || body[k] === '********')) continue;
    target[k] = body[k];
  }
  const droppedSecrets = moved ? dropCarriedSecrets(target, body, SECRET_KEYS) : [];
  // gpuGuest(중첩 객체) 병합 — 'GPU 게스트 수집 자동 구성' 체크/계정을 보존한다.
  // 비밀번호(vcenterPass/guestPass)는 비거나 redacted(********)면 기존 저장값을 유지(편집 시 안 지워짐).
  if (body.gpuGuest && typeof body.gpuGuest === 'object') {
    const prev = target.gpuGuest || {};
    const g = body.gpuGuest;
    // 같은 규칙(v2.500 A/H-2): vCenter 접속처가 바뀌면 그 비밀번호를 승계하지 않는다 —
    // vcenterHost 만 바꿔 저장하고 배포하면 저장 비번이 그 호스트로 나간다.
    const vcHostChanged = g.vcenterHost !== undefined
      && String(g.vcenterHost || '').trim().toLowerCase() !== String(prev.vcenterHost || '').trim().toLowerCase();
    const keepSecret = (nv, ov) => ((nv && nv !== '' && nv !== '********') ? nv : (vcHostChanged ? '' : (ov || '')));
    target.gpuGuest = {
      enabled: !!g.enabled,
      vcenterId: g.vcenterId !== undefined ? g.vcenterId : (prev.vcenterId || ''),
      vcenterName: g.vcenterName !== undefined ? g.vcenterName : (prev.vcenterName || ''),
      vcenterHost: g.vcenterHost !== undefined ? g.vcenterHost : (prev.vcenterHost || ''),
      vcenterUser: g.vcenterUser !== undefined ? g.vcenterUser : (prev.vcenterUser || ''),
      vcenterPass: keepSecret(g.vcenterPass, prev.vcenterPass),
      guestUser: g.guestUser !== undefined ? g.guestUser : (prev.guestUser || ''),
      guestPass: keepSecret(g.guestPass, prev.guestPass),
    };
  }
  cache = existing ? list.map((t) => (t === existing ? target : t)) : [...list, target];
  try { persist(); } catch (e) { cache = list; throw e; }   // 85회차 F2: 쓰기가 실패하면 메모리도 그대로
  // 버린 비밀을 화면이 알 수 있게 알린다 — 조용히 비우면 '배포가 왜 실패하지?' 로 이어진다.
  return { ok: true, target: redact(target), droppedSecrets };
}

/**
 * v2.879(2026-11-04 사용자 요청 '다르게 들어간 Agent 명을 수정할 수 있는 기능' — Bareos 완전 설치 '등록부 대상 연결'): 저장된 대상의
 *   **agentName 하나만** 바꾼다. SSH 주소 · 계정 · 비밀 · 토큰은 그대로이고(접속처가 바뀌지 않으므로 비밀 폐기 규칙 accessMoved 대상이 아니다),
 *   수집 서버 등록부는 건드리지 않는다 — 저장 라우트의 자동 등록은 이름에서 수집 서버 id 를 만들어 이름이 바뀌면 하나를 더 만든다.
 *   expect 를 주면 지금 이름이 그 값일 때만 바꾼다(화면이 본 뒤 그사이 바뀌었으면 conflict). 이름 검증은 호출자 몫(인증된 엣지 이름)이지만
 *   배포 때 portal.env 에 들어가는 값이라 개행 · NUL · 길이만큼은 여기서도 막는다(LO2601-01 과 같은 판정).
 * @returns {{ ok:true, before:string, target:object } | { ok:false, code:'not-found'|'conflict'|'invalid'|'registry-unreadable', reason:string }}
 */
export function setTargetAgentName(id, name, { expect } = {}) {
  const refused = writeRefusal() || autoWriteRefusal(); if (refused) return refused;   // 85회차 F1(예전에는 빈 목록이라 '찾을 수 없음' 으로 말했다) · 87회차 ⓐ: 손상 동안도 '찾을 수 없음' 이 아니다
  const list = load();
  const t = list.find((x) => x.id === id);
  if (!t) return { ok: false, code: 'not-found', reason: '배포 대상을 찾을 수 없습니다(그사이 지워졌을 수 있습니다).' };
  const before = String(t.agentName || '');
  if (expect !== undefined && before !== String(expect ?? '')) {
    return { ok: false, code: 'conflict', reason: `이 배포 대상의 에이전트 이름이 그사이 '${before || '(없음)'}' 로 바뀌었습니다 — 화면을 다시 읽고 고르세요.` };
  }
  const v = String(name ?? '').trim();
  if (!v || v.length > 128) return { ok: false, code: 'invalid', reason: '에이전트 이름이 비었거나 너무 깁니다.' };
  const envIssue = envPairsIssue(envPairs({ ...t, agentName: v }, 0));
  if (envIssue) return { ok: false, code: 'invalid', reason: envIssue };
  t.agentName = v;
  cache = list;
  // 반증 F4(재현 — ENOSPC): 쓰기가 실패하면 메모리 값도 되돌린다. 예전 판은 캐시만 바뀐 채 남아 '실패' 응답 뒤에도 대상 표 · 설치가 새 이름을 읽었다
  //   (재시작하면 되돌아가는 보고 불일치). saveTarget · removeTarget 에 남아 있던 같은 패턴은 85회차 F2 가 고쳤다.
  try { persist(); } catch (e) { t.agentName = before; throw e; }
  return { ok: true, before, target: redact(t) };
}

export function removeTarget(id) {
  const refused = writeRefusal(); if (refused) return refused;   // 85회차 F1
  const list = load();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return { ok: false, reason: '대상을 찾을 수 없습니다.' };
  cache = next;
  try { persist(); } catch (e) { cache = list; throw e; }   // 85회차 F2
  return { ok: true };
}

export function recordResult(id, result) {
  const t = getTargetRaw(id);
  if (!t) return;
  t.lastResult = { at: Date.now(), ok: result.ok, active: result.active, reason: result.reason };
  persist();
}

/**
 * 강제 동기화 SSH 대상 선택(순수, v2.428 — 구성도 미스매치 #3). 같은 host 를 쓰는 배포 대상이 둘 이상이면(Edge DVC :22 와
 * 포워딩 경유 IRS :4067) 자동 선택하지 않고 후보를 돌려준다 — 예전에는 먼저 저장된 Edge DVC 로 SSH 해 IRS 토큰을 A 에 적용했다.
 * @returns { ok, target, viaRelay } | { ok:false, reason, candidates? }
 */
export function pickSshTarget(targets, host, sshTargetId = '') {
  const same = targets.filter((t) => t && String(t.host || '').trim() === host);
  if (sshTargetId) {
    const t = same.find((x) => String(x.id) === String(sshTargetId));
    if (!t) return { ok: false, reason: `지정한 SSH 대상(${sshTargetId})이 host ${host} 의 저장 대상에 없습니다.` };
    return { ok: true, target: t, viaRelay: Number(t.port || 22) !== 22 || same.length > 1 };
  }
  if (!same.length) return { ok: false, reason: `SSH 배포 대상에 ${host} 가 없습니다. '수집 서버 → 원격 법인(DC)에 Edge 노드 포탈 설치'에서 이 호스트를 먼저 저장(SSH 계정 포함)하세요.` };
  if (same.length > 1) {
    return { ok: false, reason: `host ${host} 를 쓰는 SSH 대상이 ${same.length}개입니다(중계 엣지와 포워딩 경유 장비). 어느 장비의 토큰을 바꿀지 sshTargetId 로 지정하세요.`,
      candidates: same.map((t) => ({ id: t.id, host: t.host, port: Number(t.port || 22), agentName: t.agentName || '', portalPort: Number(t.portalPort) || 4000 })) };
  }
  return { ok: true, target: same[0], viaRelay: Number(same[0].port || 22) !== 22 };
}
