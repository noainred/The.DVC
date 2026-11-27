#!/usr/bin/env python3
"""RHEL 저장장치 이력 점검. Python 3.6+ 표준 라이브러리만 필요."""
import argparse
import bz2
from collections import Counter, defaultdict, namedtuple
from datetime import datetime, timezone
import glob
import gzip
import json
import lzma
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile


MEDIA = re.compile(
    r"\b(?:unrecovered read error|uncorrectable (?:read|write|medium|media|data) error|"
    r"unrecoverable (?:read|write|medium|media) error|medium error|media error|"
    r"bad sectors?|bad blocks?|critical medium error|media and data integrity error|"
    r"(?:error:\s*\{[^}]*\bUNC\b)|"
    r"(?:[1-9]\d*\s+(?:currently unreadable \(pending\)|offline uncorrectable) sectors?))\b", re.I)
IO = re.compile(
    r"\b(?:I/O error|blk_update_request:.*\berror|Buffer I/O error|"
    r"critical target error|DID_TIME_OUT|DID_NO_CONNECT|"
    r"ata\d+(?:\.\d+)?:.*(?:failed command|hard resetting link))\b", re.I)
FORMAT = re.compile(r"\b(?:mkfs(?:\.[\w-]+)?|mke2fs|make_filesystem|format(?:ted|ting)?)\b", re.I)
SUCCESS = re.compile(
    r"\b(?:format(?:ting)? (?:completed successfully|succeeded)|"
    r"successfully (?:formatted|created (?:the )?filesystem)|"
    r"(?:mkfs(?:\.[\w-]+)?|mke2fs|make_filesystem)\b.*"
    r"(?:\bcompleted successfully\b|\bsucceeded\b|\bexit(?: status| code)?[=: ]+0\b))", re.I)
NEGATIVE = re.compile(
    r"\b(?:no|zero)\s+(?:known\s+)?(?:bad (?:sectors?|blocks?)|media errors?|"
    r"medium errors?)\b|\b0\s+(?:bad (?:sectors?|blocks?)|media errors?|"
    r"medium errors?)\b|\b(?:media error(?:s| count)?|bad sector count)\s*[:=]\s*0\b|"
    r"\b(?:disabled|simulated|inject(?:ed|ing|ion)|example)\b", re.I)
LOCAL_HOST = socket.gethostname().lower().split(".")[0]
VIRTUAL = re.compile(
    r"virtual|logical|vbox|qemu|vmware|virtio|amazon elastic block|"
    r"persistentdisk|msft|multipath|megaraid|perc|mr[0-9]{3,4}", re.I)
DEVICE = re.compile(
    r"(?:/dev/|\bdev\s+|\[(?=(?:sd|hd|vd|xvd|nvme)))([\w./-]+)"
    r"|\b(nvme\d+(?:n\d+(?:p\d+)?)?|dm-\d+|md\d+|sd[a-z]+\d*)\b")
SERIAL = re.compile(r'\b(?:ID_SERIAL_SHORT|serial(?:[ _-]*(?:number|no\.?))?|S/N|SN)\s*[:=]\s*["\']?([\w.-]+)', re.I)
WWN = re.compile(
    r'\b(?:ID_WWN(?:_WITH_EXTENSION)?|WWN|World Wide (?:Name|N(?:umber)?))\s*[:=]\s*["\']?'
    r'((?:0x|naa\.|eui\.)?[0-9a-f]{16,32})(?![\w.-])'
    r'|\bwwn-(0x[0-9a-f]{16,32})(?![\w.-])', re.I)
ISO_TIME = re.compile(r"^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)")
SLOT = re.compile(r"/c(\d+)(?:/e(\d+))?/s(\d+)\b", re.I)
PERC_PD = re.compile(r"\bPD\s+[0-9a-f]+\s*\(e(\d+)/s(\d+)\)", re.I)
ANSI = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
Event = namedtuple("Event", "kind source line when ids device slot message")
Disk = namedtuple("Disk", "label ids slot active scope")


def clean(value):
    return ANSI.sub("?", str(value)).strip()


def identity(serial=None, wwn=None):
    result = set()
    if serial:
        serial = str(serial).strip()
        if (re.fullmatch(r"[A-Za-z0-9_.-]+", serial)
                and serial.lower() not in {"none", "unknown", "n/a", "na", "null", "serial", "default"}
                and serial.strip("0.-")):
            result.add(("SN", serial))
    if wwn:
        wwn = re.sub(r"^(0x|naa\.|eui\.)", "", str(wwn).strip().lower())
        if re.fullmatch(r"[0-9a-f]{16}|[0-9a-f]{32}", wwn) and wwn.strip("0f"):
            result.add(("WWN", wwn))
    return frozenset(result)


def log_ids(message):
    found = set()
    for value in SERIAL.findall(message):
        found.update(identity(serial=value))
    for values in WWN.findall(message):
        found.update(identity(wwn=next(value for value in values if value)))
    if any(sum(key == kind for key, _ in found) > 1 for kind in ("SN", "WWN")):
        return frozenset()
    return frozenset(found)


def raid_backed(path):
    # 가상 디스크 모델명은 펌웨어에 따라 다르므로 Linux 드라이버도 확인한다.
    device = os.path.realpath(os.path.join("/sys/class/block", os.path.basename(path), "device"))
    while device.startswith("/sys/devices/"):
        driver = os.path.join(device, "driver")
        if os.path.islink(driver) and os.path.basename(os.path.realpath(driver)) in {
                "megaraid_sas", "hpsa", "smartpqi", "aacraid"}:
            return True
        device = os.path.dirname(device)
    return False


def ids_text(ids):
    return " ".join("{}={}".format(*item) for item in sorted(ids)) or "식별자 없음"


def same_disk(left, right):
    shared = left & right
    if not shared:
        return False
    for kind in ("SN", "WWN"):
        a = {value for key, value in left if key == kind}
        b = {value for key, value in right if key == kind}
        if a and b and a.isdisjoint(b):
            return False
    return True


