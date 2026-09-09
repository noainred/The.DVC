# 환경변수 레퍼런스 (자동 생성)

`server/src` 가 실제로 읽는 환경변수 **287개**를 코드에서 추출한 목록이다.
설치본에서는 `/etc/vmware-portal/portal.env` 에 `KEY=값` 으로 넣고 서비스를 재시작한다.

- 생성: `node scripts/env-doc.mjs` (마지막 갱신 2026-09-09)
- **이 파일을 직접 고치지 말 것** — 코드가 진실의 원천이며 다음 실행에서 덮어써진다.
- `portal.env.example` 에 예시가 있는 키는 ✅, 없는 키는 빈칸으로 표시한다.
- 기본값 칸이 비어 있으면 코드에서 한 줄로 추출하지 못한 것이다(해당 파일을 참조).

> ⚠️ 스토리지·SAN 수집 주기 등 **중앙에서 배포하는 값**은 portal.env 로 잡아도 중앙 설정이 우선한다
> (루트 CLAUDE.md '스토리지 폴러 주기는 중앙 배포값' 참조).


## 공용 유틸 (13)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `API_RATE_DISABLED` | `''` |  | util/rateLimit.js |
| `API_RATE_LIMIT` | `1800` |  | util/rateLimit.js |
| `API_RATE_WINDOW_MS` | `60000` |  | util/rateLimit.js |
| `GZIP_MIN_BYTES` | `1024` |  | util/compress.js |
| `LOOP_LAG_INTERVAL_MS` | `30000` |  | util/loopLag.js |
| `LOOP_LAG_MONITOR` | `기본 아님('0' 일 때만 적용)` |  | util/loopLag.js |
| `LOOP_LAG_WARN_MS` | `500` |  | util/loopLag.js |
| `SNAP_CACHE_PER_NAME` | `12` |  | util/snapCache.js |
| `SOAP_PARSE_MIN_CHARS` | `262144` |  | util/soapParsePool.js |
| `SOAP_PARSE_WORKERS` |  |  | util/soapParsePool.js |
| `WAN_CONNECT_TIMEOUT_MS` | `20000` |  | util/resilientFetch.js |
| `WAN_MAX_CONNECTIONS` | `6` |  | util/resilientFetch.js |
| `WAN_TLS_INSECURE` | `기본 적용('true' 로 끄기)` | ✅ | util/resilientFetch.js |

