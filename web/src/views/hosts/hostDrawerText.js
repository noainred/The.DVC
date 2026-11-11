/**
 * views/hosts/hostDrawerText.js — ESXi 호스트 드로어(v2.975 · 시안 docs/design/host-drawer)의 글자 · 배치(순수 — vitest 고정).
 *
 * 판정을 새로 하지 않는다:
 *   · 사유(점검 · 끊김 · CPU 초과 · 업링크 · 인증서 · 경로 · 재부팅 · 부품 · 백업)는 hostChecksText.reasonBadges 그대로 — 호스트 표 · 전체 페이지 머리와 같은 목록.
 *   · 구성·보안 사실 줄은 hostcfg/hostCfgText.findingDetail · 고치는 법은 HOST_CFG_TEXT.
 *   · iDRAC 부품 · 재부팅 · Veeam 은 서버 /hosts/checks 의 호스트별 한 줄(byId[id])을 글자로만 바꾼다.
 * 못 읽은 값은 0 이 아니다 — null 은 '—' 이고 단위를 붙이지 않는다. 묶음을 못 받았으면 '이상 없음' 으로 세지 않고 따로 말한다(checksGap).
 * 임계값 숫자는 hostTriage.CPU_ATTENTION_PCT 에서 — 문장에 박지 않는다.
 */
import { numOrNull } from '../../numOrNull.js';
import { hostUsagePct } from '../vcdOverview.js';
import { CPU_ATTENTION_PCT } from '../hostTriage.js';
import { reasonBadges, CHECK_CHIPS, HW_TEXT, uptimeDays, nicLinkDownOf, deadPathsOf, lunsOf, ratioText } from '../hostChecksText.js';
import { HOST_CFG_TEXT, findingDetail, REBOOT_KIND } from '../hostcfg/hostCfgText.js';

const DOWN = new Set(['DISCONNECTED', 'NOT_RESPONDING']);
/** 끊김 · 무응답 — 사용률 · 추이 · 구성 판정을 그리지 않는 상태. */
export const hostDown = (h) => DOWN.has(h?.connectionState);

/** 머리 점 — [색, 이름]. 모르는 상태는 색을 올리지 않는다. */
export function hostDot(h) {
  const s = h?.connectionState;
  if (s === 'CONNECTED') return ['var(--green)', '연결됨'];
  if (s === 'MAINTENANCE') return ['var(--amber)', '점검 모드'];
  if (s === 'DISCONNECTED') return ['var(--red)', '끊김'];
  if (s === 'NOT_RESPONDING') return ['var(--red)', '무응답'];
  return ['var(--text-faint)', s || '상태 모름'];
}

