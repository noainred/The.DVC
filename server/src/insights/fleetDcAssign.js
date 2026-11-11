/**
 * insights/fleetDcAssign.js — 통합 서버 인벤토리 › 베어메탈의 **법인(DataCenter) 수동 지정** 저장(v2.969 · 사용자 결정 2026-11-11
 *   '통합 서버 인벤토리 화면도 법인(DataCenter) 기준으로' + 지정 기능은 'vCenter 지정 · 법인 지정 둘 다 두기').
 *
 * 왜 따로 두나(등록부 datacenterId 를 고치지 않는 이유):
 *   · iDRAC 등록부의 datacenterId 는 **스캔 대역의 귀속**이다 — 같은 법인으로 '교체(replace)' 스캔을 돌리면 그 법인 항목을 지우고 다시 넣는다
 *     (idrac/registry.js replaceScanned). 화면에서 등록부 법인을 바꾸면 다음 교체 스캔이 서버를 지우거나 되돌린다(데이터 손실 경로).
 *   · OME · 엣지 보고 · 원격(엣지 등록부) 서버는 중앙 등록부에 항목이 없다 — 어차피 따로 둘 곳이 필요하다.
 *   · vCenter 지정(fleetAssign.js — 전력 · 사용률의 vCenter 귀속)과 뜻이 다르다 — 섞지 않는다.
 * 판정 순서는 insights/hwExport/corp.js makeCorpOf 가 정한다: **이 수동 지정이 가장 먼저**(사람이 고친 값).
 *
 * 저장: CONFIG_DIR/fleet-dc-assign.json { v:1, assign: { <소문자 키>: <DataCenter id> } } · 키는 통합 서버 인벤토리 행의 tagKey
 *   (서비스태그 우선, 없으면 서버 id/이름 — fleetAssign 과 같은 키). 원자적 쓰기 · 손상이면 보존하고 **쓰기를 거부**한다(503 —
 *   빈 값 위에 덮어 다른 지정을 잃지 않게. server/CLAUDE.md '로드 손상 보존' · fleetAssign 은 예전 규칙이라 손상 뒤 쓰기를 막지 않는다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { bumpFleetRev } from './fleetRev.js';

const FILE = () => path.join(config.configDir, 'fleet-dc-assign.json');
const norm = (s) => String(s ?? '').trim().toLowerCase();
export const KEY_MAX = 128;
export const ENTRIES_MAX = 20_000;

let cache = null;
let cacheTok = '';
let unreadable = false;
function corruptCopyExists() {
  try { const base = path.basename(FILE()); return fs.readdirSync(path.dirname(FILE())).some((f) => f.startsWith(`${base}.corrupt.`)); } catch { return false; }
}
const tok = () => { try { const st = fs.statSync(FILE()); return `${st.mtimeMs}:${st.size}`; } catch { return ''; } };

/** { <키>: <DataCenter id> } — 손상이면 {} (unreadable 표시 · 쓰기 거부). */
export function loadFleetDcAssign() {
  const tk = tok();
  if (cache && tk === cacheTok) return cache;
  // 손상은 보존(preserveCorrupt — 파일을 옆으로 옮긴다)한 뒤에도 **계속 쓰기 거부**다: 파일이 사라졌다고 새로 시작하면 다음 쓰기가
  //   빈 값 위에 저장돼 손상 전 지정들을 복구할 기회를 잃는다. 정상 파일을 다시 읽었을 때만 풀린다(관리자가 사본을 되돌린 경우).
  if (!tk) {
    // 반증 F4: 손상 사본(.corrupt.*)만 있고 원본이 없으면 **재시작 뒤에도** 쓰기 거부 — 새로 쓰면 손상 전 지정을 되살릴 기회를 잃는다.
    //   관리자가 사본을 원래 이름으로 되돌리거나(복구) 사본을 지우면(포기) 풀린다.
    if (corruptCopyExists()) unreadable = true;
    cache = {}; cacheTok = tk; return cache;
  }
  try {
    const p = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (!p || typeof p !== 'object' || !p.assign || typeof p.assign !== 'object' || Array.isArray(p.assign)) throw new Error('형식 오류');
    const out = {};
    for (const [k, v] of Object.entries(p.assign)) { if (typeof v === 'string' && v.trim() && norm(k)) out[norm(k)] = v.trim(); }
    cache = out;
    unreadable = false;
  } catch (e) {
    preserveCorrupt(FILE(), e.message);
    cache = {};
    unreadable = true;
  }
  cacheTok = tk;
  return cache;
}
export const fleetDcAssignUnreadable = () => { loadFleetDcAssign(); return unreadable; };

