/**
 * v3.18.8 — 시험 임시 폴더 누수 재발 방지(소스 스윕 · 목록 고정).
 *
 * 서버 시험 다수가 `fs.mkdtempSync(path.join(os.tmpdir(), …))` 로 만든 폴더를 지우지 않아 전량 실행마다 /tmp 에 쌓였다
 * (컨테이너 실측 12.4GB · 25,171개 — 디스크 여유가 5% 아래로 내려가 focusmon 기록기 시험이 실패한 원인). 이 회차에 고친 561개 파일이
 * 그중 9.9GB · 17,632개의 출처였다(접두 기준 실측). 고친 파일은 아래 FIXED 에 고정한다. 전 파일 강제는 하지 않는다(아직 고치지 않은 파일이 남아 있다 — 다음 점검 후보).
 *
 * 고정하는 것:
 *  ① FIXED 의 파일이 mkdtempSync 를 쓰면 같은 파일(주석 제외)에 rmSync( 가 있다.
 *  ② 공용 꼴(TMP_DIRS · rmTmpDirs)을 쓰는 파일은 정리 훅이 after 에 실제로 걸려 있다.
 *  ③ 시험 등록 뒤에 최상위 await 가 있는 파일은 정리 훅 등록이 그 await 보다 뒤다 — node 22 는 최상위 await 동안 앞 시험이
 *     끝나면 루트 after 를 먼저 돌려 뒤 시험이 쓸 폴더를 지운다(audit2590 이 그렇게 깨졌다 — 실측).
 *     판정은 0열에서 시작하는 줄 기준(최상위 문장)이고, 문자열·템플릿 안은 먼저 지운다 — 자식 스크립트 문자열의 0열 await 를
 *     최상위로 오판하지 않게(veeam2762b 실측). 템플릿 안에 템플릿이 겹치면 판정이 어긋날 수 있다(그때는 이 시험이 시끄럽게 깨진다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 이 회차에 고친 파일(목록 고정 — 파일을 지우거나 이름을 바꾸면 여기서도 고칠 것).
const FIXED = `
activityLog2516.test.js adRoleMatch.test.js arch2580.test.js arch2581.test.js arch2582.test.js atRest2538.test.js audit2478.test.js
audit2479.test.js audit2480.test.js audit2503.test.js audit2506.test.js audit2586.test.js audit2590.test.js audit2591.test.js
audit2593.test.js audit2594.test.js audit2595.test.js audit2596.test.js audit2597.test.js audit2598c.test.js audit2598e.test.js
audit2598f.test.js audit2599a.test.js audit2599b.test.js audit2599c.test.js audit2599d.test.js audit2599e.test.js audit2599f.test.js
audit2600a.test.js audit2600b.test.js audit2600c.test.js audit2600e.test.js audit2601a.test.js audit2601b.test.js audit2601c.test.js
audit2601d.test.js audit2601e.test.js audit2601f.test.js audit2602a.test.js audit2602d.test.js audit2602e.test.js audit2602f.test.js
audit2603a.test.js audit2603b.test.js audit2603c.test.js audit2603d.test.js audit2603e.test.js audit2603f.test.js audit2604a.test.js
audit2604b.test.js audit2604c.test.js audit2604d.test.js audit2604e.test.js audit2604f.test.js audit2605a.test.js audit2605b.test.js
audit2605c.test.js audit2605d.test.js audit2605e.test.js audit2605f.test.js audit2606a.test.js audit2606b.test.js audit2606c.test.js
audit2606d.test.js audit2606f.test.js audit2606g.test.js audit2607a.test.js audit2607b.test.js audit2607c.test.js audit2607d.test.js
audit2607e.test.js audit2607g.test.js audit2607h.test.js audit2611b.test.js audit2611c.test.js audit2611e.test.js audit2612b.test.js
audit2612d.test.js audit2613a.test.js audit2613e.test.js audit2613h.test.js audit2618.test.js audit2620a.test.js audit2620b.test.js
audit2620c.test.js audit2621a.test.js audit2621b.test.js audit2621d.test.js audit2622b.test.js audit2622c.test.js audit2622d.test.js
audit2629c.test.js audit2629d.test.js audit2630b.test.js audit2630c.test.js audit2630d.test.js audit2630lead.test.js audit2631a.test.js
audit2631b.test.js audit2631c.test.js audit2632d.test.js audit2632e.test.js audit2633.test.js audit2680e.test.js audit2680f.test.js
audit2681a.test.js audit2681c.test.js audit2681e.test.js audit2682a.test.js audit2682c.test.js audit2682d.test.js audit2719a1.test.js
audit2719a2.test.js audit2719b.test.js audit2719c.test.js audit2719e.test.js audit2720g2.test.js audit2720g3.test.js audit2720g4.test.js
audit2721b.test.js audit2721e.test.js audit2727b.test.js audit2731g2a.test.js audit2731g3b_cpuspan.test.js audit2731g3b_health.test.js
audit2731g4a_changeContract.test.js audit2731g4a_remoteClose.test.js audit2731g4b.test.js audit2731g5b.test.js audit2731g5b_san.test.js
audit2732a.test.js audit2732c_routes.test.js audit2732f_bmspan.test.js audit2732g_sanPortsMask.test.js audit2732h.test.js
audit2732i1_writeFirst.test.js audit2732lead.test.js audit2733b_scanHold.test.js audit2733d.test.js audit2733e_growthSpan.test.js
audit2733h_hangsDelete.test.js audit2733h_writeFirst.test.js audit2733j_ipamSubnets.test.js audit2733j_scanInfo.test.js
audit2733j_vmperfMeta.test.js audit2740b.test.js audit2740c.test.js audit2741b.test.js audit2742c.test.js audit2742g.test.js
audit2742j.test.js audit2742m.test.js audit2743a.test.js audit2743d.test.js audit2743e.test.js audit2743lead.test.js audit2744a.test.js
audit2744d.test.js audit2744e.test.js audit2744fd.test.js audit2744flead.test.js audit2744g.test.js audit2744ra.test.js audit2744rd.test.js
audit2744rf.test.js audit2744ve.test.js audit2760b.test.js audit2762c.test.js audit2766a.test.js audit2767a.test.js audit2768a.test.js
audit2768b.test.js audit2768c.test.js audit2769c.test.js audit2770a.test.js audit2770b.test.js audit2771a.test.js audit2771b.test.js
audit2771c.test.js audit2771e.test.js audit2771f.test.js audit2781c.test.js audit2782b.test.js audit2782c.test.js audit2782d.test.js
audit2782e.test.js audit2783b.test.js audit2783e.test.js audit2783f.test.js audit2785a.test.js audit2785b.test.js audit2785c.test.js
audit2785e.test.js auditMiscall2569.test.js authStop2590.test.js authStop2591.test.js authzGates2536.test.js backupMarks2784.test.js
backupMenu2779.test.js backupOpts2780.test.js backupPriority2787.test.js bareosAutoSetup2841.test.js bareosBugs2847b.test.js
bareosCancel2867.test.js bareosFix2822.test.js bareosFullAudit1.test.js bareosGroups2830.test.js bareosHealth2892.test.js
bareosInstall2844.test.js bareosInstallBugs2846.test.js bareosInstallJob2844.test.js bareosInstallResetUnreg2876.test.js
bareosInstallRunner2844.test.js bareosLate2938.test.js bareosLinkTarget2879.test.js bareosLocal2843.test.js bareosMailCause2885.test.js
bareosNotify2822.test.js bareosResetScript2876.test.js bareosRunDetail2858.test.js bareosSetupOtp2842.test.js biz2707.test.js
bmFolders2984.test.js bmFolders2987.test.js bmFolders2989.test.js bmFolders2993.test.js bmFolders2994.test.js bmFolders2995.test.js
bmHw330.test.js bmOsSuggest2991.test.js bmPerf2921CvpRecv.test.js bmUsageEdgeOn2927.test.js bmUsageEnterprise2554.test.js
bugfix2427.test.js bulkDeploy2432.test.js bulletin2722.test.js bulletin2723.test.js capForecast2672.test.js capacityAdvisor.test.js
centralAgentTokens.test.js centralSplit2954.test.js collectorDenyLog.test.js collectorIdentity2424.test.js
collectorSetPasswordGuard.test.js collectorSync2434.test.js commonRound19_3179.test.js contentApiAudit67.test.js corpUsage2625.test.js
credentials.test.js csvlogPrune.test.js cvp2608a.test.js cvp2608b.test.js cvp2641.test.js cvp2642.test.js cvp2644.test.js
cvpDropUi2923.test.js cvpEndpoint2935.test.js cvpFaults2640.test.js cvpPreview2640.test.js dataFlow2587.test.js demo2708edge.test.js
demo2708idrac.test.js demo2708pducvp.test.js demo2708san.test.js demo2708storage.test.js demo2708users.test.js demo2709.test.js
demo2710.test.js demo2711.test.js demoData2716.test.js demoGuest2716.test.js demoSession.test.js demoUser.test.js
deployTargetGpuGuest.test.js disableTotpGuard.test.js dnsConfirm320.test.js edgeAutoUpgrade2859.test.js edgeAutoUpgrade2865.test.js
edgeSweep2574.test.js edgeSyncNoEffect2870.test.js edgeSyncPersist2938.test.js emergencyStop.test.js fieldCheck2938.test.js
fieldCheckOnefs2954.test.js finops.test.js focusMon2976.test.js focusMonAlerts3160.test.js focusMonAlertsFix3160.test.js
focusMonApi2976.test.js focusMonApps3140.test.js focusMonAudit3110.test.js focusMonAvg2979.test.js focusMonBulk2978.test.js
focusMonCard2992.test.js focusMonEdit2980.test.js focusMonGroup2982.test.js focusMonHistory3130.test.js focusMonInstall3170.test.js
focusMonLoad2983.test.js focusMonMetrics3120.test.js focusMonPrep3180.test.js focusMonProc2981.test.js focusMonSess2979.test.js
focusMonSessMerge2980.test.js forecastScope.test.js fullAudit45.test.js g2Backup2689.test.js g3Audit2689.test.js g4CacheGc2689.test.js
gpuMemTemp2650.test.js gpuPasswordless.test.js graphIncidentsScope.test.js guestDiskAudit68.test.js guestPart2749.test.js
horizon2686.test.js horizonLicense2685.test.js hostAccess2485.test.js idracInv2728.test.js idracLink2676.test.js idracPollHook2583.test.js
idracRouteOrder.test.js idracScanJobs.test.js idracScanPush.test.js idracTempSeries2504.test.js idracTrend2660.test.js
idracTrend2661.test.js idracTrend2687.test.js idracTrendGpu2668.test.js idracTrendPerf2729.test.js improvements2417.test.js
ipScanAgentDelete2694.test.js ipScanDc2638.test.js ipScanHostname2991.test.js ipScanMac2999.test.js ipScanRanges2692.test.js
ipScanUnify2691.test.js ipamChanges310.test.js ipamScanStore.test.js ipamScope.test.js ipamSubmenu2636.test.js ipms2637.test.js
ipms2639.test.js isidu2736.test.js issues2864.test.js issues2871.test.js issues2882.test.js issuesAutoCreate2880.test.js
issuesFix2929.test.js issuesR4_2908.test.js knownAgents.test.js leftoverC56.test.js linkCheck2552.test.js logAnalysis2583.test.js
logSearchMailAudit73.test.js loginFails2673.test.js loginHistory2912.test.js loginPolicy.test.js loginPolicyUsers.test.js
loginStore.test.js loginStoreLines2674.test.js maskedOrder2990.test.js mockSeed.test.js netIssueStore.test.js nsxRemoteScope.test.js
numOrNull2561.test.js ops2706.test.js opsAccessAudit64.test.js osInventory.test.js otpPolicy.test.js overviewTrend2670.test.js
partFault2548.test.js partFaultDb2548.test.js perfMonitor2498.test.js permissions.test.js physicalGpu.test.js portalDbForecast2674.test.js
powerBreakdown.test.js powerOff2483.test.js powerOff2484.test.js powerScopeLeak.test.js powerTotal2664.test.js progressDetail2501.test.js
provCfgAudit74.test.js provisionScope.test.js psInspect2965.test.js psInspectReview2965.test.js publicApi2562.test.js
pullCollectorByAgent.test.js rbacHardening.test.js rebut66.test.js rebut71.test.js rebut75.test.js relayCheck2430.test.js
relayTopo2431.test.js remoteInventory.test.js requestId2583.test.js rmaCentral.test.js rmaTests.test.js rvB_vmPaging.test.js
rvC_onefsAreas.test.js rvC_onefsAreasCentral.test.js rvD_bulletinPersist.test.js rvF_adTransport.test.js rvH_remoteSession.test.js
rvI_tlsClients.test.js rvI_tlsTrust.test.js rvJ_s09Transport.test.js rvK_releaseSigning.test.js rvK_releaseSigning2.test.js
rvK_versionsMeta.test.js rvLead_envPin.test.js sanAttrib2920.test.js sanCvpRest2940.test.js sanDemoPerf2715.test.js sanFlow2935.test.js
sanFullAudit58.test.js sanHealthCheck2519.test.js sanPerf2728.test.js sanPerfEdge2517.test.js sanPerfPush2566.test.js
sanPortUsage2748.test.js sanStorPath2935.test.js sanStorage2952.test.js sanSwitch.test.js sanSwitchPerf2420.test.js
sanSwitchPerfRelay2423.test.js sanSwitchTest2421.test.js sanTraffic2669.test.js scanRangeResult2441.test.js scanResume2737.test.js
scopeLeak2574.test.js scopeStatus2583.test.js secOutbound2583.test.js secretScan.test.js secretVault.test.js secretsPolicyS07.test.js
security2026-09-12.test.js securityAudit2026-08-17.test.js securityAudit2026-09-13.test.js securityFix2026-09-01.test.js
securityFix2435.test.js securityFullAudit19.test.js securityFullAudit20.test.js securityH1RegisterCollector.test.js
securityScopeM1M2.test.js securitySettings.test.js serialLookup.test.js serverSensors2659.test.js serverTempSpark2556.test.js
settingsCheck2553.test.js settingsOwnerGates.test.js settingsOwnersFile.test.js singleSession.test.js ssrfAgents2537.test.js
stall2675.test.js stall2693.test.js stall2713.test.js storageActivityLog.test.js storageFault2615.test.js storageIntervals.test.js
storageMon.test.js storagePowerstoreUnity.test.js storageUsage2789.test.js storageUsage2791.test.js superAdmin2643.test.js
svcInventory2887.test.js svcInventoryReview5.test.js svcInventoryReview5b.test.js svcInventoryReview5c.test.js svcInventoryReview5d.test.js
svcInventoryReview6.test.js svcInventoryReview6b.test.js svcInventoryReview7.test.js svcmon.test.js svcmonAgentField.test.js
svcmonAnalyze.test.js svcmonBatches.test.js svcmonCentralReplace.test.js svcmonCsv.test.js svcmonEdge.test.js svcmonFormats.test.js
svcmonFullAudit26.test.js svcmonGenspec.test.js svcmonMoveFolder.test.js svcmonRenameTarget.test.js svcmonReorder.test.js
svcmonRouteOrder.test.js svcmonSettingsSync2915.test.js svcmonTemplates.test.js svcmonTplCsv.test.js sweep2932Bm.test.js
sweep2932Usage.test.js topoMapAudit63.test.js topologyFix2428.test.js totpRebindGuard.test.js unsupportedServers2495.test.js
upgradeAuto2736_2.test.js upgradeCheckTimeout2736_3.test.js upgradeDownload2651.test.js upgradeSigLog2736_1.test.js
upgradeSigOverride2809.test.js upgradeWatchManifest2809.test.js userAdmin2723.test.js userTools2555.test.js vcMiscAudit69.test.js
vcRangeImport2690.test.js vcenterTop2938.test.js veeam2751.test.js veeam2754.test.js veeam2755.test.js veeam2761a.test.js
veeam2761b.test.js veeam2762a.test.js veeam2762b.test.js veeam2763a.test.js veeam2763b.test.js veeam2778.test.js veeamEm2788.test.js
veeamEm27881.test.js veeamEmLinks2817.test.js veeamEmVm2795.test.js veeamManage2819.test.js veeamRun2818.test.js veeamRunBugs28201.test.js
veeamRunDetail28221.test.js vmChanges2702.test.js vmChanges2932.test.js vmClone.test.js vmCloneCenter2793.test.js
vmCloneFeatures2794.test.js vmCloneRun2795.test.js vmCloneSafety2794.test.js vmDist2746.test.js vmDns2696.test.js vmDrawerSig2963.test.js
vmExcel2801.test.js vmExportSlots.test.js vmHub2909.test.js vmHygiene2698.test.js vmListCsv2792.test.js vmListXlsx2792.test.js
vmNameSearch2671.test.js vmPartitions2750.test.js vmTags2703.test.js vmperfDb.test.js vmperfSettings.test.js vmseriesDb2510.test.js
vmtrackDb.test.js vmtrackRerun.test.js wiki2881.test.js wikiIssues2883.test.js wikiIssues2885.test.js wikiIssues2886.test.js
wikiIssues2904.test.js wikiIssues2907.test.js wikiMention2907.test.js xferLatency2735_2.test.js xferReview2735_3.test.js
xferSchedule2735.test.js xferSpeed2735.test.js xferWindow2735_3.test.js xlsxSheetPr2799.test.js
`.split(/\s+/).filter(Boolean);

const code = (f) => stripComments(fs.readFileSync(path.join(HERE, f), 'utf8'));

const REGEX_OK_BEFORE = /[([{;,:=!&|?+\-*%~^<>]$/;
/** 문자열·템플릿·정규식 안의 글자를 공백으로 바꾼다(개행은 남긴다 — 줄 번호 보존). 주석은 먼저 지운 소스를 받는다. */
export function blankStrings(s) {
  let out = ''; let i = 0; let prev = '';
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1;
      out += c + s.slice(i + 1, j).replace(/[^\n]/g, ' ') + (j < s.length ? c : '');
      i = j + 1; prev = c; continue;
    }
    if (c === '/' && REGEX_OK_BEFORE.test(prev)) {   // 정규식 리터럴(한 줄) — 안의 따옴표·백틱을 문자열로 보지 않게
      let j = i + 1; let cls = false;
      while (j < s.length && s[j] !== '\n') {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '[') cls = true; else if (s[j] === ']') cls = false; else if (s[j] === '/' && !cls) break;
        j += 1;
      }
      if (s[j] === '/') { out += '/' + ' '.repeat(j - i - 1) + '/'; i = j + 1; prev = '/'; continue; }
    }
    out += c; if (!/\s/.test(c)) prev = c; i += 1;
  }
  return out;
}

