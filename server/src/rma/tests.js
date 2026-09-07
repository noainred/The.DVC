/**
 * RMA 점검(테스트) 카탈로그(v2.418, 순수 — 중앙·엣지 공용). HostMonitor RMA 의 'Tests' 에 해당.
 *
 * 명령(commands.js)이 '출력을 그대로 돌려주는 것'이라면 점검은 **판정을 돌려준다** —
 * { status: ok|warn|bad|unknown, reply, value }. 중앙은 점검을 법인/인스턴스에 스케줄로 배포하고
 * (schedules.js), RMA 가 주기마다 현지에서 실행해 결과를 회신한다(testRunner.js → rma-poll 결과 동봉).
 *
 * 규약:
 *  - 파라미터는 commands.js 와 같은 화이트리스트 타입(PARAM_TYPES). 셸 없이 실행(네이티브 우선).
 *  - 파일 계열 점검(파일 존재/크기/개수/텍스트 로그)은 엣지 `RMA_FILE_ROOTS`(기본 /var/log) 아래만
 *    허용한다 — portal.env 등 비밀 파일이 읽히는 경로 차단(testRunner 가 강제).
 *  - 외부 스크립트(`script`)는 엣지 `RMA_ALLOW_CUSTOM=true` 일 때만(자유 명령과 같은 정책).
 *  - `rma-itself` 는 엣지가 실행하지 않는다 — 중앙이 하트비트로 판정(HostMonitor 'rma itself' 마스터 점검).
 */
import { PARAM_TYPES } from './commands.js';

export const STATUS = ['ok', 'warn', 'bad', 'unknown'];

