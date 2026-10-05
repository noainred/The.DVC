// VM 구성 점검(도구 키 vm-hygiene, v2.698) — 화면 문구·칩. 판정은 서버 server/src/vmhygiene/analyze.js 가 한다.
// 코드 집합은 서버 ALL_CODES 와 1:1(테스트 대조) — B10 코드 문구는 vmCfgText.VM_CFG_TEXT 를 그대로 쓴다.
// 문구에 백틱·별표 금지(BoldText 는 **강조** 만 해석).
import { VM_CFG_TEXT } from './vmCfgText.js';

export const HYGIENE_TEXT = Object.freeze({
  'snap-age': { title: '오래된 스냅샷', fix: '스냅샷은 백업이 아닙니다 · 오래 둘수록 델타가 커지고 통합 시간이 길어집니다' },
  'snap-count': { title: '스냅샷이 많습니다', fix: '체인이 길면 디스크 I/O 가 느려집니다 · 필요 없는 스냅샷을 지우세요' },
  'snap-size': { title: '스냅샷이 큽니다', fix: '데이터스토어 여유를 먹습니다 · 통합(삭제) 시간도 그만큼 길어집니다' },
  'snap-orphan-delta': { title: '스냅샷이 없는데 델타 파일이 남아 있습니다(유령 스냅샷 후보)', fix: 'Snapshot Manager 에 안 보이는 델타 체인입니다 · 스냅샷 › 통합을 실행해 보세요(파일을 직접 지우지 마세요)' },
  'tools-missing': { title: 'VMware Tools 가 설치되지 않았습니다', fix: '게스트 정보·정상 종료·백업 정지(quiesce)가 동작하지 않습니다' },
  'uptime-long': { title: '오래 재부팅하지 않았습니다', fix: '참고 · 게스트 OS 패치가 적용되지 않았을 수 있습니다' },
});
export const ALL_TEXT = Object.freeze({ ...VM_CFG_TEXT, ...HYGIENE_TEXT });

export const SEV_LABEL = Object.freeze({ crit: '위험', warn: '주의', info: '참고' });
export const SEV_BADGE = Object.freeze({ crit: 'red', warn: 'amber', info: 'gray' });
const SEV_ORDER = { crit: 0, warn: 1, info: 2 };

/** 코드 칩 — 개수 많은 순(같으면 심각도 순). 0건 코드는 빼지 않고 뒤로 둔다(거르기 기준이 사라지지 않게). */
export function codeChips(byCode) {
  const list = Object.entries(byCode || {}).map(([code, v]) => ({ code, sev: v?.sev || 'info', vms: Number.isFinite(v?.vms) ? v.vms : 0, title: ALL_TEXT[code]?.title || code }));
  return list.sort((a, b) => (b.vms > 0) - (a.vms > 0) || SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || b.vms - a.vms || a.title.localeCompare(b.title));
}

/** 판정 한 개의 짧은 설명(행 안 배지 title). */
export function findingDetail(f) {
  const x = f?.facts || {};
  switch (f?.code) {
    case 'snap-age': return `가장 오래된 스냅샷 ${x.days}일(기준 ${x.limit}일)`;
    case 'snap-count': return `${x.count}개(기준 ${x.limit}개 초과)`;
    case 'snap-size': return `${x.gb} GB(기준 ${x.limit} GB 초과)`;
    case 'snap-orphan-delta': return `델타 ${x.gb} GB`;
    case 'uptime-long': return `부팅 ${x.days}일 전(기준 ${x.limit}일)`;
    case 'cpu-limit': return `CPU 제한 ${x.mhz} MHz`;
    case 'mem-limit': return `메모리 제한 ${x.mb} MB`;
    case 'guestos-mismatch': return `설정 ${x.config} · 실제 ${x.tools}`;
    case 'hostname-mismatch': return `게스트 호스트 이름 ${x.hostName}`;
    case 'question': return x.text || '응답 대기';
    case 'cdrom-connected': return x.file ? `연결된 ISO ${x.file}` : `연결 ${x.count}개`;
    case 'managed': return [x.extensionKey, x.type].filter(Boolean).join(' · ');
    default: return x.count > 1 ? `${x.count}개` : '';
  }
}

/** 수집 범위 한 줄 — '이상 없음' 과 '아직 안 읽음' 을 섞지 않는다. */
export function coverageText(c) {
  if (!c) return '';
  const parts = [`VM ${c.vms.toLocaleString()}대`, `구성 읽음 ${c.cfg.toLocaleString()}`, `장치 읽음 ${c.dev.toLocaleString()}`];
  if (c.notCollected) parts.push(`아직 안 읽음 ${c.notCollected.toLocaleString()}`);
  if (c.templates) parts.push(`템플릿 ${c.templates.toLocaleString()} 제외`);
  if (c.excepted) parts.push(`스냅샷 정책 예외 ${c.excepted.toLocaleString()}`);
  return parts.join(' · ');
}

/** 안 읽은 VM 이 있으면 결과가 '전부' 가 아니라는 사실을 말한다. */
export function coverageNote(c) {
  if (!c) return null;
  if (c.vms > 0 && c.notCollected === c.vms) return '아직 구성 속성을 읽은 VM 이 없습니다 — 수집 서버가 오래된 VM 부터 나눠 읽습니다(재시작 직후면 몇 주기 뒤에 채워집니다). 지금 보이는 판정은 스냅샷·Tools 값뿐입니다.';
  if (c.notCollected > 0) return `구성 속성을 아직 읽지 않은 VM ${c.notCollected.toLocaleString()}대는 구성 판정에서 빠졌습니다(이상이 없다는 뜻이 아닙니다).`;
  return null;
}

/** 알림 상태 문구(관리자). */
export function notifyText(n) {
  if (!n) return null;
  if (!n.enabled) return '스냅샷 정책 알림 꺼짐';
  const last = n.lastSentAt ? new Date(n.lastSentAt).toLocaleString('ko-KR') : '보낸 적 없음';
  const r = n.last?.reason;
  const why = r === 'no-channel' ? ' · 켜진 알림 채널이 없어 보내지 못했습니다' : r === 'error' ? ` · 마지막 시도 실패: ${n.last?.error || ''}` : r === 'edge' ? ' · 이 포탈은 엣지라 보내지 않습니다(중앙이 보냅니다)' : '';
  return `매일 ${n.hour}시 이후 하루 한 번 · 마지막 발송 ${last}${why}`;
}

/** 설정 입력 검증(화면) — 서버가 같은 범위로 자른다. 빈 칸은 '바꾸지 않음'. */
export const RANGES = Object.freeze({ snapAgeDays: [1, 3650], snapCount: [1, 100], snapSizeGB: [1, 100000], uptimeDays: [7, 3650] });
export function settingsPatch(form) {
  const out = {};
  for (const k of Object.keys(RANGES)) {
    const raw = form?.[k];
    if (raw == null || String(raw).trim() === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) out[k] = n;
  }
  if (typeof form?.exceptionsText === 'string') out.exceptions = form.exceptionsText.split('\n').map((s) => s.trim()).filter(Boolean);
  if (form?.notify) out.notify = { enabled: !!form.notify.enabled, hour: Number(form.notify.hour) };
  return out;
}
