/**
 * Runtime-adjustable settings that can be changed from the portal UI (and
 * persisted), overriding the env defaults. Currently: the data source
 * (mock | live | auto). Stored in CONFIG_DIR/runtime.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { atomicWriteFileSync, preserveCorrupt } from './util/atomicWrite.js';

const FILE = path.join(config.configDir, 'runtime.json');
const VALID_SOURCES = ['mock', 'live', 'auto'];

let cache = null;

// v3.10.11(공통 기능 점검 9회차): 파일이 JSON 이지만 객체가 아니면(`5`·`"live"`·`[]`) 예전엔 그 값을 그대로 cache 로 썼다 —
//   숫자 · 문자열이면 setDataSource 의 `cache.dataSource = v` 가 엄격 모드 TypeError 로 500 을 냈고, 배열이면 속성이 직렬화되지 않아
//   데이터 소스 변경이 **저장된 척만 하고** 재시작 뒤 사라졌다. 객체가 아니면 손상과 같이 보존하고 빈 설정으로 시작한다.
function load() {
  if (cache) return cache;
  cache = {};
  try {
    if (fs.existsSync(FILE)) {
      const v = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (v && typeof v === 'object' && !Array.isArray(v)) cache = v;
      else if (v != null) preserveCorrupt(FILE, '객체가 아닌 JSON');
    }
  } catch (e) { preserveCorrupt(FILE, e.message); cache = {}; }
  return cache;
}

function save() {
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
  load();
  cache.dataSource = v;
  save();
  return { ok: true, dataSource: v };
}

/** Whether the data source was overridden in the UI (vs. coming from env). */
export function isDataSourceOverridden() {
  return VALID_SOURCES.includes(load().dataSource);
}
