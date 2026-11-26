/**
 * 물리서버 상세 드로어 — 글자 · 배치 계산(순수 · v3.44 · 시안 docs/design/bm-drawer).
 * 판정은 서버가 한다(부품 장애 건수 · 값 없음 사유 코드 · 전원 · 임시 키 — routes/api/bmFolders.js serverRow). 여기서는 **그 값을 줄로 옮길 뿐**이다
 *   (새 판정 없음 — 설계 §5 결정 3). 못 읽은 값은 0 이 아니다: '—' 로 쓰고 단위를 붙이지 않으며 정상에도 장애에도 넣지 않는다.
 * 하드웨어 글자는 hwText.js · 사유 글자는 whyText.js 를 그대로 쓴다(복제 금지).
 */
import { numOrNull } from '../../../numOrNull.js';
import { PLACE_LABEL, pathText } from '../bmFoldersText.js';
import { whyOf, whyShort } from './whyText.js';
import { cpuText, memText, memSizeText, diskSizeText, nicSpeedParts, speedText } from './hwText.js';

/** 임시 키(서비스 태그를 아직 못 읽음) 설명 — 표의 '태그 없음' 배지와 드로어 신호가 같은 글자를 쓴다. */
export const TMPKEY_NOTE = '서비스 태그를 아직 읽지 못해 임시 키(이름 기반)로 다룹니다. 태그가 읽히면 폴더 등록이 태그 키로 저절로 옮겨 가고 위치는 그대로입니다. 이름이 바뀌면 임시 키도 바뀌어 등록이 ‘목록에 없는 등록’ 으로 보일 수 있습니다.';

/** CPU · 메모리 사용률이 둘 다 없는가(표 · 카드 · 드로어가 같은 기준). */
export const noUsage = (r) => r?.cpu == null && r?.mem == null;

/** 상태 점 색 — 표 행 · 좁은 화면 카드 · 드로어 머리가 같은 판정을 쓴다: 장애 > 사용률 못 읽음 > 꺼짐 > 정상. */
export function rowTone(r) {
  if (numOrNull(r?.faults) > 0) return 'red';
  if (noUsage(r)) return 'none';
  if (r?.powered === false) return 'gray';
  return 'green';
}

export const powerText = (r) => (r?.powered === true ? '켜짐' : r?.powered === false ? '꺼짐' : '모름');

/**
 * 상태 점의 설명 글자(title · aria-label) — 색이 뜻하는 것을 **그 서버의 사실로** 쓴다. 색 이름표('켜짐 · 장애 없음')를 그대로 쓰면
 *   전원 · 부품 장애 값이 없는 서버(엣지 수집 · ESXi 행 · 부품 장애 기능 꺼짐)에서 없는 사실을 말하게 된다(반증 A5).
 */
export function rowDotTitle(r) {
  const f = numOrNull(r?.faults);
  return [`전원 ${powerText(r)}`, f == null ? '부품 장애 값 없음' : f > 0 ? `부품 장애 ${f}건` : '부품 장애 없음', noUsage(r) ? '사용률 값 없음' : ''].filter(Boolean).join(' · ');
}

/** 값이 없어 판단하지 않은 것 — 신호로 올리지 않고(봐야 할 것이 아니다) 따로 밝힌다. 정상으로 세지 않는다. */
export function bmUnknowns(r) {
  const out = [];
  if (numOrNull(r?.faults) == null) out.push('부품 장애');
  if (r?.powered !== true && r?.powered !== false) out.push('전원');
  return out;
}
/** 신호가 없을 때의 글자 — **실제로 본 것만** 나열한다(값이 없던 것을 '해당 없음' 이라 하지 않는다). */
export function noSignalText(r) {
  const seen = [numOrNull(r?.faults) != null ? '부품 장애' : '', '사용률 값 없음(CPU · 메모리 둘 다)', r?.powered === true || r?.powered === false ? '전원 꺼짐' : '', '임시 키'].filter(Boolean);
  return `신호 없음 — ${seen.join(' · ')}에 해당하는 것이 없습니다.`;
}

