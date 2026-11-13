/**
 * diskbad/mock.js — 데모(DATA_SOURCE=mock) 모드에서 Lifecycle 로그를 **지어낸다**(v2.915).
 *
 * 실장비에 닿지 않는 데모 · 화면 검증용이다. 결과에 `synthesized:true` 를 달아 중앙이 그 사실을 화면에 밝힌다(합성값을 숨기지 않는다).
 * 결정적이다(서버 id 해시) — 다시 돌려도 같은 서버가 같은 기록을 낸다.
 */
const DAY = 86_400_000;

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const MSG = {
  PDR46: (d) => `Patrol Read found an uncorrectable media error on Disk ${d} in Backplane 1 of Integrated RAID Controller 1.`,
  PDR47: (d) => `A block on Disk ${d} in Backplane 1 of Integrated RAID Controller 1 was punctured by the controller.`,
  PDR54: (d) => `A disk media error on Disk ${d} in Backplane 1 of Integrated RAID Controller 1 was corrected during recovery.`,
  PDR59: (d) => `A bad disk block on Disk ${d} in Backplane 1 of Integrated RAID Controller 1 was reassigned.`,
  PDR57: (d) => `The bad block table on Disk ${d} in Backplane 1 of Integrated RAID Controller 1 is near capacity.`,
  PDR16: (d) => `Predictive failure reported for Disk ${d} in Backplane 1 of Integrated RAID Controller 1.`,
  PDR5: (d) => `Disk ${d} in Backplane 1 of Integrated RAID Controller 1 is removed.`,
};
const PICK = ['PDR54', 'PDR54', 'PDR46', 'PDR59', 'PDR54', 'PDR47', 'PDR57', 'PDR16'];

/** 한 서버의 전체(지어낸) 로그 — 시각 내림차순. */
export function mockEntries(id, now) {
  const h = hash(`diskbad|${id}`);
  const span = 120 + (h % 1300);                    // 로그가 남은 일수(넉 달 ~ 4년)
  const oldest = now - span * DAY;
  const out = [];
  if (h % 100 < 14) {
    const disks = 2 + (h % 3 === 0 ? 1 : 0);
    for (let k = 0; k < disks; k += 1) {
      const disk = 2 + ((h >>> (k * 3)) % 6);
      const n = 1 + ((h >>> (k * 5 + 2)) % 5);
      for (let i = 0; i < n; i += 1) {
        const code = PICK[(h >>> (i * 2 + k)) % PICK.length];
        const created = Math.max(oldest + DAY, now - ((h >>> (i + k * 4)) % span) * DAY - (i * 3_600_000));
        out.push({ entryId: String(1000 + k * 50 + i), created, messageId: `IDRAC.2.9.${code}`, severity: code === 'PDR54' || code === 'PDR59' ? 'OK' : 'Warning', message: MSG[code](disk), code });
      }
      if ((h >>> k) % 4 === 0) {
        const created = now - (((h >>> 7) % 40) + 2) * DAY;
        out.push({ entryId: String(1900 + k), created, messageId: 'IDRAC.2.9.PDR5', severity: 'Warning', message: MSG.PDR5(disk), code: 'PDR5' });
      }
    }
  }
  out.sort((a, b) => b.created - a.created);
  return { entries: out, oldest, total: 400 + (h % 12_000) };
}

export function mockScanServer({ drives, invAt, mode, cursor, now, ...base }) {
  const { entries, oldest, total } = mockEntries(base.id, now);
  const fresh = cursor ? entries.filter((e) => e.created >= cursor.created) : entries;
  const newest = { entryId: `n${Math.floor(now / 3_600_000)}`, created: now - 600_000 };
  return {
    ...base, ok: true, reason: '', synthesized: true, drives, invAt,
    log: { order: 'desc', total, read: cursor ? 3 : total, undated: 0, newestId: newest.entryId, newestCreated: newest.created,
      oldestRead: cursor ? cursor.created : oldest, reachedEnd: !cursor, foundCursor: !!cursor, cursorUsed: !!cursor, stopped: '', cursorCreated: cursor?.created ?? null },
    records: fresh, recordsCapped: false,
    _cursor: { entryId: newest.entryId, created: newest.created, complete: true },
    mode,
  };
}
