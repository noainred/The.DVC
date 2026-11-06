/**
 * 설정 메뉴 상태 배지 — 사실 수집(v2.916). 판정은 grade.js 하나.
 *
 * ⚠ 규약(테스트 server/test/settingsStatus2916.test.js 가 이 파일의 원문을 대조한다):
 *   - **파일 · 메모리 값만** 읽는다. 외부 호출(vCenter · SSH · SMTP · LDAP · HTTP)·SQLite·디렉터리 훑기·OS 방화벽 조회는 넣지 않는다 —
 *     설정 화면이 열려 있는 동안 주기적으로 불린다(30 vCenter · RTT 800ms 환경에서 메뉴 배지가 이벤트 루프를 잡으면 안 된다).
 *     제외한 것: hostAccessStatus · logStatus · perfDbStats · latestAll · targetRows · buildUsageReport · listBackups · testConnection 류.
 *   - 인증 정지 기록은 **지우는 판정(authStopFor)을 부르지 않는다** — 자격이 바뀐 기록을 지워 주 폴러가 같은 틀린 자격으로 다시 로그인하게
 *     만들 수 있다(util/authGuard.js). vCenter 는 스냅샷 collectionErrors 의 authStopped 를 세고, SMTP 는 mailStatus(내부 peek)를 쓴다.
 *   - 값을 못 읽었으면 던진다(→ 그 항목만 unknown). 0 으로 바꿔 넘기지 않는다.
 */
import { store } from '../store.js';
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
import { loadGpuGuestSettings } from '../gpu/settings.js';
import { listCollectors, registryLoadErrorSummary } from '../collector/registry.js';
import { getConfigSafe as proxyConfig, listProxies } from '../proxy/registry.js';
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

/** 키 → 사실 함수. grade.js RULES 와 같은 키. */
export function settingsStatusSources({ now = Date.now() } = {}) {
  return {
    'datacenter-admin': () => ({ count: len(listDatacenters()) }),
    'vcenter-admin': () => {
      const errs = store.get()?.collectionErrors;
      return { count: len(listVcenters()), authStopped: Array.isArray(errs) ? errs.filter((e) => e && e.authStopped).length : null };
    },
    'nsx-admin': () => ({ count: len(listNsx()) }),
    'horizon-admin': () => ({ count: len(listHorizon()) }),
    'idrac-admin': () => ({ loadError: !!idracLoadError() }),
    veeam: () => { const loadError = !!veeamLoadError(); return { loadError, count: loadError ? null : len(listVeeam()) }; },
    bareos: () => { const loadError = !!bareosLoadError(); return { loadError, directors: loadError ? null : len(loadBareos().directors) }; },
    backup: () => ({ scheduleEnabled: loadBackupSettings().scheduleEnabled }),
    'storage-intervals': () => ({ loadError: !!storageIntervalsLoadError() }),
    vmseries: () => ({ loadError: !!vmSeriesSettingsLoadError(), enabled: loadVmSeriesSettings().enabled === true }),
    'sansw-perf': () => ({ loadError: !!perfSettingsLoadError(), enabled: loadPerfSettings().enabled === true }),
    'isilon-dirusage': () => { const loadError = !!isiduSettingsLoadError(); return { loadError, targets: loadError ? null : len(loadIsidu().targets) }; },
    'dir-usage': () => ({ targets: len(loadDirUsage().targets) }),
    'guest-partition': () => ({ loadError: !!guestPartLoadError(), enabled: loadGuestDisk().enabled === true }),
    'gpu-guest': () => ({ enabled: loadGpuGuestSettings().enabled === true }),
    collectors: () => { const loadError = !!registryLoadErrorSummary(); return { loadError, count: loadError ? null : len(listCollectors()) }; },
    proxy: () => ({ proxyHost: String(proxyConfig().proxyHost || '').trim(), proxies: len(listProxies()) }),
    'auth-ad': () => { const t = adTransportStatus(); return { enabled: !!t.enabled, warnings: t.enabled ? len(t.warnings) : 0 }; },
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
      try { users = listUsers(); } catch { users = null; }   // 못 읽으면 자가진단이 그 점검을 unknown 으로 둔다
      const { summary } = collectSelfCheck({ users });
      return { risk: summary?.risk, warn: summary?.warn };
    },
    alerts: () => {
      const ch = loadAlertConfig().channels || {};
      return { channels: Object.values(ch).filter((c) => c && c.enabled === true).length };
    },
    mail: () => { const s = mailStatus(); return { configured: s.configured, authStopped: !!s.authStopped }; },
    'ai-search': () => ({ enabled: loadLlmConfig().enabled === true }),
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
