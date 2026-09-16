/**
 * storage/collectors/svcDiag.js — Dell Unity `svc_diag -s spinfo` 파서(v2.526, **순수 모듈**).
 *
 * 사용자 요청(2026-09-16): "용량 정보 확인 및 장비 구성정보 등 최대한 많은 정보를 수집해줘".
 *
 * ── 왜 이 명령인가 ─────────────────────────────────────────────────────────────
 * 이 현장 Unity 의 SSH 계정(`service`)은 **Unisphere 계정이 아니다**(사용자 확인). 그런데
 * `svc_diag -s spinfo` 는 **Unisphere 자격증명 없이** 하드웨어 상태·부품 인벤토리·전원 수치를
 * 전부 내놓는다. 그래서 구성 정보의 1차 원천으로 쓴다(용량·풀은 uemcli/REST 담당).
 *
 * ── 이 파서는 **사용자가 제공한 실제 출력**으로 만들었다(2026-09-16 스크린샷 5장) ──────
 * 다른 수집기들과 달리 형식을 추측하지 않았다. 확인한 구획은 넷이다:
 *   ① `Displaying all FRU statuses:`  — 들여쓰기 트리(dpe > temp/spa/spb > dimm·iom·ps·bbu·fan·slic)
 *   ② `Displaying all FRU resume:`    — `Device: X` 블록마다 부품번호·시리얼·조립명·펌웨어
 *   ③ `Summary of power supply info:` — `__ SPA PS0 Status __` 블록(입력 전력 W·전압 V·온도·결함 플래그)
 *   ④ `Summary of Suitecase info:`    — `__ SPA Suitcase Status __` 블록(오타 'Suitecase' 는 장비 출력 그대로)
 * ⚠ 다른 구획이 더 있을 수 있다(출력이 `--More--` 로 잘려 전부 보지 못했다). 그래서 ③④ 는
 *   **`__ 제목 __` 블록 일반 파서**로 읽는다 — 모르는 구획이 나와도 버리지 않고 그대로 담는다.
 *
 * ── 반드시 지킬 판정 규칙(실제 값으로 확인한 것) ────────────────────────────────
 * 1. **`REMOVED` 는 장애가 아니라 빈 슬롯이다.** 이 장비 SPA 의 DIMM 24칸 중 OK 는
 *    `0·2·4·7·9·11·12·14·16·19·21·23` **정확히 12칸**이고 12 × 8GB = **96GB** 로 접속 배너의
 *    `EMC Unity 480F 96GB` 와 일치한다. REMOVED 를 이상으로 세면 **정상 장비에 장애 12건**을 만든다.
 * 2. **`UNKNOWN` 은 정상도 이상도 아니다.** SPB 의 DIMM 이 전부 UNKNOWN 인데, 이는 SPA 에서
 *    상대 SP 의 DIMM 을 읽지 못하는 것뿐이다. '확인 불가' 로 **따로 센다**(v2.523 규약).
 * 3. **`ps0: OK 330` 의 숫자는 입력 전력(W)** 이다 — ③ 구획의 `Input Power : 330 Watts` 와
 *    교차 확인했다. 그래도 단정하지 않고 **두 출처를 함께 싣는다**(근거를 숨기지 않는다).
 * 4. **`temp: 21` 은 상태가 아니라 수치**다(DPE 온도). 상태 문자열로 취급하면 '알 수 없는 상태' 가 된다.
 * 5. 출력이 `--More--` 로 잘렸으면(`truncated`) **그 사실을 밝힌다** — 부품 목록이 일부일 수 있다.
 */

/** 상태 정규화. 이 넷 말고는 전부 `fault` 로 보되 **원문을 보존**한다(지어내지 않는다). */
export const FRU_STATE = Object.freeze({
  ok: 'ok',
  empty: 'empty',       // REMOVED — 빈 슬롯(장애 아님)
  unknown: 'unknown',   // 읽지 못함(정상도 이상도 아님)
  fault: 'fault',
});