## 공통 (78)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `AGENT_AUTO_REGISTER` | `기본 적용('false' 로 끄기)` | ✅ | config.js |
| `AGENT_INVENTORY_INTERVAL_MS` | `60000` |  | config.js |
| `AGENT_NAME` |  | ✅ | config.js |
| `AGENT_PUSH_INVENTORY` | `기본 적용('false' 로 끄기)` |  | config.js |
| `AGENT_SCAN_INTERVAL_MS` | `3600000` | ✅ | config.js |
| `AUDIT_MAX` | `20000` |  | audit.js |
| `AUTH_ENABLED` | `기본 적용('false' 로 끄기)` | ✅ | config.js |
| `AUTH_SECRET` | `''` | ✅ | config.js |
| `AUTH_TOKEN_TTL` | `'8h'` | ✅ | config.js |
| `CAPACITY_DB_PATH` |  |  | config.js |
| `CAPACITY_MON_ENABLED` | `기본 적용('false' 로 끄기)` |  | config.js |
| `CAPACITY_PUSH` | `기본 적용('false' 로 끄기)` |  | config.js |
| `CAPACITY_PUSH_INTERVAL_MS` |  |  | config.js |
| `CAPACITY_RAW_RETENTION_HOURS` |  |  | config.js |
| `CAPACITY_ROLLUP_RETENTION_DAYS` |  |  | config.js |
| `CAPACITY_SAMPLE_INTERVAL_MS` |  |  | config.js |
| `CENTRAL_URL` | `''` | ✅ | config.js |
| `COLLECT_CONCURRENCY` | `8` |  | store.js |
| `COLLECTOR_DATACENTER` |  | ✅ | config.js |
| `COLLECTOR_PULL_INTERVAL_MS` |  | ✅ | config.js |
| `COLLECTOR_TIMEOUT_MS` | `20000` |  | config.js |
| `COLLECTOR_TOKEN` |  | ✅ | config.js |
| `CORS_ORIGINS` | `''` |  | index.js |
| `CSP` |  |  | index.js |
| `DATA_SOURCE` |  | ✅ | config.js |
| `DATACENTER` | `''` |  | config.js |
| `EDGE_MODE` | `''` | ✅ | config.js |
| `EDGE_TOKEN` |  | ✅ | config.js |
| `IDRAC_DB_PATH` |  | ✅ | config.js |
| `IDRAC_ENABLED` | `기본 적용('false' 로 끄기)` | ✅ | config.js |
| `IDRAC_POLL_CONCURRENCY` |  |  | config.js |
| `IDRAC_POLL_INTERVAL_MS` |  | ✅ | config.js |
| `IDRAC_RETENTION_DAYS` | `90` | ✅ | config.js |
| `IDRAC_SCAN_INTERVAL_MS` |  |  | config.js |
| `IDRAC_TIMEOUT_MS` | `15000` |  | config.js |
| `IPAM_DB_PATH` |  |  | config.js |
| `JSON_BODY_LIMIT` | `'16mb'` |  | index.js |
| `LASTGOOD_HOLD_MS` | `6` |  | store.js |
| `OME_POWER_DURATION` | `0` | ✅ | config.js |
| `OME_POWER_METRIC_TYPES` | `'3,4,1'` | ✅ | config.js |
| `OME_POWER_PLUGIN_ID` | `'2F6D05BE-EE4B-4B0E-B873-C8D2F64A4625'` | ✅ | config.js |
| `PACKAGE_BASE_URL` |  |  | config.js |
| `PACKAGE_DIR` |  |  | config.js |
| `PING_DB_PATH` |  |  | config.js |
| `PING_MON_CONCURRENCY` |  |  | config.js |
| `PING_MON_ENABLED` | `기본 적용('false' 로 끄기)` |  | config.js |
| `PING_MON_INTERVAL_MS` |  |  | config.js |
| `PING_MON_RETENTION_DAYS` | `365` |  | config.js |
| `PING_MON_TIMEOUT_MS` |  |  | config.js |
| `POLL_INTERVAL_MS` | `30000` | ✅ | config.js |
| `PORT` | `4000` | ✅ | config.js |
| `SERVER_HEADERS_TIMEOUT_MS` | `90000` |  | index.js |
| `SERVER_KEEPALIVE_MS` | `75000` |  | index.js |
| `SERVER_REQUEST_TIMEOUT_MS` | `600000` |  | index.js |
| `SERVICE_HUB_URL` | `''` |  | config.js |
| `SHOW_UPGRADE_TAB` | `기본 아님('true' 일 때만 적용)` |  | config.js |
| `SHUTDOWN_GRACE_MS` | `8000` |  | index.js |
| `SITE_INVENTORY_STALE_MS` | `300000` |  | store.js |
| `SVCMON_ROLE` | `''` |  | config.js |
| `TEMP_DB_PATH` |  |  | config.js |
| `TEMP_RETENTION_DAYS` | `1830` |  | config.js |
| `TEMP_SAMPLE_INTERVAL_MS` | `60000` |  | config.js |
| `TOTP_ISSUER` | `'VMware Portal'` |  | config.js |
| `TRUST_PROXY` |  | ✅ | index.js |
| `UPGRADE_AUTO_APPLY` | `기본 아님('true' 일 때만 적용)` | ✅ | config.js |
| `UPGRADE_DOWNLOAD_DIR` |  |  | config.js |
| `UPGRADE_EDGES` |  |  | config.js |
| `UPGRADE_ENABLED` | `기본 아님('true' 일 때만 적용)` | ✅ | config.js |
| `UPGRADE_PACKAGE_NAME` | `'vmware-portal'` |  | config.js |
| `UPGRADE_POLL_INTERVAL_MS` |  | ✅ | config.js |
| `UPGRADE_REMOTE_BASE` |  | ✅ | config.js |
| `UPGRADE_TOKEN` | `''` |  | config.js |
| `UPGRADE_WATCH_DIR` | `''` | ✅ | config.js |
| `VC_SOAP_METRICS` | `기본 적용('false' 로 끄기)` |  | config.js |
| `VC_TLS_CIPHERS` | `'DEFAULT@SECLEVEL=0'` |  | config.js |
| `VC_TLS_MIN_VERSION` | `'TLSv1'` |  | config.js |
| `VC_TLS_REJECT_UNAUTHORIZED` | `기본 아님('true' 일 때만 적용)` | ✅ | config.js |
| `VCENTERS_EXAMPLE_FALLBACK` | `기본 아님('true' 일 때만 적용)` |  | config.js |

