/**
 * views/tools/tokenProbeAge.js — 토큰 점검 표 ②·③ 칸의 '언제 본 결과인가'(v2.785 GE O-B1, 순수).
 *
 * 서버(`portalcheck/tokenScan.js mergeProbe`)가 보관된 프로브에 나이(`ageMs`)·낡음(`stale`)·등록값 변경(`changed`)을 단다.
 * 화면은 그 값을 **읽기만** 한다(판정 복제 금지 — 낡음 경계는 서버의 `staleMs`).
 * 예전에는 시각 표시가 없어 사흘 전 200 이 '통신 성공 · 같음(증명)' 으로 지금 값처럼 보였다.
 * ⚠ 문구에 백틱 금지(BoldText).
 */

/**
 * ② 칸 아래 한 줄. 결과가 없거나 시각이 없으면 text 가 ''(그리지 않는다).
 * @param {object|null} probe 행의 probe
 * @param {(ts:number)=>string} ago 상대시각(relTime.agoText)
 * @returns {{text:string, tone:'gray'|'amber', title:string}}
 */
export function probeAgeLine(probe, ago) {
  const none = { text: '', tone: 'gray', title: '' };
  if (!probe || typeof probe !== 'object') return none;
  if (probe.changed === true) {
    const what = probe.changedWhat === 'url' ? 'URL' : probe.changedWhat === 'token+url' ? '토큰·URL' : '토큰';
    return { text: `등록 ${what} 바뀜 · 다시 점검 필요`, tone: 'amber', title: String(probe.reason || '') };
  }
  const at = Number(probe.at);
  if (!(at > 0) || probe.state === 'not-run') return none;
  if (probe.stale === true) {
    return { text: `${ago(at)} · 낡음`, tone: 'amber', title: '오래된 점검 결과입니다 — 지금도 그런지 모릅니다. ‘지금 점검’ 으로 다시 확인하세요.' };
  }
  return { text: ago(at), tone: 'gray', title: '' };
}

/**
 * ③ 수집 토큰 동일성 칸. ⚠ '증명' 은 **지금 유효한 200** 일 때만 — 낡은 200 은 '지난 점검에서 같음' 이다.
 * @returns {{text:string, tone:'green'|'red'|'gray'}}
 */
export function sameTokenCell(probe) {
  const st = probe?.state || 'not-run';
  if (st === 'ok') return probe?.stale === true ? { text: '지난 점검에선 같음', tone: 'gray' } : { text: '같음(증명)', tone: 'green' };
  if (st === 'token-mismatch') return probe?.stale === true ? { text: '지난 점검에선 다름', tone: 'red' } : { text: '다름', tone: 'red' };
  return { text: '확인 불가', tone: 'gray' };
}
