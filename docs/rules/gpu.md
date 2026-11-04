# 규칙 — GPU 모니터링(할당·메모리·온도·수집 점검)

> 루트 `CLAUDE.md` 에서 옮긴 기록(2026-10-20, v2.746 시점). 문구는 원문 그대로이고 목록 들여쓰기만 한 단계 줄였다. "되돌리지 말 것" 규칙은 그대로 유효하다 — 이 영역 코드를 고치기 전에 이 파일을 읽을 것. 새 교훈은 테스트 → 이 파일 순으로 남기고 루트 CLAUDE.md 에는 쌓지 않는다.

**언제 읽나**: server/src/gpu/ · web/src/views/tools/Gpu*

## 목차

- (원래 4458행) vGPU 할당률의 분모는 '명목 용량' 이고, 배너는 '무엇을 못 읽었나' 를 말한다
- (원래 4465행) GPU '수집 점검' 창(v2.658)은 배너와 같은 판정(guestWhy)을 법인별로 전부 보여 준다
- (원래 4468행) v2.724 — GPU 수집 경고 박스는 기본 숨김이고 '🩺 수집 점검' 버튼이 펼친다
- (원래 4632행) GPU 추이 창은 수집 공백을 잇지 않는다
- (원래 4648행) GPU 메모리·온도·동작(v2.650) — 사용률·메모리 점유·온도는 서로 다른 것을 잰다. 온도는 판정에 쓰지 않는다
- (원래 4665행) GPU 표 시안 A(v2.653) — 빈 칸은 이유를 말하고, 게스트 값이 없으면 ESXi 카운터로 채우되 출처를 밝힌다
- v2.852 GPU 할당 계층 — 법인 › 데이터센터 › 클러스터 › 호스트 › GPU › VM 의 할당·예비(화면·CSV·엑셀)
- v2.873 Bareos 백업 대상 GPU 표지 — 켜진 vGPU·PCI 패스스루 VM 은 스냅샷 불가(판정 `vmGpuMark` 하나)

## 본문

- ⚠⚠ **vGPU 할당률의 분모는 '명목 용량' 이고, 배너는 '무엇을 못 읽었나' 를 말한다**(v2.657, `gpu/gpuModelMem.js`(soapClient 에서 옮김) ·
  `gpu/hostGpu.js allocCapacityGB/allocCapacityBasis` · `routes/api/hardwareGpu.js missingZero/addMissing` · 웹 `gpuUsageText.allocTitle`·
  `gpuWhyText.missingText`, 사용자 캡처 "A40 ×1 에 48 GB / 45 GB (107%) 호박색" · "어떤 값을 못 읽었는지 구체적으로". 회귀 `server/test/gpuAlloc2657.test.js`):
  vCenter `memorySizeInKB` 는 A40 을 45GB 로 보고하는데 vGPU 프로파일은 명목 단위(24Q = 24GB)라 카드 최대 구성이 107% '초과' 로 보였다.
  할당률 분모 = GPU 마다 `max(보고값, 모델 명목값)` — 모델을 모르면 보고값(명목을 지어내지 않는다). **메모리 사용 분모(`capacityGB`)는 보고값 그대로**다(두 분모를
  섞지 말 것). 보고값이 작은 이유(예약분)는 추정이다. 배너 한 줄(vCenter × 사유)에 `missing{util,mem,temp,alloc,all}`(호스트 대수) — 할당은 게스트가 아니라
  vCenter 프로파일에서 오므로 따로 말한다. 100% 초과 툴팁은 '실제 초과' 라 단정하지 않는다(vGPU 는 프레임버퍼를 넘겨 줄 수 없다 — 해석·추정 어긋남 가능).
