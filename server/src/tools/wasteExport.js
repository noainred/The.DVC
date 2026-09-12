/**
 * tools/wasteExport.js — 낭비 리소스 화면 표를 **엑셀 시트 모델**로(순수, v2.497).
 *
 * 사용자 요구: "vCenter 별 전체 현황을 엑셀로 export — 이 표를 그대로 출력하고, 근거/리포트 파일을
 * 엑셀에서 클릭하면 볼 수 있게 첨부파일로 모두 만들어 줘".
 *
 * 여기서는 exceljs 를 모르는 **시트 모델**(이름·열·행·주석)만 만든다 — 웹 테스트가 node 환경이듯
 * 서버도 워크북 바이너리 없이 열·행·하이퍼링크 대상을 회귀로 고정하기 위해서다. 워크북 변환은
 * wasteExportXlsx.js(sheetsToWorkbook), ZIP 조립·vCenter 조회는 라우트가 한다.
 *
 * 시트 구성(화면 하위 탭 1:1): 요약 · 전원 꺼짐 · 스냅샷 · Tools 미실행 · CPU 과할당 · 메모리 과할당.
 * CPU/메모리 시트의 '근거 리포트' 셀은 ZIP 안 `reports/<file>.html` 을 가리키는 **상대 하이퍼링크**다 —
 * ZIP 을 풀고 xlsx 를 열어야 링크가 동작한다(요약 시트에 명시). 같은 VM 이 CPU·메모리 양쪽에 있으면
 * 리포트 파일은 하나만 만들고 두 시트가 같은 파일을 가리킨다(reportFileName 이 VM id 기준).
 *
 * 파일명은 ASCII 로 제한한다 — exceljs 는 하이퍼링크 Target 을 퍼센트 인코딩 없이 기록하므로(실측)
 * 한글·공백이 들어가면 Excel 이 링크를 못 열 수 있다(추정). VM 이름은 슬러그 + id 해시 8자리로 구분.
 */
import crypto from 'node:crypto';

/** 셀 값 규약: 문자열/숫자/null 또는 { text, hyperlink, tooltip }(링크 셀). */
export const LINK = (text, hyperlink, tooltip = '') => ({ text, hyperlink, tooltip });

const asciiSlug = (s) => String(s || '').normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'vm';
const hash8 = (s) => crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 8);

/** ZIP 안 리포트 파일 경로(xlsx 기준 상대). VM id 로만 정해지므로 CPU·메모리 시트가 같은 파일을 가리킨다. */
export function reportFileName(vm) {
  return `reports/${asciiSlug(vm?.name)}-${hash8(vm?.id)}.html`;
}

/** ZIP 파일명(ASCII — 웹 downloadFile 이 filename="…" 만 파싱한다). scope 는 vCenter id 또는 'all'. */
export function exportZipName({ scope = 'all', cluster = '', folder = '', at = Date.now() } = {}) {
  const d = new Date(at);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const parts = ['waste', asciiSlug(scope || 'all')];
  if (cluster) parts.push(asciiSlug(cluster));
  if (folder) parts.push(asciiSlug(folder));
  parts.push(stamp);
  return `${parts.join('-')}.zip`;
}

const r1 = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Math.round(Number(x) * 10) / 10);
const r2 = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Math.round(Number(x) * 100) / 100);
const fmtDate = (ms) => { const d = new Date(ms); return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : ''; };
const OFF_SRC = { event: '이벤트', observed: '점검', track: '추적', first_seen: '관측 시작' };

/**
 * 리포트 결과 → '판정'·'근거 리포트' 두 셀.
 * rep: { file, verdict:{state,title,summary} } | { error } | { skipped } | undefined
 */
function reportCells(vm, rep) {
  if (!rep) return { verdict: '—', link: '리포트 없음' };
  if (rep.error) return { verdict: `조회 실패: ${rep.error}`, link: '리포트 없음(조회 실패)' };
  if (rep.skipped) return { verdict: `리포트 생략(${rep.skipped})`, link: '리포트 없음(상한)' };
  const title = rep.verdict?.title || '';
  const sum = rep.verdict?.summary || '';
  return { verdict: sum ? `${title} — ${sum}` : title, link: LINK('📊 리포트 열기', rep.file, `${vm.name} 근거 리포트(HTML) — ZIP 을 풀고 xlsx 를 열어야 링크가 동작합니다`) };
}

