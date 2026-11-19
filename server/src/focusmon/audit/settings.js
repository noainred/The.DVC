/**
 * focusmon/audit/settings.js — 디스크 점검 **설치 디렉터리 설정**(v3.17.0 — 사용자 "설치 디렉터리를 사전에 사용자가 지정하는 기능 추가" · 시안 ⑱ §21 · 컨펌 ⑤ 포탈 전체에 하나).
 *
 *  · 파일 `focusmon-audit-settings.json` { v:1, dir } — '' = 기본 경로(/usr/local 두 곳). 원자 쓰기 · 손상 보존 · 손상이면 **쓰기 거절**(빈 값으로 덮지 않는다) ·
 *    손상 뒤 재시작해 보존본만 남아도 계속 '읽지 못함'(`checkCorruptOnly` — 설치 디렉터리를 조용히 기본 경로로 되돌리지 않게).
 *  · 값은 `bundle.dirIssue` 를 지난 것만 저장하고, 읽을 때도 다시 본다(손으로 고친 파일 — 규칙 밖이면 '읽지 못함').
 *  · 비밀이 없다. 엣지는 이 파일을 쓰지 않는다 — 작업마다 중앙이 디렉터리를 실어 보낸다(엣지가 다시 검사).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../../util/atomicWrite.js';
import { makeLoadError } from '../../util/registryCore.js';
import { dirIssue } from './bundle.js';

export const SETTINGS_FILE = 'focusmon-audit-settings.json';
const file = () => path.join(config.configDir, SETTINGS_FILE);
const loadErr = makeLoadError();
let cache = null;

function load() {
  if (cache) return cache;
  loadErr.clear();
  let raw;
  try { raw = fs.readFileSync(file(), 'utf8'); } catch (e) {
    if (e?.code !== 'ENOENT') loadErr.set(e); else loadErr.checkCorruptOnly(file());
    cache = { dir: '' };
    return cache;
  }
  try {
    const j = JSON.parse(raw);
    const dir = typeof j?.dir === 'string' ? j.dir : '';
    if (dirIssue(dir)) { loadErr.set(new Error('설치 디렉터리 값이 규칙에 맞지 않습니다')); cache = { dir: '' }; return cache; }
    cache = { dir, at: Number(j?.at) || null, by: typeof j?.by === 'string' ? j.by.slice(0, 64) : '' };
  } catch (e) { preserveCorrupt(file()); loadErr.set(e); cache = { dir: '' }; }
  return cache;
}
/** 읽지 못했으면 { at, reason } — 설치 · 디렉터리 저장 · 설치 파일 받기를 막는다(503). */
export function installSettingsError() { load(); return loadErr.get(); }
/** 지금 설치 디렉터리('' = 기본 경로). 읽지 못했으면 null(모름 — 기본 경로로 지어내지 않는다). */
export function installDir() { load(); return loadErr.get() ? null : cache.dir; }
export function installSettingsView() { load(); return { dir: loadErr.get() ? null : cache.dir, at: cache.at || null, by: cache.by || '', error: loadErr.get() ? String(loadErr.get().reason || '손상') : null }; }
/** 저장 — 규칙 밖이면 { ok:false, code } · 파일을 못 읽은 상태면 거절(보존본을 확인하기 전에 덮지 않는다). */
export function saveInstallDir(dir, { by = '', now = Date.now() } = {}) {
  load();
  if (loadErr.get()) return { ok: false, code: 'settings-unreadable', reason: `설치 디렉터리 설정(${SETTINGS_FILE})을 읽지 못해 저장하지 않았습니다 — 손상 보존본을 확인하세요.` };
  const d = typeof dir === 'string' ? dir : null;
  if (d === null) return { ok: false, code: 'not-string', reason: '디렉터리는 글자여야 합니다.' };
  const issue = dirIssue(d);
  if (issue) return { ok: false, code: issue };
  const prev = cache.dir;
  atomicWriteFileSync(file(), `${JSON.stringify({ v: 1, dir: d, at: now, by: String(by).slice(0, 64) })}\n`);
  cache = { dir: d, at: now, by: String(by).slice(0, 64) };
  return { ok: true, dir: d, prev };
}
export function _resetForTest() { cache = null; loadErr.clear(); }
