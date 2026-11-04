/**
 * routes/api/attach.js — 위키 문서 · 이슈 첨부(v2.886 · C-4). 저장소는 attach/store.js.
 *
 * 권한(위키 · 이슈와 같은 틀 — 서버 불변조건 '/api 상태변경은 requireRole(admin, operator)'):
 *  · 보기 · 내려받기: 로그인 사용자 전부 — **그 주인(문서 · 이슈)을 볼 수 있을 때만**(위키 getPage · 이슈 getIssue 가 범위를 판정 — 조회 밖 404).
 *  · 올리기 · 지우기: admin · operator(데모 제외) + 그 주인의 쓰기 범위(위키는 읽기 전용 스페이스 포함 — 저장과 같은 판정, 조회 밖 404 → 쓰기 밖 403).
 *    지우기는 올린 사람 또는 전체 범위 관리자.
 *  · 관리(사용량 · 상한 설정 · 전체 내려받기): 관리자 + 전체 범위(전 법인 공용 — 이슈 설정과 같은 문지기). 상한 저장은 쓰기 범위도 무제한.
 *  · 올리기 본문은 express.raw(octet-stream · 9MB) — **인증 뒤에만 읽는다**(api 라우터가 authMiddleware 뒤에 마운트된다).
 *  · 내려받기는 항상 attachment + nosniff + CSP sandbox. 그림(첫 바이트가 맞는 png · jpg · gif · webp)만 ?inline=1 로 그린다.
 */
import express from 'express';
import { requireRole } from '../../auth/auth.js';
import { isDemoGuest, isAdminDetailUser } from '../../auth/demoGuest.js';
import { scopedVcenterIds, writeScopedVcenterIds } from '../../auth/scope.js';
import { logAudit } from '../../audit.js';
import { clientIp } from '../../util/rateLimit.js';
import { acquireExport } from '../../util/exportBusy.js';
import { waitDrain } from '../../util/waitDrain.js';
import { fileStamp } from '../../util/dayKey.js';
import { store } from '../../store.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { getPage } from '../../wiki/store.js';
import { getIssue } from '../../issues/store.js';
import {
  listFor, getItem, blobOf, addAttachment, removeAttachment, attachUsage, loadAttachSettings, saveAttachSettings, attachSettingsError, writeArchive,
  ATTACH_LIMITS, EXT, KINDS,
} from '../../attach/store.js';
import fs from 'node:fs';
import zlib from 'node:zlib';

const writers = requireRole('admin', 'operator');
const adminOnly = requireRole('admin');
const fleetOnly = fullScopeOnlyWith('첨부 관리(사용량 · 전체 상한 · 전체 내려받기)는 전 법인 공용이라 전체 범위(vCenter 제한 없는) 관리자만 봅니다.');
const userOf = (req) => req.user?.username || 'anonymous';
const canWrite = (req) => ['admin', 'operator'].includes(req.user?.role) && !isDemoGuest(req.user);
const isMod = (req) => isAdminDetailUser(req.user) && !scopedVcenterIds(req.user, store.get());
function accessOf(req) {
  const snap = store.get();
  return { read: scopedVcenterIds(req.user, snap), write: writeScopedVcenterIds(req.user, snap) };
}
function fullWriteOnly(req, res, next) {
  let w = null;
  try { w = writeScopedVcenterIds(req.user, store.get()); } catch { w = new Set(); }
  if (w) return res.status(403).json({ ok: false, error: 'forbidden', reason: '첨부 상한은 전 법인 공용 설정이라 쓰기 범위가 지정되지 않은 관리자만 바꿉니다' });
  next();
}
const audit = (req, action, target, detail = '') => logAudit({ user: userOf(req), action, target, detail, ip: clientIp(req) });
function fail(res, e, next) {
  if (e && Number.isInteger(e.status)) return res.status(e.status).json({ ok: false, reason: e.message, ...(e.extra && typeof e.extra === 'object' ? e.extra : {}) });
  return next(e);
}
/** 주인을 볼 수 있는가 · 쓸 수 있는가 — 볼 수 없으면 던진다(404). 위키는 읽기 전용 스페이스면 writable=false(저장과 같은 판정). */
function ownerOf(req, kind, owner) {
  if (!KINDS.includes(kind)) { const e = new Error('없는 문서 · 이슈입니다'); e.status = 404; throw e; }
  const access = accessOf(req);
  if (kind === 'wiki') { const p = getPage(owner, userOf(req), access); return { writable: !!p.writable, title: p.title }; }
  const x = getIssue(owner, userOf(req), access);
  return { writable: x.writable !== false, title: x.title };
}
const writeDenied = (res) => res.status(403).json({ ok: false, reason: '이 문서 · 이슈는 쓰기 범위 밖이거나 읽기 전용이라 첨부를 바꿀 수 없습니다' });
const asciiName = (s) => String(s).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

