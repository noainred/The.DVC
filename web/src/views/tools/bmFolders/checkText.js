// v3.45 물리서버 점검 글자 · 배치(보증 · 계약 만료 / 펌웨어 기준선 / BIOS 설정 편차 — 시안 docs/design/bm-feature-proposals ① ② ③).
// 판정은 서버가 한다(server/src/bmcheck) — 여기는 상태 코드를 줄로 옮길 뿐이다. 규약:
//   · 못 읽은 것 · 판정하지 않은 것은 정상에도 문제에도 넣지 않고 **따로 센다**(모름 · 못 읽음 · 보내지 않음 · 판정 안 함).
//   · ‘뒤처짐’ 은 기준과 다르다는 뜻이지 올려야 한다는 판정이 아니다 · ‘다수 값’ 은 옳다는 뜻이 아니다 — 그 말을 화면에 쓴다.
//   · 기준 일수(보증 ‘곧’)는 서버 값(soonDays)을 받아 쓴다(화면에 숫자를 박지 않는다).
import { numOrNull } from '../../../numOrNull.js';

/** 보증 상태 → 글자 · 배지 색. */
export const WTY_TEXT = Object.freeze({
  expired: { label: '보증 끝남', short: '끝남', badge: 'red' },
  soon: { label: '보증 곧 끝남', short: '곧 끝남', badge: 'amber' },
  ok: { label: '보증 안', short: '보증 안', badge: 'green' },
  unknown: { label: '보증 모름', short: '모름', badge: 'gray' },
});
/** 펌웨어 서버 상태. */
export const FW_TEXT = Object.freeze({
  ok: { label: '뒤처진 것 없음', badge: 'green' },
  behind: { label: '뒤처짐', badge: 'amber' },
  // 뒤처진 줄은 없지만 버전이 갈려 다수가 없거나 한 서버 안에서 섞인 구성요소가 있다 — ‘뒤처진 것 없음’ 이라 하지 않는다
  split: { label: '갈림 — 판정 못 함', badge: 'gray' },
  none: { label: '기준 없음', badge: 'gray' },
  unread: { label: '못 읽음', badge: 'gray' },
  // 엣지가 안 보냈는지 · 중앙이 그 엣지 이름을 확인하지 못해 안 받았는지 화면은 모른다 — ‘보내지 않음’ 이라고 단정하지 않는다
  unsent: { label: '엣지에서 받지 못함', badge: 'gray' },
});
/** 펌웨어 구성요소 줄 상태. */
export const FW_ROW_TEXT = Object.freeze({
  same: { label: '같음', badge: 'green' },
  behind: { label: '뒤처짐', badge: 'amber' },
  ahead: { label: '기준보다 높음', badge: 'blue' },
  differ: { label: '다름', badge: 'amber' },
  none: { label: '판정 안 함', badge: 'gray' },
  mixed: { label: '섞임', badge: 'gray' },
});
/** BIOS 서버 상태. */
export const BIOS_TEXT = Object.freeze({
  ok: { label: '다른 설정 없음', badge: 'green' },
  diff: { label: '다른 설정', badge: 'amber' },
  // 다수와 다른 설정은 없지만 값이 갈려 다수가 없는 설정이 있다 — ‘다른 설정 없음’ 이라 하지 않는다
  split: { label: '갈림 — 다수 없음', badge: 'gray' },
  none: { label: '견줄 서버 없음', badge: 'gray' },
  unread: { label: '못 읽음', badge: 'gray' },
  unsent: { label: '엣지에서 받지 못함', badge: 'gray' },
  unplaced: { label: '미분류 — 판정 안 함', badge: 'gray' },
});
export const BIOS_ROW_TEXT = Object.freeze({
  same: { label: '같음', badge: 'green' },
  diff: { label: '다름', badge: 'amber' },
  tie: { label: '다수 없음', badge: 'gray' },
  unread: { label: '값 없음', badge: 'gray' },
});
/** BIOS 설정 키(Dell 속성 이름) → 화면 이름. 모르는 키는 키 글자 그대로. */
export const BIOS_LABEL = Object.freeze({
  BootMode: 'Boot Mode', SysProfile: 'System Profile', SystemProfile: 'System Profile(구형)', ProcVirtualization: 'Virtualization Technology', LogicalProc: 'Logical Processor',
  ProcCores: 'Cores per Processor', SriovGlobalEnable: 'SR-IOV Global Enable', MemFrequency: 'Memory Frequency', MemOpMode: 'Memory Operating Mode', NodeInterleave: 'Node Interleaving',
  IntegratedRaid: 'Integrated RAID Controller', SecureBoot: 'Secure Boot', TpmSecurity: 'TPM Security', ProcTurboMode: 'Turbo Mode', EmbSata: 'Embedded SATA',
  InternalUsb: 'Internal USB Port', PowerManagement: 'Power Management', SerialComm: 'Serial Communication', OsWatchdogTimer: 'OS Watchdog Timer',
});
export const biosLabel = (k) => BIOS_LABEL[k] || String(k || '');

