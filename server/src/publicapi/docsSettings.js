/**
 * 공개 API 문서 페이지의 on/off (v2.564).
 *
 * ⚠ **이 페이지는 로그인 없이 보인다.** 그래서 끌 수 있어야 한다 — 외부망에 노출된 포탈이나
 * 사내 정책상 API 존재 자체를 감춰야 하는 현장이 있다. 반대로 기본을 끄면 '만들었는데 안
 * 보이는' 상태라 연동 담당자가 찾지 못한다.
 *
 * **기본은 켜짐**이다. 근거: 이 페이지는 **실제 운영 데이터를 담지 않고**(합성 샘플만),
 * 경로도 이미 외부 연동용으로 설계된 `/api/v1` 8개뿐이다. 내부 API 812개는 싣지 않는다.
 * env `PUBLIC_API_DOCS=false` 로 즉시 끌 수 있고 중앙 설정으로도 끈다.
 *
 * ⚠ **끄면 404 다**(403 이 아니다) — 403 은 "여기 뭔가 있는데 막혔다" 를 알려주는 것이라
 *   감추는 목적에 어긋난다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = () => path.join(config.configDir, 'public-api-docs.json');

let _cache = null;

function load() {
  if (_cache) return _cache;
  let v = {};
  try { v = JSON.parse(fs.readFileSync(FILE(), 'utf8')) || {}; } catch { v = {}; }
  _cache = { enabled: v.enabled !== false, updatedAt: v.updatedAt ?? null, updatedBy: v.updatedBy || '' };
  return _cache;
}

/** 화면·라우트가 쓰는 단일 판정. env 가 **끄는 쪽으로만** 우선한다. */
export function docsEnabled() {
  // ⚠ env 는 '강제 끄기' 전용이다 — 중앙 설정으로 끈 것을 env 가 되살리면 관리자의 결정이
  //   조용히 뒤집힌다. 그래서 false 일 때만 본다.
  if (String(process.env.PUBLIC_API_DOCS || '').toLowerCase() === 'false') return false;
  return load().enabled;
}

export function docsSettings() {
  const s = load();
  return {
    enabled: docsEnabled(),
    stored: s.enabled,
    forcedOffByEnv: String(process.env.PUBLIC_API_DOCS || '').toLowerCase() === 'false',
    updatedAt: s.updatedAt, updatedBy: s.updatedBy,
  };
}

export function setDocsEnabled(enabled, by = '') {
  const next = { enabled: !!enabled, updatedAt: Date.now(), updatedBy: String(by || '') };
  atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2));
  _cache = next;
  return docsSettings();
}

export function _resetDocsSettingsCache() { _cache = null; }
