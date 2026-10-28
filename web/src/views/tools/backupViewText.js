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
 * 오른쪽 '주의가 필요한 곳' 목록(주의 최대 n개 + 잘리면 '외 N곳' 한 줄 + 연동 없음 요약).
 * v2.781(점검 G3 C-I2): ① 심각한 것부터(bad → warn → info) 정렬한 **뒤에** 자른다 — 예전엔 vCenter 순서로 넣고 6개에서 잘라 뒤쪽의 '읽기 실패'·
 *   맨 끝 'Veeam 연동 없음 N곳' 요약이 소리 없이 사라졌다. 잘렸으면 { more:N } 항목 한 줄로 알린다.
 *   ② needsAttention(표의 '주의 필요' 보기)에 드는 행은 **반드시 한 줄 이상** 나온다 — Veeam 정상 + 스냅샷 모름·Veeam 결과 오래됨 행이 목록에 없어
 *   '없습니다' 인데 보기에는 행이 있던 어긋남(재현 verify/att.mjs).
 * v2.782(점검 K4 F-B3): ③ 'Veeam 연동 없음 N곳' 요약(정보)은 n개 상한에 넣지 않고 **늘 맨 끝**에 붙인다 — ① 의 정렬은 info 를 맨 뒤로 보내므로
 *   목록이 넘치면 잘리는 것은 늘 그 요약이었고, '외 N건' 이 안내하는 '주의 필요' 보기(needsAttention — 연동 없음 제외)에는 그 행이 없었다.
 *   ④ '외 N곳' 은 항목 수가 아니라 **'주의 필요' 보기의 행 중 목록에 안 나온 행 수**다(한 행이 여러 줄을 낼 수 있다 — 버튼이 가는 보기와 같은 단위).
 *   항목마다 rowId(그 행 id)를 단다(id 는 'vcid:snap' 처럼 접미가 붙고 vCenter id 에도 ':' 가 있을 수 있어 잘라 쓰지 않는다).
 */