/** 남은 일수 글자 — 108일 남음 · 오늘 끝남 · 12일 지남. 모르면 ''. */
export function daysText(d) {
  const n = numOrNull(d);
  if (n == null) return '';
  if (n === 0) return '오늘 끝남';
  return n > 0 ? `${n}일 남음` : `${-n}일 지남`;
}
/** 개월 수 → ‘4년 8개월’ · ‘8개월’ · ‘1개월 미만’. 모르면 ''. */
export function monthsText(m) {
  const n = numOrNull(m);
  if (n == null || n < 0) return '';
  if (n === 0) return '1개월 미만';
  const y = Math.floor(n / 12); const r = n % 12;
  return [y ? `${y}년` : '', r ? `${r}개월` : ''].filter(Boolean).join(' ');
}

/** 목록 빠른 거르기 열쇠(저장한 보기의 허용 값이기도 하다). */
export const CHK_QUICK = Object.freeze(['wty:expired', 'wty:soon', 'wty:unknown', 'fw:behind', 'bios:diff', 'adv:hit']);
/** 그 행이 빠른 거르기에 맞는가. 점검 열쇠가 아니면 null(다른 거르기가 본다). */
export function chkQuickMatch(r, quick) {
  if (!CHK_QUICK.includes(quick)) return null;
  const c = r?.chk || {};
  if (quick === 'wty:expired') return c.w === 'expired';
  if (quick === 'wty:soon') return c.w === 'soon';
  if (quick === 'wty:unknown') return c.w === 'unknown';
  if (quick === 'fw:behind') return c.fw === 'behind';
  if (quick === 'adv:hit') return c.adva === 'hit';   // v3.49 펌웨어 보안 권고에 걸린 서버(시안 ④ ‘해당 서버 N대’ — 반증 B3)
  return c.bios === 'diff';
}

/**
 * 목록 요약 — 보증(끝남 · 곧 · 모름 · 보증 안 · 판정 못 함) / 펌웨어(뒤처짐 · 없음 · 기준 없음 · 못 읽음 · 보내지 않음) / BIOS(다름 …).
 * 판정 키가 없는 행(원장 · 찾기를 못 읽음 · ESXi 의 펌웨어)은 na 로 따로 센다(정상에 넣지 않는다).
 */
export function chkCounts(rows = []) {
  const w = { expired: 0, soon: 0, ok: 0, unknown: 0, na: 0 };
  const fw = { behind: 0, ok: 0, split: 0, none: 0, unread: 0, unsent: 0, na: 0 };
  const bios = { diff: 0, ok: 0, split: 0, none: 0, unread: 0, unsent: 0, unplaced: 0, na: 0 };
  const adv = { hit: 0, clear: 0, unmatched: 0, unknown: 0, 'no-fw': 0, 'no-table': 0, na: 0 };
  let bm = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const c = r?.chk || {};
    if (c.w in w && c.w !== 'na') w[c.w] += 1; else w.na += 1;
    if (r?.kind !== 'bm') continue;
    bm += 1;
    if (c.fw in fw && c.fw !== 'na') fw[c.fw] += 1; else fw.na += 1;
    if (c.bios in bios && c.bios !== 'na') bios[c.bios] += 1; else bios.na += 1;
    if (typeof c.adva === 'string' && Object.hasOwn(adv, c.adva) && c.adva !== 'na') adv[c.adva] += 1; else adv.na += 1;
  }
  return { n: (Array.isArray(rows) ? rows : []).length, bm, w, fw, bios, adv };
}

