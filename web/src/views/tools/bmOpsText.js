/**
 * 리눅스 베어메탈 통합 성능 4단계(v2.923 예정) — 서버 상세 ‘튜닝’ · ‘용도’ · ‘장애 기록’ · ‘진단 스냅샷’ 탭과 함대 ‘용도 분석’ · ‘장애 기록’ 보기의 **문구 · 표기**(순수).
 *
 * ⚠ 판정은 서버가 한다(`server/src/bmusage/tuning/judge.js` · `profiles/match.js` · 부품 장애 `partfault/incidents.js` · 스냅샷 `snapshot/command.js`) —
 *   이 모듈은 서버 code 를 문장으로 바꾸기만 한다(웹이 다시 판정하지 않는다). code 표는 서버 열거와 1:1(테스트가 대조).
 * ⚠ ‘확인 불가’ 는 ‘불일치(권고)’ 가 아니다 — 색 · 낱말 · 정렬 모두 따로 둔다.
 * ⚠ 문구에 백틱 금지(BoldText 는 **강조**만) · 숫자 기준을 박지 않는다(권장값 · 상한은 응답 값).
 */
import { durationText, shortStamp, holdText, INCIDENT_END_TEXT } from './partFaultText.js';
import { numOrNull } from '../../numOrNull.js';

const t = (v) => (v == null ? '' : String(v));
const n = numOrNull;

/* ── 튜닝 ───────────────────────────────────────────────────── */
/** 상태 code(서버 TUNING_STATUS) → 낱말 · 톤 · 정렬(권고가 앞, 참고가 뒤). */
export const TUNING_STATUS_TEXT = Object.freeze({
  advise: { label: '권고', tone: 'warn', rank: 0, title: '권장값과 다릅니다 — 적용 여부는 담당자가 정합니다(이 화면은 적용하지 않습니다).' },
  ok: { label: '적합', tone: 'ok', rank: 2, title: '권장값과 같습니다.' },
  info: { label: '참고', tone: 'idle', rank: 3, title: '권장값이 없거나 상황에 따라 다른 항목입니다 — 값만 보여 줍니다.' },
  unknown: { label: '확인 불가', tone: 'idle', rank: 1, title: '읽지 못했거나 판단 재료가 없습니다 — 불일치(권고)가 아닙니다.' },
});
/** 사유 code(서버 TUNING_REASON) → 짧은 문장. */
export const TUNING_REASON_TEXT = Object.freeze({
  notRead: '이 값을 받지 못했습니다(그 구획을 못 읽음).',
  notPresent: '이 서버에 그 값이 없습니다(파일 없음 — 도구 미사용 · 가상 머신 등).',
  noRec: '이 역할에는 문서 근거 권장값이 없습니다 — 관리자가 설정에서 정할 수 있습니다.',
  hold: '문서가 판단 기준을 주지 않습니다(판단 보류).',
  noDevice: '해당하는 장치가 없습니다.',
  cumulative: '부팅 이후 누적값입니다 — 지금도 늘고 있는지는 이 값만으로 모릅니다.',
  ethtoolNotRead: 'NIC 쪽 카운터(ethtool)를 읽지 않습니다 — 커널 드롭인지 NIC 드롭인지 가릴 수 없습니다.',
  numaNotRead: 'IRQ 가 어느 NUMA 노드 CPU 에 붙었는지 읽지 않습니다.',
  dbConfigNotRead: 'DB 설정(공유 버퍼 크기)을 읽지 못합니다.',
  noRtt: 'RTT 측정값이 없어 판단할 수 없습니다.',
  snapshotOnly: '주기 수집이 아니라 진단 스냅샷에서만 보이는 값입니다.',
  changed: '기본값에서 바뀌었습니다 — 바꾼 근거를 확인하세요.',
  noDrops: '이번 주기 드롭이 없습니다 — 지금은 손댈 이유가 없습니다.',
  unitsNotRead: '실행 중인 서비스 목록을 못 읽었습니다.',
  memNotRead: '물리 메모리 크기를 못 읽어 비율을 계산할 수 없습니다.',
  coresNotRead: '코어 수를 못 읽어 비교할 수 없습니다.',
  appConfigNotRead: '앱 설정 파일을 읽지 않습니다(위치가 현장마다 다르고 비밀번호가 들어 있을 수 있습니다).',
  policyNotRead: '켜져 있지만 허용 구성인지(정책 · 방화벽 규칙)는 읽지 않습니다.',
  notExplicit: '명시 설정이 없습니다 — 배포판 기본값은 확인하지 않았습니다.',
  systemMount: '시스템 마운트라 판정에서 뺐습니다(데이터 볼륨을 구분하지 못함 — 추정).',
});
/** 근거 등급(서버 GRADES). */
export const GRADE_TEXT = Object.freeze({
  '●': '공식 문서 원문 확인',
  '◐': '공식 문서 검색 발췌(원문 미열람)',
  '○': '공식 문서 없음(벤더 · 일반 관행)',
});
// (범례는 BmTuningTab GradeLegend 가 GRADE_TEXT 로 그린다 — 기호를 기호 글꼴로 감싸야 해서 문자열 범례는 두지 않는다.)
/** 표 칸용 짧은 낱말 — 기호만 두면 글꼴에 따라 ◐ 가 작은 반원으로 보여 읽기 어렵다(Chromium 1440 판독) → 기호 + 낱말. */
export const GRADE_SHORT = Object.freeze({ '●': '원문', '◐': '발췌', '○': '없음' });
export function gradeView(grade) {
  const raw = t(grade);
  const toks = [...raw.matchAll(/[●◐○]/g)].map((m) => m[0]);
  return { parts: toks.map((g) => ({ g, label: GRADE_SHORT[g] || '' })), note: /확인 불가/.test(raw) ? '→ 확인 불가' : '', title: toks.map((g) => `${g} ${GRADE_TEXT[g]}`).join(' / ') };
}
/** 역할(서버 ROLES). */
export const ROLE_LABEL = Object.freeze({ db: 'DB', web: '웹', cache: '캐시', file: '파일', general: '일반' });
/** 기능 프로파일 이름(서버 APP_IDS) + 기능 미지정. */
export const APP_LABEL = Object.freeze({ airflow: 'Airflow', gpdb: 'GPDB(Greenplum)', none: '기능 미지정' });
export const PLANNED_LABEL = Object.freeze({ 'ubuntu-base': 'Ubuntu', 'windows-base': 'Windows Server', hadoop: 'Hadoop' });

