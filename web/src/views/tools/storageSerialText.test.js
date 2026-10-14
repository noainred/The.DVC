import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SERIAL_REASON_TEXT, serialLabel, serialProbeText, serialHeader, showNodeSerialCol, nodeSerialTitle, nodeSerialNote,
} from './storageSerialText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('storageSerialText — 스토리지 시리얼 표시(v2.735.2)', () => {
  it('라벨은 출처의 뜻을 따른다 — GUID·PSNT·시리얼 · 구버전은 예전 라벨', () => {
    expect(serialLabel({ serialKind: 'guid' })).toBe('GUID');
    expect(serialLabel({ serialKind: 'psnt' })).toBe('시리얼(PSNT)');
    expect(serialLabel({ serialKind: 'serial' })).toBe('시리얼');
    expect(serialLabel({})).toBe('시리얼/GUID');
  });
  it('머리줄 — 값이 있으면 값 · 없고 사유가 있으면 미확인 + 사유 · 둘 다 없으면 표시 안 함', () => {
    expect(serialHeader({ serial: 'SYN1', extra: { serialKind: 'psnt', serialKey: 'sys-psnt-serial-number' } }))
      .toEqual({ label: '시리얼(PSNT)', value: 'SYN1', title: '출처: sys-psnt-serial-number' });
    const miss = serialHeader({ serial: '', extra: { serialProbe: { reason: 'no-field', seenKeys: ['sys-id'] } } });
    expect(miss.missing).toBe(true);
    expect(miss.title).toMatch(/시리얼 필드가 없습니다/);
    expect(miss.title).toMatch(/sys-id/);
    expect(serialHeader({ serial: '', extra: {} })).toBeNull();
  });
  it('노드 열·각주 — 읽은 대수와 못 읽은 이유', () => {
    expect(showNodeSerialCol([{ id: 1 }], {})).toBe(false);
    expect(showNodeSerialCol([{ id: 1, serial: 'A' }], {})).toBe(true);
    expect(showNodeSerialCol([{ id: 1 }], { nodeSerialProbe: { reason: 'exec' } })).toBe(true);
    expect(nodeSerialTitle({ chassisSerial: 'C1', model: 'A300' })).toBe('섀시 시리얼 C1 · 제품 A300');
    expect(nodeSerialNote({ nodeSerials: { read: 2, total: 3, source: 'isi_for_array -s isi_hw_status -i' } }, 3)).toMatch(/2\/3대 읽음 — 1대는/);
    expect(nodeSerialNote({ nodeSerialProbe: { reason: 'budget' } }, 3)).toMatch(/다음 주기에 다시 시도/);
  });
  it('사유 코드는 서버 수집기들이 쓰는 코드와 1:1 · 문구에 백틱 없음', () => {
    const src = ['isilonHw.js', 'isilon.js', 'xtremio.js', 'xtremioSsh.js', 'unitySsh.js']
      .map((f) => fs.readFileSync(path.resolve(HERE, '../../../../server/src/storage/collectors', f), 'utf8')).join('\n');
    const used = new Set([...src.matchAll(/reason:\s*(?:[^,}]*\?\s*)?'([a-z-]+)'(?:\s*:\s*'([a-z-]+)')?/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean));
    for (const r of ['budget', 'parse', 'empty', 'exec', 'no-field', 'no-match', 'not-in-output', 'not-run']) expect(used.has(r) || r === 'empty' || r === 'parse').toBe(true);
    for (const r of used) expect(SERIAL_REASON_TEXT[r], `서버 사유 ${r} 의 문구가 없다`).toBeTruthy();
    for (const v of Object.values(SERIAL_REASON_TEXT)) expect(v).not.toMatch(/`/);
    expect(serialProbeText({ reason: 'zzz' })).toBe('시리얼을 읽지 못했습니다');
  });
});
