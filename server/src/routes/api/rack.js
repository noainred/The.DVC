/**
 * routes/api/rack.js — 특수 기능 '랙 실장도'(도구 키 `rack` · 설계 docs/design/rack-elevation/README.md · 1차 = 원장 + 조회 + 편집 + 엑셀 내보내기).
 *
 * ── 권한 ───────────────────────────────────────────────────────────────────
 *  · 조회: `tools` + 도구 접근(`rack` — toolGate) + **법인 범위**. 법인(DataCenter)은 그 법인에 할당된 vCenter 중 하나라도 조회 범위에 있으면 보인다
 *    (`collectorsDc.js scopedDatacenterView` 와 같은 판정). 할당 vCenter 가 없는 법인은 범위 계정에 보이지 않는다('귀속 없는 데이터 미노출').
 *    범위 밖 전산실 · 법인은 **404**(존재 은닉).
 *  · 편집: **관리자만**(2026-11-20 사용자 결정 '관리자만 편집') — `requireRole('admin')` + 데모 계정 아님(`isAdminDetailUser`) +
 *    그 법인의 할당 vCenter 가 **모두** 쓰기 범위 안(조회 밖 404 → 쓰기 밖 403). 할당 vCenter 가 없는 법인은 전체 범위(조회 ∧ 쓰기) 관리자만.
 *  · 랙 종류(전 법인 공용 목록): 조회 ∧ 쓰기 전체 범위 관리자만(`isFullReadWriteScope`).
 *  · 연결 정보(iDRAC): 서버만 서비스 태그로 잇는다(2026-11-19 사용자 결정). 서버 목록은 범위로 먼저 자른다(`scopeIdracServers`).
 *    관리 주소는 관리자 판본에만(IP 로 등록한 서버의 id · 이름도 비관리자에게는 가린다 — 다른 iDRAC 화면과 같은 addressMatcher).
 *    시리얼(서비스 태그)은 관리자 또는 전체(조회) 범위 계정에게만(2026-11-20 사용자 결정 — rack/CLAUDE.md) — 범위 비관리자에게는 싣지 않고
 *    이름 · 호스트 이름에 든 태그도 걷어 낸다(stripTag). ⚠ 물리서버 폴더는 범위 관리자에게도 태그를 숨긴다 — 랙은 관리자가 원장을 편집하므로
 *    관리자에게는 보인다(점검 C26: 예전 주석의 '폴더와 같은 기준' 은 틀린 말이었다).
 *  · 엑셀 내보내기: `data.csv` 권한 + 조회와 같은 범위.
 * ── 동시 편집 ──────────────────────────────────────────────────────────────
 *  · 전산실 단위 쓰기(랙 · 장비)는 본문 `rev` 가 지금 판과 같을 때만 반영한다 — 아니면 409 `revConflict` + 지금 rev(조용히 덮어쓰지 않는다).
 * ⚠ 폴링하지 않는다 — 화면은 열 때 1회 + 새로 고침 + 쓰기 뒤 재조회. 응답 캐시는 두지 않는다(원장이 쓰기마다 바뀌고 조회가 가볍다).
 */
import ExcelJS from 'exceljs';
import { requirePerm, requireRole } from '../../auth/auth.js';
import { isAdminDetailUser } from '../../auth/demoGuest.js';
import { scopedVcenterIds, writeScopedVcenterIds, isFullReadWriteScope } from '../../auth/scope.js';
import { listDatacenters, getDatacenterAssign } from '../../datacenter/store.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { clientIp } from '../../util/rateLimit.js';
import { analysisServersWithRemote, invForServer } from '../../insights/analysisServers.js';
import { scopeIdracServers } from '../admin/idracCore.js';
import { hwSummaryOf, mgmtHostOf } from '../../idrac/hwSummary.js';
import { partHealthRollup } from '../../idrac/invView.js';
import { cleanText, cleanPlaceInput, cleanRackInput, intIn, rackTotals, serialKeyOf, LIMITS, KIND_LABEL } from '../../rack/layout.js';
import * as R from '../../rack/db.js';
import { VERSION_KEEP } from '../../rack/versions.js';
import { acquireExport } from '../../util/exportBusy.js';
import { addressMatcher, maskIdentityFields } from '../../auth/addressMask.js';
import { stripTag } from './svcInventory.js';
import { TAG_MASK_MIN } from '../../util/ruleName.js';
import { todayStamp } from '../../util/dayKey.js';

