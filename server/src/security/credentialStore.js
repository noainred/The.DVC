/**
 * 통합 계정 관리 저장소(v2.419) — RMA 가 엣지 망 안의 서버에 SSH 로 점검·명령을 실행할 때 쓰는
 * 계정(ID/비밀번호 또는 SSH 키)을 중앙에 **한 곳**에 보관한다.
 *
 * 위협 모델과 설계(정직하게 한계까지):
 *  - 저장: `credentials.json` — secretVault 봉인(SECRET_FILES 등록, password/privateKey/passphrase 는
 *    정책이 '암호화'면 AEAD 암호문), 0600, 원자적 쓰기 + 로드 손상 preserveCorrupt. 키 파일이 같은
 *    호스트에 있으므로 이 암호화는 백업/사본 유출 시 보호(at-rest)다 — 호스트 완전 장악은 못 막는다.
 *  - 읽기 API 는 **비밀 값을 절대 돌려주지 않는다**(hasPassword/hasKey/fingerprint 만). '보기'·
 *    '내보내기' 경로는 만들지 않는다. 백업 아카이브는 설정 소유자 전용(기존 규약)이며 이 파일도 그 안에서만.
 *  - 변경(등록/수정/삭제)은 admin + **OTP 재인증**(로컬 OTP 계정) 또는 설정 소유자(AD 등 OTP 없는 계정) +
 *    감사로그. 비밀 값은 감사·응답·오류 메시지 어디에도 싣지 않는다.
 *  - 사용 범위: `agents`(어느 법인 RMA 가 쓸 수 있나, '*' 허용) + `hosts`(어느 대상 호스트에만, IP/CIDR/
 *    호스트명/`*.suffix`). 브로커(central `/rma-credential`)가 **둘 다** 검사한 뒤에만 내준다 — 엣지 1대가
 *    침해돼도 그 법인에 허용된 계정을, 허용된 대상에만 쓸 수 있다.
 *  - 전달: 잡/스케줄에 비밀을 싣지 않는다. 엣지가 실행 직전에 브로커에서 받아 **메모리에서만** 쓰고
 *    파일에 남기지 않는다(schedule/outbox 파일에도 없음). 사용마다 감사 + useCount/lastUsed 갱신.
 *  - SSH 키는 저장 시 ssh2 로 파싱 검증(형식·패스프레이즈)하고 공개키 SHA-256 지문만 화면에 보인다.
 */
import { strictIpv4Num, cidrMatch } from '../util/ipv4.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ssh2 from 'ssh2';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { registerExitFlush } from '../util/exitFlush.js';
import { openSecretsDeep, sealSecretsDeep } from './secretVault.js';
import { ssrfBlockReason } from '../collector/registry.js';

