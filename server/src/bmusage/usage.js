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
import { perSecond, cpuPctFromJiffies, busyPct, linkPct, maxOrNull, sumStrict, maxStrict, spanOk, spanLimitMs } from './rates.js';
import { numOrNull } from '../util/numOrNull.js';
import { fcUtilization, fcRateNotes, fcRowPctFields, fcRepresentative, fcPlausibleBps } from './parse/fcRate.js';

const n = numOrNull;   // v2.561: 공용 판정

/** 이전 표본에서 같은 이름의 항목을 찾는다(장치·인터페이스가 추가·제거될 수 있다). */
const findBy = (list, field, val) => (Array.isArray(list) ? list.find((x) => x[field] === val) : null) || null;
/** 이전 표본 시각 — OS·iDRAC 이 **같은 기준**을 쓴다(둘이 갈리면 span 이 그만큼 어긋난다 — v2.550.3). */
const pAtOf = (prev) => n(prev?.at);

/**
 * v2.732(B1-01): 간격을 사람이 읽는 글자로 — **한계보다 길다는 사실과 모순되지 않게** 쓴다.
 *   예전 `Math.round(분)` 은 60.2분 간격을 '60분 전이라(60분 초과)' 로 써서 문장이 스스로 모순됐다. 분 단위로 반올림한 값이
 *   한계(분, 내림) 이하가 되면 초까지(올림) 적는다 — 적은 값은 언제나 한계보다 크다.
 */
function gapText(gapMs, limMs) {
  const limMin = Math.floor(limMs / 60_000);
  const r = Math.round(gapMs / 60_000);
  if (r > limMin) return `${r}분`;
  const totalSec = Math.ceil(gapMs / 1000);
  const m = Math.floor(totalSec / 60); const sec = totalSec % 60;
  return sec ? `${m}분 ${sec}초` : `${m}분`;
}

/**
 * 한 서버의 한 주기.
 * @param {object} p
 * @param {object} p.target      `targets.resolveTargets()` 의 항목
 * @param {object|null} p.idrac  `redfish.fetchUsage()` 결과
 * @param {object|null} p.os     `osSsh.collectOsUsage()` 결과
 * @param {object|null} p.ent    `collectors/idracEnterprise.collectEnterpriseUsage()` 결과(v2.554)
 * @param {object|null} p.prev   이전 주기의 `{ at, counters }`(같은 서버)
 * @param {number} p.now
 * @param {number|null} [p.intervalMs] 설정 수집 주기 — 누적 카운터 간격 한계(v2.732 B1-01 `rates.spanLimitMs`). 넘기지 않으면 예전 60분.
 * @param {number} [p.slackMs]   간격 한계에 더할 여유(직전 주기 실행 소요 + 이번 주기에서 이 서버가 읽히기까지 — poller.spanArgsFor)
 */
