/**
 * attach/store.js — 위키 문서 · 이슈 첨부 파일(v2.887 · 시안 ⑨⑩ '첨부' · C-4).
 *
 * 사용자 결정(2026-11-04): 파일당 8MB · 문서/이슈당 20개(시안) · **포탈 전체 상한은 설정에서**(기본 2GB) · **포탈 백업에 넣지 않고 관리자가 따로 내려받는다**
 * (백업 허용 확장자 `.json/.env` 는 넓히지 않는다 — server/CLAUDE.md 소유자 경계 · 복원 기능 없음).
 *
 * 저장:
 *  · 목록 `attachments.json` `{ v:1, items:[{ id, kind:'wiki'|'issue', owner:'W12'|'ISS-3', name, ext, mime, size, sha256, by, at }] }` — 사용자 데이터(백업에 들어간다).
 *    파일 본체는 `CONFIG_DIR/attachments/<id>`(이름은 **서버가 만든 무작위 16바이트 hex** · 확장자 없음 · 0600) — 사용자가 준 이름은 목록의 표시용으로만 쓴다(경로에 넣지 않는다).
 *    백업에서 되살리면 목록은 남고 본체는 없을 수 있다 — 목록에 `missing:true` 로 밝힌다(조용히 깨진 링크를 주지 않는다).
 *  · 설정 `attach-settings.json` `{ maxTotalMB }` — 1~102400(100GB) · 관리자 + 전체 범위(라우트).
 *  · 확장자 화이트리스트(아래 EXT) — svg · html · js 같은 실행 가능한 형식은 받지 않는다. 내려받기는 항상 `attachment` + `nosniff` + CSP sandbox,
 *    그림(png · jpg · gif · webp)만 `?inline=1` 로 화면에 그린다(내용 첫 바이트가 그 형식인지 확인한 것만 — 저장 때 판정).
 *  · 쓰기는 tmp → fsync → rename(원자) — 상한 · 개수 검사는 쓰기 전에(조용히 자르지 않는다 — 413/409 로 거부).
 *  · 권한은 호출부가 정한다: 볼 수 있는 주인(문서 · 이슈)의 첨부만 보이고(조회 밖 404), 올리기 · 지우기는 그 주인의 쓰기 범위(라우트가 위키 · 이슈 저장소 findFor 로 판정).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { capStr } from '../util/capStr.js';

export const ATTACH_LIMITS = Object.freeze({ fileBytes: 8 * 1024 * 1024, perOwner: 20, name: 120, maxTotalMBDefault: 2048, maxTotalMBMax: 102_400 });
/** 확장자 → MIME(받는 것만). 그림은 첫 바이트 판정이 맞을 때만 inline 으로 그린다. */
export const EXT = Object.freeze({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', log: 'text/plain', csv: 'text/csv', json: 'application/json', xml: 'application/xml',
  yaml: 'text/plain', yml: 'text/plain', md: 'text/plain', conf: 'text/plain', cfg: 'text/plain', ini: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip: 'application/zip', gz: 'application/gzip', '7z': 'application/x-7z-compressed',
});
export const KINDS = Object.freeze(['wiki', 'issue']);
const OWNER_RE = { wiki: /^W\d{1,9}$/, issue: /^ISS-\d{1,9}$/ };
const ID_RE = /^[a-f0-9]{32}$/;

export const attachIndexFile = () => path.join(config.configDir, 'attachments.json');
export const attachSettingsFile = () => path.join(config.configDir, 'attach-settings.json');
export const attachDir = () => path.join(config.configDir, 'attachments');
const blobPath = (id) => path.join(attachDir(), id);

function err(status, msg, extra) { const e = new Error(msg); e.status = status; if (extra) e.extra = extra; return e; }

