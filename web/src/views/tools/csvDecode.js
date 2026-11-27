// CSV 파일 바이트 → 글자 판별(공용 — 서버 집중 모니터링 일괄 등록 · 물리서버 자산 원장). v3.45 에 focusMonText.js 에서 옮겼다(판정은 그대로).
/**
 * CSV 파일 바이트 → 글자. 한국어 엑셀의 ‘CSV(쉼표로 분리)’ 는 CP949(EUC-KR)로 저장한다 — UTF-8 로 읽어 깨지면 EUC-KR 로 다시 읽는다.
 * @param {ArrayBuffer|Uint8Array} buf
 * @returns {{text:string, encoding:'utf-8'|'euc-kr'|'utf-16'}}
 */
export function decodeCsvBytes(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  // 엑셀 ‘유니코드 텍스트’ 저장본은 UTF-16(BOM FF FE · FE FF) — 탭 구분이다(서버 파서가 탭을 읽는다)
  if (u8[0] === 0xff && u8[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(u8.subarray(2)), encoding: 'utf-16' };
  if (u8[0] === 0xfe && u8[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(u8.subarray(2)), encoding: 'utf-16' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8), encoding: 'utf-8' }; }
  catch { return { text: new TextDecoder('euc-kr').decode(u8), encoding: 'euc-kr' }; }
}