/** 빠른 거르기 칩 — [열쇠, 글자, 개수, 설명]. 개수가 0 이어도 칩은 보인다(0 이라는 사실이 정보다) — 판정 자체가 없으면(전부 na) 뺀다. */
export function chkChips(counts, soonDays) {
  const c = counts || chkCounts([]);
  const out = [];
  const days = numOrNull(soonDays);
  if (c.w.na < c.n) {
    out.push(['wty:expired', '보증 끝남', c.w.expired, '자산 원장의 보증 만료일이 지난 서버']);
    out.push(['wty:soon', '보증 곧 끝남', c.w.soon, days != null ? `보증 만료일까지 ${days}일 이하로 남은 서버` : '보증 만료일이 가까운 서버']);
    out.push(['wty:unknown', '보증 모름', c.w.unknown, '자산 원장에 없거나 만료일이 없는 서버 — 끝남에도 정상에도 넣지 않습니다']);
  }
  if (c.bm && c.fw.na < c.bm) out.push(['fw:behind', '펌웨어 뒤처짐', c.fw.behind, '기준(관리자 지정 또는 같은 법인 · 같은 모델의 다수 버전)과 다른 구성요소가 있는 서버']);
  if (c.bm && c.bios.na < c.bm) out.push(['bios:diff', 'BIOS 다름', c.bios.diff, '같은 폴더 · 같은 모델 서버의 다수 값과 다른 BIOS 설정이 있는 서버']);
  // 권고 표가 있을 때만(비었으면 대조하지 않았다 — 0 대로 보이지 않게)
  const a = c.adv || { na: c.bm, 'no-table': 0 };
  if (c.bm && a.na + (a['no-table'] || 0) < c.bm) out.push(['adv:hit', '보안 권고', a.hit || 0, '관리자가 올린 보안 권고 표와 대조해 설치 버전이 고친 버전보다 낮은 구성요소가 있는 서버(건강 점수에는 넣지 않습니다)']);
  return out;
}
/** 요약 줄의 ‘따로 센 것’ 글자 — 못 읽음 · 보내지 않음 · 판정 안 함. 없으면 ''. */
export function chkAsideText(counts) {
  const c = counts || chkCounts([]);
  const p = [];
  const fwNo = c.fw.unread + c.fw.unsent;
  if (fwNo) p.push(`펌웨어 못 읽음 ${c.fw.unread} · 엣지에서 받지 못함 ${c.fw.unsent}`);
  if (c.fw.none) p.push(`펌웨어 기준 없음 ${c.fw.none}`);
  if (c.fw.split) p.push(`펌웨어 갈림(판정 못 함) ${c.fw.split}`);
  const bNo = c.bios.unread + c.bios.unsent;
  if (bNo) p.push(`BIOS 못 읽음 ${c.bios.unread} · 엣지에서 받지 못함 ${c.bios.unsent}`);
  if (c.bios.split) p.push(`BIOS 갈림(다수 없음) ${c.bios.split}`);
  if (c.bios.none) p.push(`BIOS 견줄 서버 없음 ${c.bios.none}`);
  if (c.bios.unplaced) p.push(`BIOS 미분류(판정 안 함) ${c.bios.unplaced}`);
  if (c.adv?.unknown) p.push(`보안 권고 판정 못 함 ${c.adv.unknown}`);
  if (c.adv?.['no-fw']) p.push(`보안 권고 대조 못 함(펌웨어 못 읽음) ${c.adv['no-fw']}`);
  return p.join(' / ');
}

/**
 * 목록 위 안내 — 서버가 ‘그 판정을 하지 않았다’ 고 실어 준 표지를 글자로(반증 B5: 칩이 사라질 뿐 아무 말이 없었다).
 * @param {object|null} check 목록 응답의 check
 * @returns {string[]}
 */
