/**
 * Bareos 복원 › 폴더 표(v2.866 — 사용자 요청 '기존 복원 방식은 그대로 두고, VM 백업할 때 쓰는 폴더 목록 형태로 복원' · 시안 캔버스 ① 일반 복원).
 *   vCenter › (데이터센터) › 폴더 › VM 트리를 평평한 행 목록으로 만든다(순수 — 화면은 그리기만).
 *   VM 행은 백업 대상(원장)만 — 복원은 백업 대상만 할 수 있다. 폴더의 '전체 VM' 수는 인벤토리 폴더 집계(GET restore-folders)에서 온다 —
 *   못 읽었으면 null('—' · 0 이 아니다). 고를 수 있는지는 pickBlock(지금 복원 화면과 같은 판정) 하나로 본다.
 */
import { pickBlock, restoreIsOpen, verifyOutcome } from './bareosRestoreText.js';
import { whenText, levelLabel } from './bareosText.js';

const cmp = (a, b) => String(a).localeCompare(String(b), 'ko');
const okState = (s) => s === 'ok' || s === 'warning';

function newNode(key, label, kind) {
  return { key, label, kind, children: new Map(), jobs: [], own: 0, ownKnown: false };
}

/** 경로 조각 — 데이터센터가 둘 이상인 vCenter 만 데이터센터 단계를 둔다(하나면 그 단계는 접어 vCenter 이름 옆에 적는다). */
function segsOf(dc, folder, showDc) {
  const parts = String(folder || '').split('/').filter(Boolean);
  return showDc ? [String(dc || '—'), ...parts] : parts;
}

function walk(root, segs) {
  let n = root;
  let key = root.key;
  for (const s of segs) {
    key = `${key}/${s}`;
    if (!n.children.has(s)) n.children.set(s, newNode(key, s, 'folder'));
    n = n.children.get(s);
  }
  return n;
}

/** 아래까지 합친 값 — total(인벤토리 VM 수 · 못 읽었으면 null) · 대상 · 고를 수 있는 id · 진행 중 복원 · 용량 · 마지막 성공. */
function aggregate(n, ctx) {
  const ids = [];
  let targets = n.jobs.length;
  let total = ctx.countsKnown ? n.own : null;
  let open = 0;
  let sizeGB = 0;
  let sizeUnknown = 0;
  let lastOk = null;
  for (const j of n.jobs) {
    if (!pickBlock(j, { lockedDir: ctx.lockedDir })) ids.push(j.id);
    if ((j.restores || []).some(restoreIsOpen)) open += 1;
    const g = Number(j.storageGB);
    if (j.storageGB === null || j.storageGB === undefined || !Number.isFinite(g) || g < 0) sizeUnknown += 1; else sizeGB += g;
    const at = Number(j.lastOk?.at);
    if (Number.isFinite(at) && at > 0 && (lastOk === null || at > lastOk)) lastOk = at;
  }
  for (const c of n.children.values()) {
    const a = aggregate(c, ctx);
    targets += a.targets;
    if (total !== null) total = a.total === null ? null : total + a.total;
    ids.push(...a.ids);
    open += a.open;
    sizeGB += a.sizeGB;
    sizeUnknown += a.sizeUnknown;
    if (a.lastOk !== null && (lastOk === null || a.lastOk > lastOk)) lastOk = a.lastOk;
  }
  Object.assign(n, { targets, total, ids, open, sizeGB, sizeUnknown, lastOk });
  return n;
}

/**
 * @param {object[]} jobs  목록 응답의 대상(dc · folder · vcenterId · vmName · lastRun · lastOk · restores · powerState · storageGB · writable · directorId)
 * @param {{vcenterId,dc,folder,vms}[]|null} folders  인벤토리 폴더 VM 수(null = 못 읽음)
 * @param {{ q?:string, open?:Set<string>|null, onlyTargets?:boolean, lockedDir?:string, vcNames?:object, dirNames?:object }} o
 *   open = 펼친 행 열쇠(null 이면 대상이 있는 행을 모두 펼친다 · 찾기 중에도 모두 펼친다) · onlyTargets = 대상이 없는 폴더 숨기기
 * @returns {object[]} 행 — { key, kind:'vc'|'folder'|'vm', depth, label, open, hasKids, targets, total, ids, openRestores, sizeGB, sizeUnknown, lastOk, job?, why? }
 */