const UNREADABLE = Object.freeze({ ok: false, status: 503, code: 'assignUnreadable', reason: '법인 지정 파일(fleet-dc-assign.json)을 읽지 못해 바꾸지 않습니다 — 손상 사본은 설정 폴더에 남았습니다.' });

/**
 * 여러 키를 한 번의 쓰기로 지정/해제. entries: [[key, dcId|'']] · dcId '' = 해제. validIds: 있는 DataCenter id 집합(없는 법인은 거부).
 * @returns {{ok:true, changed:number} | {ok:false, status:number, reason:string, code?:string}}
 */
export function setFleetDcAssignMany(entries = [], validIds = null) {
  const cur = loadFleetDcAssign();
  if (unreadable) return UNREADABLE;
  const next = { ...cur };
  let changed = 0;
  let skipped = 0;   // 반증 F6: 형식 밖(빈 키 · 128자 초과)으로 건너뛴 수 — '이미 같은 값' 과 섞지 않는다
  for (const [rawKey, rawDc] of Array.isArray(entries) ? entries.slice(0, 5000) : []) {
    const k = norm(rawKey);
    if (!k || k.length > KEY_MAX) { skipped += 1; continue; }
    const dc = String(rawDc ?? '').trim();
    if (dc.length > KEY_MAX) { skipped += 1; continue; }
    if (dc && validIds && !validIds.has(dc)) return { ok: false, status: 400, reason: `없는 법인(DataCenter) id: ${dc.slice(0, 64)}` };
    if (!dc) { if (k in next) { delete next[k]; changed += 1; } }
    else if (next[k] !== dc) { next[k] = dc; changed += 1; }
  }
  if (!changed) return { ok: true, changed: 0, skipped };
  if (Object.keys(next).length > ENTRIES_MAX) return { ok: false, status: 400, reason: `법인 지정은 ${ENTRIES_MAX}건까지입니다.` };
  try { atomicWriteFileSync(FILE(), JSON.stringify({ v: 1, assign: next }, null, 2)); }
  catch (e) { return { ok: false, status: 500, reason: `저장 실패: ${String(e?.message || e).slice(0, 200)}` }; }
  cache = next;
  cacheTok = tok();
  bumpFleetRev();
  return { ok: true, changed, skipped };
}

/**
 * 반증 F5: 유령 키 정리 — keep(남길 키 집합) 밖의 키를 지운다. 지운 수. 손상이면 던진다(라우트가 500 으로 드러낸다 — fleetAssign.pruneFleetAssign 과 같은 태도).
 */
export function pruneFleetDcAssign(keep) {
  const cur = loadFleetDcAssign();
  if (unreadable) throw new Error(UNREADABLE.reason);
  const live = keep instanceof Set ? keep : new Set(keep || []);
  const next = {};
  let removed = 0;
  for (const [k, v] of Object.entries(cur)) { if (live.has(k)) next[k] = v; else removed += 1; }
  if (!removed) return 0;
  atomicWriteFileSync(FILE(), JSON.stringify({ v: 1, assign: next }, null, 2));
  cache = next;
  cacheTok = tok();
  bumpFleetRev();
  return removed;
}

/** 테스트 전용. */
export function _resetFleetDcAssignForTest() { cache = null; cacheTok = ''; unreadable = false; }
