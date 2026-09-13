/**
 * 고아 VMDK 탐지(v2.505) — 데이터스토어에 **있지만 어떤 VM 에도 연결되지 않은** 가상디스크를 찾는다.
 *
 * 사용자 요청(2026-09-13): "VMDK 같은 파일이 VM에 연결되지 않은 상태인지 찾아내는 기능".
 *
 * ## 판정 원리
 *
 * vCenter 는 VM 마다 `layoutEx.file` 로 **그 VM 이 소유한 전 파일**(vmx·vmdk 디스크립터·flat/delta
 * 익스텐트·vswp·vmsn·nvram·로그)을 알려준다. 데이터스토어 파일 목록(`HostDatastoreBrowser`)에서
 * 이 집합을 빼면 '아무 VM 도 쓰지 않는 파일' 이 남는다. 이것이 VMware 자신의 고아 디스크 점검
 * 스크립트들이 쓰는 방식과 같다.
 *
 * ## ⚠ 이 기능이 **절대 하지 않는 것** — 삭제 안전성을 단정하지 않는다
 *
 * 고아 판정은 **이 vCenter 인벤토리 기준**이다. 아래 경우들은 파일이 멀쩡히 쓰이고 있는데도
 * '소유자 없음' 으로 보이므로, 전부 별도 분류하고 **삭제해도 된다고 말하지 않는다**:
 *
 *  1. **다른 vCenter 가 등록한 VM** — 데이터스토어를 두 vCenter 가 공유하면(운영에서 흔하다)
 *     저쪽 VM 의 디스크가 여기서는 소유자 없이 보인다. 그래서 결과에 `sharedDatastoreWarning`
 *     을 항상 싣고, 폴더에 `.vmx` 가 있으면 '미등록 VM 폴더' 로 따로 뺀다.
 *  2. **FCD / 개선된 가상 디스크**(`fcd/` 폴더, CNS·쿠버네티스 PV) — 설계상 VM 소유가 아니다.
 *     지우면 PV 가 파괴된다. 절대 고아로 세지 않는다.
 *  3. **콘텐츠 라이브러리**(`contentlib-*`) · **vSphere Replication**(`hbrdisk.*`·`.hbr`) ·
 *     **SRM 플레이스홀더** · **vSAN/VVol 네임스페이스**.
 *  4. **진행 중 작업** — 복제·마이그레이션·백업 중인 파일은 아직 소유자가 없다. 최근 수정
 *     (`recentHours`, 기본 24시간) 파일은 '판정 보류' 로 뺀다.
 *  5. **등록 해제된 정상 VM** — 의도적으로 언레지스터해 보관 중일 수 있다(폴더에 vmx 존재).
 *
 * 그래서 화면·API 는 '삭제 대상' 이 아니라 **'확인 필요 후보'** 라고 말한다. 실제 회수는 사람이
 * 각 항목을 확인한 뒤 하는 일이며, 이 기능은 삭제 API 를 제공하지 않는다(의도적).
 *
 * ## 디스크립터 + 익스텐트 묶기
 *
 * `disk.vmdk`(디스크립터, 수 KB)와 `disk-flat.vmdk`/`disk-000001-delta.vmdk`(실제 데이터)는
 * 한 논리 디스크다. 따로 세면 개수가 부풀고 회수 가능 용량이 디스크립터 크기로 보인다.
 * `logicalDiskKey()` 로 묶어 **합산 크기**를 보고한다.
 *
 * 이 파일은 **순수 함수만** 둔다(SOAP·DB 없음) — 삭제 판단 근거가 되는 로직이라 테스트로 고정한다.
 */

/** VMDK 계열 파일인가(대소문자 무시). */
export const isVmdk = (name) => /\.vmdk$/i.test(String(name || ''));

/**
 * 익스텐트(실제 데이터 파일) 접미사. 디스크립터는 이 접미사가 없다.
 *  - `-flat.vmdk`   : 씬/씩 단일 익스텐트
 *  - `-delta.vmdk`  : 스냅샷 델타(VMFS)
 *  - `-sesparse.vmdk`: 스냅샷 델타(VSAN/VVol·SEsparse)
 *  - `-s001.vmdk`   : 2GB 분할(스파스) 익스텐트
 *  - `-rdm.vmdk`/`-rdmp.vmdk` : RDM 매핑 파일
 *  - `-ctk.vmdk`    : CBT(변경 블록 추적) — 백업이 만든다. 디스크 본체가 아니다.
 */
