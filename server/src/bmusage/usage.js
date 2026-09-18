/**
 * bmusage/usage.js — 두 경로(iDRAC · OS)의 결과를 **하나의 사용률 행**으로 합친다(순수, v2.550).
 *
 * ── 어느 값을 쓰는가(우선순위와 그 이유) ─────────────────────────────────────
 *  · CPU·메모리 : **OS 우선**, 없으면 iDRAC. OS 는 커널이 세는 값이고 iDRAC 텔레메트리는
 *    BMC 가 샘플링한 집계다 — 같은 서버에서 두 값이 다를 수 있으므로 **어느 쪽을 썼는지 밝힌다**
 *    (`srcOf.cpu` · `srcOf.mem`). 조용히 고르면 사용자가 두 화면의 숫자가 다른 이유를 모른다.
 *  · 디스크·네트워크·HBA : **OS 뿐**이다(iDRAC 텔레메트리에 개별 사용률이 없다).
 *  · I/O(`io_pct`) : **iDRAC 뿐**이고 '집계' 라 디스크·네트워크와 같은 뜻이 아니다 — 참고값이다.
 *
 * ── 대표값을 어떻게 뽑는가 ───────────────────────────────────────────────────
 * 디스크가 6개, NIC 가 4개인 서버의 '사용률' 은 하나가 아니다. **최대값**을 쓴다 —
 * 평균을 쓰면 한 디스크가 100% 인 서버가 17% 로 보인다(병목은 최대에서 온다).
 * ⚠ 최대를 뽑을 때 **`null` 은 건너뛰고, 전부 `null` 이면 `null`** 이다(`rates.maxOrNull`).
 *   0 으로 채우면 '부하 없음' 이라는 거짓이 된다.
 *
 * ⚠⚠ **첫 주기는 CPU·디스크·네트워크·HBA 가 `null` 이다**(Linux 경로). 누적 카운터의 차이가
 *   필요하기 때문이고, 그것이 정상이다. 화면은 '첫 수집 — 다음 주기부터 값이 나옵니다' 라고
 *   말해야 한다(v2.517 규약: '기다리면 되는지' 를 말한다).
 *   Windows 경로는 `Win32_PerfFormattedData_*` 가 순간값이라 첫 주기부터 나온다 — 그 차이도 밝힌다.
 */
import { perSecond, cpuPctFromJiffies, busyPct, linkPct, maxOrNull, sumStrict } from './rates.js';
import { numOrNull } from '../util/numOrNull.js';

const n = numOrNull;   // v2.561: 공용 판정

/** 이전 표본에서 같은 이름의 항목을 찾는다(장치·인터페이스가 추가·제거될 수 있다). */
const findBy = (list, field, val) => (Array.isArray(list) ? list.find((x) => x[field] === val) : null) || null;
/** 이전 표본 시각 — OS·iDRAC 이 **같은 기준**을 쓴다(둘이 갈리면 span 이 그만큼 어긋난다 — v2.550.3). */
const pAtOf = (prev) => n(prev?.at);

/**
 * 한 서버의 한 주기.
 * @param {object} p
 * @param {object} p.target      `targets.resolveTargets()` 의 항목
 * @param {object|null} p.idrac  `redfish.fetchUsage()` 결과
 * @param {object|null} p.os     `osSsh.collectOsUsage()` 결과
 * @param {object|null} p.ent    `collectors/idracEnterprise.collectEnterpriseUsage()` 결과(v2.554)
 * @param {object|null} p.prev   이전 주기의 `{ at, counters }`(같은 서버)
 * @param {number} p.now
 */