## 로그 (1)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `VCLOGS_CONCURRENCY` | `6` |  | logs/poller.js |

## 메트릭 수집 (5)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `VMPERF_DB_DIR` |  |  | metrics/vmperfDb.js |
| `VMPERF_ENABLED` | `기본 적용('false' 로 끄기)` |  | metrics/vmperfSettings.js |
| `VMPERF_MAX_OPEN_DB` | `8` |  | metrics/vmperfDb.js |
| `VMPERF_RETENTION_DAYS` | `90` |  | metrics/vmperfSettings.js |
| `VMPERF_TRACK_TOTAL` | `기본 적용('false' 로 끄기)` |  | metrics/vmperfSettings.js |

## 베어메탈 스토리지 (4)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `BMSTOR_ACK_GRACE_MS` | `60000` |  | bmstor/jobs.js |
| `BMSTOR_CONCURRENCY` | `4` |  | bmstor/collect.js |
| `BMSTOR_PUSH_TIMEOUT_MS` | `180000` |  | bmstor/poller.js |
| `BMSTOR_SSH_TIMEOUT_MS` | `15000` |  | bmstor/collect.js |

## 보안 (11)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `LOGIN_FAIL_WINDOW_MS` | `15` |  | security/loginRateLimit.js |
| `LOGIN_GLOBAL_FACTOR` | `10` |  | security/loginRateLimit.js |
| `LOGIN_LOCKOUT_MS` | `15` |  | security/loginRateLimit.js |
| `LOGIN_MAX_FAILS` | `8` |  | security/loginRateLimit.js |
| `LOGIN_POLICY_USERS` | `''` |  | security/securitySettings.js |
| `LOGIN_RATELIMIT_DISABLED` | `기본 아님('true' 일 때만 적용)` |  | security/loginRateLimit.js |
| `OTP_FAIL_WINDOW_MS` | `10` |  | security/loginRateLimit.js |
| `OTP_LOCKOUT_MS` | `10` |  | security/loginRateLimit.js |
| `OTP_MAX_FAILS` | `5` |  | security/loginRateLimit.js |
| `OTP_RATELIMIT_DISABLED` | `기본 아님('true' 일 때만 적용)` |  | security/loginRateLimit.js |
| `SETTINGS_OWNERS` | `''` | ✅ | security/securitySettings.js |

## 분석 도구 (3)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `DISKTREND_CRIT_PCT` | `85` |  | tools/diskTrend.js |
| `DISKTREND_SNAPSHOT_MAX_HOURS` | `72` |  | tools/diskTrend.js |
| `DISKTREND_WARN_PCT` | `75` |  | tools/diskTrend.js |

## 서비스 모니터 (2)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `SVCMON_ENABLED` | `기본 적용('false' 로 끄기)` |  | svcmon/poller.js |
| `SVCMON_WORKERS` |  |  | svcmon/capacity.js |

## 수집 서버 (2)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `EDGE_PUSH_TIMEOUT_MS` | `600000` |  | collector/upgradePush.js, upgrade/upgrade.js |
| `SSRF_ALLOW_LOOPBACK` | `''` | ✅ | collector/registry.js |

## 스토리지 수집 (15)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `STORAGE_ACTIVITY_MAX` | `500` |  | storage/activityLog.js |
| `STORAGE_CLI_RAW_LIMIT` | `4000` |  | storage/collectors/cliSsh.js |
| `STORAGE_CLI_TIMEOUT_MS` | `45000` |  | storage/collectors/cliSsh.js |
| `STORAGE_DEVICE_TIMEOUT_MS` | `180000` |  | storage/poller.js |
| `STORAGE_HISTORY_KEEP_DAYS` | `400` |  | storage/db.js |
| `STORAGE_HTTP_TIMEOUT_MS` | `15000` |  | storage/collectors/isilon.js, storage/collectors/restCommon.js |
| `STORAGE_INTERVALS_LOCAL` | `''` |  | storage/intervals.js |
| `STORAGE_ISILON_PORT` | `8080` |  | storage/collectors/isilon.js |
| `STORAGE_POWERSTORE_LIST_LIMIT` | `2000` |  | storage/collectors/powerstore.js |
| `STORAGE_POWERSTORE_METRICS_INTERVAL` | `'OneDay'` |  | storage/collectors/powerstore.js |
| `STORAGE_POWERSTORE_PORT` | `443` |  | storage/collectors/powerstore.js |
| `STORAGE_UNISPHERE_PORT` | `8443` |  | storage/collectors/powermax.js |
| `STORAGE_UNITY_PORT` | `443` |  | storage/collectors/unity.js |
| `STORAGE_VPLEX_PORT` | `443` |  | storage/collectors/vplex.js |
| `STORAGE_XMS_PORT` | `443` |  | storage/collectors/xtremio.js |