/**
 * 시트 모델 생성.
 * @param {object} p
 * @param {object} p.waste     /tools/waste 응답(전량 또는 화면과 같은 상위 N)
 * @param {object} [p.offSince] /tools/waste/off-since 응답 { rows:[{id, offSince, offDays, source, exact}], sources } | null
 * @param {Map<string, object>} [p.reports] vmId → { file, verdict } | { error } | { skipped }
 * @param {string} [p.scopeLabel] 'all' | vCenter id
 * @param {string} [p.cluster] [p.folder] 하위 범위
 * @param {number} [p.days]  리포트 관측 일수
 * @param {boolean} [p.full] 상위 N 절단 없이 전량인지
 * @param {number} [p.generatedAt]
 * @param {string} [p.reportNote] 리포트 생성 요약(예: 'vCenter 조회 실패 1건')
 */
export function buildWasteSheets({ waste = {}, offSince = null, reports = new Map(), scopeLabel = 'all', cluster = '', folder = '', days = 30, full = false, generatedAt = Date.now(), reportNote = '', nameFilter = '' } = {}) {
  const oa = waste.overAllocated || {};
  const offById = new Map((offSince?.rows || []).map((x) => [x.id, x]));
  const sheets = [];

  // 요약 — KPI + vCenter 별 현황(사용자 요구 'vCenter 별 전체 현황').
  const byVc = Array.isArray(waste.byVcenter) ? waste.byVcenter : [];
  const kpi = [
    ['생성 시각', `${fmtDate(generatedAt)} ${new Date(generatedAt).toTimeString().slice(0, 5)}`],
    ['범위', `${scopeLabel === 'all' ? '전체 vCenter' : `vCenter ${scopeLabel}`}${cluster ? ` · 클러스터 ${cluster}` : ''}${folder ? ` · 폴더 ${folder}` : ''}`],
    ['행 범위', full ? '전량(상위 N 절단 없음)' : '화면 표와 동일(전원 꺼짐 상위 300 · 그 외 상위 50)',
      nameFilter ? `VM 이름 검색 '${nameFilter}' 적용 — 아래 KPI·vCenter 별 현황은 화면과 같이 전체 기준입니다(표만 걸렀습니다)` : ''],
    ['전원 꺼진 VM', waste.poweredOff?.count ?? 0, `스토리지 ${r1(waste.poweredOff?.storageGB) ?? 0} GB 점유`],
    ['스냅샷 보유 VM', waste.snapshots?.count ?? 0, `${r1(waste.snapshots?.sizeGB) ?? 0} GB`],
    ['Thin 회수가능(추정)', `${r1(waste.thinReclaim?.reclaimableGB) ?? 0} GB`, `${waste.thinReclaim?.count ?? 0} VM`],
    ['Tools 미실행(On)', waste.noTools?.count ?? 0],
    ...(oa.cpu ? [['미사용 CPU clock', `${oa.cpu.idleGHz} GHz`, `할당 ${oa.cpu.allocGHz} · 사용 ${oa.cpu.usedGHz} GHz → 절감 가능 ${oa.cpu.savingPct}% · 후보 ${oa.cpu.candidates}`]] : []),
    ...(oa.mem ? [['미사용 메모리', `${oa.mem.idleGB} GB`, `할당 ${oa.mem.allocGB} · 사용 ${oa.mem.usedGB} GB → 절감 가능 ${oa.mem.savingPct}% · 후보 ${oa.mem.candidates}`]] : []),
    ['근거 리포트', `최근 ${days}일 vCenter 롤업 기준 · CPU/메모리 과할당 시트의 '근거 리포트' 열 클릭`, reportNote || ''],
    ['안내', 'ZIP 을 압축 해제한 뒤 xlsx 를 열어야 리포트 링크(reports/*.html)가 동작합니다. 리포트는 브라우저로 열립니다.'],
  ];
  sheets.push({
    name: '요약',
    columns: [{ header: '항목', key: 'k', width: 22 }, { header: '값', key: 'v', width: 44 }, { header: '비고', key: 'n', width: 70 }],
    rows: kpi.map(([k, v, n]) => ({ k, v, n: n ?? '' })),
    section: byVc.length ? {
      title: 'vCenter 별 현황',
      columns: [
        { header: 'vCenter', key: 'vcenterId', width: 22 }, { header: 'VM 수', key: 'vms', width: 9 }, { header: '전원 꺼짐', key: 'poweredOff', width: 10 },
        { header: '꺼진 VM 스토리지(GB)', key: 'poweredOffGB', width: 18 }, { header: '스냅샷 보유', key: 'snapshots', width: 11 }, { header: '스냅샷(GB)', key: 'snapshotGB', width: 11 },
        { header: 'Tools 미실행', key: 'noTools', width: 12 }, { header: 'Thin 회수가능(GB)', key: 'thinReclaimGB', width: 16 },
        { header: 'CPU 과할당 후보', key: 'cpuCandidates', width: 15 }, { header: '메모리 과할당 후보', key: 'memCandidates', width: 17 },
      ],
      rows: byVc.map((x) => ({ ...x, poweredOffGB: r1(x.poweredOffGB), snapshotGB: r1(x.snapshotGB), thinReclaimGB: r1(x.thinReclaimGB) })),
    } : null,
  });

  // 전원 꺼짐
  sheets.push({
    name: '전원 꺼짐',
    columns: [
      { header: 'VM', key: 'name', width: 34 }, { header: 'vCenter', key: 'vcenterId', width: 20 }, { header: 'OS', key: 'guestOS', width: 30 },
      { header: '스토리지(GB)', key: 'storageGB', width: 13 }, { header: '꺼진 지(일)', key: 'offDays', width: 11 }, { header: '꺼진 시각', key: 'offSince', width: 12 },
      { header: '정확도', key: 'exact', width: 8 }, { header: '출처', key: 'source', width: 10 },
    ],
    rows: (waste.poweredOff?.vms || []).map((v) => { const o = offById.get(v.id); return {
      name: v.name, vcenterId: v.vcenterId, guestOS: v.guestOS || '', storageGB: r1(v.storageGB),
      offDays: o?.offDays ?? null, offSince: o?.offSince ? fmtDate(o.offSince) : '', exact: o ? (o.exact ? '정확' : '≥ 하한') : '', source: o ? (OFF_SRC[o.source] || o.source || '') : '',
    }; }),
    notes: [
      `전원 꺼진 VM ${waste.poweredOff?.count ?? 0}대 중 ${(waste.poweredOff?.vms || []).length}행.`,
      '꺼진 지 출처 — 이벤트: vCenter 전원 이벤트(정확) · 점검: 전원 꺼짐 점검 주기에서 관측(하한) · 추적: VM 추적 12시간 슬롯(하한) · 관측 시작: 추적 시작부터 계속 꺼짐(하한). 빈 칸은 세 출처 모두 없음.',
      ...(offSince?.error ? [`꺼진 시각 조회 실패: ${offSince.error}`] : []),
    ],
  });

  // 스냅샷
  sheets.push({
    name: '스냅샷',
    columns: [{ header: 'VM', key: 'name', width: 34 }, { header: 'vCenter', key: 'vcenterId', width: 20 }, { header: '개수', key: 'snapshotCount', width: 8 }, { header: '크기(GB)', key: 'snapshotSizeGB', width: 11 }],
    rows: (waste.snapshots?.vms || []).map((v) => ({ name: v.name, vcenterId: v.vcenterId, snapshotCount: v.snapshotCount ?? null, snapshotSizeGB: r1(v.snapshotSizeGB) })),
    notes: [`스냅샷 보유 VM ${waste.snapshots?.count ?? 0}대 중 ${(waste.snapshots?.vms || []).length}행.`],
  });

  // Tools 미실행
  sheets.push({
    name: 'Tools 미실행',
    columns: [{ header: 'VM', key: 'name', width: 34 }, { header: 'vCenter', key: 'vcenterId', width: 20 }, { header: 'Tools 상태', key: 'toolsStatus', width: 18 }],
    rows: (waste.noTools?.vms || []).map((v) => ({ name: v.name, vcenterId: v.vcenterId, toolsStatus: v.toolsStatus || '' })),
    notes: [`전원 켜진 VM 중 Tools 미실행 ${waste.noTools?.count ?? 0}대 중 ${(waste.noTools?.vms || []).length}행.`],
  });

  // CPU 과할당
  const th = oa.thresholds || {};
  sheets.push({
    name: 'CPU 과할당',
    columns: [
      { header: 'VM', key: 'name', width: 34 }, { header: 'vCenter', key: 'vcenterId', width: 20 }, { header: 'vCPU', key: 'vcpu', width: 7 },
      { header: '할당 clock(GHz)', key: 'cpuAllocGHz', width: 15 }, { header: '사용 clock(GHz)', key: 'cpuUsedGHz', width: 15 }, { header: '미사용 clock(GHz)', key: 'cpuIdleGHz', width: 16 },
      { header: '사용률(%)', key: 'cpuUsagePct', width: 10 }, { header: '절감 가능(%)', key: 'cpuSavingPct', width: 12 }, { header: 'ESXi 호스트', key: 'host', width: 26 },
      { header: `판정(최근 ${days}일)`, key: 'verdict', width: 60 }, { header: '근거 리포트', key: 'report', width: 16 },
    ],
    rows: (oa.cpuTop || []).map((v) => { const c = reportCells(v, reports.get(v.id)); return {
      name: v.name, vcenterId: v.vcenterId, vcpu: v.vcpu ?? null,
      cpuAllocGHz: v.cpuAllocMhz == null ? null : r2(v.cpuAllocMhz / 1000), cpuUsedGHz: v.cpuUsedMhz == null ? null : r2(v.cpuUsedMhz / 1000), cpuIdleGHz: v.cpuIdleMhz == null ? null : r2(v.cpuIdleMhz / 1000),
      cpuUsagePct: v.cpuUsagePct ?? null, cpuSavingPct: v.cpuSavingPct ?? null, host: v.host || '', verdict: c.verdict, report: c.link,
    }; }),
    notes: [
      `할당 clock = vCPU × 호스트 코어당 MHz · 사용 clock = 할당 × 현재 사용률. 사용률 ${th.cpuIdlePct ?? 20}% 이하이고 vCPU 2개 이상인 VM 만 후보(후보 ${oa.cpu?.candidates ?? 0}대 중 ${(oa.cpuTop || []).length}행).`,
      '과할당 수치는 스냅샷 시점(현재)의 순간 사용률 기준 추정입니다 — 감축 결정은 근거 리포트(기간 p95·CPU Ready·벌룬/스왑)를 확인하세요.',
      ...(oa.excludedNoHostMhz > 0 ? [`호스트 코어 clock 을 알 수 없는 ${oa.excludedNoHostMhz}대는 CPU clock 집계에서 제외(추정하지 않음).`] : []),
    ],
  });

  // 메모리 과할당
  sheets.push({
    name: '메모리 과할당',
    columns: [
      { header: 'VM', key: 'name', width: 34 }, { header: 'vCenter', key: 'vcenterId', width: 20 },
      { header: '할당(GB)', key: 'memAllocGB', width: 10 }, { header: '사용(GB)', key: 'memUsedGB', width: 10 }, { header: '미사용(GB)', key: 'memIdleGB', width: 11 },
      { header: '사용률(%)', key: 'memUsagePct', width: 10 }, { header: '절감 가능(%)', key: 'memSavingPct', width: 12 }, { header: 'Guest OS', key: 'guestOS', width: 30 }, { header: 'ESXi 호스트', key: 'host', width: 26 },
      { header: `판정(최근 ${days}일)`, key: 'verdict', width: 60 }, { header: '근거 리포트', key: 'report', width: 16 },
    ],
    rows: (oa.memTop || []).map((v) => { const c = reportCells(v, reports.get(v.id)); return {
      name: v.name, vcenterId: v.vcenterId, memAllocGB: r1(v.memAllocGB), memUsedGB: r1(v.memUsedGB), memIdleGB: r1(v.memIdleGB),
      memUsagePct: v.memUsagePct ?? null, memSavingPct: v.memSavingPct ?? null, guestOS: v.guestOS || '', host: v.host || '', verdict: c.verdict, report: c.link,
    }; }),
    notes: [
      `사용 메모리는 게스트가 실제로 쓰는 양(guest memory usage). 사용률 ${th.memIdlePct ?? 40}% 이하인 VM 을 후보로 봅니다(후보 ${oa.mem?.candidates ?? 0}대 중 ${(oa.memTop || []).length}행).`,
      '판정·리포트는 최근 관측 기간의 vCenter 롤업(p95·워킹셋 최대·벌룬/스왑) 기준입니다.',
    ],
  });

  return sheets;
}

/** 리포트 대상 = CPU 상위 ∪ 메모리 상위(VM id 로 중복 제거, 순서 유지). */
export function reportTargets(waste = {}) {
  const oa = waste.overAllocated || {};
  const seen = new Set(); const out = [];
  for (const v of [...(oa.cpuTop || []), ...(oa.memTop || [])]) {
    if (!v?.id || seen.has(v.id)) continue;
    seen.add(v.id); out.push(v);
  }
  return out;
}
