// realOsProbeText.js — '실제 OS 수집 점검'(v3.54 · 실제 OS 1단계 실측) 화면 문구 · 숫자 표기(순수 — node 테스트).
// 판정(사유 키)은 서버 inventory/osProbe.js NO_DETAIL_REASONS 하나다 — 여기는 그 키의 글자만 소유한다(키가 같은지 테스트가 대조).

import { EMPTY_TOKENS } from '../../components/sortableText.js';

export const REASON_TEXT = Object.freeze({
  notRead: '아직 읽지 않음(수집 전 · 꺼짐 · 엣지 미업그레이드 등)',
  notAsked: '묻지 않음(vCenter API 8.0.2 미만 또는 판 미상)',
  emptyValues: '보고는 왔으나 값이 모두 빔',
  unparsed: '보고는 왔으나 형식을 못 읽음',
  template: '템플릿',
  toolsOld: 'Tools 11.2 미만',
  toolsNotRunning: '켜짐 · Tools 미실행',
  poweredOff: '꺼짐 · 보고 기록 없음',
  toolsUnknown: 'Tools 판 미상',
  other: 'Tools 정상인데 보고 없음',
});

/** 수 → '1,234' · 못 읽음(null · NaN)은 '—'. */
export function n(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('ko-KR') : '—';
}

/**
 * a / b 백분율('87%') — 분모가 0 이거나 못 읽으면 '—'(0% 로 말하지 않는다).
 * 점검 3회차: 채움 비율을 재는 화면이라 경계에서 반올림이 사실을 뒤집지 않게 — 하나라도 빠졌으면 '100%' 가 아니라 '>99%', 하나라도 있으면 '0%' 가 아니라 '<1%'.
 */
export function pct(a, b) {
  if (!(typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b) && b > 0)) return '—';
  const p = Math.round((a / b) * 100);
  if (p >= 100 && a < b) return '>99%';
  if (p <= 0 && a > 0) return '<1%';
  return `${p}%`;
}