## 시스템 (1)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `NFS_MOUNT_BASE` | `'/mnt/portal-nfs'` |  | system/nfsMounts.js |

## 업그레이드 (4)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `INVOCATION_ID` |  |  | upgrade/upgrade.js |
| `NOTIFY_SOCKET` |  |  | upgrade/upgrade.js |
| `UPGRADE_ALLOW_UNVERIFIED` | `기본 아님('true' 일 때만 적용)` | ✅ | upgrade/bundleSource.js, upgrade/fetchPackage.js 외 1 |
| `UPGRADE_TLS_INSECURE` | `기본 적용('true' 로 끄기)` |  | upgrade/upgradeAgent.js |

## 엣지 에이전트 (16)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `AGENT_BMSTOR_POLL_MS` | `10000` |  | agent/bmstorWorker.js |
| `AGENT_CAPTURE_POLL_MS` | `4000` |  | agent/captureWorker.js |
| `AGENT_CONFIG_PUSH_MS` | `1800000` |  | agent/configPush.js |
| `AGENT_DEPLOY_CONCURRENCY` | `2` | ✅ | agent/bulkDeploy.js |
| `AGENT_DEPLOY_TIMEOUT_MS` | `900000` | ✅ | agent/bulkDeploy.js |
| `AGENT_IDRAC_SCAN_POLL_MS` | `5000` |  | agent/idracScanWorker.js |
| `AGENT_LOGQ_POLL_MS` | `4000` |  | agent/logQueryWorker.js |
| `AGENT_PING_POLL_MS` | `4000` |  | agent/pingWorker.js |
| `AGENT_PUSH_FLEET` | `기본 적용('false' 로 끄기)` |  | agent/fleetPush.js |
| `AGENT_PUSH_GZIP` | `기본 적용('false' 로 끄기)` |  | agent/inventoryPush.js |
| `AGENT_PUSH_TIMEOUT_MS` | `60000` |  | agent/fleetPush.js, agent/inventoryPush.js |
| `EDGE_ADVERTISE_URL` | `''` | ✅ | agent/selfRegister.js |
| `SANSW_CONFIG_PULL_MS` | `5` |  | agent/sanSwitchConfigPull.js |
| `SVCMON_CONFIG_PULL` | `기본 적용('false' 로 끄기)` |  | agent/svcmonConfigPull.js |
| `SVCMON_PUSH` | `기본 적용('false' 로 끄기)` |  | agent/svcmonPush.js |
| `SVCMON_PUSH_GZIP` | `기본 적용('false' 로 끄기)` |  | agent/svcmonPush.js |

## 원격 명령(RMA) (6)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `RMA_ACK_GRACE_MS` | `30000` |  | rma/jobs.js |
| `RMA_HEARTBEAT_STALE_MS` | `90000` |  | rma/jobs.js |
| `RMA_HISTORY_DAYS` | `90` |  | rma/historyDb.js |
| `RMA_MAX_OUTPUT` | `256` | ✅ | rma/exec.js |
| `RMA_TEST_ALERT_STREAK` | `2` |  | rma/testResults.js |
| `RMA_TEST_HISTORY_DAYS` | `90` |  | rma/testResults.js |