const toolsPerm = requirePerm('tools');
const csvPerm = requirePerm('data.csv');
const adminRole = requireRole('admin');
const userOf = (req) => req.user?.username || 'anonymous';
const audit = (req, action, target, detail = '') => logAudit({ user: userOf(req), action, target, detail, ip: clientIp(req) });
const ID_RE = /^[a-f0-9]{16}$/;
const isId = (v) => typeof v === 'string' && ID_RE.test(v);

// ───────────────────────── 범위(법인) ─────────────────────────

/** 법인 → 할당 vCenter 목록. */
function corpVcenters() {
  const out = new Map();
  for (const [vc, dc] of Object.entries(getDatacenterAssign() || {})) {
    const d = String(dc || ''); if (!d) continue;
    if (!out.has(d)) out.set(d, []);
    out.get(d).push(String(vc));
  }
  return out;
}

/**
 * 이 사용자가 보는 · 고칠 수 있는 법인(순수에 가깝게 — 입력은 스냅샷 · 할당표).
 * @returns {{ read: Set<string>|null, write: Set<string>|null, isAdmin: boolean }}  null = 전부
 */
export function corpAccessOf(user, snap, vcOfCorp = corpVcenters()) {
  const rset = scopedVcenterIds(user, snap);
  const wset = writeScopedVcenterIds(user, snap);
  const isAdmin = isAdminDetailUser(user);
  let read = null;
  if (rset) {
    read = new Set();
    for (const [corp, vcs] of vcOfCorp) if (vcs.some((v) => rset.has(v))) read.add(corp);
  }
  let write = null;
  if (!isAdmin) write = new Set();
  else if (wset) {
    write = new Set();
    for (const [corp, vcs] of vcOfCorp) if (vcs.length && vcs.every((v) => wset.has(v)) && (!read || read.has(corp))) write.add(corp);
  }
  return { read, write, isAdmin };
}
const canRead = (acc, corp) => !acc.read || acc.read.has(corp);
const canWrite = (acc, corp) => acc.isAdmin && (!acc.write || acc.write.has(corp));
const accessOf = (req) => corpAccessOf(req.user, store.get());
/** 시리얼을 보여 줄 수 있는가 — 전체(조회) 범위 계정 또는 관리자. */
const serialsVisible = (req) => isAdminDetailUser(req.user) || !scopedVcenterIds(req.user, store.get());

function sendErr(res, e) {
  if (e instanceof R.RackError) return res.status(e.status).json({ ok: false, reason: e.reason, ...e.extra });
  console.error('[rack] 처리 실패:', e?.message);
  return res.status(500).json({ ok: false, reason: '처리하지 못했습니다(서버 오류).' });
}

// ───────────────────────── 연결(서버 — 서비스 태그) ─────────────────────────

const HEALTH = { ok: 'ok', warning: 'warn', critical: 'crit' };
const healthOf = (v) => HEALTH[String(v || '').toLowerCase()] || (v ? 'unknown' : '');

/** 그 법인의 서버(범위로 먼저 자름) — 서비스 태그 키 → 서버. */
function corpServers(req, corpId) {
  const assign = getDatacenterAssign() || {};
  const { servers } = scopeIdracServers(req, analysisServersWithRemote({ user: req.user, query: {} }));
  const byKey = new Map();
  const list = [];
  for (const s of servers) {
    const dc = String(s.datacenterId || assign[String(s.vcenterId || s.mappedVcenterId || '')] || '');
    if (dc !== corpId) continue;
    let inv = null; try { inv = invForServer(s); } catch { inv = null; }
    const tag = String(s.serviceTag || inv?.system?.serviceTag || '').trim();
    const key = serialKeyOf(tag);
    const row = { s, inv, tag, key };
    list.push(row);
    if (key && !byKey.has(key)) byKey.set(key, row);
  }
  return { byKey, list };
}

