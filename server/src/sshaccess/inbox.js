/**
 * sshaccess/inbox.js — **키 폴더(받는 곳)**: 사람이 서버에서 직접 넣은 개인키 파일을 찾아 ‘승인 대기’ 로 보여 주고, 승인하면 봉인 저장소로 옮긴다
 * (v3.9.0 · 설계 docs/design/ssh-access §4 · §6 S3 · §8 ‘새 파일 승인’).
 *
 * 폴더: `CONFIG_DIR/ssh-keys-inbox/<법인 폴더>/common/<파일>` · `…/<법인 폴더>/servers/<서버 폴더>/<파일>`.
 *   폴더 이름은 `folderSlug(id)`(파일 시스템에 안전한 글자 — 바뀌었으면 짧은 해시를 붙인다 · 서버는 소문자로). 화면이 정확한 경로를 보여 준다.
 *   두 법인(또는 한 법인의 두 서버)이 같은 폴더 이름이 되면 그 폴더는 **읽지 않는다**(사람이 본 법인과 승인되는 법인이 갈리지 않게 — 점검 A-5 · C-13).
 *
 * 불변조건(sshaccess/CLAUDE.md):
 *  · **찾은 파일은 승인 전에는 쓰지 않는다**(누가 넣었는지 포탈이 모른다). 승인 = 설정 소유자 등급 + 본인 OTP(라우트) → 다시 읽어 **사람이 본 내용 해시(+지문)와
 *    같을 때만** 저장소(`keyStore.addKey` — 암호화 정책 · 키 판정 · 봉인 그대로)에 넣고 **평문 파일을 지운다**. 지우지 못하면 그 사실을 크게 말한다.
 *  · 폴더(법인 · 서버)는 **파일이 놓인 자리**에서 정한다 — 요청이 다른 법인 폴더로 바꿔 넣을 수 없다.
 *  · **심볼릭 링크를 따라가지 않는다** — 받는 곳 자체 · 법인 · common · servers · 서버 폴더 · 파일 어느 조각이든 링크면 읽지도 지우지도 않는다
 *    (점검 A-2 · C-2: `common -> ../..` 이면 설정 파일이 ‘받은 키’ 로 보이고 지우기로 secrets-key · users.json 이 지워졌다). 파일은 O_NOFOLLOW 로 연다.
 *  · 지우기 · 승인 삭제는 **사람이 본 내용 해시**가 지금 파일과 같을 때만(점검 C-6 — 읽은 뒤 바뀐 파일을 지우지 않는다). 경로 글자는 다듬지 않는다(앞뒤 공백 거부).
 *  · 0600 보다 넓은 권한의 파일은 승인하지 않는다(설계 §4 — 다른 계정이 이미 읽을 수 있던 키다. 0600 으로 고친 뒤 승인).
 *  · 응답에는 **파일 내용을 싣지 않는다**(지문 · 종류 · 크기 · 내용 해시 앞 32자 · 사유만).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { parsePrivateKey, KEY_REJECT } from '../bmusage/onboard/keyParse.js';

export const INBOX_DIR_NAME = 'ssh-keys-inbox';
export const inboxDir = () => path.join(config.configDir, 'ssh-keys-inbox');   // = INBOX_DIR_NAME(문서 생성기가 글자 그대로 찾는다)
export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_FILES = 300;
export const MAX_UNKNOWN = 100;
const SAFE = /[^A-Za-z0-9._-]/g;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

const t = (v, max = 256) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max).trim();

/** id · 이름 → 폴더 이름(파일 시스템에 안전). 순수. */
export function folderSlug(id) {
  const raw = t(id, 128);
  if (!raw) return '';
  let s = raw.replace(SAFE, '_').slice(0, 64);
  if (s !== raw || /^\.+$/.test(s) || s.startsWith('.')) s = `${s.replace(/^\.+/, '_')}-${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 6)}`;
  return s;
}
/** 서버 폴더 이름 — 서버 이름은 대소문자를 가리지 않는다(키 폴더 판정 keyPlacementIssue 와 같은 규칙). */
export const serverSlug = (name) => folderSlug(String(name || '').toLowerCase());

/** 법인 · 서버 → 받는 곳 경로(화면 안내용 — 만들지는 않는다). */
export function inboxPathOf(corp, server = '') {
  const c = folderSlug(corp);
  if (!c) return '';
  return server ? path.join(inboxDir(), c, 'servers', serverSlug(server)) : path.join(inboxDir(), c, 'common');
}

