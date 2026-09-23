/**
 * storageVersionText.js — 스토리지 표 '버전' 열의 문구(순수, vitest 고정, v2.585).
 *
 * 사용자 신고(2026-09-23 캡처): 2.583 에서 Unity 18대 전부 버전이 `—` 였다. `—` 만 두면 '아직 안 됐다' 와
 * '명령이 실패했다' 와 '형식을 못 읽었다' 가 구분되지 않는다(v2.493 '값이 없는 이유를 단정하지 말 것' 계열).
 * 서버가 싣는 `extra.missingCmds.version`(사유)과 `extra.versionAttempts`(후보별 시도)로 **판정**해서 말한다.
 *
 * 규칙: 값이 있으면 그대로(원문·출처는 title). 없으면 `—` + 표지(`?`)와 title 에 이유. 단정하지 않는다 —
 * 시도 기록이 없으면 '이 스냅샷에는 시도 기록이 없다' 까지만(구버전 엣지·수집 방식 API 등).
 */
const t = (v) => String(v ?? '').trim();

export function versionCellInfo(snap) {
  const s = snap && typeof snap === 'object' ? snap : null;
  const ex = s?.extra && typeof s.extra === 'object' ? s.extra : {};
  const version = t(s?.version);
  if (version) {
    const bits = [];
    if (t(ex.versionRaw)) bits.push(`원문 ${t(ex.versionRaw)}`);
    if (t(ex.versionSource)) bits.push(`출처 ${t(ex.versionSource)}`);
    if (t(ex.versionKey)) bits.push(`키 ${t(ex.versionKey)}`);
    return { text: version, mark: '', title: bits.join(' · '), kind: 'ok' };
  }
  const reason = t(ex.missingCmds?.version);
  const attempts = Array.isArray(ex.versionAttempts) ? ex.versionAttempts : [];
  if (!s) return { text: '—', mark: '', title: '', kind: 'none' };
  // 장비 수집 자체가 실패했으면 버전이 빈 것은 그 결과다 — 버전 명령 탓을 하지 않는다(조치가 다르다).
  if (t(s.error) && !attempts.length) return { text: '—', mark: '?', title: `장비 수집 자체가 실패했습니다: ${t(s.error).slice(0, 200)}`, kind: 'device-failed' };
  if (!reason && !attempts.length) {
    // 시도 기록 자체가 없다 — 이 스냅샷은 버전을 시도하지 않았거나(API 수집·구버전 엣지) 그 정보를 싣지 않는다.
    return { text: '—', mark: '?', title: '버전 수집 시도 기록이 없습니다 — 수집 방식이 SSH(uemcli)가 아니거나 엣지가 구버전일 수 있습니다.', kind: 'no-attempt' };
  }
  const lines = [];
  if (reason) lines.push(`사유: ${reason}`);
  for (const a of attempts) {
    const st = a.ok ? '성공(값 없음)' : a.timedOut ? `시한 초과(${Math.round((a.ms || 0) / 1000)}초)` : a.aborted ? `중단: ${a.aborted}` : a.truncated ? '응답 상한' : '실패';
    lines.push(`${a.cmd}: ${st}${a.ms != null && !a.timedOut ? ` · ${Math.round(a.ms / 1000)}초` : ''}${t(a.head) ? ` · "${t(a.head).split('\n')[0].slice(0, 80)}"` : ''}`);
  }
  lines.push('상세의 CLI 명령 원문에서 전체 출력을 볼 수 있습니다.');
  const kind = attempts.some((a) => a.timedOut) ? 'timeout' : attempts.length ? 'unrecognized' : 'error';
  return { text: '—', mark: '?', title: lines.join('\n'), kind };
}
