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

/**
 * 손상된 자격증명/설정 파일을 `<file>.corrupt.<ts>`로 보존한다(로드 시 JSON 파싱 실패 대응).
 * 손상본을 조용히 빈 값으로 취급하면, 다음 저장이 '온전했던 원본'을 빈/축소 목록으로 덮어써
 * 자격증명이 영구 유실된다(과거 감사 지적 H11/H12). 파싱 실패한 파일을 먼저 옆으로 치워
 * 운영자가 수동 복구할 수 있게 하고, 실패해도(권한 등) best-effort로 넘어간다.
 * @returns 보존에 성공하면 백업 경로, 아니면 null.
 */
export function preserveCorrupt(file, reason = '') {
  try {
    if (!fs.existsSync(file)) return null;
    const bak = `${file}.corrupt.${Date.now()}`;
    fs.renameSync(file, bak);
    console.error(`[atomicWrite] ${path.basename(file)} 파싱 실패${reason ? `(${reason})` : ''} — 손상본을 ${path.basename(bak)}로 보존하고 빈 값으로 시작합니다. 자동 재저장이 덮어쓰기 전 수동 복구하세요.`);
    return bak;
  } catch { return null; }
}