export const TESTS = [
  { id: 'rma-itself', group: '에이전트', label: 'RMA 자체 상태(마스터 점검)', desc: '엣지 실행 없음 — 중앙이 하트비트로 판정. 다른 점검의 상위 점검으로 쓰면 에이전트 단절 시 알림 1건으로 묶인다.', central: true, params: [] },
  { id: 'ping', group: 'LAN', label: 'Ping', params: [
    { name: 'host', label: '대상', type: 'host', required: true },
    { name: 'count', label: '횟수', type: 'int', min: 1, max: 10, def: 3 },
    { name: 'maxLossPct', label: '허용 손실(%)', type: 'int', min: 0, max: 100, def: 0 },
    { name: 'maxRttMs', label: '허용 RTT(ms)', type: 'int', min: 1, max: 60000, def: 1000 }] },
  { id: 'trace', group: 'LAN', label: 'Trace(홉 수)', params: [
    { name: 'host', label: '대상', type: 'host', required: true },
    { name: 'maxHops', label: '허용 홉', type: 'int', min: 1, max: 40, def: 20 }] },
  { id: 'tcp', group: 'LAN', label: 'TCP 포트', params: [
    { name: 'host', label: '대상', type: 'host', required: true },
    { name: 'port', label: '포트', type: 'int', min: 1, max: 65535, required: true },
    { name: 'timeoutMs', label: '타임아웃(ms)', type: 'int', min: 200, max: 30000, def: 5000 }] },
  { id: 'dns', group: 'LAN', label: 'DNS 조회', params: [
    { name: 'name', label: '이름', type: 'host', required: true },
    { name: 'expect', label: '기대 IP(선택)', type: 'host' },
    { name: 'server', label: 'DNS 서버(선택)', type: 'host' }] },
  { id: 'ntp', group: 'LAN', label: 'NTP 동기(chrony 오프셋)', params: [
    { name: 'maxOffsetMs', label: '허용 오프셋(ms)', type: 'int', min: 1, max: 600000, def: 500 }] },
  { id: 'url', group: 'Web', label: 'URL 응답', params: [
    { name: 'url', label: 'URL', type: 'url', required: true },
    { name: 'expectStatus', label: '기대 상태코드', type: 'int', min: 100, max: 599, def: 200 },
    { name: 'maxMs', label: '허용 응답시간(ms)', type: 'int', min: 100, max: 120000, def: 5000 },
    { name: 'contains', label: '본문 포함 문자열(선택)', type: 'text' },
    { name: 'insecure', label: 'TLS 검증 생략(1)', type: 'int', min: 0, max: 1, def: 0 }] },
  { id: 'cert-expiry', group: 'Web', label: '인증서 만료', params: [
    { name: 'host', label: '대상', type: 'host', required: true },
    { name: 'port', label: '포트', type: 'int', min: 1, max: 65535, def: 443 },
    { name: 'warnDays', label: '경고(일)', type: 'int', min: 1, max: 3650, def: 30 },
    { name: 'badDays', label: '위험(일)', type: 'int', min: 0, max: 3650, def: 7 }] },
  { id: 'disk-free', group: '시스템', label: '디스크 여유', params: [
    { name: 'path', label: '경로', type: 'path', required: true, def: '/' },
    { name: 'minFreePct', label: '최소 여유(%)', type: 'int', min: 0, max: 100, def: 10 },
    { name: 'minFreeGB', label: '최소 여유(GB, 선택)', type: 'int', min: 0, max: 1000000 }] },
  { id: 'cpu', group: '시스템', label: 'CPU 사용률', params: [
    { name: 'maxPct', label: '허용(%)', type: 'int', min: 1, max: 100, def: 90 },
    { name: 'sampleSec', label: '샘플(초)', type: 'int', min: 1, max: 30, def: 2 }] },
  { id: 'memory', group: '시스템', label: '메모리 여유', params: [
    { name: 'minFreeMB', label: '최소 여유(MB)', type: 'int', min: 1, max: 10000000, def: 512 },
    { name: 'minFreePct', label: '최소 여유(%, 선택)', type: 'int', min: 0, max: 100 }] },
  { id: 'load', group: '시스템', label: '부하 평균(1분)', params: [
    { name: 'maxLoadPerCore', label: '코어당 허용 부하(×0.1)', type: 'int', min: 1, max: 1000, def: 20 }] },
  { id: 'process', group: '시스템', label: '프로세스 존재', params: [
    { name: 'name', label: '프로세스명/패턴', type: 'text', required: true },
    { name: 'min', label: '최소 개수', type: 'int', min: 0, max: 10000, def: 1 },
    { name: 'max', label: '최대 개수(선택)', type: 'int', min: 0, max: 10000 }] },
  { id: 'service', group: '시스템', label: 'systemd 서비스 상태', params: [
    { name: 'unit', label: '유닛', type: 'unit', required: true, def: 'vmware-portal' },
    { name: 'expect', label: '기대 상태(active/inactive)', type: 'text', def: 'active' }] },
  { id: 'interfaces', group: '시스템', label: '네트워크 인터페이스 UP', params: [
    { name: 'iface', label: '인터페이스(선택, 비우면 lo 제외 전체)', type: 'text' }] },
  { id: 'file-exists', group: '파일', label: '파일/폴더 존재', params: [
    { name: 'path', label: '경로', type: 'path', required: true },
    { name: 'expect', label: '기대(1=있어야, 0=없어야)', type: 'int', min: 0, max: 1, def: 1 }] },
  { id: 'file-size', group: '파일', label: '파일/폴더 크기', params: [
    { name: 'path', label: '경로', type: 'path', required: true },
    { name: 'maxMB', label: '허용 최대(MB)', type: 'int', min: 0, max: 100000000, required: true }] },
  { id: 'file-age', group: '파일', label: '파일 갱신 지연', params: [
    { name: 'path', label: '경로', type: 'path', required: true },
    { name: 'maxAgeMin', label: '허용 경과(분)', type: 'int', min: 1, max: 5256000, def: 60 }] },
  { id: 'count-files', group: '파일', label: '파일 개수', params: [
    { name: 'path', label: '폴더', type: 'path', required: true },
    { name: 'pattern', label: '이름 패턴(선택, *.log)', type: 'text' },
    { name: 'max', label: '허용 최대 개수', type: 'int', min: 0, max: 10000000, required: true }] },
  { id: 'text-log', group: '파일', label: '텍스트 로그 패턴', params: [
    { name: 'path', label: '로그 파일', type: 'path', required: true },
    { name: 'pattern', label: '패턴(정규식)', type: 'text', required: true },
    { name: 'tailLines', label: '검사 줄 수(끝에서)', type: 'int', min: 10, max: 100000, def: 2000 },
    { name: 'maxMatches', label: '허용 일치 수', type: 'int', min: 0, max: 1000000, def: 0 }] },
  { id: 'ssh', group: 'SSH', label: 'SSH 원격 명령 점검(종료코드/출력 포함)', desc: '통합 계정 관리의 계정으로 대상 서버에 접속해 명령을 실행하고 종료코드(0=ok)·출력 포함 문자열로 판정. 엣지 RMA_ALLOW_SSH=true 필요.', params: [
    { name: 'host', label: '대상 호스트', type: 'host', required: true },
    { name: 'port', label: 'SSH 포트', type: 'int', min: 1, max: 65535, def: 22 },
    { name: 'credentialId', label: '저장된 계정 id', type: 'text', required: true },
    { name: 'command', label: '실행 명령(원격 셸)', type: 'shell', required: true },
    { name: 'contains', label: '출력 포함 문자열(선택)', type: 'text' },
    { name: 'timeoutMs', label: '타임아웃(ms)', type: 'int', min: 1000, max: 300000, def: 30000 }] },
  { id: 'script', group: '사용자 정의', label: '외부 스크립트(종료코드 0=ok, 1=warn, 그 외 bad)', desc: '엣지 RMA_ALLOW_CUSTOM=true 일 때만 실행.', params: [
    { name: 'command', label: '명령', type: 'shell', required: true },
    { name: 'timeoutMs', label: '타임아웃(ms)', type: 'int', min: 1000, max: 300000, def: 30000 }] },
];

