// v2.878(사용자 요청 'Bareos 의 설정을 전체 메뉴 설정으로 위치 변경 — B안'): Backup › Bareos › 설정 탭 → 설정 › 🖥️ vCenter 관리 › Bareos 백업 서버.
//   ① 설정 화면을 열 수 있는 계정에게는 Bareos 탭 줄에 '설정' 을 그리지 않는다 · 못 여는 관리자(설정 소유 계정 아님)는 예전 자리를 그대로 쓴다
//   ② 옛 주소는 구획 그대로 새 주소로(북마크) ③ 설정 화면의 백업 묶음(v2.902 — 예전 vCenter 관리 묶음)에 'bareos' 하위 키 · 도구 권한으로 보인다
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { stripComments } from '../../test/_stripComments.js';
import { bareosSubTabs, settingsHomeOk, legacySettingsHash, BAREOS_SETTINGS_HASH, BAREOS_SETTINGS_KEY } from './bareosViewText.js';

const read = (p) => stripComments(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const ALL = { summaryOk: true, detailOk: true, manageOk: true, admin: true, fullScope: true };

describe('Bareos 설정 자리 옮김(v2.878)', () => {
  it('설정 화면을 열 수 있으면 Bareos 탭 줄에 설정이 없다 · 못 열면 예전 자리 그대로', () => {
    expect(bareosSubTabs({ ...ALL, settingsHome: true }).map((t) => t[0])).toEqual(['summary', 'detail', 'ops', 'policy']);
    expect(bareosSubTabs({ ...ALL, settingsHome: false }).map((t) => t[0])).toEqual(['summary', 'detail', 'ops', 'policy', 'settings']);
  });
  it('settingsHomeOk — App 의 설정 탭 게이트와 같은 조건(관리자 + 설정 소유 계정)', () => {
    expect(settingsHomeOk(null)).toBe(false);
    expect(settingsHomeOk({ role: 'operator', isSettingsOwner: true })).toBe(false);
    expect(settingsHomeOk({ role: 'admin', name: 'kim' })).toBe(false);
    expect(settingsHomeOk({ role: 'admin', name: 'kim', isSettingsOwner: 'true' })).toBe(false);   // 불리언 true 만
    expect(settingsHomeOk({ role: 'admin', name: 'kim', isSettingsOwner: true })).toBe(true);
    expect(settingsHomeOk({ role: 'admin', name: 'Anonymous' })).toBe(true);   // 인증 꺼짐(App isSettingsOwner 와 같다)
  });
  it('옛 주소 → 새 주소(구획 유지) · 옛 주소가 아니면 null', () => {
    expect(BAREOS_SETTINGS_HASH).toBe('#/settings/bareos');
    expect(legacySettingsHash('#/tools/bareos-backup/settings')).toBe('#/settings/bareos');
    expect(legacySettingsHash('#/tools/bareos-backup/settings/install')).toBe('#/settings/bareos/install');
    expect(legacySettingsHash('#/tools/bareos-backup/settings/corp/x')).toBe('#/settings/bareos/corp/x');
    expect(legacySettingsHash('#/tools/bareos-backup/targets')).toBe(null);
    expect(legacySettingsHash('#/settings/bareos')).toBe(null);
    expect(legacySettingsHash('')).toBe(null);
  });
  it('설정 화면 — 백업 묶음(v2.902 재배치)에 bareos 하위 키(도구 권한으로 보임) · 본문은 BareosSettingsPage', () => {
    const s = read('../Settings.jsx');
    expect(s).toMatch(new RegExp(`\\{ k: '${BAREOS_SETTINGS_KEY}', label: 'Bareos 백업 서버', C: BareosSettingsPage, group: 'backups', show: \\(\\) => toolAllowed\\('bareos-backup'\\) \\}`));
    expect(s).toMatch(/\(!s\.show \|\| s\.show\(\)\)/);   // visibleSubs 가 show 를 본다
    const page = read('../BareosSettingsPage.jsx');
    expect(page).toMatch(/toolAllowed\('bareos-backup'\) && fullScope/);   // 도구 권한 + 전체 범위(서버 fullScopeOnly 와 같은 화면 게이트)
    expect(page).not.toMatch(/usePolling/);   // 설정 화면은 들어올 때 1번 + 저장 뒤에만 읽는다
  });
  it('구획 주소는 새 자리가 기본 · 예전 자리에서는 옛 base 를 넘긴다 · 옛 주소는 replace 로 넘긴다', () => {
    const st = read('./BareosSettings.jsx');
    expect(st).toMatch(/SETTINGS_HASH_BASE = Object\.freeze\(\['settings', 'bareos'\]\)/);
    expect(st).toMatch(/useHashTab\(\{ base: hashBase,/);
    const tool = read('./BareosBackupTool.jsx');
    expect(tool).toMatch(/hashBase=\{LEGACY_SETTINGS_BASE\}/);
    expect(tool).toMatch(/window\.location\.replace\(moveTo\)/);
    expect(tool).toMatch(/settingsHomeOk\(me\)/);
    expect(read('./BareosTabs.jsx')).toMatch(/settingsHome: settingsHomeOk\(me\)/);
  });
});