export function restoreFolderRows(jobs, folders, { q = '', open = null, onlyTargets = true, lockedDir = '', vcNames = {}, dirNames = {} } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  const list = (Array.isArray(jobs) ? jobs : []).filter((j) => !needle || `${j.vmName} ${j.dc || ''} ${j.folder || ''}`.toLowerCase().includes(needle));
  const countsKnown = Array.isArray(folders);
  const byVc = new Map();
  for (const j of list) {
    const k = String(j.vcenterId);
    if (!byVc.has(k)) byVc.set(k, { jobs: [], counts: [], dcs: new Set() });
    const v = byVc.get(k);
    v.jobs.push(j);
    v.dcs.add(String(j.dc || ''));
  }
  if (countsKnown) {
    for (const c of folders) {
      const v = byVc.get(String(c.vcenterId));
      if (!v) continue;   // 대상이 없는(또는 찾기에서 빠진) vCenter 는 그리지 않는다
      v.counts.push(c);
      if (!needle) v.dcs.add(String(c.dc || ''));
    }
  }
  const rows = [];
  for (const [vcId, v] of [...byVc.entries()].sort(([a], [b]) => cmp(vcNames[a] || a, vcNames[b] || b))) {
    const showDc = v.dcs.size > 1;
    const root = newNode(`vc:${vcId}`, vcNames[vcId] || vcId, 'vc');
    for (const c of v.counts) {
      const n = walk(root, segsOf(c.dc, c.folder, showDc));
      n.own += Number(c.vms) || 0;
    }
    for (const j of v.jobs) walk(root, segsOf(j.dc, j.folder, showDc)).jobs.push(j);
    // v2.870 감사 A4-03: 인벤토리에 VM 이 하나도 없는 vCenter(첫 수집 전 · 비활성)는 폴더 VM 수를 모른다 — '3/0' 이 아니라 '3/—'
    aggregate(root, { countsKnown: countsKnown && !needle && v.counts.length > 0, lockedDir });
    const dirs = [...new Set(v.jobs.map((j) => j.directorId || ''))].filter(Boolean);
    const isOpen = (n) => !!needle || (open ? open.has(n.key) : n.targets > 0);
    const push = (n, depth) => {
      const kids = [...n.children.values()].filter((c) => !onlyTargets || c.targets > 0).sort((a, b) => cmp(a.label, b.label));
      const o = isOpen(n);
      rows.push({
        key: n.key, kind: n.kind, depth, label: n.label, isOpen: o, hasKids: kids.length > 0 || n.jobs.length > 0,
        targets: n.targets, total: n.total, ids: n.ids, openRestores: n.open, sizeGB: n.sizeGB, sizeUnknown: n.sizeUnknown, lastOk: n.lastOk,
        ...(n.kind === 'vc' ? { dc: showDc ? '' : [...v.dcs][0] || '', director: dirs.map((d) => dirNames[d] || d).join(' · ') } : {}),
      });
      if (!o) return;
      for (const c of kids) push(c, depth + 1);
      for (const j of n.jobs.slice().sort((a, b) => cmp(a.vmName, b.vmName))) {
        rows.push({ key: `job:${j.id}`, kind: 'vm', depth: depth + 1, label: j.vmName, job: j, why: pickBlock(j, { lockedDir }) });
      }
    };
    push(root, 0);
  }
  return rows;
}

/** 'n / 전체' — 전체를 모르면 'n / —'. */
export function targetsText(row) {
  return `${row.targets}/${row.total === null || row.total === undefined ? '—' : row.total}`;
}

/** 막대 비율(0~100) — 전체를 모르거나 0 이면 null(막대를 그리지 않는다). */
export function targetsPct(row) {
  if (!Number.isFinite(row.total) || row.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((row.targets / row.total) * 100)));
}

/** GB → '410 GB' · '1.2 TB'. 모르면 '—'. 부분 합이면 뒤에 '+'(모르는 VM 이 있다 — 합이 실제보다 작다). */
export function sizeText(gb, unknown = 0) {
  const n = Number(gb);
  if (gb === null || gb === undefined || !Number.isFinite(n) || n < 0) return '—';
  if (n === 0 && unknown > 0) return '—';
  const t = n >= 1024 ? `${(n / 1024).toFixed(1)} TB` : `${Math.round(n)} GB`;
  return unknown > 0 ? `${t}+` : t;
}