def different_disk(left, right):
    if left & right:
        return False
    return bool({kind for kind, _ in left} & {kind for kind, _ in right})


def timestamp(value):
    match = ISO_TIME.match(value)
    if not match:
        return None
    value = match.group().replace(",", ".").replace("Z", "+0000")
    value = re.sub(r"([+-]\d\d):(\d\d)$", r"\1\2", value).replace(" ", "T")
    fmt = "%Y-%m-%dT%H:%M:%S"
    try:
        return datetime.strptime(value, fmt + (".%f" if "." in value else "") + "%z").timestamp()
    except ValueError:
        return None


def record_time(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat() if value is not None else "시간 비교 불가"


def find_tool(*names):
    for name in names:
        path = shutil.which(name, path="/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/sbin:/usr/local/bin")
        if path and os.access(path, os.X_OK):
            return path
    return None


class Audit:
    def __init__(self, report, timeout, scratch):
        self.report = report
        self.timeout = timeout
        self.scratch = scratch
        self.events = []
        self.disks = []
        self.raid_disks = []
        self.raid_complete = False
        self.raid_virtual = set()
        self.direct_ids = {}
        self.coverage_gaps = 0

    def emit(self, line=""):
        print(line, file=self.report)
        try:
            if hasattr(sys.stdout, "buffer"):
                sys.stdout.buffer.write((line + "\n").encode("utf-8"))
                sys.stdout.buffer.flush()
            else:
                print(line)
        except BrokenPipeError:
            # 화면을 파이프로 연결한 경우에도 보고서 수집은 계속한다.
            sys.stdout = open(os.devnull, "w")

    def command(self, args, timeout=None):
        try:
            result = subprocess.run(
                args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=timeout or self.timeout, env=COMMAND_ENV, cwd=self.scratch)
        except (OSError, subprocess.TimeoutExpired) as exc:
            self.emit("  수집 실패 {} | {}".format(" ".join(args), clean(exc)))
            return None, ""
        out = result.stdout.decode("utf-8", "replace")
        err = result.stderr.decode("utf-8", "replace").strip()
        self.emit("  {} | 종료값 {}{}".format(
            " ".join(args), result.returncode, " | " + clean(err) if err else ""))
        return result.returncode, out

    def scan(self, source, lines, parse, evidence_source=None):
        total, invalid = 0, 0
        first = last = None
        start_count = len(self.events)
        try:
            for total, raw in enumerate(lines, 1):
                raw = raw.rstrip("\n\r")
                try:
                    message, when, origin, slot, display_time = parse(raw)
                except (ValueError, TypeError, AttributeError, OverflowError):
                    invalid += 1
                    continue
                if when is not None:
                    first = when if first is None else min(first, when)
                    last = when if last is None else max(last, when)
                if display_time:
                    origin = "{} {}".format(origin, display_time)
                kind = classify(message, origin)
                if kind:
                    device = DEVICE.search(message)
                    device = next((item for item in device.groups() if item), "") if device else ""
                    host = re.search(r"\bhost=(\S+)", origin)
                    local = not host or host[1].lower().split(".")[0] in {LOCAL_HOST, "localhost"}
                    ids = log_ids(message) if local and kind != "파일시스템 생성 명령" else frozenset()
                    if not local:
                        origin += " (로컬 호스트 연결 불가)"
                    self.events.append(Event(
                        kind, evidence_source or source, total, when, ids, device, slot,
                        "{} | {}".format(clean(origin), clean(message))))
        except (OSError, EOFError, ValueError, lzma.LZMAError) as exc:
            self.coverage_gaps += 1
            self.emit("  일부만 읽음 {} | {}".format(source, clean(exc)))
        if invalid:
            self.coverage_gaps += 1
        self.emit("  {} | {}줄, 후보 {}줄, 해석 실패 {}줄 | {} ~ {}".format(
            source, total, len(self.events) - start_count, invalid,
            record_time(first), record_time(last)))

    def logs(self):
        journal = find_tool("journalctl")
        if journal:
            rc, boots = self.command([journal, "--list-boots", "--no-pager"])
            if boots.strip():
                for line in boots.splitlines():
                    self.emit("    " + clean(line))
            args = [journal, "--no-pager", "--all", "--output=json"]
            # 전체 journal을 스트리밍한다. -k는 기본적으로 현재 부트로 범위를 제한한다.
            try:
                with tempfile.TemporaryFile() as errors:
                    with subprocess.Popen(
                            args, stdout=subprocess.PIPE, stderr=errors,
                            env=COMMAND_ENV, cwd=self.scratch, universal_newlines=True,
                            encoding="utf-8", errors="replace") as process:
                        self.scan("journalctl 전체 보존 부트", process.stdout, parse_journal)
                        rc = process.wait()
                    errors.seek(0)
                    error_text = errors.read().decode("utf-8", "replace").strip()
                if rc != 0 or error_text:
                    self.coverage_gaps += 1
                    self.emit("  journalctl 종료값 {} | {}".format(rc, clean(error_text)))
            except OSError as exc:
                self.coverage_gaps += 1
                self.emit("  journalctl 실패 | " + clean(exc))
        else:
            self.missing("journalctl")
        paths = sorted(glob.glob("/var/log/messages*"))
        if not paths:
            self.missing("/var/log/messages*")
        for path in paths:
            self.log_file(path)
        dmesg = find_tool("dmesg")
        if not dmesg:
            self.missing("dmesg")
            return
        rc, out = self.command([dmesg, "--color=never"])
        if rc != 0:
            rc, out = self.command([dmesg])
        if rc != 0:
            self.coverage_gaps += 1
        if out:
            self.scan("dmesg (현재 부트, 상대 시간)", out.splitlines(),
                      lambda line: (line, None, "kernel", None, None))

    def missing(self, name):
        self.coverage_gaps += 1
        self.emit("  수집 불가 | " + name)

    def log_file(self, path):
        try:
            if not stat.S_ISREG(os.stat(path).st_mode):
                return
            with open(path, "rb") as probe:
                magic = probe.read(6)
            opener = open
            for header, candidate in ((b"\x1f\x8b", gzip.open), (b"BZh", bz2.open),
                                      (b"\xfd7zXZ\x00", lzma.open)):
                if magic.startswith(header):
                    opener = candidate
                    break
            if magic.startswith((b"\x28\xb5\x2f\xfd", b"\x04\x22\x4d\x18", b"\x1f\x9d")) or (
                    opener == open and path.endswith((".zst", ".zstd", ".lz4", ".Z", ".gz", ".xz", ".bz2"))):
                tool = (find_tool("lz4") if path.endswith(".lz4") or magic.startswith(b"\x04\x22\x4d\x18")
                        else find_tool("gzip") if path.endswith(".Z") or magic.startswith(b"\x1f\x9d")
                        else find_tool("zstd") if path.endswith((".zst", ".zstd")) or magic.startswith(b"\x28\xb5\x2f\xfd")
                        else None)
                if not tool:
                    self.missing(path + " (압축 해제 명령 부재 또는 압축 파일 손상)")
                    return
                with tempfile.TemporaryFile() as errors:
                    with subprocess.Popen(
                            [tool, "-dc", "--", path], stdout=subprocess.PIPE, stderr=errors,
                            env=COMMAND_ENV, cwd=self.scratch, universal_newlines=True,
                            encoding="utf-8", errors="replace") as process:
                        self.scan(path, process.stdout, parse_syslog)
                        rc = process.wait()
                    if rc:
                        errors.seek(0)
                        self.missing("{} | 종료값 {} | {}".format(
                            path, rc, clean(errors.read().decode("utf-8", "replace"))))
                return
            with opener(path, "rt", encoding="utf-8", errors="replace") as stream:
                self.scan(path, stream, parse_syslog)
        except (OSError, EOFError, lzma.LZMAError) as exc:
            self.missing("{} | {}".format(path, clean(exc)))

    def raid(self):
        tool = find_tool("perccli64", "perccli", "storcli64", "storcli", "perccli2", "storcli2")
        if not tool:
            tool = next((path for path in RAID_PATHS if os.path.isfile(path) and os.access(path, os.X_OK)), None)
        if not tool:
            self.missing("perccli/storcli (RAID 구성이라면 물리 디스크 가시성 제한)")
            return
        rc, output = self.command([tool, "show", "J"])
        controller_numbers = parse_controller_list(output) if rc == 0 else []
        if not controller_numbers:
            rc, output = self.command([tool, "show"])
            if rc == 0 and raid_ok(output):
                controller_numbers = sorted(set(re.findall(
                    r"^\s*(\d+)\s+\S+\s+\d+\s+\d+\s+\d+", output, re.M)))
        if not controller_numbers:
            self.missing("PERC/StorCLI 컨트롤러 목록을 확인하지 못함")
            return
        complete = True
        for controller in controller_numbers:
            prefix = "/c" + controller
            rc, out = self.command([tool, prefix + "/vall", "show", "all"])
            for value in re.findall(r"^\s*OS Drive Name\s*=\s*(/dev/\S+)", out, re.M | re.I):
                self.raid_virtual.add(value)
            for value in re.findall(r"^\s*SCSI NAA Id\s*=\s*(\S+)", out, re.M | re.I):
                self.raid_virtual.update(identity(wwn=value))
            if rc != 0 or not raid_ok(out):
                self.emit("    가상디스크 상세 목록을 확인하지 못함")
            controller_disks = []
            rc, out = self.command([tool, prefix + "/eall/sall", "show", "all"])
            if rc == 0 and raid_ok(out):
                controller_disks = self.raid_inventory(out)
            if not controller_disks:
                rc, out = self.command([tool, prefix + "/sall", "show", "all"])
                if rc == 0 and raid_ok(out):
                    controller_disks = self.raid_inventory(out)
            if not controller_disks or any(not disk.ids for disk in controller_disks):
                complete = False
                self.missing(prefix + " RAID 물리 디스크 목록 또는 식별자 일부 확인 불가")
            self.raid_disks.extend(controller_disks)
            filename = os.path.join(self.scratch, "events_" + controller + ".txt")
            rc, out = self.command([tool, prefix, "show", "events", "file=" + filename])
            if rc == 0 and os.path.isfile(filename) and (
                    raid_ok(out) or not re.search(r"^\s*Status\s*=", out, re.M | re.I)):
                try:
                    with open(filename, encoding="utf-8", errors="replace") as stream:
                        self.scan(prefix + " 컨트롤러 이벤트", stream, perc_parser(controller))
                except OSError as exc:
                    self.missing(prefix + " 컨트롤러 이벤트 | " + clean(exc))
            elif rc == 0 and re.search(r"^\s*Event Description\s*:", out, re.M | re.I):
                self.scan(prefix + " 컨트롤러 이벤트", out.splitlines(), perc_parser(controller))
            else:
                self.missing(prefix + " 컨트롤러 이벤트 (도구/펌웨어별 지원 차이)")
        self.raid_complete = complete
        self.disks.extend(self.raid_disks)

    def raid_inventory(self, out):
        drives = {}
        slot = None
        for line in out.splitlines():
            heading = re.match(r"^\s*Drive\s+(/c\d+(?:/e\d+)?/s\d+)\b", line, re.I)
            if heading:
                slot = slot_tuple(SLOT.search(heading.group(1)))
                drives.setdefault(slot, {"ids": set()})
            if not slot:
                continue
            key, sep, value = line.partition("=")
            if not sep:
                continue
            key, value = key.strip().lower(), value.strip()
            if key in {"sn", "serial number", "wwn", "world wide name"}:
                drives[slot]["ids"].update(identity(
                    serial=value if key in {"sn", "serial number"} else None,
                    wwn=value if key in {"wwn", "world wide name"} else None))
            if key in {"media error count", "other error count", "predictive failure count", "s.m.a.r.t alert flagged by drive"}:
                drives[slot][key] = value
        disks = []
        for slot, info in sorted(drives.items()):
            label = slot_text(slot)
            disks.append(Disk(label, frozenset(info["ids"]), slot, False, "RAID 물리 디스크"))
            for key, value in info.items():
                if key != "ids":
                    self.emit("    {} | {} = {}".format(label, key, clean(value)))
                if key == "media error count" and value.isdigit() and int(value) > 0:
                    self.events.append(Event(
                        "매체 오류 기록", "PERC/StorCLI 카운터", 0, None,
                        frozenset(info["ids"]), "", slot, "{} | {} = {}".format(label, key, value)))
        return disks

    def os_inventory(self):
        lsblk = find_tool("lsblk")
        if not lsblk:
            self.missing("lsblk")
            return
        columns = "NAME,KNAME,TYPE,MODEL,SERIAL,WWN,TRAN,FSTYPE,MOUNTPOINT"
        rc, out = self.command([lsblk, "-J", "-p", "-o", columns])
        try:
            rows = json.loads(out)["blockdevices"] if rc == 0 else None
        except (ValueError, KeyError, TypeError):
            rows = None
        if not isinstance(rows, list):
            rc, out = self.command([lsblk, "-P", "-p", "-o", columns + ",PKNAME"])
            rows = lsblk_pairs(out) if rc == 0 else []
        if not rows:
            self.missing("lsblk 장치 인벤토리")
            return
        smart = find_tool("smartctl")
        if not smart:
            self.missing("smartctl")
        udev = find_tool("udevadm")
        seen = set()
        for node in walk(rows):
            path = node.get("name") or ""
            if (node.get("type") != "disk" or not re.fullmatch(r"/dev/[\w.-]+", path)
                    or path in seen):
                continue
            seen.add(path)
            props = {}
            if udev:
                rc, out = self.command([udev, "info", "--query=property", "--name=" + path])
                if rc == 0:
                    props = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
            ids = identity(props.get("ID_SERIAL_SHORT") or node.get("serial"),
                           props.get("ID_WWN") or node.get("wwn"))
            model = " ".join(filter(None, [node.get("model"), props.get("ID_MODEL"), props.get("ID_VENDOR")]))
            transport = node.get("tran") or ""
            virtual = bool(path in self.raid_virtual or ids & self.raid_virtual or
                           VIRTUAL.search(model + " " + transport) or raid_backed(path) or
                           re.match(r"/dev/(?:vd|xvd|dm-)", path))
            scope = VIRTUAL_SCOPE if virtual else "OS 노출 장치 (물리 여부는 구성에 따라 다름)"
            descendants = list(walk([node]))
            active = any(child.get("mountpoint") for child in descendants)
            if smart and not virtual:
                smart_ids, _ = self.smart(smart, path, ids if not virtual else frozenset(), virtual)
                if not virtual and (not ids or same_disk(ids, smart_ids)):
                    ids |= smart_ids
            if smart and virtual:
                self.emit("    {} | OS 가상/RAID 장치 직접 SMART 생략".format(path))
            self.disks.append(Disk(path, ids, None, active, scope))
            for child in descendants:
                if child.get("fstype") or child.get("mountpoint"):
                    self.emit("    {} 하위 {} | FS={} | 사용={}".format(
                        path, clean(child.get("name")), clean(child.get("fstype") or "-"),
                        clean(child.get("mountpoint") or "-")))

    def raid_smart(self, extra_targets=()):
        tool = find_tool("smartctl")
        if not tool:
            self.missing("smartctl (RAID 경유 조회)")
            return
        rc, out = self.command([tool, "--scan-open"])
        targets = {(path, kind.split("+")[-1]): kind for path, kind in extra_targets}
        for line in out.splitlines():
            fields = line.split()
            if len(fields) >= 3 and fields[1] == "-d":
                path, kind = fields[0], fields[2]
                if valid_raid_target(path, kind):
                    key = (path, kind.split("+")[-1])
                    if kind.startswith("sat+") or key not in targets:
                        targets[key] = kind
        if rc != 0:
            self.missing("smartctl --scan-open (목록 일부 또는 전체 조회 실패)")
        if not targets:
            self.emit("    smartctl이 발견한 MegaRAID/PERC 물리 SMART 경로 없음.")
            return
        for (path, base_type), device_type in sorted(targets.items()):
            # ATA 속성을 읽으려면 SATA 디스크에서 SAT 경유가 필요할 수 있다.
            preferred = "sat+" + base_type if base_type.startswith("megaraid,") else device_type
            ids, usable = self.smart(tool, path, frozenset(), False, preferred)
            if not usable and preferred != base_type:
                preferred = base_type
                ids, _ = self.smart(tool, path, frozenset(), False, preferred)
            label = "{} -d {}".format(path, preferred)
            if not ids:
                self.missing(label + " 물리 디스크 시리얼/WWN")
                continue
            candidates = [disk for disk in self.disks
                          if disk.scope != VIRTUAL_SCOPE and disk.ids & ids]
            if len(candidates) == 1 and same_disk(candidates[0].ids, ids):
                disk = candidates[0]
                self.disks[self.disks.index(disk)] = disk._replace(ids=disk.ids | ids)
                self.emit("    {} | {} | {}".format(label, disk.label, ids_text(ids)))
            else:
                self.disks.append(Disk(label, ids, None, False, "RAID 경유 물리 SMART"))

    def smart(self, tool, path, known, virtual, device_type=None):
        target = (["-d", device_type] if device_type else []) + [path]
        label = "{} -d {}".format(path, device_type) if device_type else path
        ata_passthrough = bool(device_type and device_type.startswith("sat+"))
        mode = "-a" if ata_passthrough else "-x"
        rc, out = self.command([tool, mode, "-j"] + target)
        try:
            data = json.loads(out)
            if not isinstance(data, dict) or rc is None or rc & 1:
                data = None
        except ValueError:
            data = None
        if data is None or (ata_passthrough and rc is not None and not rc & 3
                            and not (data.get("ata_smart_attributes") or {}).get("table")):
            rc, out = self.command([tool, mode] + target)
            data = None
            if rc is None or rc & 3:
                self.missing(label + " SMART 조회 (장치 열기/식별 실패)")
                self.smart_failure(out, data)
                return frozenset(), False
            if rc & 4:
                self.missing(label + " SMART 일부 항목 읽기 실패")
            ids, readings = smart_text(out)
        else:
            if rc is None or rc & 3:
                self.missing(label + " SMART 조회 (장치 열기/식별 실패)")
                self.smart_failure(out, data)
                return frozenset(), False
            if rc & 4:
                self.missing(label + " SMART 일부 항목 읽기 실패")
            ids, readings = smart_json(data)
        if known and ids and not same_disk(known, ids):
            self.emit("    {} | OS/SMART 식별자 연결 보류 | {} / {}".format(
                path, ids_text(known), ids_text(ids)))
            if different_disk(known, ids) or known & ids:
                virtual = True
        for kind, value in readings:
            self.emit("    {} | {}".format(label, value))
            if kind:
                self.events.append(Event(
                    kind, "smartctl " + label, 0, None, frozenset() if virtual else ids or known,
                    path, None, value + (" | 가상 또는 식별자 충돌" if virtual else "")))
        return (frozenset() if virtual else ids), (not ata_passthrough or bool(
            re.search(r"(?m)^\s*ID#\s+ATTRIBUTE_NAME", out) if data is None
            else (data.get("ata_smart_attributes") or {}).get("table")))

    def smart_failure(self, out, data):
        if data is not None:
            messages = (data.get("smartctl") or {}).get("messages") or []
            lines = [row.get("string", "") for row in messages if isinstance(row, dict)]
        else:
            lines = [line for line in out.splitlines()
                     if re.search(r"fail|unable|error|unsupported|unknown|specify", line, re.I)]
        for line in lines:
            self.emit("    " + clean(line))

    def findings(self):
        self.emit("\n[현재 디스크 인벤토리]")
        for disk in self.disks:
            usage = "있음" if disk.active else "미관측"
            if disk.slot or disk.scope == "RAID 경유 물리 SMART":
                usage = "물리 디스크에서 판단 불가"
            self.emit("  {} | {} | {} | 마운트/스왑 표시 {}".format(
                disk.label, disk.scope, ids_text(disk.ids), usage))
        if not self.disks:
            self.emit("  수집된 디스크 없음")
        self.emit("\n[판정]")
        errors = [item for item in self.events if item.kind in ERROR_KINDS]
        formats = [item for item in self.events if item.kind == "파일시스템 생성 성공 기록"]
        counts = Counter(item.kind for item in self.events)
        if errors:
            self.emit("  [확정] 수집 자료에서 다음 오류 또는 카운터 기록 관측 (줄 기준, 중복 가능)")
            for kind in ERROR_KINDS:
                if counts[kind]:
                    self.emit("    {} | {}건".format(kind, counts[kind]))
        else:
            self.emit("  [불명] 가용 자료에서 대상 오류 패턴 미검출. 과거 무장애 여부는 알 수 없음.")
        self.emit("  파일시스템 생성 성공 패턴 {}줄, 명령/시도 패턴 {}줄".format(
            len(formats), counts["파일시스템 생성 명령"]))
        physical_view = [disk for disk in self.disks if disk.scope != VIRTUAL_SCOPE]
        index = defaultdict(list)
        for disk in physical_view:
            for key in disk.ids:
                index[key].append(disk)
        format_index = defaultdict(list)
        for item in formats:
            for key in item.ids:
                format_index[key].append(item)
        historical = defaultdict(list)
        for number, item in enumerate(errors, 1):
            if item.ids:
                historical[item.ids, item.slot].append((number, item))
        if not historical:
            self.emit("  [불명] 포맷 후 재사용 및 교체 여부를 연결할 장애 디스크 식별 근거 부족.")
        unidentified = sum(not item.ids for item in errors)
        if unidentified:
            self.emit("  [불명] 오류 기록 {}줄의 물리 식별자를 연결할 수 없음.".format(unidentified))
        for (ids, slot), records in historical.items():
            self.emit("  {}{} | 오류 근거 {}".format(
                ids_text(ids), " " + slot_text(slot) if slot else "",
                ", ".join("#{}".format(number) for number, _ in records)))
            candidates = {disk for key in ids for disk in index[key]}
            matching = {disk for disk in candidates if same_disk(ids, disk.ids)}
            os_matches = [disk for disk in matching if not disk.slot and disk.scope != "RAID 경유 물리 SMART"]
            raid_matches = [disk for disk in matching if disk.slot]
            ambiguous = (candidates != matching or len(os_matches) > 1 or len(raid_matches) > 1
                         or (len(matching) > 1 and any(
                             disk.scope == "RAID 경유 물리 SMART" for disk in matching)))
            if matching and not ambiguous:
                self.emit("    [확정] 현재 인벤토리에 식별자 일치 | " +
                          ", ".join(sorted(disk.label for disk in matching)))
                available_formats = {item for key in ids for item in format_index[key]}
                error_times = [item.when for _, item in records
                               if item.when is not None and item.kind == "매체 오류 기록"]
                matching_formats = [
                    item for item in available_formats if item.when is not None and error_times
                    and item.when > min(error_times) and same_disk(ids, item.ids)]
                if matching_formats and any(disk.active for disk in os_matches):
                    self.emit("    [추정] 매체 오류 → 동일 ID 파일시스템 생성 성공 기록 → 현재 사용 표시.")
                else:
                    self.emit("    [불명] 매체 오류 이후 포맷 및 현재 재사용을 함께 입증할 근거 부족.")
                for item in sorted(matching_formats, key=lambda row: (row.when, row.source, row.line)):
                    self.emit("      " + describe(item))
                continue
            if ambiguous:
                self.emit("    [불명] 식별자 충돌/중복으로 현재 존재 및 교체 판정 보류.")
            else:
                self.emit("    [확정] 수집된 현재 인벤토리에서 일치 식별자를 찾지 못함.")
                occupants = [disk for disk in self.raid_disks if slot and disk.slot == slot]
                if (self.raid_complete and len(occupants) == 1
                        and different_disk(ids, occupants[0].ids)):
                    self.emit("    [추정] 같은 RAID 슬롯의 식별자가 다름 | 현재 " +
                              ids_text(occupants[0].ids) +
                              " | 컨트롤러/슬롯 번호가 유지됐다는 전제.")
                else:
                    self.emit("    [불명] 물리 부재 및 교체 여부를 연결할 근거 부족.")
            self.emit("    [불명] 포맷 후 현재 재사용 근거 부족.")
        self.emit("\n[상세 근거]")
        for number, item in enumerate(errors, 1):
            self.emit("  #{} {}".format(number, describe(item)))
        for item in self.events:
            if item.kind not in ERROR_KINDS:
                self.emit("  " + describe(item))
        self.emit("\n[해석 범위]")
        self.emit("  확인하지 못했거나 일부만 수집한 소스/항목 {}개.".format(self.coverage_gaps))
        self.emit("  삭제·회전·덮어쓰기·휘발성 로그, 오프호스트 로그 및 다른 journal namespace는 범위 밖.")
        self.emit("  파일명/장치명/슬롯/DID 단독으로 과거 물리 디스크와 현재 디스크를 연결하지 않음.")
        self.emit("  동일 기록에 명시된 SN/WWN만 연결. 현재 호스트명과 다른 로그는 ID 대조에서 제외.")
        self.emit("  일반 I/O 오류는 케이블·경로·컨트롤러·가상디스크 등에서도 발생할 수 있음.")
        self.emit("  SMART 카운터와 RAID 카운터는 조회 시점의 값이며 과거 오류 시간·포맷 시점을 제공하지 않음.")
        self.emit("  legacy syslog의 연도/시간대 및 dmesg의 상대 시간은 포맷 순서 판정에 사용하지 않음.")
        self.emit("  재사용은 현재 마운트/스왑 표시와 과거 성공 로그의 조합이며 파티션·FS 계보는 별도 확인 필요.")
        self.emit("  RAID 가상디스크의 OS 오류는 물리 슬롯으로 자동 귀속하지 않음. 숨겨진 디스크/경로는 미관측 가능.")
        self.emit("  SMART ID 5는 재할당 섹터 수, ID 196은 재할당 이벤트 수. 두 값을 합산하지 않음.")
        self.emit("  SMART RAID 인덱스는 물리 슬롯이나 과거 교체 이력으로 사용하지 않음.")
        self.emit("  서로 다른 소스에 복제된 기록은 각각 표시. 건수는 장애 횟수가 아님.")


VIRTUAL_SCOPE = "가상/논리 또는 RAID 경유 OS 장치"
ERROR_KINDS = ("매체 오류 기록", "I/O·경로 오류 기록", "재할당 기록")
COMMAND_ENV = {
    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
    "LC_ALL": "C", "SYSTEMD_PAGER": "cat", "SYSTEMD_COLORS": "0",
}
RAID_PATHS = (
    "/opt/MegaRAID/perccli/perccli64", "/opt/MegaRAID/perccli/perccli",
    "/opt/MegaRAID/storcli/storcli64", "/opt/MegaRAID/storcli/storcli",
    "/opt/MegaRAID/storcli2/storcli2", "/opt/lsi/perccli/perccli64",
    "/opt/lsi/perccli/perccli", "/opt/lsi/storcli/storcli64",
    "/opt/lsi/perccli2/perccli2", "/opt/MegaRAID/perccli2/perccli2",
)


def describe(item):
    location = "{}:{}".format(item.source, item.line) if item.line else item.source
    return "[{}] {} | {} | {}{}{} | {}".format(
        item.kind, location, record_time(item.when), ids_text(item.ids),
        " | 장치 " + item.device if item.device else "",
        " | " + slot_text(item.slot) if item.slot else "", item.message)


def classify(message, origin):
    if FORMAT.search(message):
        if (DEVICE.search(message) and SUCCESS.search(message)
                and not re.search(r"\b(?:COMMAND|EXECVE|PROCTITLE)=|\b(?:failed|aborted|dry.run|example|simulated)\b", message, re.I)):
            return "파일시스템 생성 성공 기록"
        if re.search(r"\b(?:mkfs(?:\.[\w-]+)?|mke2fs|make_filesystem)\b", message, re.I):
            if DEVICE.search(message):
                return "파일시스템 생성 명령"
    if NEGATIVE.search(message):
        return None
    if not re.match(r"^(?:kernel|smartd|perccli\d*|storcli\d*|megaraid_sas|perc-event|dmesg)(?:\s|$)", origin, re.I):
        return None
    if re.search(r"\b(?:media|medium) errors?\s+(?:recovered|corrected)\b|\brecovered (?:media|medium|read) error\b", message, re.I):
        return None
    if MEDIA.search(message):
        return "매체 오류 기록"
    if IO.search(message):
        return "I/O·경로 오류 기록"
    return None


def journal_string(value):
    if isinstance(value, list) and all(isinstance(item, int) for item in value):
        return bytes(value).decode("utf-8", "replace")
    return value if isinstance(value, str) else ""


def parse_journal(raw):
    row = json.loads(raw)
    message = journal_string(row.get("MESSAGE"))
    transport = journal_string(row.get("_TRANSPORT"))
    comm = journal_string(row.get("_COMM"))
    origin = "kernel" if transport == "kernel" else (comm or "journal")
    if origin == "kernel" and transport != "kernel":
        origin = "journal"
    slot = slot_tuple(SLOT.search(message)) if origin in ("perccli", "perccli64", "storcli", "storcli64", "storcli2") else None
    origin = "{} boot={} host={}".format(origin, row.get("_BOOT_ID", "?"), row.get("_HOSTNAME", "?"))
    value = row.get("__REALTIME_TIMESTAMP")
    when = int(value) / 1000000 if value else None
    if when is not None:
        datetime.fromtimestamp(when, timezone.utc)
    return message, when, origin, slot, None


SYSLOG = re.compile(
    r"^(?P<time>\d{4}-\d\d-\d\d[T ][^\s]+(?:\s+[^\s]+)?|"
    r"[A-Z][a-z]{2}\s+\d{1,2}\s+\d\d:\d\d:\d\d)\s+"
    r"(?P<host>\S+)\s+(?P<tag>[\w./-]+)(?:\[\d+\])?:\s*(?P<message>.*)$")
# ISO 시간 구문은 별도로 검사해 호스트 필드를 잘못 삼키지 않는다.
SYSLOG_ISO_REST = re.compile(r"^\s+(\S+)\s+([\w./-]+)(?:\[\d+\])?:\s*(.*)$")


def parse_syslog(raw):
    iso = ISO_TIME.match(raw)
    if iso:
        match = SYSLOG_ISO_REST.match(raw[iso.end():])
        if match:
            host, tag, message = match.groups()
            return message, timestamp(raw), "{} host={}".format(tag, host), None, iso.group()
    match = SYSLOG.match(raw)
    if match:
        return match["message"], None, "{} host={}".format(match["tag"], match["host"]), None, match["time"]
    return raw, None, "syslog (송신자 미확인)", None, None


def slot_tuple(match):
    if not match:
        return None
    return tuple(int(value) if value is not None else -1 for value in match.groups())


def slot_text(slot):
    controller, enclosure, bay = slot
    return "/c{}{}".format(controller, "/e{}".format(enclosure) if enclosure >= 0 else "") + "/s{}".format(bay)


def perc_parser(controller):
    seq = when = None

    def parse(raw):
        nonlocal seq, when
        key, _, value = raw.partition(":")
        key, value = key.strip().lower(), value.strip()
        if key in {"seqnum", "sequence number"}:
            seq, when = value, None
        elif key in {"time", "event time", "timestamp"}:
            # 컨트롤러 로컬 시간의 시간대는 추측하지 않는다.
            when = value
        elif key in {"event description", "description"}:
            match = SLOT.search(value)
            slot = slot_tuple(match)
            perc = PERC_PD.search(value)
            if slot and slot[0] != int(controller):
                slot = None
            if not slot and perc:
                slot = (int(controller), int(perc[1]), int(perc[2]))
            return value, timestamp(when or ""), "perc-event seq={}".format(seq or "?"), slot, when
        return "", None, "perc-event", None, None

    return parse


def raid_ok(output):
    return (bool(re.search(r"^\s*Status\s*=\s*Success\s*$", output, re.M | re.I))
            and not re.search(r"^\s*Status\s*=\s*(?:Failure|Failed)\b", output, re.M | re.I))


def parse_controller_list(output):
    try:
        rows = json.loads(output)["Controllers"]
        numbers = set()
        for row in rows:
            if row["Command Status"]["Status"].lower() != "success":
                return []
            for item in row["Response Data"]["System Overview"]:
                number = str(item["Ctl"])
                if not number.isdigit():
                    return []
                numbers.add(number)
        return sorted(numbers)
    except (ValueError, KeyError, TypeError, AttributeError):
        return []


def lsblk_pairs(out):
    rows = {}
    for line in out.splitlines():
        row = {}
        for key, value in re.findall(r'([A-Z][A-Z0-9_]*)="([^"]*)"', line):
            row[key.lower()] = re.sub(r"\\x([0-9a-fA-F]{2})", lambda match: chr(int(match[1], 16)), value)
        name = row.get("name")
        if name:
            rows[name] = row
    roots = []
    for name, row in rows.items():
        parent = row.get("pkname")
        if parent and parent not in rows:
            parent = "/dev/" + parent
        if parent in rows and parent != name:
            rows[parent].setdefault("children", []).append(row)
        else:
            roots.append(row)
    return roots


def walk(rows):
    for row in rows:
        if isinstance(row, dict):
            yield row
            yield from walk(row.get("children") or [])


def smart_json(data):
    wwn = data.get("wwn") or {}
    value = None
    if isinstance(wwn, dict):
        try:
            value = "{:01x}{:06x}{:09x}".format(wwn["naa"], wwn["oui"], wwn["id"])
        except (KeyError, TypeError, ValueError):
            pass
    elif isinstance(wwn, str):
        value = wwn
    ids = identity(data.get("serial_number"), data.get("logical_unit_id") or value)
    readings = []
    for row in (data.get("ata_smart_attributes") or {}).get("table", []):
        key = row.get("id")
        name = row.get("name") or ""
        # ATA 속성 ID는 제조사별 의미가 달라 이름과 함께 확인한다.
        accepted = {
            5: {"Reallocated_Sector_Ct", "Reallocated_Sector_Count"},
            196: {"Reallocated_Event_Count", "Reallocation_Event_Count"},
            197: {"Current_Pending_Sector"},
            198: {"Offline_Uncorrectable"},
            199: {"UDMA_CRC_Error_Count"},
        }
        if name in accepted.get(key, set()):
            raw_data = row.get("raw") or {}
            raw = str(raw_data.get("string") or raw_data.get("value", ""))
            number = re.match(r"^\s*(\d+)\b", raw)
            value = int(number[1]) if number else None
            kind = "재할당 기록" if key in (5, 196) else "I/O·경로 오류 기록" if key == 199 else "매체 오류 기록"
            readings.append((kind if value else None, "SMART ID {} {} RAW_VALUE = {}".format(key, name, clean(raw))))
    nvme = data.get("nvme_smart_health_information_log") or {}
    scsi = data.get("scsi_error_counter_log") or {}
    for name, value in [("NVMe Media and Data Integrity Errors", nvme.get("media_errors"))] + [
            ("SCSI {} total uncorrected errors".format(action), (scsi.get(action) or {}).get("total_uncorrected_errors"))
            for action in ("read", "write", "verify")]:
        if isinstance(value, int) and value >= 0:
            kind = "매체 오류 기록" if name.startswith("NVMe") else "I/O·경로 오류 기록"
            readings.append((kind if value else None, "{} = {}".format(name, value)))
    for key in ("summary", "extended"):
        log = (data.get("ata_smart_error_log") or {}).get(key) or {}
        for entry in log.get("table") or []:
            error = entry.get("completion_registers") or {}
            detail = error.get("error_description") or entry.get("error_description") or ""
            if re.search(r"\bUNC\b", detail):
                readings.append(("매체 오류 기록", "ATA {} SMART 오류 #{} | {} | Power-on hours={}".format(
                    key, entry.get("error_number", "?"), clean(detail), entry.get("lifetime_hours", "?"))))
    status = (data.get("smart_status") or {}).get("passed")
    if status is not None:
        readings.append((None, "SMART overall passed = {}".format(status)))
    return ids, readings


def smart_text(out):
    serial = re.search(r"^\s*Serial [Nn]umber:\s*(.+)$", out, re.M)
    wwn = re.search(r"^\s*(?:LU WWN Device Id|Logical Unit id):\s*(.+)$", out, re.M | re.I)
    ids = identity(serial[1] if serial else None, re.sub(r"\s+", "", wwn[1]) if wwn else None)
    readings = []
    for line in out.splitlines():
        match = re.match(
            r"^\s*(5\s+Reallocated_Sector_(?:Ct|Count)|196\s+Reallocat(?:ed|ion)_Event_Count|197\s+Current_Pending_Sector|"
            r"198\s+Offline_Uncorrectable|199\s+UDMA_CRC_Error_Count)"
            r"(?:\s+0x[0-9a-fA-F]+(?:\s+\S+){6}|\s+[-+A-Z_]{6}(?:\s+\S+){4})"
            r"\s+(\d+)\b", line)
        nvme = re.match(r"^\s*Media and Data Integrity Errors:\s*([\d,]+)", line)
        scsi = re.match(r"^\s*(read|write|verify):(?:\s+\S+){6}\s+(\d+)\s*$", line)
        if match:
            key = int(match[1].split()[0])
            kind = "재할당 기록" if key in (5, 196) else "I/O·경로 오류 기록" if key == 199 else "매체 오류 기록"
            readings.append((kind if int(match[2]) else None, clean(line)))
        elif nvme:
            readings.append(("매체 오류 기록" if int(nvme[1].replace(",", "")) else None, clean(line)))
        elif scsi:
            readings.append(("I/O·경로 오류 기록" if int(scsi[2]) else None, clean(line)))
        elif re.search(r"\bError:\s+UNC\b", line):
            readings.append(("매체 오류 기록", clean(line)))
        elif re.search(r"^\s*SMART (?:overall-health|Health Status)", line):
            readings.append((None, clean(line)))
    return ids, readings


def valid_raid_target(path, kind):
    return bool(re.fullmatch(r"/dev/(?:bus/\d+|[\w.-]+)", path)
                and re.fullmatch(r"(?:sat\+megaraid|megaraid|mpi3mr),\d+", kind))


def main():
    parser = argparse.ArgumentParser(
        description="RHEL 읽기 전용 디스크 오류 이력 점검. 화면과 시각이 포함된 보고서 파일에 기록합니다.")
    parser.add_argument("--output-dir", default=".", help="이미 존재하는 보고서 저장 디렉터리 (기본값: 현재 디렉터리)")
    parser.add_argument("--timeout", type=int, default=120,
                        help="개별 장치 조회 제한 시간(초). 전체 로그 스트림에는 적용하지 않음 (기본값: 120)")
    parser.add_argument("--raid-smart", action="append", nargs=2, default=[],
                        metavar=("DEVICE", "TYPE"),
                        help="자동 검색에 없는 물리 SMART 경로 추가 (반복 가능)")
    args = parser.parse_args()
    if any(not valid_raid_target(path, kind) for path, kind in args.raid_smart):
        parser.error("--raid-smart 예: --raid-smart /dev/bus/0 sat+megaraid,3")
    if args.timeout < 1:
        parser.error("--timeout은 1 이상이어야 합니다.")
    if not sys.platform.startswith("linux") or os.geteuid() != 0:
        print("Linux에서 root 권한으로 실행하세요.", file=sys.stderr)
        return 2
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    old_umask = os.umask(0o077)
    try:
        with tempfile.TemporaryDirectory(prefix="rhel-disk-audit-") as scratch:
            filename = os.path.abspath(os.path.join(args.output_dir, "rhel_disk_audit_" + stamp + ".txt"))
            with open(filename, "x", encoding="utf-8", buffering=1) as report:
                audit = Audit(report, args.timeout, scratch)
                audit.emit("RHEL 디스크 오류 이력 점검 | {} | {}".format(
                    clean(socket.gethostname()), datetime.now().astimezone().isoformat()))
                audit.emit("보고서 | " + clean(filename))
                audit.emit("\n[로그 수집 범위]")
                audit.logs()
                audit.emit("\n[PERC/StorCLI 조회]")
                audit.raid()
                audit.emit("\n[OS/SMART 조회]")
                audit.os_inventory()
                audit.emit("\n[RAID 경유 물리 SMART 조회]")
                audit.raid_smart(args.raid_smart)
                audit.findings()
                audit.emit("\n완료 | " + clean(filename))
    except (OSError, KeyboardInterrupt) as exc:
        print("점검 중단 | {}".format(clean(exc) or "사용자 중단"), file=sys.stderr)
        return 1
    finally:
        os.umask(old_umask)
    return 0


if __name__ == "__main__":
    sys.exit(main())