const WHY_TONE = { fail: 'crit', stale: 'warn', none: 'info', unknown: 'none' };
/** 신호 등급 → 머리 배지 색 · 줄 앞 점(색만으로 가르지 않는다 — 글자가 함께 간다). */
export const SIG_BADGE = Object.freeze({ crit: 'red', warn: 'amber', info: 'gray', none: 'gray' });
export const SIG_DOT = Object.freeze({ crit: 'var(--red)', warn: 'var(--amber)', info: 'var(--text-faint)', none: '' });

/**
 * 신호 줄 — 행에 이미 있는 값만 쓴다. [{ kind, tone:'crit'|'warn'|'info'|'none', badge, label, fact, desc?, link?:[href, 글자] }]
 *   ⚠ **값이 없는 것(부품 장애 · 전원)은 신호가 아니다**(반증 A2): 전원은 ESXi 행(서버가 null 고정) · 엣지가 수집한 베어메탈에서 구조적으로 비고,
 *   부품 장애는 그 기능이 꺼져 있어도 빈다 — '읽지 못했다' 고 단정할 수 없고 서버마다 뜨는 줄은 봐야 할 것을 가린다. 그런 값은 bmUnknowns 로 따로 밝힌다.
 */
export function bmSignalRows(r, now = Date.now()) {
  const out = [];
  const faults = numOrNull(r?.faults);
  if (faults != null && faults > 0) {
    out.push({ kind: 'fault', tone: 'crit', badge: `부품 장애 ${faults}건`, label: `부품 장애 ${faults}건`,
      fact: '이 서버에 열린 부품 장애가 있습니다 — 어느 부품인지는 물리 부품 장애 화면에서 봅니다.', link: ['#/tools/part-faults', '부품 장애'] });
  }
  const off = r?.powered === false;
  if (noUsage(r)) {
    const code = r?.why?.code || '';
    // 꺼진 서버의 '꺼져 있음' 사유는 아래 전원 줄이 말한다(같은 말을 두 줄로 쓰지 않는다)
    if (code && !(code === 'powered-off' && off)) {
      const w = whyOf(code);
      out.push({ kind: 'usage', tone: WHY_TONE[w.cls] || 'none', badge: `사용률 값 없음 · ${whyShort(r.why, now)}`, label: `사용률 값 없음 — ${w.s}`, fact: w.l, desc: w.a || '', link: ['#/tools/bm-usage', '사용률'] });
    } else if (!code) {
      out.push({ kind: 'usage', tone: 'none', badge: '사용률 값 없음', label: '사용률 값 없음', fact: '값이 없는 이유를 받지 못했습니다 — 원인을 단정하지 않습니다.', link: ['#/tools/bm-usage', '사용률'] });
    }
  }
  if (off) out.push({ kind: 'off', tone: 'info', badge: '전원 꺼짐', label: '전원 꺼짐', fact: '서버 전원이 꺼져 있습니다.' });
  if (r?.tmpKey) out.push({ kind: 'tmpkey', tone: 'info', badge: '태그 없음', label: '서비스 태그를 아직 읽지 못함', fact: TMPKEY_NOTE });
  return out;
}

/**
 * ‹ › · ↑↓ 이웃 — rows 는 연 곳의 보이는 순서(행 객체 · key).
 * 목록에 없으면 index −1. 다만 **방금까지 있던 자리(lastIndex)** 를 알면 그 자리 앞뒤로 이어 간다(gone: true) — 미분류 · 폴더 보기에서
 *   넣기 · 옮기기 · 빼기를 하면 그 서버가 목록에서 빠지는데, 그때 ‹ › 가 둘 다 잠기면 닫고 다시 눌러야 했다(반증 A4).
 *   빠진 자리에는 다음 서버가 올라와 있으므로 '다음' = rows[lastIndex] · '이전' = rows[lastIndex − 1].
 */
export function neighborOfKey(rows, key, lastIndex = -1) {
  const list = Array.isArray(rows) ? rows : [];
  const i = list.findIndex((x) => x && x.key === key);
  if (i >= 0) return { prev: list[i - 1] || null, next: list[i + 1] || null, index: i, total: list.length, gone: false };
  const li = Number.isInteger(lastIndex) && lastIndex >= 0 ? Math.min(lastIndex, list.length) : -1;
  if (li < 0) return { prev: null, next: null, index: -1, total: list.length, gone: false };
  return { prev: list[li - 1] || null, next: list[li] || null, index: -1, total: list.length, gone: true };
}

