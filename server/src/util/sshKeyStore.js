/**
 * util/sshKeyStore.js — 노드(중앙 · 엣지)가 스스로 만든 SSH 키로 비밀번호 없이 접속하기 위한 **키 파일 공장**(v2.976 — 집중 모니터링).
 *
 * v2.736 아이실론(`isidu/sshKey.js`)이 처음 만든 규칙을 그대로 옮겼다 — 같은 판정을 두 벌 두지 않으려고 공장으로 뺐고,
 * `isidu/sshKey.js` 는 이 공장을 `isidu_key` 로 부르는 얇은 껍데기다(동작 · 내보내기 이름 · 테스트 그대로).
 *
 * ── 키를 어디서 읽는가 ─────────────────────────────────────────────────────────
 *  포탈 서비스는 `ProtectHome=true` · `--no-create-home` 계정(vmportal)으로 돈다 — `~/.ssh` 는 없거나 읽을 수 없다. 그래서 키는 CONFIG_DIR 아래:
 *    ① env `<envVar>`(절대 경로 — 호스트에서만 정한다. 화면 · API 로 경로를 받지 않는다: 아무 파일이나 키로 읽게 하지 않으려고)
 *    ② `<CONFIG_DIR>/ssh/<name>`(이 공장이 만든 키)
 *    ③ `<CONFIG_DIR>/ssh/id_ed25519` · `id_ecdsa` · `id_rsa`(관리자가 기존 키를 복사해 둔 경우 — 기능끼리 함께 쓴다)
 *  키가 하나도 없으면 `ensureKey()` 가 **ECDSA P-256 키를 새로 만든다**(Node crypto SEC1 PEM — ssh2 가 확실히 읽는 형식.
 *  ⚠ `ssh2.utils.generateKeyPairSync('ed25519')` 는 자기 파서가 거부하는 키를 0.52% 만든다 — CLAUDE.md v2.590 기록).
 *
 * ── 지키는 것 ────────────────────────────────────────────────────────────────
 *  · 개인키는 어떤 응답에도 싣지 않는다 — 공개키 · 지문 · 종류만. 파일은 0600, 디렉터리는 0700, 이미 있으면 **덮어쓰지 않는다**(`wx`).
 *  · 암호가 걸린 키는 쓰지 않는다(비밀번호 없는 접속이 목적이다) — 그 사실을 상태로 말한다.
 *  · 키 파일은 백업 번들에 들어가지 않는다(백업은 .json/.env 만 — 서버 불변조건). 잃으면 새로 만들고 다시 등록해야 한다(화면이 말한다).
 *  · 키는 노드를 떠나지 않는다 — 엣지는 공개키 · 지문만 중앙에 올린다(7b 키 저장소 `bmusage/onboard/keyStore.js` 와 다른 길: 그쪽은 사람이 넣은 키를 봉인해 나른다).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { config } from '../config.js';

const require = createRequire(import.meta.url);
let _ssh2 = null;
function ssh2utils() { if (!_ssh2) _ssh2 = require('ssh2').utils; return _ssh2; }

const KEY_MAX_BYTES = 64 * 1024;
const COPIED_NAMES = Object.freeze(['id_ed25519', 'id_ecdsa', 'id_rsa']);
const CACHE_MS = 30_000;
const NAME_RE = /^[a-z][a-z0-9_]{1,31}$/;

export const sshKeyDir = () => path.join(config.configDir, 'ssh');

function fingerprintOf(pubBlob) {
  return `SHA256:${crypto.createHash('sha256').update(pubBlob).digest('base64').replace(/=+$/, '')}`;
}

/** 공개 정보만(화면 · push 용). 경로는 파일 이름만. 공장 밖에서도 쓴다(중앙이 엣지가 올린 값을 다시 거를 때). */
export function publicKeyViewOf(info) {
  if (!info) return null;
  const { present, usable, source, file, type, fingerprint, publicKey, encrypted, error, loosePerm } = info;
  return { present: !!present, usable: !!usable, source: source || null, file: file || null, type: type || null, fingerprint: fingerprint || null,
    publicKey: publicKey || null, ...(encrypted ? { encrypted: true } : {}), ...(error ? { error } : {}), ...(loosePerm ? { loosePerm: true } : {}) };
}

/**
 * @param {object} o
 * @param {string} o.name      생성 키 파일 이름(`isidu_key` · `focusmon_key`)
 * @param {string} o.envVar    절대 경로를 받는 env 이름
 * @param {string} o.comment   공개키 주석의 앞부분(`vmware-portal-isidu`) — 뒤에 `@<hostname>`
 * @param {string} o.tag       콘솔 머리(`[isidu]`)
 * @param {string} o.purpose   새로 만들었을 때 콘솔 문구의 대상(‘아이실론 접속용’)
 * @param {string} o.where     새로 만들었을 때 공개키를 넣을 곳(‘아이실론 계정의 authorized_keys’)
 */
