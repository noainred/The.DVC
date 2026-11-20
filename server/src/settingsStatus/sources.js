/**
 * 설정 메뉴 상태 배지 — 사실 수집(v2.916). 판정은 grade.js 하나.
 *
 * ⚠ 규약(테스트 server/test/settingsStatus2916.test.js 가 이 파일의 원문을 대조한다):
 *   - **네트워크 · DB 를 쓰지 않는다** — 외부 호출(vCenter · SSH · SMTP · LDAP · HTTP) · SQLite · OS 방화벽 조회를 넣지 않는다.
 *     설정 화면이 열려 있는 동안 주기적으로 불린다(30 vCenter · RTT 800ms 환경에서 메뉴 배지가 이벤트 루프를 잡으면 안 된다).
 *     제외한 것: hostAccessStatus · logStatus · perfDbStats · latestAll · targetRows · buildUsageReport · listBackups · testConnection 류.
 *     정직 기록(반증 D6): 각 모듈 로더가 **설정 파일을 동기로 읽고 · 복호하고 · 손상 보존본을 찾으려 설정 폴더를 훑는다**(registryCore.corruptOnlyReason ·
 *     selfCheck · secretVault). 실측(30 vCenter · 30 엣지 · 암호화 모드) 따뜻한 계산 약 6ms · 첫 계산(자가진단) 약 65ms — 라우트가 3초로 합친다.
 *     게스트 비밀번호 전부를 복호하던 GPU 게스트 설정은 '켜짐' 만 읽는 gpuGuestEnabledLight 로 바꿨다.
 *   - 인증 정지 기록은 **지우는 판정(authStopFor)을 부르지 않는다** — 자격이 바뀐 기록을 지워 주 폴러가 같은 틀린 자격으로 다시 로그인하게
 *     만들 수 있다(util/authGuard.js). vCenter 는 스냅샷 collectionErrors 의 authStopped 를 세고, SMTP 는 mailStatus(내부 peek)를 쓴다.
 *   - 값을 못 읽었으면 던진다(→ 그 항목만 unknown). 0 으로 바꿔 넘기지 않는다. 로더가 손상 파일을 보존본으로 옮기고 **기본값을 돌려주는**
 *     모듈(로드 오류 표지가 없는 것)은 damaged(파일) 로 따로 본다 — 기본값의 '0개' 를 미설정으로 보이게 하지 않는다(반증 D2).
 *     72회차 F2: damaged() 는 **로더를 부른 뒤에** 본다 — 캐시 없는 로더(nsx 등)는 손상 파일을 그 호출에서 보존본으로 옮기므로, 먼저 보면
 *     손상 직후 첫 계산이 '파일 있음(손상 아님) + 0개' 로 꺼짐 · 미설정을 냈다.
 *   - 읽기가 새 파일을 만들지 않게 한다 — 인증이 꺼진 설치에서 listUsers() 는 초기 관리자 비밀번호 파일을 시드한다(반증 D4).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { store } from '../store.js';
import { corruptOnlyReason } from '../util/registryCore.js';
import { listDatacenters, datacentersLoadError } from '../datacenter/store.js';
import { listRegistry as listVcenters, registryLoadError as vcRegistryLoadError } from '../vcenter/registry.js';
import { listRegistry as listNsx, registryLoadError as nsxRegistryLoadError } from '../nsx/registry.js';
import { listHorizon, horizonLoadError } from '../horizon/horizon.js';
import { registryLoadError as idracLoadError } from '../idrac/registry.js';
import { listServers as listVeeam, registryLoadError as veeamLoadError } from '../veeam/registry.js';
import { loadSettings as loadBareos, settingsLoadError as bareosLoadError } from '../bareos/settings.js';
import { loadBackupSettings, backupSettingsReadError } from '../backup/settings.js';
import { storageIntervalsLoadError } from '../storage/intervals.js';
import { loadVmSeriesSettings, vmSeriesSettingsLoadError } from '../vmseries/settings.js';
import { loadPerfSettings, perfSettingsLoadError } from '../sanswitch/perfSettings.js';
import { loadSettings as loadIsidu, isiduSettingsLoadError } from '../isidu/settings.js';
import { load as loadDirUsage, settingsLoadError as dirUsageLoadError } from '../dirusage/settings.js';
import { settingsLoadError as guestPartLoadError } from '../guestpart/settings.js';
import { load as loadGuestDisk, settingsLoadError as guestDiskLoadError } from '../guestdisk/settings.js';
import { gpuGuestEnabledLight } from '../gpu/settings.js';
import { listCollectors, registryLoadErrorSummary } from '../collector/registry.js';
import { getConfigSafe as proxyConfig, listProxiesSafe, registryReadError as proxyReadError } from '../proxy/registry.js';
import { adTransportStatus, adConfigReadError } from '../auth/ad.js';
import { loadSecretsPolicy } from '../security/secretVault.js';
import { loadHostAccess, hostAccessWriteRefusal } from '../hostaccess/settings.js';
import { peerTrustStatus } from '../security/peerTrust.js';
import { collectSelfCheck } from '../security/selfCheck.js';
import { listUsers } from '../auth/auth.js';
import { loadAlertConfig, alertConfigWriteRefusal } from '../alerts.js';
import { mailStatus } from '../mail/service.js';
import { mailSettingsLoadError } from '../mail/settings.js';
import { loadLlmConfig, llmConfigWriteRefusal } from '../llm/config.js';
import { upgradeManager } from '../upgrade/manager.js';
import { upgradeSettingsWriteRefusal } from '../upgrade/settings.js';

const len = (a) => { if (!Array.isArray(a)) throw new Error('not-a-list'); return a.length; };
/**
 * 설정 파일이 없고 손상 보존본(<파일>.corrupt.<시각>)만 있는가 — 로더가 손상본을 옮기고 기본값으로 시작한 상태.
 * v2.932(점검 D1-01): 통신 점검 카탈로그(linkcheck/settingsLinks.js)도 load-error 표지가 없는 등록부에 이 판정을 쓴다 — 복제하지 않게 내보낸다.
 */
