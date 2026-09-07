/**
 * sanswitch/collectors/fosParse.js — Brocade Fabric OS CLI 출력 파서(순수, v2.410).
 *
 * 왜 순수 모듈로 떼어 두나: 실장비 없이 검증할 수 있는 유일한 부분이 파싱이다. FOS 는
 * 버전(7/8/9)·모델(픽스드 vs 디렉터)에 따라 **컬럼 구성이 달라진다**. 실제 출력 샘플을
 * 테스트에 고정해 두면, 나중에 현장 출력으로 교정할 때 무엇이 깨지는지 바로 드러난다.
 *
 * ⚠ 정직 표기: 아래 파서들은 **문서·공개 출력 예시 기준으로 작성했고 실장비로 검증하지
 *   않았다**. 그래서 수집기는 각 명령의 원문 앞부분을 함께 보관해(연결 테스트의 'CLI 원문'
 *   패널) 파싱이 빗나가도 운영자가 실제 출력을 바로 볼 수 있게 한다.
 */

/** 'v8.2.3d' 같은 FOS 버전 문자열만 뽑기. */
export function parseFirmwareShow(text) {
  const m = String(text || '').match(/v\d+\.\d+\.\d+[a-z0-9_]*/i);
  return m ? m[0] : '';
}

/**
 * chassisshow 파싱(v2.411 — **실장비 출력으로 전면 교정**).
 *
 * 처음엔 'Chassis Family:' 한 줄만 찾았는데, 실제 FOS v9.0.1d 출력에는 **그 줄이 아예 없었다**
 * (사용자 제공 실출력). 그래서 모델이 늘 '미상'으로 떴다. 실제 출력은 유닛 블록의 나열이다:
 *
 *   FAN  Unit: 1 / 2 / 3            ← 팬 개수
 *   POWER SUPPLY  Unit: 1 / 2       ← 입력 전압(218.00 V), 소비전력(-240W), 부품/시리얼
 *   CHASSIS/WWN  Unit: 1            ← 섀시 Factory Part/Serial Num, ID, Serial Num, Time Awake
 *
 * ⚠ 같은 키('Factory Serial Num' 등)가 여러 블록에 반복되므로 **어느 블록의 값인지**를
 *   구분해야 한다. 예전 구현은 블록 구분이 엉성해 PSU 의 부품번호를 섀시 것으로 집었다.
 *
 * 소비전력은 FOS 관례상 음수로 찍힌다(-240W = 240W 소비) → 절댓값으로 정규화한다.
 *
 * @returns { model, serial, partNumber, chassisId, fans, psus[], powerWatts, awakeDays, aliveDays }
 */
