/**
 * Runtime-adjustable settings that can be changed from the portal UI (and
 * persisted), overriding the env defaults. Currently: the data source
 * (mock | live | auto). Stored in CONFIG_DIR/runtime.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { atomicWriteFileSync, preserveCorrupt } from './util/atomicWrite.js';
import { makeJsonFileReader } from './util/jsonFileRead.js';   // 107회차: 읽기 오류 ≠ 손상(공용 읽기 — 30초 간격 재읽기)
import { parseJsonObject } from './util/jsonObject.js';

const FILE = path.join(config.configDir, 'runtime.json');
const VALID_SOURCES = ['mock', 'live', 'auto'];

let cache = null;

// v3.10.11(공통 기능 점검 9회차): 파일이 JSON 이지만 객체가 아니면(`5`·`"live"`·`[]`) 예전엔 그 값을 그대로 cache 로 썼다 —
//   숫자 · 문자열이면 setDataSource 의 `cache.dataSource = v` 가 엄격 모드 TypeError 로 500 을 냈고, 배열이면 속성이 직렬화되지 않아
//   데이터 소스 변경이 **저장된 척만 하고** 재시작 뒤 사라졌다. 객체가 아니면 손상과 같이 보존하고 빈 설정으로 시작한다.
/*
 * 107회차(재현 — EISDIR): 읽기 오류(EACCES · EIO · EISDIR)는 손상이 아니다 — 예전 catch 하나는 온전한 원본을 .corrupt 로 옮기고 빈 값 · 기본값을 캐시해
 *   다음 저장이 원본 자리를 덮었다. 읽기 단계는 공용 읽기: 원본을 두고 · 캐시하지 않고(30초 간격 재읽기) · 저장을 거절한다(503 settingsUnreadable). parse 실패는 예전과 같다.
 */
const _reader = makeJsonFileReader(() => FILE, { parse: (t) => t, preserve: false, tag: 'runtime' });
let _readErr = '';
/** 107회차: 읽기 오류 중의 저장 거절 본문(503) 또는 null. */
export function runtimeSettingsWriteRefusal() {
  load();
  return _readErr ? { ok: false, status: 503, code: 'settingsUnreadable', readError: true, reason: `런타임 설정(데이터 소스) 파일(${path.basename(FILE)})을 읽지 못해 저장하지 않았습니다 — 읽기 오류(${_readErr})이고 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽고, 읽히면 저장이 다시 열립니다).` } : null;
}
function load() {
  if (cache) return cache;
  const rr = _reader.read();
  if (rr.kind === 'read-error') { _readErr = String(rr.error?.code || 'read-error').slice(0, 32); return {}; }   // 107회차: 캐시하지 않는다 — 쓰기는 거절한다
  _readErr = '';
  cache = {};
  try {
    // v3.17.2: 판정은 공용 util/jsonObject.js 하나 — 객체가 아니면 던져 아래 catch 가 원본을 보존한다.
    if (rr.kind === 'ok') cache = parseJsonObject(rr.value);
  } catch (e) { preserveCorrupt(FILE, e.message); cache = {}; }
  return cache;
}

function save() {
  { const no = runtimeSettingsWriteRefusal(); if (no) throw Object.assign(new Error(no.reason), no, { extra: { code: no.code, readError: true } }); }   // 107회차: 읽기 오류 중에는 빈 값 · 기본값 위에 쓰지 않는다
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

/** Effective data source: UI override if set, else the env default. */
export function getDataSource() {
  const s = load();
  return VALID_SOURCES.includes(s.dataSource) ? s.dataSource : config.dataSource;
}

export function setDataSource(value) {
  const v = String(value || '').toLowerCase();
  if (!VALID_SOURCES.includes(v)) return { ok: false, reason: 'mock | live | auto 중 하나여야 합니다.' };
  { const no = runtimeSettingsWriteRefusal(); if (no) return no; }   // 107회차: 읽기 오류 중에는 빈 설정 위에 쓰지 않는다(캐시도 없다)
  load();
  cache.dataSource = v;
  save();
  return { ok: true, dataSource: v };
}

/** Whether the data source was overridden in the UI (vs. coming from env). */
export function isDataSourceOverridden() {
  return VALID_SOURCES.includes(load().dataSource);
}
