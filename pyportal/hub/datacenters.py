"""전세계 28개 데이터센터 마스터 데이터.

포탈이 조회 전용으로 쓰는 정적 목록이다. 실제 사이트 정보로 바꿀 때는 이 파일만
수정하면 되고(서버 재기동 필요), 좌표는 등장방형 도법 지도 배치에 그대로 쓰인다.
"""

from __future__ import annotations

REGIONS = ("APAC", "EMEA", "AMER", "LATAM")

DATACENTERS = [
    # --- APAC (10) ---
    {"id": "icn-01", "code": "ICN-1", "name": "Seoul South Central DC", "city": "Seoul (서울)",
     "country": "South Korea", "region": "APAC", "pue": 1.18, "racks": 1200,
     "status": "operational", "lat": 37.5665, "lng": 126.9780, "primarySubnet": "10.100.0.0/16"},
    {"id": "nrt-01", "code": "NRT-1", "name": "Tokyo Narita Enterprise DC", "city": "Tokyo (도쿄)",
     "country": "Japan", "region": "APAC", "pue": 1.21, "racks": 1800,
     "status": "operational", "lat": 35.6762, "lng": 139.6503, "primarySubnet": "10.101.0.0/16"},
    {"id": "sin-01", "code": "SIN-1", "name": "Singapore Jurong Digital Hub", "city": "Singapore (싱가포르)",
     "country": "Singapore", "region": "APAC", "pue": 1.25, "racks": 1500,
     "status": "operational", "lat": 1.3521, "lng": 103.8198, "primarySubnet": "10.102.0.0/16"},
    {"id": "hkg-01", "code": "HKG-1", "name": "Hong Kong Cyberport DC", "city": "Hong Kong (홍콩)",
     "country": "Hong Kong", "region": "APAC", "pue": 1.23, "racks": 1100,
     "status": "operational", "lat": 22.3193, "lng": 114.1694, "primarySubnet": "10.103.0.0/16"},
    {"id": "syd-01", "code": "SYD-1", "name": "Sydney Alexandria DC", "city": "Sydney (시드니)",
     "country": "Australia", "region": "APAC", "pue": 1.20, "racks": 950,
     "status": "operational", "lat": -33.8688, "lng": 151.2093, "primarySubnet": "10.104.0.0/16"},
    {"id": "bom-01", "code": "BOM-1", "name": "Mumbai Navi Tech Park", "city": "Mumbai (뭄바이)",
     "country": "India", "region": "APAC", "pue": 1.28, "racks": 1300,
     "status": "operational", "lat": 19.0760, "lng": 72.8777, "primarySubnet": "10.105.0.0/16"},
    {"id": "kix-01", "code": "KIX-1", "name": "Osaka West Japan DC", "city": "Osaka (오사카)",
     "country": "Japan", "region": "APAC", "pue": 1.22, "racks": 1350,
     "status": "operational", "lat": 34.6937, "lng": 135.5023, "primarySubnet": "10.106.0.0/16"},
    {"id": "tpe-01", "code": "TPE-1", "name": "Taipei Changhua DC", "city": "Taipei (타이베이)",
     "country": "Taiwan", "region": "APAC", "pue": 1.20, "racks": 1250,
     "status": "operational", "lat": 25.0330, "lng": 121.5654, "primarySubnet": "10.107.0.0/16"},
    {"id": "cgk-01", "code": "CGK-1", "name": "Jakarta Cikarang DC", "city": "Jakarta (자카르타)",
     "country": "Indonesia", "region": "APAC", "pue": 1.26, "racks": 900,
     "status": "maintenance", "lat": -6.2088, "lng": 106.8456, "primarySubnet": "10.108.0.0/16"},
    {"id": "mel-01", "code": "MEL-1", "name": "Melbourne Port Phillip DC", "city": "Melbourne (멜버른)",
     "country": "Australia", "region": "APAC", "pue": 1.21, "racks": 850,
     "status": "operational", "lat": -37.8136, "lng": 144.9631, "primarySubnet": "10.109.0.0/16"},

    # --- EMEA (10) ---
    {"id": "fra-01", "code": "FRA-1", "name": "Frankfurt Main Exchange DC", "city": "Frankfurt (프랑크푸르트)",
     "country": "Germany", "region": "EMEA", "pue": 1.15, "racks": 2200,
     "status": "operational", "lat": 50.1109, "lng": 8.6821, "primarySubnet": "10.200.0.0/16"},
    {"id": "lon-01", "code": "LON-1", "name": "London Docklands DC", "city": "London (런던)",
     "country": "UK", "region": "EMEA", "pue": 1.17, "racks": 2000,
     "status": "operational", "lat": 51.5074, "lng": -0.1278, "primarySubnet": "10.201.0.0/16"},
    {"id": "cdg-01", "code": "CDG-1", "name": "Paris Saint-Denis DC", "city": "Paris (파리)",
     "country": "France", "region": "EMEA", "pue": 1.19, "racks": 1400,
     "status": "operational", "lat": 48.8566, "lng": 2.3522, "primarySubnet": "10.202.0.0/16"},
    {"id": "dub-01", "code": "DUB-1", "name": "Dublin Grange Castle DC", "city": "Dublin (더블린)",
     "country": "Ireland", "region": "EMEA", "pue": 1.14, "racks": 1600,
     "status": "operational", "lat": 53.3498, "lng": -6.2603, "primarySubnet": "10.203.0.0/16"},
    {"id": "zrh-01", "code": "ZRH-1", "name": "Zurich Alpine High-Sec DC", "city": "Zurich (취리히)",
     "country": "Switzerland", "region": "EMEA", "pue": 1.15, "racks": 950,
     "status": "operational", "lat": 47.3769, "lng": 8.5417, "primarySubnet": "10.204.0.0/16"},
    {"id": "mxp-01", "code": "MXP-1", "name": "Milan Caldera Park DC", "city": "Milan (밀라노)",
     "country": "Italy", "region": "EMEA", "pue": 1.21, "racks": 850,
     "status": "operational", "lat": 45.4642, "lng": 9.1900, "primarySubnet": "10.205.0.0/16"},
    {"id": "mad-01", "code": "MAD-1", "name": "Madrid Alcobendas DC", "city": "Madrid (마드리드)",
     "country": "Spain", "region": "EMEA", "pue": 1.22, "racks": 900,
     "status": "operational", "lat": 40.4168, "lng": -3.7038, "primarySubnet": "10.206.0.0/16"},
    {"id": "arn-01", "code": "ARN-1", "name": "Stockholm Nordic Eco DC", "city": "Stockholm (스톡홀름)",
     "country": "Sweden", "region": "EMEA", "pue": 1.12, "racks": 1100,
     "status": "operational", "lat": 59.3293, "lng": 18.0686, "primarySubnet": "10.207.0.0/16"},
    {"id": "jnb-01", "code": "JNB-1", "name": "Johannesburg Midrand DC", "city": "Johannesburg (요하네스버그)",
     "country": "South Africa", "region": "EMEA", "pue": 1.27, "racks": 800,
     "status": "degraded", "lat": -26.2041, "lng": 28.0473, "primarySubnet": "10.208.0.0/16"},
    {"id": "dxb-01", "code": "DXB-1", "name": "Dubai Silicon Oasis DC", "city": "Dubai (두바이)",
     "country": "UAE", "region": "EMEA", "pue": 1.29, "racks": 900,
     "status": "operational", "lat": 25.2048, "lng": 55.2708, "primarySubnet": "10.209.0.0/16"},

    # --- AMER (6) ---
    {"id": "iad-01", "code": "IAD-1", "name": "Ashburn Virginia Mega DC", "city": "Ashburn (애시번)",
     "country": "USA", "region": "AMER", "pue": 1.13, "racks": 3200,
     "status": "operational", "lat": 39.0438, "lng": -77.4874, "primarySubnet": "10.300.0.0/16"},
    {"id": "pdx-01", "code": "PDX-1", "name": "Oregon Hillsboro Green DC", "city": "Hillsboro (힐스보로)",
     "country": "USA", "region": "AMER", "pue": 1.12, "racks": 2800,
     "status": "operational", "lat": 45.5229, "lng": -122.9898, "primarySubnet": "10.301.0.0/16"},
    {"id": "sjc-01", "code": "SJC-1", "name": "Silicon Valley Santa Clara DC", "city": "Santa Clara (산타클라라)",
     "country": "USA", "region": "AMER", "pue": 1.16, "racks": 2100,
     "status": "operational", "lat": 37.3541, "lng": -121.9552, "primarySubnet": "10.302.0.0/16"},
    {"id": "ord-01", "code": "ORD-1", "name": "Chicago Elk Grove DC", "city": "Chicago (시카고)",
     "country": "USA", "region": "AMER", "pue": 1.17, "racks": 2400,
     "status": "operational", "lat": 41.8781, "lng": -87.6298, "primarySubnet": "10.303.0.0/16"},
    {"id": "yyz-01", "code": "YYZ-1", "name": "Toronto Vaughan Tech DC", "city": "Toronto (토론토)",
     "country": "Canada", "region": "AMER", "pue": 1.18, "racks": 1100,
     "status": "operational", "lat": 43.6532, "lng": -79.3832, "primarySubnet": "10.304.0.0/16"},
    {"id": "yul-01", "code": "YUL-1", "name": "Montreal Hydro-Green DC", "city": "Montreal (몬트리올)",
     "country": "Canada", "region": "AMER", "pue": 1.13, "racks": 1400,
     "status": "operational", "lat": 45.5017, "lng": -73.5673, "primarySubnet": "10.305.0.0/16"},

    # --- LATAM (2) ---
    {"id": "sao-01", "code": "SAO-1", "name": "Sao Paulo Barueri DC", "city": "Sao Paulo (상파울루)",
     "country": "Brazil", "region": "LATAM", "pue": 1.26, "racks": 1000,
     "status": "operational", "lat": -23.5505, "lng": -46.6333, "primarySubnet": "10.400.0.0/16"},
    {"id": "scl-01", "code": "SCL-1", "name": "Santiago Quilicura DC", "city": "Santiago (산티아고)",
     "country": "Chile", "region": "LATAM", "pue": 1.24, "racks": 750,
     "status": "operational", "lat": -33.4489, "lng": -70.6693, "primarySubnet": "10.401.0.0/16"},
]

DATACENTER_IDS = frozenset(dc["id"] for dc in DATACENTERS)


def summary() -> dict:
    """상단 통계 타일용 집계 — 목록 길이에 비례하는 단순 O(N) 계산."""
    total = len(DATACENTERS)
    operational = sum(1 for dc in DATACENTERS if dc["status"] == "operational")
    racks = sum(dc["racks"] for dc in DATACENTERS)
    avg_pue = round(sum(dc["pue"] for dc in DATACENTERS) / total, 3) if total else 0.0
    by_region = {region: 0 for region in REGIONS}
    for dc in DATACENTERS:
        by_region[dc["region"]] = by_region.get(dc["region"], 0) + 1
    return {
        "total": total,
        "operational": operational,
        "racks": racks,
        "avgPue": avg_pue,
        "byRegion": by_region,
    }