const fmt = (v) => { const n = numOrNull(v); return n == null ? '—' : n.toLocaleString('en-US'); };
const pad2 = (n) => String(n).padStart(2, '0');
/** 'MM-DD HH:mm'(브라우저 시간대) — 못 읽으면 ''. */
export function shortTime(ts) {
  const n = numOrNull(ts);
  if (n == null || n <= 0) return '';
  const d = new Date(n);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
const ghz = (mhz) => { const n = numOrNull(mhz); return n == null || n < 0 ? null : (Math.round(n / 100) / 10).toFixed(1); };
const gbNum = (mb) => { const n = numOrNull(mb); return n == null || n <= 0 ? null : Math.round(n / 1024).toLocaleString('en-US'); };

/** 사유 kind → 개체 보기 탭(바로가기). 없으면 null. */
const TAB_OF = Object.freeze({
  cpu: ['monitor', '성능'], uplink: ['network', '네트워크'], 'mp-dead': ['configure', '구성'], 'cert-expired': ['configure', '구성'], 'cert-expiring': ['configure', '구성'],
  'reboot-required': ['configure', '구성'], 'ssh-running': ['configure', '구성'], 'logs-lost': ['configure', '구성'], unexpected: ['monitor', '이벤트'], 'veeam-n': ['vms', 'VM'],
});
const CHIP_BY_KIND = new Map(CHECK_CHIPS.map((c) => [c.kind, c]));

/**
 * 신호 줄 — reasonBadges 의 순서 · 구성 그대로, 줄마다 사실(fact) · 설명(desc) · 바로가기(tab)를 붙인다.
 * @param host  /hosts 한 행
 * @param {{ sec?:object|null, checks?:object|null }} o  sec = secCountsOf(host) · checks = /hosts/checks 의 byId
 * @returns {{kind,badge,label,tone:'crit'|'warn',fact,desc,tab:[string,string]|null}[]}  badge = 호스트 표와 같은 짧은 글자 · label = 줄 제목
 */
export function hostSignalRows(host, { sec = null, checks = null } = {}) {
  const c = checks?.[host?.id] || null;
  return reasonBadges(host, { sec, checks }).map((b) => {
    const row = { kind: b.kind, badge: b.label, label: b.label, tone: b.tone === 'amber' ? 'warn' : 'crit', fact: '', desc: '', tab: TAB_OF[b.kind] || null };
    if (b.kind === 'maint') {
      row.label = '점검(Maintenance) 모드';
      row.desc = '유지보수 상태 호스트 — 호스트 목록의 ‘점검 모드’ 카드와 같은 판정입니다.';
    } else if (b.kind === 'down') {
      row.desc = 'vCenter 가 이 호스트의 사용률을 읽지 못했습니다 — 값은 0 이 아니라 ‘—’ 로 둡니다.';
    } else if (b.kind === 'cpu') {
      row.label = `CPU ${CPU_ATTENTION_PCT}% 초과`;
      const u = numOrNull(host?.cpuUsageMhz); const t = numOrNull(host?.cpuTotalMhz);
      row.fact = `${b.label}${u != null && t != null ? ` · ${fmt(u)} / ${fmt(t)} MHz` : ''}`;
      row.desc = '서버 경보와 같은 임계값입니다 — 호스트 목록의 CPU 초과 카드와 같은 판정.';
    } else if (b.kind === 'unexpected') {
      row.fact = shortTime(c?.boot?.bootTime) ? `부팅 ${shortTime(c.boot.bootTime)}` : '';
      row.desc = REBOOT_KIND.unexpected.note;
    } else if (b.kind === 'hw') {
      const [t] = HW_TEXT[c?.hw?.state] || ['—'];
      const bad = numOrNull(c?.hw?.bad);
      row.fact = `iDRAC ${t}${bad != null && bad > 0 ? ` ${bad}` : ''}${c?.hw?.health ? ` · 시스템 상태 ${c.hw.health}` : ''}`;
      row.desc = '부품 상태는 파트 장애 화면과 같은 판정입니다.';
    } else if (b.kind === 'veeam-n') {
      const v = c?.veeam;
      row.fact = v ? `VM ${fmt(v.total)}대 중 ${fmt(v.n)}대 · 있음 ${fmt(v.y)}${v.unknown ? ` · 확인 불가 ${fmt(v.unknown)}` : ''}` : '';
      row.desc = '어제부터 지금까지 Veeam 백업이 끝나지 않은 VM 입니다(템플릿 제외).';
    } else {
      const code = CHIP_BY_KIND.get(b.kind)?.code;
      const f = code ? sec?.findings?.find((x) => x.code === code) : null;
      row.fact = f ? findingDetail(f) : '';
      row.desc = (code && HOST_CFG_TEXT[code]?.fix) || '';
    }
    return row;
  });
}

/**
 * 점검 묶음(/hosts/checks)에서 **받지 못한 것** — '이상 없음' 과 구분해 말한다. 다 받았으면 [].
 * @param st  { loading } | { error } | { byId } — 드로어가 가진 점검 상태
 */
export function checksGap(st, hostId) {
  if (!st || st.loading) return [];
  if (st.error) return ['iDRAC 부품 상태', '재부팅 판정', 'Veeam 대조'];
  const c = st.byId?.[hostId];
  if (!c) return ['iDRAC 부품 상태', '재부팅 판정', 'Veeam 대조'];
  const out = [];
  if (!('hw' in c)) out.push('iDRAC 부품 상태(관리자 판본)');
  if (!('boot' in c)) out.push('재부팅 판정(구성 점검 도구 권한)');
  if (!c.veeam) out.push('Veeam 대조(수집 안 됨)');
  return out;
}

/**
 * 타일 4칸의 글자 — 값(v)이 null 이면 '—' · 단위 없음. 끊긴 호스트는 사용률이 null(hostUsagePct).
 * @param c  /hosts/checks 의 byId[host.id] — 없으면 VM 타일의 켜짐 · 할당 줄(subs)을 비운다(지어내지 않는다).
 */
export function hostTiles(host, c = null) {
  const cores = numOrNull(host?.cpuCores);
  const u = ghz(host?.cpuUsageMhz); const t = ghz(host?.cpuTotalMhz);
  const mu = gbNum(host?.memUsageMB); const mt = gbNum(host?.memTotalMB);
  const down = hostDown(host);
  const vm = c?.vm || null;
  const watts = numOrNull(host?.powerWatts);
  const hasW = watts != null && watts > 0;
  const tc = numOrNull(host?.tempC); const tm = numOrNull(host?.tempMaxC);
  return {
    // 타일은 좁다(640px 드로어에서 안쪽 약 110px) — 한 줄에 한 가지만 적는다(Chromium 확인: '32코어 · 72.5 / 76.8 GHz' 가 잘렸다). 코어 수는 '하드웨어 · 배치' 에 있다.
    cpu: { pct: hostUsagePct(host, 'cpuUsagePct'), sub: !down && u != null && t != null ? `${u} / ${t} GHz` : (cores != null ? `${cores}코어` : '코어 수 모름') },
    mem: { pct: hostUsagePct(host, 'memUsagePct'), sub: !down && mu != null && mt != null ? `${mu} / ${mt} GB` : (mt != null ? `${mt} GB` : '용량 모름') },
    vm: {
      n: numOrNull(host?.vmCount),
      subs: vm ? [`켜짐 ${fmt(vm.on)} · 꺼짐 ${fmt(Math.max(0, vm.n - vm.on))}`, vm.templates ? `템플릿 ${fmt(vm.templates)}` : null, `vCPU ${fmt(vm.vcpu)} 할당`, `코어 대비 ${ratioText(vm.vcpu, cores)}`].filter(Boolean) : [],
    },
    power: {
      watts: hasW ? watts : null,
      src: !hasW ? '' : host.powerSource === 'idrac' ? 'iDRAC 실측' : host.idracBacked ? 'vCenter 추정' : 'vCenter',
      temp: tc != null ? `${tc}℃${tm != null ? ` · 최고 ${tm}℃` : ''}` : '',
    },
  };
}

/** 하드웨어 · 배치 표 — [{ label, value, full?, mono? }]. 못 읽은 값은 '—'. */
export function hostKvRows(host, now = Date.now()) {
  const h = host || {};
  const sockets = numOrNull(h.cpuSockets); const cores = numOrNull(h.cpuCores); const threads = numOrNull(h.cpuThreads);
  const cpu = [sockets != null ? `${sockets}소켓` : null, cores != null ? `${cores}코어${threads != null ? ` / ${threads}스레드` : ''}` : null].filter(Boolean).join(' · ') || '—';
  const mt = gbNum(h.memTotalMB); const mu = gbNum(h.memUsageMB);
  const up = uptimeDays(h, now);
  const nics = Array.isArray(h.nics) ? h.nics.length : null;
  const nd = nicLinkDownOf(h);
  const luns = lunsOf(h); const dead = deadPathsOf(h); const paths = numOrNull(h.hcfg?.mp?.paths);
  const st = [luns != null ? `LUN ${luns}` : null, paths != null ? `경로 ${paths}` : null, dead != null ? `죽은 경로 ${dead}` : null].filter(Boolean).join(' · ') || '—';
  const watts = numOrNull(h.powerWattsIdrac);
  const rows = [
    { label: '제조사 / 모델', value: [h.vendor, h.model].filter(Boolean).join(' / ') || '—' },
    { label: '서비스 태그', value: h.serviceTag || '—', mono: !!h.serviceTag },
    { label: 'ESXi', value: h.version ? `${h.version}${h.build ? ` (build ${h.build})` : ''}` : '—' },
    { label: '업타임', value: up == null ? '—' : `${up}일${shortTime(h.bootTime) ? ` · 부팅 ${shortTime(h.bootTime)}` : ''}` },
    { label: 'CPU', value: cpu },
    { label: '메모리', value: mt != null ? `${mt} GB${!hostDown(h) && mu != null ? ` · 사용 ${mu} GB` : ''}` : '—' },
    { label: 'CPU 모델', value: h.cpuModel || '—', full: true, cpuModel: true },
    { label: '물리 NIC', value: nics == null ? '—' : `${nics}개${nd != null ? ` · 링크 끊김 ${nd}` : ''}` },
    { label: '스토리지 경로', value: st },
    { label: 'HBA / GPU', value: `${Array.isArray(h.hbas) ? h.hbas.length : 0}개 / ${Array.isArray(h.gpus) ? h.gpus.length : 0}개` },
    { label: '클러스터', value: h.cluster || '—' },
    { label: 'vCenter', value: h.vcenterId || '—' },
    { label: '데이터센터', value: h.vcDatacenter || '—' },
  ];
  if (h.idracBacked && watts != null && watts > 0) rows.push({ label: 'iDRAC 실측 전력', value: `${(watts / 1000).toFixed(2)} kW (${fmt(watts)} W)` });
  rows.push({ label: 'vCenter ID', value: h.id || '—', full: true, mono: true });
  return rows;
}