/** 시각(ms) → 'MM-DD HH:mm' · 없으면 '—'. */
export function at(ms) {
  if (!(typeof ms === 'number' && Number.isFinite(ms) && ms > 0)) return '—';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 수집 상태 칸 — 상태가 없는 이유를 단정하지 않는다(점검 1회차 반증: 예전에는 상태가 없으면 무조건 '엣지 수집' 이라 말했다).
 * @param st   vCenter 행의 status(이 포탈의 vmcfg 상태 — 직접 수집 vCenter 만 있다)
 * @param row  vCenter 행(collectSource 'site' | 'direct')
 * @param ctx  응답의 { collect:{ osEnabled }, demo }
 */
export function statusText(st, row = null, ctx = null) {
  // 9회차 재구성: **수집 경로를 먼저** 정한다 — 이 포탈의 상태(st)는 이 포탈이 SOAP 로 수집하는 행(direct)에만 뜻이 있다(서버도 그 행에만 싣는다).
  //   예전에는 st 를 먼저 읽어, st 가 딸려 온 엣지 · REST 행이 '… · Tools 보고 요청' 으로 보일 수 있었다.
  if (ctx?.demo && !st) return { text: '데모 데이터(수집 상태 없음)', tone: 'muted' };
  // 5회차: REST 폴백으로 받은 vCenter 는 Tools 보고 · 구성을 읽지 않는다.
  if (row?.collectSource === 'rest') return { text: 'REST 폴백 수집 — Tools 보고를 읽지 않음', tone: 'amber' };
  if (row?.collectSource === 'site' && row?.collectMethod === 'rest') return { text: '엣지 수집(REST 폴백 — Tools 보고를 읽지 않음)', tone: 'amber' };
  if (row?.collectSource === 'site') return { text: '엣지 수집(상태는 엣지에)', tone: 'muted' };
  // 이하 이 포탈이 직접 수집하는 행.
  // 9회차: 수집을 껐으면 남은 상태보다 먼저 말한다(꺼진 뒤 정상 톤 '… · Tools 보고 요청' 이 남았다).
  if (ctx?.collect?.osEnabled === false) {
    return { text: `이 포탈의 실제 OS 수집 꺼짐${st?.osAt != null ? ` · 마지막 수집 ${at(st.osAt)}` : ''}`, tone: 'amber' };
  }
  // 4회차: 오류도 언제 났는지 · 마지막 성공이 언제인지 함께(오류 문구만 보이면 낡은 오류인지 지금 오류인지 가를 수 없었다).
  if (st?.osError) {
    const when = st.osErrorAt != null ? ` ${at(st.osErrorAt)}` : '';
    const last = st.osAt != null && (st.osErrorAt == null || st.osAt < st.osErrorAt) ? ` · 마지막 성공 ${at(st.osAt)}` : (st.osAt == null ? ' · 성공 기록 없음' : '');
    return { text: `오류${when} — ${String(st.osError).slice(0, 80)}${last}`, tone: 'amber' };
  }
  // 3회차: 예산 때문에 일부만 읽었거나 이번 주기를 건너뛴 것을 정상 톤으로 덮지 않는다.
  if (st?.osSkipReason === 'budget' && !(st.osAt != null && st.osSkippedAt != null && st.osAt > st.osSkippedAt)) {
    return { text: `이번 주기 건너뜀(수집 시간 예산 소진${st.osAt != null ? ` · 마지막 수집 ${at(st.osAt)}` : ''})`, tone: 'amber' };
  }
  if (st && st.osAt != null && typeof st.osCut === 'number' && st.osCut > 0) {
    return { text: `${at(st.osAt)} · 일부만 읽음(${n(st.osCut)}대 남음 · 다음 주기에 이어서)`, tone: 'amber' };
  }
  // 4회차: 묻지 않은 이유가 '판 미달' 인지 '판 미상' 인지 가른다(서버 detailedApiOk 는 판을 못 읽어도 묻지 않는다).
  if (st && st.osAt != null) return { text: `${at(st.osAt)} · ${st.osAsked ? 'Tools 보고 요청' : notAskedText(st.apiVersion)}`, tone: 'ok' };
  if (ctx?.demo) return { text: '데모 데이터(수집 상태 없음)', tone: 'muted' };
  return { text: '이 포탈 수집 기록 없음(수집 전 · 접속 실패 등)', tone: 'muted' };
}

/** 묻지 않은 vCenter 의 사유 글 — 판을 읽었으면 '판 미달 · 8.0.1.0', 못 읽었으면 '판 미상'. */
export function notAskedText(apiVersion) {
  return typeof apiVersion === 'string' && /^\d{1,3}\.\d{1,3}/.test(apiVersion) ? `제품 정보만(판 미달 · ${apiVersion})` : '제품 정보만(판 미상)';
}

/** 수집 주기(ms) → '6시간' · '30분' — 못 읽으면 null(화면이 숫자 없이 말한다 · 주기 숫자를 박지 않는다). */
export function periodText(ms) {
  if (!(typeof ms === 'number' && Number.isFinite(ms) && ms > 0)) return null;
  const min = Math.round(ms / 60_000);
  if (min >= 60 && min % 60 === 0) return `${min / 60}시간`;
  return min >= 1 ? `${min}분` : null;
}

/** {value,count}[] → 'A 3 · B 1' (상위 몇 개) — 보여 주지 않은 종류가 있으면 '외 N가지'(서버가 자른 수 omitted 포함 · 조용히 자르지 않는다). */
export function topText(list, max = 3, omitted = 0) {
  if (!Array.isArray(list) || !list.length) return '—';
  const hidden = Math.max(0, list.length - max) + (Number.isFinite(omitted) && omitted > 0 ? omitted : 0);
  return list.slice(0, max).map((x) => `${x.value} ${x.count}`).join(' · ') + (hidden ? ` 외 ${hidden}가지` : '');
}

/** 시스템 VM 수 — 구성(vm.cfg)을 읽은 VM 에서만 셀 수 있다(점검 2회차: 못 읽은 VM 을 0 으로 섞지 않는다). 다 읽었으면 숫자만, 일부면 '읽은 N대 중 M', 하나도 못 읽었으면 '—'. */
export function managedText(managed, cfgRead, total) {
  if (!(typeof cfgRead === 'number' && cfgRead > 0)) return '—';
  if (typeof total === 'number' && cfgRead < total) return `읽은 ${n(cfgRead)}대 중 ${n(managed)}`;
  return n(managed);
}

/**
 * 판 정렬 키 — 숫자 마디는 자리를 맞춘다('8.10' 이 '8.4' 앞에 오지 않게 · 7회차). 없으면 '' (정렬 맨 뒤).
 * 8회차(반증 재현): 앞에 글자 'v' 를 붙여 STable(sortableText.sortKeyOf)이 **늘 글자로** 읽게 한다 — 마디 1~2개 키는 수로, 3개 이상은 글자로 읽혀
 *   compareKeys 가 수를 늘 앞에 두는 탓에 '22.04' 가 '8.10.1' 앞에 왔다. 시험은 실제 비교기(sortKeyOf + compareKeys)로 한다.
 */
export function versionSortKey(v) {
  if (typeof v !== 'string' || !v.trim()) return '';
  if (EMPTY_TOKENS.has(v.trim())) return '';   // 9회차: '-' · 'n/a' · '미상' 같은 빈 값 표기는 정렬 맨 뒤(STable 규약)
  return `v${v.trim().slice(0, 64).split(/([.\-_ ])/).map((p) => (/^\d{1,12}$/.test(p) ? p.padStart(12, '0') : p)).join('')}`;
}

/** 아키텍처 칸 — 'X86 · 64bit'. 둘 다 없으면 '—'. */
export function archText(r) {
  const a = r?.architecture || '';
  const b = r?.bitness ? `${r.bitness}bit` : '';
  return [a, b].filter(Boolean).join(' · ') || '—';
}

/** 내려받을 파일 이름 — real-os-probe-YYYYMMDD-HHmm.json */
export function probeFileName(now = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `real-os-probe-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`;
}