export const damaged = (name) => { const f = path.join(config.configDir, name); return !fs.existsSync(f) && !!corruptOnlyReason(f); };

/** 키 → 사실 함수. grade.js RULES 와 같은 키. */
export function settingsStatusSources({ now = Date.now() } = {}) {
  return {
    /*
     * 123회차(메인 수정 반증 — 형제 전수 · 재현: 파일 자리에 폴더 = EISDIR): vCenter · NSX 만 고쳐져 있었다 — 아래 항목들은 설정 파일 **읽기 오류** 동안
     *   로더가 주는 기본값 · 빈 목록(또는 마지막으로 읽은 값)을 그대로 실어 '등록된 법인 없음 · 정기 백업 꺼짐 · 리포트 대상 없음 · 꺼짐 · 사용 안 함 · 알림 채널 없음 ·
     *   SMTP 미설정' 이라고 말했다(damaged() 는 '파일 없음 + 손상 보존본' 만 본다 — 읽기 오류는 파일이 그대로 있다). 각 모듈의 읽기 오류 표지를 연결한다:
     *   읽기 오류면 readError(판정은 grade.js 공통 규칙 — '읽기 오류 · 원본은 그대로')와 loadError 를 싣고, 건수 · 켜짐 값은 싣지 않는다(null). 로더를 먼저 부른다(72회차 F2).
     */
    'datacenter-admin': () => { const le = datacentersLoadError(); const loadError = damaged('datacenters.json') || !!le; return { count: loadError ? null : len(listDatacenters()), loadError, readError: le?.readError === true }; },
    'vcenter-admin': () => {
      const errs = store.get()?.collectionErrors;
      // 118회차 메인(Chromium 판독): 등록부를 **읽지 못한 동안**(읽기 오류 — 원본은 그대로)에도 건수 0 으로 '등록된 vCenter 없음 · 미설정' 배지가 붙어,
      //   같은 화면의 '읽지 못했습니다 — 등록된 vCenter 가 없는 것이 아닙니다' 배너와 반대로 말했다. 못 읽은 것은 0건이 아니다 — 건수를 싣지 않는다(읽기 오류 · 손상 · 보존본만 남음).
      //   읽기 오류(readError — 보존본이 없다)와 손상(보존본 확인 — v2.916 반증 D2 문구)은 가른다.
      const le = vcRegistryLoadError();
      const unread = damaged('vcenters.json') || !!le;
      const count = unread ? null : len(listVcenters());
      return { loadError: unread, readError: le?.readError === true, count, authStopped: Array.isArray(errs) ? errs.filter((e) => e && e.authStopped).length : null };
    },
    'nsx-admin': () => { const le = nsxRegistryLoadError(); const loadError = damaged('nsx.json') || !!le; return { count: loadError ? null : len(listNsx()), loadError, readError: le?.readError === true }; },   // 116회차 등록부 — 같은 규칙
    'horizon-admin': () => { const loadError = damaged('horizon.json') || !!horizonLoadError(); return { loadError, count: loadError ? null : len(listHorizon()) }; },   // 38회차 R3: 읽기 오류 · 손상 기억도
    'idrac-admin': () => ({ loadError: !!idracLoadError() }),
    veeam: () => { const loadError = !!veeamLoadError(); return { loadError, count: loadError ? null : len(listVeeam()) }; },
    bareos: () => { const loadError = !!bareosLoadError(); return { loadError, directors: loadError ? null : len(loadBareos().directors) }; },
    backup: () => { const re = !!backupSettingsReadError(); return { scheduleEnabled: re ? null : loadBackupSettings().scheduleEnabled, loadError: damaged('backup.json') || re, readError: re }; },
    'storage-intervals': () => ({ loadError: !!storageIntervalsLoadError() }),
    vmseries: () => ({ loadError: !!vmSeriesSettingsLoadError(), enabled: loadVmSeriesSettings().enabled === true }),
    'sansw-perf': () => ({ loadError: !!perfSettingsLoadError(), enabled: loadPerfSettings().enabled === true }),
    'isilon-dirusage': () => { const loadError = !!isiduSettingsLoadError(); return { loadError, targets: loadError ? null : len(loadIsidu().targets) }; },
    'dir-usage': () => { const le = dirUsageLoadError(); const loadError = damaged('dirusage.json') || !!le; return { targets: loadError ? null : len(loadDirUsage().targets), loadError, readError: le?.readError === true }; },
    'guest-partition': () => { const enabled = loadGuestDisk().enabled === true; const gd = guestDiskLoadError(); const gp = guestPartLoadError(); return { loadError: !!gp || !!gd || damaged('guest-disk.json'), readError: gp?.readError === true || gd?.readError === true, enabled }; },
    'gpu-guest': () => ({ enabled: gpuGuestEnabledLight(), loadError: damaged('gpu-guest.json') }),
    collectors: () => { const loadError = !!registryLoadErrorSummary(); return { loadError, count: loadError ? null : len(listCollectors()) }; },
    // listProxies() 는 기본 프록시를 늘 첫 줄에 넣는다(proxy/registry.js) — 추가로 등록한 프록시만 센다(반증 D3).
    // 72회차 F2: remote-access.json 이 손상돼 보존본만 남으면 로더가 기본값(중계 서버 없음)을 돌려준다 — '꺼짐' 이 아니라 주의다.
    // 79회차 반증: 읽기 오류(76 F5 — 원본 그대로 · 빈 설정으로 돈다)도 주의 — 예전 판정(손상 보존본만)으로는 '중계 서버 0 · 꺼짐' 으로 보였다.
    //   ⚠ 로드(proxyReadError)를 damaged 보다 먼저 — 첫 계산에서 손상본을 보존본으로 옮긴 뒤에 '보존본만 남음' 을 본다(portalMiscAudit72 F2).
    proxy: () => { const rre = !!proxyReadError(); const loadError = damaged('remote-access.json') || rre; return { proxyHost: loadError ? '' : String(proxyConfig().proxyHost || '').trim(), proxies: loadError ? null : len(listProxiesSafe()), loadError, readError: rre }; },   // 123회차: 읽기 오류에 '손상 보존본 확인' 이라고 말하지 않는다(보존본이 없다)
    'auth-ad': () => { const t = adTransportStatus(); const re = !!adConfigReadError(); return { enabled: !!t.enabled, warnings: t.enabled ? len(t.warnings) : 0, loadError: damaged('auth.json') || re, readError: re }; },   // 123회차: 읽기 오류 동안은 마지막으로 읽은 값(없으면 env 기본값 — 보통 꺼짐)이다
    secrets: () => { const p = loadSecretsPolicy(); return { mode: p.mode, locked: !!p.locked, recovered: !!p.recovered }; },
    'host-access': () => {
      const p = loadHostAccess().pending;
      const dl = p ? Number(p.deadline) : NaN;
      // 72회차 F2: 손상 보존본만 남으면 로더가 기본값(적용 대기 없음)을 돌려준다 — 표시 없음(정상)으로 숨기지 않는다.
      const re = !!hostAccessWriteRefusal();   // 123회차: 읽기 오류 동안 pending 은 null 이다 — '적용 대기 없음(표시 없음)' 이 아니다(115회차 R1)
      return { pendingOverdue: !!p && Number.isFinite(dl) && dl < now, loadError: damaged('host-access.json') || re, readError: re };
    },
    'peer-trust': () => {
      const st = peerTrustStatus();
      if (st.loadError) return { loadError: true };
      let pending = 0; let changed = 0;
      for (const k of Object.values(st.kinds || {})) { pending += Number(k?.counts?.pending) || 0; changed += Number(k?.counts?.pendingChanged) || 0; }
      return { loadError: false, pending, changed };
    },
    'security-self-check': () => {
      let users = null;
      // 인증이 꺼진 설치에서는 부르지 않는다 — loadUsers 가 users.json 이 없으면 기본 관리자와 초기 비밀번호 파일을 만든다(반증 D4).
      try { users = config.auth.enabled ? listUsers() : null; } catch { users = null; }   // 못 읽으면 자가진단이 그 점검을 unknown 으로 둔다
      const { summary } = collectSelfCheck({ users });
      return { risk: summary?.risk, warn: summary?.warn, unknown: summary?.unknown };
    },
    alerts: () => {
      const ch = loadAlertConfig().channels || {};
      const re = !!alertConfigWriteRefusal();   // 123회차: 읽기 오류 동안 설정은 기본값(채널 꺼짐)이다 — '알림 채널 없음' 이 아니다
      return { loadError: damaged('alerts.json') || re, readError: re, channels: re ? null : Object.values(ch).filter((c) => c && c.enabled === true).length };
    },
    mail: () => { const s = mailStatus(); const le = mailSettingsLoadError(); return { loadError: damaged('mail.json') || !!le, readError: le?.readError === true, configured: le ? null : s.configured, authStopped: !!s.authStopped }; },   // 123회차: 못 읽은 설정은 'SMTP 미설정' 이 아니다
    'ai-search': () => { const enabled = loadLlmConfig().enabled === true; const re = !!llmConfigWriteRefusal(); return { enabled, loadError: damaged('llm.json') || re, readError: re }; },   // 123회차: 읽기 오류 동안은 마지막으로 읽은 값(없으면 env 기본값)이다
    diagnostics: () => { const e = store.get()?.collectionErrors; return { collectionErrors: len(e) }; },
    upgrade: () => {
      const s = upgradeManager.status();
      const c = s.lastCheck || {};
      const remote = c.remote?.available === true; const watch = c.watch?.available === true;
      return {
        available: remote || watch,
        latest: remote ? c.remote.latest : (watch ? c.watch.version : null),
        remoteConfigured: !!s.remoteConfigured,
        watchDir: !!String(s.watchDir || '').trim(),
        // 72회차 F2: upgrade.json 이 손상돼 보존본만 남으면 로더가 환경 변수 기본값으로 돌아간다 — '업그레이드 소스 없음(미설정)' 이 아니라 주의다.
        loadError: damaged('upgrade.json') || !!upgradeSettingsWriteRefusal(),
        readError: !!upgradeSettingsWriteRefusal(),   // 123회차: 읽기 오류 동안은 마지막으로 읽은 값(없으면 env 기본값)이다 — '업그레이드 소스 없음' 이 아니다
      };
    },
  };
}