export const FRU_STATE_LABEL = Object.freeze({
  ok: '정상', empty: '빈 슬롯', unknown: '확인 불가', fault: '이상',
});

export function fruState(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return FRU_STATE.unknown;
  if (s === 'OK' || s === 'PRESENT' || s === 'ENABLED') return FRU_STATE.ok;
  if (s === 'REMOVED' || s === 'EMPTY' || s === 'NOT PRESENT') return FRU_STATE.empty;
  if (s === 'UNKNOWN' || s === 'N/A') return FRU_STATE.unknown;
  return FRU_STATE.fault;
}

/** 부품 이름 → 종류. 화면이 종류별로 묶어 보여준다. */
export function fruKind(name) {
  const n = String(name || '').toLowerCase();
  if (/^dimm\d*$/.test(n)) return 'dimm';
  if (/^fan\d*$/.test(n)) return 'fan';
  if (/^ps\d*$/.test(n)) return 'psu';
  if (/^bbu\d*$/.test(n)) return 'bbu';
  if (/^slic\d*$/.test(n)) return 'slic';
  if (/^mezz\d*$/.test(n)) return 'mezz';
  if (/^iom\d*$/.test(n)) return 'iom';
  if (/^sp[ab]$/.test(n)) return 'sp';
  if (/^dpe$/.test(n)) return 'enclosure';
  if (/^dae\d*$/.test(n)) return 'enclosure';
  return 'other';
}

const TRUNCATED_RE = /--\s*More\s*--/i;
const num = (v) => {
  const m = /^-?\d+(\.\d+)?/.exec(String(v || '').trim());
  return m ? Number(m[0]) : null;
};

/* ────────────────── ① FRU 상태 트리 ────────────────── */

/**
 * `<들여쓰기><이름>: <상태>[ <부가>]` 줄을 읽는다.
 * 들여쓰기 깊이로 소속(dpe > spa/spb > 부품)을 정한다.
 */
function parseFruStatuses(lines) {
  const items = [];
  let dpeTemp = null;
  let group = '';          // 현재 SP('spa'|'spb') 또는 ''
  let groupIndent = -1;
  for (const raw of lines) {
    const m = /^(\s*)([A-Za-z][\w.\-/]*)\s*:\s*(.*)$/.exec(raw);
    if (!m) continue;
    const [, pad, nameRaw, restRaw] = m;
    const indent = pad.length;
    const name = nameRaw.trim();
    const rest = restRaw.trim();
    if (!rest) continue;
    const lower = name.toLowerCase();

    // `temp: 21` 은 상태가 아니라 수치다(규칙 4).
    if (lower === 'temp' && /^-?\d/.test(rest)) { dpeTemp = num(rest); continue; }

    const [stateTok, ...extra] = rest.split(/\s+/);
    const state = fruState(stateTok);
    if (/^sp[ab]$/.test(lower)) { group = lower; groupIndent = indent; }
    else if (indent <= groupIndent) { group = ''; groupIndent = -1; }

    items.push({
      name,
      kind: fruKind(name),
      sp: /^sp[ab]$/.test(lower) ? lower : group,
      state,
      raw: stateTok,
      // `iom: OK WARNADO_IOM_BOM_B_REV_C` · `ps0: OK 330` 의 뒤쪽 토큰(모델 또는 수치)
      detail: extra.join(' ') || '',
      value: extra.length === 1 ? num(extra[0]) : null,
    });
  }
  return { items, dpeTemp };
}

/* ────────────────── ② FRU resume(인벤토리) ────────────────── */

/** 인벤토리에서 **보관할 필드만** — 전량을 저장하면 스냅샷·중앙 push 가 불필요하게 커진다. */
const RESUME_KEEP = Object.freeze([
  'EMC TLA Part Number', 'EMC TLA Serial Number', 'EMC Product Part Number',
  'EMC Product Serial Number', 'TLA Assembly Name', 'Family FRU ID',
  'EMC Sub Assy Part Number', 'EMC Sub Assy Serial Number',
  'Device Type', 'Module Part Number', 'Module Serial Number', 'Density',
  'JEDEC ID Code', 'Manufacturing date', 'Number of Programmables',
]);