const byId = new Map(TESTS.map((t) => [t.id, t]));
export const getTest = (id) => byId.get(String(id || '')) || null;
export const INTERVAL = { min: 30, max: 86400, def: 300 };

export function testCatalog() {
  return TESTS.map((t) => ({ ...t, params: (t.params || []).map((x) => ({ ...x, hint: PARAM_TYPES[x.type]?.hint || (x.type === 'shell' ? '셸 명령' : '') })) }));
}

/** 파라미터 검증·정규화(순수). { ok, args } | { ok:false, issue }. commands.buildCommand 와 같은 규칙. */
export function buildTest(id, rawArgs = {}) {
  const t = getTest(id);
  if (!t) return { ok: false, issue: `알 수 없는 점검: ${String(id || '').slice(0, 40)}` };
  const args = {};
  for (const p of t.params || []) {
    let v = rawArgs?.[p.name];
    if (v == null || v === '') v = p.def;
    if (v == null || v === '') { if (p.required) return { ok: false, issue: `'${p.label}' 값이 필요합니다.` }; continue; }
    v = String(v).trim();
    if (p.type === 'shell') {
      if (v.length > 2000) return { ok: false, issue: '명령이 너무 깁니다(최대 2000자).' };
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)) return { ok: false, issue: '명령에 제어문자가 포함되어 있습니다.' }; // eslint-disable-line no-control-regex
      args[p.name] = v; continue;
    }
    const ty = PARAM_TYPES[p.type];
    if (!ty) return { ok: false, issue: `내부 오류: 파라미터 타입 ${p.type}` };
    if (p.name === 'pattern' && p.type === 'text') {
      // 정규식/글롭 패턴은 text 집합보다 넓다 — 길이·제어문자만 본다(실행은 argv/네이티브라 셸 위험 없음).
      if (v.length > 200 || /[\x00-\x1f\x7f]/.test(v)) return { ok: false, issue: `'${p.label}' 형식 오류(200자 이내, 제어문자 불가)` }; // eslint-disable-line no-control-regex
      args[p.name] = v; continue;
    }
    if (!ty.re.test(v)) return { ok: false, issue: `'${p.label}' 형식 오류 — ${ty.hint}` };
    if (p.type === 'int') {
      const n = Number(v);
      if (p.min != null && n < p.min) return { ok: false, issue: `'${p.label}'은 ${p.min} 이상이어야 합니다.` };
      if (p.max != null && n > p.max) return { ok: false, issue: `'${p.label}'은 ${p.max} 이하여야 합니다.` };
      args[p.name] = n;
    } else args[p.name] = v;
  }
  return { ok: true, test: t.id, args, central: !!t.central };
}