export function buildUsage({ target = {}, idrac = null, os = null, ent = null, prev = null, now = Date.now(), intervalMs = null, slackMs = 0 } = {}) {
  const srcOf = {};
  const notes = [];
  /*
   * v2.744(최종 검토 RV-1): 서버 HBA 대표값(값 또는 '크게 초과로 비움' hba_over)을 **실제로 정한 경로** — 'os' | 'idrac' | null(아무도 못 정함).
   *   srcOf.hba 는 값이 있을 때만 세워지므로(row.src 계약 — 바꾸지 않는다) hba_over 를 세운 경로는 이것으로만 알 수 있다.
   *   노트(OS FC 노트의 대체 문구)와 각주 근거(hbaBasis.recordHbaBasis — 어느 경로의 포트를 셀지)가 이 값을 쓴다. DB 에는 넣지 않는다.
   */
  let hbaRepSrc = null;
  // v2.744(RV-1): OS FC 노트는 iDRAC 경로가 빈 대표값을 채운 **뒤에** 만든다(그 전에 만들면 '대표값은 비웠다' 는 거짓이 된다) — 자리만 잡아 둔다.
  let osFcRows = null; let osFcNotesAt = -1;
  /*
   * v2.732(감사 B1-01): 누적 카운터 간격 한계를 **한 번** 계산해 CPU·디스크 I/O·네트워크·HBA·iDRAC NIC/FC 가 **전부 같은 값**을 쓴다
   *   (v2.731 A2-04 '한 행 안에서 같은 경계' 원칙). 예전 60분 고정은 주기 60분 이상(설정 상한 6시간)에서 매 주기 값을 비웠다.
   */
  const lim = spanLimitMs(intervalMs, slackMs);
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
    if (n(os.busyOutOfRange) > 0) notes.push(`디스크 ${os.busyOutOfRange}개의 I/O 사용률이 0~100 범위를 벗어나 비웠습니다(보정하지 않았습니다).`);
    // v2.612 COL2612-01: 100% 를 넘는 NIC 사용률은 링크 속도 보고가 틀린 것이다 — 100 으로 자르지 않고 비운 사실을 말한다.
    if (n(os.nicPctOutOfRange) > 0) notes.push(`NIC ${os.nicPctOutOfRange}개의 사용률이 100% 를 넘어(링크 속도 보고가 실제와 다를 수 있습니다) 비웠습니다(처리량은 그대로입니다).`);
    const used = maxOrNull((os.disks || []).map((d) => d.usedPct));
    if (used != null) { out.disk_used_pct = used; srcOf.diskUsed = 'os'; }
    const np = maxOrNull((os.nics || []).map((x) => x.pct));
    if (np != null) { out.net_pct = np; srcOf.net = 'os'; }
    const nb = maxOrNull((os.nics || []).map((x) => x.bytesPerSec));
    if (nb != null) out.net_bps = nb;
    const hp = maxOrNull((os.hbas || []).map((x) => x.pct));
    if (hp != null) { out.hba_pct = hp; srcOf.hba = 'os'; hbaRepSrc = 'os'; }
    // ⚠ Windows FC 처리량 카운터는 표준이 아니다 — 없으면 없다고 둔다(0 을 만들지 않는다).
    if ((os.hbas || []).length && hp == null) notes.push('Windows 에서 HBA 사용률 카운터를 읽지 못했습니다(드라이버가 제공하지 않을 수 있습니다).');
  } else if (osOk && os.osKind === 'linux') {
    const c = os.counters || {};
    const pc = prev?.counters || null;
    const pAt = n(prev?.at);
    // CPU — jiffies 누적의 차이. v2.731 A2-04: 표본 간격도 넘긴다(디스크·네트워크와 같은 경계 — 긴 공백의 평균을 이번 주기 값으로 쓰지 않는다).
    const cpu = cpuPctFromJiffies(pc?.cpu, c.cpu, pAt, now, lim);
    if (cpu != null) { out.cpu_pct = cpu; srcOf.cpu = 'os'; }
    else if (pc == null) notes.push('첫 수집이라 CPU·디스크·네트워크·HBA 사용률은 다음 주기부터 나옵니다(누적 카운터의 차이가 필요합니다).');
    if (pc != null && !spanOk(pAt, now, lim)) {
      // 조용히 비우지 않는다 — 왜 이번 주기 누적 카운터 값이 없는지 말한다(다음 주기부터 이 표본이 새 기준이다).
      // v2.732(B1-01): 한계는 주기에 비례하므로(주기 × 3 + 여유) 다음 주기 간격은 한계 안이다 — '다음 주기부터' 가 참이 된다.
      const gapMs = pAt != null ? now - pAt : null;
      const basis = n(intervalMs) != null && n(intervalMs) > 0 ? ' — 수집 주기의 3배 + 수집 소요, 최소 60분' : '';
      notes.push(gapMs != null && gapMs > lim
        ? `직전 표본이 ${gapText(gapMs, lim)} 전이라 허용 간격(${Math.floor(lim / 60_000)}분${basis})을 넘어 OS 누적 카운터 사용률(CPU·디스크 I/O·네트워크·HBA)은 이번 주기 비웠습니다(긴 공백의 평균을 지금 값으로 쓰지 않습니다 — 다음 주기부터 나옵니다).`
        : '직전 표본과의 간격이 비정상이라(시각 없음·역행·너무 짧음) OS 누적 카운터 사용률(CPU·디스크 I/O·네트워크·HBA)은 이번 주기 비웠습니다(다음 주기부터 나옵니다).');
    }
    // 메모리 — 순간값이라 첫 주기부터 나온다.
    if (n(os.mem?.usedPct) != null) { out.mem_pct = n(os.mem.usedPct); srcOf.mem = 'os'; }
    // 디스크 busy — io_ticks 증가 / 경과.
    const busy = maxOrNull((c.disks || []).map((d) => busyPct(findBy(pc?.disks, 'name', d.name)?.ioTicksMs, d.ioTicksMs, pAt, now, lim)));
    if (busy != null) { out.disk_busy_pct = busy; srcOf.diskBusy = 'os'; }
    // 디스크 사용 공간 — df(순간값).
    const used = maxOrNull((os.mounts || []).map((m) => m.usedPct));
    if (used != null) { out.disk_used_pct = used; srcOf.diskUsed = 'os'; }
    // 네트워크 — rx+tx 초당 바이트, 링크 속도를 아는 인터페이스만 퍼센트.
    const perIf = (c.nets || []).map((x) => {
      const p = findBy(pc?.nets, 'iface', x.iface);
      const rx = perSecond(p?.rxBytes, x.rxBytes, pAt, now, lim);
      const tx = perSecond(p?.txBytes, x.txBytes, pAt, now, lim);
      const bps = sumStrict([rx, tx]);
      return { iface: x.iface, bps, pct: x.virtual ? null : linkPct(maxStrict([rx, tx]), x.bitsPerSec), state: x.state, bitsPerSec: x.virtual ? null : x.bitsPerSec, ...(x.virtual ? { virtual: true } : {}) };
    });
    const np = maxOrNull(perIf.map((x) => x.pct));
    if (np != null) { out.net_pct = np; srcOf.net = 'os'; }
    const nb = maxOrNull(perIf.map((x) => x.bps));
    if (nb != null) out.net_bps = nb;
    // v2.605(COL2605-01): 가상 인터페이스는 '속도를 못 읽은 것' 이 아니라 **판정 대상이 아닌 것**이다 — 따로 센다.
    const virtualIf = perIf.filter((x) => x.virtual).length;
    if (virtualIf) notes.push(`가상 인터페이스(tun/tap·bridge·veth 등) ${virtualIf}개는 보고 속도가 링크 속도가 아니라 사용률(%)에서 뺐습니다(처리량에는 포함).`);
    if (perIf.some((x) => !x.virtual && x.bps != null && x.bitsPerSec == null)) {
      notes.push('링크 속도를 읽지 못한 인터페이스가 있어 그 회선의 사용률(%)은 내지 않았습니다(처리량만).');
    }
    // HBA — tx/rx words(4바이트) 누적. 속도를 모르면 퍼센트 없음.
    // v2.743(감사 DEV-03): 분모는 명목 Gbit 가 아니라 **FC 표준 데이터율**(16GFC 1,600MB/s 등 — parse/fcRate.js)이다.
    //   명목으로 나누면 포화한 포트가 80% 에서 멈춰 기본 임계 90% 알림이 울리지 않았다. 표에 없는 속도는 명목 + 사유 표지.
    /*
     * v2.744(감사 DEV-01): ① 통계를 못 읽은 포트(-1 표지 — parseFcHosts 가 null + countersInvalid)는 처리량을 비운다(전후 어느 쪽이든).
     *   ② 한 방향 처리량이 회선의 **물리 상한**(fcRateCapBps — 데이터율 × 2, 속도 미상 1e12 B/s)을 넘으면 카운터 이상이다 — 값으로
     *   두면 491 PB/s 같은 수치가 원시 표본과 5년 일 롤업 최대(hba_bps_max)에 남는다. 비우고 사유를 센다(조용히 버리지 않는다).
     */
    let fcImplausible = 0;
    // v2.744(회귀 검토 GB-R2): 상한은 직전 표본 속도도 함께 본다(주기 중 재협상 — 큰 쪽) · 1 Gbit 미만 속도는 상한 근거가 아니다(fcRateCapBps).
    const fcCap = (v, bits, prevBits) => { const ok = fcPlausibleBps(v, bits, prevBits); if (v != null && ok == null) fcImplausible += 1; return ok; };
    const perFc = (c.hbas || []).map((x) => {
      const p = findBy(pc?.hbas, 'host', x.host);
      const rx = fcCap(perSecond(p?.rxBytes, x.rxBytes, pAt, now, lim), x.bitsPerSec, p?.bitsPerSec);
      const tx = fcCap(perSecond(p?.txBytes, x.txBytes, pAt, now, lim), x.bitsPerSec, p?.bitsPerSec);
      const bps = sumStrict([rx, tx]);
      const u = fcUtilization(maxStrict([rx, tx]), x.bitsPerSec);
      return { host: x.host, bps, ...fcRowPctFields(u), state: x.state, speedRaw: x.speedRaw, ...(x.countersInvalid ? { countersInvalid: true } : {}) };
    });
    // v2.744(감사 RECENT-02): 대표값은 fcRepresentative 하나 — 크게 넘어 비운 포트가 있으면 다른 포트 값으로 채우지 않는다.
    const rep = fcRepresentative(perFc);
    if (rep.pct != null) { out.hba_pct = rep.pct; srcOf.hba = 'os'; hbaRepSrc = 'os'; }
    if (rep.overBlank) { out.hba_over = true; hbaRepSrc = 'os'; }   // ⚠ DB 열이 아니다(insertUsage 는 열 목록만 읽는다) — 알림 판정(alertRules overFlag)용
    const hb = maxOrNull(perFc.map((x) => x.bps));
    if (hb != null) out.hba_bps = hb;
    // v2.744(최종 검토 RV-1): 노트는 아래 iDRAC 경로 뒤에 이 자리에 끼워 넣는다(순서는 예전 그대로).
    osFcRows = perFc; osFcNotesAt = notes.length;
    const fcUnread = (c.hbas || []).filter((x) => x && x.countersInvalid).length;
    if (fcUnread) notes.push(`FC HBA ${fcUnread}개는 통계 카운터를 읽지 못했습니다(드라이버가 '-1' 표지를 냈습니다 — 링크 다운·칩 재설정 중일 수 있습니다). 그 포트의 처리량·사용률은 비웠습니다(0 이 아닙니다).`);
    // 표지 → 정상 주기: 이번 값은 읽었지만 비교할 직전 값이 없다 — 조용히 비우지 않고 '다음 주기부터' 라고 말한다.
    const fcPrevUnread = (c.hbas || []).filter((x) => x && !x.countersInvalid && findBy(pc?.hbas, 'host', x.host)?.countersInvalid).length;
    if (fcPrevUnread) notes.push(`FC HBA ${fcPrevUnread}개는 직전 주기에 통계 카운터를 읽지 못해('-1' 표지) 이번 주기 처리량·사용률은 비웠습니다(다음 주기부터 나옵니다).`);
    if (fcImplausible) notes.push(`FC HBA 처리량 ${fcImplausible}건이 회선의 물리 상한을 넘어(카운터 이상) 비웠습니다 — 처리량·사용률로 저장하지 않았습니다.`);
    // ⚠ 화면 상세용이고 **DB 에는 넣지 않는다** — 폴러가 적재 직전에 뗀다(v2.550.3).
    out._perIf = perIf; out._perFc = perFc;
  }

  // ── iDRAC 경로(빈 칸만 채운다) ─────────────────────────────────────────────
  let idracIf = null; let idracFc = null;
  let idracRep = null;   // v2.744(RV-1): iDRAC 행이 빈 대표값을 정했으면 그 fcRepresentative 결과(OS 노트의 대체 문구가 쓴다)
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
    /*
     * v2.598(감사 IDRAC-2598-03): 누적 카운터의 **분모는 리포트 표본 시각(`at`)의 차이**다. 폴러 시계(prev.at→now)로
     *   나누면, iDRAC 이 리포트를 아직 갱신하지 않아 **같은 카운터를 두 번 읽은 주기**가 0 B/s·0% 가 된다 —
     *   '트래픽 없음' 이라는 거짓이다. 이번 표본 시각이 이전과 같거나 이르면 그 장치는 **판정 보류(null)** 다.
     *   ⚠ 표본 시각이 없는 구버전 이전 상태·리포트는 예전처럼 폴러 시계를 쓴다(그때는 갱신 여부를 알 수 없다).
     */
    let idracStale = 0;
    const idracSpan = (p, x) => {
      const pa = n(p?.at); const ca = n(x?.at);
      if (pa != null && ca != null) {
        if (ca <= pa) { idracStale += 1; return null; }
        return [pa, ca];
      }
      return [pAtOf(prev), now];
    };
    const idracRow = (p, x) => {
      const sp = idracSpan(p, x);
      const rx = sp ? perSecond(p?.rxBytes, x.rxBytes, sp[0], sp[1], lim) : null;
      const tx = sp ? perSecond(p?.txBytes, x.txBytes, sp[0], sp[1], lim) : null;
      return { rx, tx };
    };
    if ((idrac.nics || []).length) {
      idracIf = idrac.nics.map((x) => {
        const p = findBy(pIdrac?.nics, 'iface', x.iface);
        const { rx, tx } = idracRow(p, x);
        const bps = sumStrict([rx, tx]);
        return { iface: x.iface, bps, pct: linkPct(maxStrict([rx, tx]), x.bitsPerSec), bitsPerSec: x.bitsPerSec, src: 'idrac' };
      });
      const np = maxOrNull(idracIf.map((x) => x.pct));
      if (out.net_pct == null && np != null) { out.net_pct = np; srcOf.net = 'idrac'; }
      const nb = maxOrNull(idracIf.map((x) => x.bps));
      if (out.net_bps == null && nb != null) out.net_bps = nb;
    }
    if ((idrac.fcs || []).length) {
      let idracImplausible = 0;
      const capI = (v, bits, prevBits) => { const ok = fcPlausibleBps(v, bits, prevBits); if (v != null && ok == null) idracImplausible += 1; return ok; };
      idracFc = idrac.fcs.map((x) => {
        const p = findBy(pIdrac?.fcs, 'host', x.host);
        const r0 = idracRow(p, x);
        // v2.744(DEV-01): OS 경로와 같은 물리 상한 — 카운터 이상을 처리량으로 두지 않는다(GB-R2: 직전 속도 함께 · 1 Gbit 미만 속도는 근거 아님).
        const rx = capI(r0.rx, x.bitsPerSec, p?.bitsPerSec); const tx = capI(r0.tx, x.bitsPerSec, p?.bitsPerSec);
        const bps = sumStrict([rx, tx]);
        // v2.743(DEV-03): OS 경로와 같은 분모(FC 표준 데이터율) — 판정은 parse/fcRate.js 하나.
        const u = fcUtilization(maxStrict([rx, tx]), x.bitsPerSec);
        return { host: x.host, bps, ...fcRowPctFields(u), bitsPerSec: x.bitsPerSec, src: 'idrac' };
      });
      // v2.744(RECENT-02): 대표값 판정은 OS 경로와 같은 fcRepresentative. OS 가 이미 '크게 초과로 비움'(hba_over)을 냈으면
      //   iDRAC 값으로 채우지 않는다(같은 HBA 의 다른 측정으로 가장 바쁜 포트를 덮지 않게 — 빈 칸만 채우는 규칙의 예외가 아니라 그 연장이다).
      const repI = fcRepresentative(idracFc);
      // v2.744(회귀 검토 GB-R4): iDRAC 행이 대표값을 정할 수 있었는가 — OS 가 이미 정했으면(값 또는 '크게 초과로 비움') 노트가 그렇게 말한다.
      const idracForRep = out.hba_pct == null && !out.hba_over;
      if (idracForRep) {
        if (repI.pct != null) { out.hba_pct = repI.pct; srcOf.hba = 'idrac'; }
        else if (repI.overBlank) out.hba_over = true;
        if (repI.pct != null || repI.overBlank) { hbaRepSrc = 'idrac'; idracRep = repI; }
      }
      const hb = maxOrNull(idracFc.map((x) => x.bps));
      if (out.hba_bps == null && hb != null) out.hba_bps = hb;
      for (const t of fcRateNotes(idracFc, 'iDRAC ', { usedForRep: idracForRep })) notes.push(t);
      if (idracImplausible) notes.push(`iDRAC FC 처리량 ${idracImplausible}건이 회선의 물리 상한을 넘어(카운터 이상) 비웠습니다.`);
    }
    if (idracStale) {
      notes.push(`iDRAC 텔레메트리 리포트가 이전 주기 이후 갱신되지 않은 장치 ${idracStale}개는 네트워크·HBA 사용률을 판정하지 않았습니다(같은 값을 두 번 읽어 0 으로 보이지 않게).`);
    }
    // 디스크 — iDRAC 텔레메트리에 busy% 에 해당하는 값이 **사실상 없다**(파서가 `absent` 로 밝힌다).
    //   용량 계열이 읽히면 사용 공간만 채운다.
    const du = maxOrNull((idrac.disks || []).map((d) => d.usedPct));
    if (out.disk_used_pct == null && du != null) { out.disk_used_pct = du; srcOf.diskUsed = 'idrac'; }
  }

  // v2.744(최종 검토 RV-1): OS FC 노트 — iDRAC 이 빈 대표값을 정했으면 그 결과를 넘긴다(노트가 최종 hba_pct·hba_over 와 같은 말을 하게).
  if (osFcRows) {
    const fallback = idracRep ? { label: 'iDRAC', pct: idracRep.pct, overBlank: idracRep.overBlank } : null;
    notes.splice(osFcNotesAt, 0, ...fcRateNotes(osFcRows, '', { fallback }));
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
      // v2.744(최종 검토 RV-1): 서버 HBA 대표값을 정한 경로('os'|'idrac'|null) — 각주 근거가 그 경로의 포트를 센다(hbaBasis.recordHbaBasis).
      hbaRepSrc,
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