/**
 * 드로어 안에 보일 쓰기 결과 알림 — 드로어를 연 뒤 · 서버를 넘긴 뒤에 **새로 온 것만**(seen = 그때 이미 있던 알림 객체).
 *   이전 서버의 '옮겼습니다' 를 다음 서버 것처럼 보이지 않게 하고, 글자가 없는 알림은 그리지 않는다.
 */
export const freshNote = (note, seen) => (note && note !== seen && note.text ? note : null);

/** 사용률 출처 표지 — 값이 있을 때만. 행이 '지표마다 다름(구분 모름)' 이면 mixed. */
const srcOf = (r, m, v) => (v == null ? '' : r?.usrc?.mixed ? 'mixed' : r?.usrc?.[m] || '');

/** 타일 4장의 값(그리기는 컴포넌트). 값이 없으면 pct · watts 가 null — '—' 로 그리고 단위를 붙이지 않는다. */
export function bmTiles(r) {
  const cpu = numOrNull(r?.cpu); const mem = numOrNull(r?.mem);
  // 용량: 행 값(사용률 쪽) 먼저 · 없으면 같은 행의 iDRAC 요약(같은 화면의 '하드웨어 요약' 이 32코어인데 타일만 '모름' 이 되지 않게 — 반증 A14)
  const cores = numOrNull(r?.cores) ?? numOrNull(r?.hw?.cpu?.cores);
  const memGB = numOrNull(r?.memGB);
  const memSub = memGB != null ? `${memGB} GB` : memText(r?.hw?.mem);
  const spec = cpuText(r?.hw?.cpu);
  const faults = numOrNull(r?.faults);
  const capText = [cores != null ? `${cores}코어` : '', memSub].filter(Boolean).join(' · ');
  return {
    cpu: { pct: cpu, src: srcOf(r, 'cpu', cpu), sub: [cores != null ? `${cores}코어` : '', spec && cores != null && spec !== `${cores}C` ? spec : ''].filter(Boolean).join(' · ') || '코어 수 모름' },
    mem: { pct: mem, src: srcOf(r, 'mem', mem), sub: memSub || '용량 모름' },
    usage: { cap: capText || '용량 모름' },
    power: { watts: numOrNull(r?.watts), sub: `전원 ${powerText(r)}` },
    fault: faults == null ? { state: 'unread', n: null } : { state: faults > 0 ? 'bad' : 'ok', n: faults },
  };
}

/**
 * 식별 · 배치 값 줄 — [{ label, value, mono?, full?, badge?, note?, src?, agent?, muted? }].
 *   서비스 태그는 범위 계정 판본에 없다(서버가 싣지 않는다 — scoped 면 줄 자체를 만들지 않는다).
 */
export function bmKvRows(r, { corpName = (x) => x, scoped = false } = {}) {
  const rows = [
    { label: '법인', value: r?.corp ? corpName(r.corp) : '(미지정)' },
    { label: '종류', value: r?.kind === 'esxi' ? 'ESXi 호스트' : '베어메탈' },
    { label: '폴더', full: true, value: r?.place ? pathText(r.path) : '(미분류)', badge: r?.place ? PLACE_LABEL[r.place] || '' : '',
      note: !r?.place ? (r?.corp ? '아직 폴더가 없습니다' : '법인을 몰라 폴더에 넣을 수 없습니다') : r.place === 'rule' ? '규칙이 넣은 자리입니다(옮기면 손 등록이 됩니다)' : '' },
    { label: '모델', value: r?.model || '—', muted: !r?.model },
  ];
  if (!scoped) rows.push({ label: '서비스 태그', value: r?.serviceTag || '—', mono: true, muted: !r?.serviceTag });
  rows.push({ label: '전원', value: powerText(r), muted: r?.powered == null });
  rows.push({ label: '받는 길', src: r?.src || '', agent: r?.agent || '' });
  return rows;
}

/**
 * 하드웨어 요약 5칸(CPU · 메모리 · 디스크 · NIC · FC HBA) — sum = iDRAC 요약(idrac/hwSummary.js), det = 부품 목록(있을 때만).
 *   요약이 없으면 null(화면이 사유를 말한다). 칸마다 못 읽은 값은 '—'(읽었고 0개인 것과 다르다 — '없음').
 */
