/**
 * sanswitch/collectors/fosRest.js — Brocade Fabric OS REST API 수집기(v2.410).
 *
 * 전제: **FOS 8.2.1 이상**에만 /rest 가 있다. 그 미만 펌웨어는 404 로 실패하므로 SSH 방식을
 * 써야 한다(등록 폼의 수집 방식 안내에도 그렇게 적혀 있다).
 *
 * 인증 흐름(FOS 고유 — 일반 Basic 이 아니다):
 *   POST /rest/login  (Authorization: Basic …)
 *     → 응답 헤더 Authorization: "Custom_Basic <token>"
 *   이후 모든 요청에 그 헤더 값을 **그대로** 실어 보낸다.
 *   POST /rest/logout 로 반드시 반납한다 — FOS 는 동시 REST 세션 수가 매우 제한적이라
 *   (모델에 따라 수 개) 반납하지 않으면 다음 수집이 'no free sessions' 로 막힌다.
 *   ⚠ 그래서 logout 은 finally 에서 실패해도 무시하고 호출한다.
 *
 * 응답 형태: { "Response": { "<컨테이너>": [ {...}, ... ] } } — 항목이 1개면 배열이 아니라
 * 객체로 오는 경우가 있어 항상 asArray() 로 감싼다(실제로 흔한 사고 지점).
 */

import { Agent } from 'undici';
import { emptySnapshot, summarizePorts, MAX_PORTS } from '../types.js';
import { applyRates } from '../rates.js';

// 자체서명 인증서 장비 한정 로컬 디스패처 — 전역 TLS 오염 금지(server/CLAUDE.md).
const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
const TIMEOUT_MS = Number(process.env.SANSW_HTTP_TIMEOUT_MS) || 20_000;

const RE_HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/; // eslint-disable-line no-control-regex

export const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/**
 * FOS 포트 타입 코드 → 표시 문자열. 신형 FOS 는 문자열 필드를 함께 주므로 그것을 우선한다.
 * 확신하지 못하는 코드는 추측하지 않고 'Type N' 으로 둔다(틀린 이름을 보여주느니 코드가 낫다).
 */
const PORT_TYPE = { 7: 'F-Port', 10: 'E-Port', 15: 'U-Port', 21: 'N-Port' };
export const portTypeLabel = (row) => row['port-type-string'] || PORT_TYPE[Number(row['port-type'])]
  || (row['port-type'] != null ? `Type ${row['port-type']}` : '');

/** operational-status(2=online,3=offline,5=faulty) + physical-state 로 정규 상태 산출. */
export function restPortState(row) {
  const phys = String(row['physical-state'] || '').toLowerCase();
  if (phys.includes('no_license') || phys.includes('nolicense')) return 'noLicense';
  if (row['is-enabled-state'] === false || phys === 'disabled') return 'disabled';
  const op = Number(row['operational-status']);
  if (op === 2) return 'online';
  if (op === 5 || phys.includes('flt') || phys.includes('faulty')) return 'faulty';
  return 'offline';
}

/** 속도(bit/s) → '32G'. 0/미상은 빈 문자열. */
export function speedLabel(bps) {
  const n = Number(bps);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `${Math.round(n / 1e9)}G`;
}

/**
 * 광 파워 정규화 → dBm.
 * FOS REST(media-rdp)는 rx-power/tx-power 를 **µW 단위**로 준다(YANG 정의). CLI(sfpshow)는
 * dBm 으로 찍는다. 두 방식의 값이 다른 단위로 섞이면 임계 판정이 무의미해지므로 여기서 dBm 로
 * 통일한다. 0 이하 값은 이미 dBm 인 것으로 보고 그대로 둔다(펌웨어에 따라 dBm 을 주는 사례
 * 대비 — 양수 µW 와 음수 dBm 은 값의 부호로 구분된다).
 */
export function toDbm(v) {
  // ⚠ null/''/undefined 를 먼저 걸러야 한다 — `Number(null)` 은 0 이고 0 은 유한값이라,
  //   isFinite 만 보면 **미수집이 '0 dBm'(완벽한 광레벨)으로 둔갑**한다(회귀 테스트가 잡음).
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return Math.round(n * 10) / 10;      // 이미 dBm
  return Math.round(10 * Math.log10(n / 1000) * 10) / 10; // µW → dBm
}