const EXTENT_RE = /-(flat|delta|sesparse|rdm|rdmp|ctk|s\d{3,})\.vmdk$/i;
export const isExtent = (name) => EXTENT_RE.test(String(name || ''));

/** CBT 파일은 백업 산출물이라 '디스크' 로 세지 않는다(별도 표시). */
export const isCtk = (name) => /-ctk\.vmdk$/i.test(String(name || ''));

/**
 * 논리 디스크 키 — 디스크립터와 그 익스텐트를 같은 키로 묶는다(폴더 포함, 소문자).
 * `vm-1_1-000003-delta.vmdk` → `vm-1_1-000003`(스냅샷 세대는 별개 디스크로 본다:
 * 세대별로 회수 가능 여부가 다르고, 사용자가 어느 세대인지 알아야 한다).
 */
export function logicalDiskKey(folder, name) {
  const base = String(name || '').replace(/\.vmdk$/i, '').replace(/-(flat|delta|sesparse|rdm|rdmp|ctk)$/i, '').replace(/-s\d{3,}$/i, '');
  return `${String(folder || '').toLowerCase()}/${base.toLowerCase()}`;
}

/**
 * 경로 정규화 — `[ds1] folder/x.vmdk` 와 브라우저의 `folderPath`+`path` 를 같은 형태로 만든다.
 * vCenter 가 주는 문자열은 공백·대소문자·구분자 표기가 일관되지 않아 **정규화 없이 비교하면
 * 소유 중인 디스크가 고아로 잡힌다**(그러면 이 기능은 위험하다).
 *  - 소문자화(VMFS 경로는 대소문자를 구분하지 않는다)
 *  - `[ds] ` 접두의 공백 정리
 *  - 역슬래시 → 슬래시, 중복 슬래시 축약, 앞뒤 공백 제거
 */
export function normDsPath(p) {
  let s = String(p || '').trim().replace(/\\/g, '/');
  s = s.replace(/^\[\s*([^\]]*?)\s*\]\s*\/*/, (_m, ds) => `[${ds}] `);   // 접두 뒤 슬래시도 흡수
  s = s.replace(/\/{2,}/g, '/');
  s = s.replace(/\s*\/\s*/g, '/');                                       // 구분자 주변 공백
  return s.toLowerCase();
}

/**
 * `[ds] ` 접두를 떼어 **데이터스토어 안의 상대 경로**를 준다(소문자).
 * 제외 구역 판정은 이 상대 경로로 해야 한다 — 접두가 붙어 있으면 `fcd` 가 공백 뒤에 오므로
 * `(^|/)fcd` 같은 앵커가 걸리지 않는다(이 버그를 테스트가 잡았다).
 */
export function relFolder(folder) {
  return normDsPath(folder).replace(/^\[[^\]]*\]\s*/, '');
}

/**
 * 브라우저 결과 1건 → 정규화된 전체 경로. folderPath 는 보통 `[ds1] folder` 또는 `[ds1]`.
 * 데이터스토어 루트 파일은 vCenter 표기가 `[ds1] loose.vmdk`(슬래시 없음)이므로 그 형태를 맞춘다 —
 * 여기서 `/` 를 끼우면 소유 경로(`layoutEx.file`)와 문자열이 달라져 소유 판정을 놓친다.
 */
export function fullPathOf(folder, name) {
  const rel = relFolder(folder).replace(/\/+$/, '');
  const ds = /^\[([^\]]*)\]/.exec(normDsPath(folder))?.[1] ?? '';
  const nm = String(name || '').trim().toLowerCase();
  const tail = rel ? `${rel}/${nm}` : nm;
  return ds ? `[${ds}] ${tail}` : normDsPath(tail);
}

/**
 * VM 소유 파일 집합 만들기(순수). `layoutEx.file` 파싱 결과 경로 배열들을 받아 정규화 Set 으로.
 * 소유 집합은 **크게 잡는 쪽이 안전하다** — 빠뜨리면 쓰고 있는 디스크를 고아로 보고한다.
 */
export function ownedPathSet(pathLists = []) {
  const set = new Set();
  for (const list of pathLists) {
    for (const p of (list || [])) {
      const n = normDsPath(p);
      if (n) set.add(n);
    }
  }
  return set;
}

