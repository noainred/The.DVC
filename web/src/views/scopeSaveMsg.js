/**
 * v2.733(점검 3회차 C5-03): 설정 저장 성공 문구 + 범위 계정 경고(순수).
 *
 * 서버는 범위 제한 계정이 보낸 전 법인 공용 값을 **적용하지 않고** `ignoredGlobal`·`ignoredReason` 으로 밝힌다(v2.607).
 * 지표 수집·GPU 사용량 수집·전원 꺼짐 점검·게스트 디스크 화면은 그것을 읽지 않고 '저장되었습니다. 새 주기가 즉시 적용됩니다' 라
 * 말했다(칸은 서버의 기존 값으로 되돌아간다 — 바뀌지 않은 설정을 바뀐 것처럼 보고). 경고 문장은 형제 화면과 같은
 * `scopeSaveText.scopeSaveSuffix` 하나를 쓰고(새 문구 복제 금지), 경고가 있으면 '즉시 적용' 같은 적용 주장을 붙이지 않는다.
 */
import { scopeSaveSuffix } from './scopeSaveText.js';

/**
 * @param {object} r       저장 응답
 * @param {string} saved   저장 문장('저장되었습니다.')
 * @param {string} applied 적용 주장(' 새 주기가 즉시 적용됩니다.') — 경고가 있으면 붙이지 않는다
 * @returns {{ text: string, partial: boolean }}
 */
export function scopeSavedText(r, saved = '저장되었습니다.', applied = '') {
  const warn = scopeSaveSuffix(r);
  if (warn) return { text: `${saved}${warn}`, partial: true };
  return { text: `${saved}${applied}`, partial: false };
}
