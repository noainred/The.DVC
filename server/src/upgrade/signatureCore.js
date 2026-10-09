/**
 * upgrade/signatureCore.js — 릴리스 서명 manifest 의 형식·서명·검증 코어(검토 S-10, v2.730). **순수**(node 내장만).
 *
 * 왜: 업그레이드 번들의 sha256 은 **같은 채널**(versions.json · push 헤더)에서 온다. 메타데이터와 번들을 함께
 * 바꿀 수 있는 쪽(미러·배포 토큰 탈취·http 중간자)은 두 값을 맞춰 보낼 수 있다 — 재현: 교체한 번들과 그 새 sha 를
 * 함께 넣으면 downloadArchive 가 받아들였다. sha 는 '전송 손상' 을 잡을 뿐 **배포자를 인증하지 않는다.**
 * 그래서 CI 가 보호된 배포 키(Ed25519)로 manifest 에 서명하고, 수신측은 **고정된 신뢰 공개키**로 설치 전에 검증한다.
 *
 * 이 모듈 하나를 세 곳이 쓴다 — ① 서버 런타임(upgrade/signature.js) ② 오프라인 확인 도구(upgrade/verifyCli.js)
 * ③ CI 서명 스크립트(scripts/release-sign.mjs, 서명 직후 같은 함수로 자기 검증). 서명·검증이 갈라지지 않게.
 * ⚠ 이 모듈은 **개인키를 읽거나 저장하지 않는다** — `signManifest` 는 호출자가 넘긴 KeyObject 로 서명만 한다.
 *
 * ── 형식 ──────────────────────────────────────────────────────────────────────────────────────────────
 * manifest 파일(`vmware-portal-<버전>.manifest.json`)은 **봉투(envelope)** 다:
 *   { "format":"vmware-portal-release-manifest", "v":1, "alg":"ed25519", "keyId":"ed25519:<16hex>",
 *     "payload":"<base64(JSON 바이트)>", "signature":"<base64(Ed25519 서명 64바이트)>" }
 * 서명 대상은 **payload 바이트 그대로**다(JSON 정규화를 하지 않는다 — 다시 직렬화하면 서명이 깨질 수 있다).
 * payload JSON: { format, v, product:"vmware-portal", version, createdAt, keyId,
 *                 files:[{ name, kind, platform, size, sha256 }] }
 *
 * ── 신뢰 키 파일 ────────────────────────────────────────────────────────────────────────────────────────
 *   { "format":"vmware-portal-release-keys", "schema":1,
 *     "keys":[{ "keyId":"ed25519:<16hex>", "publicKey":"<base64(SPKI DER)>", "addedAt":"…", "note":"…",
 *               "revoked":false, "revokedAt":null, "revokedReason":"" }],
 *     "revoked":["ed25519:<16hex>", …] }   ← 키 없이 회수만 적는 목록(호스트 파일용)
 * keyId 는 공개키(SPKI DER)의 sha256 앞 16자리다 — 파일에 적힌 keyId 가 공개키와 맞지 않으면 그 항목을 버린다
 * (이름표만 바꿔 다른 키를 그 이름으로 신뢰하게 만들 수 없다).
 */

import crypto from 'node:crypto';

export const MANIFEST_FORMAT = 'vmware-portal-release-manifest';
export const KEYS_FORMAT = 'vmware-portal-release-keys';
export const MANIFEST_V = 1;
export const PRODUCT = 'vmware-portal';
/** manifest 봉투 크기 상한(바이트) — 파일 수십 개여도 수 KB 다. */
export const MANIFEST_MAX_BYTES = 65536;
export const MAX_FILES = 64;
export const KEY_ID_RE = /^ed25519:[0-9a-f]{16}$/;
export const VERSION_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
export const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;
export const KINDS = Object.freeze(['bundle', 'installer', 'installer_cent9', 'windows', 'other']);
const SHA_RE = /^[0-9a-f]{64}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** 이 manifest 파일 이름(버전마다 하나 — 그 버전의 모든 산출물을 담는다). */
export const manifestNameFor = (version) => `${PRODUCT}-${version}.manifest.json`;
export const MANIFEST_NAME_RE = /^vmware-portal-(\d{1,9}\.\d{1,9}\.\d{1,9})\.manifest\.json$/;

/**
 * 판정 코드. CANNOT_VERIFY 는 '확인할 수 없음'(정책이 warn 이면 경고 후 진행), 그 밖은 **확인했더니 틀림**이라
 * 정책과 무관하게 거부한다(warn 탈출구는 '서명이 없는 소스' 를 위한 것이지 '틀린 서명' 을 받기 위한 것이 아니다).
 */
export const CANNOT_VERIFY = Object.freeze(new Set(['no-trusted-keys', 'trust-unreadable', 'manifest-missing', 'manifest-unavailable', 'unknown-key']));