/** 누가 정했나(by) → 짧은 표지. */
export function byText(by) {
  const s = t(by);
  if (s.startsWith('role:')) return `역할 ${ROLE_LABEL[s.slice(5)] || s.slice(5)}`;
  if (s.startsWith('profile:')) return `용도 ${s.slice(8)}`;
  if (s === 'override:corp') return '관리자 설정(법인)';
  if (s === 'override:all') return '관리자 설정(전체)';
  return '—';
}
/** 등급 문자열(‘● / ◐’ · ‘◐ → 확인 불가’)의 기호들. */
export function gradeTokens(grade) { return [...t(grade).matchAll(/[●◐○]/g)].map((m) => m[0]); }
/** 상태 수 → 요약 조각(권고 · 적합 · 참고 · 확인 불가 순). */
export function tuningSummaryParts(counts = {}) {
  return ['advise', 'ok', 'info', 'unknown'].map((k) => ({ key: k, label: TUNING_STATUS_TEXT[k].label, count: n(counts?.[k]) ?? 0, tone: TUNING_STATUS_TEXT[k].tone }));
}
/** 장치 · NIC 단위 결과 → 한 줄 목록. */
export function devicesText(devices = []) {
  if (!Array.isArray(devices) || !devices.length) return '';
  return devices.map((d) => `${t(d.name)} ${d.value == null || d.value === '' ? '—' : t(d.value)}${d.status && d.status !== 'ok' ? `(${TUNING_STATUS_TEXT[d.status]?.label || d.status})` : ''}`).join(' · ');
}
/** 항목 상태 칸 문구(낱말 + 사유). */
export function tuningStatusView(item = {}) {
  const st = TUNING_STATUS_TEXT[item.status] || TUNING_STATUS_TEXT.unknown;
  return { label: st.label, tone: st.tone, rank: st.rank, title: st.title, reason: item.reason ? (TUNING_REASON_TEXT[item.reason] || '') : '' };
}
/** 출처 id → 문서(응답의 sources 표에서). */
export function sourceById(list = [], id) { return (Array.isArray(list) ? list : []).find((s) => s.id === id) || null; }
/** 사실이 어디서 왔나 · 왜 비었나(응답이 말하는 사실만). */
export function factsNotes(resp = {}, { now = Date.now() } = {}) {
  const out = [];
  if (!resp || typeof resp !== 'object') return out;
  if (resp.via === 'edge') out.push(`엣지 **${t(resp.agent)}** 가 보낸 현재값으로 이 노드가 판정했습니다${n(resp.snapAt) != null ? `(${Math.max(0, Math.round((now - n(resp.snapAt)) / 60_000))}분 전 받음)` : ''} — 권장값 덮어쓰기 · 용도 태그는 이 노드의 설정입니다.`);
  if (resp.noFacts) out.push('이 서버의 튜닝 · 용도 사실을 아직 받지 못했습니다 — OS(SSH) 경로가 없거나, 수집 전이거나, 엣지가 이 기능 이전 판입니다. 모든 항목이 **확인 불가**이고 권고로 세지 않습니다.');
  if (resp.detailOmitted) out.push('엣지 봉투가 크기 상한을 넘어 이 서버의 상세(튜닝 사실 포함)가 빠졌습니다 — 엣지 보관분을 다시 가져오거나 법인 수를 줄여 보세요.');
  if (Array.isArray(resp.trimmed) && resp.trimmed.length) out.push(`튜닝 열 상한 때문에 목록(${resp.trimmed.join(' · ')})을 저장하지 못했습니다 — 그 목록이 필요한 감지는 ‘못 읽음’ 입니다.`);
  if (Array.isArray(resp.conflicts) && resp.conflicts.length) out.push(`기능 프로파일 둘이 같은 항목을 정합니다(${resp.conflicts.map((c) => `${t(c.item)}: ${byText(c.kept)} 이 이김`).join(' · ')}).`);
  return out;
}
/** 튜닝 탭 머리 — TuneD 활성 프로파일 · 역할(수동/기본). */
export function tuningHeadParts(resp = {}) {
  return {
    tuned: resp.tunedProfile ? t(resp.tunedProfile) : '—',
    role: `${ROLE_LABEL[resp.role] || t(resp.role) || '일반'}${resp.roleManual ? '(수동 태그)' : '(기본 — 태그 없음)'}`,
    apps: (resp.activeApps || []).map((a) => APP_LABEL[a] || a).join(' · ') || '없음',
  };
}
export const TUNING_HONEST = Object.freeze([
  'Red Hat 문서(H1~H9)는 원문을 열지 못했습니다(비브라우저 요청 403 — 우회하지 않음). 인용 문장은 검색 엔진 발췌라 등급이 ◐ 입니다.',
  'Rocky 공식 문서에는 범용 성능 튜닝 가이드가 없습니다. Rocky 는 RHEL 재빌드라 RHEL 문서를 1차 근거로 씁니다.',
  '‘DB 역할 권장값’ 중 Red Hat 이 명시한 것은 없습니다(swappiness 10 · THP madvise 는 구판 예시 · DB 벤더 관행 — ◐/○). 다른 역할에는 DB 를 전제로 한 값을 두지 않았습니다.',
  '이 탭은 **읽기 전용**입니다 — 포탈은 sysctl · tuned-adm · ethtool 을 실행하지 않습니다. 적용은 담당자가 합니다.',
]);

