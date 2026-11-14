/**
 * sshaccess/inbox.js — **키 폴더(받는 곳)**: 사람이 서버에서 직접 넣은 개인키 파일을 찾아 ‘승인 대기’ 로 보여 주고, 승인하면 봉인 저장소로 옮긴다
 * (v3.9.0 · 설계 docs/design/ssh-access §4 · §6 S3 · §8 ‘새 파일 승인’).
 *
 * 폴더: `CONFIG_DIR/ssh-keys-inbox/<법인 폴더>/common/<파일>` · `…/<법인 폴더>/servers/<서버 폴더>/<파일>`.
 *   폴더 이름은 `folderSlug(id)`(파일 시스템에 안전한 글자 — 바뀌었으면 짧은 해시를 붙여 겹치지 않게). 화면이 정확한 경로를 보여 준다.
 *
 * 불변조건(sshaccess/CLAUDE.md):
 *  · **찾은 파일은 승인 전에는 쓰지 않는다**(누가 넣었는지 포탈이 모른다). 승인 = 설정 소유자 등급 + 본인 OTP(라우트) → 다시 읽어 **사람이 본 지문과
 *    같을 때만** 저장소(`keyStore.addKey` — 암호화 정책 · 키 판정 · 봉인 그대로)에 넣고 **평문 파일을 지운다**. 지우지 못하면 그 사실을 크게 말한다.
 *  · 폴더(법인 · 서버)는 **파일이 놓인 자리**에서 정한다 — 요청이 다른 법인 폴더로 바꿔 넣을 수 없다.
 *  · 읽는 것은 정해진 깊이의 일반 파일만: 심링크 · 장치 · 너무 큰 파일(64KB) · 너무 많은 파일(MAX_FILES)은 읽지 않고 사유를 적는다.
 *    경로는 `path.resolve` 뒤 받는 곳 안인지 다시 본다(`..` · 절대 경로 거부). 응답에는 **파일 내용을 싣지 않는다**(지문 · 종류 · 크기 · 사유만).
 *  · 공개키(.pub)만 있는 파일은 키가 아니다 — ‘공개키 파일’ 로 적고 가져오지 않는다.
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
const SAFE = /[^A-Za-z0-9._-]/g;

const t = (v, max = 256) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max).trim();

/** id · 이름 → 폴더 이름(파일 시스템에 안전 · 겹치지 않게). 순수. */
export function folderSlug(id) {
  const raw = t(id, 128);
  if (!raw) return '';
  let s = raw.replace(SAFE, '_').slice(0, 64);
  if (s !== raw || /^\.+$/.test(s) || s.startsWith('.')) s = `${s.replace(/^\.+/, '_')}-${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 6)}`;
  return s;
}

/** 법인 · 서버 → 받는 곳 경로(화면 안내용 — 만들지는 않는다). */
export function inboxPathOf(corp, server = '') {
  const c = folderSlug(corp);
  if (!c) return '';
  return server ? path.join(inboxDir(), c, 'servers', folderSlug(server)) : path.join(inboxDir(), c, 'common');
}

const idOf = (rel) => crypto.createHash('sha256').update(rel).digest('hex').slice(0, 16);

/**
 * 받는 곳을 읽는다(비동기 · 파일 내용은 돌려주지 않는다).
 * @param {{corps:{id:string}[], servers:{id:string,name:string,vcenterId?:string}[]}} known  지금 있는 법인 · OS 등록 서버(폴더 이름 → id)
 * @returns {Promise<{exists:boolean, dir:string, items:object[], truncated:number, unknownFolders:string[]}>}
 */