const idOf = (rel) => crypto.createHash('sha256').update(rel).digest('hex').slice(0, 16);
const shaOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);

/** 이 경로가 심링크가 아닌 진짜 디렉터리인가(없으면 false). */
async function isRealDir(p) { try { const st = await fs.promises.lstat(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } }

/** slug → id. 겹치는 slug 는 `null`(모호 — 쓰지 않는다). */
function slugMap(entries) {
  const m = new Map();
  for (const [slug, id] of entries) { if (!slug) continue; m.set(slug, m.has(slug) && m.get(slug) !== id ? null : id); }
  return m;
}

/**
 * 받는 곳을 읽는다(비동기 · 파일 내용은 돌려주지 않는다).
 * @param {{corps:{id:string}[], servers:{id:string,name:string,vcenterId?:string}[]}} known  지금 있는 법인 · OS 등록 서버(폴더 이름 → id)
 */
export async function scanInbox({ corps = [], servers = [] } = {}) {
  const base = inboxDir();
  const out = { exists: false, dir: base, items: [], truncated: 0, unknownFolders: [], unknownTotal: 0, rootIsLink: false };
  try { const st = await fs.promises.lstat(base); if (st.isSymbolicLink()) { out.rootIsLink = true; return out; } if (!st.isDirectory()) return out; } catch { return out; }
  out.exists = true;
  let corpDirs;
  try { corpDirs = await fs.promises.readdir(base, { withFileTypes: true }); } catch { return out; }
  const corpBySlug = slugMap(corps.filter((c) => c && c.id).map((c) => [folderSlug(c.id), String(c.id)]));
  const serverBySlug = slugMap(servers.filter((s) => s && s.name && s.vcenterId).map((s) => [`${s.vcenterId}\u0001${serverSlug(s.name)}`, String(s.name)]));
  const unknown = (x) => { out.unknownTotal += 1; if (out.unknownFolders.length < MAX_UNKNOWN) out.unknownFolders.push(x.slice(0, 120)); };
  let count = 0;
  const visit = async (abs, rel, corp, server) => {
    if (!(await isRealDir(abs))) { if (fs.existsSync(abs)) unknown(`${rel} (디렉터리가 아니거나 심볼릭 링크 — 읽지 않음)`); return; }
    let ents;
    try { ents = await fs.promises.readdir(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) continue;
      if (count >= MAX_FILES) { out.truncated += 1; continue; }
      count += 1;
      out.items.push(await inspectFile(path.join(abs, e.name), path.join(rel, e.name), corp, server));
    }
  };
  for (const cd of corpDirs) {
    if (!cd.isDirectory()) { if (cd.isSymbolicLink()) unknown(`${cd.name} (심볼릭 링크 — 읽지 않음)`); continue; }   // Dirent: 링크는 isDirectory() 가 false
    const corp = corpBySlug.get(cd.name);
    if (!corp) { unknown(corp === null ? `${cd.name} (두 법인이 같은 폴더 이름 — 읽지 않음)` : cd.name); continue; }
    await visit(path.join(base, cd.name, 'common'), path.join(cd.name, 'common'), corp, '');
    const sroot = path.join(base, cd.name, 'servers');
    if (!(await isRealDir(sroot))) { if (fs.existsSync(sroot)) unknown(`${cd.name}/servers (디렉터리가 아니거나 심볼릭 링크 — 읽지 않음)`); continue; }
    let sdirs = [];
    try { sdirs = await fs.promises.readdir(sroot, { withFileTypes: true }); } catch { sdirs = []; }
    for (const sd of sdirs) {
      if (!sd.isDirectory()) { if (sd.isSymbolicLink()) unknown(`${cd.name}/servers/${sd.name} (심볼릭 링크 — 읽지 않음)`); continue; }
      const server = serverBySlug.get(`${corp}\u0001${sd.name}`);
      if (!server) { unknown(`${cd.name}/servers/${sd.name}${server === null ? ' (두 서버가 같은 폴더 이름 — 읽지 않음)' : ''}`); continue; }
      await visit(path.join(sroot, sd.name), path.join(cd.name, 'servers', sd.name), corp, server);
    }
  }
  out.items.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

/** O_NOFOLLOW 로 열어 일반 파일 · 크기를 확인하고 읽는다. */
function readNoFollow(abs) {
  let fd;
  try { fd = fs.openSync(abs, fs.constants.O_RDONLY | O_NOFOLLOW); } catch (e) { return { ok: false, code: e?.code === 'ELOOP' ? 'symlink' : e?.code === 'ENOENT' ? 'not-found' : 'unreadable' }; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, code: 'not-file' };
    if (st.size > MAX_FILE_BYTES) return { ok: false, code: 'too-large', st };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = fs.readSync(fd, buf, off, st.size - off, off); if (!n) break; off += n; }
    return { ok: true, buf: buf.subarray(0, off), st };
  } catch { return { ok: false, code: 'unreadable' }; } finally { try { fs.closeSync(fd); } catch { /* */ } }
}
const READ_REASON = { symlink: '심볼릭 링크는 읽지 않습니다 — 실제 키 파일을 넣으세요.', 'not-file': '일반 파일이 아닙니다.', 'too-large': `파일이 ${MAX_FILE_BYTES / 1024}KB 를 넘어 읽지 않았습니다.`, unreadable: '파일을 읽지 못했습니다(권한).', 'not-found': '파일이 없습니다.' };

