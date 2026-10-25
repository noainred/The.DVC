/**
 * views/tools/backupViewText.js — '백업' 메뉴(백업 서머리 · 백업 세부내용, v2.779) 화면의 순수 헬퍼.
 * 사용자 요청: "1개 vcenter 를 선택하면 VM 백업 전체 현황 · 전체 28개 vcenter 의 백업 현황 · veeam 백업과 snapshot 둘다 표시"
 *   + 시안(디자인 캔버스 'VM 백업 현황 시안' — vCenter › 폴더 › 하위 폴더 › VM 표).
 * 판정은 서버(server/src/veeam/backupStatus.js)가 한다 — 여기서는 받은 값을 묶고 글자로 바꿀 뿐이다. 못 읽은 값은 '—'(0 이 아니다).
 * ⚠ 문구에 백틱 금지(값 인용은 ‘ ’).
 */

export const fmtNum = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '—');

/** n / total 의 정수 %(둘 중 하나라도 모르면 null). */
export function pctOf(n, total) {
  if (!(typeof n === 'number' && Number.isFinite(n)) || !(typeof total === 'number' && total > 0)) return null;
  return Math.round((n / total) * 100);
}

/** Veeam 쪽 상태(서버 veeamState) → 짧은 이름 · 색 톤. 모르는 코드는 '모름'(지어내지 않는다). */
export const VEEAM_STATE = {
  ok: { text: '정상', tone: 'ok' },
  partial: { text: '일부 서버만', tone: 'warn' },
  unlinked: { text: '연동 없음', tone: 'info' },
  'veeam-failed': { text: '읽기 실패', tone: 'bad' },
  'veeam-pending': { text: '첫 수집 대기', tone: 'muted' },
  'registry-unreadable': { text: '등록부 확인 불가', tone: 'bad' },
  'no-inventory': { text: 'VM 목록 수집 전', tone: 'muted' },
};
export const veeamStateOf = (s) => VEEAM_STATE[s] || { text: '모름', tone: 'muted' };

/** 스냅샷 기준을 못 낸 사유(서버 snapReason) → 짧은 이름. */
export const SNAP_REASON = {
  preparing: '준비 중', 'not-collected': '이벤트 미수집', 'stale-events': '이벤트 오래됨', 'no-account': 'Veeam 계정 모름',
  'log-off': '로그 수집 꺼짐', 'severity-filter': '로그 등급 제한', 'no-edge-data': '엣지 요약 없음', 'stale-edge': '엣지 요약 오래됨',
  'no-inventory': 'VM 목록 수집 전', 'no-collect-yet': '이벤트 수집 전',
};
export const snapReasonText = (r) => SNAP_REASON[r] || (r ? '모름' : '');

/** 다빈치/IRS — vCenter 화면과 같은 규칙(이름에 IRS 단어). */
export const isIrs = (name) => /\birs\b/i.test(String(name || ''));

/** 서머리 표 보기 필터. */
export function filterRows(rows, f) {
  const list = Array.isArray(rows) ? rows : [];
  if (f === 'davinci') return list.filter((r) => !isIrs(r.name));
  if (f === 'irs') return list.filter((r) => isIrs(r.name));
  if (f === 'warn') return list.filter((r) => needsAttention(r));
  return list;
}

/** 주의가 필요한 행 — Veeam 을 못 읽음·일부·결과 오래됨·이름 불일치 · 스냅샷을 모름 · 잔존 스냅샷. 연동 없음은 주의가 아니라 정보. */
export function needsAttention(r) {
  if (!r) return false;
  const vs = r.veeamState;
  if (vs && vs !== 'ok' && vs !== 'unlinked') return true;
  if (r.veeamStale > 0 || r.hostMismatch) return true;
  if (r.snap == null) return true;
  return r.snapStale > 0;
}