/**
 * 비관리자 판본의 서버 식별 필드 가림(점검 C5 · C6 — 재현):
 *  · IP 로 등록한 iDRAC 는 등록부 id · 이름이 곧 관리 주소다 — 다른 iDRAC 화면과 같은 `addressMatcher` 로 id 는 토큰, 이름은 '이름 가림'.
 *  · 시리얼을 가리는 판본(범위 비관리자)은 이름 · 호스트 이름에 든 서비스 태그도 걷어 낸다(물리서버 폴더 · 서비스 인벤토리 `stripTag` 와 같은 함수 · 같은 임계).
 */
function maskServerIdentity(obj, row, { admin, showSerial }) {
  if (admin) return obj;
  const out = maskIdentityFields(obj, addressMatcher([row.s?.host, row.s?.id].filter(Boolean)), { idFields: ['serverId'], nameFields: ['name', 'hostname'] });
  if (!showSerial && String(row.tag || '').length >= TAG_MASK_MIN) {
    for (const f of ['name', 'hostname']) if (out[f]) out[f] = stripTag(out[f], row.tag);
    if (out.hw?.host) out.hw = { ...out.hw, host: stripTag(out.hw.host, row.tag) };
    if (out.hw?.os?.host) out.hw = { ...out.hw, os: { ...out.hw.os, host: stripTag(out.hw.os.host, row.tag) } };
  }
  return out;
}

function linkView(row, { admin, showSerial = true }) {
  const { s, inv } = row;
  const sys = inv?.system || {};
  const rollup = (k) => { const r = partHealthRollup(inv?.[k]); return r.state ? { state: r.state, ...r.counts } : null; };
  return maskServerIdentity({
    serverId: String(s.id),
    name: s.name || sys.hostName || '',
    hostname: sys.hostName || '',
    model: sys.model || s.model || '',
    powerState: sys.powerState || inv?.powerState || '',
    health: healthOf(sys.health),
    remote: !!s.remote,
    collectedAt: Number(inv?.collectedAt) || null,
    hw: hwSummaryOf(inv),
    parts: inv ? { psu: rollup('psus'), disk: rollup('disks'), mem: rollup('memoryDimms'), fan: rollup('fans') } : null,
    ...(admin ? { mgmtHost: mgmtHostOf(s.host) } : {}),
  }, row, { admin, showSerial });
}

// ───────────────────────── 조회 ─────────────────────────

async function treeView(req) {
  const acc = accessOf(req);
  const corps = listDatacenters().filter((d) => canRead(acc, String(d.id)))
    .map((d) => ({ id: String(d.id), name: d.name || String(d.id), writable: canWrite(acc, String(d.id)) }));
  const ids = new Set(corps.map((c) => c.id));
  const tree = await R.listTree(ids);
  // 범위 밖 법인의 원장(법인 목록에서 지워진 법인 포함)은 범위 계정에 주지 않는다 — 전체 범위면 '법인 목록에 없음' 으로 밝힌다.
  if (!acc.read) {
    const known = new Set(listDatacenters().map((d) => String(d.id)));
    const all = await R.listTree(null);
    for (const s of all.sites) if (!known.has(s.corpId) && !corps.some((c) => c.id === s.corpId)) corps.push({ id: s.corpId, name: `${s.corpId}(법인 목록에 없음)`, writable: canWrite(acc, s.corpId), orphan: true });
    return { corps, sites: all.sites, rooms: all.rooms };
  }
  return { corps, ...tree };
}