/** 엄격한 base64 해석 — 다시 인코딩해 같을 때만(느슨한 Buffer.from 은 쓰레기 문자를 건너뛴다). */
export function strictBase64(s, maxLen = 1 << 20) {
  if (typeof s !== 'string' || !s || s.length > maxLen || s.length % 4 !== 0 || !B64_RE.test(s)) return null;
  const buf = Buffer.from(s, 'base64');
  return buf.toString('base64') === s ? buf : null;
}

export const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 공개키(KeyObject)의 keyId — SPKI DER 의 sha256 앞 16자리. */
export function keyIdOf(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return `ed25519:${sha256Hex(der).slice(0, 16)}`;
}
/** 공개키 → 키 파일에 적는 base64(SPKI DER). */
export const spkiBase64Of = (publicKey) => publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

/** base64(SPKI DER) → Ed25519 공개키 KeyObject. 아니면 null. */
export function publicKeyFromBase64(b64) {
  const der = strictBase64(b64, 4096);
  if (!der) return null;
  try {
    const k = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return k.asymmetricKeyType === 'ed25519' ? k : null;
  } catch { return null; }
}

/**
 * 신뢰 키 문서 하나를 읽는다(순수). 잘못된 항목은 버리고 `errors` 에 사유를 남긴다.
 * @returns {{ keys: object[], revokedIds: Set<string>, errors: string[] }}
 */
export function parseKeysDoc(doc, source = 'keys') {
  const out = { keys: [], revokedIds: new Set(), errors: [] };
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) { out.errors.push(`${source}: 객체가 아닙니다`); return out; }
  if (doc.format != null && doc.format !== KEYS_FORMAT) out.errors.push(`${source}: format 이 ${KEYS_FORMAT} 가 아닙니다`);
  const keys = doc.keys == null ? [] : doc.keys;
  if (!Array.isArray(keys)) { out.errors.push(`${source}: keys 가 배열이 아닙니다`); return out; }
  if (keys.length > 64) out.errors.push(`${source}: 키가 ${keys.length}개 — 앞 64개만 읽습니다`);
  for (const [i, k] of keys.slice(0, 64).entries()) {
    if (!k || typeof k !== 'object') { out.errors.push(`${source}: keys[${i}] 가 객체가 아닙니다`); continue; }
    const pub = publicKeyFromBase64(k.publicKey);
    if (!pub) { out.errors.push(`${source}: keys[${i}] 공개키를 읽지 못했습니다(Ed25519 SPKI DER base64 가 아님)`); continue; }
    const id = keyIdOf(pub);
    if (k.keyId != null && k.keyId !== id) { out.errors.push(`${source}: keys[${i}] keyId(${String(k.keyId).slice(0, 40)})가 공개키(${id})와 맞지 않아 버렸습니다`); continue; }
    out.keys.push({
      keyId: id, publicKey: pub, spki: k.publicKey,
      revoked: k.revoked === true, revokedAt: typeof k.revokedAt === 'string' ? k.revokedAt.slice(0, 40) : null,
      revokedReason: typeof k.revokedReason === 'string' ? k.revokedReason.slice(0, 200) : '',
      addedAt: typeof k.addedAt === 'string' ? k.addedAt.slice(0, 40) : null,
      note: typeof k.note === 'string' ? k.note.slice(0, 200) : '',
      source,
    });
    if (k.revoked === true) out.revokedIds.add(id);
  }
  const rv = doc.revoked == null ? [] : doc.revoked;
  if (!Array.isArray(rv)) out.errors.push(`${source}: revoked 가 배열이 아닙니다`);
  else for (const id of rv.slice(0, 256)) { if (typeof id === 'string' && KEY_ID_RE.test(id)) out.revokedIds.add(id); else out.errors.push(`${source}: revoked 항목 형식이 틀렸습니다`); }
  return out;
}

/**
 * 여러 키 문서를 합친다 — 키는 합집합, **회수는 어느 출처든 이긴다**(호스트 파일이 저장소 키를 회수할 수 있고,
 * 저장소에서 회수한 키를 호스트 파일이 되살릴 수 없다).
 * @returns {{ byId: Map<string,object>, activeCount:number, revokedCount:number, errors:string[] }}
 */
export function mergeTrust(parsedDocs) {
  const byId = new Map();
  const revoked = new Set();
  const errors = [];
  for (const p of parsedDocs) {
    if (!p) continue;
    for (const er of p.errors) errors.push(er); // 순수 모듈(내장만) — util/pushAll.js 를 끌어오지 않는다(스프레드 금지 규약 audit2603a)
    for (const id of p.revokedIds) revoked.add(id);
    for (const k of p.keys) if (!byId.has(k.keyId)) byId.set(k.keyId, { ...k });
  }
  for (const id of revoked) { const k = byId.get(id); if (k) k.revoked = true; else byId.set(id, { keyId: id, publicKey: null, revoked: true, source: 'revoked-list' }); }
  let activeCount = 0; let revokedCount = 0;
  for (const k of byId.values()) { if (k.revoked) revokedCount += 1; else if (k.publicKey) activeCount += 1; }
  return { byId, activeCount, revokedCount, errors };
}

