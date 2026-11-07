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
 *   - 읽기가 새 파일을 만들지 않게 한다 — 인증이 꺼진 설치에서 listUsers() 는 초기 관리자 비밀번호 파일을 시드한다(반증 D4).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { store } from '../store.js';
import { corruptOnlyReason } from '../util/registryCore.js';
import { listDatacenters } from '../datacenter/store.js';
import { listRegistry as listVcenters } from '../vcenter/registry.js';
import { listRegistry as listNsx } from '../nsx/registry.js';
import { listHorizon } from '../horizon/horizon.js';
import { registryLoadError as idracLoadError } from '../idrac/registry.js';
import { listServers as listVeeam, registryLoadError as veeamLoadError } from '../veeam/registry.js';
import { loadSettings as loadBareos, settingsLoadError as bareosLoadError } from '../bareos/settings.js';
import { loadBackupSettings } from '../backup/settings.js';
import { storageIntervalsLoadError } from '../storage/intervals.js';
import { loadVmSeriesSettings, vmSeriesSettingsLoadError } from '../vmseries/settings.js';
import { loadPerfSettings, perfSettingsLoadError } from '../sanswitch/perfSettings.js';
import { loadSettings as loadIsidu, isiduSettingsLoadError } from '../isidu/settings.js';
import { load as loadDirUsage } from '../dirusage/settings.js';
import { settingsLoadError as guestPartLoadError } from '../guestpart/settings.js';
import { load as loadGuestDisk } from '../guestdisk/settings.js';
import { gpuGuestEnabledLight } from '../gpu/settings.js';
import { listCollectors, registryLoadErrorSummary } from '../collector/registry.js';
import { getConfigSafe as proxyConfig, listProxiesSafe } from '../proxy/registry.js';
import { adTransportStatus } from '../auth/ad.js';
import { loadSecretsPolicy } from '../security/secretVault.js';
import { loadHostAccess } from '../hostaccess/settings.js';
import { peerTrustStatus } from '../security/peerTrust.js';
import { collectSelfCheck } from '../security/selfCheck.js';
import { listUsers } from '../auth/auth.js';
import { loadAlertConfig } from '../alerts.js';
import { mailStatus } from '../mail/service.js';
import { loadLlmConfig } from '../llm/config.js';
import { upgradeManager } from '../upgrade/manager.js';

const len = (a) => { if (!Array.isArray(a)) throw new Error('not-a-list'); return a.length; };
/**
 * 설정 파일이 없고 손상 보존본(<파일>.corrupt.<시각>)만 있는가 — 로더가 손상본을 옮기고 기본값으로 시작한 상태.
 * v2.932(점검 D1-01): 통신 점검 카탈로그(linkcheck/settingsLinks.js)도 load-error 표지가 없는 등록부에 이 판정을 쓴다 — 복제하지 않게 내보낸다.
 */
export const damaged = (name) => { const f = path.join(config.configDir, name); return !fs.existsSync(f) && !!corruptOnlyReason(f); };

/** 키 → 사실 함수. grade.js RULES 와 같은 키. */
export function settingsStatusSources({ now = Date.now() } = {}) {
  return {
    'datacenter-admin': () => ({ loadError: damaged('datacenters.json'), count: len(listDatacenters()) }),
    'vcenter-admin': () => {
      const errs = store.get()?.collectionErrors;
      return { loadError: damaged('vcenters.json'), count: len(listVcenters()), authStopped: Array.isArray(errs) ? errs.filter((e) => e && e.authStopped).length : null };
    },
    'nsx-admin': () => ({ loadError: damaged('nsx.json'), count: len(listNsx()) }),
    'horizon-admin': () => ({ loadError: damaged('horizon.json'), count: len(listHorizon()) }),
    'idrac-admin': () => ({ loadError: !!idracLoadError() }),
    veeam: () => { const loadError = !!veeamLoadError(); return { loadError, count: loadError ? null : len(listVeeam()) }; },
    bareos: () => { const loadError = !!bareosLoadError(); return { loadError, directors: loadError ? null : len(loadBareos().directors) }; },
    backup: () => ({ loadError: damaged('backup.json'), scheduleEnabled: loadBackupSettings().scheduleEnabled }),
    'storage-intervals': () => ({ loadError: !!storageIntervalsLoadError() }),
    vmseries: () => ({ loadError: !!vmSeriesSettingsLoadError(), enabled: loadVmSeriesSettings().enabled === true }),
    'sansw-perf': () => ({ loadError: !!perfSettingsLoadError(), enabled: loadPerfSettings().enabled === true }),
    'isilon-dirusage': () => { const loadError = !!isiduSettingsLoadError(); return { loadError, targets: loadError ? null : len(loadIsidu().targets) }; },
    'dir-usage': () => ({ loadError: damaged('dirusage.json'), targets: len(loadDirUsage().targets) }),
    'guest-partition': () => ({ loadError: !!guestPartLoadError() || damaged('guest-disk.json'), enabled: loadGuestDisk().enabled === true }),
    'gpu-guest': () => ({ loadError: damaged('gpu-guest.json'), enabled: gpuGuestEnabledLight() }),
    collectors: () => { const loadError = !!registryLoadErrorSummary(); return { loadError, count: loadError ? null : len(listCollectors()) }; },
    // listProxies() 는 기본 프록시를 늘 첫 줄에 넣는다(proxy/registry.js) — 추가로 등록한 프록시만 센다(반증 D3).
    proxy: () => ({ proxyHost: String(proxyConfig().proxyHost || '').trim(), proxies: len(listProxiesSafe()) }),
    'auth-ad': () => { const t = adTransportStatus(); return { loadError: damaged('auth.json'), enabled: !!t.enabled, warnings: t.enabled ? len(t.warnings) : 0 }; },
    secrets: () => { const p = loadSecretsPolicy(); return { mode: p.mode, locked: !!p.locked, recovered: !!p.recovered }; },
    'host-access': () => {
      const p = loadHostAccess().pending;
      const dl = p ? Number(p.deadline) : NaN;
      return { pendingOverdue: !!p && Number.isFinite(dl) && dl < now };
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
      return { loadError: damaged('alerts.json'), channels: Object.values(ch).filter((c) => c && c.enabled === true).length };
    },
    mail: () => { const s = mailStatus(); return { loadError: damaged('mail.json'), configured: s.configured, authStopped: !!s.authStopped }; },
    'ai-search': () => ({ loadError: damaged('llm.json'), enabled: loadLlmConfig().enabled === true }),
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
      };
    },
  };
}