/* ───── 설정 ───── */
let settingsCache = null;
let settingsError = null;
export function loadAttachSettings() {
  if (settingsCache) return settingsCache;
  const f = attachSettingsFile();
  settingsError = null;
  let maxTotalMB = ATTACH_LIMITS.maxTotalMBDefault;
  try {
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const n = Number(j?.maxTotalMB);
      if (Number.isInteger(n) && n >= 1 && n <= ATTACH_LIMITS.maxTotalMBMax) maxTotalMB = n;
      else throw new Error('maxTotalMB 가 1~102400 정수가 아닙니다');
    }
  } catch (e) {
    preserveCorrupt(f, e.message);
    settingsError = safeLoadText(e) || '사유 미상';
    console.warn(`[attach] attach-settings.json 을 읽지 못해 기본 상한(${ATTACH_LIMITS.maxTotalMBDefault}MB)으로 둡니다: ${settingsError}`);
  }
  settingsCache = { maxTotalMB };
  return settingsCache;
}
export const attachSettingsError = () => { loadAttachSettings(); return settingsError; };
export function saveAttachSettings(body) {
  const n = Number(body?.maxTotalMB);
  if (!Number.isInteger(n) || n < 1 || n > ATTACH_LIMITS.maxTotalMBMax) throw err(400, `maxTotalMB: 1~${ATTACH_LIMITS.maxTotalMBMax} (MB) 정수여야 합니다`);
  atomicWriteFileSync(attachSettingsFile(), JSON.stringify({ maxTotalMB: n }), { mode: 0o600 });
  settingsCache = { maxTotalMB: n }; settingsError = null;
  return settingsCache;
}

/* ───── 목록 ───── */
let cache = null; // { items }
function load() {
  if (cache) return cache;
  const f = attachIndexFile();
  let items = [];
  try {
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!j || !Array.isArray(j.items)) throw new Error('items 배열이 없습니다');
      items = j.items.filter((x) => x && typeof x === 'object' && ID_RE.test(x.id) && KINDS.includes(x.kind) && OWNER_RE[x.kind].test(x.owner)
        && typeof x.name === 'string' && Object.hasOwn(EXT, x.ext) && Number.isInteger(x.size) && x.size >= 0);
    }
  } catch (e) {
    preserveCorrupt(f, e.message);
    console.warn(`[attach] attachments.json 을 읽지 못해 빈 목록으로 시작합니다(파일 본체는 그대로 둡니다): ${safeLoadText(e) || '사유 미상'}`);
    items = [];
  }
  cache = { items };
  return cache;
}
function save() { atomicWriteFileSync(attachIndexFile(), JSON.stringify({ v: 1, items: cache.items }), { mode: 0o600 }); }
export function _resetAttachCache() { cache = null; settingsCache = null; settingsError = null; }

/** 사용자가 준 파일 이름 → 표시 이름(제어 문자 · 경로 구분자 제거 · 120자) + 확장자(소문자). 받지 않는 확장자면 400. */
export function cleanName(raw) {
  // eslint-disable-next-line no-control-regex
  let s = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '_').trim();
  s = s.replace(/^\.+/, '').slice(-ATTACH_LIMITS.name);
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(s);
  const ext = m ? m[1].toLowerCase() : '';
  if (!s || !m || !Object.hasOwn(EXT, ext)) throw err(400, `받는 파일 형식이 아닙니다 — ${Object.keys(EXT).join(' · ')}`, { code: 'bad-type' });
  return { name: capStr(s, ATTACH_LIMITS.name), ext };
}
/** 그림 첫 바이트 판정 — inline 으로 그려도 되는가. */
export function imageMagicOk(ext, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  if (ext === 'png') return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === 'jpg' || ext === 'jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ext === 'gif') return buf.subarray(0, 4).toString('latin1') === 'GIF8';
  if (ext === 'webp') return buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}
const view = (x) => ({ id: x.id, kind: x.kind, owner: x.owner, name: x.name, ext: x.ext, mime: x.mime, size: x.size, by: x.by, at: x.at, image: !!x.image, missing: !fs.existsSync(blobPath(x.id)) });
export const totalBytes = () => load().items.reduce((a, x) => a + x.size, 0);