export function buildUsage({ target = {}, idrac = null, os = null, ent = null, prev = null, now = Date.now() } = {}) {
  const srcOf = {};
  const notes = [];
  const out = {
    key: target.key, name: target.name, vcenterId: target.vcenterId || '', ts: now,
    cpu_pct: null, mem_pct: null, disk_busy_pct: null, disk_used_pct: null,
    net_pct: null, net_bps: null, hba_pct: null, hba_bps: null, io_pct: null,
  };

  // ── OS 경로 ────────────────────────────────────────────────────────────────
  const osOk = !!(os && os.ok);
  const winShape = osOk && os.osKind === 'windows';
  if (winShape) {
    if (n(os.cpuPct) != null) { out.cpu_pct = n(os.cpuPct); srcOf.cpu = 'os'; }
    if (n(os.mem?.usedPct) != null) { out.mem_pct = n(os.mem.usedPct); srcOf.mem = 'os'; }
    const busy = maxOrNull((os.disks || []).map((d) => d.busyPct));
    if (busy != null) { out.disk_busy_pct = busy; srcOf.diskBusy = 'os'; }
    const used = maxOrNull((os.disks || []).map((d) => d.usedPct));
    if (used != null) { out.disk_used_pct = used; srcOf.diskUsed = 'os'; }
    const np = maxOrNull((os.nics || []).map((x) => x.pct));
    if (np != null) { out.net_pct = np; srcOf.net = 'os'; }
    const nb = maxOrNull((os.nics || []).map((x) => x.bytesPerSec));
    if (nb != null) out.net_bps = nb;
    const hp = maxOrNull((os.hbas || []).map((x) => x.pct));
    if (hp != null) { out.hba_pct = hp; srcOf.hba = 'os'; }
    // ⚠ Windows FC 처리량 카운터는 표준이 아니다 — 없으면 없다고 둔다(0 을 만들지 않는다).
    if ((os.hbas || []).length && hp == null) notes.push('Windows 에서 HBA 사용률 카운터를 읽지 못했습니다(드라이버가 제공하지 않을 수 있습니다).');
  } else if (osOk && os.osKind === 'linux') {
    const c = os.counters || {};
    const pc = prev?.counters || null;
    const pAt = n(prev?.at);
    // CPU — jiffies 누적의 차이.
    const cpu = cpuPctFromJiffies(pc?.cpu, c.cpu);
    if (cpu != null) { out.cpu_pct = cpu; srcOf.cpu = 'os'; }
    else if (pc == null) notes.push('첫 수집이라 CPU·디스크·네트워크·HBA 사용률은 다음 주기부터 나옵니다(누적 카운터의 차이가 필요합니다).');
    // 메모리 — 순간값이라 첫 주기부터 나온다.
    if (n(os.mem?.usedPct) != null) { out.mem_pct = n(os.mem.usedPct); srcOf.mem = 'os'; }
    // 디스크 busy — io_ticks 증가 / 경과.
    const busy = maxOrNull((c.disks || []).map((d) => busyPct(findBy(pc?.disks, 'name', d.name)?.ioTicksMs, d.ioTicksMs, pAt, now)));
    if (busy != null) { out.disk_busy_pct = busy; srcOf.diskBusy = 'os'; }
    // 디스크 사용 공간 — df(순간값).
    const used = maxOrNull((os.mounts || []).map((m) => m.usedPct));
    if (used != null) { out.disk_used_pct = used; srcOf.diskUsed = 'os'; }
    // 네트워크 — rx+tx 초당 바이트, 링크 속도를 아는 인터페이스만 퍼센트.
    const perIf = (c.nets || []).map((x) => {
      const p = findBy(pc?.nets, 'iface', x.iface);
      const rx = perSecond(p?.rxBytes, x.rxBytes, pAt, now);
      const tx = perSecond(p?.txBytes, x.txBytes, pAt, now);
      const bps = sumStrict([rx, tx]);
      return { iface: x.iface, bps, pct: linkPct(bps, x.bitsPerSec), state: x.state, bitsPerSec: x.bitsPerSec };
    });
    const np = maxOrNull(perIf.map((x) => x.pct));
    if (np != null) { out.net_pct = np; srcOf.net = 'os'; }
    const nb = maxOrNull(perIf.map((x) => x.bps));
    if (nb != null) out.net_bps = nb;
    if (perIf.some((x) => x.bps != null && x.bitsPerSec == null)) {
      notes.push('링크 속도를 읽지 못한 인터페이스가 있어 그 회선의 사용률(%)은 내지 않았습니다(처리량만).');
    }
    // HBA — tx/rx words(4바이트) 누적. 속도를 모르면 퍼센트 없음.
    const perFc = (c.hbas || []).map((x) => {
      const p = findBy(pc?.hbas, 'host', x.host);
      const rx = perSecond(p?.rxBytes, x.rxBytes, pAt, now);
      const tx = perSecond(p?.txBytes, x.txBytes, pAt, now);
      const bps = sumStrict([rx, tx]);
      return { host: x.host, bps, pct: linkPct(bps, x.bitsPerSec), state: x.state, speedRaw: x.speedRaw };
    });
    const hp = maxOrNull(perFc.map((x) => x.pct));
    if (hp != null) { out.hba_pct = hp; srcOf.hba = 'os'; }
    const hb = maxOrNull(perFc.map((x) => x.bps));
    if (hb != null) out.hba_bps = hb;
    // ⚠ 화면 상세용이고 **DB 에는 넣지 않는다** — 폴러가 적재 직전에 뗀다(v2.550.3).
    out._perIf = perIf; out._perFc = perFc;
  }

  // ── iDRAC 경로(빈 칸만 채운다) ─────────────────────────────────────────────
  let idracIf = null; let idracFc = null;
  if (idrac && idrac.ok) {
    if (out.cpu_pct == null && n(idrac.cpuPct) != null) { out.cpu_pct = n(idrac.cpuPct); srcOf.cpu = 'idrac'; }
    if (out.mem_pct == null && n(idrac.memPct) != null) { out.mem_pct = n(idrac.memPct); srcOf.mem = 'idrac'; }
    if (n(idrac.ioPct) != null) { out.io_pct = n(idrac.ioPct); srcOf.io = 'idrac'; }

    /*
     * ── 텔레메트리 전수 모드(v2.551) ─────────────────────────────────────────
     * iDRAC 의 NIC·FC 통계는 **부팅 이후 누적 바이트**라 OS 경로와 똑같이 두 주기의 차이가
     * 필요하다 — 환산은 `rates.js` 하나가 한다(코어는 하나다).
     * ⚠ **OS 값이 있으면 덮지 않는다**: 커널이 세는 값이 더 정확하고, 같은 서버에서 두 값이
     *   다를 수 있으므로 `srcOf` 로 어느 쪽을 썼는지 밝힌다.
     * ⚠ 첫 주기는 `null` 이다(누적 차이가 없다) — 0 으로 채우지 않는다.
     */
    const pIdrac = prev?.idrac || null;
    if ((idrac.nics || []).length) {
      idracIf = idrac.nics.map((x) => {
        const p = findBy(pIdrac?.nics, 'iface', x.iface);
        const rx = perSecond(p?.rxBytes, x.rxBytes, pAtOf(prev), now);
        const tx = perSecond(p?.txBytes, x.txBytes, pAtOf(prev), now);
        const bps = sumStrict([rx, tx]);
        return { iface: x.iface, bps, pct: linkPct(bps, x.bitsPerSec), bitsPerSec: x.bitsPerSec, src: 'idrac' };
      });
      const np = maxOrNull(idracIf.map((x) => x.pct));
      if (out.net_pct == null && np != null) { out.net_pct = np; srcOf.net = 'idrac'; }
      const nb = maxOrNull(idracIf.map((x) => x.bps));
      if (out.net_bps == null && nb != null) out.net_bps = nb;
    }
    if ((idrac.fcs || []).length) {
      idracFc = idrac.fcs.map((x) => {
        const p = findBy(pIdrac?.fcs, 'host', x.host);
        const rx = perSecond(p?.rxBytes, x.rxBytes, pAtOf(prev), now);
        const tx = perSecond(p?.txBytes, x.txBytes, pAtOf(prev), now);
        const bps = sumStrict([rx, tx]);
        return { host: x.host, bps, pct: linkPct(bps, x.bitsPerSec), bitsPerSec: x.bitsPerSec, src: 'idrac' };
      });
      const hp = maxOrNull(idracFc.map((x) => x.pct));
      if (out.hba_pct == null && hp != null) { out.hba_pct = hp; srcOf.hba = 'idrac'; }
      const hb = maxOrNull(idracFc.map((x) => x.bps));
      if (out.hba_bps == null && hb != null) out.hba_bps = hb;
    }
    // 디스크 — iDRAC 텔레메트리에 busy% 에 해당하는 값이 **사실상 없다**(파서가 `absent` 로 밝힌다).
    //   용량 계열이 읽히면 사용 공간만 채운다.
    const du = maxOrNull((idrac.disks || []).map((d) => d.usedPct));
    if (out.disk_used_pct == null && du != null) { out.disk_used_pct = du; srcOf.diskUsed = 'idrac'; }
  }

  /*
   * ── Enterprise 대체 경로(v2.554) — **빈 칸만** 채운다 ─────────────────────────
   * 사용자 신고: 텔레메트리(Datacenter 전용)가 없는 Enterprise 서버에서 CPU·메모리가 영원히 `—`.
   * ⚠ **OS·텔레메트리 값을 덮지 않는다** — 셋의 측정 방식이 달라 같은 서버에서 값이 다를 수 있다.
   *   어느 쪽을 썼는지 `srcOf`(`idrac-ent`)로 밝힌다. 조용히 고르면 두 화면의 숫자가 다른 이유를
   *   사용자가 알 수 없다(v2.550 `srcOf` 규약의 확장).
   * ⚠ **전력·온도를 사용률로 환산하지 않는다**(사용자 지시 "수집하지 않는다") — 여기서
   *   `watts`·`celsius` 로 무엇을 만들려 하지 말 것.
   * ⚠ `io_pct` 는 iDRAC 계열 값이므로 텔레메트리가 못 읽었을 때만 채운다.
   */
  if (ent && ent.ok) {
    if (out.cpu_pct == null && n(ent.cpuPct) != null) { out.cpu_pct = n(ent.cpuPct); srcOf.cpu = 'idrac-ent'; }
    if (out.mem_pct == null && n(ent.memPct) != null) { out.mem_pct = n(ent.memPct); srcOf.mem = 'idrac-ent'; }
    if (out.io_pct == null && n(ent.ioPct) != null) { out.io_pct = n(ent.ioPct); srcOf.io = 'idrac-ent'; }
  }

  const srcs = [...new Set(Object.values(srcOf))].sort();
  out.src = srcs.join('+');
  return {
    row: out, srcOf, notes,
    // 화면 상세용 — DB 에는 넣지 않는다(장치 수 × 주기면 행이 폭주한다).
    detail: {
      osKind: osOk ? os.osKind : null,
      osRead: osOk ? (os.read || []) : [], osMissing: osOk ? (os.missing || []) : [], osAbsent: osOk ? (os.absent || []) : [],
      osError: os && !os.ok ? (os.error || '') : '',
      idracKind: idrac && !idrac.ok ? (idrac.kind || '') : '',
      idracError: idrac && !idrac.ok ? (idrac.error || '') : '',
      idracUsedIds: idrac?.usedIds || null, idracSeenIds: idrac?.seenIds || null,
      mounts: osOk ? (os.mounts || []) : [], mountsMissing: osOk ? (os.mountsMissing || []) : [],
      interfaces: out._perIf || (osOk && winShape ? (os.nics || []) : []) ,
      fc: out._perFc || (osOk && winShape ? (os.hbas || []) : []),
      // iDRAC 이 읽은 장치 목록 — OS 목록과 **나란히** 둔다(어느 경로의 값인지 알 수 있게).
      idracInterfaces: idracIf || [], idracFc: idracFc || [],
      idracReports: idrac?.usedReports || [], idracSeenReports: idrac?.seenReports || [],
      idracAbsent: idrac?.absent || [], idracRead: idrac?.read || [],
      idracFull: !!idrac?.full, idracFullTried: !!idrac?.fullTried,
      memDetail: osOk ? (os.mem || null) : null,
      /*
       * Enterprise 대체 경로 상세(v2.554). ⚠ `entRaw` 는 racadm **원문**이다 — 파싱이 빗나가도
       * 사용자가 실제 출력을 보고 알려줄 수 있어야 한다(v2.542 `cliRaw` 규약). 비밀번호는
       * 명령줄에 싣지 않으므로 원문에 없다.
       */
      license: target.license || null,
      entTried: ent ? (ent.tried || []) : [],
      entVia: ent?.via || '',
      entKind: ent && !ent.ok ? (ent.kind || '') : '',
      entError: ent && !ent.ok ? (ent.error || '') : '',
      entUsedPaths: ent?.usedPaths || null,
      entUsedCmd: ent?.usedCmd || '',
      entUsedStat: ent?.usedStat || null,
      entSeenSensors: ent?.seenSensors || [],
      entSkipped: ent?.skipped || [],
      entSshTried: ent?.sshTried || [],
      entRaw: ent?.raw || '',
      entMs: ent?.ms ?? null,
      firstSample: !!(osOk && os.osKind === 'linux' && !prev),
    },
    /*
     * 다음 주기용 — 누적값만 들고 간다(비밀·원문은 담지 않는다).
     * ⚠ **iDRAC 카운터도 담아야 한다**(v2.551): 안 담으면 iDRAC 경로가 매 주기 '첫 표본' 이 되어
     *   네트워크·HBA 가 영원히 `null` 이다. Windows 는 OS 누적값이 필요 없지만(순간값) iDRAC
     *   카운터는 OS 종류와 무관하게 필요하므로 **`next` 를 OS 조건에 묶지 않는다**.
     */
    next: (() => {
      const osCounters = osOk && os.osKind === 'linux' ? os.counters : null;
      const idracCounters = (idrac && idrac.ok && ((idrac.nics || []).length || (idrac.fcs || []).length))
        ? { nics: idrac.nics || [], fcs: idrac.fcs || [] } : null;
      if (!osCounters && !idracCounters) return null;
      return { at: now, counters: osCounters, idrac: idracCounters };
    })(),
  };
}