/** 산출물 목록으로 payload 객체를 만든다(서명 전 검사 포함). */
export function buildManifest({ version, files, keyId, createdAt = new Date().toISOString() }) {
  if (!VERSION_RE.test(String(version || ''))) throw new Error(`버전 형식이 아닙니다: ${version}`);
  if (!KEY_ID_RE.test(String(keyId || ''))) throw new Error('keyId 형식이 아닙니다');
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) throw new Error(`files 는 1~${MAX_FILES}개여야 합니다`);
  const seen = new Set();
  const out = files.map((f) => {
    if (!FILE_NAME_RE.test(String(f.name || ''))) throw new Error(`파일 이름 형식이 아닙니다: ${f.name}`);
    if (seen.has(f.name)) throw new Error(`같은 파일이 두 번 있습니다: ${f.name}`);
    seen.add(f.name);
    if (!KINDS.includes(f.kind)) throw new Error(`알 수 없는 kind: ${f.kind}`);
    if (!Number.isSafeInteger(f.size) || f.size < 0) throw new Error(`size 가 정수가 아닙니다: ${f.name}`);
    if (!SHA_RE.test(String(f.sha256 || ''))) throw new Error(`sha256 형식이 아닙니다: ${f.name}`);
    return { name: f.name, kind: f.kind, platform: String(f.platform || 'any').slice(0, 32), size: f.size, sha256: f.sha256 };
  });
  return { format: MANIFEST_FORMAT, v: MANIFEST_V, product: PRODUCT, version: String(version), createdAt: String(createdAt).slice(0, 40), keyId, files: out };
}

/** payload 객체에 서명해 봉투(객체)를 만든다. privateKey 는 Ed25519 KeyObject. */
export function signManifest(manifest, privateKey) {
  if (privateKey?.asymmetricKeyType !== 'ed25519' || privateKey.type !== 'private') throw new Error('Ed25519 개인키가 필요합니다');
  const keyId = keyIdOf(crypto.createPublicKey(privateKey));
  if (manifest.keyId !== keyId) throw new Error(`manifest.keyId(${manifest.keyId})가 서명 키(${keyId})와 다릅니다`);
  const payload = Buffer.from(JSON.stringify(manifest), 'utf8');
  const signature = crypto.sign(null, payload, privateKey);
  return { format: MANIFEST_FORMAT, v: MANIFEST_V, alg: 'ed25519', keyId, payload: payload.toString('base64'), signature: signature.toString('base64') };
}
export const serializeEnvelope = (env) => `${JSON.stringify(env, null, 2)}\n`;

function fail(code, reason, extra = {}) { return { ok: false, code, reason, ...extra }; }

/** payload JSON 의 형식 검사(서명이 맞은 뒤에 부른다). */
function checkPayload(m, keyId) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'payload 가 객체가 아닙니다';
  if (m.format !== MANIFEST_FORMAT || m.v !== MANIFEST_V) return 'payload format/v 가 맞지 않습니다';
  if (m.product !== PRODUCT) return `제품 이름이 ${PRODUCT} 가 아닙니다`;
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) return 'payload version 형식이 아닙니다';
  if (m.keyId !== keyId) return 'payload keyId 가 봉투 keyId 와 다릅니다';
  if (!Array.isArray(m.files) || !m.files.length || m.files.length > MAX_FILES) return 'files 목록이 비었거나 너무 깁니다';
  for (const f of m.files) {
    if (!f || typeof f !== 'object' || !FILE_NAME_RE.test(String(f.name || '')) || !KINDS.includes(f.kind)
      || !Number.isSafeInteger(f.size) || f.size < 0 || !SHA_RE.test(String(f.sha256 || ''))) return 'files 항목 형식이 틀렸습니다';
  }
  return null;
}

/**
 * 봉투 글을 검증한다. trust = mergeTrust() 결과.
 * @returns {{ok:true, manifest:object, keyId:string} | {ok:false, code:string, reason:string, keyId?:string}}
 */
