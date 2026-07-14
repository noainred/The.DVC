/**
 * RedHat 계열의 /etc/redhat-release 처럼, CONFIG_DIR에 현재 포탈 버전을 한 줄로 명시하는
 * 릴리스 파일(CONFIG_DIR/vmware-portal-release)을 기록한다.
 *
 * - 기동 시마다 갱신 → 원격/오프라인 업그레이드 후 재시작하면 새 버전이 그대로 반영된다.
 * - 사람이 읽는 한 줄(제품명 + release + 버전 + 역할) + 파싱하기 쉬운 key=value 메타 몇 줄.
 * - 민감정보가 아니므로 0644(다른 config 파일과 달리 외부에서 읽어도 무방).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config, currentVersion } from '../config.js';

export const RELEASE_FILE = path.join(config.configDir, 'vmware-portal-release');

/** 배포 역할 판별(central 엔드포인트 개방 여부 · 중앙으로 push 여부). */
function nodeRole() {
  const isCentral = !!config.central?.token;   // /api/central 개방 = 중앙 수신자
  const isEdge = !!config.agent?.centralUrl;    // 중앙으로 push = 엣지
  if (isCentral && isEdge) return 'central+edge';
  if (isCentral) return 'central';
  if (isEdge) return 'edge';
  return 'standalone';
}

/** CONFIG_DIR/vmware-portal-release 를 기록한다. 반환: 파일 경로 또는 실패 시 null. */
export function writeReleaseFile(now = new Date()) {
  try {
    const version = currentVersion();
    const role = nodeRole();
    const content =
      `VMware Global Monitoring Portal release ${version} (${role})\n` +
      `VERSION=${version}\n` +
      `ROLE=${role}\n` +
      `WRITTEN_AT=${now.toISOString()}\n`;
    fs.mkdirSync(config.configDir, { recursive: true });
    fs.writeFileSync(RELEASE_FILE, content, { mode: 0o644 });
    try { fs.chmodSync(RELEASE_FILE, 0o644); } catch { /* best effort */ }
    return RELEASE_FILE;
  } catch {
    return null;
  }
}
