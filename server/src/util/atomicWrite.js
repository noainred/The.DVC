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
    // 임시파일 데이터를 디스크에 fsync한 뒤 rename — fsync 없이는 rename 메타데이터가 데이터보다
    // 먼저 디스크에 닿아, 정전 시 대상이 0바이트/부분 파일로 남을 수 있다(정전 안전성 확보).
    const fd = fs.openSync(tmp, 'w', mode);
    try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.chmodSync(tmp, mode); } catch { /* */ }
    fs.renameSync(tmp, file); // 같은 FS에서 원자적 교체
    // 디렉터리 엔트리(rename)도 fsync — 새 파일명이 정전에도 유실되지 않게. 미지원 플랫폼은 무시.
    try { const dfd = fs.openSync(dir, 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch { /* */ }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* */ }
    throw e;
  }
}
