/**
 * diskbad/mock.js — 데모(DATA_SOURCE=mock) 모드에서 Lifecycle 로그를 **지어낸다**(v3.8.0).
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

/** 지어낸 읽기 진단 — 서버 몇 대는 로그인 기록이 활성 로그를 채운 꼴(하루 ~ 며칠치)로 만든다(화면 검증용). */
function mockDiag(id, total, entries) {
  const h = hash(`diag|${id}`);
  const flooded = h % 5 === 0;
  const disk = entries.length;
  const login = flooded ? Math.floor(total * 0.48) : Math.floor(total * 0.06);
  const top = [{ code: 'USR0030', n: login }, { code: 'USR0032', n: login }, { code: 'LOG007', n: Math.floor(total * 0.01) }, { code: 'SYS1003', n: Math.floor(total * 0.004) }];
  if (disk) top.push({ code: entries[0].code, n: disk });
  return { flooded, diag: { pages: Math.ceil(total / 50), ms: 400 * Math.ceil(total / 50), distinct: 14 + (h % 20), top: top.filter((x) => x.n > 0).sort((a, b) => b.n - a.n), firstLen: 50, hasNext: total > 50, path: 'std' } };
}

function mockProbe(now) {
  return { v: 1, at: now, synthesized: true, manager: { firmware: '7.00.00.00', model: '14G Monolithic' },
    lclog: { path: '/redfish/v1/Managers/iDRAC.Embedded.1/LogServices/Lclog/Entries', pageLen: 50, count: 3853, nextLink: true, order: 'desc', sampleMessageId: 'IDRAC.2.9.USR0030', codes: { USR0030: 24, USR0032: 24, LOG007: 2 } },
    filterExact: { n: 50, count: 1912, nextLink: true, allMatch: true }, filterPrefixEq: { n: 0, count: 0, nextLink: false, allMatch: false },
    lcService: { exports: ['ExportLCLog', 'ExportCompleteLCLog', 'ExportTechSupportReport'], ExportLCLog: { shareTypes: ['Local', 'NFS', 'CIFS'] }, ExportCompleteLCLog: { shareTypes: ['NFS', 'CIFS'] } },
    logAttributes: { total: 812, matched: { 'Logging.1.LCLogAggregation': 'Disabled' } },
    drive: { id: 'Disk.Bay.0:Enclosure.Internal.0-1:RAID.Integrated.1-1', mediaType: 'SSD', values: { FailurePredicted: false, PredictedMediaLifeLeftPercent: 97 }, links: [] }, ms: 2100 };
}

export function mockScanServer({ drives, invAt, mode, manual = false, cursor, now, ...base }) {
  const { entries, oldest: oldestFull, total } = mockEntries(base.id, now);
  const { flooded, diag } = mockDiag(base.id, total, entries);
  // 로그인 기록으로 찬 서버는 활성 로그가 며칠치뿐이고 그 안의 기록만 보인다(실장비에서 본 꼴 — v3.8.2).
  const oldest = flooded ? now - (1 + (hash(`span|${base.id}`) % 6)) * DAY : oldestFull;
  const visible = flooded ? entries.filter((e) => e.created >= oldest) : entries;
  const fresh = cursor ? visible.filter((e) => e.created >= cursor.created) : visible;
  const newest = { entryId: `n${Math.floor(now / 3_600_000)}`, created: now - 600_000 };
  return {
    ...base, ok: true, reason: '', synthesized: true, drives, invAt,
    log: { order: 'desc', total, read: cursor ? 3 : total, undated: 0, newestId: newest.entryId, newestCreated: newest.created,
      oldestRead: cursor ? cursor.created : oldest, reachedEnd: !cursor, foundCursor: !!cursor, cursorUsed: !!cursor, stopped: '', cursorCreated: cursor?.created ?? null,
      ...diag },
    records: fresh, recordsCapped: false, ...(manual ? { probe: mockProbe(now) } : {}),
    _cursor: { entryId: newest.entryId, created: newest.created, complete: true },
    mode,
  };
}
