/**
 * sanswitch/types.js — SAN 스위치 모니터링 카탈로그 + 정규화 스키마(v2.410).
 *
 * 대상: Brocade(Broadcom) Fabric OS 기반 FC 스위치·디렉터 전 모델.
 *
 * ── 왜 '모델별'이 아니라 'FOS 공통'인가 ────────────────────────────────────────
 * Brocade FC 장비는 모델(6505/6510/6520/G620/G720, DCX·X6·X7 디렉터, OEM 리브랜드인
 * HPE SN6000B·IBM SAN48B·Dell Connectrix DS-*B …)이 달라도 **관리 인터페이스가 같다** —
 * 같은 Fabric OS, 같은 CLI(switchshow/porterrshow/sfpshow), 같은 REST 모듈. 모델은
 * 포트 수와 블레이드 유무만 바꾼다. 그래서 수집기는 모델을 묻지 않고, 모델·시리얼·
 * 포트 수는 **장비가 스스로 보고한 값**(chassisshow / brocade-chassis)을 그대로 쓴다.
 * 새 모델이 들어와도 코드 변경이 필요 없다.
 *
 * ⚠ 정직 표기: 사용자가 지목한 '6603' 은 Brocade FC 스위치 모델명으로 확인하지 못했다
 *   (6505/6510/6520/6547·G6xx·DCX/X6/X7 계열은 확인됨). 다만 위 이유로 **모델과 무관하게**
 *   FOS 장비면 동작하며, 실제 모델명은 수집 결과의 'model' 열에 장비가 보고한 문자열이
 *   그대로 표시된다 — 등록 후 그 값으로 확인하면 된다.
 *
 * ── 수집 방식 ────────────────────────────────────────────────────────────────
 *  1) REST API — FOS 8.2.1 이상에서만 제공된다(그 이전 펌웨어에는 /rest 가 없다).
 *     세션 수 제한이 있어 반드시 logout 한다(collectors/fosRest.js).
 *  2) SSH CLI — 전 FOS 버전에서 동작한다. 구형 펌웨어의 유일한 경로.
 *  SNMP(FA-MIB/SW-MIB)도 가능하지만 이 포탈에 SNMP 클라이언트가 없어 **넣지 않았다** —
 *  고를 수는 있는데 수집은 안 되는 유령 선택지를 만들지 않는다(storage/types.js 와 같은 규칙).
 *
 * ── NormalizedSwitchSnapshot 스키마(수집 방식과 무관하게 동일) ─────────────────
 * {
 *   deviceId, type, name,          // name = 스위치가 보고한 이름(등록명 폴백)
 *   collectedAt, ok, error,
 *   fabricOs, model, serial, wwn, domainId, switchState,   // 장비 자기보고
 *   ports: {
 *     total,        // 물리 포트 수
 *     licensed,     // 라이선스(POD)로 사용 가능한 포트 수 — 미확인이면 total
 *     online,       // 링크가 올라온 포트(= 실사용)
 *     offline,      // 라이선스는 있는데 비어 있는 포트
 *     disabled, faulty, noLicense,
 *     free,         // licensed - online  ← '포트 용량'의 핵심 지표
 *     usedPct,      // online / licensed
 *     bySpeed: { '32G': 12, ... },       // 온라인 포트의 협상 속도 분포
 *     list: [ PortRow ]                  // ≤ MAX_PORTS(디렉터 대비)
 *   },
 *   health: { status, fans, psus, tempC, alerts },   // 미수집 항목은 null
 *   licenses: [{ name, expires }],       // ≤32
 *   fabric: { switches, principal },
 *   zoning: { effectiveConfig, zones },
 *   sections: { ... },                   // 섹션별 'ok'|'skip'|오류문자열(부분 실패를 숨기지 않음)
 *   extra: {}
 * }
 *
 * PortRow = {
 *   index, slotPort, name, state, physical, enabled, speed, maxSpeed, portType,
 *   wwn, attached[], attachedName,       // 연결 장비(WWN·심볼릭 이름)
 *   errCrc, errEncOut, errLinkFail, errLossSync, errLossSig, discC3,  // 누적 카운터
 *   sfpTempC, sfpVoltage, txPowerDbm, rxPowerDbm, sfpVendor, sfpSerial, sfpPartNumber,
 *   inFrames, outFrames, inBytes, outBytes,
 *   inBps, outBps                        // 직전 수집과의 델타 기반(첫 수집은 null — 정직 표기)
 * }
 */

/** 포트 목록 상한 — X7-8 디렉터가 최대 512~768 포트. 그 이상은 절단하고 truncated 로 알린다. */
export const MAX_PORTS = 1024;

