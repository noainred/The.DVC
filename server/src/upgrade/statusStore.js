/**
 * upgrade/statusStore.js — 업그레이드 확인·적용·백그라운드 확인 기록을 재시작 뒤에도 남긴다(v2.736.2, 상태 파일).
 *
 * 왜: 자동 업그레이드는 새 번들을 적용한 **직후 재시작** 한다. 기록이 메모리에만 있으면 재시작한 새 프로세스의 화면에는
 *   '아직 확인하지 않았습니다' 만 남아, 자동 업그레이드가 실제로 일어났는지·무엇이 실패했는지 알 길이 없었다(2026-10-15 신고).
 *
 * 규칙(signature.js 검증 기록과 같은 판단):
 *  - 파일에 쓰는 것은 서버 프로세스가 `manager.start()` 로 `enable` 한 뒤뿐이다 — 테스트·도구가 import 만으로 CONFIG_DIR 에 쓰지 않게.
 *  - 쓰기는 동기 원자 쓰기(0600)다 — 적용 직후 재시작하므로 디바운스하면 그 기록이 사라진다(쓰기는 확인·적용마다 1회 — 드물다).
 *  - 아는 필드만(`autoState.js sanitize*`) — 읽을 때도 같은 정제. 손상 파일은 보존(.corrupt.<ts>) 후 새로 시작한다.
 *  - 쓰기 실패는 업그레이드 동작을 바꾸지 않는다(콘솔과 상태 `persist.error` 에만).
 *  - 비밀은 없다 — 설정(토큰)은 싣지 않고, 주소는 계정·쿼리를 뗀다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { sanitizeCheck, sanitizeResult, sanitizeTick } from './autoState.js';

registerStateFile('upgrade-status.json');
export const upgradeStatusFile = (configDir = config.configDir) => path.join(configDir, 'upgrade-status.json');

/** 파일을 읽는다 — {doc, error?, corruptKept?}. 없으면 빈 문서. */
export function readUpgradeStatus(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e?.code === 'ENOENT') return { doc: {} };
    return { doc: {}, error: `업그레이드 기록 파일을 읽지 못했습니다(${String(e?.code || e?.message || e).slice(0, 80)})` };
  }
  let doc;
  try { doc = JSON.parse(text); } catch { doc = undefined; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    const kept = preserveCorrupt(file, 'upgrade-status');
    return { doc: {}, error: '업그레이드 기록 파일이 손상되어 새로 시작했습니다', corruptKept: kept ? path.basename(kept) : null };
  }
  return { doc: { lastCheck: sanitizeCheck(doc.lastCheck), lastResult: sanitizeResult(doc.lastResult), lastTick: sanitizeTick(doc.lastTick) } };
}

/** 쓴다 — 성공이면 null, 실패면 사유 문구. */
export function writeUpgradeStatus(file, { lastCheck, lastResult, lastTick }) {
  try {
    const strip = (o) => { if (!o) return null; const { restored, ...rest } = o; return rest; }; // 되살렸다는 표지는 파일에 쓰지 않는다
    const doc = { v: 1, lastCheck: strip(sanitizeCheck(lastCheck)), lastResult: strip(sanitizeResult(lastResult)), lastTick: strip(sanitizeTick(lastTick)) };
    atomicWriteFileSync(file, JSON.stringify(doc), { mode: 0o600 });
    return null;
  } catch (e) {
    return `업그레이드 기록을 파일에 남기지 못했습니다(${String(e?.code || e?.message || e).slice(0, 80)}) — 재시작하면 이번 기록은 사라집니다`;
  }
}