/* ── 용도 ───────────────────────────────────────────────────── */
/** 점검 결과(서버 CHECK_STATUS). */
export const CHECK_STATUS_TEXT = Object.freeze({
  ok: { label: '정상', tone: 'ok', rank: 3 },
  warn: { label: '주의', tone: 'warn', rank: 1 },
  bad: { label: '이상', tone: 'bad', rank: 0 },
  unknown: { label: '확인 불가', tone: 'idle', rank: 2 },
  notCollected: { label: '미수집', tone: 'idle', rank: 4 },
  info: { label: '참고', tone: 'idle', rank: 5 },
});
/** 점검 사유(서버 CHECK_REASON). */
export const CHECK_REASON_TEXT = Object.freeze({
  notRead: '이 값을 받지 못했습니다.',
  cmdNotRun: '이 단계는 이 명령을 실행하지 않습니다(정상으로 세지 않습니다).',
  linkOnly: '분류와 링크만 보여 줍니다.',
  tunedNone: 'TuneD 활성 프로파일이 없습니다(파일 없음).',
  listCapped: '목록이 상한에서 잘려 있는지 없는지 말할 수 없습니다.',
  notRunning: '실행 중인 데몬이 없습니다.',
  httpNotRun: '이 단계는 HTTP 점검을 하지 않습니다(성능점검 연동은 다음 단계).',
  secretConfig: '설정에 비밀번호가 들어 있어 읽지 않습니다.',
  appConfigNotRead: '앱 설정 파일을 읽지 않습니다.',
  metricsNoReceiver: 'StatsD · OTel 수신기가 없어 받지 않습니다(이번 범위 밖).',
  noUnit: '그 이름의 실행 유닛이 없습니다(유닛 이름은 현장마다 다릅니다).',
  defaultOff: '꺼져 있습니다(기본값).',
  sqlNotRun: 'gpadmin 계정의 SQL 점검은 이 단계에서 실행하지 않습니다.',
  manualOnly: 'DB 를 멈춰야 하는 점검이라 자동 실행하지 않습니다.',
});
/** 서버 · 프로파일 상태(서버 PROFILE_STATUS). */
export const PROFILE_STATUS_TEXT = Object.freeze({
  ok: { label: '정상', tone: 'ok', rank: 3 },
  warn: { label: '주의', tone: 'warn', rank: 1 },
  bad: { label: '이상', tone: 'bad', rank: 0 },
  unknown: { label: '확인 불가', tone: 'idle', rank: 2 },
  none: { label: '프로파일 없음', tone: 'idle', rank: 4 },
});
export const EVIDENCE_KIND = Object.freeze({ unit: '유닛', proc: '프로세스', port: '포트', account: '계정' });
/** 감지 근거 → ‘유닛 a · 프로세스 b’. 없으면 ‘감지 근거 없음’. */
export function evidenceText(ev = []) {
  if (!Array.isArray(ev) || !ev.length) return '감지 근거 없음';
  return ev.map((e) => `${EVIDENCE_KIND[e.kind] || e.kind} ${t(e.value)}${e.strong ? '' : '(곁들이)'}`).join(' · ');
}
/** 점검 결과 칸. */
export function checkView(c = {}) {
  const st = CHECK_STATUS_TEXT[c.status] || CHECK_STATUS_TEXT.unknown;
  return { label: st.label, tone: st.tone, rank: st.rank, value: c.value == null ? '' : t(c.value), reason: c.reason ? (CHECK_REASON_TEXT[c.reason] || TUNING_REASON_TEXT[c.reason] || '') : '' };
}
/** 매트릭스 칸 — 서버 수 · 상태 수 문구. 0대면 ‘—’. */
export function matrixCellText(cell) {
  if (!cell || !n(cell.servers)) return { main: '—', sub: '' };
  const st = cell.status || {};
  const bits = ['ok', 'warn', 'bad', 'unknown', 'none'].filter((k) => n(st[k])).map((k) => `${PROFILE_STATUS_TEXT[k].label} ${st[k]}`);
  return { main: `${cell.servers}대`, sub: bits.join(' · ') };
}
export const PROFILE_HONEST = Object.freeze([
  'Rocky 9.4 의 공식 ‘정상 동작 점검’ 항목은 릴리스 노트(R3)의 세 가지뿐입니다 — 나머지는 일반 관행(○)이거나 GPDB 요구(●)입니다.',
  'Airflow 메트릭(import_errors · open_slots · starving)은 StatsD/OTel 수신기가 있어야 보입니다 — 이번 범위 밖이라 **미수집**입니다. 설정 파일(airflow.cfg)도 읽지 않습니다.',
  'GPDB 의 SQL 점검은 gpadmin 계정이 필요합니다 — 이 단계는 실행하지 않습니다(**미수집**). gpcheckperf 는 DB 를 멈춰야 하므로 자동 실행하지 않습니다.',
  '프로세스는 **이름만** 읽습니다(인자에 비밀이 실릴 수 있어 읽지 않음) — 그래서 Airflow 의 scheduler · worker 구분은 유닛 이름으로만 합니다.',
  'Ubuntu · Windows · Hadoop 프로파일은 만들지 않았습니다 — ‘프로파일 없음’ 으로 보이고 점검하지 않습니다(틀린 판정을 내지 않습니다).',
]);