export function parseChassisShow(text) {
  const out = { model: '', serial: '', partNumber: '', chassisId: '',
    fans: 0, psus: [], powerWatts: null, awakeDays: null, aliveDays: null };
  // CHASSIS/WWN 블록이 없는 변형(픽스드 스위치는 'Chassis Family' + 'SW BLADE' 블록만 찍는
  // 경우가 있다) 대비 폴백. **팬/PSU 블록의 값은 절대 쓰지 않는다** — 그건 그 부품의 시리얼이라
  // 섀시 시리얼로 보고하면 자산 대조가 틀어진다.
  const fb = { serial: '', partNumber: '' };
  const lines = String(text || '').split(/\r?\n/);
  let block = '';       // 'fan' | 'psu' | 'chassis' | ''
  let psu = null;
  const num = (v) => { const m = String(v).match(/-?[\d.]+/); return m ? Number(m[0]) : null; };
  const flushPsu = () => { if (psu) { out.psus.push(psu); psu = null; } };

  for (const raw of lines) {
    const l = raw.trim();
    let m;
    // 일부 FOS 버전에는 이 줄이 있다(있으면 그게 가장 정확한 모델명).
    if ((m = l.match(/^Chassis\s+Family:\s*(.+)$/i))) { out.model = m[1].trim(); continue; }

    if (/^FAN\s+Unit:/i.test(l)) { flushPsu(); block = 'fan'; out.fans++; continue; }
    if ((m = l.match(/^POWER\s+SUPPLY\s+Unit:\s*(\d+)/i))) { flushPsu(); block = 'psu'; psu = { unit: Number(m[1]) }; continue; }
    if (/^CHASSIS(\/WWN)?\s+Unit:/i.test(l)) { flushPsu(); block = 'chassis'; continue; }
    if (/^(SW|CP|AP|CORE)\s+BLADE\s+Slot:/i.test(l)) { flushPsu(); block = 'blade'; continue; }

    if (block === 'psu' && psu) {
      if ((m = l.match(/^Power\s+Source:\s*(.+)$/i))) psu.source = m[1].trim();
      else if ((m = l.match(/^PS\s+Voltage\s+input:\s*(.+)$/i))) psu.voltageV = num(m[1]);
      // -240W = 240W 소비(FOS 표기). 절댓값으로 통일한다.
      else if ((m = l.match(/^Power\s+Usage:\s*(.+)$/i))) psu.powerW = Math.abs(num(m[1]) ?? 0) || null;
      else if ((m = l.match(/^Factory\s+Serial\s+Num:\s*(\S+)/i))) psu.serial = m[1];
      else if ((m = l.match(/^Factory\s+Part\s+Num:\s*(\S+)/i))) psu.partNumber = m[1];
      continue;
    }
    if (block !== 'psu' && block !== 'fan' && block !== 'chassis') {
      // 블록 밖 또는 BLADE 블록 — 폴백 후보로만 담아 둔다(위 주석).
      if ((m = l.match(/^Factory\s+Serial\s+Num:\s*(\S+)/i))) { if (!fb.serial) fb.serial = m[1]; }
      else if ((m = l.match(/^Factory\s+Part\s+Num:\s*(\S+)/i))) { if (!fb.partNumber) fb.partNumber = m[1]; }
    }
    if (block === 'chassis') {
      // 'Serial Num'(BRCFPL1944R00C) 이 'Factory Serial Num'(FPL1944R00C) 보다 완전한 표기라 우선.
      if ((m = l.match(/^Serial\s+Num:\s*(\S+)/i))) out.serial = m[1];
      else if ((m = l.match(/^Factory\s+Serial\s+Num:\s*(\S+)/i))) { if (!out.serial) out.serial = m[1]; }
      else if ((m = l.match(/^Factory\s+Part\s+Num:\s*(\S+)/i))) out.partNumber = m[1];
      else if ((m = l.match(/^Part\s+Num:\s*(\S+)/i))) { if (!out.partNumber) out.partNumber = m[1]; }
      else if ((m = l.match(/^ID:\s*(\S+)/i))) out.chassisId = m[1];
      else if ((m = l.match(/^Time\s+Awake:\s*(\d+)/i))) out.awakeDays = Number(m[1]);
      else if ((m = l.match(/^Time\s+Alive:\s*(\d+)/i))) out.aliveDays = Number(m[1]);
    }
  }
  flushPsu();
  if (!out.serial) out.serial = fb.serial;
  if (!out.partNumber) out.partNumber = fb.partNumber;
  const watts = out.psus.map((p) => p.powerW).filter((w) => w != null);
  out.powerWatts = watts.length ? watts.reduce((a, b) => a + b, 0) : null;
  return out;
}

/** FOS 상태 문자열 → 정규화 상태(types.js summarizePorts 의 분류와 짝). */
export function normalizePortState(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/[\s()]+/g, '_');
  if (!s) return 'unknown';
  if (s.startsWith('online')) return 'online';
  if (s.startsWith('no_license') || s.startsWith('nolicense')) return 'noLicense';
  if (s.startsWith('disabled') || s.startsWith('port_disabled')) return 'disabled';
  if (s.startsWith('faulty') || s.startsWith('port_flt') || s.startsWith('laser_flt')
    || s.startsWith('mod_inv') || s.startsWith('mod_val') || s.startsWith('port_fault')) return 'faulty';
  // No_Light / No_Sync / No_Module / Offline / In_Sync / Testing / Bypassed 등 = 비어 있음
  return 'offline';
}

/**
 * switchshow 파싱 → { header, ports[] }.
 *
 * 표 머리글이 두 종류다:
 *   픽스드:  Index Port Address Media Speed State     Proto
 *   디렉터:  Index Slot Port Address Media Speed State Proto
 * 그래서 열 위치를 하드코딩하지 않고 **머리글 줄을 읽어** Slot 유무를 판정한다
 * (하드코딩하면 디렉터에서 한 칸씩 밀려 전 포트의 상태가 엉뚱하게 잡힌다).
 */