async function inspectFile(abs, rel, corp, server) {
  const base = { id: idOf(rel), relPath: rel.split(path.sep).join('/'), file: path.basename(rel).slice(0, 120), corp, server };
  let st;
  try { st = await fs.promises.lstat(abs); } catch { return { ...base, code: 'unreadable', reason: READ_REASON.unreadable }; }
  if (st.isSymbolicLink()) return { ...base, code: 'symlink', reason: READ_REASON.symlink };
  const r = readNoFollow(abs);
  if (!r.ok) return { ...base, code: r.code, reason: READ_REASON[r.code] || READ_REASON.unreadable, ...(r.st ? { size: r.st.size } : {}) };
  const meta = { ...base, size: r.st.size, mtime: Math.round(r.st.mtimeMs), loosePerm: (r.st.mode & 0o077) !== 0, sha: shaOf(r.buf) };
  const p = parsePrivateKey(r.buf.toString('utf8'), '');
  if (p.ok) return { ...meta, code: 'ready', fingerprint: p.fingerprint, algo: p.algo, bits: p.bits, recommended: p.recommended };
  return { ...meta, code: p.code, reason: KEY_REJECT[p.code] || p.reason, needPassphrase: p.code === 'need-passphrase' };
}

/**
 * 받는 곳 안의 상대 경로 → 절대 경로 + 그 자리의 법인 · 서버 폴더 이름. 밖이거나 모양이 다르거나 **어느 조각이든 심링크**면 null.
 * 경로 글자는 다듬지 않는다(앞뒤 공백이 있으면 거부 — 점검 C-6: 다듬으면 ‘key ’ 를 지우라는 요청이 ‘key’ 를 지웠다).
 */
function resolveRel(relPath) {
  if (typeof relPath !== 'string' || !relPath || relPath.length > 400 || relPath !== relPath.trim() || relPath.includes('\0') || path.isAbsolute(relPath)) return null;
  const parts = relPath.split('/');
  if (parts.some((x) => !x || x === '.' || x === '..')) return null;
  const ok = (parts.length === 3 && parts[1] === 'common') || (parts.length === 4 && parts[1] === 'servers');
  if (!ok) return null;
  const root = path.resolve(inboxDir());
  const abs = path.resolve(root, ...parts);
  if (!abs.startsWith(root + path.sep)) return null;
  // 디렉터리 조각(받는 곳 · 법인 · common/servers · 서버)이 진짜 디렉터리인지 — 링크면 거부.
  let cur = root;
  for (const seg of [null, ...parts.slice(0, -1)]) {
    if (seg) cur = path.join(cur, seg);
    try { const st = fs.lstatSync(cur); if (st.isSymbolicLink() || !st.isDirectory()) return null; } catch { return null; }
  }
  return { abs, corpSlug: parts[0], serverSlug: parts.length === 4 ? parts[2] : '' };
}

/**
 * 승인할 파일을 다시 읽는다(동기 — 라우트가 OTP 를 통과한 뒤 한 번). 사람이 본 내용 해시 · 지문과 다르면 거절.
 * @param {{expectSha?:string, expectFingerprint?:string, passphrase?:string}} o  둘 중 하나는 있어야 한다(passphrase 키는 지문을 미리 모른다 — 해시로 본다)
 */