/** ③ 판정 — 첫 최상위 시험 등록 줄 뒤에 최상위 await 줄이 있으면 그 마지막 줄 번호(0부터), 없으면 -1. */
export function lastTopAwaitAfterFirstTest(src) {
  const lines = blankStrings(stripComments(src)).split('\n');
  const first = lines.findIndex((l) => /^(?:await\s+)?(?:test|describe|it|suite)(?:\.\w+)?\(/.test(l) && !/^(?:test|describe)\.(?:after|before|afterEach|beforeEach)\(/.test(l));
  if (first < 0) return -1;
  let last = -1;
  for (let i = first + 1; i < lines.length; i++) {
    if (/^(?:(?:const|let|var)\s[^=]*=\s*)?await\b|^(?:const|let|var)\s+[^=]+=\s*\(?\s*await\b|^for\s+await\b/.test(lines[i])) last = i;
  }
  return last;
}

test('목록이 비지 않았고 전부 실제 시험 파일이다', () => {
  assert.ok(FIXED.length >= 100, `목록이 너무 짧다(${FIXED.length}) — 파싱 실패`);
  assert.equal(new Set(FIXED).size, FIXED.length, '목록에 중복이 있다');
  const missing = FIXED.filter((f) => !fs.existsSync(path.join(HERE, f)));
  assert.deepEqual(missing, [], `없는 파일(지웠거나 이름이 바뀌었다면 목록도 고칠 것): ${missing.join(', ')}`);
});

test('① mkdtempSync 를 쓰는 고친 파일은 같은 파일에 rmSync( 가 있다(주석 제외)', () => {
  const bad = FIXED.filter((f) => { const s = code(f); return s.includes('mkdtempSync') && !s.includes('rmSync('); });
  assert.deepEqual(bad, [], `임시 폴더를 만들고 지우지 않는다: ${bad.join(', ')}`);
});

test('② 공용 꼴(TMP_DIRS)을 쓰는 파일은 정리 훅이 after 에 걸려 있다', () => {
  const bad = [];
  for (const f of FIXED) {
    const s = code(f);
    if (!s.includes('TMP_DIRS')) continue;
    if (!/^(?:test\.)?after\(\(\) => \{[^\n]*(?:rmTmpDirs\(\)|TMP_DIRS)/m.test(s)) bad.push(f);
  }
  assert.deepEqual(bad, [], `TMP_DIRS 를 모으고 after 에서 지우지 않는다: ${bad.join(', ')}`);
});

test('③ 시험 사이에 최상위 await 가 있으면 정리 훅은 그 await 뒤에서 등록한다', () => {
  const bad = [];
  for (const f of FIXED) {
    const s = code(f);
    if (!s.includes('rmTmpDirs')) continue;
    const lines = blankStrings(s).split('\n');
    const hook = lines.findIndex((l) => /^(?:test\.)?after\(\(\) => \{ rmTmpDirs\(\)/.test(l));
    const late = lastTopAwaitAfterFirstTest(fs.readFileSync(path.join(HERE, f), 'utf8'));
    if (late >= 0 && hook < late) bad.push(`${f}(훅 ${hook + 1}행 < await ${late + 1}행)`);
  }
  assert.deepEqual(bad, [], `정리 훅이 늦은 최상위 await 보다 앞이다(앞 시험이 끝나면 먼저 돌아 폴더를 지운다): ${bad.join(', ')}`);
});

test('③ 판정 자체 — 늦은 await 를 잡고, 들여 쓴 줄 · 첫 시험 앞의 await 는 보지 않는다', () => {
  assert.equal(lastTopAwaitAfterFirstTest("const a = await import('x');\ntest('t', () => {});\n"), -1);
  assert.equal(lastTopAwaitAfterFirstTest("test('t', () => {});\n  const b = await f();\n"), -1);
  assert.equal(lastTopAwaitAfterFirstTest("test('t', () => {});\nconst backup = await import('y');\ntest('u', () => {});\n"), 1);
  assert.equal(lastTopAwaitAfterFirstTest("test('t', () => {});\nawait new Promise((r) => setTimeout(r, 1));\n"), 1);
  assert.equal(lastTopAwaitAfterFirstTest("test.after(() => {});\nconst c = await g();\ntest('t', () => {});\n"), -1);
  // 자식 스크립트 템플릿 안의 0열 await 는 최상위가 아니다(veeam2762b 실측 오탐) · 정규식 안의 백틱이 템플릿을 열지 않는다
  assert.equal(lastTopAwaitAfterFirstTest("test('t', () => {\n  const s = `\nconst P = await import(R);\n`;\n});\n"), -1);
  assert.equal(lastTopAwaitAfterFirstTest("test('t', () => { assert.match(x, /[`]/); });\nconst d = await h();\n"), 1);
  // 주석 안의 await 는 보지 않는다
  assert.equal(lastTopAwaitAfterFirstTest("test('t', () => {});\n// await 는 여기 없다\n"), -1);
});