/*
 * 오른쪽 '주의가 필요한 곳' 목록(최대 n개 + 잘리면 '외 N건' 한 줄).
 * v2.781(점검 G3 C-I2): ① 심각한 것부터(bad → warn → info) 정렬한 **뒤에** 자른다 — 예전엔 vCenter 순서로 넣고 6개에서 잘라 뒤쪽의 '읽기 실패'·
 *   맨 끝 'Veeam 연동 없음 N곳' 요약이 소리 없이 사라졌다. 잘렸으면 { more:N } 항목 한 줄로 알린다.
 *   ② needsAttention(표의 '주의 필요' 보기)에 드는 행은 **반드시 한 줄 이상** 나온다 — Veeam 정상 + 스냅샷 모름·Veeam 결과 오래됨 행이 목록에 없어
 *   '없습니다' 인데 보기에는 행이 있던 어긋남(재현 verify/att.mjs).
 */
const TONE_RANK = { bad: 0, warn: 1, info: 2 };
export function attentionList(rows, n = 6) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  for (const r of list) {
    if (!r) continue;
    const vs = veeamStateOf(r.veeamState);
    const vBad = !!r.veeamState && r.veeamState !== 'ok' && r.veeamState !== 'unlinked';
    if (vBad) out.push({ id: r.id, tone: vs.tone === 'bad' ? 'bad' : 'warn', title: `${r.name} — Veeam ${vs.text}`, text: r.snap != null ? `스냅샷 기준 ${fmtNum(r.snap)}대는 보입니다` : '스냅샷 기준도 모릅니다' });
    else {
      if (r.hostMismatch) out.push({ id: r.id, tone: 'warn', title: `${r.name} — Veeam 이 다른 vCenter 이름으로 적음`, text: '포탈의 vCenter 주소와 Veeam 이 쓰는 이름이 다를 수 있습니다' });
      if (r.veeamStale > 0) out.push({ id: `${r.id}:vstale`, tone: 'warn', title: `${r.name} — Veeam 서버 ${fmtNum(r.veeamStale)}대 결과 오래됨`, text: '마지막으로 읽은 결과의 수입니다' });
      if (r.snap == null) out.push({ id: `${r.id}:snap`, tone: 'warn', title: `${r.name} — 스냅샷 기준 모름`, text: r.snapReason ? `사유: ${snapReasonText(r.snapReason)}` : '스냅샷 기준을 읽지 못했습니다' });
    }
    if (r.snapStale > 0) out.push({ id: `${r.id}:stale`, tone: 'warn', title: `${r.name} — 스냅샷 잔존 ${r.snapStale}대`, text: '하루 넘게 남은 Veeam 임시 스냅샷(정리 실패 의심)' });
  }
  const unlinked = list.filter((r) => r && r.veeamState === 'unlinked').map((r) => r.name);
  if (unlinked.length) out.push({ id: 'unlinked', tone: 'info', title: `Veeam 연동 없음 ${unlinked.length}곳`, text: `${unlinked.slice(0, 6).join(' · ')}${unlinked.length > 6 ? ' …' : ''} — 스냅샷 기준만 보입니다` });
  const sorted = out.map((a, i) => [a, i]).sort((x, y) => ((TONE_RANK[x[0].tone] ?? 1) - (TONE_RANK[y[0].tone] ?? 1)) || x[1] - y[1]).map(([a]) => a);
  if (sorted.length <= n) return sorted;
  const rest = sorted.length - n;
  return [...sorted.slice(0, n), { id: 'more', tone: 'muted', more: rest, title: `외 ${rest}건`, text: '나머지는 표의 ‘주의 필요’ 보기에서 볼 수 있습니다' }];
}