export function createSshKeyStore({ name, envVar, comment, tag, purpose, where }) {
  if (!NAME_RE.test(String(name || ''))) throw new Error(`sshKeyStore: 이름 형식이 아닙니다(${name})`);
  let _cache = null; // { at, info, pem }

  const keyCandidates = () => {
    const out = [];
    const env = String(process.env[envVar] || '').trim();
    if (env && path.isAbsolute(env)) out.push({ path: env, source: 'env' });
    out.push({ path: path.join(sshKeyDir(), name), source: 'generated' });
    for (const n of COPIED_NAMES) out.push({ path: path.join(sshKeyDir(), n), source: 'copied' });
    return out;
  };

  function readKeyFile(cand) {
    const st = fs.statSync(cand.path);
    if (!st.isFile()) return { info: { present: false, source: cand.source, error: '키 경로가 파일이 아닙니다' } };
    if (st.size > KEY_MAX_BYTES) return { info: { present: false, source: cand.source, error: '키 파일이 너무 큽니다(64KB 초과)' } };
    const pem = fs.readFileSync(cand.path);
    const parsed = ssh2utils().parseKey(pem);
    const base = { present: true, source: cand.source, file: path.basename(cand.path), dirInConfig: cand.source !== 'env', mtime: st.mtimeMs,
      loosePerm: (st.mode & 0o077) !== 0 };
    if (parsed instanceof Error) {
      const enc = /encrypt|passphrase/i.test(parsed.message);
      return { info: { ...base, usable: false, encrypted: enc, error: enc ? '암호(passphrase)가 걸린 키입니다 — 비밀번호 없는 접속에는 암호 없는 키가 필요합니다' : `키를 읽지 못했습니다(${String(parsed.message).slice(0, 120)})` } };
    }
    const k = Array.isArray(parsed) ? parsed[0] : parsed;
    const blob = k.getPublicSSH();
    const cmt = String(k.comment || '').replace(/[^\x20-\x7e]/g, '').slice(0, 80) || `${comment}@${os.hostname()}`;
    const publicKey = `${k.type} ${blob.toString('base64')} ${cmt}`;
    return { info: { ...base, usable: true, type: k.type, fingerprint: fingerprintOf(blob), publicKey }, pem };
  }

  /** 지금 쓸 키의 정보(공개 정보만). 후보가 없으면 { present:false }. */
  function keyInfo({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && _cache && now - _cache.at < CACHE_MS) return _cache.info;
    let found = null; let firstErr = null;
    for (const c of keyCandidates()) {
      try {
        if (!fs.existsSync(c.path)) continue;
        const r = readKeyFile(c);
        if (r.info.usable) { found = r; break; }
        if (!firstErr) firstErr = r;
      } catch (e) {
        if (!firstErr) firstErr = { info: { present: true, source: c.source, file: path.basename(c.path), usable: false, error: `키 파일을 읽지 못했습니다(${e.code || e.message})` } };
      }
    }
    const r = found || firstErr || { info: { present: false, usable: false } };
    _cache = { at: now, info: r.info, pem: r.pem || null };
    return r.info;
  }

  /** 접속에 쓸 개인키(PEM 버퍼). 없거나 쓸 수 없으면 null — 사유는 keyInfo().error. */
  function privateKeyForConnect() {
    keyInfo();
    return _cache?.pem || null;
  }

  /**
   * 키가 없으면 만든다(있으면 아무것도 하지 않는다). 쓸 수 없는 키가 있으면 덮어쓰지 않고 그 사실을 돌려준다.
   * @returns {{created:boolean, info:object, reason?:string}}
   */
  function ensureKey() {
    const cur = keyInfo({ fresh: true });
    if (cur.present) return { created: false, info: cur, ...(cur.usable ? {} : { reason: cur.error || '쓸 수 없는 키가 이미 있습니다 — 덮어쓰지 않았습니다' }) };
    const dir = sshKeyDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
    const { privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'sec1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const file = path.join(dir, name);
    try {
      fs.writeFileSync(file, privateKey, { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if (e.code === 'EEXIST') return { created: false, info: keyInfo({ fresh: true }) };
      throw e;
    }
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    const info = keyInfo({ fresh: true });
    console.log(`${tag} ${purpose} SSH 키를 새로 만들었습니다(${info.type || '?'} ${info.fingerprint || ''}) — 공개키를 ${where}에 넣어야 접속됩니다`);
    return { created: true, info };
  }

  return Object.freeze({
    KEY_FILE_NAME: name,
    keyDir: sshKeyDir,
    keyCandidates,
    keyInfo,
    privateKeyForConnect,
    ensureKey,
    publicKeyView: (info = keyInfo()) => publicKeyViewOf(info),
    resetCache: () => { _cache = null; },
  });
}