async function roomView(req, roomId) {
  const acc = accessOf(req);
  const data = await R.getRoom(roomId);
  if (!data || !canRead(acc, data.site.corpId)) return null;
  const corpId = data.site.corpId;
  const admin = isAdminDetailUser(req.user);
  const showSerial = serialsVisible(req);
  const { byKey, list } = corpServers(req, corpId);
  const placedKeys = await R.placedSerialKeys(corpId);
  const places = data.places.map((p) => {
    const row = p.kind === 'server' && p.serialKey ? byKey.get(p.serialKey) : null;
    const out = { ...p, link: row ? linkView(row, { admin, showSerial }) : null, linkState: p.kind !== 'server' ? 'n/a' : !p.serialKey ? 'no-serial' : row ? 'linked' : 'not-found' };
    delete out.serialKey;
    if (!showSerial) { out.serial = ''; out.extraSerials = []; out.serialHidden = true; }
    return out;
  });
  const placesByRack = new Map();
  for (const p of places) { if (!placesByRack.has(p.rackId)) placesByRack.set(p.rackId, []); placesByRack.get(p.rackId).push(p); }
  const racks = data.racks.map((r) => ({ ...r, totals: rackTotals(r, (placesByRack.get(r.id) || []).filter((p) => p.face !== 'rear')) }));
  // 미배치 = 이 법인 서버 중 원장 어디에도(이 법인 전 데이터센터) 서비스 태그가 없는 것.
  const unplacedAll = list.filter((x) => x.key && !placedKeys.has(x.key));
  const unplaced = unplacedAll.slice(0, 300).map((x) => maskServerIdentity({
    serverId: String(x.s.id), name: x.s.name || x.inv?.system?.hostName || '', model: x.inv?.system?.model || x.s.model || '',
    hostname: x.inv?.system?.hostName || '', ...(showSerial ? { serviceTag: x.tag } : {}),
  }, x, { admin, showSerial }));
  const noTag = list.filter((x) => !x.key).length;
  const corp = listDatacenters().find((d) => String(d.id) === corpId);
  return {
    ok: true,
    corp: { id: corpId, name: corp?.name || corpId },
    site: data.site, room: data.room, rev: data.room.rev,
    racks, places,
    unplaced, unplacedTotal: unplacedAll.length, serversNoTag: noTag,
    logs: data.logs.map((l) => ({ ...l, user: admin ? l.user : '' })),
    canEdit: canWrite(acc, corpId),
    serialsHidden: !showSerial,
    limits: LIMITS,
  };
}

// ───────────────────────── 엑셀 내보내기(사용자 엑셀 실장도와 같은 꼴) ─────────────────────────

/**
 * 엑셀 시트 이름 — 금지 글자(\\ / ? * [ ] :) · 앞뒤 작은따옴표 · 예약어 'History' 를 피하고 31자로 자른다(반증 F2 — 그런 전산실 이름이면 내보내기가 500 이었다).
 */
export function sheetNameOf(name) {
  let s = String(name || '').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31);
  while (s.startsWith("'")) s = s.slice(1);
  while (s.endsWith("'")) s = s.slice(0, -1);
  s = s.trim();
  if (!s) s = '전산실';
  if (s.toLowerCase() === 'history') s = `전산실 ${s}`;
  return s.slice(0, 31);
}

const fmtU = (p) => `U${p.uStart}${p.uSize > 1 ? `–${p.uStart + p.uSize - 1}` : ''}`;

/**
 * 시트 하나에 그리는 랙 수(점검 C4 — 측정): ExcelJS 의 mergeCells 는 병합마다 그 시트의 기존 병합 전부와 겹침을 검사해 비용이 병합 수의 제곱이다.
 * 랙 300개를 한 시트에 그리면 중앙 이벤트 루프가 약 21초 멈췄다(랙당 병합 약 55회). 시트를 RACKS_PER_SHEET 대씩 나누고 랙마다 양보한다.
 */
export const RACKS_PER_SHEET = 12;
/** 나눈 시트 이름 — 전산실 이름 뒤에 랙 번호 범위(31자 · 금지 글자 규칙은 sheetNameOf). 시트가 하나면 예전처럼 전산실 이름만. */
export function sheetNamesOf(roomName, rackCount, per = RACKS_PER_SHEET) {
  const n = Math.max(1, Math.ceil(rackCount / per));
  if (n === 1) return [sheetNameOf(roomName)];
  const out = [];
  for (let k = 0; k < n; k += 1) {
    const tail = ` ${k * per + 1}-${Math.min(rackCount, (k + 1) * per)}`;
    out.push(sheetNameOf(`${sheetNameOf(roomName).slice(0, 31 - tail.length).trim()}${tail}`));
  }
  return out;
}
const yieldTurn = () => new Promise((r) => setImmediate(r));