export function specCells(sum, det = null) {
  if (!sum) return null;
  const cpu = sum.cpu || null; const mem = sum.mem || null; const disk = sum.disk || null; const nic = sum.nic || null; const hba = sum.hba || null;
  const cores = numOrNull(cpu?.cores); const threads = numOrNull(cpu?.threads);
  const dimms = numOrNull(mem?.dimms);
  const dn = numOrNull(disk?.n); const ssd = numOrNull(disk?.ssd) || 0; const hdd = numOrNull(disk?.hdd) || 0;
  const other = dn != null ? Math.max(0, dn - ssd - hdd) : 0;
  const hn = numOrNull(hba?.n); const hp = numOrNull(hba?.ports);
  // NIC: 값 칸에는 첫 속도 묶음만(칸 폭 — '25G×2 · 1G×2' 는 1440px 드로어의 5칸에서 잘렸다), 나머지 묶음은 아래 줄로. 속도를 못 읽었으면 포트 수.
  const ports = numOrNull(nic?.ports);
  const sp = nicSpeedParts(nic);
  const nicV = sp.length ? sp[0] : (ports != null ? `${ports}포트` : '');
  const nicSub = [sp.slice(1).join(' · '), Array.isArray(det?.nics) ? `어댑터 ${det.nics.length}` : (sp.length && ports != null ? `${ports}포트` : '')].filter(Boolean).join(' · ');
  return [
    { k: 'CPU', v: cpuText(cpu) || '—', s: cores != null ? `${cores}코어${threads != null ? ` / ${threads}스레드` : ''}` : '' },
    { k: '메모리', v: memText(mem) || '—', s: dimms != null ? `DIMM ${dimms}개` : '' },
    { k: '디스크', v: dn == null ? '—' : dn === 0 ? '없음' : (diskSizeText(disk.gb) || `${dn}개`), plain: dn === 0,
      s: dn == null ? '' : dn === 0 ? '읽었고 0개' : [ssd ? `SSD ${ssd}` : '', hdd ? `HDD ${hdd}` : '', other ? `기타 ${other}` : ''].filter(Boolean).join(' · ') },
    { k: 'NIC', v: nicV || '—', s: nicSub },
    { k: 'FC HBA', v: hn == null ? '—' : hn === 0 ? '없음' : `FC ${hn}`, plain: hn === 0, s: hn == null ? '' : hn === 0 ? '읽었고 0개' : (hp ? `${hp}포트` : '') },
  ];
}

/**
 * 부품 목록 — 종류마다 줄({ n: '2 ×' | '', m: 모델, x: 사양 }). rows 가 null 이면 그 종류를 못 읽음 · [] 이면 없음.
 *   글자는 예전 옆 패널(HwPanel)과 같은 값을 모델 칸과 사양 칸으로 나눴을 뿐이다. det 가 없으면 null.
 */
export function partGroups(det) {
  if (!det) return null;
  const nx = (x) => (numOrNull(x?.n) > 1 ? `${x.n} ×` : '');
  const join = (...xs) => xs.filter(Boolean).join(' · ');
  const g = (k, list, f) => ({ k, rows: Array.isArray(list) ? list.map(f) : null });
  return [
    g('CPU', det.cpus, (x) => ({ n: nx(x), m: x.model || '모델 모름', x: join(x.cores ? `${x.cores}코어${x.threads ? `/${x.threads}스레드` : ''}` : (x.threads ? `${x.threads}스레드` : ''), x.mhz ? `최대 ${(x.mhz / 1000).toFixed(1)}GHz` : '') })),
    g('메모리(DIMM)', det.dimms, (x) => ({ n: nx(x), m: [x.gb ? memSizeText(x.gb) : '크기 모름', x.type || '', x.mhz ? `${x.mhz}MHz` : ''].filter(Boolean).join(' '), x: x.maker || '' })),
    g('디스크', det.disks, (x) => ({ n: nx(x), m: x.model || '모델 모름', x: join(x.gb ? diskSizeText(x.gb) : '', x.media ? `${x.media}${x.proto ? `(${x.proto})` : ''}` : (x.proto || '')) })),
    g('스토리지 컨트롤러', det.ctrls, (x) => ({ n: nx(x), m: x.model || '모델 모름', x: x.fw ? `펌웨어 ${x.fw}` : '' })),
    g('NIC', det.nics, (x) => ({ n: '', m: x.model || '모델 모름', x: join(numOrNull(x.ports) != null ? `${x.ports}포트` : '', numOrNull(x.up) != null ? `링크 업 ${x.up}` : '', Array.isArray(x.speeds) && x.speeds.length ? x.speeds.map(speedText).filter(Boolean).join('/') : '') })),
    g('FC HBA', det.hbas, (x) => ({ n: '', m: x.model || '모델 모름', x: x.ports ? `${x.ports}포트` : '' })),
  ];
}

