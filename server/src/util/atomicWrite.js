import fs from 'node:fs';
import path from 'node:path';

/**
 * 원자적 파일 쓰기 — 임시파일에 기록 후 rename으로 교체한다. writeFileSync는 기록 도중
 * 크래시/정전 시 파일을 truncate/부분기록 상태로 남겨, 다음 로드에서 JSON 파싱 실패 →
 * 빈 값 반환 → 다음 저장이 손상본을 덮어쓰며 데이터가 영구 유실될 수 있다. rename은 같은
 * 파일시스템에서 원자적이므로 '온전한 이전본' 또는 '온전한 새본'만 남는다.
 */
export function atomicWriteFileSync(file, data, { mode = 0o600 } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmp, data, { mode });
    try { fs.chmodSync(tmp, mode); } catch { /* */ }
    fs.renameSync(tmp, file); // 같은 FS에서 원자적 교체
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* */ }
    throw e;
  }
}
