// VM 구성 점검(B10, v2.697) — 화면 문구·판정. 판정 규칙은 서버 server/src/vmcfg/parse.js vmCfgFindings 와 **같은 규칙**이고
// 테스트가 두 구현을 같은 입력으로 대조한다(웹은 서버 소스를 번들할 수 없다 — 번들 경계).
// 문구에 백틱 금지(BoldText 는 **강조** 만 해석한다 — uiText.test.js 스윕).

export const VM_CFG_CODES = Object.freeze({
  question: 'crit',
  consolidation: 'warn',
  'disk-nonpersistent': 'warn',
  'cpu-limit': 'warn',
  'mem-limit': 'warn',
  'cdrom-connected': 'warn',
  'guestos-mismatch': 'warn',
  'disk-independent': 'info',
  'multi-writer': 'info',
  'rdm-physical': 'info',
  'cbt-off': 'info',
  floppy: 'info',
  reservation: 'info',
  'hostname-mismatch': 'info',
  managed: 'info',
});

/** 코드 → { title, fix } — 서버 코드 집합과 1:1(테스트 고정). fix 는 짧은 조치 한 줄. */
export const VM_CFG_TEXT = Object.freeze({
  question: { title: '응답 대기 중인 질문이 있습니다', fix: 'vCenter 에서 VM 질문에 답하기 전까지 VM 이 멈춰 있을 수 있습니다' },
  consolidation: { title: '디스크 통합(consolidation)이 필요합니다', fix: '스냅샷 삭제가 끝나지 않아 델타 파일이 남아 있습니다 · 스냅샷 › 통합을 실행하세요' },
  'disk-nonpersistent': { title: '비영구(nonpersistent) 디스크가 있습니다', fix: '전원을 끄면 변경 내용이 사라집니다 · 의도한 구성인지 확인하세요' },
  'cpu-limit': { title: 'CPU 제한(limit)이 걸려 있습니다', fix: 'vCPU 를 늘려도 이 값 이상 쓰지 못합니다 · 의도하지 않았다면 무제한으로 되돌리세요' },
  'mem-limit': { title: '메모리 제한(limit)이 걸려 있습니다', fix: '할당 메모리보다 작으면 벌룬·스왑이 생깁니다 · 의도하지 않았다면 무제한으로 되돌리세요' },
  'cdrom-connected': { title: 'CD-ROM 이 연결돼 있습니다', fix: 'vMotion·DRS 이동을 막을 수 있습니다 · 쓰지 않으면 연결을 해제하세요' },
  'guestos-mismatch': { title: '설정된 게스트 OS 와 실제 OS 가 다릅니다', fix: 'VM 설정의 게스트 OS 를 실제 값으로 맞추세요(Tools·최적화 설정이 달라집니다)' },
  'disk-independent': { title: '독립(independent) 디스크가 있습니다', fix: '스냅샷·스냅샷 기반 백업에 포함되지 않습니다' },
  'multi-writer': { title: '공유(multi-writer) 디스크가 있습니다', fix: '클러스터 구성용 공유 디스크 · 스냅샷·vMotion 제약이 있습니다' },
  'rdm-physical': { title: '물리 호환 RDM 이 있습니다', fix: '스냅샷·스냅샷 기반 백업에 포함되지 않습니다' },
  'cbt-off': { title: 'CBT(변경 블록 추적)가 꺼져 있습니다', fix: '증분 백업이 전체 백업으로 동작할 수 있습니다' },
  floppy: { title: '플로피 장치가 있습니다', fix: '쓰지 않는 레거시 장치 · 제거를 권장합니다(CIS)' },
  reservation: { title: 'CPU·메모리 예약(reservation)이 있습니다', fix: 'HA 여력·전원 켜기 허용 판정에 쓰입니다 · 의도한 값인지 확인하세요' },
  'hostname-mismatch': { title: 'VM 이름과 게스트 호스트 이름이 다릅니다', fix: '참고 · 템플릿 복제 뒤 이름을 바꾸지 않았을 수 있습니다' },
  managed: { title: '다른 솔루션이 관리하는 VM 입니다', fix: '직접 수정하지 마세요(복제·DR 솔루션이 만든 VM 일 수 있습니다)' },
});

