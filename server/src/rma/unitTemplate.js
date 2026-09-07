/**
 * RMA systemd 템플릿 유닛(`vmware-portal-rma@.service`) 본문 — 원격 배포(rma/deploy.js)와
 * 오프라인 패키지(packaging/offline/vmware-portal-rma@.service)가 **같은 내용**을 써야 한다.
 * 회귀 테스트(test/rma.test.js)가 두 파일의 동일성을 고정한다 — 한쪽만 고치면 실패한다.
 * 플레이스홀더: @PREFIX@ @USER@ @CONFIG_DIR@ (install.sh 와 동일). %i = 인스턴스 이름.
 */
export const RMA_UNIT_TEMPLATE = `[Unit]
Description=VMware Portal RMA (remote command agent) instance %i
Documentation=https://github.com/noainred/The.DVC
After=network-online.target
Wants=network-online.target
# 포탈 본체와 함께 재시작(업그레이드 시 새 코드 반영) — 단, 본체가 죽어도 RMA 는 독립적으로 살아 있다.
PartOf=vmware-portal.service

[Service]
Type=simple
User=@USER@
Group=@USER@
EnvironmentFile=@CONFIG_DIR@/portal.env
EnvironmentFile=-@CONFIG_DIR@/rma-%i.env
Environment=RMA_INSTANCE=%i
Environment=NODE_ENV=production
WorkingDirectory=@PREFIX@/app
ExecStart=@PREFIX@/runtime/node/bin/node @PREFIX@/app/server/src/rma/agent.js
Restart=always
RestartSec=3
TimeoutStopSec=15
KillMode=mixed

# Hardening — 명령 실행 프로세스라 본체보다 완화(ProtectSystem=full 은 /usr 읽기 전용 유지).
NoNewPrivileges=false
PrivateTmp=true
ProtectSystem=full
ProtectControlGroups=true
ProtectKernelTunables=true
ReadWritePaths=@PREFIX@ @CONFIG_DIR@

[Install]
WantedBy=multi-user.target
`;

/** sudoers 규칙 — 프리셋 portal-restart(commands.js sudo:true)가 요구하는 단 한 줄. */
export const RMA_SUDOERS = (user) => `# vmware-portal RMA: 포탈 서비스 재시작만 허용(commands.js portal-restart)\n${user} ALL=(root) NOPASSWD: /usr/bin/systemctl restart vmware-portal.service\n`;

export function renderUnit({ prefix, user, configDir }) {
  return RMA_UNIT_TEMPLATE.replace(/@PREFIX@/g, prefix).replace(/@USER@/g, user).replace(/@CONFIG_DIR@/g, configDir);
}