const TONE_RANK = { bad: 0, warn: 1, info: 2 };
export function attentionList(rows, n = 6) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  for (const r of list) {
    if (!r) continue;
    const vs = veeamStateOf(r.veeamState);
    const vBad = !!r.veeamState && r.veeamState !== 'ok' && r.veeamState !== 'unlinked';
    if (vBad) out.push({ id: r.id, rowId: r.id, tone: vs.tone === 'bad' ? 'bad' : 'warn', title: `${r.name} — Veeam ${vs.text}`, text: r.snap != null ? `스냅샷 기준 ${fmtNum(r.snap)}대는 보입니다` : '스냅샷 기준도 모릅니다' });
    else {
      if (r.hostMismatch) out.push({ id: r.id, rowId: r.id, tone: 'warn', title: `${r.name} — Veeam 이 다른 vCenter 이름으로 적음`, text: '포탈의 vCenter 주소와 Veeam 이 쓰는 이름이 다를 수 있습니다' });
      if (r.veeamStale > 0) out.push({ id: `${r.id}:vstale`, rowId: r.id, tone: 'warn', title: `${r.name} — Veeam 서버 ${fmtNum(r.veeamStale)}대 결과 오래됨`, text: '마지막으로 읽은 결과의 수입니다' });
      if (r.snap == null) out.push({ id: `${r.id}:snap`, rowId: r.id, tone: 'warn', title: `${r.name} — 스냅샷 기준 모름`, text: r.snapReason ? `사유: ${snapReasonText(r.snapReason)}` : '스냅샷 기준을 읽지 못했습니다' });
    }
    if (r.snapStale > 0) out.push({ id: `${r.id}:stale`, rowId: r.id, tone: 'warn', title: `${r.name} — 스냅샷 잔존 ${r.snapStale}대`, text: '하루 넘게 남은 Veeam 임시 스냅샷(정리 실패 의심)' });
  }
  const unlinked = list.filter((r) => r && r.veeamState === 'unlinked').map((r) => r.name);
  // v2.784: 백업 필요로 표시했는데 Veeam 백업이 안 보이는 VM — 한 줄 요약(정보 칸: '주의 필요' 보기·잘림 계산과 섞지 않는다)
  const gaps = list.filter((r) => r && typeof r.marks?.needGap === 'number' && r.marks.needGap > 0).sort((a, b) => b.marks.needGap - a.marks.needGap);
  if (gaps.length) {
    const sum = gaps.reduce((a, r) => a + r.marks.needGap, 0);
    out.push({ id: 'needgap', tone: 'info', title: `백업 필요인데 Veeam 백업 없음 ${fmtNum(sum)}대`, text: `${gaps.slice(0, 4).map((r) => `${r.name} ${fmtNum(r.marks.needGap)}`).join(' · ')}${gaps.length > 4 ? ' …' : ''} — Detail 의 ‘백업 필요·미백업’ 보기` });
  }
  // v2.785(GR R-B2): 표시 파일을 못 읽은 행(marks null)이 있으면 미백업 줄이 소리 없이 사라지지 않게 한 줄(정보 칸 — 행 문제 아님)
  const marksUnknownN = list.filter((r) => r && r.marks === null).length;
  if (marksUnknownN) out.push({ id: 'marks-unknown', tone: 'info', title: `백업 표시 수 모름 ${marksUnknownN}곳`, text: '표시 파일을 읽지 못해 중요도·백업 필요·미백업 수를 셀 수 없습니다 — 설정 폴더의 backup-marks.json 을 확인하세요' });
  if (unlinked.length) out.push({ id: 'unlinked', tone: 'info', title: `Veeam 연동 없음 ${unlinked.length}곳`, text: `${unlinked.slice(0, 6).join(' · ')}${unlinked.length > 6 ? ' …' : ''} — 스냅샷 기준만 보입니다` });
  const sorted = out.map((a, i) => [a, i]).sort((x, y) => ((TONE_RANK[x[0].tone] ?? 1) - (TONE_RANK[y[0].tone] ?? 1)) || x[1] - y[1]).map(([a]) => a);
  const info = sorted.filter((a) => a.tone === 'info');
  const att = sorted.filter((a) => a.tone !== 'info');
  if (att.length <= n) return [...att, ...info];
  const shown = att.slice(0, n);
  const shownRows = new Set(shown.map((a) => a.rowId));
  const rest = filterRows(list, 'warn').filter((r) => !shownRows.has(r.id)).length;
  if (rest) return [...shown, { id: 'more', tone: 'muted', more: rest, title: `외 ${rest}곳`, text: '나머지는 표의 ‘주의 필요’ 보기에서 볼 수 있습니다' }, ...info];
  // v2.783(점검 Q3 L-B4 — 재현 att.mjs): 잘린 항목이 전부 **이미 보인 행**의 다른 문제(예: Veeam 읽기 실패 행의 스냅샷 잔존)면 rest 가 0 이라
  //   안내 없이 사라졌다(v2.781 C-I2 '잘렸으면 한 줄로 알린다' 보장의 회귀). 그때는 잘린 **항목 수**를 '외 N건(보인 곳의 다른 문제)' 로 알린다 —
  //   그 행들은 '주의 필요' 보기에 있으므로 버튼이 가는 곳도 같다.
  const hidden = att.length - shown.length;
  return [...shown, ...(hidden > 0 ? [{ id: 'more', tone: 'muted', more: hidden, title: `외 ${hidden}건(보인 곳의 다른 문제)`, text: '목록에 나온 곳의 다른 주의 항목입니다 — 표의 ‘주의 필요’ 보기에서 볼 수 있습니다' }] : []), ...info];
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
    crit: CRIT_KEYS.includes(vm?.m?.crit) ? vm.m.crit : '', need: vm?.m?.need === true,
    method: METHOD_KEYS.includes(vm?.m?.method) ? vm.m.method : '',   // v2.803 백업 방식(사람이 정한 값)
  };
}