export const SAN_SWITCH_TYPES = [
  {
    type: 'brocade',
    label: 'Brocade / Broadcom (Fabric OS)',
    implemented: true,
    desc: 'FC 스위치·디렉터 전 모델 공통(6505·6510·6520·G6xx·G7xx·DCX/X6/X7 및 HPE SN·IBM SANxxB·Dell Connectrix 리브랜드). 모델·포트 수는 장비가 보고한 값을 그대로 씁니다.',
  },
  {
    type: 'cisco-mds',
    label: 'Cisco MDS (NX-OS)',
    implemented: false,
    desc: 'NX-API/SSH 기반 — 수집기 미구현(등록은 구현 후에).',
  },
];

export const COLLECT_METHODS = {
  brocade: [
    { value: 'ssh', label: 'SSH CLI (switchshow 등 — 전 펌웨어)',
      hint: '스위치에 SSH 로 접속해 switchshow·porterrshow·sfpshow·licenseshow 를 파싱합니다. FOS 버전을 가리지 않아 구형 장비에도 동작합니다.' },
    { value: 'rest', label: 'REST API (FOS 8.2.1+)',
      hint: 'FOS REST(/rest/running/brocade-*)로 포트·통계·SFP·라이선스를 읽습니다. FOS 8.2.1 미만에는 /rest 가 없어 실패합니다. 세션 수 제한이 있어 수집 후 즉시 logout 합니다.' },
  ],
  'cisco-mds': [
    { value: 'ssh', label: 'SSH CLI (NX-OS) — 미구현', hint: '카탈로그 예약. 수집기는 아직 없습니다.' },
  ],
};

export const isKnownType = (t) => SAN_SWITCH_TYPES.some((x) => x.type === t);
export const isImplementedType = (t) => SAN_SWITCH_TYPES.some((x) => x.type === t && x.implemented);
export const typeLabel = (t) => SAN_SWITCH_TYPES.find((x) => x.type === t)?.label || t;
export const collectMethodsFor = (t) => COLLECT_METHODS[t] || COLLECT_METHODS.brocade;
export const defaultCollectMethod = (t) => collectMethodsFor(t)[0].value;
export function normalizeCollectMethod(type, value) {
  const list = collectMethodsFor(type);
  return list.some((m) => m.value === value) ? value : list[0].value;
}

/** 빈 스냅샷(수집 실패 시에도 이 형태를 반환한다 — 뷰가 타입을 몰라도 그리게). */
export function emptySnapshot(device = {}) {
  return {
    deviceId: device.id || '', type: device.type || 'brocade',
    name: device.name || device.host || '', host: device.host || '',
    datacenterId: device.datacenterId || '', agent: device.agent || '',
    collectedAt: Date.now(), ok: false, error: '',
    fabricOs: '', model: '', serial: '', wwn: '', domainId: null, switchState: '',
    ports: { total: 0, licensed: 0, online: 0, offline: 0, disabled: 0, faulty: 0, noLicense: 0,
      free: 0, usedPct: 0, bySpeed: {}, list: [], truncated: false },
    health: { status: '', fans: null, psus: null, tempC: null, alerts: 0 },
    licenses: [], fabric: { switches: 0, principal: '' }, zoning: { effectiveConfig: '', zones: 0 },
    sections: {}, extra: {},
  };
}

/**
 * 포트 목록 → 요약(순수). 수집 방식(REST/SSH)이 달라도 **요약 규칙은 하나**여야 한다 —
 * 두 수집기가 각자 세면 같은 스위치가 방식에 따라 다른 사용률을 보고한다.
 *
 * 상태 분류(FOS 공통):
 *   online   링크 정상(switchshow 'Online' / REST operational-status=2)
 *   offline  라이선스는 있는데 비어 있음('No_Light','No_Sync','No_Module','Offline')
 *   disabled 관리자가 내림('Disabled','Port Disabled')
 *   faulty   장애('Faulty','Port Fault','Laser_Flt','Mod_Inv','Mod_Val')
 *   noLicense POD 미구매 슬롯('No_License') — **분모에서 뺀다**: 살 수 없는 포트를
 *             '여유 포트'로 세면 증설 판단이 틀린다(이 기능의 핵심).
 */
export function summarizePorts(list = []) {
  const s = { total: 0, licensed: 0, online: 0, offline: 0, disabled: 0, faulty: 0, noLicense: 0,
    free: 0, usedPct: 0, bySpeed: {}, list, truncated: false };
  for (const p of list) {
    s.total++;
    const st = String(p.state || '').toLowerCase();
    if (st === 'nolicense') { s.noLicense++; continue; }
    s.licensed++;
    if (st === 'online') {
      s.online++;
      const sp = p.speed ? String(p.speed) : '기타';
      s.bySpeed[sp] = (s.bySpeed[sp] || 0) + 1;
    } else if (st === 'disabled') s.disabled++;
    else if (st === 'faulty') s.faulty++;
    else s.offline++;
  }
  s.free = Math.max(0, s.licensed - s.online);
  s.usedPct = s.licensed ? Math.round((s.online / s.licensed) * 1000) / 10 : 0;
  return s;
}