export function parseSwitchShow(text) {
  const lines = String(text || '').split(/\r?\n/);
  const header = {};
  const ports = [];
  let hasSlot = false;
  let inTable = false;

  for (const raw of lines) {
    const l = raw.replace(/\s+$/, '');
    if (!inTable) {
      const m = l.match(/^(switchName|switchType|switchState|switchMode|switchRole|switchDomain|switchId|switchWwn|zoning|Fabric Name|switchBeacon):\s*(.+)$/i);
      if (m) { header[m[1].replace(/\s+/g, '')] = m[2].trim(); continue; }
      if (/^\s*Index\s+/i.test(l)) { hasSlot = /^\s*Index\s+Slot\s+/i.test(l); inTable = true; }
      continue;
    }
    if (/^=+$/.test(l.trim()) || !l.trim()) continue;
    const t = l.trim().split(/\s+/);
    if (t.length < 5 || !/^\d+$/.test(t[0])) continue;
    let i = 0;
    const index = Number(t[i++]);
    const slot = hasSlot ? Number(t[i++]) : null;
    const port = Number(t[i++]);
    const address = t[i++];
    const media = t[i++];
    const speed = t[i++];
    const stateRaw = t[i++] || '';
    // State 뒤부터가 Proto/포트타입/연결 WWN. '(persistent)' 같은 괄호 주석이 State 에 붙어
    // 나오는 경우가 있어 상태는 첫 토큰만 쓴다.
    const rest = t.slice(i);
    const portType = rest.find((x) => /-Port$/i.test(x)) || '';
    const attached = rest.filter((x) => /^[0-9a-f]{2}(:[0-9a-f]{2}){7}$/i.test(x));
    ports.push({
      index, slot, port,
      slotPort: slot == null ? String(port) : `${slot}/${port}`,
      address, media, speed: normalizeSpeed(speed),
      state: normalizePortState(stateRaw), stateRaw,
      portType, attached,
      comment: rest.filter((x) => !/-Port$/i.test(x) && !/^[0-9a-f]{2}(:[0-9a-f]{2}){7}$/i.test(x) && x !== 'FC').join(' ').trim(),
    });
  }
  return { header, ports, hasSlot };
}

/** 'N16'/'16G'/'AN'/'--' → '16G'/'자동'/'' 로 표준화(속도 분포 집계가 흔들리지 않게). */
export function normalizeSpeed(raw) {
  const s = String(raw || '').trim();
  if (!s || s === '--') return '';
  if (/^AN$/i.test(s)) return '자동';
  const m = s.match(/^N?(\d+)\s*G?$/i);
  return m ? `${m[1]}G` : s;
}

/** '1.2g' / '345k' / '12' → 숫자. porterrshow 는 큰 값을 k/m/g 로 줄여 찍는다. */
export function parseCounter(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s || s === '-' || s === '--') return null;
  const m = s.match(/^([\d.]+)\s*([kmgt])?$/);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, g: 1e9, t: 1e12 }[m[2]] || 1;
  return Math.round(Number(m[1]) * mult);
}

/**
 * porterrshow → { <portIndex>: {frames_tx, frames_rx, crc_err, enc_out, link_fail, ...} }.
 *
 * ⚠ 컬럼 구성이 FOS 버전마다 다르다(c3timeout·pcs_err 는 신형에만 있다). 그래서 **머리글
 *   2줄을 읽어 이름을 만들고**, 이름을 못 만들면 아래 정규 순서로 폴백한다. 값 개수가
 *   이름 개수와 다르면 앞에서부터 맞는 만큼만 채우고 나머지는 버린다(잘못된 열을 CRC 로
 *   보고하는 것보다 비우는 것이 낫다).
 */
const PORTERR_CANONICAL = ['frames_tx', 'frames_rx', 'enc_in', 'crc_err', 'crc_g_eof', 'too_shrt',
  'too_long', 'bad_eof', 'enc_out', 'disc_c3', 'link_fail', 'loss_sync', 'loss_sig', 'frjt', 'fbsy'];

export function parsePortErrShow(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  const rows = lines.filter((l) => /^\s*\d+:\s/.test(l));
  if (!rows.length) return {};
  const valueCount = rows[0].trim().split(/\s+/).length - 1;
  let names = PORTERR_CANONICAL;
  if (valueCount > PORTERR_CANONICAL.length) {
    // 신형 추가 열(c3timeout tx/rx, pcs_err …) — 정규 이름 뒤에 익명 열을 붙여 자리만 맞춘다.
    names = [...PORTERR_CANONICAL, ...Array.from({ length: valueCount - PORTERR_CANONICAL.length }, (_, i) => `extra_${i + 1}`)];
  }
  const out = {};
  for (const l of rows) {
    const t = l.trim().split(/\s+/);
    const idx = Number(t[0].replace(':', ''));
    const vals = t.slice(1);
    const rec = {};
    for (let i = 0; i < Math.min(names.length, vals.length); i++) rec[names[i]] = parseCounter(vals[i]);
    out[idx] = rec;
  }
  return out;
}