/* ── v2.784 사람이 정한 표시(중요도 · 백업 필요 · 메모) ─────────────────────── */
const CRIT_KEYS = ['high', 'mid', 'low'];
/** 중요도 3단계(사용자 선택) — 글자 · 색. 아이콘은 화면이 그린다(방패 모양 · 색으로 구분). */
export const CRIT = [
  { key: 'high', text: '상', label: '중요도 상', color: '#f87171' },
  { key: 'mid', text: '중', label: '중요도 중', color: '#fb923c' },
  { key: 'low', text: '하', label: '중요도 하', color: '#94a3b8' },
];
export const critOf = (k) => CRIT.find((c) => c.key === k) || null;
/**
 * v2.803 백업 방식(사용자 요청 '업무 중요도 다음 — Veeam · Clone · Config 백업 · 백업 안함') — 사람이 정한 값만(수집값으로 추정하지 않는다).
 *   글자는 서버 veeam/backupStatus.js METHOD_TEXT 와 같다(테스트 대조). 색은 화면 칩 — 글자와 함께 쓴다(색만으로 구분하지 않게).
 */
export const METHODS = [
  { key: 'veeam', text: 'Veeam', color: '#86efac' },
  { key: 'clone', text: 'Clone', color: '#67e8f9' },
  { key: 'config', text: 'Config 백업', color: '#a78bfa' },
  { key: 'none', text: '백업 안함', color: '#94a3b8' },
];
const METHOD_KEYS = METHODS.map((m) => m.key);
export const methodOf = (k) => METHODS.find((m) => m.key === k) || null;
export const MEMO_MAX = 1000;   // 서버 veeam/backupMarks.js MEMO_MAX 와 같다(테스트 대조)
/**
 * 상단 지표 — 중요도별 · 백업 필요 · 미백업(needGap 을 모르면 '—').
 * v2.785(GR R-B2): unreadable(응답 marksUnreadable)이면 행 marks 가 null 이어도 모든 값 null(모름) + unknown — 화면은 '—'.
 *   값이 null 이면(서버 합계가 못 읽은 행 때문에 낸 null) 0 으로 바꾸지 않는다('못 읽은 값은 0 이 아니다'). 데이터가 없으면(옛 응답) null.
 */
const markNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export function marksLine(m, unreadable = false) {
  if (unreadable) return { high: null, mid: null, low: null, need: null, needGap: null, method: null, unknown: true };
  if (!m) return null;
  // v2.803 method — 백업 방식별 수 { veeam, clone, config, none, unset } · 옛 응답(없음)·모름은 null
  const method = m.method && typeof m.method === 'object' ? Object.fromEntries(['veeam', 'clone', 'config', 'none', 'unset'].map((k) => [k, markNum(m.method[k])])) : null;
  return { high: markNum(m.high), mid: markNum(m.mid), low: markNum(m.low), need: markNum(m.need), needGap: markNum(m.needGap), method,
    needGapUnknown: m.needGapUnknown > 0 ? m.needGapUnknown : undefined };
}
/**
 * v2.785(GR R-B2): 표시 파일 안내(서머리·세부 같은 문구) — 응답 { marksUnreadable, marksCorruptKept }.
 *   못 읽음(같은 프로세스 손상 — 수는 '—' · 저장 거부) > 손상 사본만 남음(재시작 뒤 새 파일로 시작 — 예전 표시가 빠졌을 수 있다). 없으면 null.
 */
export function marksNotice(d) {
  if (d?.marksUnreadable) return { tone: 'bad', text: '백업 표시 파일(backup-marks.json)을 읽지 못해 중요도·백업 필요 수를 모릅니다(—) · 표시를 바꿀 수 없습니다 — 설정 폴더의 손상 사본(backup-marks.json.corrupt.*)을 확인하세요.' };
  if (d?.marksCorruptKept) return { tone: 'warn', text: '예전에 손상돼 옆에 보존된 표시 파일(backup-marks.json.corrupt.*)이 있습니다 — 그때 정한 중요도·백업 필요·메모가 빠졌을 수 있습니다(수는 지금 파일 기준). 확인했으면 설정 폴더에서 그 사본을 치우면 이 안내가 사라집니다.' };
  return null;
}
/** v2.785(GR R-B2): 세부 보기 칩의 수 — 표시 기준 칩(백업 필요·미백업·중요도)은 표시를 모르면 '—'. */
const MARK_FILTER_KEYS = new Set(['need', 'needgap', 'crit-high', 'crit-mid', 'crit-low', 'method-veeam', 'method-clone', 'method-config', 'method-none', 'method-unset']);
export function filterCountText(k, counts, marksUnknown) {
  if (marksUnknown && MARK_FILTER_KEYS.has(k)) return '—';
  return counts?.[k];
}
/** v2.785(GR R-B3): 세부내용 조회 조건 키(vCenter · 전원 · 제외 — 서버가 세는 조건). 저장 직후 재조회가 지금 고른 조건과 같은지 본다. */
export const detailLoadKey = (vcId, opts) => `${vcId || ''}|${opts?.power || ''}|${opts?.excl ? 1 : 0}`;
/** 일괄 선택 — 보이는 VM 전부를 더하거나(전부 골라져 있으면) 뺀다. */
export function toggleAllVisible(sel, visibleIds) {
  const s = new Set(sel || []);
  const ids = Array.isArray(visibleIds) ? visibleIds : [];
  const allIn = ids.length > 0 && ids.every((id) => s.has(id));
  for (const id of ids) { if (allIn) s.delete(id); else s.add(id); }
  return s;
}

