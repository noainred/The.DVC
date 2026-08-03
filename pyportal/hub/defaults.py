"""최초 기동 시 심어 두는 기본 바로가기.

'기본값 복원' 버튼도 이 목록으로 되돌린다. 사용자가 설정에서 만든 링크는
createdViaSettings=True 로 표시돼 화면에서 '사용자 추가' 배지가 붙는다.

카테고리 정의는 `catstore.py` 로 옮겼다(v2.216) — 설정 화면에서 편집할 수 있어야 하므로
코드 상수가 아니라 `categories.json` 이 진실의 원천이다. 여기 `category` 값은 그 파일의
seed id(`monitoring`·`infra`…)를 가리킨다.
"""

from __future__ import annotations

import copy

_DEFAULT_SHORTCUTS = [
    {
        "id": "sc-grafana", "name": "Grafana Global Metrics",
        "url": "https://grafana.internal.dc/d/global-overview",
        "category": "monitoring", "icon": "📈",
        "description": "28개 데이터센터 CPU·메모리·온도·전력 실시간 대시보드",
        "tags": ["Monitoring", "Realtime", "28 DCs"], "datacenterId": "all", "isFavorite": True,
    },
    {
        "id": "sc-netbox", "name": "NetBox DCIM Asset Manager",
        "url": "https://netbox.internal.dc/racks/global",
        "category": "infra", "icon": "🗄️",
        "description": "랙 배치·패치패널·전원 분전·IPAM 자산 관리",
        "tags": ["DCIM", "Racks", "IPAM"], "datacenterId": "all", "isFavorite": True,
    },
    {
        "id": "sc-k8s", "name": "Kubernetes Cluster Portal",
        "url": "https://k8s-portal.internal.dc/clusters",
        "category": "infra", "icon": "📦",
        "description": "글로벌 엣지 파드 멀티 클러스터 관리 콘솔",
        "tags": ["K8s", "Containers", "Pods"], "datacenterId": "all", "isFavorite": True,
    },
    {
        "id": "sc-snow", "name": "ServiceNow NOC Incident Desk",
        "url": "https://servicenow.internal.dc/nav_to.do?uri=incidents",
        "category": "incident", "icon": "🛟",
        "description": "24/7 글로벌 NOC 티켓·에스컬레이션·정비 이력",
        "tags": ["NOC", "Tickets", "SLA"], "datacenterId": "all", "isFavorite": True,
    },
    {
        "id": "sc-vault", "name": "HashiCorp Vault Key Management",
        "url": "https://vault.internal.dc/ui/vault/secrets",
        "category": "security", "icon": "🔐",
        "description": "시크릿·SSL 인증서·SSH 키 중앙 관리",
        "tags": ["Security", "Vault", "Secrets"], "datacenterId": "all", "isFavorite": False,
    },
    {
        "id": "sc-aci", "name": "Cisco ACI Network Topology",
        "url": "https://aci-controller.internal.dc/topology",
        "category": "network", "icon": "🕸️",
        "description": "Spine-Leaf 패브릭·BGP 경로·DC 간 다크파이버 연동",
        "tags": ["Network", "BGP", "SDN"], "datacenterId": "all", "isFavorite": True,
    },
    {
        "id": "sc-splunk", "name": "Splunk SIEM Log Analytics",
        "url": "https://splunk.internal.dc/en-US/app/search",
        "category": "incident", "icon": "📜",
        "description": "통합 syslog·방화벽 트래픽 분석·감사 추적",
        "tags": ["Logs", "SIEM", "Audit"], "datacenterId": "all", "isFavorite": False,
    },
    {
        "id": "sc-pue", "name": "Power & Cooling (PUE Tracker)",
        "url": "https://chiller-hvac.internal.dc/pue-monitor",
        "category": "infra", "icon": "⚡",
        "description": "항온항습·UPS 배터리·발전기 상태 및 PUE 텔레메트리",
        "tags": ["HVAC", "Power", "PUE"], "datacenterId": "all", "isFavorite": False,
    },
    {
        "id": "sc-cdn", "name": "CDN & Traffic Routing",
        "url": "https://cdn-dash.internal.dc/global-dc",
        "category": "network", "icon": "🌐",
        "description": "엣지 DDoS 방어·DNS 페일오버·글로벌 트래픽 조향",
        "tags": ["DNS", "CDN", "DDoS"], "datacenterId": "all", "isFavorite": False,
    },
    {
        "id": "sc-veeam", "name": "Backup / Disaster Recovery Portal",
        "url": "https://backup.internal.dc/dr-status",
        "category": "storage", "icon": "💾",
        "description": "DC 간 자동 스냅샷 백업 및 재해복구 오케스트레이션",
        "tags": ["Backup", "DR", "Storage"], "datacenterId": "all", "isFavorite": False,
    },
    {
        "id": "sc-icn1", "name": "Seoul (ICN-1) 로컬 관리 콘솔",
        "url": "https://icn1-mgmt.internal.dc/dashboard",
        "category": "infra", "icon": "🖥️",
        "description": "서울 센터 IPMI/KVM 및 블레이드 컨트롤러",
        "tags": ["ICN-1", "Seoul", "Console"], "datacenterId": "icn-01", "isFavorite": True,
    },
    {
        "id": "sc-fra1", "name": "Frankfurt (FRA-1) 관리 포탈",
        "url": "https://fra1-mgmt.internal.dc/dashboard",
        "category": "infra", "icon": "🖥️",
        "description": "프랑크푸르트 센터 IPMI/KVM 및 광 교차연결 포탈",
        "tags": ["FRA-1", "Frankfurt", "Europe"], "datacenterId": "fra-01", "isFavorite": True,
    },
    {
        "id": "sc-iad1", "name": "Ashburn (IAD-1) 관리 콘솔",
        "url": "https://iad1-mgmt.internal.dc/dashboard",
        "category": "infra", "icon": "🖥️",
        "description": "애시번 메가 센터 전력망 및 고밀도 GPU 클러스터 관리",
        "tags": ["IAD-1", "Virginia", "GPU"], "datacenterId": "iad-01", "isFavorite": True,
    },
]


def default_shortcuts() -> list:
    """호출할 때마다 깊은 복사본을 준다 — 상수 목록이 실수로 변형되지 않게."""
    return copy.deepcopy(_DEFAULT_SHORTCUTS)