/* ── 장애 기록(부품 장애 모듈 문구 재사용) ───────────────────────── */
/** 요약 5칸 — 서버 faultKpis 값만. */
export function faultKpiCards(k = {}, { days = 90 } = {}) {
  return [
    { key: 'open', label: '열린 장애', value: n(k.open) ?? '—', tone: n(k.open) ? 'warn' : 'idle' },
    { key: 'started', label: days ? `최근 ${days}일 발생` : '발생(보존 기간)', value: n(k.started) ?? '—', tone: 'idle' },
    { key: 'avg', label: '평균 지속', value: k.avgDurationMs == null ? '—' : durationText(k.avgDurationMs), note: `정상 복귀 · 부품 제거로 끝난 ${n(k.durationSamples) ?? 0}건 기준(수동 닫음 · 시작 모름 제외)`, tone: 'idle' },
    { key: 'removed', label: '교체(부품 제거)', value: n(k.removed) ?? '—', tone: 'idle' },
    { key: 'endUnknown', label: '종료 기록 없음', value: n(k.endUnknown) ?? '—', note: '해소 이벤트 없이 끝남 — ‘정상 복귀’ 가 아닙니다', tone: n(k.endUnknown) ? 'warn' : 'idle' },
  ];
}
export const FAULT_RULES_NOTE = '‘종료 기록 없음’ 은 해소 이벤트 없이 끝난 것이고 ‘정상 복귀’ 와 다릅니다 · ‘부품 제거’ 는 고친 것이 아니라 뺀 것(교체 이력)입니다 · ‘수동 닫음’ 은 평균 지속에 넣지 않습니다 · ‘보류 사유’ 는 그 기간에 상태를 못 읽은 이유이고 장애가 아닙니다. 전부 기존 파트 장애 모듈의 규칙 그대로 — 이 화면은 서버 하나로 좁혀 보여 줄 뿐 다시 판정하지 않습니다.';
/** 시간순 — 부품 전이(장애 이벤트) + SEL/LC. 시각으로만 정렬(인과를 적지 않는다). */
export function faultTimeline(incidents = [], sel = null, labels = {}) {
  const out = [];
  for (const i of Array.isArray(incidents) ? incidents : []) {
    for (const e of i.events || []) {
      const st = (s) => labels.state?.[s] || s || '?';
      const what = e.event === 'open' ? `열림 ‘${st(e.state)}’` : e.event === 'change' ? `변화 ${st(e.prevState)} → ${st(e.state)}` : `닫힘 · ${(INCIDENT_END_TEXT[e.closeReason === 'key-migrated' ? 'migrated' : e.closeReason] || INCIDENT_END_TEXT.ok).label}`;
      out.push({ at: n(e.at), src: '부품', text: `${t(i.label)} — ${what}` });
    }
  }
  for (const e of Array.isArray(sel) ? sel : []) {
    const ms = Date.parse(t(e.at));
    out.push({ at: Number.isFinite(ms) ? ms : null, src: 'SEL/LC', text: `${t(e.severity)} ${t(e.message)}`, raw: t(e.at) });
  }
  return out.sort((a, b) => (b.at ?? -1) - (a.at ?? -1)).slice(0, 80);
}
export { durationText, shortStamp, holdText };

