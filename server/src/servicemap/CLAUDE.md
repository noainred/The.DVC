# 서비스 인벤토리(`servicemap/` · 라우트 `routes/api/svcInventory.js` · 도구 키 `svc-inventory`) 불변조건 — v2.886

> 설계·결정 기록은 `docs/design/service-map/README.md`. 사용자 선택: 시안 2(전역 카탈로그 globalId + 커버리지 매트릭스) · 1+2단계 전부.

- **판정 코어는 `resolve.js` 하나**(순수): 고정(pin) → vCenter 폴더 규칙(vmPlacement `/ERP/prod` 모양 · `/` 경계 · 가장 긴 접두 · 루트 규칙은 `/` 만) →
  스캔 엔트리 라벨(서비스명 또는 별칭) → vSphere 태그(전역 카테고리 + 법인 켬일 때만 · 태그 못 읽음 = unchecked, 미지정과 다르다) → 이름 규칙(접두·접미·포함, 정규식 아님) → 미지정.
  **서비스는 자동으로 만들지 않는다** — 규칙 값에 맞는 서비스가 없으면 '매핑 안 된 값' 큐로 보낸다. 판정은 구성원당 1회, 결과 Map 을 표·큐·전역이 공유한다.
- **집계는 `corpusage/build.js` 의 `emptyAgg/addAgg/finishAgg` 를 그대로 쓴다**(가중 사용률 = Σ(사용률×용량)÷Σ용량 · 꺼진 VM 제외 · 못 읽음·오래됨·용량 없음은 따로 센다).
  같은 입력이면 법인 사용률 화면과 같은 값이어야 한다 — 복제 판정 금지.
- **저장소(`store.js`)**: 메모리가 진실 · 200ms 디바운스 원자 쓰기 · rev 단조 증가. 파일이 손상이면 **빈 트리로 시작하지 않고** 503 + 쓰기 차단,
  초기화(`store.reset`)는 전체 범위 관리자만이고 손상본을 보존한다(`preserveCorrupt`). 비밀은 싣지 않는다.
- **범위**: 조회는 `scopedVcenterIds` 교집합이 요청 필터보다 먼저 · 법인 대상 쓰기는 `corpWriteAccess`(모르는 법인·조회 밖 404 → 쓰기 밖 403, writeVcenters 미설정 = 조회 범위) ·
  전역 카탈로그·태그 카테고리·초기화는 전체 범위 관리자(`FLEET_OPS`). 법인 미지정 구성원은 범위 계정에 싣지 않는다. 응답 캐시는 범위·쓰기 범위·관리자·저장소 rev 를 키에 넣는다.
  비관리자 판본에는 스캔 엔트리 대역(CIDR)·주소 모양 BM 이름을 싣지 않는다.
- **고정**: 법인이 있는 구성원만(법인 없는 서버는 통합 서버 인벤토리에서 법인을 먼저 정한다). 자동 판정과 다르면 드리프트 큐(검토하면 해제). 법인이 바뀌면 무시(pinMismatch).
  유령 키는 그 법인을 못 읽었거나 베어메탈 출처를 못 읽었으면 **판정 보류**로 따로 둔다(지우지 않는다).
- **키**: VM = `iu:<vcenterId>:<instanceUuid>`(없으면 `vm:<moref id>`) · 베어메탈 = `st:<서비스태그>`(없으면 `fl:<fleetId sha1 16자>` — 주소 원문을 키에 싣지 않는다).
- **의존 방향**: 도메인 모듈(`servicemap/*`)은 `routes/` 를 import 하지 않는다(arch 테스트) — 스냅샷·fleet·장애·백업 입력 수집은 라우트 층에서 한다.
- 회귀: `server/test/svcInventory2886.test.js` · 웹 `web/src/views/tools/svcInventoryText.test.js`.