export function verifyEnvelopeText(text, trust) {
  if (text == null || text === '') return fail('manifest-missing', '서명 manifest 가 없습니다');
  const raw = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
  if (raw.length > MANIFEST_MAX_BYTES) return fail('manifest-malformed', `manifest 가 상한(${MANIFEST_MAX_BYTES}바이트)보다 큽니다`);
  let env;
  try { env = JSON.parse(raw.toString('utf8')); } catch { return fail('manifest-malformed', 'manifest 가 JSON 이 아닙니다'); }
  if (!env || typeof env !== 'object' || Array.isArray(env)) return fail('manifest-malformed', 'manifest 봉투가 객체가 아닙니다');
  if (env.format !== MANIFEST_FORMAT || env.v !== MANIFEST_V || env.alg !== 'ed25519') return fail('manifest-malformed', 'manifest 봉투의 format/v/alg 가 맞지 않습니다');
  if (typeof env.keyId !== 'string' || !KEY_ID_RE.test(env.keyId)) return fail('manifest-malformed', 'manifest keyId 형식이 아닙니다');
  const keyId = env.keyId;
  const payload = strictBase64(env.payload, MANIFEST_MAX_BYTES);
  const sig = strictBase64(env.signature, 256);
  if (!payload || !sig || sig.length !== 64) return fail('manifest-malformed', 'manifest payload/signature 인코딩이 틀렸습니다', { keyId });
  if (!trust || !trust.byId) return fail('no-trusted-keys', '신뢰 공개키가 없습니다', { keyId });
  const key = trust.byId.get(keyId);
  if (key?.revoked) return fail('revoked-key', `회수된 서명 키입니다(${keyId})`, { keyId });
  if (!key || !key.publicKey) return fail('unknown-key', `신뢰 목록에 없는 서명 키입니다(${keyId})`, { keyId });
  let okSig = false;
  try { okSig = crypto.verify(null, payload, key.publicKey, sig); } catch { okSig = false; }
  if (!okSig) return fail('bad-signature', `서명이 맞지 않습니다 — manifest 가 변조됐거나 다른 키로 서명됐습니다(${keyId})`, { keyId });
  let m;
  try { m = JSON.parse(payload.toString('utf8')); } catch { return fail('manifest-malformed', '서명된 payload 가 JSON 이 아닙니다', { keyId }); }
  const why = checkPayload(m, keyId);
  if (why) return fail('manifest-malformed', `서명된 payload 형식 오류 — ${why}`, { keyId });
  return { ok: true, manifest: m, keyId };
}

/**
 * 검증된 manifest 와 실제 산출물을 대조한다(순수).
 *  · expectVersion: 요청한 버전과 manifest.version 이 같아야 한다 — **다른 버전 manifest 재사용 거부**(rollback/replay).
 *  · name 이 있으면 그 이름의 항목, 없으면(push — 파일명 없음) kind+sha256 으로 찾는다.
 */
export function matchArtifact(manifest, { name, kind, size, sha256, expectVersion, checkHash = true } = {}) {
  if (expectVersion != null && String(expectVersion).replace(/^v/, '') !== manifest.version) {
    return fail('version-mismatch', `manifest 버전(${manifest.version})이 요청한 버전(${String(expectVersion).slice(0, 32)})과 다릅니다 — 다른 버전의 manifest 는 쓸 수 없습니다`);
  }
  const sha = String(sha256 || '').toLowerCase();
  let entry;
  if (name) {
    entry = manifest.files.find((f) => f.name === name);
    if (!entry) return fail('file-not-in-manifest', `manifest 에 ${String(name).slice(0, 120)} 이(가) 없습니다`);
  } else {
    entry = manifest.files.find((f) => f.sha256 === sha && (!kind || f.kind === kind));
    if (!entry) return fail('sha-mismatch', `번들 sha256(${sha.slice(0, 12)}…)이 서명된 manifest(${manifest.version})의 ${kind || ''} 항목과 맞지 않습니다`);
  }
  if (kind && entry.kind !== kind) return fail('kind-mismatch', `manifest 의 ${entry.name} 은(는) ${entry.kind} 이지 ${kind} 가 아닙니다`);
  // checkHash:false — 사전 확인(번들을 받기 전). 주어진 값(versions.json 의 sha·크기)만 대조한다.
  if (!checkHash) {
    if (Number.isFinite(size) && entry.size !== size) return fail('size-mismatch', `versions.json 의 크기가 서명된 값과 다릅니다(서명 ${entry.size}, 목록 ${size})`);
    if (sha && entry.sha256 !== sha) return fail('sha-mismatch', `versions.json 의 sha256 이 서명된 값과 다릅니다(서명 ${entry.sha256.slice(0, 12)}…, 목록 ${sha.slice(0, 12)}…)`);
    return { ok: true, entry };
  }
  if (Number.isFinite(size) && entry.size !== size) return fail('size-mismatch', `크기가 서명된 값과 다릅니다(서명 ${entry.size}, 실제 ${size})`);
  if (entry.sha256 !== sha) return fail('sha-mismatch', `sha256 이 서명된 값과 다릅니다(서명 ${entry.sha256.slice(0, 12)}…, 실제 ${sha.slice(0, 12)}…)`);
  return { ok: true, entry };
}