export function readForApproval(relPath, { expectSha = '', expectFingerprint = '', passphrase = '' } = {}) {
  const r = resolveRel(relPath);
  if (!r) return { ok: false, code: 'bad-path', status: 400, reason: '받는 곳 안의 파일 경로가 아닙니다(심볼릭 링크 폴더 포함).' };
  const sha = t(expectSha, 64); const fp = t(expectFingerprint, 80);
  if (!sha && !fp) return { ok: false, code: 'need-expect', status: 400, reason: '화면에서 본 파일 정보(내용 해시)가 없습니다 — 다시 읽기 후 승인하세요.' };
  const rd = readNoFollow(r.abs);
  if (!rd.ok) return { ok: false, code: rd.code, status: rd.code === 'not-found' ? 404 : 400, reason: rd.code === 'not-found' ? '파일이 없습니다(이미 승인 · 삭제됐을 수 있음) — 다시 읽기를 누르세요.' : READ_REASON[rd.code] || READ_REASON.unreadable };
  if ((rd.st.mode & 0o077) !== 0) return { ok: false, code: 'loose-perm', status: 409, reason: '다른 계정이 읽을 수 있는 파일입니다(0600 이 아님) — 키가 이미 노출됐을 수 있습니다. 서버에서 chmod 600 으로 고친 뒤 승인하세요(노출이 의심되면 새 키를 만드세요).' };
  if (sha && shaOf(rd.buf) !== sha) return { ok: false, code: 'file-changed', status: 409, reason: '화면에서 본 뒤 파일이 바뀌었습니다 — 다시 읽기 후 확인하세요.' };
  const pem = rd.buf.toString('utf8');
  const p = parsePrivateKey(pem, typeof passphrase === 'string' ? passphrase : '');
  if (!p.ok) return { ok: false, code: p.code, reason: KEY_REJECT[p.code] || p.reason };
  if (fp && fp !== p.fingerprint) return { ok: false, code: 'fingerprint-changed', status: 409, reason: '화면에서 본 뒤 파일이 바뀌었습니다(지문이 다름) — 다시 읽기 후 확인하세요.' };
  return { ok: true, pem, abs: r.abs, sha: shaOf(rd.buf), corpSlug: r.corpSlug, serverSlug: r.serverSlug, parsed: p };
}

/**
 * 받는 곳의 파일 하나를 지운다(승인 뒤 평문 삭제 · 거절). 받는 곳 밖 · 링크 경로는 지우지 않는다.
 * **지금 내용 해시가 expectSha 와 같을 때만** 지운다(읽은 뒤 바뀐 파일을 지우지 않는다).
 */
export function removeInboxFile(relPath, { expectSha = '' } = {}) {
  const r = resolveRel(relPath);
  if (!r) return { ok: false, code: 'bad-path', status: 400, reason: '받는 곳 안의 파일 경로가 아닙니다(심볼릭 링크 폴더 포함).' };
  const sha = t(expectSha, 64);
  if (!sha) return { ok: false, code: 'need-expect', status: 400, reason: '화면에서 본 파일 정보(내용 해시)가 없습니다 — 다시 읽기 후 지우세요.' };
  const rd = readNoFollow(r.abs);
  if (!rd.ok && rd.code !== 'too-large') return { ok: false, code: rd.code, status: rd.code === 'not-found' ? 404 : 400, reason: READ_REASON[rd.code] || READ_REASON.unreadable };
  if (!rd.ok || shaOf(rd.buf) !== sha) return { ok: false, code: 'file-changed', status: 409, reason: '화면에서 본 뒤 파일이 바뀌었습니다 — 지우지 않았습니다. 다시 읽기 후 확인하세요.' };
  try {
    fs.unlinkSync(r.abs);
    return { ok: true };
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: false, code: 'not-found', status: 404, reason: '파일이 없습니다.' };
    return { ok: false, code: 'unlink-failed', status: 500, reason: `파일을 지우지 못했습니다(${String(e?.code || e?.message || e).slice(0, 60)}).` };
  }
}

/** 상대 경로의 법인 · 서버 폴더 이름(승인 때 폴더를 정한다 — 요청 본문이 아니라 자리에서). */
export function slugsOf(relPath) { const r = resolveRel(relPath); return r ? { corpSlug: r.corpSlug, serverSlug: r.serverSlug } : null; }