function makeClient(device) {
  // 포트 기본 443 — 등록부에서 바꿀 수 있다(NAT/포트포워딩 뒤 스위치).
  const base = `https://${device.host}:${Number(device.httpsPort) || 443}/rest`;
  const auth = Buffer.from(`${device.username}:${device.password || ''}`).toString('base64');
  if (!RE_HEADER_VALUE.test(`Basic ${auth}`)) throw new Error('자격증명에 사용 불가 문자가 있습니다.');
  let token = '';
  const vf = device.vfId ? `?vf-id=${Number(device.vfId)}` : '';
  return {
    async login() {
      const res = await fetch(`${base}/login`, {
        method: 'POST', headers: { Authorization: `Basic ${auth}`, Accept: 'application/yang-data+json' },
        dispatcher, signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 401) throw new Error('인증 실패(401) — 계정/비밀번호 확인');
      if (res.status === 404) throw new Error('/rest 없음(404) — FOS 8.2.1 미만으로 보입니다. 수집 방식을 SSH 로 바꾸세요.');
      if (!res.ok) throw new Error(`login HTTP ${res.status}`);
      token = res.headers.get('authorization') || '';
      if (!token) throw new Error('login 응답에 Authorization 토큰이 없습니다.');
      try { await res.body?.cancel?.(); } catch { /* */ }
    },
    async get(modulePath) {
      const res = await fetch(`${base}/running/${modulePath}${vf}`, {
        headers: { Authorization: token, Accept: 'application/yang-data+json' },
        dispatcher, signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      return j?.Response || {};
    },
    async logout() {
      if (!token) return;
      try {
        const res = await fetch(`${base}/logout`, {
          method: 'POST', headers: { Authorization: token }, dispatcher, signal: AbortSignal.timeout(10_000),
        });
        try { await res.body?.cancel?.(); } catch { /* */ }
      } catch { /* 반납 실패는 무시 — 세션은 FOS 타임아웃으로도 회수된다 */ }
    },
  };
}

/** 응답 조각들 → 스냅샷(순수 — 테스트가 네트워크 없이 이 함수만 검증한다). */
export function buildSnapshot(device, parts = {}) {
  const snap = emptySnapshot(device);
  const sw = asArray(parts.switch?.['fibrechannel-switch'])[0] || {};
  const chassis = asArray(parts.chassis?.chassis)[0] || {};
  const ifaces = asArray(parts.ports?.fibrechannel);
  const stats = new Map(asArray(parts.stats?.['fibrechannel-statistics']).map((s) => [String(s.name), s]));
  const media = new Map(asArray(parts.media?.['media-rdp']).map((m) => [String(m.name), m]));
  const nameServer = new Map(asArray(parts.ns?.['fibrechannel-name-server'])
    .map((n) => [String(n['port-id'] || '').toLowerCase().replace(/^0x/, ''), n['port-symbolic-name'] || n['node-symbolic-name'] || '']));

  snap.name = sw['user-friendly-name'] || chassis['chassis-user-friendly-name'] || device.name || device.host;
  snap.fabricOs = sw['firmware-version'] || '';
  snap.model = chassis['product-name'] || '';
  snap.serial = chassis['serial-number'] || '';
  snap.wwn = sw['name'] || chassis['chassis-wwn'] || '';
  snap.domainId = sw['domain-id'] != null ? Number(sw['domain-id']) : null;
  snap.switchState = Number(sw['operational-status']) === 2 ? 'Online' : (sw['operational-status'] != null ? 'Offline' : '');
  snap.zoning = { effectiveConfig: asArray(parts.zone?.['effective-configuration'])[0]?.['cfg-name'] || '', zones: 0 };
  snap.fabric = {
    switches: asArray(parts.fabric?.['fabric-switch']).length,
    principal: asArray(parts.fabric?.['fabric-switch']).find((f) => Number(f['principal']) === 1)?.['switch-user-friendly-name'] || '',
  };

  const list = ifaces.slice(0, MAX_PORTS).map((row) => {
    const key = String(row.name);
    const st = stats.get(key) || {};
    const md = media.get(key) || {};
    const addr = String(row['fcid-hex'] || row.fcid || '').toLowerCase().replace(/^0x/, '');
    const slot = key.includes('/') ? Number(key.split('/')[0]) : null;
    return {
      index: row['default-index'] != null ? Number(row['default-index']) : Number(row.index ?? key.replace('/', '')),
      slot, slotPort: key, address: addr,
      state: restPortState(row), stateRaw: row['physical-state'] || '',
      speed: speedLabel(row.speed), maxSpeed: speedLabel(row['max-speed']),
      portType: portTypeLabel(row),
      attached: asArray(row.neighbor?.wwn), attachedName: nameServer.get(addr) || '',
      comment: '',
      errCrc: num(st['crc-errors']), errEncOut: num(st['encoding-errors-outside-frame']),
      errLinkFail: num(st['link-failures']), errLossSync: num(st['loss-of-sync']),
      errLossSig: num(st['loss-of-signal']), discC3: num(st['class-3-discards']),
      inFrames: num(st['in-frames']), outFrames: num(st['out-frames']),
      inBytes: num(st['in-octets']), outBytes: num(st['out-octets']),
      sfpTempC: num(md.temperature), sfpVoltageMv: num(md.voltage),
      txPowerDbm: toDbm(md['tx-power']), rxPowerDbm: toDbm(md['rx-power']),
      sfpVendor: md['vendor-name'] || '', sfpSerial: md['serial-number'] || '', sfpPartNumber: md['part-number'] || '',
    };
  });
  const rate = applyRates(device.id, list);
  snap.ports = { ...summarizePorts(list), truncated: ifaces.length > MAX_PORTS };
  snap.licenses = asArray(parts.license?.license).slice(0, 32)
    .map((l) => ({ key: '', name: l.name || l.feature || '', expires: l['expiration-date'] || '', pod: /ports?\s*on\s*demand|POD/i.test(String(l.name || '')) }));
  const fans = asArray(parts.fan?.fan);
  const psus = asArray(parts.psu?.['power-supply']);
  snap.health = {
    status: snap.switchState,
    fans: fans.length ? { ok: fans.filter((f) => String(f['operational-state'] || '').toLowerCase() === 'ok').length, total: fans.length } : null,
    psus: psus.length ? { ok: psus.filter((p) => String(p['operational-state'] || '').toLowerCase() === 'ok').length, total: psus.length } : null,
    tempC: list.reduce((mx, p) => (p.sfpTempC != null && p.sfpTempC > mx ? p.sfpTempC : mx), -Infinity) > -Infinity
      ? list.reduce((mx, p) => (p.sfpTempC != null && p.sfpTempC > mx ? p.sfpTempC : mx), -Infinity) : null,
    alerts: 0, monitors: {},
  };
  snap.extra = { collectMethod: 'rest', rateReady: rate.computed, rateGapSec: rate.gapSec, rateUnit: 'bps',
    fabricName: sw['fabric-user-friendly-name'] || '' };
  snap.ok = true;
  return snap;
}

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** 수집 진입점. 섹션 실패는 sections 에 남기고 계속 진행한다(포트 표는 살린다). */
export async function collect(device) {
  const c = makeClient(device);
  await c.login();
  const parts = {}; const sections = {};
  const grab = async (key, modulePath, required = false) => {
    try { parts[key] = await c.get(modulePath); sections[key] = 'ok'; }
    catch (e) { sections[key] = e.message; if (required) throw e; }
  };
  try {
    await grab('ports', 'brocade-interface/fibrechannel', true);
    await grab('switch', 'brocade-fibrechannel-switch/fibrechannel-switch');
    await grab('chassis', 'brocade-chassis/chassis');
    await grab('stats', 'brocade-interface/fibrechannel-statistics');
    await grab('media', 'brocade-media/media-rdp');
    await grab('license', 'brocade-license/license');
    await grab('fan', 'brocade-fru/fan');
    await grab('psu', 'brocade-fru/power-supply');
    await grab('fabric', 'brocade-fabric/fabric-switch');
    await grab('ns', 'brocade-name-server/fibrechannel-name-server');
    await grab('zone', 'brocade-zone/effective-configuration');
  } finally {
    await c.logout(); // 세션 반납은 반드시(FOS 동시 REST 세션 수가 매우 적다)
  }
  const snap = buildSnapshot(device, parts);
  snap.sections = sections;
  return snap;
}