function parseFruResume(lines, { maxDevices = 64 } = {}) {
  const out = [];
  let cur = null;
  let errors = 0;
  const push = () => { if (cur && (Object.keys(cur.fields).length || cur.error)) out.push(cur); cur = null; };
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (/^-{5,}$/.test(t)) { push(); continue; }
    const dev = /^Device:\s*(.+)$/.exec(t);
    if (dev) { push(); cur = { device: dev[1].trim(), fields: {}, programmables: [], error: '' }; continue; }
    // `Error failed to read DIMM resume...` — 그 부품은 **못 읽은 것**이다(없는 것이 아니다).
    if (/^Error\b/i.test(t)) { errors += 1; if (cur) cur.error = t.slice(0, 120); continue; }
    if (!cur) continue;
    const kv = /^([^:]{2,60}?)\s*:\s*(.*)$/.exec(t);
    if (!kv) continue;
    const key = kv[1].trim();
    const val = kv[2].trim();
    if (!val) continue;
    if (key === 'Programmable Name') { cur.programmables.push({ name: val }); continue; }
    if (key === 'Programmable Revision' && cur.programmables.length) {
      cur.programmables[cur.programmables.length - 1].revision = val; continue;
    }
    if (RESUME_KEEP.includes(key)) cur.fields[key] = val.slice(0, 120);
  }
  push();
  return {
    devices: out.slice(0, maxDevices).map((d) => ({ ...d, programmables: d.programmables.slice(0, 12) })),
    omitted: Math.max(0, out.length - maxDevices),
    readErrors: errors,
  };
}

/* ────────────────── ③④ `__ 제목 __` 블록(전원·Suitcase·그 밖) ────────────────── */

const BOOL = (v) => {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'true' || s === 'yes') return true;
  if (s === 'false' || s === 'no') return false;
  return null;      // 읽지 못한 것을 false 로 만들지 않는다
};

/**
 * `__ SPA PS0 Status __` 처럼 밑줄 두 개로 감싼 제목 블록을 읽는다.
 * ⚠ 모르는 제목도 버리지 않고 담는다 — 출력을 전부 보지 못했기 때문이다(머리말).
 */
function parseTitledBlocks(lines, { maxBlocks = 40 } = {}) {
  const out = [];
  let cur = null;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    const head = /^_{2,}\s*(.+?)\s*_{2,}$/.exec(t);
    if (head) { if (cur) out.push(cur); cur = { title: head[1].trim(), fields: {} }; continue; }
    if (!cur) continue;
    const kv = /^([^:]{2,60}?)\s*:\s*(.*)$/.exec(t);
    if (!kv) continue;
    const v = kv[2].trim();
    if (v) cur.fields[kv[1].trim()] = v.slice(0, 120);
  }
  if (cur) out.push(cur);
  return out.slice(0, maxBlocks);
}

/** 전원 블록 → 수치. **읽지 못한 값은 null**(0 으로 채우면 '전력 0W' 라는 거짓). */
export function powerFromBlocks(blocks) {
  const rows = [];
  for (const b of blocks || []) {
    if (!/P\/?S|power supply|PS\d/i.test(b.title)) continue;
    const f = b.fields || {};
    const faults = [];
    for (const k of ['Faulted', 'Ambient OverTemp Fault', 'Input Lost', 'Internal Fan Fault']) {
      if (BOOL(f[k]) === true) faults.push(k);
    }
    rows.push({
      title: b.title,
      inserted: BOOL(f.Inserted),
      model: f['Unique ID'] || '',
      inputWatts: num(f['Input Power']),
      inputVolts: num(f['Input Voltage']),
      tempC: num(f['Temp Sensor']),
      firmware: f['Firmware Revision'] || '',
      type: f['P/S Type [A/C vs D/C]'] || '',
      faults,
      // 결함 플래그를 하나도 읽지 못했으면 '정상' 이라 말하지 않는다.
      state: faults.length ? FRU_STATE.fault
        : ['Faulted', 'Input Lost'].some((k) => BOOL(f[k]) === false) ? FRU_STATE.ok : FRU_STATE.unknown,
    });
  }
  const watts = rows.map((r) => r.inputWatts).filter((n) => Number.isFinite(n));
  return {
    supplies: rows,
    totalWatts: watts.length ? watts.reduce((a, b) => a + b, 0) : null,   // 하나도 못 읽으면 null
    readWatts: watts.length,
  };
}