## 원격 접속(프록시) (22)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `GUACD_HOST` | `''` |  | proxy/registry.js |
| `GUACD_PORT` | `4822` |  | proxy/registry.js |
| `HAPROXY_DATAPLANE_BASE` | `'/v3'` |  | proxy/registry.js |
| `HAPROXY_DATAPLANE_PASS` | `''` |  | proxy/registry.js |
| `HAPROXY_DATAPLANE_URL` | `''` |  | proxy/registry.js |
| `HAPROXY_DATAPLANE_USER` | `''` |  | proxy/registry.js |
| `PROXY_HAPROXY_CFG` | `'/etc/haproxy/haproxy.cfg'` |  | proxy/registry.js |
| `PROXY_PUBLIC_HOST` | `''` |  | proxy/registry.js |
| `PROXY_PUBLIC_PORT_BASE` | `20000` |  | proxy/registry.js |
| `PROXY_RELOAD_CMD` | `'systemctl reload haproxy'` |  | proxy/registry.js |
| `PROXY_SSH_HOST` | `''` |  | proxy/registry.js |
| `PROXY_SSH_PASS` | `''` |  | proxy/registry.js |
| `PROXY_SSH_PORT` | `22` |  | proxy/registry.js |
| `PROXY_SSH_USER` | `''` |  | proxy/registry.js |
| `PROXY_VALIDATE_CMD` | `'haproxy -c -f {file}'` |  | proxy/registry.js |
| `REMOTE_IDLE_TIMEOUT_MS` | `30` |  | proxy/sshGateway.js |
| `REMOTE_MAPPING_TTL_MS` | `24` |  | proxy/expiry.js |
| `REMOTE_MAX_SESSIONS` | `80` |  | proxy/sshGateway.js |
| `SSH_EXEC_MAX_OUTPUT` | `4` |  | proxy/sshExec.js |
| `SSH_EXEC_TIMEOUT_MS` | `60000` |  | proxy/sshExec.js |
| `SSH_LEGACY_FALLBACK` | `기본 적용('0' 로 끄기)` | ✅ | proxy/sshExec.js |
| `SSH_READY_TIMEOUT_MS` | `60000` |  | proxy/sshExec.js, proxy/sshGateway.js |

## 인사이트 (6)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `CONFIG_DIR` |  | ✅ | config.js, insights/dbLocation.js |
| `DB_HEALTH_COUNT_MAX_BYTES` | `512` |  | insights/dbHealth.js |
| `DB_HEALTH_FULL_MAX_BYTES` | `256` |  | insights/dbHealth.js |
| `PORTAL_DB_MIN_FORECAST_MS` | `3600000` |  | insights/portalDb.js |
| `PORTAL_DB_SAMPLE_MS` | `10` |  | insights/portalDb.js |
| `SERIAL_INDEX_CACHE_MS` | `30000` |  | insights/serialLookup.js |

## 인증·권한 (15)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `AD_ADMIN_GROUP` | `''` | ✅ | auth/ad.js |
| `AD_BASE_DN` | `''` | ✅ | auth/ad.js |
| `AD_DEFAULT_ROLE` | `'viewer'` | ✅ | auth/ad.js |
| `AD_DOMAIN` | `''` | ✅ | auth/ad.js |
| `AD_ENABLED` | `기본 아님('true' 일 때만 적용)` | ✅ | auth/ad.js |
| `AD_GROUP_MATCH` | `기본 아님('substring' 일 때만 적용)` | ✅ | auth/ad.js |
| `AD_OPERATOR_GROUP` | `''` |  | auth/ad.js |
| `AD_TIMEOUT_MS` | `8000` |  | auth/ad.js |
| `AD_TLS_REJECT_UNAUTHORIZED` | `기본 적용('false' 로 끄기)` | ✅ | auth/ad.js |
| `AD_URL` | `''` | ✅ | auth/ad.js |
| `AD_USER_FILTER` |  |  | auth/ad.js |
| `AD_VIEWER_GROUP` | `''` |  | auth/ad.js |
| `AUTH_DISABLED_ROLE` |  |  | auth/auth.js |
| `DEFAULT_ADMIN_PASSWORD` | `'admin123'` | ✅ | auth/auth.js, config.js |
| `OTP_ROLE_ENFORCE` | `기본 적용('false' 로 끄기)` |  | auth/auth.js |

## 중계 경로 점검 (1)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `RELAYCHECK_CONCURRENCY` | `4` | ✅ | relaycheck/poller.js |

## 중계 토폴로지 (2)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `RELAYTOPO_CONCURRENCY` | `4` | ✅ | relaytopo/ops.js |
| `RELAYTOPO_SSH_TIMEOUT_MS` | `45000` | ✅ | relaytopo/ops.js |

