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
 * chassisshow → { model, serial, partNumber }.
 * 'Chassis Family' 가 모델(6510/G620/X6-8 …)이다. 디렉터는 블레이드 항목이 여러 번 나오는데,
 * 시리얼은 **CHASSIS/WWN 카드 것**을 우선하고 없으면 첫 'Factory Serial Num' 을 쓴다.
 */
export function parseChassisShow(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = { model: '', serial: '', partNumber: '' };
  let inChassisBlock = false;
  for (const raw of lines) {
    const l = raw.trim();
    let m;
    if ((m = l.match(/^Chassis\s+Family:\s*(.+)$/i))) { out.model = m[1].trim(); continue; }
    if (/^CHASSIS\b/i.test(l) || /^Chassis Factory/i.test(l)) inChassisBlock = true;
    else if (/^(SW|CP|AP|POWER SUPPLY|FAN)\b/i.test(l)) inChassisBlock = false;
    if ((m = l.match(/^Factory\s+Serial\s+Num:\s*(\S+)/i))) {
      if (!out.serial || inChassisBlock) out.serial = m[1];
      continue;
    }
    if ((m = l.match(/^Factory\s+Part\s+Num:\s*(\S+)/i))) { if (!out.partNumber) out.partNumber = m[1]; }
  }
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
    else if ((m = l.match(/^RX\s*Power:\s*(.+)$/i))) cur.rxPowerDbm = num(m[1]);
    else if ((m = l.match(/^TX\s*Power:\s*(.+)$/i))) cur.txPowerDbm = num(m[1]);
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

/** fanshow / psshow → {ok, total}. 문구가 모델마다 달라 'Ok/Faulty' 단어 수로 센다. */
export function parseFruShow(text) {
  const s = String(text || '');
  const lines = s.split(/\r?\n/).filter((l) => /\b(Fan|Power Supply|Unit)\b/i.test(l));
  if (!lines.length) return null;
  const ok = lines.filter((l) => /\bOk\b|\bOK\b|is Ok/i.test(l)).length;
  return { ok, total: lines.length };
}