const shortName = (s) => {
  if (s == null) return null;
  const t = String(s).trim().toLowerCase();
  if (!t || /^\d{1,3}(\.\d{1,3}){3}$/.test(t) || t.includes(':')) return null;
  return t.split('.')[0] || null;
};
const normGuestId = (s) => (s ? String(s).toLowerCase().replace(/guest$/, '') : null);

/** 서버 vmCfgFindings 와 같은 규칙(테스트 대조). */
export function vmCfgFindings(vm) {
  const out = [];
  const add = (code, facts = {}) => out.push({ code, sev: VM_CFG_CODES[code], facts });
  const c = vm?.cfg && typeof vm.cfg === 'object' ? vm.cfg : null;
  const d = vm?.dev && typeof vm.dev === 'object' ? vm.dev : null;
  const template = vm?.template === true;
  if (c) {
    if (c.question && !template) add('question', { text: c.question.text || null });
    if (c.consolidationNeeded === true) add('consolidation');
    if (c.cpuLimitMhz != null && c.cpuLimitMhz >= 0) add('cpu-limit', { mhz: c.cpuLimitMhz });
    if (c.memLimitMB != null && c.memLimitMB >= 0) add('mem-limit', { mb: c.memLimitMB });
    if ((c.cpuReservationMhz || 0) > 0 || (c.memReservationMB || 0) > 0) add('reservation', { cpuMhz: c.cpuReservationMhz, memMB: c.memReservationMB });
    if (c.cbt === false && !template) add('cbt-off');
    const gc = normGuestId(c.guestIdConfig); const gt = normGuestId(c.guestIdTools);
    if (gc && gt && gc !== gt) add('guestos-mismatch', { config: c.guestIdConfig, tools: c.guestIdTools });
    const hn = shortName(c.guestHostName); const vn = shortName(vm?.name);
    if (hn && vn && hn !== vn) add('hostname-mismatch', { hostName: c.guestHostName });
    if (c.managedBy && (c.managedBy.extensionKey || c.managedBy.type)) add('managed', { ...c.managedBy });
  }
  if (d) {
    const cds = (d.cdroms || []).filter((x) => x && x.connected === true);
    if (cds.length && !template) add('cdrom-connected', { count: cds.length, iso: cds.filter((x) => x.iso).length, file: cds.find((x) => x.file)?.file || null });
    if ((d.floppies || []).length) add('floppy', { count: d.floppies.length });
    const disks = Array.isArray(d.disks) ? d.disks : [];
    const nonp = disks.filter((x) => /nonpersistent/i.test(x?.mode || ''));
    if (nonp.length) add('disk-nonpersistent', { count: nonp.length });
    const indep = disks.filter((x) => /^independent_persistent$/i.test(x?.mode || ''));
    if (indep.length) add('disk-independent', { count: indep.length });
    const mw = disks.filter((x) => /multiwriter/i.test(x?.sharing || ''));
    if (mw.length) add('multi-writer', { count: mw.length });
    const rdmP = disks.filter((x) => x?.rdm && /physical/i.test(x?.rdmMode || ''));
    if (rdmP.length) add('rdm-physical', { count: rdmP.length });
  }
  const order = { crit: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.sev] - order[b.sev]);
}