## 중앙(위임 수집) (11)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `CAPTURE_ACK_GRACE_MS` | `60000` |  | central/captureJobs.js |
| `CENTRAL_FLEET_MAX_AGENTS` | `500` |  | central/fleet.js |
| `CENTRAL_FLEET_TTL_MS` | `30` |  | central/fleet.js |
| `CENTRAL_PDU_TTL_MS` | `6` |  | central/pduEdge.js |
| `CENTRAL_TOKEN` | `''` | ✅ | central/token.js, config.js |
| `IDRAC_PUSH_TIMEOUT_MS` | `15` |  | central/idracScanPush.js |
| `IDRAC_SCAN_ACK_TIMEOUT_MS` | `90000` |  | central/idracScanJobs.js |
| `INGEST_PLAIN_WARN_BYTES` | `512` |  | central/ingestStats.js |
| `INGEST_PLAIN_WARN_STREAK` | `3` |  | central/ingestStats.js |
| `PING_ACK_TIMEOUT_MS` | `30000` |  | central/pingJobs.js |
| `SVCMON_SILENCE_ALERT` | `기본 적용('false' 로 끄기)` |  | central/svcmonSilence.js |

## 추이 트래킹 (3)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `VMTRACK_DB_PATH` |  |  | vmtrack/db.js |
| `VMTRACK_DS_DELTA_MIN_GB` | `1` |  | vmtrack/diff.js |
| `VMTRACK_RETENTION_DAYS` | `1095` |  | vmtrack/db.js |

## 헬스체크 (1)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `HEALTH_PROBE_TIMEOUT_MS` | `5000` |  | health/network.js |

## API 라우트 (19)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `CENTRAL_REQUIRE_AGENT_TOKEN` | `기본 아님('true' 일 때만 적용)` |  | routes/central.js |
| `CENTRAL_VERIFY_SELF_REGISTER` | `기본 적용('false' 로 끄기)` | ✅ | routes/central.js |
| `GPU_EXPORT_MAX_ROWS` | `300000` |  | routes/api/hardwareGpu.js |
| `METRICS_ALLOW_ANON` | `기본 적용('true' 로 끄기)` |  | routes/metricsExport.js |
| `METRICS_ALLOW_QUERY_TOKEN` | `기본 아님('true' 일 때만 적용)` |  | routes/metricsExport.js |
| `METRICS_EXPORT_TOKEN` | `''` |  | routes/metricsExport.js |
| `RIGHTSIZE_CAP_REDUCTION_PCT` |  |  | routes/api/toolsCapacity.js |
| `RIGHTSIZE_HEADROOM_PCT` |  |  | routes/api/toolsCapacity.js |
| `RIGHTSIZE_MIN_COVERAGE_PCT` |  |  | routes/api/toolsCapacity.js |
| `RIGHTSIZE_MIN_DAYS` |  |  | routes/api/toolsCapacity.js |
| `RIGHTSIZE_READY_WARN_PCT` |  |  | routes/api/toolsCapacity.js |
| `RMA_CRED_RATE_PER_MIN` | `120` |  | routes/central.js |
| `SECRETS_KEY` |  |  | routes/admin/opsSettings.js, security/secretVault.js |
| `SVCMON_XLSX_MAX_BYTES` | `8000000` |  | routes/svcmon/shared.js |
| `UPGRADE_INSTALL_DIR` | `''` | ✅ | config.js, routes/upgrade.js |
| `UPGRADE_PATH_ALLOW_BASES` | `''` |  | routes/upgrade.js |
| `UPGRADE_PATH_CHECK` | `''` |  | routes/upgrade.js |
| `VCLOGS_EXPORT_MAX_ROWS` | `100000` |  | routes/api/checksLogs.js |
| `WASTE_SPARK_MAX_VMS` | `24` |  | routes/api/toolsCapacity.js |

## GPU (1)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `GUEST_GPU_TTL_MS` | `30` |  | gpu/store.js |

## Horizon (1)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `HORIZON_TLS_VERIFY` | `기본 아님('true' 일 때만 적용)` |  | horizon/horizon.js |

## iDRAC/전력 (5)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `IDRAC_SENSOR_SAMPLES` | `1440` |  | idrac/sensorStore.js |
| `OME_POWER_CONCURRENCY` | `16` |  | idrac/ome.js |
| `POWER_CURRENT_STALE_MS` | `2` |  | idrac/service.js |
| `POWER_NDJSON_MAX_ROWS` | `2000000` |  | idrac/db.js |
| `ROOMTEMP_STALE_MS` | `15` |  | idrac/roomTemp.js |