/*
 * v2.781(점검 G3 C-B2): 서머리 KPI 글자(순수) — 서버 backupTotals 의 '아는 vCenter 수·아는 VM 합' 으로 낸다.
 *  · 그 기준을 아는 vCenter 가 0 곳이면 '—'(예전엔 'Veeam 0 · 0%'·'실패 0 · 경고 0' 이었다)
 *  · 비율의 분모는 그 기준을 아는 vCenter 의 VM 합(vmVeeamKnown·vmSnapKnown) — 확인 불가 vCenter 의 VM 은 분모에서 뺀다(부제 '확인 불가 N곳 제외' 가 사실이 되게)
 *  · 일부 서버만·일부만 읽은 vCenter 가 있으면 값 뒤 '*'(VCenters 백업 KPI 와 같은 표지 — 부분 합)
 *  · '지금 백업 중' 은 마지막 읽기가 실패·오래된 서버가 있으면(runningUnknown) 하한 — 0 이면 '—', 아니면 '≥N'
 *  · 서버 필드가 없으면(옛 응답) 모름 쪽으로 — 0 으로 지어내지 않는다.
 */
const nz = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
export function summaryKpis(t0, { rpoDays = 1 } = {}) {
  const t = t0 && typeof t0 === 'object' ? t0 : {};
  const join = (parts, dflt) => parts.filter(Boolean).join(' · ') || dflt;
  const vcs = nz(t.vcenters); const vmUnknown = nz(t.vmUnknown);
  const vm = {
    value: vcs > vmUnknown ? `${fmtNum(t.vm)}${vmUnknown ? '*' : ''}` : '—',
    sub: join([`vCenter ${fmtNum(t.vcenters)}개`, vmUnknown ? `* VM 목록 수집 전 ${vmUnknown}곳` : '']),
  };
  const vRead = nz(t.veeamKnownVcs); const vUnknown = nz(t.veeamUnknown); const vPartial = nz(t.veeamPartial);
  // 연동 없음뿐이면 'Veeam 0' 은 사실(없음 확정) — 읽어야 할 vCenter 를 하나도 못 읽었으면 모름
  const vShow = vRead > 0 || (vUnknown === 0 && nz(t.vmVeeamKnown) > 0);
  const vPct = vShow ? pctOf(t.veeam, t.vmVeeamKnown) : null;
  const veeam = {
    value: vShow ? `${fmtNum(t.veeam)}${vPartial ? '*' : ''}${vPct != null ? ` · ${vPct}%` : ''}` : '—',
    sub: join([vUnknown ? `확인 불가 ${vUnknown}곳 제외` : '', t.veeamUnlinked ? `연동 없음 ${t.veeamUnlinked}곳` : '', vPartial ? `* 일부 서버만 ${vPartial}곳` : ''], 'Veeam 서버 기준'),
  };
  const sKnown = nz(t.snapKnownVcs); const sPartial = nz(t.snapPartial);
  const sPct = sKnown ? pctOf(t.snap, t.vmSnapKnown) : null;
  const snap = {
    value: sKnown ? `${fmtNum(t.snap)}${sPartial ? '*' : ''}${sPct != null ? ` · ${sPct}%` : ''}` : '—',
    sub: join([t.snapUnknown ? `확인 불가 ${t.snapUnknown}곳 제외` : '', sPartial ? `* 일부만 읽음 ${sPartial}곳` : ''], '최근 7일 Veeam 스냅샷 · 지금 스냅샷'),
  };
  const rUnknown = nz(t.runningUnknown);
  const runText = (v) => (!vRead ? '—' : rUnknown ? (nz(v) > 0 ? `≥${fmtNum(v)}` : '—') : fmtNum(v));
  const running = {
    value: runText(t.running),
    sub: join([`대기 ${runText(t.pending)}`, rUnknown ? `모름 ${rUnknown}곳(마지막 읽기 실패·오래됨)` : '']),
  };
  const k = `d${RPO_DAYS.includes(Number(rpoDays)) ? Number(rpoDays) : 1}`;
  const rpo = {
    value: vRead ? `${fmtNum(t.rpo?.[k])}${vPartial ? '*' : ''}` : '—',
    sub: vRead ? join([t.rpo?.unknown ? `시각 모름 ${fmtNum(t.rpo.unknown)}` : '', `실패 ${fmtNum(t.failed)} · 경고 ${fmtNum(t.warning)}`])
      : (vUnknown ? `Veeam 확인 불가 ${vUnknown}곳` : 'Veeam 백업 대상 중'),
  };
  return { vm, veeam, snap, running, rpo };
}