/**
 * sfpshow -all → { <portIndex>: { tempC, voltageMv, currentMa, rxPowerDbm, txPowerDbm,
 *                                 vendor, partNumber, serial, wavelengthNm } }.
 * 포트 블록은 'Port  0:' 또는 'Slot  1/Port  0:' 로 시작한다.
 */
export function parseSfpShow(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = {};
  let cur = null;
  const num = (s) => { const m = String(s).match(/-?[\d.]+/); return m ? Number(m[0]) : null; };
  // 광 레벨: '-inf dBm (0.0 uW)' 처럼 무광 포트는 dBm 자리가 -inf 다. 첫 숫자 매치(num)는 -inf 를
  // 건너뛰고 괄호 안 0.0 을 잡아 '0 dBm'(완벽한 광레벨)으로 오독한다 → 무광은 null(v2.416 리뷰 확정).
  const dbm = (s) => { const t = String(s).trim(); if (/^-?inf\b/i.test(t) || /^n\/?a\b/i.test(t)) return null; const m = t.match(/^-?[\d.]+/); return m ? Number(m[0]) : num(t); };
  for (const raw of lines) {
    const l = raw.trim();
    let m;
    if ((m = l.match(/^(?:Slot\s+(\d+)\s*\/\s*)?Port\s+(\d+)\s*:/i))) {
      const idx = Number(m[2]);
      cur = out[idx] = out[idx] || { slot: m[1] != null ? Number(m[1]) : null };
      continue;
    }
    if (!cur) continue;
    if ((m = l.match(/^Temperature:\s*(.+)$/i))) cur.tempC = num(m[1]);
    else if ((m = l.match(/^Voltage:\s*(.+)$/i))) cur.voltageMv = num(m[1]);
    else if ((m = l.match(/^Current:\s*(.+)$/i))) cur.currentMa = num(m[1]);
    else if ((m = l.match(/^RX\s*Power:\s*(.+)$/i))) cur.rxPowerDbm = dbm(m[1]);
    else if ((m = l.match(/^TX\s*Power:\s*(.+)$/i))) cur.txPowerDbm = dbm(m[1]);
    else if ((m = l.match(/^Vendor\s*Name:\s*(.+)$/i))) cur.vendor = m[1].trim();
    else if ((m = l.match(/^Vendor\s*PN:\s*(.+)$/i))) cur.partNumber = m[1].trim();
    else if ((m = l.match(/^Serial\s*No:\s*(.+)$/i))) cur.serial = m[1].trim();
    else if ((m = l.match(/^Wavelength:\s*(.+)$/i))) cur.wavelengthNm = num(m[1]);
  }
  return out;
}

/**
 * licenseshow → [{ key, name, pod }]. POD(Ports on Demand)는 '몇 포트를 쓸 수 있는가'를
 * 결정하므로 포트 용량 판단의 근거다. 다만 **라이선스 문구에서 포트 수를 역산하지 않는다** —
 * 실제 사용 가능 포트는 switchshow 의 No_License 상태로 세는 것이 정확하다(문구는 모델마다
 * 다르고 누적 여부도 불명확하다. 추정치를 확정값처럼 보이게 하지 않는다).
 */
export function parseLicenseShow(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let key = '';
  for (const raw of lines) {
    const l = raw.replace(/\s+$/, '');
    if (!l.trim()) continue;
    const m = l.match(/^(\S+):\s*$/);
    if (m) { key = m[1]; continue; }
    if (/^\s+/.test(l)) {
      const name = l.trim();
      if (/^(Feature|Expiry|Configured)/i.test(name)) continue;
      out.push({ key, name, pod: /ports?\s+on\s+demand/i.test(name) });
    }
  }
  return out.slice(0, 32);
}

/** switchstatusshow → { status, monitors:{name:state} }. */
export function parseSwitchStatusShow(text) {
  const lines = String(text || '').split(/\r?\n/);
  const monitors = {};
  let status = '';
  for (const raw of lines) {
    const l = raw.trim();
    let m;
    if ((m = l.match(/^Switch\s*State:?\s*(\S+)/i))) { status = m[1].toUpperCase(); continue; }
    if ((m = l.match(/^(.*?monitor)\s{2,}(HEALTHY|MARGINAL|DOWN|UNKNOWN)\s*$/i))) {
      monitors[m[1].trim()] = m[2].toUpperCase();
    }
  }
  return { status, monitors };
}

/**
 * nsshow → { <portId24bit(hex)>: symbolicName }. 연결 장비 이름(호스트/어레이)을 포트에
 * 붙이기 위한 것. 포트 주소(switchshow Address)와 같은 키로 맞춘다.
 */