## IP 관리 (7)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `IPAM_FPING` | `기본 아님('0' 일 때만 적용)` |  | ipam/scan.js |
| `IPAM_PING_CONCURRENCY` | `8` |  | ipam/scan.js |
| `IPAM_SCAN_DEADLINE_MS` | `20` |  | ipam/scanRunner.js |
| `IPAM_SCAN_WORKER` | `기본 적용('0' 로 끄기)` |  | ipam/scanRunner.js |
| `IPAM_WRITE_DEBOUNCE_MS` | `1500` |  | ipam/scanStore.js |
| `IPAM_WRITE_MIN_ROWS` | `500` |  | ipam/db.js |
| `IPAM_WRITE_WORKER` | `기본 적용('0' 로 끄기)` |  | ipam/db.js |

## LLM (4)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `LLM_ENABLED` | `기본 아님('true' 일 때만 적용)` |  | llm/config.js |
| `LLM_TIMEOUT_MS` | `30000` |  | llm/config.js |
| `OLLAMA_MODEL` | `'llama3.1'` |  | llm/config.js |
| `OLLAMA_URL` | `'http://localhost:11434'` |  | llm/config.js |

## NSX (1)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `NSX_TLS_REJECT_UNAUTHORIZED` | `기본 아님('true' 일 때만 적용)` |  | nsx/client.js |

## PDU (5)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `PDU_CONCURRENCY` | `4` |  | pdu/poller.js |
| `PDU_DB` |  |  | pdu/db.js |
| `PDU_DEVICE_TIMEOUT_MS` | `90000` |  | pdu/poller.js |
| `PDU_INTERVALS_LOCAL` | `기본 아님('1' 일 때만 적용)` |  | pdu/intervals.js |
| `PDU_RETAIN_DAYS` | `400` |  | pdu/db.js |

## SAN 스위치 (19)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `SANSW_CAPS_TTL_MS` | `6` |  | sanswitch/collectors/fosSsh.js |
| `SANSW_CLI_RAW_LIMIT` | `4000` |  | sanswitch/collectors/fosSsh.js |
| `SANSW_CLI_TIMEOUT_MS` | `45000` |  | sanswitch/collectors/fosSsh.js |
| `SANSW_CONCURRENCY` | `4` |  | sanswitch/poller.js |
| `SANSW_DEVICE_TIMEOUT_MS` | `120000` |  | sanswitch/poller.js |
| `SANSW_HTTP_TIMEOUT_MS` | `20000` |  | sanswitch/collectors/fosRest.js |
| `SANSW_PERF_CONCURRENCY` | `2` |  | sanswitch/perfPoller.js |
| `SANSW_PERF_DEVICE_TIMEOUT_MS` |  |  | sanswitch/perfPoller.js |
| `SANSW_PERF_LOCAL` | `''` | ✅ | sanswitch/perfSettings.js |
| `SANSW_PERF_PUSH_CHUNK_BYTES` | `700` |  | sanswitch/perfPush.js |
| `SANSW_PERF_PUSH_MS` |  | ✅ | sanswitch/perfPush.js |
| `SANSW_PERF_PUSH_ROWS` | `20000` | ✅ | sanswitch/perfPush.js |
| `SANSW_POLL_MS` | `5` |  | sanswitch/poller.js |
| `SANSW_PUSH_CHUNK_BYTES` | `700` |  | sanswitch/push.js |
| `SANSW_PUSH_GZIP` | `기본 적용('false' 로 끄기)` |  | sanswitch/perfPush.js, sanswitch/push.js |
| `SANSW_PUSH_MS` | `5` |  | sanswitch/push.js |
| `SANSW_PUSH_PORT_LIMIT` | `64` |  | sanswitch/push.js |
| `SANSW_TEST_PICKUP_MS` | `10` | ✅ | sanswitch/testRuns.js |
| `SANSW_TEST_RESULT_MS` | `5` | ✅ | sanswitch/testRuns.js |

## vCenter 수집 (2)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `PERF_COUNTER_TTL_MS` | `6` |  | vcenter/soapClient.js |
| `VC_KEEPALIVE_MS` | `4000` |  | vcenter/restClient.js |

## VM 프로비저닝 (1)

| 키 | 기본값 | 예시 | 정의 위치 |
|---|---|---|---|
| `PROVISION_CONCURRENCY` | `4` |  | provision/jobs.js |

---

예시 파일(`packaging/offline/portal.env.example`)에 있는 키: 59 / 287
