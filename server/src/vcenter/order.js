/**
 * vCenter display order — a user-defined ordering applied to every "vCenter
 * 선택" list in the web (all dropdowns read /vcenters). Stored as an array of
 * vCenter ids in CONFIG_DIR/vcenter-order.json. Ids not present in the order go
 * to the end, preserving their original relative order.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { makeLoadError } from '../util/registryCore.js'; // 118회차: 읽기 오류 ≠ 손상(공용 판정 — vcenter/registry.js 와 같은 규칙)

const FILE = path.join(config.configDir, 'vcenter-order.json');

/*
 * 118회차(재현): 예전에는 읽기와 JSON.parse 를 catch 하나로 받아 읽기 오류(EMFILE · EIO · EACCES)에도 순서 파일을 `.corrupt.*` 로 옮기고
 *   빈 순서를 **프로세스가 끝날 때까지** 캐시했다 — 전 포탈의 vCenter 선택 목록 순서가 사라지고, 다음 '순서 저장' 이 그 위에 새 파일을 썼다.
 *   이제 읽기 오류는 원본을 두고 · 캐시하지 않고(30초 간격으로 다시 읽는다 — 그동안은 마지막으로 읽은 순서, 없으면 등록 순서) · 저장을 거절한다.
 *   손상(JSON 형식)은 예전과 같다(보존본으로 옮기고 빈 순서 — 저장이 새 파일을 만든다).
 */
const loadErr = makeLoadError();
const WHAT = 'vCenter 표시 순서(vcenter-order.json)';
const parseOrder = (text) => { const j = JSON.parse(text); return Array.isArray(j?.order) ? j.order.map(String) : []; };

let cache = null;
function load() {
  if (cache) return cache;   // 읽은 순서(또는 파일 없음 · 손상의 빈 순서)만 캐시한다 — 읽기 오류는 아래에서 캐시에 넣지 않는다
  const r = loadErr.read(FILE, parseOrder);
  if (r.kind === 'ok') { cache = r.value; return cache; }
  if (r.kind === 'read-error') return cache || [];   // 마지막으로 읽은 순서(없으면 빈 순서 — 캐시로 굳히지 않는다)
  cache = [];   // 파일 없음 · 손상(보존본으로 옮김)
  return cache;
}

export function getOrder() { return [...load()]; }
/** 읽기 오류 중의 저장 거절(`{ok:false, code:'registry-unreadable', readError:true, reason}`) 또는 null. */
export function orderWriteRefusal() { load(); return loadErr.writeRefusal(WHAT); }

export function saveOrder(ids) {
  const order = Array.isArray(ids) ? [...new Set(ids.map((x) => String(x).trim()).filter(Boolean))] : [];
  load();
  loadErr.assertWritable(WHAT);   // 118회차: 읽히지 않는 원본을 보존본 없이 덮지 않는다(던진다 — 라우트는 먼저 orderWriteRefusal 로 503)
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify({ order }, null, 2), { mode: 0o600 });
  cache = order;
  loadErr.clear();
  return order;
}

/** Stable-sort items by the saved order. `idOf` extracts each item's vCenter id. */
export function sortByOrder(items, idOf = (x) => x.id) {
  const order = load();
  if (!order.length) return items;
  const rank = new Map(order.map((id, i) => [id, i]));
  return items
    .map((x, i) => [x, i])
    .sort((a, b) => {
      const ra = rank.has(idOf(a[0])) ? rank.get(idOf(a[0])) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(idOf(b[0])) ? rank.get(idOf(b[0])) : Number.MAX_SAFE_INTEGER;
      return ra - rb || a[1] - b[1]; // ties keep original order
    })
    .map(([x]) => x);
}