- **GPU '수집 점검' 창(v2.658)은 배너와 같은 판정(guestWhy)을 법인별로 전부 보여 준다**(`gpuWhyText.collectCheckGroups`·`readCell` +
  `GpuTool.jsx GpuCollectCheckModal`, 사용자 요청 "외 22건 말고 전체를 법인별로 클릭해서"): 배너는 앞 6줄 + '외 N건'(누르면 이 창)이고, 창은 '일부만 수집'
  까지 싣는다. 법인 칩으로 거르고 호스트 줄은 값마다 읽음(출처)/못 읽음을 적는다. 새 조회를 만들지 않는다(이미 받은 /tools/gpu 응답만).
- **v2.724 — GPU 수집 경고 박스는 기본 숨김이고 '🩺 수집 점검' 버튼이 펼친다**(사용자 요청 — `GpuTool.jsx whyShown`, 회귀 `web/src/views/tools/gpuCheckToggle2724.test.js`):
  버튼은 이제 박스 토글(`aria-expanded`)이고, 법인별 창(`GpuCollectCheckModal`)은 박스 안 '외 N건 — 전부 보기'·'법인별 전부 보기' 가 연다. 박스는 보기·필터와 무관하게 펼쳐진다.
  ⚠ 예전처럼 `view === 'host'` 조건만으로 자동 표시로 되돌리지 말 것(테스트가 고정).
- **GPU 추이 창은 수집 공백을 잇지 않는다**(v2.656, `GpuHistModal.gapRows`): 간격이 `max(버킷, 수집 주기) × 2` 를 넘으면 null 행을 끼워 선을 끊고
  (버킷을 모르면 이웃 간격 중앙값), 앞뒤가 빈 점은 점으로 찍는다(v2.551 bmUsageChart 규약과 같다). 끊은 곳 수를 창 아래에 적는다 · 평균/최고 범례.
- ⚠⚠ **GPU 메모리·온도·동작(v2.650) — 사용률·메모리 점유·온도는 서로 다른 것을 잰다. 온도는 판정에 쓰지 않는다**
  (`gpu/activity.js`·`vgpuProfile.js`·`hostGpu.js` + `GET /tools/gpu/host` + 웹 `components/HostGpuPanel.jsx`·`views/tools/gpuUsageText.js`·
  `GpuHistModal.jsx`, 사용자 요청 "GPU 메모리 점유/사용량도 추가" · "GPU 온도 센서의 온도도 같이 수집해서 실제로 GPU 가 동작하는지 점검" ·
  호스트 상세 "GPU 사용율, GPU 온도, GPU 메모리 할당/사용율". 회귀 `server/test/gpuMemTemp2650.test.js` + 웹 `gpuUsageText.test.js`):
  - **nvidia-smi 쿼리는 `guestops.js NVSMI_QUERY` 하나**(SSH 경로도 import) — `temperature.gpu` 는 **맨 뒤**에 붙였다(앞 열 위치를 바꾸면 구버전
    파서와 어긋난다). 테스트가 src 전체에서 쿼리 리터럴이 한 곳뿐임을 고정한다. 온도 열이 없는 출력도 읽는다(온도만 null).
  - 동작 판정(`gpuActivity`)은 **사용률 → 메모리 점유** 순이다: 사용률 ≥ 10 = 연산 중 · 그 아래이면서 메모리 ≥ 10 = 메모리 점유·유휴 · 그 밖 = 유휴 ·
    사용률을 모르면(미수집·MIG) **판정 불가**(유휴로 세지 않는다). 온도는 모델·냉각마다 정상 범위가 달라 **임계를 정하지 않고** 근거로만 보인다.
    기준 숫자는 서버가 `activityRule` 로 싣는다(화면에 박지 말 것).
  - 호스트 요약은 `summarizeHostGpu` 하나를 호스트 상세와 GPU 모니터링 표가 같이 쓴다. **꺼진 VM 은 할당·사용·온도에서 뺀다**(vGPU 는 꺼지면 프레임버퍼를
    잡지 않고, 게스트 값은 낡은 값이다). 게스트 수집이 없는 켜진 VM 수는 `vmsUnread` 로 밝힌다(합계에서 빠졌다는 사실).
  - vGPU 할당 GB 는 프로파일 이름 끝 숫자(`…-20c` = 20, `0` = 512MB)다 — **해석 못 하면 null**(`allocUnknown` 으로 센다). 패스스루는 한 장 통째라 '장' 이다.
    `gpu` 객체에 vgpu·passthrough 개수가 없으면(구버전 스냅샷·목) `vmGpuDevices` 가 type + count 로 되돌린다. 패스스루 용량은 모델명 추정(`capacityEstimated`).
  - 추이: `gpu_vm_util`·`gpu_vm_mem`·`gpu_vm_temp`(VM) + `gpu_temp`·`gpu_mem`(호스트) — GPU VM 200대면 연 약 526만 행(temp_host 와 같은 규모).
    **신선한 게스트 값만**(폴 주기 × 3, 최소 15분) · `GPU_VM_SERIES=0` 으로 끈다. 히스토리 API 는 `metric=util|mem|temp`, 클러스터·법인은 사용률만(400).
  - 호스트 상세는 소유 화면 밖에서 `/tools/gpu` 를 부르므로 `toolAllowed('gpu')` 를 먼저 본다(v2.613 CATALOG2613-02 스윕이 실제로 잡았다).
  - ⚠ 정직 기록: vGPU 게스트에서 `temperature.gpu` 가 값을 주는지, 이 현장 프로파일 이름 형식은 실장비로 확인하지 못했다. 목 데이터는 vGPU 과할당(>100%)이 나온다(합성 한계).