/** 폴더 경로에서 '제외 구역' 판정 — 왜 제외인지 사유를 문자열로 돌려준다(null = 제외 아님). */
export function excludedFolderReason(folder) {
  const f = relFolder(folder);            // `[ds] ` 접두를 뗀 상대 경로로 판정(아래 앵커가 걸리게)
  // FCD/개선된 가상 디스크 — CNS·쿠버네티스 PV. VM 소유가 아닌 것이 정상이다.
  if (/(^|\/)fcd(\/|$)/.test(f)) return 'fcd';
  // 콘텐츠 라이브러리
  if (/contentlib-/.test(f)) return 'contentlib';
  // vSphere Replication 대상 폴더
  if (/(^|\/)hbr[-_]?(disk|persistent)?/.test(f) || /\.hbr(\/|$)/.test(f)) return 'replication';
  // vSAN/VVol 시스템 네임스페이스 · VMFS 시스템 폴더
  if (/(^|\/)(\.vsan\.stats|\.dvsdata|\.sdd\.sf|\.vsphere-ha|\.snapshot|\.naa\.|esx\.conf)/.test(f)) return 'system';
  if (/(^|\/)\.[a-z]/.test(f)) return 'system';        // 숨김 시스템 폴더 일반
  return null;
}

/** 파일명 기준 제외 사유(null = 제외 아님). */
export function excludedNameReason(name) {
  const n = String(name || '').toLowerCase();
  if (/^hbrdisk\./.test(n)) return 'replication';       // vSphere Replication 디스크
  if (isCtk(n)) return 'ctk';                           // 백업 CBT 파일
  return null;
}

export const EXCLUDE_LABEL = {
  fcd: 'FCD(개선된 가상 디스크 · 쿠버네티스 PV) — VM 소유가 아닌 것이 정상입니다',
  contentlib: '콘텐츠 라이브러리',
  replication: 'vSphere Replication',
  system: '시스템/숨김 폴더',
  ctk: '백업 CBT(변경 블록 추적) 파일',
  recent: '최근 변경 — 복제·마이그레이션·백업이 진행 중일 수 있습니다',
  unregistered: '같은 폴더에 .vmx 가 있습니다 — 등록 해제된 VM 이거나 다른 vCenter 가 등록한 VM 일 수 있습니다',
};

/**
 * 고아 후보 판정(순수 · 이 기능의 핵심).
 *
 * @param files    parseDsSearchResults 결과 배열 [{folder,name,type,sizeBytes,modified}]
 * @param owned    ownedPathSet() 결과 Set
 * @param opts.now          기준 시각(ms)
 * @param opts.recentHours  이 시간 안에 수정된 파일은 '판정 보류'(기본 24)
 * @returns {{disks:Array, excluded:Array, summary:Object}}
 *   disks[i] = { key, folder, name, files[], sizeBytes, modified, hasVmxInFolder, verdict, reason }
 *   verdict: 'orphan' (소유 VM 없음 · vmx 도 없음) | 'unregistered' (폴더에 vmx 있음) | 'hold' (최근 변경)
 */
