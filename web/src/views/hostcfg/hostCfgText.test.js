// v2.699 — 호스트 구성 문구·판정. 서버 hostcfg/parse.js 와 같은 입력으로 대조한다(번들 경계라 두 벌).
import { describe, it, expect } from 'vitest';
import * as web from './hostCfgText.js';
import * as srv from '../../../../server/src/hostcfg/parse.js';

const NOW = Date.UTC(2026, 9, 5, 3, 0, 0);
const D = 86_400_000;
const HOSTS = [
  { name: 'a', hcfg: { certNotAfter: NOW - 2 * D, rebootRequired: true, services: { ssh: { running: true, policy: 'on' }, shell: { running: true }, ntpd: { running: false } }, ntpServers: ['n1'], syslogHost: '', acceptance: 'community', lockFailures: 0, mob: true, lockdown: 'disabled', shellTimeout: 0 } },
  { name: 'b', hcfg: { certNotAfter: NOW + 10 * D, ntpServers: [], syslogHost: null, lockFailures: null, shellTimeout: null } },
  { name: 'c', connectionState: 'DISCONNECTED', hcfg: { rebootRequired: true } },
  { name: 'd' },
  { name: 'e', hcfg: { certNotAfter: NOW + 400 * D, ntpServers: null, services: null } },
  // v2.701(A10): 단일 업링크·업링크 없음·업링크 다운·무차별 — 포트그룹 없는 표준 스위치는 판정에서 뺀다.
  { name: 'f', nics: [{ device: 'vmnic1', link: false }, { device: 'vmnic2', link: true }], hcfg: { net: {
    switches: [{ name: 'vs0', kind: 'vss', uplinks: ['vmnic0'], pgs: 1 }, { name: 'vs1', kind: 'vss', uplinks: [], pgs: 0 },
      { name: 'ds', kind: 'dvs', uplinks: ['vmnic1', 'vmnic2'], pgs: null }, { name: 'vsi', kind: 'vss', uplinks: [], pgs: 2 }],
    pgs: [{ name: 'P', vlan: 5, sw: 'vs0', promisc: true }, { name: 'Q', vlan: 6, sw: 'vs0', promisc: null }], pgsTotal: 2 } } },
];

describe('hostCfgText', () => {
  it('코드 집합 — 서버 = 웹 = 문구 키(1:1)', () => {
    expect(web.HOST_CFG_CODES).toEqual(srv.HOST_CFG_CODES);
    expect(Object.keys(web.HOST_CFG_TEXT).sort()).toEqual(Object.keys(srv.HOST_CFG_CODES).sort());
    expect(Object.keys(web.DRIFT_LABEL).sort()).toEqual(Object.keys(srv.DRIFT_FIELDS).sort());
    expect(web.CERT_WARN_DAYS).toBe(srv.CERT_WARN_DAYS);
  });
  it('판정 — 서버와 같은 입력에서 같은 결과', () => {
    for (const h of HOSTS) expect(web.hostCfgFindings(h, NOW)).toEqual(srv.hostCfgFindings(h, NOW));
  });
  it('문구에 백틱·별표 없음', () => {
    for (const t of Object.values(web.HOST_CFG_TEXT)) expect(t.title + t.fix).not.toMatch(/[`*]/);
  });
  it('hostCfgRows — 미수집은 none, 모르는 값은 —', () => {
    expect(web.hostCfgRows({ name: 'x' }).state).toBe('none');
    const r = web.hostCfgRows({ name: 'x', hcfg: { at: NOW, syslogHost: null, lockFailures: null, ntpServers: null } }, NOW);
    expect(r.rows.find((x) => x.label === 'syslog 대상').value).toBe('—');
    expect(r.rows.find((x) => x.label === '로그인 실패 잠금').value).toBe('—');
    expect(r.rows.find((x) => x.label === '재부팅 필요').value).toBe('—');
  });
  it('coverageNote — 전부 미수집 / 수집 꺼짐 / 끊긴 호스트는 분모에서 뺀다', () => {
    expect(web.coverageNote({ hosts: 3, cfg: 0, notCollected: 2, disconnected: 1 })).toMatch(/읽은 호스트가 없습니다/);
    expect(web.coverageNote({ hosts: 3, cfg: 0, notCollected: 3, disconnected: 0 }, { enabled: false })).toMatch(/꺼져/);
    expect(web.coverageNote({ hosts: 3, cfg: 3, notCollected: 0, disconnected: 0 })).toBeNull();
  });
});