export function chkNotices(check) {
  const c = check && typeof check === 'object' ? check : {};
  const out = [];
  if (c.assets?.unreadable) out.push('자산 원장 파일을 읽지 못해 보증을 판정하지 않았습니다 — 원장이 비었다는 뜻이 아닙니다(서비스 점검에서 확인).');
  if (c.noHw) out.push('하드웨어 정보를 찾지 못해 펌웨어 · BIOS 를 판정하지 않았습니다.');
  if (c.baselineUnreadable) out.push('관리자 지정 펌웨어 기준 파일을 읽지 못해 다수 버전으로만 대조했습니다(서비스 점검에서 확인).');
  return out;
}

/** 드로어 신호 줄 — 목록 행의 chk 로(상세를 받기 전에도 같은 말). [{ kind, tone, badge, label, fact }] */
export function chkSignals(r) {
  const c = r?.chk || {};
  const out = [];
  if (c.w === 'expired') out.push({ kind: 'wty', tone: 'warn', badge: '보증 끝남', label: `보증 끝남${numOrNull(c.wd) != null ? ` — ${daysText(c.wd)}` : ''}`, fact: '자산 원장의 보증 만료일이 지났습니다.' });
  else if (c.w === 'soon') out.push({ kind: 'wty', tone: 'info', badge: `보증 ${daysText(c.wd) || '곧 끝남'}`, label: `보증 곧 끝남${numOrNull(c.wd) != null ? ` — ${daysText(c.wd)}` : ''}`, fact: '자산 원장의 보증 만료일이 가깝습니다 — 연장 · 교체를 검토할 때입니다.' });
  if (c.fw === 'behind') out.push({ kind: 'fw', tone: 'info', badge: `펌웨어 뒤처짐${numOrNull(c.fwn) ? ` ${c.fwn}` : ''}`, label: `펌웨어 — 기준과 다른 구성요소${numOrNull(c.fwn) ? ` ${c.fwn}개` : ''}`, fact: '기준(관리자 지정 또는 같은 법인 · 같은 모델의 다수 버전)과 다릅니다 — 올려야 한다는 판정은 아닙니다.' });
  if (c.bios === 'diff') out.push({ kind: 'bios', tone: 'info', badge: `BIOS 다름${numOrNull(c.biosn) ? ` ${c.biosn}` : ''}`, label: `BIOS 설정 — 다수 값과 다른 설정${numOrNull(c.biosn) ? ` ${c.biosn}개` : ''}`, fact: '같은 폴더 · 같은 모델 서버의 다수 값과 다릅니다 — 다수 값이 옳다는 뜻은 아닙니다.' });
  return out;
}

const dash = (v) => (v == null || v === '' ? '—' : String(v));

/**
 * 보증 · 계약 구역 값.
 * @param {object|null} w 서버 응답의 warranty(null = 판정 못 함)
 * @param {{ soonDays?:number, admin?:boolean, unreadable?:boolean }} opt
 * @returns {{ state:string, badge:{label,color}|null, head:string, kv:{label,value,sub?,dim?}[], note:string }}
 */
