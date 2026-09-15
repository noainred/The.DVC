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
 *   cfgshow           조닝(활성 설정·zone 멤버·별칭) ← v2.511, 조닝 그림의 원천
 *
 * ⚠ cfgshow 출력은 대형 패브릭에서 수십~수백 KB 다(사용자 실장비에서 42KB 지점까지 확인).
 *   대화식 터미널에서는 FOS 가 `--More--(byte N)` 페이저를 붙이는데, 이 구현은 **비대화식 exec
 *   채널**이라 보통 붙지 않는다. 그래도 붙으면 파서가 그 흔적을 보고 `truncated` 로 밝힌다
 *   (조용히 일부만 보여주지 않는다). 출력 상한은 sshExec 의 4MB 를 그대로 쓴다.
 *
 * 부분 실패는 숨기지 않는다 — switchshow 만 성공해도 포트 현황은 보여주고, 실패한 섹션은
 * sections 에 사유를 남긴다(권한이 낮은 계정은 nsshow/licenseshow 가 막히는 경우가 있다).
 */

import { withSsh } from '../../proxy/sshExec.js';
import { emptySnapshot, summarizePorts, MAX_PORTS } from '../types.js';
import { applyRates } from '../rates.js';
import * as P from './fosParse.js';
import { zoningFromText } from '../zoningCollect.js';

const RAW_LIMIT = Number(process.env.SANSW_CLI_RAW_LIMIT) || 4000;
const CMD_TIMEOUT_MS = Number(process.env.SANSW_CLI_TIMEOUT_MS) || 45_000;

/**
 * 명령 명세. required 인 것이 실패하면 전체 수집 실패.
 * cmds 는 후보 목록 — 앞에서부터 시도해 쓸 만한 출력이 나오면 멈춘다(버전차 폴백).
 * ⚠ Virtual Fabrics 장비는 논리 스위치 컨텍스트를 먼저 바꿔야 한다. 다만 `setcontext` 는
 *   세션 상태를 바꾸는 명령이라, 각 exec 이 독립 채널인 이 구현에서는 유지되지 않는다.
 *   그래서 VF 는 **명령마다 앞에 붙여** 실행한다(`setcontext N; switchshow`).
 */
/**
 * 명령 가용성 조사(v2.412 — 실장비 진단으로 교정).
 *
 * v2.411 에서는 `switchstatusshow` 가 안 되자 '흔히 쓰이는 경로'를 **추측해서** 하나씩
 * 찔러봤다. 사용자가 실장비에서 확인해 준 결과 그 추측은 틀렸고, 더 중요하게는
 * **그 명령 자체가 이 스위치에 없었다**:
 *
 *   > which switchstatusshow
 *   which: no switchstatusshow in (/fabos/link_bin:/bin:/usr/bin:/sbin:/usr/sbin:
 *          /fabos/link_abin:/fabos/link_sbin:/fabos/link_rbin:/fabos/factory:/fabos/xtool)
 *   > ls /fabos/&#42;/switchstatusshow  →  No such file or directory
 *
 * 그래서 경로를 추측하지 않고 **장비에 직접 묻는다**: 세션 시작에 한 번 `echo $PATH` 로 실제
 * 검색 경로를 받고, 그 디렉터리들의 파일 목록으로 '이 스위치가 가진 명령 집합'을 만든다.
 * 이후에는 있는 명령만 실행하고, 없는 명령은 **시도조차 하지 않고** 사유를 남긴다.
 *
 * 얻는 것: ① 없는 명령에 6번씩 SSH 왕복하던 낭비 제거 ② '왜 안 되는지'가 추측이 아닌 사실로
 * 표시됨 ③ 모델·펌웨어마다 다른 명령 구성에 코드 변경 없이 적응.
 *
 * ⚠ root 계정은 raw 셸을 받지만 admin 계정의 로그인 셸은 FOS CLI 라, **계정에 따라 쓸 수 있는
 *   명령이 다르다**. 그래서 캐시 키에 계정을 포함한다.
 */
const CAPS_TTL_MS = Math.max(60_000, Number(process.env.SANSW_CAPS_TTL_MS) || 6 * 3600_000);
const _caps = new Map(); // `${host}|${user}` → { at, has:Set<string>, path:string[] }

/** 장비가 돌려준 경로 문자열 중 **안전한 절대경로만** 통과(셸 조립에 그대로 들어가므로). */
const SAFE_DIR = /^\/[A-Za-z0-9._/-]{1,200}$/;