/**
 * v2.812(사용자 요청 '선택과 반전 기능') — 보이는 VM 의 선택을 뒤집는다: 고른 것은 풀고, 안 고른 것은 고른다.
 * 보이지 않는 VM(필터·검색 밖)의 선택은 그대로 둔다 — 일괄 적용 대상이 몰래 바뀌지 않게.
 */
export function invertVisible(sel, visibleIds) {
  const s = new Set(sel || []);
  for (const id of Array.isArray(visibleIds) ? visibleIds : []) { if (s.has(id)) s.delete(id); else s.add(id); }
  return s;
}

/**
 * v2.812(사용자 요청 '폴더를 선택하면 포함된 모든 VM 을 선택') — 폴더 키 → 그 폴더 아래(하위 폴더 포함) VM id 목록.
 * buildTree 결과를 받으므로 지금 보기 조건(필터·검색)에 드는 VM 만 담긴다 — '보이는 VM 전체 선택' 과 같은 규칙.
 * 접힌 폴더도 안의 VM 을 모두 담는다(펼침 여부와 무관). 한 번의 후위 순회로 만든다(VM 수 × 폴더 깊이).
 * @returns {Map<string, string[]>}
 */
export function folderVmIdMap(tree) {
  const out = new Map();
  const walk = (n) => {
    const ids = (n.vms || []).map((v) => v.id).filter((id) => id != null);
    for (const c of n.children || []) ids.push(...walk(c));
    if (n.key) out.set(n.key, ids);
    return ids;
  };
  if (tree) walk(tree);
  return out;
}

/** 폴더 체크 상태 — 'all'(모두 선택) · 'some'(일부) · 'none'(없음 · VM 0대 포함). */
export function folderCheckState(sel, ids) {
  const list = Array.isArray(ids) ? ids : [];
  if (!list.length || !sel || !sel.size) return 'none';
  let n = 0;
  for (const id of list) if (sel.has(id)) n++;
  return n === 0 ? 'none' : n === list.length ? 'all' : 'some';
}

export const FILTERS = [
  ['all', '전체'], ['veeam', 'Veeam 백업'], ['snaponly', '스냅샷만'], ['none', '확인 안 됨'], ['run', '백업 중·대기'], ['stale', '스냅샷 잔존'],
  ['rpo', '오래된 백업'], ['fail', '실패·경고'],
  ['need', '백업 필요'], ['needgap', '백업 필요·미백업'],
];
/** 중요도 필터 — 칩 줄에 두지 않고 상단 중요도 수를 누르면 적용한다(칩 줄이 길어지지 않게). 서버 VIEW_FILTERS 는 FILTERS + 이것. */
export const CRIT_FILTERS = [['crit-high', '중요도 상'], ['crit-mid', '중요도 중'], ['crit-low', '중요도 하']];
/** v2.803 백업 방식 필터 — 중요도처럼 칩 줄 밖(상단 백업 방식 수를 누르면 적용). 서버 VIEW_FILTERS = FILTERS + CRIT_FILTERS + 이것. */
export const METHOD_FILTERS = [...METHODS.map((m) => [`method-${m.key}`, `백업 방식 ${m.text}`]), ['method-unset', '백업 방식 미지정']];
export const filterLabel = (f) => ([...FILTERS, ...CRIT_FILTERS, ...METHOD_FILTERS].find(([k]) => k === f) || [f, f])[1];