export async function buildRoomXlsx(view) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'THE DAVINCI';
  const names = sheetNamesOf(view.room.name, view.racks.length);
  const thin = { style: 'thin', color: { argb: 'FF808080' } };
  const box = { top: thin, left: thin, bottom: thin, right: thin };
  const COLS = 5; const GAP = 1;
  let ws = null;
  for (const [idx, rack] of view.racks.entries()) {
    const i = idx % RACKS_PER_SHEET;
    if (i === 0 || !ws) {
      ws = wb.addWorksheet(names[Math.floor(idx / RACKS_PER_SHEET)]);
      ws.getCell(1, 1).value = `${view.corp.name} › ${view.site.name} › ${view.room.name} — 랙 실장도(포탈 원장 · ${todayStamp()})`;
      ws.getCell(1, 1).font = { bold: true, size: 12 };
    }
    if (idx) await yieldTurn();   // 랙마다 양보 — 큰 전산실 내보내기가 다른 요청을 붙잡지 않게
    const c0 = 1 + i * (COLS + GAP);
    const H = rack.heightU;
    ws.getColumn(c0).width = 5; ws.getColumn(c0 + 1).width = 40; ws.getColumn(c0 + 2).width = 8; ws.getColumn(c0 + 3).width = 10; ws.getColumn(c0 + 4).width = 10;
    ws.getColumn(c0 + COLS).width = 3;
    ws.mergeCells(3, c0, 3, c0 + COLS - 1);
    const title = ws.getCell(3, c0);
    title.value = `${rack.name}${rack.role ? ` ${rack.role}` : ''}${rack.row ? ` · ${rack.row} 줄` : ''}`;
    title.font = { bold: true, size: 12 }; title.alignment = { horizontal: 'center' }; title.border = box;
    ['U', '장비', '무게(kg)', '운전전력(W)', '정격전력(W)'].forEach((h, k) => {
      const c = ws.getCell(4, c0 + k); c.value = h; c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000000' } }; c.alignment = { horizontal: 'center' }; c.border = box;
    });
    const rowOfU = (u) => 5 + (H - u);
    for (let u = H; u >= 1; u -= 1) {
      const r = rowOfU(u);
      ws.getCell(r, c0).value = u; ws.getCell(r, c0).alignment = { horizontal: 'center' };
      for (let k = 0; k < COLS; k += 1) ws.getCell(r, c0 + k).border = box;
    }
    const mine = view.places.filter((p) => p.rackId === rack.id);
    const front = mine.filter((p) => p.face !== 'rear');
    for (const p of front) {
      const top = rowOfU(p.uStart + p.uSize - 1); const bot = rowOfU(p.uStart);
      const cells = [c0 + 1, c0 + 2, c0 + 3, c0 + 4];
      if (bot > top) for (const c of cells) ws.mergeCells(top, c, bot, c);
      const lines = [p.label || '', [p.model, p.serial, ...(p.extraSerials || []), p.link?.hostname || ''].filter(Boolean).join(' / ')].filter(Boolean);
      const cell = ws.getCell(top, c0 + 1);
      cell.value = `${lines.join('\n')}${p.face === 'front' ? ' (앞 반깊이)' : ''}`;
      cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
      cell.font = { bold: true };
      [p.weightKg, p.opW, p.ratedW].forEach((v, k) => { const x = ws.getCell(top, c0 + 2 + k); x.value = v ?? null; x.alignment = { vertical: 'middle', horizontal: 'right' }; });
    }
    let r = rowOfU(1) + 1;
    const t = rack.totals;
    const part = (n, read) => (read < n ? ` (${n}대 중 ${read}대)` : '');
    const sumRow = (label, value) => {
      ws.mergeCells(r, c0, r, c0 + 2);
      const a = ws.getCell(r, c0); a.value = label; a.alignment = { horizontal: 'center' }; a.border = box;
      ws.mergeCells(r, c0 + 3, r, c0 + 4);
      const b = ws.getCell(r, c0 + 3); b.value = value; b.alignment = { horizontal: 'right' }; b.border = box;
      r += 1;
    };
    sumRow(`실장율(N/${H})`, t.usePct == null ? '—' : `${t.usePct}% (${t.usedU}U)`);
    sumRow('전력량 합계(운전)', t.opW == null ? '—' : `${t.opW} W${part(t.devices, t.opRead)}`);
    sumRow('전력량 합계(정격)', t.ratedW == null ? '—' : `${t.ratedW} W${part(t.devices, t.ratedRead)}`);
    sumRow('장비 무게 합계', t.weightKg == null ? '—' : `${t.weightKg} kg${part(t.devices, t.weightRead)}`);
    sumRow('세로 PDU(A · B 계통)', `A ${rack.pduA} · B ${rack.pduB}`);
    const rear = mine.filter((p) => p.face === 'rear');
    for (const p of rear) sumRow(`후면 ${fmtU(p)}`, [p.label, p.model, p.serial].filter(Boolean).join(' / '));
  }
  if (!ws) {   // 랙이 없는 전산실도 제목 시트 하나는 남긴다(예전 동작)
    ws = wb.addWorksheet(names[0]);
    ws.getCell(1, 1).value = `${view.corp.name} › ${view.site.name} › ${view.room.name} — 랙 실장도(포탈 원장 · ${todayStamp()})`;
    ws.getCell(1, 1).font = { bold: true, size: 12 };
  }
  return wb.xlsx.writeBuffer();
}