/** 스케줄 항목 검증(순수) — { id?, test, args, intervalSec, instance?, enabled, name? }. */
export function scheduleItemIssue(item = {}) {
  const b = buildTest(item.test, item.args || {});
  if (!b.ok) return b.issue;
  const iv = Number(item.intervalSec);
  if (!Number.isInteger(iv) || iv < INTERVAL.min || iv > INTERVAL.max) return `주기는 ${INTERVAL.min}~${INTERVAL.max}초 정수여야 합니다.`;
  if (item.instance && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(item.instance))) return '인스턴스 이름 형식 오류';
  if (item.name != null && String(item.name).length > 80) return '이름은 80자 이내';
  return null;
}

/** 임계 판정 도우미(순수) — 엣지·테스트가 공유. */
export const judge = {
  ping: ({ sent, received, avgMs }, a) => {
    if (!sent) return { status: 'unknown', reply: 'ping 결과 없음' };
    const loss = Math.round(((sent - received) / sent) * 100);
    if (received === 0) return { status: 'bad', reply: `응답 없음(${sent}회 전부 손실)`, value: 100 };
    if (loss > a.maxLossPct) return { status: 'bad', reply: `손실 ${loss}% > ${a.maxLossPct}%`, value: loss };
    if (avgMs != null && avgMs > a.maxRttMs) return { status: 'warn', reply: `RTT ${avgMs}ms > ${a.maxRttMs}ms (손실 ${loss}%)`, value: avgMs };
    return { status: 'ok', reply: `손실 ${loss}%${avgMs != null ? `, RTT ${avgMs}ms` : ''}`, value: avgMs ?? loss };
  },
  threshold: (value, { badAbove, warnAbove, badBelow, warnBelow, unit = '' }) => {
    if (value == null || !Number.isFinite(Number(value))) return { status: 'unknown', reply: '값 없음' };
    const v = Number(value);
    if (badAbove != null && v > badAbove) return { status: 'bad', reply: `${v}${unit} > ${badAbove}${unit}`, value: v };
    if (badBelow != null && v < badBelow) return { status: 'bad', reply: `${v}${unit} < ${badBelow}${unit}`, value: v };
    if (warnAbove != null && v > warnAbove) return { status: 'warn', reply: `${v}${unit} > ${warnAbove}${unit}`, value: v };
    if (warnBelow != null && v < warnBelow) return { status: 'warn', reply: `${v}${unit} < ${warnBelow}${unit}`, value: v };
    return { status: 'ok', reply: `${v}${unit}`, value: v };
  },
  certDays: (days, a) => {
    if (days == null) return { status: 'unknown', reply: '인증서 정보 없음' };
    if (days <= a.badDays) return { status: 'bad', reply: `만료 ${days}일 남음(≤ ${a.badDays})`, value: days };
    if (days <= a.warnDays) return { status: 'warn', reply: `만료 ${days}일 남음(≤ ${a.warnDays})`, value: days };
    return { status: 'ok', reply: `만료 ${days}일 남음`, value: days };
  },
};
