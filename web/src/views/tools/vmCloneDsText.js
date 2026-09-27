/**
 * VM 복제 대상 데이터스토어 드롭다운 한 줄 — v2.632 WEB2632-05.
 *
 * 여유 공간을 못 읽은 DS(soapClient 가 freeSpace 를 받지 못하면 freeGB·usagePct 가 null — v2.598)를
 * 예전에는 `여유 0TB (null%)` 로 그렸다. 복제 대상을 고르는 근거가 되는 값이 **오류 없이 틀렸다**
 * ('꽉 찬 DS' 로 읽혀 멀쩡한 DS 를 피하거나, 반대로 미상인 DS 를 모르고 고른다). 못 읽으면 '미상' 이라 말한다.
 */
import { numOrNull } from '../../numOrNull.js';
import { unitText } from '../unitText.js';

export function dsOptionLabel(ds) {
  const name = ds?.name || '(이름 없음)';
  const free = numOrNull(ds?.freeGB);
  const freeText = free == null ? '여유 —(미상)' : `여유 ${Math.round(free / 1024 * 10) / 10}TB`;
  const pct = numOrNull(ds?.usagePct);
  return `${name} — ${freeText}${pct == null ? '' : ` (${unitText(pct, '%')})`}`;
}