export function findOrphanDisks(files = [], owned = new Set(), { now = Date.now(), recentHours = 24 } = {}) {
  const recentMs = Math.max(0, Number(recentHours) || 0) * 3_600_000;
  // 폴더별 .vmx 존재 여부 — '미등록 VM 폴더' 와 '진짜 떠 있는 디스크' 를 가르는 핵심 신호.
  const vmxFolders = new Set();
  for (const f of files) {
    if (/\.vmx$/i.test(f?.name || '')) vmxFolders.add(normDsPath(f.folder));
  }
  const folderHasVmx = (folder) => vmxFolders.has(normDsPath(folder));

  const byDisk = new Map();     // logicalDiskKey -> 묶음
  const excluded = [];
  let ownedCount = 0;
  let scannedVmdk = 0;

  for (const f of files) {
    if (!f || !isVmdk(f.name)) continue;
    scannedVmdk += 1;
    const full = fullPathOf(f.folder, f.name);
    if (owned.has(full)) { ownedCount += 1; continue; }          // 소유 확인 — 보고하지 않는다

    const exReason = excludedFolderReason(f.folder) || excludedNameReason(f.name);
    if (exReason) { excluded.push({ folder: f.folder, name: f.name, sizeBytes: f.sizeBytes || 0, reason: exReason }); continue; }

    const key = logicalDiskKey(f.folder, f.name);
    let d = byDisk.get(key);
    if (!d) {
      d = {
        key, folder: f.folder, name: '', files: [], sizeBytes: 0, modifiedTs: null,
        hasVmxInFolder: folderHasVmx(f.folder),
      };
      byDisk.set(key, d);
    }
    d.files.push({ name: f.name, sizeBytes: f.sizeBytes || 0, type: f.type || '', modified: f.modified || '', extent: isExtent(f.name) });
    d.sizeBytes += f.sizeBytes || 0;
    // 표시 이름은 디스크립터(익스텐트 아닌 것) 우선 — 없으면 첫 파일.
    if (!d.name || (!isExtent(f.name) && isExtent(d.name))) d.name = f.name;
    const ts = Date.parse(f.modified || '');
    if (Number.isFinite(ts) && (d.modifiedTs == null || ts > d.modifiedTs)) d.modifiedTs = ts;
  }

  const disks = [];
  for (const d of byDisk.values()) {
    let verdict = 'orphan';
    let reason = '';
    if (recentMs > 0 && d.modifiedTs != null && now - d.modifiedTs < recentMs) {
      verdict = 'hold'; reason = EXCLUDE_LABEL.recent;
    } else if (d.hasVmxInFolder) {
      verdict = 'unregistered'; reason = EXCLUDE_LABEL.unregistered;
    }
    disks.push({ ...d, name: d.name || '(이름 없음)', verdict, reason, modified: d.modifiedTs ? new Date(d.modifiedTs).toISOString() : '' });
  }
  // 큰 것부터 — 용량 회수 검토가 주 목적이다.
  disks.sort((a, b) => b.sizeBytes - a.sizeBytes || String(a.folder).localeCompare(String(b.folder)));

  const sum = (pred) => disks.filter(pred).reduce((a, d) => a + d.sizeBytes, 0);
  return {
    disks,
    excluded: excluded.sort((a, b) => b.sizeBytes - a.sizeBytes),
    summary: {
      scannedVmdkFiles: scannedVmdk,
      ownedVmdkFiles: ownedCount,
      orphanDisks: disks.filter((d) => d.verdict === 'orphan').length,
      orphanBytes: sum((d) => d.verdict === 'orphan'),
      unregisteredDisks: disks.filter((d) => d.verdict === 'unregistered').length,
      unregisteredBytes: sum((d) => d.verdict === 'unregistered'),
      holdDisks: disks.filter((d) => d.verdict === 'hold').length,
      holdBytes: sum((d) => d.verdict === 'hold'),
      excludedFiles: excluded.length,
      excludedBytes: excluded.reduce((a, e) => a + e.sizeBytes, 0),
    },
  };
}

/**
 * 신뢰도 판정(순수) — 결과를 얼마나 믿을 수 있는가. 사용자가 이 값을 보고 행동 수준을 정한다.
 * **소유 집합이 불완전하면 결과는 쓸 수 없다**: 파일 목록이 절단됐거나(truncated) VM 소유 파일을
 * 한 건도 못 읽었으면 '신뢰 불가' 다. 그 경우에도 숫자를 보여주되 그 사실을 앞세운다.
 */
export function confidenceOf({ truncated = false, vmsQueried = 0, vmsWithLayout = 0, ownedFiles = 0, dsVmCount = 0 } = {}) {
  if (truncated) return { level: 'low', text: '파일 목록이 상한에서 절단됐습니다 — 목록에 없는 파일은 판정 대상에서 빠졌습니다(누락 가능).' };
  if (dsVmCount > 0 && vmsQueried === 0) {
    return { level: 'none', text: '이 데이터스토어를 쓰는 VM 의 파일 목록을 한 건도 읽지 못했습니다 — 고아 판정을 신뢰할 수 없습니다.' };
  }
  if (dsVmCount > 0 && vmsWithLayout < dsVmCount) {
    return { level: 'low', text: `VM ${dsVmCount}대 중 ${vmsWithLayout}대의 파일 목록만 읽었습니다 — 못 읽은 VM 의 디스크가 고아로 잡힐 수 있습니다.` };
  }
  if (ownedFiles === 0 && dsVmCount === 0) {
    return { level: 'medium', text: '이 데이터스토어에 등록된 VM 이 없습니다 — 남은 파일 전부가 후보로 나옵니다(정상일 수 있습니다).' };
  }
  return { level: 'high', text: '이 vCenter 에 등록된 VM 전부의 파일 목록과 대조했습니다.' };
}

/** 데이터스토어 공유 경고 — 항상 표시한다(끄지 말 것. 이 경고가 오삭제를 막는 마지막 줄이다). */
export const SHARED_DS_WARNING = '이 판정은 **이 vCenter 인벤토리 기준**입니다. 데이터스토어를 다른 vCenter 와 공유하고 있으면 그쪽 VM 의 디스크가 여기서는 소유자 없이 보입니다. 삭제 전에 반드시 해당 파일을 쓰는 VM 이 정말 없는지 직접 확인하세요.';
