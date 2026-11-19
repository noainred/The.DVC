/**
 * vmhygiene/holds.js — 스냅샷 보류(기한 있는 예외 · v3.28.0 · 설계 docs/design/snapshots §8 ⑥ 기본값 ‘넣는다(관리자만)’).
 * CONFIG_DIR/vm-snapshot-holds.json — 사람이 정하는 설정(비밀 없음).
 *
 *   · 보류 = VM 하나(vCenter id + VM id)의 스냅샷 정책 판정을 **기한까지** 뺀다. 예외 목록(vm-hygiene.json exceptions — 이름 · 메모 글자, 기한 없음)과 달리
 *     반드시 기한이 있다(루트 CLAUDE.md ‘보류에는 반드시 시한’) — 1 ~ HOLD_DAYS_MAX 일. 지난 보류는 판정에서 빠지고(지금 시각으로 판정) 목록에서도 정리된다.
 *   · 판정은 vmhygiene/analyze.js hygieneFindings 하나가 한다 — loadVmHygieneSettings 가 이 목록을 **열거되지 않는 속성 holds**(Map)로 붙인다.
 *     그래서 설정 저장(saveVmHygieneSettings — 열거되는 키만 펼친다) · 설정 응답 · rev 에는 섞이지 않고, 카드 · VM 구성 점검 · 알림 · 스냅샷 화면이 같은 판정을 본다.
 *   · 못 읽은 파일(read-error)은 **보류 없음이 아니다** — 이전에 읽은 목록을 그대로 쓰고(없으면 빈 목록 + unreadable) 저장은 거절한다(읽지 못한 값 위에 덮지 않는다).
 */
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { makeJsonFileReader } from '../util/jsonFileRead.js';
import { numOrNull } from '../util/numOrNull.js';

export const HOLDS_FILE_NAME = 'vm-snapshot-holds.json';
const FILE = () => path.join(config.configDir, HOLDS_FILE_NAME);
export const HOLD_DAYS_MAX = 90;
export const HOLDS_MAX = 2000;
const DAY = 86_400_000;
const REASON_MAX = 200;

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const txt = (s, max) => (typeof s === 'string' ? s.trim().slice(0, max) : '');
export const holdKey = (vcenterId, vmId) => `${vcenterId}\n${vmId}`;

/** 한 항목 정리(순수) — 모르는 키 · 모양이 틀린 항목은 버린다(null). */
export function normHold(raw) {
  if (!isObj(raw)) return null;
  const vcenterId = txt(raw.vcenterId, 200); const vmId = txt(raw.vmId, 200);
  const until = numOrNull(raw.until); const at = numOrNull(raw.at);
  if (!vcenterId || !vmId || until == null || until <= 0) return null;
  return { vcenterId, vmId, vmName: txt(raw.vmName, 200), until: Math.trunc(until), reason: txt(raw.reason, REASON_MAX), by: txt(raw.by, 128) || null, at: at != null ? Math.trunc(at) : null };
}

const _reader = makeJsonFileReader(FILE, { parse: (t) => { const p = JSON.parse(t); if (!isObj(p) || !Array.isArray(p.holds)) throw new Error('holds 배열이 아닙니다'); return p; }, tag: 'snapshot-holds' });
let _last = [];           // 마지막으로 읽은 목록(읽기 오류 동안 이어 쓴다)
let _unreadable = false;
let _onChange = null;
let _gen = 0;
/** 보류 세대 — 바뀌면 오른다(응답 캐시 열쇠). */
export function holdsGeneration() { return _gen; }
export function onHoldsChange(fn) { _onChange = typeof fn === 'function' ? fn : null; }

/** 지금 목록(지난 것은 뺀다). */
export function loadHolds(now = Date.now()) {
  const r = _reader.read();
  if (r.kind === 'ok') { _last = r.value.holds.map(normHold).filter(Boolean).slice(0, HOLDS_MAX); _unreadable = false; }
  else if (r.kind === 'read-error') _unreadable = true;
  else { if (r.kind !== 'missing') console.warn('[snapshot-holds] 파일을 읽지 못해 보존하고 빈 목록으로 시작합니다'); _last = []; _unreadable = false; }
  return { holds: _last.filter((h) => h.until > now), unreadable: _unreadable };
}

/** 판정용 Map — 키 holdKey(vcenterId, vmId). */
export function activeHoldMap(now = Date.now()) {
  return new Map(loadHolds(now).holds.map((h) => [holdKey(h.vcenterId, h.vmId), h]));
}

/**
 * 보류를 걸거나(days 1~HOLD_DAYS_MAX) 푼다(days 0). 범위 판정은 라우트가 먼저 한다.
 * @returns {{ok:true, hold:object|null} | {ok:false, status:number, reason:string}}
 */
export function setHold({ vcenterId, vmId, vmName = '', days, reason = '' }, user, now = Date.now()) {
  const cur = loadHolds(now);
  if (cur.unreadable) return { ok: false, status: 503, reason: '보류 목록 파일을 읽지 못해 저장하지 않습니다 — 파일을 확인한 뒤 다시 시도하세요.' };
  const d = numOrNull(days);
  if (d == null || !Number.isInteger(d) || d < 0 || d > HOLD_DAYS_MAX) return { ok: false, status: 400, reason: `보류 일수는 0(풀기) ~ ${HOLD_DAYS_MAX}일 정수입니다.` };
  const key = holdKey(vcenterId, vmId);
  const rest = cur.holds.filter((h) => holdKey(h.vcenterId, h.vmId) !== key);
  let hold = null;
  if (d > 0) {
    if (!txt(reason, REASON_MAX)) return { ok: false, status: 400, reason: '보류 사유를 적어 주세요.' };
    hold = normHold({ vcenterId, vmId, vmName, until: now + d * DAY, reason, by: user, at: now });
    if (!hold) return { ok: false, status: 400, reason: 'VM 을 알 수 없습니다.' };
    if (rest.length >= HOLDS_MAX) return { ok: false, status: 400, reason: `보류는 ${HOLDS_MAX}건까지입니다.` };
    rest.push(hold);
  }
  atomicWriteFileSync(FILE(), JSON.stringify({ holds: rest }, null, 2));
  _reader.reset(); _last = rest; _gen += 1;
  if (_onChange) { try { _onChange(); } catch { /* 캐시 무효화 실패는 다음 읽기에 맡긴다 */ } }
  return { ok: true, hold };
}

export function _resetHoldsForTest() { _reader.reset(); _last = []; _unreadable = false; }
