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
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // 자격증명 저장 방식(평문/암호화, v2.296) — 로드 시 복호·저장 시 봉인
import { accessMoved, dropCarriedSecrets } from '../util/secretCarry.js';

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

function load() {
  if (cache) return cache;
  try { if (fs.existsSync(FILE)) cache = openSecretsDeep(JSON.parse(fs.readFileSync(FILE, 'utf8'))?.targets || []); } catch { preserveCorrupt(FILE); cache = []; } // v2.296 배포 SSH/토큰 복호 · v2.322 손상본 보존
  if (!Array.isArray(cache)) cache = [];
  return cache;
}

function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep({ targets: cache }), null, 2), { mode: 0o600 }); // 암호화 모드면 password/privateKey/토큰 봉인
  try { fs.chmodSync(FILE, 0o600); } catch { /* mode는 신규생성 시에만 적용 — 덮어쓰기에도 0600 보장 */ }
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

export function saveTarget(body = {}) {
  if (!body.host) return { ok: false, reason: 'host는 필수입니다.' };
  const list = load();
  const existing = body.id ? list.find((t) => t.id === body.id) : null;
  const target = existing || { id: crypto.randomBytes(5).toString('hex'), enabled: true };
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
  if (!existing) list.push(target);
  cache = list; persist();
  // 버린 비밀을 화면이 알 수 있게 알린다 — 조용히 비우면 '배포가 왜 실패하지?' 로 이어진다.
  return { ok: true, target: redact(target), droppedSecrets };
}

export function removeTarget(id) {
  const list = load();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return { ok: false, reason: '대상을 찾을 수 없습니다.' };
  cache = next; persist();
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