export async function probeCommands(sh, key) {
  const cached = _caps.get(key);
  if (cached && Date.now() - cached.at < CAPS_TTL_MS) return cached;
  try {
    const pr = await sh.exec('echo $PATH', 15_000);
    const dirs = String(pr.stdout || '').trim().split(':').map((d) => d.trim())
      .filter((d) => SAFE_DIR.test(d)).slice(0, 20);
    if (!dirs.length) throw new Error('PATH 를 읽지 못했습니다');
    const ls = await sh.exec(`ls ${dirs.join(' ')} 2>/dev/null`, 25_000);
    const has = new Set(String(ls.stdout || '').split(/\s+/).map((x) => x.trim()).filter(Boolean));
    if (!has.size) throw new Error('명령 목록이 비었습니다');
    const rec = { at: Date.now(), has, path: dirs };
    _caps.set(key, rec);
    return rec;
  } catch (e) {
    // 조사 실패 시에는 '전부 있다'고 보고 그냥 실행한다 — 조사 실패가 수집 실패로 번지면 안 된다.
    const rec = { at: Date.now(), has: null, path: [], probeError: e.message };
    _caps.set(key, rec);
    return rec;
  }
}

/**
 * 실행할 명령 목록. `sfpshow` 처럼 옵션 유무가 버전마다 다른 것만 후보를 둔다
 * (경로 추측 후보는 없앴다 — 위 머리말 참조).
 */
function specs(vfId) {
  const pre = vfId ? `setcontext ${vfId}; ` : '';
  const c = (cmd) => `${pre}${cmd}`;
  return [
    { key: 'switchshow', bin: 'switchshow', required: true, cmds: [c('switchshow')] },
    { key: 'chassisshow', bin: 'chassisshow', cmds: [c('chassisshow')] },
    { key: 'firmwareshow', bin: 'firmwareshow', cmds: [c('firmwareshow')] },
    { key: 'licenseshow', bin: 'licenseshow', cmds: [c('licenseshow')] },
    { key: 'porterrshow', bin: 'porterrshow', cmds: [c('porterrshow')] },
    { key: 'sfpshow', bin: 'sfpshow', cmds: [c('sfpshow -all'), c('sfpshow')] },
    { key: 'switchstatusshow', bin: 'switchstatusshow', cmds: [c('switchstatusshow')] },
    { key: 'fanshow', bin: 'fanshow', cmds: [c('fanshow')] },
    { key: 'psshow', bin: 'psshow', cmds: [c('psshow')] },
    { key: 'nsshow', bin: 'nsshow', cmds: [c('nsshow')] },
    // v2.511: 조닝. `cfgshow` 가 없는 계정/펌웨어면 probeCommands 가 걸러 시도조차 하지 않는다.
    { key: 'cfgshow', bin: 'cfgshow', cmds: [c('cfgshow')] },
  ];
}