const FILE = () => path.join(config.configDir, 'credentials.json');
const MAX_ITEMS = 500;
const RE_NAME = /^[^<>"'\x00-\x1f]{1,64}$/; // eslint-disable-line no-control-regex
const RE_USER = /^[A-Za-z0-9._@\\-]{1,64}$/;
const RE_HOST_ENTRY = /^(\*|\*\.[A-Za-z0-9.-]{1,200}|[A-Za-z0-9][A-Za-z0-9.:-]{0,253}(?:\/\d{1,3})?)$/;
const RE_AGENT_ENTRY = /^(\*|[^<>"'\s]{1,64})$/;
export const KINDS = [
  { id: 'password', label: 'ID / 비밀번호' },
  { id: 'key', label: 'SSH 개인키 (+ 패스프레이즈 선택)' },
];

let _db = null;
let seq = 0;

/**
 * 사용 카운터(useCount/lastUsedAt/lastUsedBy)는 **별도 파일**(credentials-usage.json, 비밀 없음)에 디바운스로 쓴다(v2.425).
 * 예전에는 브로커 인출마다 persist() → 전 항목을 새 salt 로 scrypt 재봉인(항목당 200~400ms 동기) → 계정 30개면 요청 1건에
 * 메인 루프 6~25초 정지(리뷰 확정 결함 #1). 비밀 파일은 등록/수정/삭제 때만 다시 쓴다.
 */
const USAGE_FILE = () => path.join(config.configDir, 'credentials-usage.json');
const USAGE_DEBOUNCE_MS = 5_000;
let _usageTimer = null;
function loadUsage() {
  try { if (fs.existsSync(USAGE_FILE())) return JSON.parse(fs.readFileSync(USAGE_FILE(), 'utf8')) || {}; } catch { /* 카운터는 손실 허용 */ }
  return {};
}
function flushUsage() {
  _usageTimer = null;
  const out = {};
  for (const c of load().items) if (c.useCount) out[c.id] = { useCount: c.useCount, lastUsedAt: c.lastUsedAt || null, lastUsedBy: c.lastUsedBy || '' };
  try { atomicWriteFileSync(USAGE_FILE(), JSON.stringify(out), { mode: 0o600 }); } catch { /* 카운터 기록 실패는 사용을 막지 않는다 */ }
}
function scheduleUsagePersist() {
  if (_usageTimer) return;
  _usageTimer = setTimeout(flushUsage, USAGE_DEBOUNCE_MS);
  _usageTimer.unref?.();
}
// v2.590 P13: 종료 직전 5초 디바운스 창의 사용 기록(어느 엣지가 어느 호스트로 인출)을 잃지 않게 동기 flush 를 등록한다
// (v2.582 규약 — 디바운스 저장은 util/exitFlush 에 등록한다. 이 변수명은 그때 스윕 정규식을 빠져나갔다).
registerExitFlush('security/credentialStore.usage', () => { if (_usageTimer) { clearTimeout(_usageTimer); flushUsage(); } });
export function _flushUsageForTest() { if (_usageTimer) { clearTimeout(_usageTimer); _usageTimer = null; } flushUsage(); }

function load() {
  if (_db) return _db;
  try {
    if (fs.existsSync(FILE())) {
      const p = openSecretsDeep(JSON.parse(fs.readFileSync(FILE(), 'utf8')));
      const usage = loadUsage();
      _db = { items: (Array.isArray(p.items) ? p.items : []).map((c) => {
        const u = usage[c.id];
        return u ? { ...c, useCount: Math.max(Number(c.useCount) || 0, Number(u.useCount) || 0), lastUsedAt: u.lastUsedAt || c.lastUsedAt || null, lastUsedBy: u.lastUsedBy || c.lastUsedBy || '' } : c;
      }) };
      return _db;
    }
  } catch { preserveCorrupt(FILE()); }
  _db = { items: [] };
  return _db;
}
function persist() {
  atomicWriteFileSync(FILE(), JSON.stringify(sealSecretsDeep({ version: 1, items: load().items }), null, 2), { mode: 0o600 });
}
const newId = () => `cred_${Date.now().toString(36)}_${(seq++).toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
const lc = (s) => String(s || '').trim().toLowerCase();

/** SSH 개인키 검증 + 공개키 SHA-256 지문(순수). 실패 시 { ok:false, reason }. 비밀은 반환하지 않는다. */
export function inspectPrivateKey(privateKey, passphrase = '') {
  const parsed = ssh2.utils.parseKey(String(privateKey || ''), passphrase || undefined);
  if (parsed instanceof Error) {
    const msg = /passphrase|decrypt|encrypted/i.test(parsed.message) ? '개인키가 암호화되어 있습니다 — 패스프레이즈를 확인하세요.' : `개인키 형식을 읽을 수 없습니다(${parsed.message.slice(0, 80)})`;
    return { ok: false, reason: msg };
  }
  const k = Array.isArray(parsed) ? parsed[0] : parsed;
  let fp = '';
  try { fp = 'SHA256:' + crypto.createHash('sha256').update(k.getPublicSSH()).digest('base64').replace(/=+$/, ''); } catch { fp = ''; }
  return { ok: true, type: k.type || '', fingerprint: fp, comment: k.comment || '' };
}

/** 대상 호스트 허용 판정(순수) — IP/CIDR(IPv4)/정확 호스트명/`*.suffix`/`*`. 목록이 비면 거부(안전 기본). */
export function hostAllowed(host, list) {
  const h = lc(host).replace(/^::ffff:/, '');
  if (!h || !Array.isArray(list) || !list.length) return false;
  // v2.589: 비정규 IPv4(선행 0 → 8진 해석)는 거부 — 볼트 비밀이 허용 대역 밖으로 나가지 않게(util/ipv4 단일 소스).
  const n = strictIpv4Num(h);
  if (n === false) return false;
  for (const raw of list) {
    const e = lc(raw);
    if (e === '*') return true;
    if (e.startsWith('*.')) { if (h.endsWith(e.slice(1)) && h.length > e.length - 1) return true; continue; }
    if (e.includes('/')) {
      if (n != null && cidrMatch(n, e) === true) return true;
      continue;
    }
    if (e === h) return true;
  }
  return false;
}
export function agentAllowed(agent, list) {
  const a = lc(agent);
  return Array.isArray(list) && list.some((x) => lc(x) === '*' || lc(x) === a);
}

const publicView = (c) => ({
  id: c.id, name: c.name, kind: c.kind, username: c.username, hosts: c.hosts || [], agents: c.agents || [], note: c.note || '',
  hasPassword: !!c.password, hasKey: !!c.privateKey, hasPassphrase: !!c.passphrase, keyType: c.keyType || '', fingerprint: c.fingerprint || '',
  createdBy: c.createdBy || '', createdAt: c.createdAt || null, updatedAt: c.updatedAt || null, updatedBy: c.updatedBy || '',
  lastUsedAt: c.lastUsedAt || null, lastUsedBy: c.lastUsedBy || '', useCount: c.useCount || 0,
});

export function listCredentials() { return load().items.map(publicView); }
export function getCredentialView(id) { const c = load().items.find((x) => x.id === id); return c ? publicView(c) : null; }

/** 입력 검증(순수). 오류면 사유. */
export function credentialInputIssue(input = {}, { existing = null } = {}) {
  if (!RE_NAME.test(String(input.name || '').trim())) return '이름 형식 오류(1~64자, <>"\' 금지)';
  if (!KINDS.some((k) => k.id === input.kind)) return '종류는 password(ID/비밀번호) 또는 key(SSH 키)';
  if (!RE_USER.test(String(input.username || '').trim())) return '계정(ID) 형식 오류(영숫자·._@\\-, 64자 이내)';
  const secretGiven = (v) => v != null && String(v) !== '';
  for (const f of ['password', 'privateKey', 'passphrase']) if (secretGiven(input[f]) && /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(String(input[f]))) return `${f} 에 제어문자가 포함되어 있습니다.`; // eslint-disable-line no-control-regex
  if (input.kind === 'password' && !secretGiven(input.password) && !existing?.password) return '비밀번호를 입력하세요.';
  if (input.kind === 'key' && !secretGiven(input.privateKey) && !existing?.privateKey) return 'SSH 개인키를 입력하세요.';
  if (secretGiven(input.password) && String(input.password).length > 512) return '비밀번호는 512자 이내';
  if (secretGiven(input.privateKey) && String(input.privateKey).length > 16 * 1024) return '개인키는 16KB 이내';
  const hosts = listOf(input.hosts), agents = listOf(input.agents);
  if (!hosts.length) return '대상 호스트 허용 목록을 1개 이상 지정하세요(IP/CIDR/호스트명/*.suffix, 전체 허용은 *).';
  for (const h of hosts) if (!RE_HOST_ENTRY.test(h)) return `대상 호스트 항목 형식 오류: ${h.slice(0, 40)}`;
  for (const h of hosts) if (h !== '*' && !h.startsWith('*.') && !h.includes('/')) { const r = ssrfBlockReason(`https://${h}`); if (r) return `대상 호스트 차단(${h}): ${r}`; }
  if (!agents.length) return '사용 가능한 법인(RMA)을 1개 이상 지정하세요(전체는 *).';
  for (const a of agents) if (!RE_AGENT_ENTRY.test(a)) return `법인 항목 형식 오류: ${a.slice(0, 40)}`;
  if (input.note != null && String(input.note).length > 300) return '메모는 300자 이내';
  return null;
}
export const listOf = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\s]+/)).map((x) => String(x).trim()).filter(Boolean);