/** VM 이 보기 필터에 드는가. '확인 안 됨' 은 두 쪽을 다 읽었는데 둘 다 없을 때만(모름은 넣지 않는다). */
export function vmMatches(vm, f, opts) {
  const c = vmClass(vm, opts);
  if (f === 'veeam') return c.veeam;
  // v2.783(점검 Q3 L-B3): Veeam 을 아는 VM 만 — 'Veeam 모름'(v 키 없음 · 첫 수집 전 서버 · 읽기 실패)인 스냅샷 VM 은 '스냅샷만'(요약 sOnly 와 같은 뜻 —
  //   Veeam 에 없다고 확인됨)이 아니다. 'none' 과 같은 규칙 · 서버 veeam/backupStatus.js vmViewMatches 와 웹 backupViewText.js vmMatches 는 한 쌍(대조 테스트).
  if (f === 'snaponly') return c.vKnown && !c.veeam && c.snap;
  if (f === 'none') return c.vKnown && c.sKnown && !c.veeam && !c.snap;
  if (f === 'run') return c.run;
  if (f === 'stale') return c.stale;
  if (f === 'rpo') return c.old;
  if (f === 'fail') return c.fail;
  if (f === 'need') return c.need;
  if (f === 'needgap') return c.need && c.vKnown && !c.veeam && c.method !== 'none' && c.method !== 'clone';   // Veeam 을 모르는 VM 은 넣지 않는다 · v2.806 백업 안함·Clone 은 미백업 아님(서버 vmViewMatches 와 한 쌍)
  if (f === 'crit-high' || f === 'crit-mid' || f === 'crit-low') return c.crit === f.slice(5);
  if (f.startsWith('method-')) return f === 'method-unset' ? !c.method : c.method === f.slice(7);   // 서버 vmViewMatches 와 한 쌍
  return true;
}

/** 필터별 VM 수. */
export function filterCounts(vms, opts) {
  const out = {};
  const keys = [...FILTERS, ...CRIT_FILTERS, ...METHOD_FILTERS].map(([k]) => k);
  for (const k of keys) out[k] = 0;
  for (const vm of Array.isArray(vms) ? vms : []) for (const k of keys) if (vmMatches(vm, k, opts)) out[k]++;
  return out;
}

/** VM 의 폴더 경로 조각 — vCenter › VM 및 폴더 화면과 같은 규칙('vm' 마디는 뺀다). */
export const folderParts = (folder) => String(folder || 'vm').split('/').filter((p) => p && p !== 'vm');

const nat = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * 폴더 트리 — 필터·검색에 드는 VM 만 담고, 폴더마다 그 아래(전체 VM 기준 — 필터와 무관)의 집계를 단다.
 * @returns {{ key:'', name:string, children:Array, vms:Array, agg:{n,veeam,snap,run,none,clone} }}   // v2.803 clone = 백업 방식 Clone 인 VM 수
 */
/** 보기 필터·검색에 드는 VM 인가(트리와 '보이는 VM 전체 선택' 이 같은 판정). needle 은 소문자로 다듬은 검색어. */
export function vmShown(vm, filter, needle, opts, parts = folderParts(vm?.folder)) {
  return vmMatches(vm, filter, opts) && (!needle || String(vm.name || '').toLowerCase().includes(needle) || parts.join('/').toLowerCase().includes(needle));
}
/** v2.784: 지금 보기에 드는 VM id(폴더를 접어 둔 것도 포함 — 일괄 적용 대상). */
export function visibleVmIds(vms, { filter = 'all', q = '', rpoDays = 1, now = Date.now() } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  return (Array.isArray(vms) ? vms : []).filter((vm) => vmShown(vm, filter, needle, { rpoDays, now })).map((vm) => vm.id);
}