/* ── 진단 스냅샷 ─────────────────────────────────────────────── */
/** 결과 code(서버 SNAPSHOT_CODES) → 문장 · 톤. */
export const SNAP_CODE_TEXT = Object.freeze({
  ok: { tone: 'ok', text: '스냅샷을 받았습니다.' },
  'bad-reason': { tone: 'warn', text: '사유를 2자 이상 적어야 합니다(감사 기록에 남습니다).' },
  'not-found': { tone: 'idle', text: '대상 서버를 찾지 못했습니다 — 대상에서 빠졌거나 볼 수 있는 범위 밖입니다.' },
  forbidden: { tone: 'warn', text: '이 서버의 법인에 쓰기 권한이 없습니다(조회 전용) — 진단 스냅샷은 원격 명령을 실행합니다.' },
  'no-os-path': { tone: 'idle', text: '이 서버에는 OS 계정이 없습니다 — 스냅샷은 SSH 경로가 있어야 합니다(베어메탈 스토리지 등록부).' },
  busy: { tone: 'warn', text: '이 서버의 스냅샷이 이미 실행 중입니다 — 끝난 뒤 다시 누르세요(서버당 동시 1건).' },
  'daily-cap': { tone: 'warn', text: '이 법인의 24시간 스냅샷 상한에 닿았습니다.' },
  'store-unavailable': { tone: 'bad', text: '스냅샷 보관 DB 를 열 수 없어 실행하지 않았습니다(상한을 셀 수 없습니다).' },
  'ssh-error': { tone: 'bad', text: 'SSH 로 읽지 못했습니다 — 아래 사유를 보세요.' },
  auth: { tone: 'bad', text: 'SSH 자격증명이 거부됐습니다 — 계정 잠금을 막으려고 이 서버의 주기 수집을 멈췄습니다(등록부에서 고치면 다음 주기에 재개).' },
  'host-key': { tone: 'bad', text: 'SSH 호스트키를 신뢰하지 않아 연결하지 않았습니다(비밀번호를 보내지 않음) — 설정 › 장비 신뢰에서 지문을 확인 · 승인하세요.' },
  timeout: { tone: 'bad', text: '시한 안에 끝나지 않아 세션을 끊었습니다.' },
  'not-linux': { tone: 'idle', text: '리눅스 셸 출력이 아닙니다(Windows 이거나 명령이 제한된 계정) — 스냅샷은 리눅스만 지원합니다.' },
  edge: { tone: 'bad', text: '엣지에 닿지 못했습니다 — 엣지가 꺼졌거나 이 기능 이전 판일 수 있습니다.' },
});
/** 칸 상태(서버 SNAPSHOT_STATES). */
export const SNAP_STATE_TEXT = Object.freeze({
  ok: '',
  perm: '권한 부족 — 읽지 못했습니다(확인 불가).',
  partial: '일부 권한 부족 — 읽은 프로세스만 보입니다(확인 불가가 섞여 있음).',
  absent: '없음(0줄).',
  missing: '받지 못했습니다(출력이 잘렸거나 명령이 없음).',
});
/** 권한 부족 상태(상태 9종 ④)를 그려야 하는가. */
export function snapPermState(result) {
  const s = result?.states || {};
  return s.io === 'perm' || s.io === 'partial' || s.dmesg === 'perm';
}
/** 바이트/초 → 읽기 쉬운 단위(값이 없으면 ‘—’ — 0 으로 두지 않는다). */
export function bpsText(v) {
  const x = n(v);
  if (x == null) return '—';
  if (x >= 1e9) return `${(x / 1e9).toFixed(1)} GB/s`;
  if (x >= 1e6) return `${(x / 1e6).toFixed(1)} MB/s`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(1)} KB/s`;
  return `${Math.round(x)} B/s`;
}
/** KB → 읽기 쉬운 단위. */
export function kbText(v) {
  const x = n(v);
  if (x == null) return '—';
  if (x >= 1024 * 1024) return `${(x / 1024 / 1024).toFixed(1)}GB`;
  if (x >= 1024) return `${(x / 1024).toFixed(0)}MB`;
  return `${Math.round(x)}KB`;
}
export function snapResultNote(r = {}) {
  const bits = [];
  if (n(r.ms) != null) bits.push(`소요 ${(n(r.ms) / 1000).toFixed(1)}초`);
  if (n(r.used) != null && n(r.max) != null) bits.push(`이 법인 24시간 ${r.used}/${r.max}회`);
  if (r.stored === false) bits.push('**보관하지 못했습니다**');
  return bits.join(' · ');
}
export const SNAP_NOTE = '사람이 누를 때만 SSH 1회로 읽습니다(주기 수집이 아닙니다) · 읽기 전용 명령만(ps · /proc/<pid>/io · ss -s · dmesg) · **sudo 를 자동으로 시도하지 않습니다** · 프로세스는 이름만(인자 · 환경 변수는 읽지 않음) · 결과는 그 서버를 수집하는 노드에 7일 보관 · 사유와 실행자는 감사 로그에 남습니다.';
export const SNAP_PS_NOTE = 'ps 의 %CPU 는 프로세스 수명 평균입니다(지금 순간값이 아닙니다). I/O 는 2초 동안의 /proc/<pid>/io 증가분입니다.';