/** 등록/수정. 비밀 필드가 비어 있으면 기존 값 유지. 반환은 공개 뷰(비밀 없음). */
export function saveCredential(input = {}, { actor = '' } = {}) {
  const db = load();
  const existing = input.id ? db.items.find((x) => x.id === input.id) : null;
  if (input.id && !existing) throw new Error('계정을 찾을 수 없습니다.');
  const issue = credentialInputIssue(input, { existing });
  if (issue) throw new Error(issue);
  const now = Date.now();
  const rec = existing || { id: newId(), createdAt: now, createdBy: actor, useCount: 0 };
  rec.name = String(input.name).trim(); rec.kind = input.kind; rec.username = String(input.username).trim();
  rec.hosts = listOf(input.hosts); rec.agents = listOf(input.agents); rec.note = String(input.note || '').slice(0, 300);
  if (input.kind === 'password') {
    if (input.password != null && input.password !== '') rec.password = String(input.password);
    delete rec.privateKey; delete rec.passphrase; delete rec.fingerprint; delete rec.keyType;
  } else {
    const keyGiven = input.privateKey != null && input.privateKey !== '';
    const key = keyGiven ? String(input.privateKey) : rec.privateKey;
    const pass = input.passphrase != null && input.passphrase !== '' ? String(input.passphrase) : (keyGiven ? '' : (rec.passphrase || ''));
    const insp = inspectPrivateKey(key, pass);
    if (!insp.ok) throw new Error(insp.reason);
    rec.privateKey = key; if (pass) rec.passphrase = pass; else delete rec.passphrase;
    rec.fingerprint = insp.fingerprint; rec.keyType = insp.type;
    delete rec.password;
  }
  rec.updatedAt = now; rec.updatedBy = actor;
  if (!existing) { if (db.items.length >= MAX_ITEMS) throw new Error(`계정은 최대 ${MAX_ITEMS}개`); db.items.push(rec); }
  persist();
  return publicView(rec);
}

