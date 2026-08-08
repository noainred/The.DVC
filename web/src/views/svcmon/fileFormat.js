/**
 * 대상/매핑 파일 가져오기 공용 헬퍼 — 확장자로 포맷을 정하고, 서버가 받는 모양
 * `{format, content}` 로 바꾼다. XLSX 는 바이너리라 base64 로 싣고, CSV·JSON 은 UTF-8 텍스트다.
 *
 * 서버가 multipart 를 다루지 않으므로(라우트가 JSON 본문만 받는다) 브라우저에서 읽어 보낸다 —
 * 미리보기·등록 2단계에서 같은 본문을 두 번 보내야 해 클라이언트가 원문을 들고 있는 게 맞다.
 */

export const IMPORT_ACCEPT = '.csv,.json,.xlsx,text/csv,application/json';

/** 파일 이름 확장자로 포맷 결정(모르면 csv). */
export function detectFormat(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.xlsx')) return 'xlsx';
  if (n.endsWith('.json')) return 'json';
  return 'csv';
}

/** File → Promise<{format, content, fileName}>. xlsx=base64, 그 외=텍스트. */
export function readImportFile(file) {
  const format = detectFormat(file.name);
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('파일을 읽지 못했습니다.'));
    if (format === 'xlsx') {
      r.onload = () => {
        const bytes = new Uint8Array(r.result);
        // 큰 배열을 apply 로 한 번에 넘기면 스택을 넘길 수 있어 청크로 문자열화한다.
        let bin = '';
        const CH = 0x8000;
        for (let i = 0; i < bytes.length; i += CH) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        }
        resolve({ format, content: btoa(bin), fileName: file.name });
      };
      r.readAsArrayBuffer(file);
    } else {
      r.onload = () => resolve({ format, content: String(r.result || ''), fileName: file.name });
      r.readAsText(file, 'utf-8');
    }
  });
}
