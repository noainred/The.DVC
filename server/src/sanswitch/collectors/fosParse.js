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
 * 축약 표기(k/m/g/t 접미사)인가(v2.590 F3). `1.2m` 은 유효숫자 2자리로 **반올림된** 값이라 두 수집의
 * 차이를 '새로 생긴 에러'·'초당 프레임' 으로 쓰면 틀린다 — `1.2m → 1.2m` 이면 실제로 수만 건이 늘어도
 * 차이는 0 이다(월간 점검이 '신규 없음(정상)' 이라 말했다). 판정 쪽이 이 표시를 보고 증분을 보류한다.
 */
export function isAbbreviatedCounter(raw) {
  return /^[\d.]+\s*[kmgt]$/i.test(String(raw ?? '').trim());
}

/**
 * porterrshow → { <portIndex>: {frames_tx, frames_rx, crc_err, enc_out, link_fail, ...} }.
 * 축약 표기로 읽은 열 이름은 `_approx`(배열)로 함께 싣는다 — 값 자체는 그대로 쓴다(누적 표시는 맞다).
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
    const approx = [];
    for (let i = 0; i < Math.min(names.length, vals.length); i++) {
      rec[names[i]] = parseCounter(vals[i]);
      if (isAbbreviatedCounter(vals[i])) approx.push(names[i]);
    }
    if (approx.length) rec._approx = approx;
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
      // v2.595(감사 C2595-03): 디렉터는 슬롯마다 Port 0 부터 다시 센다 — 포트 번호만 키로 쓰면 'Slot 1/Port 0' 과
      //   'Slot 2/Port 0' 이 한 항목에 덮이고, switchshow 의 전역 Index 로 조회하면 **다른 포트의 광량**이 붙었다.
      //   슬롯이 있으면 'slot/port'(switchshow slotPort 와 같은 표기)로, 없으면 예전대로 포트 번호로 둔다.
      const idx = m[1] != null ? `${Number(m[1])}/${Number(m[2])}` : Number(m[2]);
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
 * nsshow → { <포트 WWN 소문자 콜론표기>: 'initiator'|'target'|'both' }  (v2.511)
 *
 * 조닝 그림의 역할(이니시에이터/타깃)을 **추정이 아니라 확정**으로 만들기 위한 것이다.
 * 네임서버 항목의 `Device type:` 줄(FOS 가 `Physical Initiator` / `Physical Target` /
 * `Physical Initiator+Target` 로 적는다)과 `FC4s:` 줄의 `FCP-Target`/`FCP-Initiator` 표기를
 * 둘 다 본다. 키는 헤더 줄의 **세 번째 필드(포트 WWN)** — zone 멤버와 같은 축이다.
 *
 * ⚠ 정직 한계: 이 파서는 위 두 표기를 **있으면** 읽는다. 이 환경에서는 실장비 nsshow 출력을
 *   확인하지 못했고(사용자가 제공한 캡처는 cfgshow 뿐이다), FOS 버전·`nsshow` 옵션에 따라
 *   `Device type:` 이 없을 수 있다. 없으면 **빈 객체를 돌려주고 그림은 추정으로 떨어진다** —
 *   없는 역할을 지어내지 않는다. 화면도 '확정(●)' 배지를 그때만 붙인다.
 */