const pad2 = (n) => String(n).padStart(2, '0');
/** 추이 가로축 눈금 글자 — 첫 눈금은 날짜까지('11/25 18시'), 나머지는 시각만. 브라우저 지역 시각. */
export function tickText(ts, withDate = false) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${withDate ? `${d.getMonth() + 1}/${d.getDate()} ` : ''}${pad2(d.getHours())}시`;
}

/**
 * 24시간 추이 그림 값 — rows [{ ts, cpu, mem }](서버가 240점으로 줄인 것). 못 읽은 점은 **선을 끊고**(0 으로 그리지 않는다),
 *   CPU · 메모리가 둘 다 없는 구간은 '못 읽음' 띠로 표시한다.
 * @returns {{ cpu:string, mem:string, gaps:{x:number,w:number}[], ticks:{x:number,text:string,anchor:string}[], lastCpu:number|null, lastMem:number|null, n:number }|null}
 */
export function trendView(rows, { w = 560, top = 20, h = 110, fmt = tickText } = {}) {
  // 시각도 numOrNull 로(Number(null) · Number('') 은 0 = 1970년이 된다 — 반증 A13)
  const list = (Array.isArray(rows) ? rows : []).filter((p) => p && numOrNull(p.ts) > 0);
  if (!list.length) return null;
  const t0 = Number(list[0].ts); const t1 = Number(list[list.length - 1].ts);
  const span = Math.max(1, t1 - t0);
  const x = (ts) => ((Number(ts) - t0) / span) * w;
  const y = (v) => top + (1 - Math.max(0, Math.min(100, v)) / 100) * h;
  const path = (k) => {
    let s = ''; let pen = false;
    for (const p of list) {
      const v = numOrNull(p[k]);
      if (v == null) { pen = false; continue; }
      s += `${pen ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(v).toFixed(1)} `; pen = true;
    }
    return s.trim();
  };
  const last = (k) => { for (let i = list.length - 1; i >= 0; i -= 1) { const v = numOrNull(list[i][k]); if (v != null) return v; } return null; };
  // 둘 다 없는 점이 이어진 구간 — 앞뒤 읽힌 점 사이(끝이면 가장자리까지)를 띠로
  const gaps = []; let start = null; let lastOkX = 0;
  for (const p of list) {
    const none = numOrNull(p.cpu) == null && numOrNull(p.mem) == null;
    const px = x(p.ts);
    if (none) { if (start == null) start = lastOkX; } else { if (start != null && px - start > 0.5) gaps.push({ x: start, w: px - start }); start = null; lastOkX = px; }
  }
  if (start != null && w - start > 0.5) gaps.push({ x: start, w: w - start });
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f, i) => ({ x: f * w, text: fmt(t0 + f * span, i === 0), anchor: i === 0 ? 'start' : i === 4 ? 'end' : 'middle' }));
  return { cpu: path('cpu'), mem: path('mem'), gaps, ticks, lastCpu: last('cpu'), lastMem: last('mem'), n: list.length, y0: y(0), y50: y(50), y100: y(100), w };
}

/** 표가 알려 준 보이는 순서(키 배열)로 행을 다시 놓는다 — 순서에 없는 행은 뺀다(상한으로 잘린 행). 순서를 모르면 rows 그대로. */
export function orderRows(rows, order) {
  const list = Array.isArray(rows) ? rows : [];
  if (!Array.isArray(order)) return list;
  const by = new Map(list.map((x) => [x.key, x]));
  return order.map((k) => by.get(k)).filter(Boolean);
}