export function deleteCredential(id) {
  const db = load();
  const i = db.items.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const [gone] = db.items.splice(i, 1);
  persist();
  return publicView(gone);
}

/**
 * 브로커 인출 — 이 agent 가 이 host 에 쓸 수 있는 계정인지 검사한 뒤 **비밀을 포함한** 사본을 돌려준다.
 * 호출자(central 라우트)는 개별 토큰 agent 모드에서만 부르고, 응답을 로그에 남기지 않는다.
 * 반환 { ok, secret:{ kind, username, password?, privateKey?, passphrase? }, name } | { ok:false, reason }.
 */
export function brokerFetch(id, { agent, host }) {
  const c = load().items.find((x) => x.id === id);
  if (!c) return { ok: false, reason: '계정을 찾을 수 없습니다(삭제됨).' };
  if (!agentAllowed(agent, c.agents)) return { ok: false, reason: `계정 '${c.name}' 은 법인 '${agent}' 에 허용되지 않았습니다.` };
  if (!hostAllowed(host, c.hosts)) return { ok: false, reason: `계정 '${c.name}' 은 대상 '${host}' 에 허용되지 않았습니다.` };
  c.useCount = (c.useCount || 0) + 1; c.lastUsedAt = Date.now(); c.lastUsedBy = `${agent}→${host}`;
  scheduleUsagePersist(); // 비밀 파일 재봉인 없이 카운터만 디바운스 저장(v2.425)
  const secret = { kind: c.kind, username: c.username };
  if (c.kind === 'password') secret.password = c.password || '';
  else { secret.privateKey = c.privateKey || ''; if (c.passphrase) secret.passphrase = c.passphrase; }
  return { ok: true, name: c.name, secret };
}

/** 중앙 사전 검사(비밀 없음) — 실행 요청 시 이 agent/host 조합이 허용되는지. */
export function credentialUsable(id, { agent, host }) {
  const c = load().items.find((x) => x.id === id);
  if (!c) return { ok: false, reason: '계정을 찾을 수 없습니다.' };
  if (!agentAllowed(agent, c.agents)) return { ok: false, reason: `계정 '${c.name}' 은 법인 '${agent}' 에 허용되지 않았습니다.` };
  if (host && !hostAllowed(host, c.hosts)) return { ok: false, reason: `계정 '${c.name}' 은 대상 '${host}' 에 허용되지 않았습니다.` };
  return { ok: true, name: c.name, kind: c.kind, username: c.username };
}

export function _resetCredentials() { _db = null; }
