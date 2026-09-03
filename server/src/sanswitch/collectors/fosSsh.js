/**
 * sanswitch/collectors/fosSsh.js — Brocade Fabric OS SSH CLI 수집기(v2.410).
 *
 * 왜 SSH 가 기본인가: FOS REST API 는 **8.2.1 이상에만 있다**. 현장에는 그보다 낮은 펌웨어가
 * 흔히 남아 있고, 그 장비에는 CLI 말고 경로가 없다. 그래서 SSH 를 기본 방식으로 둔다.
 *
 * 실행 명령(전부 읽기 전용 — 스위치 구성을 바꾸지 않는다):
 *   switchshow        포트 표(인덱스/슬롯·포트/속도/상태/타입/연결 WWN) ← 필수
 *   chassisshow       모델(Chassis Family)·시리얼
 *   firmwareshow      FOS 버전
 *   licenseshow       라이선스(POD 포함)
 *   porterrshow       포트별 누적 에러/프레임 카운터
 *   sfpshow -all      SFP 광레벨(Tx/Rx dBm)·온도·벤더
 *   switchstatusshow  스위치 종합 헬스
 *   fanshow / psshow  FRU 상태
 *   nsshow            네임서버(연결 장비 심볼릭 이름)
 *
 * 부분 실패는 숨기지 않는다 — switchshow 만 성공해도 포트 현황은 보여주고, 실패한 섹션은
 * sections 에 사유를 남긴다(권한이 낮은 계정은 nsshow/licenseshow 가 막히는 경우가 있다).
 */

import { withSsh } from '../../proxy/sshExec.js';
import { emptySnapshot, summarizePorts, MAX_PORTS } from '../types.js';
import { applyRates } from '../rates.js';
import * as P from './fosParse.js';

const RAW_LIMIT = Number(process.env.SANSW_CLI_RAW_LIMIT) || 4000;
const CMD_TIMEOUT_MS = Number(process.env.SANSW_CLI_TIMEOUT_MS) || 45_000;

/**
 * 명령 명세. required 인 것이 실패하면 전체 수집 실패.
 * cmds 는 후보 목록 — 앞에서부터 시도해 쓸 만한 출력이 나오면 멈춘다(버전차 폴백).
 * ⚠ Virtual Fabrics 장비는 논리 스위치 컨텍스트를 먼저 바꿔야 한다. 다만 `setcontext` 는
 *   세션 상태를 바꾸는 명령이라, 각 exec 이 독립 채널인 이 구현에서는 유지되지 않는다.
 *   그래서 VF 는 **명령마다 앞에 붙여** 실행한다(`setcontext N; switchshow`).
 */
function specs(vfId) {
  const pre = vfId ? `setcontext ${vfId}; ` : '';
  const c = (s) => `${pre}${s}`;
  return [
    { key: 'switchshow', required: true, cmds: [c('switchshow')] },
    { key: 'chassisshow', cmds: [c('chassisshow')] },
    { key: 'firmwareshow', cmds: [c('firmwareshow')] },
    { key: 'licenseshow', cmds: [c('licenseshow')] },
    { key: 'porterrshow', cmds: [c('porterrshow')] },
    { key: 'sfpshow', cmds: [c('sfpshow -all'), c('sfpshow')] },
    { key: 'switchstatusshow', cmds: [c('switchstatusshow')] },
    { key: 'fanshow', cmds: [c('fanshow')] },
    { key: 'psshow', cmds: [c('psshow')] },
    { key: 'nsshow', cmds: [c('nsshow')] },
  ];
}

async function runSession(device) {
  const creds = {
    host: device.host, port: Number(device.sshPort) || 22,
    username: device.username, password: device.password || '',
  };
  return withSsh(creds, async (sh) => {
    const out = {}; const raw = []; const errors = {};
    for (const spec of specs(device.vfId)) {
      let lastErr = null; let done = false;
      for (const cmd of spec.cmds) {
        try {
          const r = await sh.exec(cmd, CMD_TIMEOUT_MS);
          const stdout = String(r.stdout || '');
          const stderr = String(r.stderr || '');
          // FOS 는 오류를 exit 0 + 본문 문구로 내는 경우가 흔하다(예: 'Invalid command').
          const looksError = !stdout.trim()
            || /^\s*(invalid command|command not found|permission denied|not supported)/i.test(stdout)
            || /command not found|not recognized/i.test(stderr);
          raw.push({ key: spec.key, cmd, ok: !looksError, sample: (stdout || stderr).slice(0, RAW_LIMIT) });
          if (looksError) { lastErr = new Error(firstLine(stdout || stderr) || '빈 출력'); continue; }
          out[spec.key] = stdout; done = true; break;
        } catch (e) {
          lastErr = e;
          raw.push({ key: spec.key, cmd, ok: false, sample: `실행 오류: ${e.message}`.slice(0, RAW_LIMIT) });
        }
      }
      if (!done) {
        errors[spec.key] = lastErr?.message || '명령 실패';
        if (spec.required) throw new Error(`${spec.key}: ${errors[spec.key]}`);
      }
    }
    return { out, raw, errors };
  });
}