/** v2.781(점검 G3 B-B1): 표의 '백업 중' 칸 — 마지막 읽기가 실패·오래된 서버가 있으면 0 은 '—', 아니면 하한 '≥N'. */
export const RUNNING_STALE_TITLE = '마지막 읽기가 실패했거나 오래된 Veeam 서버가 있어 그 서버의 백업 중 수는 모릅니다(실제보다 적을 수 있음)';
export function runningCell(r) {
  const n = r && typeof r.running === 'number' && Number.isFinite(r.running) ? r.running : null;
  if (n == null) return { text: '—', active: false, sort: null };
  if (r.runningStale) return n > 0 ? { text: `≥${fmtNum(n)}`, active: true, sort: n, title: RUNNING_STALE_TITLE } : { text: '—', active: false, sort: null, title: RUNNING_STALE_TITLE };
  return { text: fmtNum(n), active: n > 0, sort: n };
}

/* ── v2.780 범위 옵션(두 화면 공유) ─────────────────────────────────────── */

/** 전원 범위 — 서버 ?power= 값. 일시 중지(Suspended)는 꺼짐에 든다 · 전원을 모르는 VM 은 켜짐·꺼짐 어느 쪽에도 넣지 않는다(서버가 따로 센다). */
export const POWER = [['all', '전체'], ['on', '켜짐'], ['off', '꺼짐']];
/** 오래된 백업 기준(일) — 서버 RPO_DAYS 와 같다. */
export const RPO_DAYS = [1, 3, 7];
const OPTS_KEY = 'backup-opts';
export const DEFAULT_OPTS = Object.freeze({ power: 'all', excl: true, rpoDays: 1 });

/** 저장된 옵션 — 못 읽으면(사생활 모드·차단·깨진 값) 기본값. 아는 값만 받는다. */
export function loadOpts(storage) {
  try {
    const st = storage === undefined ? globalThis.localStorage : storage;
    const raw = st ? JSON.parse(st.getItem(OPTS_KEY) || 'null') : null;
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_OPTS };
    return {
      power: POWER.some(([k]) => k === raw.power) ? raw.power : DEFAULT_OPTS.power,
      excl: raw.excl !== false,
      rpoDays: RPO_DAYS.includes(Number(raw.rpoDays)) ? Number(raw.rpoDays) : DEFAULT_OPTS.rpoDays,
    };
  } catch { return { ...DEFAULT_OPTS }; }
}
export function saveOpts(o, storage) {
  try {
    const st = storage === undefined ? globalThis.localStorage : storage;
    if (st) st.setItem(OPTS_KEY, JSON.stringify({ power: o.power, excl: o.excl !== false, rpoDays: o.rpoDays }));
  } catch { /* 저장 못 해도 화면은 그대로 동작 */ }
}
/** 서버 조회 쿼리(전원·제외). */
export const scopeQuery = (o) => ({ power: o.power, excl: o.excl === false ? '0' : '1' });
/** 범위 안내 — '템플릿·vCLS N대 제외 · 전원 모름 N대'(0 이면 그 조각을 뺀다 · 모르면 빈 글자).
 * scope = 응답 scope({power, excl}) · counts = 서머리 totals 또는 세부 row({excluded, powerUnknown}). */
export function scopeNote(scope, counts) {
  if (!scope || !counts) return '';
  const parts = [];
  if (scope.excl && counts.excluded > 0) parts.push(`템플릿·vCLS ${fmtNum(counts.excluded)}대 제외`);
  if (scope.power !== 'all' && counts.powerUnknown > 0) parts.push(`전원 모름 ${fmtNum(counts.powerUnknown)}대(켜짐·꺼짐 어디에도 넣지 않음)`);
  return parts.join(' · ');
}

/* ── 세부내용: VM 분류 · 폴더 트리 ───────────────────────────────────────── */