export function parseNsRoles(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = {};
  let cur = null;
  const set = (wwn, role) => {
    if (!wwn) return;
    const prev = out[wwn];
    out[wwn] = (prev && prev !== role) ? 'both' : role;
  };
  for (const raw of lines) {
    const l = raw.trim();
    let m;
    // `N    011000;      3;10:00:...;20:00:...; na` — 세 번째 세미콜론 필드가 포트 WWN.
    if ((m = l.match(/^N[L]?\s+[0-9a-f]{6}\s*;[^;]*;\s*([0-9a-f]{2}(?::[0-9a-f]{2}){7})\s*;/i))) {
      cur = m[1].toLowerCase(); continue;
    }
    if (/^N[L]?\s+[0-9a-f]{6}\s*;/i.test(l)) { cur = null; continue; } // 형식이 다른 헤더 — 귀속시키지 않는다
    if (!cur) continue;
    if ((m = l.match(/^(?:Device type|FC4s)\s*:\s*(.+)$/i))) {
      const v = m[1];
      const init = /initiator/i.test(v);
      const targ = /target/i.test(v);
      if (init && targ) out[cur] = 'both';
      else if (init) set(cur, 'initiator');
      else if (targ) set(cur, 'target');
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
  const isNum = (x) => /^\d+$/.test(x);
  const isTotal = (x) => /^total$/i.test(x);
  const isHeader = (t) => t.length > 0 && t.every((x) => isNum(x) || isTotal(x)) && isNum(t[0]);

  const samples = [];
  let cur = null;
  let lastFirst = -1;
  for (let i = 0; i < lines.length; i++) {
    let hdr = tokens(lines[i]);
    if (!isHeader(hdr)) continue;
    let j = i + 1;

    /**
     * ⚠ **줄바꿈된 출력을 이어붙인다**(v2.517 — 사용자 제공 실장비 캡처로 확정).
     *
     * `portperfshow` 는 터미널 폭에 맞춰 한 블록(16포트)을 **여러 줄로 쪼개** 찍는다. 사용자
     * 환경(FOS v9.2.2c, 128포트)의 실제 출력이 그 형태였다 — 포트 번호 14개 뒤에 `46 47` 두 개가
     * 다음 줄로 넘어간다. 값 줄도 같은 폭으로 쪼개진다.
     *
     * 예전 파서는 헤더 바로 다음 줄을 **값 줄로 단정**해서, 이어지는 헤더 조각(`46  47`)을 값으로
     * 읽었다 — 실측(같은 캡처): 128포트 중 **3개만** 남고 그 값도 엉뚱했다
     * (`{port 0: 49, port 62: 5790, port 63: 4030000}`). 0건이 아니라 **틀린 값이 저장**되므로
     * 화면은 '수집되고 있다' 고 보이면서 숫자가 거짓이 된다. 그래서 여기서 끊어야 한다.
     *
     * 판정: 이어지는 헤더 조각은 **직전 포트 번호 + 1 로 시작**해야 한다. 이 연속성 검사가 없으면
     * 구분선 없는 변형에서 값 줄(`0 0 0 …`, 전부 숫자라 isHeader 가 참)을 헤더로 삼킨다.
     */
    for (;;) {
      const nx = tokens(lines[j] || '');
      if (!nx.length || !isHeader(nx)) break;
      const lastPort = hdr.filter(isNum).map(Number).pop();
      if (lastPort == null || Number(nx[0]) !== lastPort + 1) break;
      hdr = [...hdr, ...nx];
      j++;
    }

    // 구분선/빈 줄 건너뛰기(구분선도 폭에 맞춰 두 줄로 쪼개진다 — 둘 다 `^=+$` 다).
    while (j < lines.length && (isSep(lines[j]) || !lines[j].trim())) j++;
    if (j >= lines.length) break;

    // 값은 **헤더 개수만큼** 모은다(쪼개진 줄을 이어붙인다). 빈 줄·구분선을 만나면 멈춘다 —
    // 캡처가 중간에서 끊긴 경우는 아래 '부분 샘플 버리기' 가 처리한다.
    const vals = [];
    while (j < lines.length && vals.length < hdr.length) {
      if (isSep(lines[j]) || !lines[j].trim()) break;
      vals.push(...tokens(lines[j]));
      j++;
    }
    if (!vals.length) continue;

    const first = Number(hdr[0]);
    if (!cur || first <= lastFirst) { cur = { ports: {}, total: null }; samples.push(cur); }
    lastFirst = first;
    for (let k = 0; k < Math.min(hdr.length, vals.length); k++) {
      const v = parseCounter(vals[k]);
      if (isTotal(hdr[k])) { cur.total = v; continue; }
      if (v != null) cur.ports[Number(hdr[k])] = v;
    }
    i = j - 1;   // 다음 반복의 i++ 가 아직 보지 않은 줄을 가리키게 한다
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

/* ══════════════════════════════════════════════════════════════════════════════
 * 월간 점검용 파서 4종(v2.519 — 사용자 제공 Brocade 월간 점검 체크리스트)
 *
 * ⚠⚠ **정직 고지 — 이 4종은 실장비 출력을 확인하지 못했다.**
 *   사용자가 보내 준 캡처는 `cfgshow`·`portperfshow` 뿐이고, 이 환경의 egress 정책에서
 *   Broadcom TechDocs 는 403(CONNECT 거부)이라 원문 형식을 읽지 못했다. 그래서 각 파서는
 *   ① **형식에 관용적**이고 ② 아무것도 못 읽으면 `parsed: false` 를 돌려준다.
 *   판정 모듈(`sanswitch/healthCheck.js`)은 `parsed: false` 를 **'이상 없음' 이 아니라
 *   '형식 미인식'** 으로 다룬다 — 점검 보고서에서 '확인했는데 정상' 과 '확인하지 못함' 을
 *   섞는 것이 가장 위험한 거짓이다. 실장비 출력을 받으면 정규식을 조이고 이 고지를 지운다.
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * `sensorshow` → 전압·온도·팬 센서.
 *
 * 관용 매칭: `sensor  N: (종류) 이름 is 상태[, value is N C | speed is N RPM]`
 * 종류·상태 문구가 펌웨어마다 달라 **종류는 소문자화해 분류만** 하고 원문(raw)을 함께 남긴다.
 *
 * @returns {{ parsed:boolean, list:Array<{n,kind,name,state,ok,value,unit,raw}>, counts:object }}
 */
export function parseSensorShow(text) {
  const lines = String(text || '').split(/\r?\n/);
  const list = [];
  for (const raw of lines) {
    const m = raw.match(/^\s*sensor\s+(\d+)\s*:\s*\(([^)]*)\)\s*(.*)$/i);
    if (!m) continue;
    const rest = String(m[3] || '');
    // `... is Ok, value is 31 C` / `... is Ok,speed is 7050 RPM` / `... is Absent`
    const st = rest.match(/\bis\s+([A-Za-z-]+)/);
    const val = rest.match(/(?:value|speed)\s+is\s+(-?[\d.]+)\s*([A-Za-z]+)?/i);
    const name = rest.replace(/\s*[,;]?\s*\bis\b.*$/i, '').trim();
    const state = st ? st[1] : '';
    list.push({
      n: Number(m[1]),
      kind: String(m[2] || '').trim().toLowerCase().replace(/\s+/g, ' '),
      name, state,
      // ⚠ 상태를 모르면 `ok: null`(모른다) — false(장애)로 단정하지 않는다.
      ok: state ? /^(ok|normal|present|absent)$/i.test(state) && !/^absent$/i.test(state) : null,
      value: val ? Number(val[1]) : null,
      unit: val && val[2] ? val[2] : null,
      raw: raw.trim().slice(0, 200),
    });
  }
  const counts = { total: list.length, ok: 0, bad: 0, unknown: 0, absent: 0 };
  for (const s of list) {
    if (/^absent$/i.test(s.state)) counts.absent++;
    else if (s.ok === true) counts.ok++;
    else if (s.ok === false) counts.bad++;
    else counts.unknown++;
  }
  return { parsed: list.length > 0, list: list.slice(0, 200), counts };
}

/** 로그 심각도 정규화 — 펌웨어마다 대소문자·약어가 달라 한 곳에서 맞춘다. */
function logSeverity(s) {
  const v = String(s || '').toUpperCase();
  if (/CRITICAL|CRIT|EMERG|ALERT/.test(v)) return 'critical';
  if (/^ERROR|\bERR\b/.test(v)) return 'error';
  if (/WARN/.test(v)) return 'warning';
  if (/INFO/.test(v)) return 'info';
  return 'unknown';
}

/**
 * `errdump`(또는 `errshow`) → RASLog 항목.
 *
 * ⚠ `errshow` 는 **대화형**(페이저로 멈춘다)이라 수집은 `errdump` 를 먼저 쓴다 — 대화형 명령을
 *   폴러가 부르면 캡처가 시한까지 매달린다.
 *
 * 관용 매칭: 한 줄에 `[MOD-1234]` 형태의 메시지 id 가 있으면 항목으로 본다. 날짜·심각도는
 * 있으면 뽑고 없으면 null. 심각도 문자열이 없으면 **'unknown'** 이고, 판정 모듈은 그것을
 * 정상으로 치지 않는다.
 *
 * @param {number} limit 최근 몇 건까지 보관할지(errdump 는 수천 줄이 올 수 있다)
 */
export function parseErrDump(text, limit = 200) {
  const lines = String(text || '').split(/\r?\n/);
  const list = [];
  for (const raw of lines) {
    // 대괄호로 앵커돼 있으므로 모듈명은 **1글자도 허용**한다(관용 설계 — 실장비 출력을 확인하지
    // 못했으므로 조이지 않는다). 실제 FOS 모듈은 FW·SEC·HIL 처럼 2~4글자다.
    const id = raw.match(/\[([A-Z][A-Z0-9]{0,15}-\d{1,5})\]/);
    if (!id) continue;
    const date = raw.match(/(\d{4}[/-]\d{2}[/-]\d{2}[ T-]\d{2}:\d{2}:\d{2})/);
    const sev = raw.match(/\b(CRITICAL|CRIT|EMERG|ALERT|ERROR|ERR|WARNING|WARN|INFO)\b/i);
    list.push({
      id: id[1], at: date ? date[1] : null,
      severity: logSeverity(sev ? sev[1] : ''),
      text: raw.trim().slice(0, 300),
    });
  }
  const counts = { total: list.length, critical: 0, error: 0, warning: 0, info: 0, unknown: 0 };
  for (const e of list) counts[e.severity] = (counts[e.severity] || 0) + 1;
  // 최근 것을 남긴다(errdump 는 보통 오래된 것부터 출력한다 — 뒤가 최신).
  return { parsed: list.length > 0, list: list.slice(-Math.max(1, limit)), counts };
}

/**
 * `bottleneckmon --show` → Slow Drain 감지.
 *
 * 출력 형태가 펌웨어·옵션마다 크게 달라 **두 가지만** 본다:
 *  ① '감지 없음' 류 문구(`No bottleneck`, `not enabled` 등)
 *  ② 포트 번호가 들어간 행(감지 목록)
 * `enabled:false` 는 **'정상' 이 아니다** — 기능이 꺼져 있으면 Slow Drain 을 알 수 없다.
 */
export function parseBottleneckMon(text) {
  const s = String(text || '');
  if (!s.trim()) return { parsed: false, enabled: null, none: false, ports: [], note: '' };
  const disabled = /\bnot\s+enabled|\bdisabled\b|is\s+not\s+configured/i.test(s);
  const none = /\bno\s+(bottleneck|congestion|latency)/i.test(s);
  const ports = [];
  for (const raw of s.split(/\r?\n/)) {
    // 헤더·구분선·요약 문구는 건너뛴다. `  12   ...  3.5  ...` 처럼 선두가 포트 번호인 행만.
    const m = raw.match(/^\s*(\d{1,3})\s+(.*\S)\s*$/);
    if (!m) continue;
    if (/^=+$/.test(m[2]) || /port/i.test(m[2]) && /type|state/i.test(m[2])) continue;
    ports.push({ port: Number(m[1]), detail: m[2].slice(0, 120) });
  }
  return {
    parsed: disabled || none || ports.length > 0,
    enabled: disabled ? false : (none || ports.length ? true : null),
    none, ports: ports.slice(0, 100),
    note: s.trim().split(/\r?\n/).find((l) => /bottleneck|congestion|latency/i.test(l))?.trim().slice(0, 200) || '',
  };
}

/**
 * `fabricshow` → 패브릭 구성원(ISL·도메인).
 *
 * 관용 매칭: `<domain>: <hex id> <WWN> <ip> <ip> "<name>"`. 이름 인용부호가 없는 펌웨어도 있어
 * 마지막 토큰을 이름으로 폴백한다. principal 표시(`>`)가 있으면 그 도메인을 principal 로 본다.
 */
export function parseFabricShow(text) {
  const lines = String(text || '').split(/\r?\n/);
  const list = [];
  let principal = null;
  for (const raw of lines) {
    const m = raw.match(/^\s*(>?)\s*(\d{1,3})\s*:\s*([0-9a-fA-F]{4,6})\s+([0-9a-fA-F:]{20,23})\s+(\S+)(?:\s+(\S+))?\s*(.*)$/);
    if (!m) continue;
    let name = String(m[7] || '').trim();
    const q = name.match(/"([^"]*)"/);
    if (q) name = q[1];
    else name = name.split(/\s+/).filter(Boolean).pop() || '';
    const domain = Number(m[2]);
    if (m[1] === '>') principal = domain;
    list.push({ domain, switchId: m[3], wwn: m[4].toLowerCase(), enetIp: m[5], fcIp: m[6] || '', name: name.slice(0, 60) });
  }
  return { parsed: list.length > 0, switches: list.slice(0, 64), count: list.length, principal };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * v2.522 — 실행 가능한 대체 명령용 파서 4종.
 *
 * 왜 추가하나: 사용자 현장 계정(`rbash`)에 `switchstatusshow`·`licenseshow`·`sensorshow`·
 * `errdump`·`bottleneckmon`·`fabricshow` 가 **없다**(스크린샷). 그래서 결과가 비슷한 **실행 가능한
 * 명령**을 후보로 시도한다(사용자 요청 "실행되지 않는 명령어가 있는데, 결과가 비슷한 실행 가능한
 * 명령어를 찾아서 대체해줘") + ISL 점검 요청(`islshow`·`trunkshow`·`lsan --show`).
 *
 * ⚠ **이 4종의 실장비 출력을 확인하지 못했다**(Broadcom TechDocs 는 이 환경에서 403). 그래서
 *   파서는 형식에 관용적이고, 아무것도 못 읽으면 `parsed:false` 를 준다 — 판정은 그것을 '정상' 이
 *   아니라 **'형식 미인식'** 으로 다룬다. 실장비 출력을 받으면 정규식을 조이고 이 고지를 지울 것.
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * `tempshow` → 온도 센서(`sensorshow` 가 없는 계정의 대체).
 * 형태(가정): `Sensor ID   Temp(C)  Temp(F)  Status` 머리글 + `  1   31   87   Ok` 행.
 * ⚠ 임계는 **장비가 준 Status** 를 따른다 — 포탈이 숫자를 정하지 않는다(v2.519 규칙).
 */
export function parseTempShow(text) {
  const s = String(text || '');
  if (!s.trim()) return { parsed: false, list: [], counts: { total: 0, ok: 0, bad: 0, unknown: 0 } };
  const list = [];
  for (const raw of s.split(/\r?\n/)) {
    if (/sensor\s*id/i.test(raw) || /^[\s=-]+$/.test(raw)) continue;
    // `<id> <C> [<F>] [<status>]` — 상태 단어가 없으면 ok 를 **추정하지 않는다**(null).
    const m = raw.match(/^\s*(\d{1,3})\s+(-?\d{1,3}(?:\.\d+)?)\s*(?:(-?\d{1,3}(?:\.\d+)?)\s*)?([A-Za-z]+)?\s*$/);
    if (!m) continue;
    const st = (m[4] || '').toLowerCase();
    list.push({
      kind: 'temp', id: Number(m[1]), value: Number(m[2]), unit: 'C',
      ok: st ? /^(ok|normal|good|nominal)$/.test(st) : null,
      raw: raw.trim().slice(0, 160),
    });
  }
  const counts = { total: list.length, ok: list.filter((x) => x.ok === true).length, bad: list.filter((x) => x.ok === false).length, unknown: list.filter((x) => x.ok == null).length, absent: 0 };
  return { parsed: list.length > 0, list, counts };
}

/**
 * `islshow` → ISL(스위치 간 링크) 목록.
 * 형태(가정): ` 1: 12-> 12 10:00:00:05:1e:aa:bb:cc  2 fab1 sp: 16.000G bw: 16.000G TRUNK QOS`
 * 관용 규칙: `->` 와 WWN 이 있는 줄만 본다. 나머지 필드는 있으면 싣고 없으면 null.
 */
export function parseIslShow(text) {
  const s = String(text || '');
  if (!s.trim()) return { parsed: false, list: [], count: 0, note: '' };
  const none = /\bno\s+isl|not\s+connected|no\s+e[-_ ]?port/i.test(s);
  const list = [];
  for (const raw of s.split(/\r?\n/)) {
    if (!/->/.test(raw)) continue;
    const wwn = raw.match(/([0-9a-f]{2}(?::[0-9a-f]{2}){7})/i);
    if (!wwn) continue;
    const ports = raw.match(/(\d{1,4})\s*->\s*(\d{1,4})/);
    const sp = raw.match(/\bsp:\s*([\d.]+\s*[GMK]?)/i);
    const bw = raw.match(/\bbw:\s*([\d.]+\s*[GMK]?)/i);
    const dom = raw.match(/(?:[0-9a-f]{2}(?::[0-9a-f]{2}){7})\s+(\d{1,3})\b/i);
    const flags = (raw.match(/\b(TRUNK|QOS|CR_RECOV|FEC|ENCRYPTED|COMPRESSED|DEGRADED)\b/gi) || []).map((x) => x.toUpperCase());
    list.push({
      port: ports ? Number(ports[1]) : null,
      remotePort: ports ? Number(ports[2]) : null,
      wwn: wwn[1].toLowerCase(),
      domain: dom ? Number(dom[1]) : null,
      speed: sp ? sp[1].trim() : '',
      bandwidth: bw ? bw[1].trim() : '',
      flags,
      raw: raw.trim().slice(0, 200),
    });
  }
  return { parsed: list.length > 0 || none, list, count: list.length, note: none && !list.length ? 'ISL 없음(출력이 그렇게 보고함)' : '' };
}

/**
 * `trunkshow` → 트렁크 그룹.
 * 형태(가정): 그룹 머리줄 ` 1:  0->  0 <wwn>  2  deskew 15  MASTER` + 이어지는 멤버 줄.
 * 그룹 번호(`N:`)가 있는 줄을 그룹 시작으로, `->` 만 있는 줄을 멤버로 본다.
 */
export function parseTrunkShow(text) {
  const s = String(text || '');
  if (!s.trim()) return { parsed: false, groups: [], count: 0, members: 0, note: '' };
  const none = /\bno\s+trunk|trunking.*(not|dis)abled/i.test(s);
  const groups = [];
  let cur = null;
  for (const raw of s.split(/\r?\n/)) {
    if (!/->/.test(raw)) continue;
    const head = raw.match(/^\s*(\d{1,3})\s*:\s*(\d{1,4})\s*->\s*(\d{1,4})/);
    const mem = raw.match(/^\s*(\d{1,4})\s*->\s*(\d{1,4})/);
    const deskew = raw.match(/deskew\s+(\d+)/i);
    const master = /\bMASTER\b/i.test(raw);
    if (head) {
      cur = { group: Number(head[1]), members: [], master: null };
      groups.push(cur);
      cur.members.push({ port: Number(head[2]), remotePort: Number(head[3]), deskew: deskew ? Number(deskew[1]) : null, master });
      if (master) cur.master = Number(head[2]);
    } else if (mem && cur) {
      cur.members.push({ port: Number(mem[1]), remotePort: Number(mem[2]), deskew: deskew ? Number(deskew[1]) : null, master });
      if (master && cur.master == null) cur.master = Number(mem[1]);
    }
  }
  const members = groups.reduce((a, g) => a + g.members.length, 0);
  return { parsed: groups.length > 0 || none, groups, count: groups.length, members, note: none && !groups.length ? '트렁크 없음(출력이 그렇게 보고함)' : '' };
}

/**
 * `lsan --show` → LSAN(패브릭 간 공유) zone 목록.
 * 형태(가정): `Fabric ID: 2` 블록 + `LSAN_<name>` 줄 + 멤버 WWN 줄.
 * LSAN 을 쓰지 않는 환경이 대다수이므로 **없는 것이 정상**이다 — 판정이 아니라 정보로만 싣는다.
 */
export function parseLsanShow(text) {
  const s = String(text || '');
  if (!s.trim()) return { parsed: false, zones: [], count: 0, note: '' };
  const none = /\bno\s+lsan|not\s+configured|fc\s*router.*not/i.test(s);
  const zones = [];
  let cur = null;
  for (const raw of s.split(/\r?\n/)) {
    const zn = raw.match(/\b(LSAN[_A-Za-z0-9-]*)\b/);
    const wwn = raw.match(/([0-9a-f]{2}(?::[0-9a-f]{2}){7})/i);
    const fid = raw.match(/fabric\s*id\s*:?\s*(\d{1,3})/i);
    if (zn) { cur = { name: zn[1], fabricId: cur?.fabricId ?? null, members: [] }; zones.push(cur); }
    else if (fid) { if (cur) cur.fabricId = Number(fid[1]); else cur = { name: '', fabricId: Number(fid[1]), members: [] }; }
    if (wwn && cur) cur.members.push(wwn[1].toLowerCase());
  }
  const named = zones.filter((z) => z.name);
  return { parsed: named.length > 0 || none, zones: named, count: named.length, note: none && !named.length ? 'LSAN 구성 없음(출력이 그렇게 보고함)' : '' };
}