export function parseNsShow(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = {};
  let cur = null;
  for (const raw of lines) {
    const l = raw.trim();
    let m;
    if ((m = l.match(/^N\s+([0-9a-f]{6})\s*;/i)) || (m = l.match(/^NL\s+([0-9a-f]{6})\s*;/i))) {
      cur = m[1].toLowerCase(); continue;
    }
    if (!cur) continue;
    if ((m = l.match(/^(?:Port|Node)Symb:\s*\[\s*\d+\s*\]\s*"(.*)"\s*$/i))) {
      if (m[1].trim() && !out[cur]) out[cur] = m[1].trim().slice(0, 120);
    }
  }
  return out;
}

/**
 * portperfshow 파싱(v2.411 — 사용자 제공 실출력 기준).
 *
 * 출력은 '포트 번호 줄 → ===== 구분선 → 값 줄' 이 16포트씩 반복되는 행렬이고, 마지막 블록의
 * 끝에는 `Total` 열이 붙는다:
 *
 *      16       17       18  ...      31
 *   ==========================================
 *     86.40k 130.63k   1.05m ...    1.19m
 *
 * ⚠ 값의 단위는 **바이트/초**다(FOS 문서 기준). bps 로 보려면 ×8 해야 한다 — 저장은 장비가
 *   준 원단위(B/s) 그대로 하고 환산은 화면에서 한다(저장 단계에서 환산하면 나중에 단위를
 *   되짚을 수 없다).
 * ⚠ portperfshow 는 Ctrl-C 전까지 화면을 계속 갱신한다. 그래서 캡처에는 **같은 행렬이 여러 벌**
 *   들어 있을 수 있다 — 포트 번호가 되감기는 지점을 기준으로 샘플을 나누고 **마지막(가장 최근)
 *   샘플**만 쓴다. 여러 벌을 합치면 같은 포트가 덮어써져 시점이 뒤섞인다.
 *
 * @returns { ports: { [portIndex]: bytesPerSec }, total: number|null, samples: number }
 */
export function parsePortPerfShow(text) {
  const lines = String(text || '').split(/\r?\n/);
  const isSep = (l) => /^=+$/.test(l.trim());
  const tokens = (l) => l.trim().split(/\s+/).filter(Boolean);
  const isHeader = (t) => t.length > 0 && t.every((x) => /^\d+$/.test(x) || /^total$/i.test(x)) && /^\d+$/.test(t[0]);

  const samples = [];
  let cur = null;
  let lastFirst = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = tokens(lines[i]);
    if (!isHeader(t)) continue;
    // 구분선을 건너뛰고 값 줄을 찾는다(구분선이 없는 변형도 견디게 최대 2줄까지 본다).
    let j = i + 1;
    while (j < lines.length && (isSep(lines[j]) || !lines[j].trim())) j++;
    if (j >= lines.length) break;
    const vals = tokens(lines[j]);
    if (!vals.length) continue;
    const first = Number(t[0]);
    if (!cur || first <= lastFirst) { cur = { ports: {}, total: null }; samples.push(cur); }
    lastFirst = first;
    for (let k = 0; k < Math.min(t.length, vals.length); k++) {
      const v = parseCounter(vals[k]);
      if (/^total$/i.test(t[k])) { cur.total = v; continue; }
      if (v != null) cur.ports[Number(t[k])] = v;
    }
    i = j;
  }
  // 캡처가 값 줄 중간에서 끊기면 마지막 샘플이 부분(포트 수 부족)일 수 있다 — 직전 완전 샘플보다
  // 포트 수가 적으면 마지막 것을 버리고 직전 샘플을 쓴다(절단 토큰이 '최신 값'으로 저장되는 것 방지).
  let pick = samples.length - 1;
  if (pick >= 1) {
    const n = (s) => Object.keys(s.ports).length;
    if (n(samples[pick]) < n(samples[pick - 1])) pick -= 1;
  }
  const last = samples[pick] || { ports: {}, total: null };
  return { ...last, samples: samples.length, partialDropped: pick < samples.length - 1 };
}

/** fanshow / psshow → {ok, total}. 문구가 모델마다 달라 'Ok/Faulty' 단어 수로 센다. */
export function parseFruShow(text) {
  const s = String(text || '');
  const lines = s.split(/\r?\n/).filter((l) => /\b(Fan|Power Supply|Unit)\b/i.test(l));
  if (!lines.length) return null;
  const ok = lines.filter((l) => /\bOk\b|\bOK\b|is Ok/i.test(l)).length;
  return { ok, total: lines.length };
}