export function warrantyView(w, { soonDays = null, admin = false, unreadable = false } = {}) {
  if (unreadable || !w) {
    return { state: 'na', badge: null, head: '', kv: [], note: unreadable
      ? '자산 원장 파일을 읽지 못해 보증을 판정하지 않았습니다 — 원장이 비었다는 뜻이 아닙니다(서비스 점검에서 확인).' : '보증 값을 받지 못했습니다.' };
  }
  const t = WTY_TEXT[w.state] || WTY_TEXT.unknown;
  const days = numOrNull(soonDays);
  const kv = [
    { label: '보증 만료', value: dash(w.end), sub: daysText(w.daysLeft), dim: !w.end },
    { label: '보증 종류', value: dash(w.type), dim: !w.type },
    { label: '구매일', value: dash(w.purchase), dim: !w.purchase },
    { label: '사용 기간', value: dash(monthsText(w.ageMonths)), dim: !monthsText(w.ageMonths) },
    // 계약 번호 · 비고는 관리자 판본에만 온다 — 다른 판본에서는 줄을 만들지 않는다(빈 칸으로도 보이지 않게)
    ...(admin ? [{ label: '유지보수 계약', value: dash(w.contract), dim: !w.contract }] : []),
    { label: '지원 종료(제조사)', value: dash(w.eos), sub: w.eosPassed === true ? '지났습니다' : '', dim: !w.eos },
    ...(admin && w.note ? [{ label: '비고', value: w.note, full: true }] : []),
  ];
  let note = '';
  if (w.state === 'unknown') note = w.why === 'no-end' ? '자산 원장에 이 서버가 있지만 보증 만료일이 없습니다 — 끝남에도 정상에도 넣지 않습니다.' : '자산 원장에 이 서버가 없습니다 — 끝남에도 정상에도 넣지 않습니다.';
  else if (w.state === 'soon' && days != null) note = `보증 만료일까지 ${days}일 이하로 남으면 ‘곧 끝남’ 으로 봅니다.`;
  return { state: w.state, badge: { label: t.label, color: t.badge }, head: w.end ? `${w.end}${daysText(w.daysLeft) ? ` · ${daysText(w.daysLeft)}` : ''}` : '', kv, note };
}

const basisText = (row) => (row.basis === 'admin' ? '관리자 지정' : row.basis === 'majority' ? `다수 버전${numOrNull(row.peers) != null && numOrNull(row.known) != null ? ` · ${row.known}대 중 ${row.peers}대` : ''}` : row.tie ? '버전이 갈림 — 다수 없음' : '기준 없음');
/**
 * 펌웨어 기준선 구역 값.
 * @returns {{ state:string, badge:{label,color}|null, head:string, rows:object[], note:string, why:string }}
 */