/* ── v2.814 디스크 사용 용량(GB — 서버 backupStatus.gbOf: 0 이상 유한수 · 소수 1자리 · 모르면 null) ── */
const gbKnown = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
/** GB → '—' · '512 GB' · '1,000 GB' · '1.2 TB'(1024 GB 이상). 1자리 반올림. */
export function fmtGb(gb) {
  if (!gbKnown(gb)) return '—';
  if (gb >= 1024) return `${(gb / 1024).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} TB`;
  return `${(Math.round(gb * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })} GB`;
}
/**
 * 백업 방식별 용량 합 — { all, veeam, clone, config, none, unset, unknown(용량을 모르는 VM 수) }.
 * 표시 파일을 못 읽었으면(marksUnreadable) 방식별 합은 null(어느 방식인지 모른다) — 전체 합만.
 */
export function methodGbTotals(vms, { marksUnreadable = false } = {}) {
  const out = { all: 0, unknown: 0, ...Object.fromEntries([...METHOD_KEYS, 'unset'].map((k) => [k, marksUnreadable ? null : 0])) };
  for (const vm of Array.isArray(vms) ? vms : []) {
    if (!gbKnown(vm?.gb)) { out.unknown++; continue; }
    out.all += vm.gb;
    if (marksUnreadable) continue;
    const k = methodOf(vm?.m?.method) ? vm.m.method : 'unset';
    out[k] += vm.gb;
  }
  return out;
}