/** VM 한 대의 분류. v 키가 없으면 Veeam 모름(서버가 못 읽음), null 이면 Veeam 없음.
 * v2.780: old(마지막 백업이 rpoDays 일을 넘음) · fail(그 VM 마지막 결과가 실패·경고) — 서버 backupStatus.js viewClass 와 같은 판정(테스트가 대조). */
export function vmClass(vm, { rpoDays = 1, now = Date.now() } = {}) {
  const vKnown = !!vm && 'v' in vm && vm.v !== undefined;
  const v = vKnown ? vm.v : null;
  const sKnown = !!(vm && vm.s && 'ev' in vm.s && vm.s.ev !== undefined);
  const snapNow = vm?.s?.now || null;
  const snapEv = sKnown ? vm.s.ev : null;
  const snap = !!(snapEv || (snapNow && !snapNow.stale));
  const r = v ? String(v.lr || v.lastResult || '') : '';
  const days = RPO_DAYS.includes(Number(rpoDays)) ? Number(rpoDays) : 1;
  return {
    vKnown, veeam: !!v, run: !!(v && (v.state === 'run' || v.state === 'wait')), sKnown, snap, stale: !!(snapNow && snapNow.stale),
    old: !!(v && typeof v.lb === 'number' && Number.isFinite(v.lb) && now - v.lb > days * 86_400_000), fail: /^(fail|warn)/i.test(r),
  };
}

export const FILTERS = [
  ['all', '전체'], ['veeam', 'Veeam 백업'], ['snaponly', '스냅샷만'], ['none', '확인 안 됨'], ['run', '백업 중·대기'], ['stale', '스냅샷 잔존'],
  ['rpo', '오래된 백업'], ['fail', '실패·경고'],
];

/** VM 이 보기 필터에 드는가. '확인 안 됨' 은 두 쪽을 다 읽었는데 둘 다 없을 때만(모름은 넣지 않는다). */
export function vmMatches(vm, f, opts) {
  const c = vmClass(vm, opts);
  if (f === 'veeam') return c.veeam;
  if (f === 'snaponly') return !c.veeam && c.snap;
  if (f === 'none') return c.vKnown && c.sKnown && !c.veeam && !c.snap;
  if (f === 'run') return c.run;
  if (f === 'stale') return c.stale;
  if (f === 'rpo') return c.old;
  if (f === 'fail') return c.fail;
  return true;
}

/** 필터별 VM 수. */
export function filterCounts(vms, opts) {
  const out = {};
  for (const [k] of FILTERS) out[k] = 0;
  for (const vm of Array.isArray(vms) ? vms : []) for (const [k] of FILTERS) if (vmMatches(vm, k, opts)) out[k]++;
  return out;
}

/** VM 의 폴더 경로 조각 — vCenter › VM 및 폴더 화면과 같은 규칙('vm' 마디는 뺀다). */
export const folderParts = (folder) => String(folder || 'vm').split('/').filter((p) => p && p !== 'vm');

const nat = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * 폴더 트리 — 필터·검색에 드는 VM 만 담고, 폴더마다 그 아래(전체 VM 기준 — 필터와 무관)의 집계를 단다.
 * @returns {{ key:'', name:string, children:Array, vms:Array, agg:{n,veeam,snap,run,none} }}
 */