const yn = (v) => (v === true ? '켜짐' : v === false ? '꺼짐' : '—');
const ageMin = (at, now) => (at > 0 ? Math.max(0, Math.round((now - at) / 60_000)) : null);
export function ageText(at, now = Date.now()) {
  const m = ageMin(at, now);
  if (m == null) return '—';
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}시간 전` : `${Math.round(h / 24)}일 전`;
}
function limitText(v, unit) {
  if (v == null) return '—';
  if (v < 0) return '무제한';
  return `${v.toLocaleString()} ${unit}`;
}
function resText(v, unit) {
  if (v == null) return '—';
  return v === 0 ? '없음' : `${v.toLocaleString()} ${unit}`;
}
const FW = { efi: 'EFI', bios: 'BIOS' };

/**
 * VM 속성창 '구성' 칸의 행 목록 — 값이 없으면 '—'(0·꺼짐으로 채우지 않는다).
 * @returns {{ state:'none'|'partial'|'ok', note:string|null, rows:{label,value,title?}[] }}
 */
export function vmCfgRows(vm, now = Date.now()) {
  const c = vm?.cfg && typeof vm.cfg === 'object' ? vm.cfg : null;
  const d = vm?.dev && typeof vm.dev === 'object' ? vm.dev : null;
  if (!c && !d) {
    return { state: 'none', rows: [], note: '구성 속성을 아직 읽지 않았습니다 — 수집 서버가 VM 을 오래된 순서로 나눠 읽습니다(재시작 직후·첫 수집이면 몇 주기 뒤에 채워집니다). 이 vCenter 가 REST 폴백·구버전 엣지로 수집되면 이 값은 오지 않습니다.' };
  }
  const rows = [];
  if (c) {
    rows.push({ label: '디스크 통합 필요', value: c.consolidationNeeded === true ? '필요' : c.consolidationNeeded === false ? '아니오' : '—' });
    rows.push({ label: 'CBT', value: yn(c.cbt) });
    rows.push({ label: 'CPU 핫애드 / 메모리 핫애드', value: `${yn(c.cpuHotAdd)} / ${yn(c.memHotAdd)}` });
    rows.push({ label: 'CPU 예약 / 제한', value: `${resText(c.cpuReservationMhz, 'MHz')} / ${limitText(c.cpuLimitMhz, 'MHz')}` });
    rows.push({ label: '메모리 예약 / 제한', value: `${resText(c.memReservationMB, 'MB')} / ${limitText(c.memLimitMB, 'MB')}` });
    rows.push({ label: '펌웨어', value: c.firmware ? (FW[c.firmware] || c.firmware) : '—' });
    rows.push({ label: '게스트 OS(설정)', value: c.guestIdConfig || '—' });
    rows.push({ label: '게스트 OS(Tools 보고)', value: c.guestIdTools || (c.guestNameTools ? c.guestNameTools : '—'), title: c.guestNameTools || undefined });
    rows.push({ label: '게스트 호스트 이름', value: c.guestHostName || '—' });
    rows.push({ label: '부팅 시각', value: c.bootTime ? new Date(c.bootTime).toLocaleString('ko-KR') : '—', title: c.bootTime ? `가동 ${ageText(c.bootTime, now).replace(' 전', '')}` : '꺼져 있거나 보고되지 않았습니다' });
    rows.push({ label: '관리 솔루션', value: c.managedBy ? [c.managedBy.extensionKey, c.managedBy.type].filter(Boolean).join(' · ') : '없음' });
  }
  if (d) {
    const cds = Array.isArray(d.cdroms) ? d.cdroms : [];
    const conn = cds.filter((x) => x?.connected === true);
    rows.push({ label: 'CD-ROM', value: cds.length ? `${cds.length}개 · 연결 ${conn.length}` : '없음', title: conn.map((x) => x.file || (x.host ? '호스트 장치' : x.label)).join(', ') || undefined });
    const disks = Array.isArray(d.disks) ? d.disks : [];
    const modes = disks.map((x) => x?.mode).filter(Boolean);
    const indep = modes.filter((m) => /independent/i.test(m)).length;
    rows.push({ label: '디스크', value: disks.length ? `${disks.length}개${indep ? ` · 독립 ${indep}` : ''}${disks.some((x) => x?.rdm) ? ` · RDM ${disks.filter((x) => x?.rdm).length}` : ''}` : '—' });
    const legacy = [(d.floppies || []).length ? `플로피 ${d.floppies.length}` : null, d.usb ? `USB ${d.usb}` : null, d.serial ? `직렬 ${d.serial}` : null, d.parallel ? `병렬 ${d.parallel}` : null].filter(Boolean);
    rows.push({ label: '레거시 장치', value: legacy.length ? legacy.join(' · ') : '없음' });
  }
  const parts = [];
  parts.push(c ? `구성 ${ageText(c.at, now)}` : '구성 미수집');
  parts.push(d ? `장치 ${ageText(d.at, now)}` : '장치 미수집');
  const note = `읽은 시각 — ${parts.join(' · ')}. 구성은 30분, 장치 목록은 6시간 주기로 나눠 다시 읽습니다(기본값).`;
  return { state: c && d ? 'ok' : 'partial', rows, note };
}