export function buildTree(vms, { filter = 'all', q = '', rpoDays = 1, now = Date.now() } = {}) {
  const root = { key: '', name: '', children: new Map(), vms: [], agg: { n: 0, veeam: 0, snap: 0, run: 0, none: 0, clone: 0, gb: 0, gbUnknown: 0 }, hit: 0 };
  const needle = String(q || '').trim().toLowerCase();
  for (const vm of Array.isArray(vms) ? vms : []) {
    const parts = folderParts(vm.folder);
    const c = vmClass(vm);
    const show = vmShown(vm, filter, needle, { rpoDays, now }, parts);
    let node = root;
    const path = [root];
    for (const p of parts) {
      const key = node.key ? `${node.key}/${p}` : p;
      let next = node.children.get(p);
      if (!next) { next = { key, name: p, children: new Map(), vms: [], agg: { n: 0, veeam: 0, snap: 0, run: 0, none: 0, clone: 0, gb: 0, gbUnknown: 0 }, hit: 0 }; node.children.set(p, next); }
      node = next; path.push(node);
    }
    for (const n of path) {
      n.agg.n++; if (c.veeam) n.agg.veeam++; if (c.snap) n.agg.snap++; if (c.run) n.agg.run++; if (c.method === 'clone') n.agg.clone++;
      if (c.vKnown && c.sKnown && !c.veeam && !c.snap) n.agg.none++;
      if (gbKnown(vm.gb)) n.agg.gb += vm.gb; else n.agg.gbUnknown++;   // v2.814 디스크 용량 합(모르는 VM 은 따로 센다 — 0 으로 더하지 않는다)
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
  if (!vm || !('v' in vm) || vm.v === undefined) return { text: '모름', tone: 'unknown' };   // v2.782 B-B3: v undefined 도 모름(viewClass 와 같은 판정)
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

/**
 * v2.806 백업 방식 단축키(사용자 요청 — VM 을 고른 상태에서 V Veeam · C Clone · G Config 백업 · N 백업 안함). 아니면 null.
 *   조합키(Ctrl·Meta·Alt)·IME 조합 중·누르고 있는 반복·입력 칸(input·textarea·select·편집 가능 요소)에 초점이 있으면 null — 메모를 쓰다가 글자가 백업 방식으로 바뀌지 않게.
 */
export const METHOD_KEYS_MAP = Object.freeze({ v: 'veeam', c: 'clone', g: 'config', n: 'none' });
export function methodKeyOf(e) {
  if (!e || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.repeat) return null;
  const t = e.target;
  const tag = String(t?.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return null;
  return METHOD_KEYS_MAP[String(e.key || '').toLowerCase()] || null;
}

/**
 * v2.803 '백업' 칸(사용자 요청 '스냅샷은 Veeam 이 없을 때 Veeam 자리에, Veeam 이 있으면 숨김') — Veeam 이 있으면 Veeam 칩,
 *   Veeam 이 없거나 모르면 스냅샷 칩(잔존·지금·최근 N일). 둘 다 없으면 Veeam 쪽 표기('—' · 모름)를 그대로 쓴다(스냅샷 '—' 로 Veeam 모름을 덮지 않는다).
 */
export function backupCell(vm, days = 7) {
  const v = veeamCell(vm);
  if (v.tone !== 'none' && v.tone !== 'unknown') return { ...v, src: 'veeam' };
  const s = snapCell(vm, days);
  if (s.tone !== 'none' && s.tone !== 'unknown') return { ...s, src: 'snap' };
  return { ...(v.tone === 'unknown' || s.tone === 'unknown' ? { text: '모름', tone: 'unknown' } : v), src: '' };
}
/**
 * v2.803 'Clone' 칸 — 백업 방식이 Clone 인 VM 에만 서버가 c 를 싣는다(키 없음 = 빈칸).
 *   c null(잡 목록 못 읽음)·unknown(실행 노드 보고 없음) '모름' · 잡 없음 · 아직 실행 안 함 · 'Clone 월-일 시:분'(성공 clone · 실패·건너뜀 bad) + 잡 꺼짐.
 */
export function cloneCell(vm) {
  if (!vm || !('c' in vm)) return null;
  const c = vm.c;
  if (!c || c.unknown) return { text: 'Clone · 모름', tone: 'unknown' };
  if (!c.job) return { text: 'Clone · 잡 없음', tone: 'cloneNone' };
  const off = c.on === false ? ' · 잡 꺼짐' : '';
  if (!(typeof c.at === 'number' && Number.isFinite(c.at))) return { text: `Clone · 아직 실행 안 함${off}`, tone: 'cloneNone' };
  if (c.skipped) return { text: `Clone 건너뜀 ${shortTs(c.at)}${off}`, tone: 'cloneBad' };
  return c.ok ? { text: `Clone ${shortTs(c.at)}${off}`, tone: 'clone' } : { text: `Clone 실패 ${shortTs(c.at)}${off}`, tone: 'cloneBad' };
}

/* ── v2.787 Veeam 백업 현황 Summary — 바로가기 · 법인별 표 · 우선순위 VM(사용자 요청 + 시안) ─────────── */

/** 바로가기 칩 점 색 — 읽기 실패(빨강) · 주의 필요(주황) · 연동 없음(회색) · 정상(초록). 판정은 needsAttention 하나(표의 '주의 필요' 보기와 같다). */
export function quickTone(r) {
  if (!r) return 'muted';
  if (r.veeamState === 'veeam-failed' || r.veeamState === 'registry-unreadable') return 'bad';
  if (needsAttention(r)) return 'warn';
  if (r.veeamState === 'unlinked') return 'muted';
  return 'ok';
}
export const QUICK_DOT = { bad: '#ef4444', warn: '#f59e0b', muted: '#64748b', ok: '#22c55e' };

/** 커버리지 막대 조각(%) — 둘 다 · Veeam 만 · 스냅샷만(나머지는 확인 안 됨). 나눔을 모르면 null(막대를 그리지 않는다). */
export function coverageOf(r) {
  const s = r?.split; const vm = r?.vm;
  if (!s || !(typeof vm === 'number' && vm > 0)) return null;
  const p = (n) => Math.round((n / vm) * 1000) / 10;
  return { both: p(s.both), vOnly: p(s.vOnly), sOnly: p(s.sOnly), none: p(s.none) };
}

export const SORTS = [['attn', '주의 많은 순'], ['cover', '커버리지 낮은 순'], ['vm', 'VM 많은 순'], ['name', '이름 순']];
/** 법인별 표의 처음 순서(제목을 누르면 STable 이 다시 정렬한다). 모르는 값(—)은 늘 뒤. */
export function sortRows(rows, key) {
  const list = (Array.isArray(rows) ? rows : []).slice();
  const nameCmp = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { numeric: true });
  const attn = (r) => (quickTone(r) === 'bad' ? 3 : quickTone(r) === 'warn' ? 2 : 0) + ((r.marks?.needGap || 0) > 0 ? 1 : 0);
  const cov = (r) => (typeof r.veeam === 'number' && r.vm > 0 ? r.veeam / r.vm : Infinity);
  if (key === 'cover') return list.sort((a, b) => (cov(a) - cov(b)) || nameCmp(a, b));
  if (key === 'vm') return list.sort((a, b) => ((b.vm ?? -1) - (a.vm ?? -1)) || nameCmp(a, b));
  if (key === 'name') return list.sort(nameCmp);
  return list.sort((a, b) => (attn(b) - attn(a)) || ((b.results?.failed || 0) - (a.results?.failed || 0)) || nameCmp(a, b));
}

/** 바로가기 찾기 — 법인 이름(대소문자 무시). */
export const matchSite = (r, q) => !String(q || '').trim() || String(r?.name || '').toLowerCase().includes(String(q).trim().toLowerCase());

export const PRIO_TABS = [['all', '전체'], ['gap', '백업 필요·미백업'], ['high', '중요도 상'], ['fail', '실패'], ['old', '오래된 백업'], ['stale', '스냅샷 잔존']];
/**
 * 우선순위 VM(서버 priorityCandidates) → 화면 목록. '오래된 백업' 은 고른 기준 일수로 판정하고, 문제가 하나도 남지 않는 후보는 뺀다.
 * 순서: 중요도 상 → 백업 필요 → 나머지 · 같은 단계에서 미백업 → 실패 → 잔존 → 오래된(이른 순).
 * @returns {{ items: Array, counts: Record<string, number> }}
 */
export function priorityView(items, { rpoDays = 1, now = Date.now() } = {}) {
  const days = RPO_DAYS.includes(Number(rpoDays)) ? Number(rpoDays) : 1;
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const old = typeof it.lb === 'number' && now - it.lb > days * 86_400_000;
    if (!it.gap && !it.fail && !it.cloneBad && !it.stale && !old) continue;
    const tags = [];
    // v2.806: 백업 방식 — Config 백업은 포탈이 확인할 수 없어 '확인 불가' · Clone 은 Veeam 부재 대신 복제 잡 상태(cloneBad)
    if (it.gap) tags.push(['gap', it.method === 'config' ? 'Config 백업 — 확인 불가' : 'Veeam 백업 없음']);
    if (it.cloneBad) tags.push(['fail', 'Clone 실패·잡 없음']);
    if (it.crit === 'high') tags.push(['high', '중요도 상']);
    if (it.need) tags.push(['need', '백업 필요']);
    if (it.fail) tags.push(['fail', '마지막 실패']);
    if (old) tags.push(['old', `${days}일+ 경과`]);
    if (it.stale) tags.push(['stale', '스냅샷 잔존']);
    out.push({ ...it, old, tags });
  }
  const tier = (x) => (x.crit === 'high' ? 0 : x.need ? 1 : 2);
  const prob = (x) => (x.gap ? 0 : (x.fail || x.cloneBad) ? 1 : x.stale ? 2 : 3);   // 서버 priorityRank 와 같은 단계
  out.sort((a, b) => (tier(a) - tier(b)) || (prob(a) - prob(b)) || ((a.lb ?? Infinity) - (b.lb ?? Infinity)) || String(a.name).localeCompare(String(b.name)));
  const counts = { all: out.length, gap: 0, high: 0, fail: 0, old: 0, stale: 0 };
  for (const x of out) { if (x.gap) counts.gap++; if (x.crit === 'high') counts.high++; if (x.fail || x.cloneBad) counts.fail++; if (x.old) counts.old++; if (x.stale) counts.stale++; }
  return { items: out, counts };
}
export const prioMatches = (x, tab) => (tab === 'all' ? true : tab === 'high' ? x.crit === 'high' : tab === 'fail' ? !!(x.fail || x.cloneBad) : !!x[tab]);   // v2.806 Clone 실패는 '실패' 탭
/** 폴더 끝 두 조각(‘A.MGMT › AD’) — 긴 경로가 칸을 넘지 않게. */
export const folderTail = (folder) => folderParts(folder).slice(-2).join(' › ') || '—';