export async function scanInbox({ corps = [], servers = [] } = {}) {
  const base = inboxDir();
  const out = { exists: false, dir: base, items: [], truncated: 0, unknownFolders: [] };
  let corpDirs;
  try { corpDirs = await fs.promises.readdir(base, { withFileTypes: true }); out.exists = true; } catch { return out; }
  const corpBySlug = new Map(corps.filter((c) => c && c.id).map((c) => [folderSlug(c.id), String(c.id)]));
  const serverBySlug = new Map();   // `${corp}\u0001${slug}` → 서버 이름
  for (const s of servers) if (s && s.name && s.vcenterId) serverBySlug.set(`${s.vcenterId}\u0001${folderSlug(s.name)}`, String(s.name));
  let count = 0;
  const visit = async (abs, rel, corp, server) => {
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
    if (!cd.isDirectory()) continue;
    const corp = corpBySlug.get(cd.name);
    if (!corp) { out.unknownFolders.push(cd.name.slice(0, 80)); continue; }
    await visit(path.join(base, cd.name, 'common'), path.join(cd.name, 'common'), corp, '');
    let sdirs = [];
    try { sdirs = await fs.promises.readdir(path.join(base, cd.name, 'servers'), { withFileTypes: true }); } catch { sdirs = []; }
    for (const sd of sdirs) {
      if (!sd.isDirectory()) continue;
      const server = serverBySlug.get(`${corp}\u0001${sd.name}`);
      if (!server) { out.unknownFolders.push(`${cd.name}/servers/${sd.name}`.slice(0, 120)); continue; }
      await visit(path.join(base, cd.name, 'servers', sd.name), path.join(cd.name, 'servers', sd.name), corp, server);
    }
  }
  out.items.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

async function inspectFile(abs, rel, corp, server) {
  const base = { id: idOf(rel), relPath: rel.split(path.sep).join('/'), file: path.basename(rel).slice(0, 120), corp, server };
  let st;
  try { st = await fs.promises.lstat(abs); } catch { return { ...base, code: 'unreadable', reason: '파일 정보를 읽지 못했습니다.' }; }
  if (st.isSymbolicLink()) return { ...base, code: 'symlink', reason: '심볼릭 링크는 읽지 않습니다 — 실제 키 파일을 넣으세요.' };
  if (!st.isFile()) return { ...base, code: 'not-file', reason: '일반 파일이 아닙니다.' };
  const meta = { ...base, size: st.size, mtime: Math.round(st.mtimeMs), loosePerm: (st.mode & 0o077) !== 0 };
  if (st.size > MAX_FILE_BYTES) return { ...meta, code: 'too-large', reason: `파일이 ${MAX_FILE_BYTES / 1024}KB 를 넘어 읽지 않았습니다.` };
  let text;
  try { text = await fs.promises.readFile(abs, 'utf8'); } catch { return { ...meta, code: 'unreadable', reason: '파일을 읽지 못했습니다(권한).' }; }
  const p = parsePrivateKey(text, '');
  if (p.ok) return { ...meta, code: 'ready', fingerprint: p.fingerprint, algo: p.algo, bits: p.bits, recommended: p.recommended };
  return { ...meta, code: p.code, reason: KEY_REJECT[p.code] || p.reason, needPassphrase: p.code === 'need-passphrase' };
}

/** 받는 곳 안의 상대 경로 → 절대 경로 + 그 자리의 법인 · 서버 폴더 이름. 밖이거나 모양이 다르면 null. */
function resolveRel(relPath) {
  const rel = t(relPath, 400);
  if (!rel || rel.includes('\0') || path.isAbsolute(rel)) return null;
  const parts = rel.split('/');
  if (parts.some((x) => !x || x === '.' || x === '..')) return null;
  const ok = (parts.length === 3 && parts[1] === 'common') || (parts.length === 4 && parts[1] === 'servers');
  if (!ok) return null;
  const root = path.resolve(inboxDir());
  const abs = path.resolve(root, ...parts);
  if (!abs.startsWith(root + path.sep)) return null;
  return { abs, corpSlug: parts[0], serverSlug: parts.length === 4 ? parts[2] : '' };
}

/**
 * 승인할 파일을 다시 읽는다(동기 — 라우트가 OTP 를 통과한 뒤 한 번). 사람이 본 지문과 다르면 거절.
 * @returns {{ok:true, pem:string, abs:string, corpSlug:string, serverSlug:string, parsed:object} | {ok:false, code:string, status?:number, reason:string}}
 */
export function readForApproval(relPath, expectFingerprint, passphrase = '') {
  const r = resolveRel(relPath);
  if (!r) return { ok: false, code: 'bad-path', status: 400, reason: '받는 곳 안의 파일 경로가 아닙니다.' };
  let st;
  try { st = fs.lstatSync(r.abs); } catch { return { ok: false, code: 'not-found', status: 404, reason: '파일이 없습니다(이미 승인 · 삭제됐을 수 있음) — 다시 읽기를 누르세요.' }; }
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, code: 'not-file', reason: '일반 파일이 아닙니다(심볼릭 링크는 받지 않습니다).' };
  if (st.size > MAX_FILE_BYTES) return { ok: false, code: 'too-large', reason: '파일이 너무 큽니다.' };
  let pem;
  try { pem = fs.readFileSync(r.abs, 'utf8'); } catch { return { ok: false, code: 'unreadable', reason: '파일을 읽지 못했습니다.' }; }
  const p = parsePrivateKey(pem, typeof passphrase === 'string' ? passphrase : '');
  if (!p.ok) return { ok: false, code: p.code, reason: KEY_REJECT[p.code] || p.reason };
  if (t(expectFingerprint, 80) !== p.fingerprint) return { ok: false, code: 'fingerprint-changed', status: 409, reason: '화면에서 본 뒤 파일이 바뀌었습니다(지문이 다름) — 다시 읽기 후 확인하세요.' };
  return { ok: true, pem, abs: r.abs, corpSlug: r.corpSlug, serverSlug: r.serverSlug, parsed: p };
}

/** 받는 곳의 파일 하나를 지운다(승인 뒤 평문 삭제 · 거절). 받는 곳 밖 · 심링크는 지우지 않는다. */
export function removeInboxFile(relPath) {
  const r = resolveRel(relPath);
  if (!r) return { ok: false, code: 'bad-path', status: 400, reason: '받는 곳 안의 파일 경로가 아닙니다.' };
  try {
    const st = fs.lstatSync(r.abs);
    if (!st.isFile() || st.isSymbolicLink()) return { ok: false, code: 'not-file', reason: '일반 파일이 아닙니다.' };
    fs.unlinkSync(r.abs);
    return { ok: true };
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: false, code: 'not-found', status: 404, reason: '파일이 없습니다.' };
    return { ok: false, code: 'unlink-failed', status: 500, reason: `파일을 지우지 못했습니다(${String(e?.code || e?.message || e).slice(0, 60)}).` };
  }
}

/** 상대 경로의 법인 · 서버 폴더 이름(승인 때 폴더를 정한다 — 요청 본문이 아니라 자리에서). */
export function slugsOf(relPath) { const r = resolveRel(relPath); return r ? { corpSlug: r.corpSlug, serverSlug: r.serverSlug } : null; }