/** 주인 하나의 첨부(오래된 것부터). 호출부가 그 주인을 볼 수 있음을 확인했다. */
export function listFor(kind, owner) {
  if (!KINDS.includes(kind) || !OWNER_RE[kind].test(owner)) return [];
  return load().items.filter((x) => x.kind === kind && x.owner === owner).map(view);
}
/** id → 항목(없으면 null). 권한 판정은 호출부가 kind/owner 로. */
export function getItem(id) {
  if (!ID_RE.test(String(id))) return null;
  return load().items.find((x) => x.id === id) || null;
}
export function blobOf(id) { return blobPath(id); }

/**
 * 올리기 — buf(Buffer) · 원래 이름 · 올린 사람. 형식 · 크기 · 개수 · 전체 상한을 먼저 본다(넘으면 거부 — 413/409).
 * @returns 저장한 항목(view)
 */
export function addAttachment(kind, owner, rawName, buf, user, { now = Date.now() } = {}) {
  if (!KINDS.includes(kind) || !OWNER_RE[kind].test(owner)) throw err(404, '없는 문서 · 이슈입니다');
  const { name, ext } = cleanName(rawName);
  if (!Buffer.isBuffer(buf) || !buf.length) throw err(400, '빈 파일입니다');
  if (buf.length > ATTACH_LIMITS.fileBytes) throw err(413, `파일은 ${ATTACH_LIMITS.fileBytes / 1024 / 1024}MB 까지입니다`, { code: 'too-big' });
  const c = load();
  if (c.items.filter((x) => x.kind === kind && x.owner === owner).length >= ATTACH_LIMITS.perOwner) throw err(409, `첨부는 ${kind === 'wiki' ? '문서' : '이슈'}마다 ${ATTACH_LIMITS.perOwner}개까지입니다 — 필요 없는 첨부를 지우고 다시 하세요`, { code: 'too-many' });
  const maxBytes = loadAttachSettings().maxTotalMB * 1024 * 1024;
  const used = totalBytes();
  if (used + buf.length > maxBytes) throw err(409, `포탈 첨부 전체 상한(${loadAttachSettings().maxTotalMB}MB)을 넘습니다 — 관리자에게 정리나 상한 조정을 요청하세요`, { code: 'attach-full', used, max: maxBytes });
  const id = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(attachDir(), { recursive: true, mode: 0o700 });
  const tmp = `${blobPath(id)}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, blobPath(id));
  const item = {
    id, kind, owner, name, ext, mime: EXT[ext], size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), by: user, at: now,
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext) && imageMagicOk(ext, buf),
  };
  c.items.push(item);
  try { save(); } catch (e) { c.items.pop(); try { fs.unlinkSync(blobPath(id)); } catch { /* 이미 없다 */ } throw e; }
  return view(item);
}

/** 지우기 — 항목과 본체. 권한은 호출부(올린 사람 또는 전체 범위 관리자 + 그 주인의 쓰기 범위). */
export function removeAttachment(id) {
  const c = load();
  const i = c.items.findIndex((x) => x.id === id);
  if (i < 0) throw err(404, '없는 첨부입니다');
  const [x] = c.items.splice(i, 1);
  save();
  try { fs.unlinkSync(blobPath(x.id)); } catch { /* 본체가 이미 없다(백업 복원 뒤 등) */ }
  return view({ ...x });
}
/** 주인이 지워지면 그 첨부를 모두 지운다(문서 · 이슈 삭제 라우트가 부른다). */
export function removeOwner(kind, owner) {
  const c = load();
  const gone = c.items.filter((x) => x.kind === kind && x.owner === owner);
  if (!gone.length) return 0;
  c.items = c.items.filter((x) => !(x.kind === kind && x.owner === owner));
  save();
  for (const x of gone) { try { fs.unlinkSync(blobPath(x.id)); } catch { /* 이미 없다 */ } }
  return gone.length;
}

/** 관리자 사용량 — 전체 · 종류별 · 본체 없는 항목 수 · 목록에 없는 본체 파일 수(고아). */
export function attachUsage() {
  const items = load().items;
  let missing = 0;
  const known = new Set();
  for (const x of items) { known.add(x.id); if (!fs.existsSync(blobPath(x.id))) missing += 1; }
  let orphan = 0;
  try { for (const n of fs.readdirSync(attachDir())) if (ID_RE.test(n) && !known.has(n)) orphan += 1; } catch { /* 폴더가 아직 없다 */ }
  const by = (k) => items.filter((x) => x.kind === k);
  return {
    count: items.length, bytes: totalBytes(), maxTotalMB: loadAttachSettings().maxTotalMB, missing, orphan,
    wiki: { count: by('wiki').length, bytes: by('wiki').reduce((a, x) => a + x.size, 0) },
    issue: { count: by('issue').length, bytes: by('issue').reduce((a, x) => a + x.size, 0) },
  };
}

/* ───── 따로 내려받기(tar.gz 스트림) ───── */
function tarHeader(name, size, mtimeSec) {
  const h = Buffer.alloc(512, 0);
  const put = (s, off, len) => h.write(s, off, len, 'utf8');
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name.slice(0, 99), 0, 100);
  put(oct(0o600, 8), 100, 8); put(oct(0, 8), 108, 8); put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12); put(oct(Math.max(0, Math.floor(mtimeSec)), 12), 136, 12);
  h.fill(0x20, 148, 156); // 체크섬 자리 — 공백으로 두고 계산
  put('0', 156, 1); put('ustar\u000000', 257, 8);
  let sum = 0; for (const b of h) sum += b;
  put(oct(sum, 7), 148, 7); h[155] = 0x20;
  return h;
}
const pad512 = (n) => Buffer.alloc((512 - (n % 512)) % 512, 0);
/**
 * 첨부 전체를 tar 로 차례로 내보낸다(본체 하나씩 스트림 — 전체를 메모리에 올리지 않는다). 첫 항목은 목록(index.json — 원래 이름 · 주인 · 올린 사람).
 * 본체가 없는 항목은 건너뛰고 index.json 의 missing 에 적는다. write(chunk) 는 Promise(뒤압력)를 돌려준다.
 */
export async function writeArchive(write) {
  const items = load().items.map((x) => ({ ...x }));
  const present = items.filter((x) => fs.existsSync(blobPath(x.id)));
  const index = Buffer.from(JSON.stringify({ v: 1, createdAt: Date.now(), note: '파일 본체는 files/<id> — 원래 이름은 이 목록의 name', items: items.map((x) => ({ ...x, missing: !present.includes(x) })) }, null, 1), 'utf8');
  const now = Date.now() / 1000;
  await write(tarHeader('index.json', index.length, now)); await write(index); await write(pad512(index.length));
  let files = 0; let bytes = 0;
  for (const x of present) {
    let st;
    try { st = fs.statSync(blobPath(x.id)); } catch { continue; }
    await write(tarHeader(`files/${x.id}`, st.size, x.at / 1000));
    const fd = fs.openSync(blobPath(x.id), 'r');
    try {
      const chunk = Buffer.alloc(1024 * 1024);
      let left = st.size;
      while (left > 0) {
        const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, left), null);
        if (n <= 0) break;
        await write(Buffer.from(chunk.subarray(0, n)));
        left -= n;
      }
      if (left > 0) await write(Buffer.alloc(left, 0)); // 읽는 중 줄어든 파일 — 머리말 크기를 지킨다
    } finally { fs.closeSync(fd); }
    await write(pad512(st.size));
    files += 1; bytes += st.size;
  }
  await write(Buffer.alloc(1024, 0)); // tar 끝
  return { files, bytes, missing: items.length - present.length };
}
