/**
 * serverInfoText.js — 서버 정보 화면 문구(순수 · 시험 serverInfoText.test.js). 값이 없으면 단위를 붙이지 않는다(‘—’ · 루트 CLAUDE.md).
 */
import { numOrNull } from '../../numOrNull.js';
import { sizeText } from '../veeamBadge.js';   // 바이트 → TB 까지(util/fmt fmtBytes 는 GB 에서 멈춘다 — 디스크 크기에 TB 가 필요)

/** 못 읽은 이유 → 짧은 글. */
export const MISS_TEXT = Object.freeze({ permission: '못 읽음 · 권한', absent: '없음', unread: '못 읽음' });

/** 칸 하나({value|missing,reason}) → 글. fmt 가 있으면 값에 씌운다. */
export function cellText(c, fmt = (v) => String(v)) {
  if (!c || typeof c !== 'object') return '—';
  if (c.missing || c.value == null || c.value === '') return `— ${MISS_TEXT[c.reason] || MISS_TEXT.unread}`;
  return fmt(c.value);
}
export const bytesText = (v) => (numOrNull(v) == null ? '—' : sizeText(Number(v)));
export const kbText = (v) => (numOrNull(v) == null ? '—' : sizeText(Number(v) * 1024));

/** 읽기 결과 코드 → 글(서버 readServer · service 의 code 와 같은 열쇠). */
export const CODE_TEXT = Object.freeze({
  ok: '읽음', unparsed: '일부만 읽음', 'maybe-windows': 'OS 종류 확인 필요', 'not-found': '서버 없음', 'registry-unreadable': '등록부 못 읽음',
  'edge-delegated': '엣지에서 읽음', disabled: '수집 꺼짐', 'not-configured': '계정 없음', cred: '계정 판정에서 막힘', 'auth-rejected': '로그인 거부',
  'same-cred-rejected': '같은 계정 거부로 건너뜀', hostkey: '호스트키 미승인', timeout: '시한 초과', 'exec-timeout': '명령 시한 · 일부만', 'exec-truncated': '출력 상한 · 일부만',
  connect: '접속 실패', 'no-plan': '읽기 묶음 없음', error: '내부 오류',
});
export const codeTone = (code) => (code === 'ok' ? 'ok' : ['unparsed', 'maybe-windows', 'edge-delegated', 'disabled', 'not-configured', 'exec-timeout', 'exec-truncated'].includes(code) ? 'warn' : 'bad');

/**
 * 화면에 보일 값의 출처(반증 F10 — 실패 행의 지난 값이 ‘지금 값’ 처럼 보였고, 일부만 읽은 값은 어디에도 안 보였다):
 *   성공 → 그 값 · 일부만(partial — base 가 있다) → 그 값 + ‘일부만’ · 실패 → 마지막 성공 값(lastOk) + ‘지난 값’ · 없으면 null.
 * @returns {{src:object, kind:'now'|'partial'|'last'}|null}
 */
export function shownOf(r) {
  if (!r) return null;
  if (r.ok) return { src: r, kind: 'now' };
  if (r.base) return { src: r, kind: 'partial' };
  if (r.lastOk?.base) return { src: r.lastOk, kind: 'last' };
  return null;
}

/** 계정이 오는 곳(서버 접속 화면과 같은 말). */
export function sourceText(s) {
  if (s?.agent) return { label: '엣지가 읽음', tone: 'muted' };
  const a = s?.account || {};
  if (a.unreadable) return { label: '상태 파일 못 읽음', tone: 'bad' };
  if (a.source === 'own') return { label: '따로 정함', tone: 'warn' };
  if (a.source === 'os') return { label: 'OS 종류에서 물려받음', tone: 'ok' };
  if (a.source === 'corp') return { label: '법인에서 물려받음', tone: 'ok' };
  if (a.pending) return { label: '승인 대기', tone: 'warn' };
  return { label: '미설정', tone: 'muted' };
}

/** 표 한 줄 요약(모델 · 코어 · 메모리 · 디스크 수 · 가장 찬 파일시스템). 못 읽은 칸은 빼고 이어 붙인다 — 하나도 없으면 ‘—’. */
export function summaryText(r) {
  const sh = shownOf(r);
  if (!sh) return '—';
  const src = sh.src;
  const b = src.base;
  const parts = [];
  if (!b.model?.missing && b.model?.value) parts.push(String(b.model.value));
  if (!b.cpuCores?.missing && b.cpuCores?.value != null) parts.push(`${b.cpuCores.value}코어`);
  if (!b.memBytes?.missing && b.memBytes?.value != null) parts.push(bytesText(b.memBytes.value));
  if (Array.isArray(src.disks)) parts.push(`디스크 ${src.disks.length}개`);
  const top = Array.isArray(src.fs) ? src.fs.filter((f) => numOrNull(f.usePct) != null).sort((x, y) => y.usePct - x.usePct)[0] : null;
  if (top) parts.push(`${top.mount} ${top.usePct}%`);
  if (!parts.length) return '—';
  return `${sh.kind === 'last' ? '지난 값 · ' : sh.kind === 'partial' ? '일부만 · ' : ''}${parts.join(' · ')}`;
}

/** 화면의 OS 글. */
export const osText = (os) => (os === 'windows' ? 'Windows' : os === 'linux' ? 'Linux' : '미지정(Linux 로 읽음)');