async function runSession(device, signal, { trace = null, verbose = false } = {}) {
  const creds = {
    host: device.host, port: Number(device.sshPort) || 22,
    username: device.username, password: device.password || '', signal,
    trace, verbose, // 연결 테스트 추적(v2.421) — 폴러는 넘기지 않는다(null)
  };
  return withSsh(creds, async (sh) => {
    const out = {}; const raw = []; const errors = {};
    // 이 스위치가 실제로 가진 명령 집합을 먼저 조사한다(경로 추측 금지 — 위 머리말).
    trace?.('명령 가용성 조사(echo $PATH; ls) — 캐시 6시간');
    const caps = await probeCommands(sh, `${device.host}|${device.username}`);
    if (caps.probeError) trace?.(`명령 조사 실패(그대로 진행): ${caps.probeError}`, 'warn');
    else trace?.(`PATH ${caps.path.length}개 디렉터리 · 확인된 명령 ${caps.has.size}개`);
    if (caps.probeError) raw.push({ key: '_probe', cmd: 'echo $PATH; ls $PATH', ok: false, sample: `명령 조사 실패(그대로 실행합니다): ${caps.probeError}` });
    else raw.push({ key: '_probe', cmd: 'echo $PATH; ls $PATH', ok: true, sample: `PATH: ${caps.path.join(':')}\n확인된 명령 ${caps.has.size}개` });

    for (const spec of specs(device.vfId)) {
      // 조사에 성공했고 그 명령이 없으면 **시도하지 않는다** — 없는 명령에 SSH 왕복을
      // 반복하지 않고, 사유도 추측이 아닌 사실('이 스위치에 없음')로 남긴다.
      if (caps.has && spec.bin && !caps.has.has(spec.bin)) {
        const why = `이 스위치에 '${spec.bin}' 명령이 없습니다(펌웨어/계정이 제공하지 않음)`;
        errors[spec.key] = why;
        raw.push({ key: spec.key, cmd: spec.bin, ok: false, sample: `${why}\n확인 경로: ${caps.path.join(':')}` });
        if (spec.required) throw new Error(`${spec.key}: ${why}`);
        continue;
      }
      let lastErr = null; let done = false;
      for (const cmd of spec.cmds) {
        try {
          const r = await sh.exec(cmd, CMD_TIMEOUT_MS);
          const stdout = String(r.stdout || '');
          const stderr = String(r.stderr || '');
          // FOS 는 오류를 exit 0 + 본문/stderr 문구로 내는 경우가 흔하다. 'command not found' 는
          // 줄 중간에 나오므로(`sh: licenseshow: command not found`) 앵커 없이 본다 —
          // 앵커를 걸어 두면 실패를 '성공(빈 내용)'으로 오인해 대체 경로를 시도하지 않는다.
          const looksError = !stdout.trim()
            || /command not found|not recognized|no such file or directory/i.test(stdout)
            || /^\s*(invalid command|permission denied|not supported)/i.test(stdout)
            || /command not found|not recognized|no such file or directory/i.test(stderr);
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
  // 모델은 chassisshow 의 'Chassis Family'. 그게 없으면 **추측하지 않고** switchshow 의
  // switchType 원값을 화면이 그대로 보여준다(extra.switchType) — 타입 코드→모델명 매핑표는
  // 확실하지 않아 만들지 않았다. 틀린 모델명을 보여주느니 원값이 낫다.
  snap.model = chassis.model || '';
  snap.serial = chassis.serial || '';
  // 조닝(v2.511) — switchshow 헤더의 활성 설정 **이름**에 더해, cfgshow 로 zone 멤버까지 읽는다.
  // v2.510 까지는 이름 한 줄뿐이고 `zones: 0` 은 하드코딩이었다(그래서 그림을 그릴 수 없었다).
  const headerCfg = (sw.header.zoning || '').replace(/^ON\s*\(?|\)?$/gi, '').trim();
  snap.zoning = zoningFromText(out.cfgshow || '', headerCfg);
  // 네임서버가 알려주는 FC4 역할(있을 때만) — 조닝 그림의 역할을 '추정' 이 아니라 '확정' 으로
  // 만든다. 없으면 빈 객체이고 그림은 구조 추론으로 떨어진다(fosParse.parseNsRoles 주석 참조).
  snap.nsRoles = P.parseNsRoles(out.nsshow || '');

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
  // FRU 상태는 fanshow/psshow 가 우선(정상/장애 판정이 있다). 그 명령이 없는 장비에서는
  // chassisshow 의 유닛 개수로 대체한다 — 개수만 알 뿐 정상 여부는 모르므로 ok:null 로 두고
  // 화면이 '3개'처럼 개수만 표시하게 한다(모르는 것을 '정상'으로 칠하지 않는다).
  const fans = P.parseFruShow(out.fanshow || '') || (chassis.fans ? { ok: null, total: chassis.fans } : null);
  const psus = P.parseFruShow(out.psshow || '') || (chassis.psus.length ? { ok: null, total: chassis.psus.length } : null);
  snap.health = {
    status: status.status || (sw.header.switchState || ''),
    fans, psus, powerWatts: chassis.powerWatts, psuDetail: chassis.psus.slice(0, 8),
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
    zoning: out.cfgshow ? 'ok' : (errors.cfgshow || 'skip'),
  };
  snap.extra = {
    collectMethod: 'ssh',
    // chassisshow 에서 얻은 섀시 식별·가동 정보(v2.411 — 실장비 출력에 'Chassis Family' 가
    // 없어 모델명을 못 읽는 대신, 실제로 들어 있는 값들을 그대로 노출한다).
    chassisPartNumber: chassis.partNumber || '', chassisId: chassis.chassisId || '',
    awakeDays: chassis.awakeDays, aliveDays: chassis.aliveDays,
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
export async function collect(device, { withRaw = false, signal, trace = null, verbose = false } = {}) {
  const r = await runSession(device, signal, { trace, verbose });
  trace?.(`출력 해석: 성공 섹션 ${Object.keys(r.out).length}개, 실패 ${Object.keys(r.errors).length}개${Object.keys(r.errors).length ? ` (${Object.keys(r.errors).join(', ')})` : ''}`);
  const snap = buildSnapshot(device, r.out, r.errors);
  return withRaw ? { snap, raw: r.raw } : snap;
}