export function registerAttach(api) {
  /* ── 관리(사용량 · 상한 · 전체 내려받기) — '/attach/:kind/:owner' 보다 먼저 ── */
  api.get('/attach/admin/usage', adminOnly, fleetOnly, (req, res) => {
    if (!isAdminDetailUser(req.user)) return res.status(403).json({ ok: false, reason: '데모 계정은 첨부 관리를 볼 수 없습니다' });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, usage: attachUsage(), settings: loadAttachSettings(), loadError: attachSettingsError(), limits: ATTACH_LIMITS, exts: Object.keys(EXT) });
  });
  api.put('/attach/admin/settings', adminOnly, fleetOnly, fullWriteOnly, (req, res, next) => {
    if (!isAdminDetailUser(req.user)) return res.status(403).json({ ok: false, reason: '데모 계정은 첨부 설정을 바꿀 수 없습니다' });
    try {
      const s = saveAttachSettings(req.body || {});
      audit(req, 'attach.settings', 'attach-settings.json', `전체 상한 ${s.maxTotalMB}MB`);
      res.json({ ok: true, settings: s, usage: attachUsage() });
    } catch (e) { fail(res, e, next); }
  });
  // 전체 내려받기(tar.gz) — 포탈 백업에 넣지 않는 대신(사용자 결정) 관리자가 따로 받는다. 무거운 내보내기라 동시 1건.
  api.get('/attach/admin/archive', adminOnly, fleetOnly, async (req, res, next) => {
    if (!isAdminDetailUser(req.user)) return res.status(403).json({ ok: false, reason: '데모 계정은 첨부를 내려받을 수 없습니다' });
    const lock = acquireExport('attach-archive', req);
    if (!lock.ok) return res.status(lock.status).json(lock.body);
    try {
      res.set('Content-Type', 'application/gzip');
      res.set('Content-Disposition', `attachment; filename="portal-attachments-${fileStamp()}.tar.gz"`);
      res.set('Cache-Control', 'no-store');
      const gz = zlib.createGzip();
      gz.pipe(res);
      // 뒤압력은 공용 util/waitDrain(끊기면 기다림을 끝낸다 — 잠금이 finally 에서 풀리게). 끊겼으면 던져 멈춘다.
      const write = async (b) => { if (gz.write(b)) return; if (!(await waitDrain(gz, res))) throw Object.assign(new Error('내려받기가 끊겼습니다'), { aborted: true }); };
      const r = await writeArchive(write);
      gz.end();
      audit(req, 'attach.archive', 'attachments', `파일 ${r.files} · ${Math.round(r.bytes / 1024)}KB · 본체 없음 ${r.missing}`);
    } catch (e) { if (!res.headersSent) fail(res, e, next); else res.destroy(e); } finally { lock.release(); }
  });

  /* ── 파일 하나 ── */
  api.get('/attach/file/:id', (req, res, next) => {
    try {
      const x = getItem(req.params.id);
      if (!x) return res.status(404).json({ ok: false, reason: '없는 첨부입니다' });
      ownerOf(req, x.kind, x.owner); // 볼 수 없으면 404
      const file = blobOf(x.id);
      if (!fs.existsSync(file)) return res.status(410).json({ ok: false, reason: '첨부 목록에는 있지만 파일 본체가 없습니다(백업에서 되살린 포탈이면 첨부는 따로 옮겨야 합니다)', code: 'missing' });
      const inline = req.query.inline === '1' && x.image;
      res.set('Content-Type', inline ? x.mime : (x.mime || 'application/octet-stream'));
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Security-Policy', "default-src 'none'; sandbox");
      res.set('Cache-Control', 'private, no-store');
      res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${asciiName(x.name)}"; filename*=UTF-8''${encodeURIComponent(x.name)}`);
      fs.createReadStream(file).on('error', (e) => { if (!res.headersSent) next(e); else res.destroy(e); }).pipe(res);
    } catch (e) { fail(res, e, next); }
  });
  api.delete('/attach/file/:id', writers, (req, res, next) => {
    if (!canWrite(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 첨부를 지울 수 없습니다' });
    try {
      const x = getItem(req.params.id);
      if (!x) return res.status(404).json({ ok: false, reason: '없는 첨부입니다' });
      const o = ownerOf(req, x.kind, x.owner);
      if (!o.writable) return writeDenied(res);
      if (x.by !== userOf(req) && !isMod(req)) return res.status(403).json({ ok: false, reason: '첨부는 올린 사람이나 전체 범위 관리자만 지울 수 있습니다' });
      const r = removeAttachment(x.id);
      audit(req, 'attach.delete', `${x.kind}:${x.owner}`, `${x.name} (${x.size}B · 올린 사람 ${x.by})`);
      res.json({ ok: true, removed: r });
    } catch (e) { fail(res, e, next); }
  });

  /* ── 주인(문서 · 이슈)의 첨부 ── */
  api.get('/attach/:kind/:owner', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      const o = ownerOf(req, req.params.kind, req.params.owner);
      res.json({ ok: true, items: listFor(req.params.kind, req.params.owner), canUpload: canWrite(req) && o.writable, me: userOf(req), isMod: isMod(req), limits: ATTACH_LIMITS, exts: Object.keys(EXT) });
    } catch (e) { fail(res, e, next); }
  });
  api.post('/attach/:kind/:owner', writers, express.raw({ type: 'application/octet-stream', limit: ATTACH_LIMITS.fileBytes + 1024 }), (req, res, next) => {
    if (!canWrite(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 첨부를 올릴 수 없습니다' });
    try {
      const o = ownerOf(req, req.params.kind, req.params.owner);
      if (!o.writable) return writeDenied(res);
      if (!Buffer.isBuffer(req.body)) return res.status(415).json({ ok: false, reason: '파일 본문(application/octet-stream)이 아닙니다' });
      const item = addAttachment(req.params.kind, req.params.owner, typeof req.query.name === 'string' ? req.query.name : '', req.body, userOf(req));
      audit(req, 'attach.add', `${item.kind}:${item.owner}`, `${item.name} (${item.size}B)`);
      res.json({ ok: true, item });
    } catch (e) { fail(res, e, next); }
  });
}