- ⚠⚠ **GPU 표 시안 A(v2.653) — 빈 칸은 이유를 말하고, 게스트 값이 없으면 ESXi 카운터로 채우되 출처를 밝힌다**
  (`gpu/guestWhy.js`(순수 판정) · `routes/api/hardwareGpu.js gatherGuestWhyCtx` · `vcenter/soapClient.js gpuPerfCounterIds`·`parseHostGpuPerf` ·
  웹 `views/tools/GpuTool.jsx`·`gpuWhyText.js` + `DataTable expandedKey/renderExpanded`. 사용자 요청 "온도·메모리 사용률이 안 나오고 할당 VM 이 많으면 줄 간격이
  넓다 · edge 에서 수집하는 건 안 된다" + "조회 기본 1일" + "GPU 에서 수집하는 모든 데이터 저장". 회귀 `server/test/gpuTable2653.test.js` + 웹 `gpuWhyText.test.js`):
  - **엣지 법인이 빈 원인은 확정하지 못했다(정직 기록)** — 엣지 push·중앙 수신·저장·화면 코드는 온도·메모리 필드를 전부 넘긴다. 'VM 동작 불가 N' 은 그 VM 의
    게스트 기록이 중앙에 아예 없다는 뜻이다. 그래서 원인을 추측하지 않고 **행마다 이유 코드**(`GUEST_WHY_CODES` 9종 — 웹 `WHY_TEXT` 와 1:1, 테스트 대조)를
    싣는다: site vCenter 는 담당 엣지(스냅샷 `collectedBy`)의 진단 보고 유무·나이(30분)·그 vCenter 항목 유무 → 선별 단계, direct 는 로컬 설정·진단.
    판정 입력은 전부 인메모리·설정 파일이다(왕복 0). 엣지 버전 < 2.650 이면 '엣지 구버전'(온도·메모리 절대량 미전송) — **버전을 모르면 단정하지 않는다**.
  - **ESXi GPU 카운터는 사용률과 같은 QueryPerf 한 번**이다(`gpu.mem.usage`(%) · `gpu.mem.used`(KB, 인스턴스 합) · `gpu.temperature`(인스턴스 최대)).
    ⚠ 카운터 이름은 관용 이름이고 이 현장 vCenter 카탈로그에서 확인하지 못했다 — 없으면 그 값만 null 이고 수집 로그가 '카운터 없음' 을 말한다.
    -1 표본은 버리고(0 으로 채우지 않는다) 합계 인스턴스("")는 GPU 인스턴스가 있으면 뺀다. 호스트 필드 `gpuTempC`·`gpuMemUsedPct`·`gpuMemUsedMB` 는
    중앙 `INV_NUM_KEYS` 에 넣었다(엣지 push 로 오는 값도 수로 좁힌다).
  - **게스트 값이 먼저다**(`summarizeHostGpu` — `tempSource`·`memSource`). 두 출처를 한 호스트에 섞지 않는다 — 화면은 ESXi 값에 'ESXi' 표지를 붙인다.
    패스쓰루 용량은 모델명 추정이라 ESXi MB 로 백분율을 계산하지 않는다.
  - 저장: `gpu_mem_mb`(호스트)·`gpu_vm_mem_mb`(VM) 추가 + 게스트 값이 없는 신선한 호스트는 ESXi 값으로 `gpu_temp`·`gpu_mem` 적재. 추이 API `metric=memmb`(MB 저장, 화면 GB).
  - 화면: 행 높이 44px 고정(CSS 는 `.gpu-host-table > tbody > tr:not(.row-expanded) > td` — 펼침 표까지 44px 가 되던 것을 좁혔다) · 칩은 켜진 VM 먼저 ·
    펼침은 한 번에 한 행(`DataTable` 의 선택 인자 — 기본값이면 기존 표 무변경) · 추이 창 기본 1일.
  - 데모(v2.654): mock 은 설정 없이 전 법인을 합성 수집(`gpu/poller.js demoAll`)하고 일부 VM·법인을 일부러 실패로 둬 이유 칩이 보인다 · 목 GPU VM 은 호스트별 순번으로 배치(`mkVmGpu(…, ord)`).
  - ⚠ **Playwright 스크린샷 경로는 절대 경로로** — 상대 경로면 스크립트를 돌린 cwd(저장소)에 png 가 떨어진다(이번에 server/·web/ 에 떨어져 지웠다).
  - **집계 단위(v2.655, 사용자 요청 "1분/10분/1시간/6시간 단위로")**: `/tools/gpu/history?bucket=1m|10m|1h|6h`(서버 `GPU_HIST_BUCKETS` ↔ 웹
    `GpuHistModal.jsx GPU_HIST_BUCKETS` 키 대조 — 둘 다 테스트가 고정). 안 주면 예전 기간 규칙. 단위를 고르면 점 상한 3,000 이고 넘치면
    `historyStep` 의 `truncated`·`coveredSince` 로 밝힌다. 화면은 상한을 넘는 기간 버튼을 막고, 사용률 수집 주기(`sampleSec` =
    `gpuUtilIntervalSec`)와 비슷한 단위면 '같은 값이 이어질 수 있다' 고 적는다. GPU 계열은 dead-band 가 없어 1분 원본이 그대로 있다.

  · v2.769(점검 R4-D5): **호스트 GPU 사용률 = 켜진 GPU VM 의 최댓값**(MIG 제외) — 폴러·sampler·`gpu_util` 이력·엣지 push 가 이 정의이고, 표(`/tools/gpu`)·호스트 상세도 같은 값이다(평균으로 되돌리지 말 것 — 표와 추이가 갈린다).
    일부 GPU 무응답은 `gpuErrors`(0~64, 밖이면 null)로 레코드·store·중앙 `narrowGpuRow`·엣지 push 에 싣고 화면이 'GPU N장 응답 없음' 으로 알린다.
    클러스터 키(`<vcenterId>|<cluster>`)의 소유 vCenter 는 `gpu/clusterKeyScope.js` 최장 프리픽스(스냅샷 id ∪ 허용 id) — `split('|')[0]` 금지.
- ⚠⚠ **v2.852 GPU 할당 계층 — 법인 › 데이터센터 › 클러스터 › 호스트 › 물리 GPU › VM 의 할당·예비**(승인 시안 https://claude.ai/artifact/GQKnG775UijSAU7aUSFFeB ·
  사용자 요청 "어떤 GPU 가 설치되어 있고 어떤 VM 에 얼만큼의 vGPU/GPU 가 할당되어 있고 할당량/예비량" + "excel 로 내보내기". `gpu/allocTree.js`(순수) ·
  `gpu/allocTreeXlsx.js` · `GET /tools/gpu/alloc`(+ `.csv`·`.xlsx` — data.csv · 엑셀 동시 1건) · 웹 `GpuTool` '할당 계층' 보기(`GpuAllocTree.jsx`·`gpuAllocText.js`).
  회귀 `server/test/gpuAllocTree2852.test.js` + 웹 `gpuAllocText.test.js`):
  - **할당 = 켜진 VM 만**, 예비 = 용량 − 할당. 용량(명목 — `gpuCapacityOf` 는 hostGpu.js allocCapacityGB 와 같은 규칙)이나 할당(프로파일 해석 불가)을 모르는 것이
    섞이면 **예비·할당률은 null**(부분 합을 예비로 보이지 않는다). 꺼진 VM 은 `off` 묶음과 `offGB`(켜면 필요한 양). vSGA 는 행만 — 합계 제외.
  - **GPU 별 배치의 근거**: vGPU = 수집기 `parseGpus` 가 싣는 `gpus[].vms`(HostGraphicsInfo.vm moref — VM id 는 `${vcenterId}:${ref}`),
    패스스루 = 호스트 GPU `pciId` ↔ VM `gpu.pciIds`(`vmPassthroughPciIds` — 정적 `<id>`·동적 `<assignedId>`). 키가 없는 GPU(구버전 수집기·엣지)는
    `placement:false` — GPU 단위 할당·예비 null, VM 은 '배치 정보 없음' 묶음(GPU 에 지어내 배치하지 않는다). 호스트 할당은 배치와 무관하게 VM 구성에서.
  - **엣지 수신**: 세 필드는 `routes/central.js sanitizeHostGpus`·`sanitizeVmGpuField` 가 형식(moref·PCI 주소)·상한으로 좁힌다. gpus 가 배열이 아니면 [] ·
    새 필드가 형식 밖이면 키를 지운다(= 배치 정보 없음). 예전에는 gpus·gpu 를 통째로 받았다(그 밖 필드는 여전히 그대로 — 별건).
  - 슬롯은 한 GPU 의 프로파일이 하나일 때만(같은 GPU 에는 같은 프로파일 — NVIDIA 일반 규칙, 혼합 크기 모드면 계산하지 않는다). CSV 슬롯 글자는
    '사용 N / 전체 M'(엑셀이 '4/4' 를 날짜로 바꾼다). 엑셀은 조건부 서식 없이 글자 막대(█░) · 개요 + 폭 한 장 인쇄라 `xlsxSheetPrOrder.js` 를 불러온다.
  - 웹 표는 STable 래퍼 + **형제끼리만 정렬**(전체 정렬은 계층을 깬다 — th onClick 이 있어 STable 자체 정렬은 꺼진다).
  - **v2.853 법인 칩**(사용자 요청 — vCenter 화면 '⚡ 바로가기' 와 같은 모양으로 법인 선택): `vc-quicknav`·`qn-btn`(`.on` = 선택) 그대로 ·
    칩 = `/vcenters` 의 법인 전부(GPU 호스트 0 이면 흐리게) · 상태 점은 `vcCardText.vcQuickDot` 하나(vCenter 화면도 이것으로 바꿨다 — 판정 복제 금지) ·
    여러 개 선택(빈 선택 = 전체) · 요약 칸은 `gpuAllocText.sumTotals`(서버 finishTotals 와 같은 '모르는 값이 섞이면 예비 null') ·
    내려받기는 `vcenterIds=a,b`(서버가 조회 범위와 교집합을 먼저 — 범위 밖 id 는 빠진다, 100개·200자 상한) · 찾기 글자가 법인 id·이름에 맞으면 그 법인 전체.
  - **v2.855 엑셀 내보내기 창**(`GpuAllocExportModal.jsx` — 시안 '계층 표 엑셀 내보내기'): 계층 표에 넣을 단계 `depth=host|gpu|vm`(계층 표 행 깊이 상한 —
    평면 표·안내에는 영향 없음, 개요 단추 수도 맞춘다) · 시트 `sheets=tree,flat,info`(하나 이상) — 모르는 값은 `allocExportOpts` 가 **잠금을 잡기 전에** 400.
    범위 글자·호스트·GPU 수·단계별 파일 이름은 `GET /tools/gpu/alloc/export-meta`(data.csv)가 내려받기와 **같은 `allocFileName`** 으로 준다(화면이 이름을 지어내지 않는다).
    웹 쿼리는 `gpuAllocText.allocExportQuery` 하나(CSV·창·내려받기 공용 — 기본값은 싣지 않는다).
  - **v2.856 버그 수정 — 새로 고침이 상태 점도 다시 읽는다**: 법인 칩 상태 점(`/vcenters`)은 `load()` 가 계층과 함께 읽는다(예전에는 마운트 1회라
    '⟳ 새로 고침' 뒤에도 점이 그대로였다 — v2.853 보고의 한계). 다시 읽기가 실패하면 직전 점을 유지한다(처음 실패만 빈 목록). 회귀 `web gpuAllocRefresh2856.test.js`(소스 계약 — 수정 전 3건 실패 확인).
  - **v2.857 특수 기능 'GPU 할당율'(도구 키 `gpu-alloc`)로 독립**(사용자 요청 — 이름은 요청 그대로, 표준 표기 '할당률' 은 `aka`): API 는 `/tools/gpu-alloc*`
    (경로 첫 세그먼트 = 도구 키 규약 — 옛 `/tools/gpu/alloc*` 는 지웠다: 남기면 'GPU 인벤토리' 권한만으로 열려 gpu-alloc 거부가 집행되지 않는다) ·
    `auth/toolAccess.js` 매핑 · `toolcats/catalog.js` PRESET(서버·가상화) · `SpecialTools.jsx` 는 scope 콤보 없이(법인은 화면 안 칩).
    GPU 인벤토리의 옛 해시 `#/tools/gpu/alloc` 는 새 도구로 넘기고, 바로가기 단추는 `toolAllowed('gpu-alloc')` 일 때만 보인다.
  - **v2.868 호스트·VM CPU/메모리**(사용자 요청 '호스트의 CPU/Memory 와 VM 의 CPU/Memory 도 포함'): 스냅샷 값만(`allocTree.hostResOf`·`vmResOf` — 새 수집 없음).
    호스트 = 코어 · 메모리 GB · 사용률(끊긴 호스트는 null) · VM = vCPU · 메모리 GB · 사용률(꺼진 VM 은 null — 수집기가 0 을 싣는다).
    합계: 코어·메모리 **합** 은 모르는 호스트가 섞이면 null(부분 합 금지) · **사용률** 은 비율이라 읽은 호스트의 MHz·MB 합으로 내고 뺀 대수(`hostUseUnknown`)를
    비고에 적는다(한 대가 끊겼다고 법인 사용률을 지우지 않는다 — 처음 판은 null 로 지워 목 데이터 법인 행이 비었다) · 켜진 GPU VM 의 vCPU·메모리 합(`vmVcpu`·`vmMemGB`).
    엑셀 계층 표는 열이 6개 늘어 비고가 17번째 열이다(`treeLines` cells 17개 — 테스트가 고정).
  - **v2.869 법인별 시트 · 창은 모든 법인으로 시작**(사용자 요청 '전체 vCenter 한 시트는 유지하면서 1개 vCenter 를 1개 시트에' · '기본적으로 모든 vcenter 를 선택' —
    승인 시안 `docs/design/gpu-alloc-corp-sheets/`): 시트 키 `corp`(기본 켬 — `ALLOC_SHEET_KEYS` 넷) = **'목차'** + GPU 호스트가 있는 법인마다 계층 표 한 장.
    법인 시트는 전체 계층 표와 **같은 함수**(`addTreeSheet`)에 `{ totals: vc.totals, vcenters: [vc] }` 를 준 것 — 값을 새로 내지 않는다. 목차는 범위 안 법인 **전부**
    (`allocTree.allocCorpRoster` — 계층과 같은 범위 판정 `scopeTest` · GPU 없는 법인은 '시트 없음' · 용량 빈 칸). 시트 이름 `corpSheetNames`(31자 · 금지 문자 · 끝 `-.` ·
    고정 시트·대소문자 겹침은 `~2` — `hostExport.hostSheetNames` 와 같은 규칙) · 링크는 `util/xlsxInternalLink.js`(location 만 — 외부 관계 없음, 테스트가 XML 을 본다) ·
    '← 목차' 는 제목이 끝나는 칸 뒤(`backLinkCol` — 값이 있는 칸은 제목 넘침을 자른다) · 탭 색 목차 회색 · 법인 파랑 · 할당률 90% 이상 주황 · 법인 시트 상한 100(`CORP_SHEETS_MAX`).
    파일 이름 `_percorp`(`allocFileName` 다섯째 인자) · `export-meta` 가 `corpSheets`·`fileNamesPercorp` 를 같은 함수로 준다.
    창(`GpuAllocExportModal`)은 화면 칩 선택과 무관하게 **모든 법인(sel = null)** 으로 시작 · 칩으로 줄임 · '화면 선택대로' · 빈 선택은 내려받기 잠금(빈 `vcenterIds` 는 '전체' 로 읽히므로 보내지 않는다) ·
    전부 고르면 `vcenterIds` 를 싣지 않는다(`gpuAllocText.exportPick`). 옛 화면이 `sheets=tree,flat,info` 를 보내면 지금처럼 3시트다.
    실측(합성 28법인 × GPU 호스트 10대 · GPU 560장, 같은 프로세스): 3시트 0.64~0.86초 · 215KB → 법인별 포함 1.1~1.2초 · 373KB. 목 서버 첫 요청 두 번이 5.6~5.8초였는데 원인은 가리지 못했다(이후 0.17~0.53초).
  - **v2.871 버그 점검(사용자 요청 '버그 찾아서 개선' — GPU 할당율 전체, 메인 직접 점검)** 확정 3건:
    ① **GPU 아닌 패스스루를 GPU 로 셈** — `parseVmGpu` 는 VM 의 `VirtualPCIPassthrough` 장치를 전부 센다(NIC · HBA DirectPath 포함). 호스트 패스스루 GPU 목록은
    PCI 디스플레이 클래스(0x03)만이라, NIC 를 받은 VM 이 'GPU VM' 이 되고 GB 를 몰라(allocUnknown) 호스트~법인 **예비·할당률이 통째로 비었다**.
    `buildHostAlloc devOf`: 호스트 패스스루 GPU 가 모두 pciId 를 갖고 VM 장치 주소를 모두 읽었을 때만 주소로 가른다(맞는 것만 GPU · 대소문자 무시) —
    GPU 장치가 0 이면 계층에서 뺀다. 하나라도 모르면(구버전 수집기 · 꺼진 VM 동적 DirectPath) 예전처럼 전부 GPU(지어내지 않는다).
    ⚠ 근원(`parseVmGpu` 가 장치 종류를 가리지 않음)은 GPU 인벤토리(`gpu` 도구)에도 같은 영향이 있을 수 있다 — 이번 범위 밖(별건, 확인 안 함).
    ② **범위 글자** — 고른 법인을 계층(GPU 있는 법인)으로만 세어 GPU 없는 법인만 고르면 '조회 범위 안에 없음' 이라고 거짓으로 적고 파일 이름도 덜 셌다 →
    `allocScopeOf`(범위 안에서 고른 법인 = `allocCorpRoster` id · 5곳 이상이면 '외 N곳' — 창이 '모든 법인' 에서 한 곳만 빼도 제목이 끝없이 길어지지 않게).
    ③ **VM 행 정렬** — 꺼진 VM 을 보이지 않는 할당 값으로 정렬하고 '꺼진 VM GB' 정렬은 값이 늘 비어 움직이지 않았다 → 보이는 칸의 값으로(`keyVal`).
    정정: 처음에 '꺼진 VM GB 부분 합' 도 결함으로 보고 null 로 바꿨으나, main 의 v2.870 감사 A4-01 이 이미 '합 + 빠진 대수 비고' 로 다뤘고 이 모듈의
    할당 GB 도 같은 규칙(합 + '할당 모르는 VM N')이라 철회했다(넣었으면 할당과 꺼진 VM 의 규칙이 어긋난다).
    회귀: server `gpuAllocTree2852` v2.871 2건(변이: 주소 판정 끄기 · 대소문자 무시 끄기 둘 다 실패) · web `gpuAllocText` 1건(수정 전 판으로 실패 확인).
  - ⚠ 정직 기록: `HostGraphicsInfo.vm` 이 꺼진 VM 을 싣는지, 이 현장 vCenter 가 동적 DirectPath `assignedId` 를 주는지는 실장비로 확인하지 못했다
    (꺼진 VM 은 목록에 있어도 할당에 넣지 않으므로 결과는 같다). 한 VM 의 vGPU 장치 둘이 한 GPU 목록에 한 번만 오면 GPU 단위 할당이 한 장치분으로 적게 잡힌다(호스트 합은 정확).

- ⚠ **v2.873 Bareos 백업 대상 GPU 표지 — 판정은 `gpu/vgpuProfile.js vmGpuMark` 하나**(사용자 요청 'GPU VM 백업 대상 화면에 표지 추가' ·
  `routes/api/bareosBackup.js` viewJob · vm-candidates 의 `gpuDev` · 웹 `bareosText.gpuChip`. 회귀 `server/test/bareosGpuMark2873.test.js` + 웹 `bareosGpuChip2873.test.js`):
  VMware 는 vGPU·PCI 패스스루 장치가 있는 **켜진** VM 의 스냅샷을 지원하지 않는다(Broadcom KB 394566 — 검색 요약 기준, 원문은 세션 네트워크 정책으로 열지 못했다).
  대상 표 VM 칸 칩 · 등록 후보 칩 · 상세 패널 안내 한 줄(패널 머리 줄에는 칩을 두지 않는다). 웹은 서버 수를 글자로만 바꾼다(장치 판정 복제 금지).
  - **null = 모름 또는 없음** — 수집기는 GPU 호스트 위 VM 만 장치를 읽으므로(soapClient `gpuHostRefs`) GPU 없는 호스트의 NIC 패스스루 VM 은 표지가 없다. '장치 없음' 이라고 단정하는 문구를 쓰지 말 것.
  - 패스스루 수는 NIC·HBA DirectPath 도 센다(v2.871 ①) — 스냅샷 제약은 같으므로 백업 표지에는 맞는 값이다. 이름표는 'PCI 패스스루'(GPU 라고 단정하지 않는다).
  - 엣지 push 의 수는 중앙에서 좁혀지지 않으므로(sanitizeVmGpuField 는 pciIds 만) 정수 0~64 로 자르고, 프로파일은 이름 글자 64자만. 목록 응답 캐시(memoJson)는 스냅샷 세대로 무효화된다.
  - ⚠ 정직 기록: 메모리 없는 스냅샷(Bareos 플러그인 방식)이면 최신 vSphere 에서 vGPU VM 도 되는지는 확인하지 못했다 — 문구는 '실패할 수 있습니다' 이고 확인 방법(수동 스냅샷)을 적었다.
  - ✅ 정정(v2.882.1): 여기 '남긴 것' 으로 적었던 '1440 상세 패널 머리 줄이 GPU 칩 없이도 닫기를 둘째 줄로 내린다'(변경 전부터 — A/B)는 v2.882.1 에 고쳤다(머리 줄 구조 — `docs/rules/web.md` v2.860 ⑧ · `bareosPanelHead2882.test.js`). GPU 칩은 여전히 머리 줄에 두지 않는다.
