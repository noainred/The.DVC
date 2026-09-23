import { describe, it, expect } from 'vitest';
import { versionCellInfo } from './storageVersionText.js';

describe('versionCellInfo (v2.585)', () => {
  it('값이 있으면 그대로 + 원문·출처·키 title', () => {
    const r = versionCellInfo({ version: '5.4.0.0.5.094', extra: { versionRaw: 'c4dev_PIE_8775R-5.4.0.0.5.094-GNOSIS_RETAIL', versionSource: 'svc_diag' } });
    expect(r.text).toBe('5.4.0.0.5.094'); expect(r.mark).toBe(''); expect(r.title).toBe('원문 c4dev_PIE_8775R-5.4.0.0.5.094-GNOSIS_RETAIL · 출처 svc_diag'); expect(r.kind).toBe('ok');
  });
  it('스냅샷이 없으면 — 만(표지 없음)', () => {
    expect(versionCellInfo(null)).toEqual({ text: '—', mark: '', title: '', kind: 'none' });
  });
  it('장비 수집 자체가 실패했으면 그 사실을 말한다(버전 명령 탓이 아니다)', () => {
    const r = versionCellInfo({ version: '', error: 'SSH 수집 실패: connect ECONNREFUSED', extra: { cliRaw: [] } });
    expect(r.kind).toBe('device-failed'); expect(r.title).toMatch(/장비 수집 자체가 실패/); expect(r.mark).toBe('?');
  });
  it('시도 기록이 없으면 단정하지 않는다', () => {
    const r = versionCellInfo({ version: '', extra: {} });
    expect(r.mark).toBe('?'); expect(r.kind).toBe('no-attempt'); expect(r.title).toMatch(/시도 기록이 없습니다/);
  });
  it('시도별 결과를 나열한다 — 시한 초과·값 없음·실패를 구분하고 사유를 앞에 둔다', () => {
    const r = versionCellInfo({ version: '', extra: { missingCmds: { version: 'uemcli /sys/soft/ver show: 실행은 됐지만 원하는 값이 없습니다(다음 후보로 넘어감).' }, versionAttempts: [
      { cmd: 'svc_diag', ok: false, ms: 17001, timedOut: true, head: '' },
      { cmd: 'uemcli /sys/general show -detail', ok: false, ms: 3800, head: '1:    System name = U\n      Model = Unity 480F' },
    ] } });
    expect(r.text).toBe('—'); expect(r.mark).toBe('?'); expect(r.kind).toBe('timeout');
    const lines = r.title.split('\n');
    expect(lines[0]).toMatch(/^사유: /);
    expect(lines[1]).toBe('svc_diag: 시한 초과(17초)');
    expect(lines[2]).toBe('uemcli /sys/general show -detail: 실패 · 4초 · "1:    System name = U"');
    expect(lines[3]).toMatch(/CLI 명령 원문/);
    expect(r.title).not.toMatch(/`/);
  });
});