/** VM 전원 — 모르면 '—'. */
export function powerText(p) {
  if (p === 'POWERED_ON' || p === 'poweredOn') return '켜짐';
  if (p === 'POWERED_OFF' || p === 'poweredOff') return '꺼짐';
  if (p === 'SUSPENDED' || p === 'suspended') return '일시 중지';
  return '—';
}

/** VM 의 마지막 백업 한 칸 — 결과 · 레벨. 실행 기록이 없으면 '실행 기록 없음'. */
export function lastRunText(job) {
  const r = job?.lastRun;
  if (!r) return { text: '실행 기록 없음', tone: 'muted' };
  const lv = r.level ? ` · ${levelLabel(r.level)}` : '';
  if (r.state === 'ok') return { text: `성공${lv}`, tone: 'ok' };
  if (r.state === 'warning') return { text: `경고${lv}`, tone: 'warn' };
  if (r.state === 'error') return { text: `실패${lv}`, tone: 'bad' };
  if (r.state === 'canceled') return { text: `취소${lv}`, tone: 'muted' };
  return { text: `진행 중${lv}`, tone: 'info' };
}

/** 마지막 성공 칸 — 포탈 기록에 성공이 없으면 그렇게 말한다(카탈로그에 더 오래된 성공이 있을 수 있어 '없음' 으로 단정하지 않는다). */
export function lastOkText(job) {
  const at = Number(job?.lastOk?.at);
  if (!Number.isFinite(at) || at <= 0) return { text: '포탈 기록에 없음', tone: 'warn', title: '포탈이 본 실행 중에 성공한 백업이 없습니다 — 복원 지점 읽기에서 Director 카탈로그로 확인합니다' };
  return { text: whenText(at), tone: '', title: '' };
}

/** 복원 상태 칸 — 진행 중 · 최근 복원(7일) · 검증 실패. 없으면 '—'. */
export function restoreStateText(job, now = Date.now()) {
  const rs = Array.isArray(job?.restores) ? job.restores : [];
  if (rs.some(restoreIsOpen)) return { text: '복원 진행 중', tone: 'info' };
  const recent = rs.filter((r) => Number(r.at) >= now - 7 * 86_400_000).sort((a, b) => Number(b.at) - Number(a.at))[0];
  if (recent?.verify) {
    // v2.870 감사 A2-02: 검증 판정은 verifyOutcome 하나(켜 보는 중 · 재시도 소진을 '검증 성공' 으로 보이던 것)
    const v = verifyOutcome(recent);
    if (v === 'ok') return { text: `검증 성공 · ${whenText(recent.at)}`, tone: 'ok' };
    if (v === 'failed') return { text: `검증 실패 · ${whenText(recent.at)}`, tone: 'bad' };
    return { text: `검증 중 · ${whenText(recent.at)}`, tone: 'info' };
  }
  if (recent) {
    const ok = okState(recent.state);
    return { text: `복원 ${ok ? '성공' : recent.state === 'error' ? '실패' : '끝남'} · ${whenText(recent.at)}`, tone: ok ? 'ok' : recent.state === 'error' ? 'bad' : 'muted' };
  }
  return { text: '—', tone: 'muted' };
}

/** 고른 VM 들의 용량 합(부분 합이면 sizeText 가 '+' 를 붙인다). */
export function pickedSize(jobs) {
  let gb = 0; let unknown = 0;
  for (const j of jobs) { const g = Number(j?.storageGB); if (j?.storageGB === null || j?.storageGB === undefined || !Number.isFinite(g) || g < 0) unknown += 1; else gb += g; }
  return sizeText(gb, unknown);
}

/** 보기(간단 목록 · 폴더 표) — 브라우저에 기억(사람별 편의 · 못 읽으면 기본). */
export const RESTORE_VIEWS = Object.freeze([['list', '간단 목록'], ['table', '폴더 표']]);
const VIEW_KEY = 'bareos.restore.view';
export function loadRestoreView(storage) {
  try { const v = storage?.getItem(VIEW_KEY); return RESTORE_VIEWS.some(([k]) => k === v) ? v : 'list'; } catch { return 'list'; }
}
export function saveRestoreView(v, storage) {
  try { storage?.setItem(VIEW_KEY, v); } catch { /* 사생활 보호 창 등 — 기억하지 못해도 된다 */ }
}