/* ────────────────── 전체 ────────────────── */

/**
 * `svc_diag -s spinfo` 전체 출력 파싱.
 *
 * @returns {{parsed:boolean, systemType:string, spId:string, dpeTemp:number|null,
 *   fru:object, resume:object, blocks:object[], power:object, truncated:boolean}}
 */
export function parseSpinfo(text) {
  const src = String(text || '');
  const lines = src.split(/\r?\n/);
  const truncated = TRUNCATED_RE.test(src);

  const systemType = (/This SP's system type is:\s*(.+)/.exec(src) || [])[1]?.trim() || '';
  const spId = (/This SP's ID is:\s*(.+)/.exec(src) || [])[1]?.trim() || '';

  // 구획 경계 — 없으면 그 구획은 비어 있다(지어내지 않는다).
  const idxOf = (re) => lines.findIndex((l) => re.test(l));
  const iStatus = idxOf(/Displaying all FRU statuses:/i);
  const iResume = idxOf(/Displaying all FRU resume:/i);
  const iSummary = lines.findIndex((l, i) => i > Math.max(iResume, iStatus) && /^Summary of /i.test(l.trim()));

  const statusLines = iStatus >= 0 ? lines.slice(iStatus + 1, iResume >= 0 ? iResume : (iSummary >= 0 ? iSummary : lines.length)) : [];
  const resumeLines = iResume >= 0 ? lines.slice(iResume + 1, iSummary >= 0 ? iSummary : lines.length) : [];
  const summaryLines = iSummary >= 0 ? lines.slice(iSummary) : [];

  const { items, dpeTemp } = parseFruStatuses(statusLines);
  const resume = parseFruResume(resumeLines);
  const blocks = parseTitledBlocks(summaryLines);
  const power = powerFromBlocks(blocks);

  const count = (pred) => items.filter(pred).length;
  const fru = {
    items,
    total: items.length,
    ok: count((x) => x.state === 'ok'),
    // ⚠ 빈 슬롯과 확인 불가는 **이상이 아니다**(머리말 규칙 1·2) — 각각 따로 센다.
    empty: count((x) => x.state === 'empty'),
    unknown: count((x) => x.state === 'unknown'),
    fault: count((x) => x.state === 'fault'),
    faults: items.filter((x) => x.state === 'fault').slice(0, 40),
    sps: [...new Set(items.map((x) => x.sp).filter(Boolean))],
  };

  return {
    parsed: items.length > 0 || resume.devices.length > 0 || blocks.length > 0,
    systemType, spId, dpeTemp, fru, resume, blocks, power, truncated,
  };
}

/**
 * 설치된 메모리 합계 — **인벤토리에서 읽은 DIMM 만** 더한다.
 * ⚠ 빈 슬롯(REMOVED)을 0GB 로 더하지 않는다(그건 맞지만), 반대로 **읽지 못한 DIMM 을 0 으로
 *   세지도 않는다** — 읽은 개수를 함께 내어 화면이 '일부만 읽었다' 를 말할 수 있게 한다.
 */
export function memoryFromResume(resume) {
  const dimms = (resume?.devices || []).filter((d) => /DIMM/i.test(d.device) && d.fields?.Density);
  let gb = 0;
  for (const d of dimms) {
    const g = num(d.fields.Density);
    if (Number.isFinite(g)) gb += /TB/i.test(d.fields.Density) ? g * 1024 : g;
  }
  return { modules: dimms.length, totalGB: dimms.length ? gb : null, readErrors: resume?.readErrors || 0 };
}
