/**
 * hostaccess/settings.js — 호스트 접근 제어 설정(`host-access.json`, v2.485).
 * 초안(draft)·적용 상태(applied)·확정 대기(pending)를 한 파일에 둔다. 원자적 쓰기 + preserveCorrupt.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { normalizeSettings } from './render.js';

const FILE = path.join(config.configDir, 'host-access.json');
let cache = null;

export function loadHostAccess() {
  if (cache) return cache;
  let raw = {};
  try { if (fs.existsSync(FILE)) raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; }
  catch (e) { preserveCorrupt(FILE); console.warn(`[host-access] 설정 로드 실패 — 원본을 .corrupt 로 보존하고 기본값으로 시작합니다: ${e.message}`); raw = {}; }
  const { settings } = normalizeSettings(raw.draft || {}, { portalPort: config.port });
  cache = {
    draft: settings,
    applied: raw.applied && typeof raw.applied === 'object' ? raw.applied : null,   // { at, by, fingerprint, rich:[], sshdStopped }
    pending: raw.pending && typeof raw.pending === 'object' ? raw.pending : null,   // { at, deadline, by, fingerprint, rich:[] }
  };
  return cache;
}

export function saveHostAccess(patch) {
  const cur = loadHostAccess();
  const next = { ...cur, ...patch };
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next;
  return next;
}

export function _resetHostAccessCache() { cache = null; }