const firstLine = (t) => String(t || '').split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 200) || '';

/**
 * 파싱 결과 합성(순수 — 테스트가 SSH 없이 이 함수만 검증한다).
 * @param out    { switchshow, chassisshow, ... } 각 명령의 stdout
 * @param errors { key: 사유 }
 */
export function buildSnapshot(device, out = {}, errors = {}) {
  const snap = emptySnapshot(device);
  const sw = P.parseSwitchShow(out.switchshow || '');
  const chassis = P.parseChassisShow(out.chassisshow || '');
  const errs = P.parsePortErrShow(out.porterrshow || '');
  const sfps = P.parseSfpShow(out.sfpshow || '');
  const ns = P.parseNsShow(out.nsshow || '');
  const status = P.parseSwitchStatusShow(out.switchstatusshow || '');
  const licenses = P.parseLicenseShow(out.licenseshow || '');

  snap.name = sw.header.switchName || device.name || device.host;
  snap.switchState = sw.header.switchState || '';
  snap.wwn = sw.header.switchWwn || '';
  snap.domainId = sw.header.switchDomain != null ? Number(sw.header.switchDomain) : null;
  snap.fabricOs = P.parseFirmwareShow(out.firmwareshow || '');
  snap.model = chassis.model || '';
  snap.serial = chassis.serial || '';
  snap.zoning = { effectiveConfig: (sw.header.zoning || '').replace(/^ON\s*\(?|\)?$/gi, '').trim(), zones: 0 };

  const list = sw.ports.slice(0, MAX_PORTS).map((p) => {
    const e = errs[p.index] || {};
    const s = sfps[p.index] || {};
    return {
      index: p.index, slot: p.slot, slotPort: p.slotPort, address: p.address,
      state: p.state, stateRaw: p.stateRaw, speed: p.speed, portType: p.portType,
      attached: p.attached, attachedName: ns[String(p.address || '').toLowerCase()] || '',
      comment: p.comment,
      errCrc: e.crc_err ?? null, errEncOut: e.enc_out ?? null, errLinkFail: e.link_fail ?? null,
      errLossSync: e.loss_sync ?? null, errLossSig: e.loss_sig ?? null, discC3: e.disc_c3 ?? null,
      inFrames: e.frames_rx ?? null, outFrames: e.frames_tx ?? null,
      inBytes: null, outBytes: null,   // SSH porterrshow 는 옥텟을 주지 않는다 → bps 대신 fps
      sfpTempC: s.tempC ?? null, sfpVoltageMv: s.voltageMv ?? null,
      txPowerDbm: s.txPowerDbm ?? null, rxPowerDbm: s.rxPowerDbm ?? null,
      sfpVendor: s.vendor || '', sfpSerial: s.serial || '', sfpPartNumber: s.partNumber || '',
    };
  });
  const rate = applyRates(device.id, list);
  snap.ports = { ...summarizePorts(list), truncated: sw.ports.length > MAX_PORTS };
  snap.licenses = licenses;
  const fans = P.parseFruShow(out.fanshow || '');
  const psus = P.parseFruShow(out.psshow || '');
  snap.health = {
    status: status.status || (sw.header.switchState || ''),
    fans, psus,
    tempC: Math.max(...list.map((p) => p.sfpTempC ?? -Infinity)) > -Infinity
      ? Math.max(...list.map((p) => p.sfpTempC ?? -Infinity)) : null,
    alerts: Object.values(status.monitors || {}).filter((v) => v !== 'HEALTHY').length,
    monitors: status.monitors || {},
  };
  snap.sections = {
    ports: 'ok',
    chassis: out.chassisshow ? 'ok' : (errors.chassisshow || 'skip'),
    firmware: out.firmwareshow ? 'ok' : (errors.firmwareshow || 'skip'),
    counters: out.porterrshow ? 'ok' : (errors.porterrshow || 'skip'),
    sfp: out.sfpshow ? 'ok' : (errors.sfpshow || 'skip'),
    health: out.switchstatusshow ? 'ok' : (errors.switchstatusshow || 'skip'),
    licenses: out.licenseshow ? 'ok' : (errors.licenseshow || 'skip'),
    nameserver: out.nsshow ? 'ok' : (errors.nsshow || 'skip'),
  };
  snap.extra = {
    collectMethod: 'ssh',
    // 속도(처리량)는 두 번째 수집부터 나온다 — UI 가 '아직 계산 전'을 정직하게 안내하도록.
    rateReady: rate.computed, rateGapSec: rate.gapSec,
    rateUnit: 'fps', // SSH 는 옥텟 카운터가 없어 프레임/초만 계산된다
    switchType: sw.header.switchType || '', switchRole: sw.header.switchRole || '',
    fabricName: sw.header.FabricName || '',
  };
  snap.ok = true;
  return snap;
}

/** 수집 진입점. raw(명령 원문)는 연결 테스트에서만 쓰고 스냅샷에는 넣지 않는다(대역폭). */
export async function collect(device, { withRaw = false } = {}) {
  const r = await runSession(device);
  const snap = buildSnapshot(device, r.out, r.errors);
  return withRaw ? { snap, raw: r.raw } : snap;
}
