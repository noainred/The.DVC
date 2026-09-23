/**
 * 업그레이드 적용(파일 복사) 직전에 라이브 WAL SQLite DB를 강제 체크포인트(TRUNCATE)한다.
 *
 * 왜: 업그레이드는 config 디렉터리를 통째로 복사(cpSync)해 보존한다. WAL 모드 DB는 최근 커밋이
 * 아직 본 .db가 아니라 별도 `-wal` 파일에 있을 수 있고, 라이브 쓰기 중 .db와 -wal이 서로 다른
 * 순간에 캡처되면 복사본이 부분/불일치가 될 수 있다. 복사 전에 wal_checkpoint(TRUNCATE)로 -wal의
 * 페이지를 본 .db로 flush하고 -wal을 비우면, 복사본이 자기완결적이라 이 위험이 사라진다.
 *
 * 안전장치:
 *  - best-effort: node:sqlite 미사용(폴백)·개별 실패는 무시하고 업그레이드를 절대 막지 않는다.
 *  - 별도 짧은 커넥션으로 체크포인트(주 커넥션과 공유된 -wal/-shm에 반영). busy_timeout으로 대기.
 *  - ipam.db는 DELETE 저널(외부 프로그램이 직접 읽는 공유 파일)이라 -wal이 없어 대상에서 제외한다.
 */

import fs from 'node:fs';
import path from 'node:path';

export async function checkpointConfigDbs(dir) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { return { ok: false, reason: 'node:sqlite 미사용(NDJSON 폴백) — 체크포인트 불필요' }; }

  // v2.590 P14: 한 단계 하위 디렉터리(vmperf/·vmseries/ — vCenter 마다 파일 하나)도 본다. 업그레이드는 config 를
  // **재귀** 복사하는데 여기는 비재귀라 vCenter별 DB 30여 개가 -wal 과 다른 순간에 복사될 수 있었다.
  let entries = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.db')) entries.push(e.name);
      else if (e.isDirectory() && e.name !== 'backups') {
        try { for (const f of fs.readdirSync(path.join(dir, e.name))) if (f.endsWith('.db')) entries.push(path.join(e.name, f)); }
        catch { /* 하위 디렉터리 읽기 실패는 건너뛴다(best effort) */ }
      }
    }
  } catch { return { ok: false, reason: `디렉터리 없음: ${dir}` }; }

  const checkpointed = [];
  for (const f of entries) {
    if (/ipam/i.test(path.basename(f))) continue;                 // ipam.db 제외(비 WAL·외부 공유)
    const p = path.join(dir, f);
    if (!fs.existsSync(`${p}-wal`)) continue;       // -wal 없으면 flush할 것도 없음
    let db = null;
    try {
      db = new DatabaseSync(p);
      db.exec('PRAGMA busy_timeout=5000;');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      checkpointed.push(f);
    } catch { /* best effort — 개별 DB 실패는 무시 */ }
    finally { try { db?.close(); } catch { /* */ } }
  }
  return { ok: true, checkpointed };
}