// ───────────────────────── 쓰기 ─────────────────────────

const intRev = (v) => (Number.isInteger(v) ? v : (typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : null));

/** 쓰기 대상의 법인을 찾아 '조회 밖 404 → 쓰기 밖 403'. 통과하면 { corpId, roomId }. */
async function gate(req, res, kind, id) {
  if (!isId(id)) { res.status(400).json({ ok: false, reason: '대상 id 가 올바르지 않습니다.' }); return null; }
  const found = await R.corpOf(kind, id);
  const acc = accessOf(req);
  if (!found || !canRead(acc, found.corpId)) { res.status(404).json({ ok: false, reason: '대상을 찾지 못했습니다.' }); return null; }
  if (!canWrite(acc, found.corpId)) { res.status(403).json({ ok: false, error: 'forbidden', reason: '이 법인의 랙 실장도를 고칠 권한이 없습니다(관리자 · 그 법인 쓰기 범위만).' }); return null; }
  return found;
}

/** 본문 { op, ... } 하나로 받는 쓰기 연산. */
async function runOp(req, res) {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const op = cleanText(b.op, 32);
  const user = userOf(req);
  const rev = intRev(b.rev);
  const name = cleanText(b.name, LIMITS.name);
  try {
    switch (op) {
      case 'site.add': {
        const corpId = cleanText(b.corpId, 64);
        const acc = accessOf(req);
        if (!corpId || !canRead(acc, corpId) || !listDatacenters().some((d) => String(d.id) === corpId)) return res.status(404).json({ ok: false, reason: '법인을 찾지 못했습니다.' });
        if (!canWrite(acc, corpId)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '이 법인의 랙 실장도를 고칠 권한이 없습니다(관리자 · 그 법인 쓰기 범위만).' });
        if (!name) return res.status(400).json({ ok: false, reason: '데이터센터 이름이 비어 있습니다.' });
        const r = await R.addSite({ corpId, name, user });
        audit(req, 'rack.site.add', corpId, name);
        return res.json({ ok: true, ...r });
      }
      case 'site.rename': case 'site.remove': {
        const g = await gate(req, res, 'site', b.id); if (!g) return undefined;
        if (op === 'site.rename' && !name) return res.status(400).json({ ok: false, reason: '이름이 비어 있습니다.' });
        const r = op === 'site.rename' ? await R.renameSite({ id: b.id, name, user }) : await R.removeSite({ id: b.id, user });
        audit(req, `rack.${op}`, g.corpId, name || b.id);
        return res.json({ ok: true, ...r });
      }
      case 'room.add': {
        const g = await gate(req, res, 'site', b.siteId); if (!g) return undefined;
        if (!name) return res.status(400).json({ ok: false, reason: '전산실 이름이 비어 있습니다.' });
        const r = await R.addRoom({ siteId: b.siteId, name, user });
        audit(req, 'rack.room.add', g.corpId, name);
        return res.json({ ok: true, ...r });
      }
      case 'room.rename': case 'room.remove': {
        const g = await gate(req, res, 'room', b.id); if (!g) return undefined;
        if (op === 'room.rename' && !name) return res.status(400).json({ ok: false, reason: '이름이 비어 있습니다.' });
        const r = op === 'room.rename' ? await R.renameRoom({ id: b.id, name, user }) : await R.removeRoom({ id: b.id, user });
        audit(req, `rack.${op}`, g.corpId, name || b.id);
        return res.json({ ok: true, ...r });
      }
      case 'version.restore': {
        const corpId = cleanText(b.corpId, 64);
        const acc = accessOf(req);
        if (!corpId || !canRead(acc, corpId)) return res.status(404).json({ ok: false, reason: '법인을 찾지 못했습니다.' });
        if (!canWrite(acc, corpId)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '이 법인의 랙 실장도를 고칠 권한이 없습니다(관리자 · 그 법인 쓰기 범위만).' });
        const versionId = intRev(b.versionId); const expectLatestId = intRev(b.expectLatestId);
        if (versionId == null) return res.status(400).json({ ok: false, reason: '판 번호가 올바르지 않습니다.' });
        const r = await R.restoreVersion({ corpId, versionId, expectLatestId, user });
        audit(req, 'rack.version.restore', corpId, `판 #${versionId} → 새 판 #${r.latestId}`);
        return res.json({ ok: true, ...r });
      }
      case 'type.add': case 'type.remove': {
        if (!isAdminDetailUser(req.user) || !isFullReadWriteScope(req.user, store.get())) {
          return res.status(403).json({ ok: false, error: 'forbidden', reason: '랙 종류는 전 법인 공용 목록이라 조회 · 쓰기 모두 전체 범위인 관리자만 바꿀 수 있습니다.' });
        }
        if (op === 'type.remove') {
          if (!isId(b.id)) return res.status(400).json({ ok: false, reason: '대상 id 가 올바르지 않습니다.' });
          const r = await R.removeType({ id: b.id });
          audit(req, 'rack.type.remove', b.id);
          return res.json({ ok: true, ...r });
        }
        const heightU = intIn(b.heightU, LIMITS.minHeightU, LIMITS.maxHeightU);
        if (!name || heightU == null) return res.status(400).json({ ok: false, reason: `이름과 높이(${LIMITS.minHeightU}~${LIMITS.maxHeightU}U)를 넣으세요.` });
        const mm = (v) => (v === '' || v == null ? null : intIn(v, 100, 3000));
        const r = await R.addType({ name, heightU, widthMm: mm(b.widthMm), depthMm: mm(b.depthMm) });
        audit(req, 'rack.type.add', name, `${heightU}U`);
        return res.json({ ok: true, ...r });
      }
      case 'rack.add': case 'rack.update': case 'rack.remove': {
        const g = await gate(req, res, op === 'rack.add' ? 'room' : 'rack', op === 'rack.add' ? b.roomId : b.id); if (!g) return undefined;
        let r;
        if (op === 'rack.remove') r = await R.removeRack({ roomId: g.roomId, rev, user, id: b.id });
        else {
          const c = cleanRackInput(b.rack, { partial: op === 'rack.update' });
          if (c.error) return res.status(400).json({ ok: false, reason: c.error });
          if (c.value.typeId && !isId(c.value.typeId)) return res.status(400).json({ ok: false, reason: '랙 종류 id 가 올바르지 않습니다.' });
          r = op === 'rack.add' ? await R.addRack({ roomId: g.roomId, rev, user, input: c.value }) : await R.updateRack({ roomId: g.roomId, rev, user, id: b.id, input: c.value });
        }
        audit(req, `rack.${op}`, g.corpId, String(op === 'rack.add' ? (r?.id || '') : b.id));
        return res.json({ ok: true, ...r });
      }
      case 'place.add': case 'place.update': case 'place.remove': {
        const g = await gate(req, res, op === 'place.add' ? 'rack' : 'place', op === 'place.add' ? b.rackId : b.id); if (!g) return undefined;
        let r;
        if (op === 'place.remove') r = await R.removePlace({ roomId: g.roomId, rev, user, id: b.id });
        else {
          const c = cleanPlaceInput(b.place, { partial: op === 'place.update' });
          if (c.error) return res.status(400).json({ ok: false, reason: c.error });
          if (op === 'place.add') r = await R.addPlace({ roomId: g.roomId, rev, user, rackId: b.rackId, input: c.value });
          else {
            if (b.rackId != null && b.rackId !== '' && !isId(b.rackId)) return res.status(400).json({ ok: false, reason: '옮길 랙 id 가 올바르지 않습니다.' });
            r = await R.updatePlace({ roomId: g.roomId, rev, user, id: b.id, rackId: b.rackId || '', input: c.value });
          }
        }
        audit(req, `rack.${op}`, g.corpId, String(op === 'place.add' ? (r?.id || '') : b.id));
        return res.json({ ok: true, ...r });
      }
      default:
        return res.status(400).json({ ok: false, reason: '알 수 없는 연산입니다.' });
    }
  } catch (e) { return sendErr(res, e); }
}