export function fwView(fw, { noHw = false, baselineUnreadable = false, invAt = null } = {}) {
  if (!fw) return { state: 'na', badge: null, head: '', rows: [], note: '', why: noHw ? '하드웨어 정보를 찾지 못해 펌웨어를 대조하지 않았습니다.' : '펌웨어 대조 값을 받지 못했습니다.', invAt: null };
  const t = FW_TEXT[fw.state] || FW_TEXT.none;
  const rows = (Array.isArray(fw.rows) ? fw.rows : []).map((r) => {
    const st = FW_ROW_TEXT[r.state] || FW_ROW_TEXT.none;
    return { key: r.key, type: r.type, label: r.label, installed: r.mixed ? '섞임' : dash(r.installed), baseline: dash(r.baseline), basis: basisText(r), basisKind: r.basis || '',
      // 버전 칸의 아래 줄 — 기준 버전과 그 근거를 한 줄로(기준이 없으면 근거만)
      baseSub: r.baseline ? `기준 ${r.baseline} · ${basisText(r)}` : basisText(r),
      state: r.state, stateText: st.label, badge: st.badge, raw: r };
  });
  let why = '';
  if (fw.state === 'unread') why = '이 서버의 펌웨어 목록이 없습니다(인벤토리를 아직 읽지 못했거나 장비가 목록을 주지 않았습니다) — 같음에도 뒤처짐에도 넣지 않습니다.';
  else if (fw.state === 'unsent') why = '이 서버를 수집하는 엣지에서 펌웨어 목록을 받지 못했습니다(엣지 판이 낮거나 · 그 엣지가 아직 읽지 못했거나 · 중앙이 그 엣지의 이름을 확인하지 못했습니다) — 같음에도 뒤처짐에도 넣지 않습니다.';
  else if (fw.state === 'split') {
    const n = numOrNull(fw.open);
    why = `뒤처진 구성요소는 없지만, 같은 모델 서버끼리 버전이 갈려 다수가 없거나 이 서버 안에서 버전이 섞인 구성요소가 ${n != null ? `${n}개 ` : ''}있습니다 — ‘뒤처진 것 없음’ 으로 보지 않습니다.`;
  }
  else if (fw.state === 'none') {
    // 이유는 상황마다 다르다(반증 B9): 대조하는 구성요소가 아예 없다 · 같은 모델이 이 서버뿐이다 · 그 밖(버전이 다 달라 다수가 없다 등)
    if (!rows.length) why = '이 서버의 펌웨어 목록에 대조하는 구성요소(BIOS · iDRAC · NIC · 저장장치 컨트롤러 · HBA)가 없습니다 — 판정하지 않습니다.';
    else if (numOrNull(fw.peers) != null && fw.peers <= 1) why = '같은 법인에 같은 모델 서버가 이 서버뿐이라 다수 버전이 없습니다 — 관리자가 기준을 지정하면 대조합니다.';
    else why = '대조할 기준이 없습니다 — 같은 법인의 같은 모델 서버 2대 이상이 같은 버전을 쓰거나 관리자가 기준을 지정해야 합니다.';
  }
  const peers = numOrNull(fw.peers);
  // 머리 글자: 기준보다 높은 것이 있으면 ‘다른 구성요소 없음’ 이라 하지 않는다(반증 B7) · 수를 모르면 단위를 붙이지 않는다(B13)
  const ahead = numOrNull(fw.ahead); const openN = numOrNull(fw.open);
  const head = fw.state === 'behind' ? `기준과 다른 구성요소 ${fw.behind}개`
    : fw.state === 'ok' ? (ahead > 0 ? `뒤처진 것 없음 · 기준보다 높은 구성요소 ${ahead}개` : '기준과 다른 구성요소 없음')
      : fw.state === 'split' ? (openN != null ? `판정하지 못한 구성요소 ${openN}개` : '판정하지 못한 구성요소 있음') : '';
  const notes = ['‘뒤처짐’ 은 기준과 다르다는 뜻이고 올려야 한다는 판정이 아닙니다.'];
  if (peers != null && peers >= 2) notes.push(`다수 버전은 같은 법인 · 같은 모델에서 펌웨어를 읽은 ${peers}대로 냅니다.`);
  if (numOrNull(fw.skipped) > 0) notes.push(`디스크 · 진단 등 ${fw.skipped}개는 대조하지 않습니다(같은 것끼리 묶을 수 없습니다).`);
  if (baselineUnreadable) notes.push('관리자 지정 기준 파일을 읽지 못해 다수 버전으로만 대조했습니다.');
  return { state: fw.state, badge: { label: fw.state === 'behind' ? `뒤처짐 ${fw.behind}` : t.label, color: t.badge }, head, rows, note: rows.length ? notes.join(' ') : '', why, invAt: numOrNull(invAt) };
}

/**
 * BIOS 설정 편차 구역 값. 다른 설정이 먼저 오게 정렬한다(다름 → 다수 없음 → 값 없음 → 같음 — 같은 것 안에서는 서버 순서).
 */