export function buildTree(vms, { filter = 'all', q = '', rpoDays = 1, now = Date.now() } = {}) {
  const root = { key: '', name: '', children: new Map(), vms: [], agg: { n: 0, veeam: 0, snap: 0, run: 0, none: 0 }, hit: 0 };
  const needle = String(q || '').trim().toLowerCase();
  for (const vm of Array.isArray(vms) ? vms : []) {
    const parts = folderParts(vm.folder);
    const c = vmClass(vm);
    const show = vmMatches(vm, filter, { rpoDays, now }) && (!needle || String(vm.name || '').toLowerCase().includes(needle) || parts.join('/').toLowerCase().includes(needle));
    let node = root;
    const path = [root];
    for (const p of parts) {
      const key = node.key ? `${node.key}/${p}` : p;
      let next = node.children.get(p);
      if (!next) { next = { key, name: p, children: new Map(), vms: [], agg: { n: 0, veeam: 0, snap: 0, run: 0, none: 0 }, hit: 0 }; node.children.set(p, next); }
      node = next; path.push(node);
    }
    for (const n of path) {
      n.agg.n++; if (c.veeam) n.agg.veeam++; if (c.snap) n.agg.snap++; if (c.run) n.agg.run++;
      if (c.vKnown && c.sKnown && !c.veeam && !c.snap) n.agg.none++;
      if (show) n.hit++;
    }
    if (show) node.vms.push(vm);
  }
  const fin = (n) => ({ key: n.key, name: n.name, agg: n.agg, hit: n.hit,
    children: [...n.children.values()].filter((x) => x.hit > 0).sort((a, b) => nat.compare(a.name, b.name)).map(fin),
    vms: n.vms.slice().sort((a, b) => nat.compare(String(a.name || ''), String(b.name || ''))) });
  return fin(root);
}

/**
 * 트리를 그릴 행으로 편다 — 열린 폴더만 아래를 보인다. 검색·필터 중이면(forceOpen) 전부 연다.
 * @returns {Array<{kind:'folder'|'vm', depth:number, key:string, node?:object, vm?:object, open?:boolean}>}
 */
export function flattenTree(tree, open, { forceOpen = false } = {}) {
  const rows = [];
  const walk = (n, depth) => {
    for (const c of n.children) {
      const isOpen = forceOpen || (open && open.has(c.key));
      rows.push({ kind: 'folder', depth, key: c.key, node: c, open: isOpen });
      if (isOpen) walk(c, depth + 1);
    }
    for (const vm of n.vms) rows.push({ kind: 'vm', depth, key: `vm:${vm.id}`, vm });
  };
  if (tree) walk(tree, 0);
  return rows;
}

/** 처음 열 폴더 — 첫 단계(데이터센터)와 그 아래 첫 단계까지. */
export function initialOpen(tree) {
  const s = new Set();
  for (const c of tree?.children || []) { s.add(c.key); for (const g of c.children || []) s.add(g.key); }
  return s;
}

const p2 = (x) => String(x).padStart(2, '0');
/** 'MM-DD HH:MM'(모르면 '—'). */
export function shortTs(ms) {
  if (!(typeof ms === 'number' && Number.isFinite(ms) && ms > 0)) return '—';
  const d = new Date(ms);
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** VM 의 Veeam 칸 — { text, tone }(tone: ok·run·wait·none·unknown). */
export function veeamCell(vm) {
  if (!vm || !('v' in vm)) return { text: '모름', tone: 'unknown' };
  const v = vm.v;
  if (!v) return { text: '—', tone: 'none' };
  if (v.state === 'run') return { text: Number.isFinite(v.pg) ? `백업 중 ${v.pg}%` : '백업 중', tone: 'run' };
  if (v.state === 'wait') return { text: '대기', tone: 'wait' };
  return { text: v.lb ? `Veeam ${shortTs(v.lb)}` : 'Veeam', tone: 'ok' };
}

/** VM 의 스냅샷 칸 — 잔존 > 지금 스냅샷 > 최근 N일 시도 > 없음/모름. */
export function snapCell(vm, days = 7) {
  const s = vm?.s || {};
  if (s.now && s.now.stale) return { text: `잔존${s.now.ts ? ` ${Math.max(1, Math.round((Date.now() - s.now.ts) / 3_600_000))}h` : ''}`, tone: 'stale' };
  if (s.now) return { text: '지금 스냅샷', tone: 'now' };
  if (!('ev' in s)) return { text: '모름', tone: 'unknown' };
  if (s.ev) return { text: `${days}일 ${Number.isInteger(s.ev.n) ? `${s.ev.n}회` : '시도'}`, tone: 'ev' };
  return { text: '—', tone: 'none' };
}