export function registerRack(api) {
  api.get('/tools/rack', toolsPerm, async (req, res) => {
    try {
      const acc = accessOf(req);
      const t = await treeView(req);
      const types = await R.listTypes();
      res.json({
        ok: true, ...t, types,
        canEditTypes: isAdminDetailUser(req.user) && isFullReadWriteScope(req.user, store.get()),
        isAdmin: acc.isAdmin, kinds: KIND_LABEL, limits: LIMITS,
      });
    } catch (e) { sendErr(res, e); }
  });
  // 법인별 판(최근 30개) — 조회는 그 법인 조회 범위 · 작업자 계정명은 관리자 판본만(변경 이력과 같은 기준).
  api.get('/tools/rack/versions', toolsPerm, async (req, res) => {
    try {
      const corpId = cleanText(req.query?.corp, 64);
      const acc = accessOf(req);
      if (!corpId || !canRead(acc, corpId)) return res.status(404).json({ ok: false, reason: '법인을 찾지 못했습니다.' });
      const admin = isAdminDetailUser(req.user);
      const versions = (await R.listVersions(corpId)).map((v) => ({ ...v, user: admin ? v.user : '' }));
      return res.json({ ok: true, corpId, versions, latestId: versions[0]?.id ?? null, keep: VERSION_KEEP, canRestore: canWrite(acc, corpId) });
    } catch (e) { return sendErr(res, e); }
  });
  api.get('/tools/rack/versions/:vid', toolsPerm, async (req, res) => {
    try {
      const corpId = cleanText(req.query?.corp, 64);
      const acc = accessOf(req);
      if (!corpId || !canRead(acc, corpId) || !/^\d{1,12}$/.test(String(req.params.vid))) return res.status(404).json({ ok: false, reason: '판을 찾지 못했습니다.' });
      const d = await R.versionDetail(corpId, Number(req.params.vid));
      if (!d) return res.status(404).json({ ok: false, reason: '판을 찾지 못했습니다.' });
      if (!isAdminDetailUser(req.user)) d.version.user = '';
      return res.json({ ok: true, ...d });
    } catch (e) { return sendErr(res, e); }
  });
  api.get('/tools/rack/room/:id', toolsPerm, async (req, res) => {
    if (!isId(req.params.id)) return res.status(404).json({ ok: false, reason: '전산실을 찾지 못했습니다.' });
    try {
      const v = await roomView(req, req.params.id);
      if (!v) return res.status(404).json({ ok: false, reason: '전산실을 찾지 못했습니다.' });
      return res.json(v);
    } catch (e) { return sendErr(res, e); }
  });
  api.get('/tools/rack/room/:id/xlsx', toolsPerm, csvPerm, async (req, res) => {
    if (!isId(req.params.id)) return res.status(404).json({ ok: false, reason: '전산실을 찾지 못했습니다.' });
    try {
      const v = await roomView(req, req.params.id);
      if (!v) return res.status(404).json({ ok: false, reason: '전산실을 찾지 못했습니다.' });
      // 반증 F6: 무거운 내보내기는 동시 1건(util/exportBusy.js — 루트 CLAUDE.md 성능 규약).
      const lock = acquireExport('rack-xlsx', req);
      if (!lock.ok) return res.status(lock.status).json(lock.body);
      let buf;
      try { buf = await buildRoomXlsx(v); } finally { lock.release(); }
      const fname = `rack-${v.site.name}-${v.room.name}.xlsx`.replace(/[^\w.\-가-힣]/g, '_');
      audit(req, 'rack.export', v.corp.id, `${v.site.name} › ${v.room.name}`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="rack.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
      return res.end(Buffer.from(buf));
    } catch (e) { return sendErr(res, e); }
  });
  api.post('/tools/rack/op', adminRole, toolsPerm, (req, res) => {
    if (!isAdminDetailUser(req.user)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '랙 실장도는 관리자만 고칠 수 있습니다.' });
    return runOp(req, res);
  });
}