export function biosView(bios, { noHw = false, path = '', model = '' } = {}) {
  if (!bios) return { state: 'na', badge: null, head: '', rows: [], note: '', why: noHw ? '하드웨어 정보를 찾지 못해 BIOS 설정을 견주지 않았습니다.' : 'BIOS 설정 값을 받지 못했습니다.' };
  const t = BIOS_TEXT[bios.state] || BIOS_TEXT.none;
  const ORDER = { diff: 0, tie: 1, unread: 2, same: 3 };
  const rows = (Array.isArray(bios.rows) ? bios.rows : []).map((r, i) => {
    const st = BIOS_ROW_TEXT[r.state] || BIOS_ROW_TEXT.tie;
    const majorSub = r.major && numOrNull(r.majorN) != null ? `${r.majorN}대` : '';
    return { k: r.k, label: biosLabel(r.k), value: dash(r.v), major: r.major ? r.major : '—', majorSub,
      majorText: r.major ? `다수 ${r.major}${majorSub ? ` · ${majorSub}` : ''}` : '다수 없음', state: r.state, stateText: st.label, badge: st.badge, i };
  }).sort((a, b) => (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9) || a.i - b.i);
  const size = numOrNull(bios.group?.size); const known = numOrNull(bios.group?.known);
  let why = '';
  if (bios.state === 'unplaced') why = '미분류 서버는 견주지 않습니다 — 폴더에 넣으면 같은 폴더 · 같은 모델 서버와 견줍니다(모델이 같다는 것만으로 같은 일을 한다고 보지 않습니다).';
  else if (bios.state === 'unread') why = '이 서버의 BIOS 설정을 읽지 못했습니다 — 같음에도 다름에도 넣지 않습니다.';
  else if (bios.state === 'unsent') why = '이 서버를 수집하는 엣지에서 BIOS 설정을 받지 못했습니다(엣지 판이 낮거나 · 그 엣지가 아직 읽지 못했거나 · 중앙이 그 엣지의 이름을 확인하지 못했습니다) — 같음에도 다름에도 넣지 않습니다.';
  else if (bios.state === 'split') why = '다수 값과 다른 설정은 없지만, 같은 묶음 서버끼리 값이 갈려 다수가 없는 설정이 있습니다 — ‘다른 설정 없음’ 으로 보지 않습니다(어느 쪽이 옳다고도 하지 않습니다).';
  else if (bios.state === 'none') {
    // 이유는 묶음 크기 · 읽은 대수에 따라 다르다(반증 B6 — 2대가 있는데 ‘2대 이상 있어야’ 라고 썼다)
    if (size != null && size <= 1) why = '같은 폴더에 같은 모델 서버가 이 서버뿐입니다 — 2대 이상 있어야 견줍니다.';
    else if (known != null && known <= 1) why = '같은 폴더 · 같은 모델의 다른 서버 BIOS 설정을 읽지 못해 견줄 값이 없습니다.';
    else why = '견줄 수 있는 설정이 없습니다(같은 설정을 읽은 서버가 2대 이상이어야 다수 값이 생깁니다).';
  }
  // 머리 글자는 **견준 상태**(다름 · 갈림 · 없음)에만 — 못 읽음 · 받지 못함 · 견줄 서버 없음 옆에 ‘N대와 견줌’ 이라 쓰지 않는다. 대수는 이 서버를 포함한 묶음 크기
  const compared = bios.state === 'ok' || bios.state === 'diff' || bios.state === 'split';
  const head = compared && size != null && size > 0 ? `같은 폴더 · 같은 모델 ${size}대(이 서버 포함)${known != null && known < size ? ` 중 설정을 읽은 ${known}대로 견줌` : '를 견줌'}` : '';
  return { state: bios.state, badge: { label: bios.state === 'diff' ? `다른 설정 ${bios.diff}` : t.label, color: t.badge }, head, rows, path, model,
    note: rows.length ? '다수 값이 옳다는 뜻은 아닙니다 — 같은 일을 하는 서버끼리 다른 점만 보여 줍니다.' : '', why };
}

/** 자산 원장 올리기 결과 글자(드라이런 · 커밋 공용). */
/** 올리기 결과 표의 사유 칸 — 오류 사유, 또는 바뀌는 칸(지워지는 칸은 그렇게 밝힌다). */
export function importRowNote(x) {
  if (!x) return '';
  if (x.reason) return String(x.reason);
  if (x.action !== 'update' || !Array.isArray(x.fields) || !x.fields.length) return '';
  const cleared = new Set(Array.isArray(x.cleared) ? x.cleared : []);
  return `바뀌는 칸: ${x.fields.map((f) => (cleared.has(f) ? `${f}(지움)` : f)).join(' · ')}`;
}
export function importSummaryText(s, { replace = false } = {}) {
  if (!s) return '';
  const p = [`더함 ${s.add}`, `바꿈 ${s.update}`, `같음 ${s.same}`, `오류 ${s.error}`];
  if (replace) p.push(`지움 ${s.remove}`);
  return p.join(' · ');
}
export const IMPORT_ACTION = Object.freeze({ add: { label: '더함', badge: 'green' }, update: { label: '바꿈', badge: 'blue' }, same: { label: '같음', badge: 'gray' }, error: { label: '오류', badge: 'red' } });
