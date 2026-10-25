#!/usr/bin/env python3
"""
Bluescan: Advanced Bluetooth Reconnaissance & Protocol Auditor.

A single-file, asynchronous CLI for auditing Bluetooth Low Energy devices:

* ``scan``              passive/active discovery with profile fingerprinting
* ``profile``           full GATT enumeration with attack-surface highlighting
* ``media``             AVRCP / MCS / VCS media-control injection
* ``simulate-takeover`` scripted state-machine stress sequence with notifications
* ``raw``               arbitrary hex injection for GATT fuzzing

Design notes
------------
* Everything is ``asyncio``; no blocking I/O inside the event loop.
* Every network/hardware step is bounded by ``asyncio.wait_for`` so the tool can
  never hang, and every connection is released in a ``finally`` block.
* Protocol payloads are built by pure functions (``build_*``) so they are unit
  tested byte-for-byte; see ``tests/test_bluescan.py``.

Protocol correctness (verified against the Bluetooth SIG AVRCP 1.3+ / AV/C Panel
Subunit specifications and against vendor stacks):

* PASS THROUGH opcode .................. 0x7C
* Panel subunit (``AVC_SUBUNIT_PANEL``) .. 0x09, encoded in the "subunit" octet
  as ``0x09 << 3`` = ``0x48`` (subunit id 0)
* AV/C frame .......................... ``ctype | subunit | opcode | opid|state | len``
* Released state bit ................... 0x80 (pressed = 0x00)
* AVRCP profile id (AVCTP PID) ......... 0x110E

So "Play, pressed" over GATT is ``00 48 7C 44 00`` and over AVCTP (transaction
label 2) ``20 11 0E 00 48 7C 44 00`` - both match real captures.

Important: AVRCP is a **Classic** Bluetooth profile carried over AVCTP/L2CAP; a
BLE GATT characteristic can only reach it when the firmware exposes a vendor
pass-through point (e.g. the widely used ``0000ae02`` handle) or implements the
LE Audio Media Control Service (MCS 0x1848) / Volume Control Service (VCS 0x1844).
Bluescan supports all three and tells you which one it found.

Authorisation
-------------
``media``, ``simulate-takeover`` and ``raw`` send real control traffic. They
require either ``--yes`` or an interactive ownership confirmation, and every
action is appended to an audit log (``bluescan-audit.log`` by default). Only run
them against devices you own or have written permission to test.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import platform
import re
import sys
import time
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Dict, Iterable, List, Optional, Sequence, Tuple

__version__ = "1.0.0"

try:  # pragma: no cover - import guard
    from bleak import BleakClient, BleakScanner
    from bleak.exc import (
        BleakBluetoothNotAvailableError,
        BleakCharacteristicNotFoundError,
        BleakDBusError,
        BleakDeviceNotFoundError,
        BleakError,
    )
except ImportError as exc:  # pragma: no cover
    sys.stderr.write(
        "bluescan requires the 'bleak' and 'rich' packages.\n"
        "Install them with:  pip install -r requirements.txt\n"
        f"(import error: {exc})\n"
    )
    raise SystemExit(2) from exc

try:  # pragma: no cover - import guard
    from rich.console import Console
    from rich.logging import RichHandler
    from rich.markup import escape
    from rich.panel import Panel
    from rich.table import Table
    from rich.text import Text
except ImportError as exc:  # pragma: no cover
    sys.stderr.write(
        "bluescan requires 'rich'.\n"
        "Install it with:  pip install -r requirements.txt\n"
        f"(import error: {exc})\n"
    )
    raise SystemExit(2) from exc


# ---------------------------------------------------------------------------
# Protocol constants
# ---------------------------------------------------------------------------

#: AVRCP / AV/C PASS THROUGH operation ids. Source: AVRCP 1.3+ Table 4.x,
#: mirrored by BlueZ ``profiles/audio/avrcp.c``, Android ``avrc_defs.h``,
#: Zephyr ``bt_avrcp_opid_t`` and Infineon ``wiced_bt_avrc_defs.h``.
#:
#: NOTE: ``pause`` is 0x46; 0x43 is **mute**. ``next``/``prev`` are the
#: FORWARD/BACKWARD ids 0x4B/0x4C.
AVRCP_OPERATION_IDS: Dict[str, int] = {
    "select": 0x40,
    "volume_up": 0x41,
    "volume_down": 0x42,
    "mute": 0x43,
    "play": 0x44,
    "stop": 0x45,
    "pause": 0x46,
    "record": 0x47,
    "rewind": 0x48,
    "fast_forward": 0x49,
    "eject": 0x4A,
    "next": 0x4B,
    "prev": 0x4C,
}

#: Actions selectable from the CLI (subset of the table above).
MEDIA_ACTIONS: Tuple[str, ...] = (
    "play",
    "pause",
    "stop",
    "next",
    "prev",
    "volume_up",
    "volume_down",
    "mute",
)

AVC_CTYPE_CONTROL: int = 0x00
AVC_SUBUNIT_PANEL: int = 0x09
AVC_SUBTYPE_SHIFT: int = 3
AVC_OPCODE_PASSTHROUGH: int = 0x7C
AVC_STATE_PRESSED: int = 0x00
AVC_STATE_RELEASED: int = 0x80
AVC_PASSTHROUGH_DATA_LEN: int = 0x00
AVCTP_PROFILE_ID: Tuple[int, int] = (0x11, 0x0E)  # AVRCP

#: LE Audio Media Control Service (MCS) / Media Control Point (MCP) opcodes.
MCP_OPCODES: Dict[str, int] = {
    "play": 0x01,
    "pause": 0x02,
    "stop": 0x03,
    "prev": 0x04,
    "next": 0x05,
    "rewind": 0x06,
    "fast_forward": 0x07,
}

#: LE Audio Volume Control Service (VCS) / Volume Control Point opcodes.
VCS_OPCODES: Dict[str, int] = {
    "volume_up": 0x00,
    "volume_down": 0x01,
}

UUID_AVRCP_PASSTHROUGH: str = "0000ae02-0000-1000-8000-00805f9b34fb"
UUID_MCS: str = "00001848-0000-1000-8000-00805f9b34fb"
UUID_MCP: str = "00002ba4-0000-1000-8000-00805f9b34fb"
UUID_VCS: str = "00001844-0000-1000-8000-00805f9b34fb"
UUID_VCP: str = "00002b7e-0000-1000-8000-00805f9b34fb"

#: Short (16-bit) UUID -> (profile label, fingerprint tag).
PROFILE_UUIDS: Dict[str, Tuple[str, str]] = {
    "110a": ("A2DP_SOURCE", "AUDIO_TARGET"),
    "110b": ("A2DP_SINK", "AUDIO_TARGET"),
    "110c": ("AVRCP_TARGET", "AUDIO_TARGET"),
    "110d": ("A2DP", "AUDIO_TARGET"),
    "110e": ("AVRCP", "AUDIO_TARGET"),
    "110f": ("AVRCP_CONTROLLER", "AUDIO_TARGET"),
    "1108": ("HSP_HEADSET", "PHONE_TARGET"),
    "1112": ("HSP", "PHONE_TARGET"),
    "111e": ("HFP_HANDSFREE", "PHONE_TARGET"),
    "111f": ("HFP_AUDIO_GATEWAY", "PHONE_TARGET"),
    "1203": ("GENERIC_AUDIO", "PHONE_TARGET"),
    "1812": ("HID", "INPUT_TARGET"),
    "180d": ("HEART_RATE", "SENSOR"),
    "180f": ("BATTERY", "SENSOR"),
}

#: Fingerprint tags in display priority order.
TAG_PRIORITY: Tuple[str, ...] = (
    "AUDIO_TARGET",
    "PHONE_TARGET",
    "INPUT_TARGET",
    "SENSOR",
    "BLE_DEVICE",
)

MAC_RE = re.compile(r"^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$")
UUID_SHORT_RE = re.compile(r"^[0-9a-f]{4}$")
UUID_FULL_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MAC_LIKE_RE = re.compile(r"^(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$|^[0-9a-fA-F-]{20,36}$")

MAX_RAW_BYTES = 512
DEFAULT_ATT_PAYLOAD = 20


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class BluescanError(Exception):
    """Base class for expected, user-facing failures."""


class DeviceNotFound(BluescanError):
    """The target address was never seen / is out of range."""


class CharacteristicMismatch(BluescanError):
    """The requested characteristic (or a media control point) does not exist."""


class NotAuthorized(BluescanError):
    """The operator did not confirm ownership of the target device."""


class UnsupportedAction(BluescanError):
    """The action cannot be expressed on the resolved protocol/characteristic."""


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass
class ScanResult:
    """One discovered BLE device plus fingerprint tags."""

    address: str
    name: str
    rssi: Optional[int]
    service_uuids: List[str] = field(default_factory=list)
    profiles: List[str] = field(default_factory=list)
    tags: List[str] = field(default_factory=list)
    manufacturer_ids: List[int] = field(default_factory=list)

    @property
    def primary_tag(self) -> str:
        """Highest-priority tag, e.g. ``AUDIO_TARGET``."""
        for tag in TAG_PRIORITY:
            if tag in self.tags:
                return tag
        return "BLE_DEVICE"

    def to_dict(self) -> Dict[str, Any]:
        """JSON-serialisable view."""
        return {
            "address": self.address,
            "name": self.name,
            "rssi": self.rssi,
            "tags": self.tags,
            "primary_tag": self.primary_tag,
            "profiles": self.profiles,
            "service_uuids": self.service_uuids,
            "manufacturer_ids": self.manufacturer_ids,
        }


@dataclass
class MediaCommandResult:
    """Outcome of a single media-control write."""

    action: str
    protocol: str
    characteristic: str
    payload: bytes
    ok: bool
    elapsed_ms: float = 0.0
    error: Optional[str] = None
    frames: List[bytes] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        """JSON-serialisable view (payload as hex)."""
        return {
            "action": self.action,
            "protocol": self.protocol,
            "characteristic": self.characteristic,
            "payload": self.payload.hex(" ").upper(),
            "ok": self.ok,
            "elapsed_ms": round(self.elapsed_ms, 2),
            "error": self.error,
        }


@dataclass
class CharacteristicInfo:
    """Flattened GATT characteristic for reporting."""

    service_uuid: str
    service_name: str
    uuid: str
    handle: int
    description: str
    properties: List[str]
    writable: bool
    notifiable: bool
    media_control: bool

    @property
    def flags(self) -> List[str]:
        """Short markers used in the profile table."""
        out: List[str] = []
        if "write" in [p.lower() for p in self.properties]:
            out.append("WRITE")
        if "write-without-response" in [p.lower() for p in self.properties]:
            out.append("WRITE_NR")
        if self.notifiable:
            out.append("NOTIFY")
        if self.media_control:
            out.append("MEDIA_CTRL")
        return out


@dataclass
class ProfileReport:
    """Result of a GATT enumeration."""

    address: str
    name: str
    services: List[Dict[str, Any]] = field(default_factory=list)
    characteristics: List[CharacteristicInfo] = field(default_factory=list)
    media_candidates: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def writable(self) -> List[CharacteristicInfo]:
        """Characteristics accepting writes (the injectable surface)."""
        return [c for c in self.characteristics if c.writable]

    @property
    def notifiable(self) -> List[CharacteristicInfo]:
        """Characteristics that can push state to us."""
        return [c for c in self.characteristics if c.notifiable]

    def to_dict(self) -> Dict[str, Any]:
        """JSON-serialisable view."""
        return {
            "address": self.address,
            "name": self.name,
            "services": self.services,
            "characteristics": [
                {
                    "service_uuid": c.service_uuid,
                    "service_name": c.service_name,
                    "uuid": c.uuid,
                    "handle": c.handle,
                    "description": c.description,
                    "properties": c.properties,
                    "flags": c.flags,
                }
                for c in self.characteristics
            ],
            "media_candidates": self.media_candidates,
            "counts": {
                "services": len(self.services),
                "characteristics": len(self.characteristics),
                "writable": len(self.writable),
                "notifiable": len(self.notifiable),
            },
        }


# ---------------------------------------------------------------------------
# Pure helpers (unit tested)
# ---------------------------------------------------------------------------


def normalise_uuid(value: str) -> str:
    """Expand a 16-bit UUID to its full 128-bit form and lowercase it."""
    raw = str(value).strip().lower().replace("0x", "")
    if UUID_SHORT_RE.match(raw):
        return f"0000{raw}-0000-1000-8000-00805f9b34fb"
    return raw


def short_uuid(value: str) -> str:
    """Return the 4-hex-digit short form when the base UUID matches."""
    full = normalise_uuid(value)
    if full.startswith("0000") and full.endswith("-0000-1000-8000-00805f9b34fb"):
        return full[4:8]
    return full


def profile_labels(uuids: Iterable[str]) -> Tuple[List[str], List[str]]:
    """Map service UUIDs to ``(profile_labels, tags)``.

    Fingerprinting rules (highest value first):

    * AVRCP (0x110E, 0x110C, 0x110F) or A2DP (0x110A, 0x110B, 0x110D)
      -> ``AUDIO_TARGET``
    * HFP (0x111E, 0x111F), HSP (0x1108, 0x1112) or Generic Audio (0x1203)
      -> ``PHONE_TARGET``
    * HID (0x1812) -> ``INPUT_TARGET``; Heart Rate / Battery -> ``SENSOR``
    """
    labels: List[str] = []
    tags: List[str] = []
    for uuid_value in uuids:
        key = short_uuid(uuid_value)
        info = PROFILE_UUIDS.get(key)
        if not info:
            continue
        label, tag = info
        if label not in labels:
            labels.append(label)
        if tag not in tags:
            tags.append(tag)
    return labels, tags


def normalise_mac(value: str) -> str:
    """Validate/normalise a target address.

    Accepts a Bluetooth MAC (``AA:BB:CC:DD:EE:FF``), a macOS CoreBluetooth UUID
    or a Linux ``hci0``-style identifier. Raises :class:`BluescanError` when the
    value cannot possibly be an address.
    """
    raw = str(value or "").strip()
    if not raw:
        raise BluescanError("empty device address")
    candidate = raw.upper().replace("-", ":")
    if MAC_RE.match(candidate):
        return candidate
    if re.fullmatch(r"[0-9A-Fa-f]{12}", raw):  # bare form: aabbccddeeff
        pairs = [raw.upper()[i : i + 2] for i in range(0, 12, 2)]
        return ":".join(pairs)
    # macOS gives an opaque UUID per peripheral; keep it verbatim.
    if re.match(r"^[0-9A-F]{8}(?::[0-9A-F]{4}){3}:[0-9A-F]{12}$", candidate):
        return raw
    if UUID_FULL_RE.match(raw.lower()) or re.match(r"^[0-9a-fA-F]{32}$", raw):
        return raw
    if not MAC_LIKE_RE.match(raw):
        raise BluescanError(
            f"'{raw}' does not look like a Bluetooth address "
            "(expected AA:BB:CC:DD:EE:FF, or a UUID on macOS)"
        )
    return raw


def parse_hex(hex_data: str) -> bytes:
    """Parse ``"AA BB CC"`` (also ``0xAA,BB:CC`` or ``AABBCC``) into bytes."""
    raw = str(hex_data or "").strip()
    if not raw:
        raise BluescanError("empty hex payload")
    cleaned = re.sub(r"0x", "", raw, flags=re.IGNORECASE)
    cleaned = re.sub(r"[\s,;:_-]+", "", cleaned)
    if not re.fullmatch(r"[0-9a-fA-F]+", cleaned):
        raise BluescanError(f"'{raw}' contains non-hex characters")
    if len(cleaned) % 2:
        raise BluescanError(f"'{raw}' has an odd number of hex digits")
    data = bytes.fromhex(cleaned)
    if len(data) > MAX_RAW_BYTES:
        raise BluescanError(
            f"payload is {len(data)} bytes; refusing more than {MAX_RAW_BYTES} "
            "in one injection (fuzzing long buffers can brick firmware)"
        )
    return data


def chunk_bytes(data: bytes, size: int) -> List[bytes]:
    """Split ``data`` into ``size``-byte writes; ``size <= 0`` means one write."""
    if not data:
        return []
    if size <= 0 or size >= len(data):
        return [data]
    return [data[i : i + size] for i in range(0, len(data), size)]


def build_avrcp_passthrough(
    action: str,
    *,
    pressed: bool = True,
    frame: str = "avc",
    transaction_label: int = 0,
) -> bytes:
    """Build an AVRCP PASS THROUGH frame for ``action``.

    ``frame`` selects the on-the-wire shape:

    * ``"avc"``   - spec-correct AV/C frame ``00 48 7C <opid|state> 00``
    * ``"avc4"``  - legacy 4-byte variant ``00 7C <opid|state> 00`` used by some
      vendor GATT media points
    * ``"avctp"`` - ``"avc"`` prefixed with the 3-byte AVCTP header
      ``<label><0x11><0x0E>``
    """
    key = str(action).strip().lower()
    if key not in AVRCP_OPERATION_IDS:
        raise UnsupportedAction(
            f"unknown AVRCP action '{action}'; choose from {', '.join(MEDIA_ACTIONS)}"
        )
    opid = AVRCP_OPERATION_IDS[key]
    state = AVC_STATE_PRESSED if pressed else AVC_STATE_RELEASED
    octet = (opid & 0x7F) | state

    if frame == "avc4":
        payload = bytes(
            [AVC_CTYPE_CONTROL, AVC_OPCODE_PASSTHROUGH, octet, AVC_PASSTHROUGH_DATA_LEN]
        )
    elif frame == "avc":
        payload = bytes(
            [
                AVC_CTYPE_CONTROL,
                AVC_SUBUNIT_PANEL << AVC_SUBTYPE_SHIFT,
                AVC_OPCODE_PASSTHROUGH,
                octet,
                AVC_PASSTHROUGH_DATA_LEN,
            ]
        )
    elif frame == "avctp":
        header = bytes(
            [
                (transaction_label & 0x0F) << 4,  # transaction label, type 0, request
                AVCTP_PROFILE_ID[0],
                AVCTP_PROFILE_ID[1],
            ]
        )
        payload = header + build_avrcp_passthrough(action, pressed=pressed, frame="avc")
    else:
        raise UnsupportedAction(f"unknown frame '{frame}' (use avc, avc4 or avctp)")
    return payload


def build_media_payloads(protocol: str, action: str, *, release: bool = True) -> List[bytes]:
    """Return the write payloads for ``action`` on ``protocol``.

    * ``avrcp`` -> press frame, then release frame (``release=False`` sends only
      the press, which some firmware requires for long-press behaviour)
    * ``mcp``   -> single MCS Media Control Point opcode
    * ``vcs``   -> single VCS Volume Control Point opcode
    """
    key = str(action).strip().lower()
    if protocol == "avrcp":
        payloads = [build_avrcp_passthrough(key, pressed=True)]
        if release:
            payloads.append(build_avrcp_passthrough(key, pressed=False))
        return payloads
    if protocol == "mcp":
        if key not in MCP_OPCODES:
            raise UnsupportedAction(
                f"Media Control Service has no '{key}' opcode "
                "(volume control lives in VCS 0x1844)"
            )
        return [bytes([MCP_OPCODES[key]])]
    if protocol == "vcs":
        if key not in VCS_OPCODES:
            raise UnsupportedAction(
                f"Volume Control Service has no '{key}' opcode (only volume_up/volume_down)"
            )
        return [bytes([VCS_OPCODES[key]])]
    raise UnsupportedAction(f"unknown protocol '{protocol}'")


def protocol_for_uuid(uuid_value: str) -> str:
    """Pick the media protocol that matches a characteristic UUID."""
    short = short_uuid(uuid_value)
    if short == short_uuid(UUID_MCP):
        return "mcp"
    if short == short_uuid(UUID_VCP):
        return "vcs"
    return "avrcp"


def friendly_error(exc: BaseException) -> Tuple[str, str, List[str]]:
    """Translate an exception into ``(level, message, hints)``.

    Covers the four scenarios in the brief: device not found, connection
    refused, UUID mismatch and permission denied - all of which surface
    differently on Linux (BlueZ/DBus), Windows (WinRT) and macOS (CoreBluetooth).
    """
    system = platform.system()
    text = str(exc)
    lowered = text.lower()

    def linux_hint() -> List[str]:
        return [
            "Linux: allow your user to use Bluetooth:",
            "  sudo usermod -aG bluetooth $USER   (then log out/in)",
            "  or run:  sudo setcap 'cap_net_raw,cap_net_admin+eip' "
            "$(readlink -f $(which python3))",
            "  make sure the adapter is up:  bluetoothctl power on",
        ]

    if isinstance(exc, DeviceNotFound) or isinstance(exc, BleakDeviceNotFoundError):
        return (
            "error",
            f"device not found: {text or 'no response from target'}",
            [
                "check the address (scan again), and that the device is powered, in range "
                "and advertising"
            ],
        )
    if isinstance(exc, BleakCharacteristicNotFoundError) or isinstance(exc, CharacteristicMismatch):
        return (
            "error",
            f"UUID mismatch: {text}",
            ["run 'bluescan.py profile <MAC>' to list the real characteristic handles/UUIDs"],
        )
    if isinstance(exc, PermissionError) or "permission" in lowered or "access denied" in lowered:
        hints = [f"{system}: the OS refused Bluetooth access"] + (
            linux_hint() if system == "Linux" else []
        )
        if system == "Darwin":
            hints.append(
                "macOS: System Settings -> Privacy & Security -> Bluetooth -> enable your terminal"
            )
        if system == "Windows":
            hints.append("Windows: Settings -> Privacy -> Bluetooth -> allow desktop apps")
        return ("error", f"permission denied: {text}", hints)
    if isinstance(exc, (ConnectionError,)) or "connect" in lowered or "refused" in lowered:
        hints = ["the device may be paired to another host, busy, or out of range"]
        if "111" in text or "refused" in lowered:
            hints.insert(
                0, "TCP equivalent of 'connection refused': the device rejected the GATT link"
            )
        hints.append("retry with --connect-timeout 30, or disconnect other hosts first")
        return ("error", f"connection refused/failed: {text}", hints)
    if isinstance(exc, FileNotFoundError) or "no such file or directory" in lowered:
        hints = (
            [
                "Linux: install/start the Bluetooth stack:",
                "  sudo apt install bluez   &&   sudo systemctl start bluetooth",
                "  check the adapter exists:  ls /sys/class/bluetooth",
            ]
            if system == "Linux"
            else ["this host reports no Bluetooth adapter or service"]
        )
        return ("error", f"Bluetooth stack unavailable: {text}", hints)
    if isinstance(exc, BleakBluetoothNotAvailableError):
        hints = linux_hint() if system == "Linux" else ["check that Bluetooth is turned on"]
        return ("error", f"no Bluetooth adapter available: {text}", hints)
    if isinstance(exc, BleakDBusError):
        return ("error", f"BlueZ/DBus error: {text}", linux_hint() if system == "Linux" else [])
    if isinstance(exc, (TimeoutError, asyncio.TimeoutError)):
        return (
            "warn",
            "operation timed out",
            ["the device is likely busy or refusing the request; retry or power-cycle it"],
        )
    if isinstance(exc, BleakError):
        return (
            "error",
            f"Bluetooth error: {text}",
            ["re-run with --verbose for the raw traceback"],
        )
    return ("error", text or exc.__class__.__name__, [])


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


class TagLogger:
    """``[INFO]``/``[WARN]``/``[ERROR]``/``[AUDIT]`` console logging with colour."""

    STYLES = {
        "info": ("cyan", "INFO"),
        "warn": ("yellow", "WARN"),
        "error": ("bold red", "ERROR"),
        "audit": ("bold green", "AUDIT"),
        "debug": ("dim", "DEBUG"),
    }

    def __init__(self, console: Console, verbose: bool = False) -> None:
        self.console = console
        self.verbose = verbose

    def _emit(self, level: str, message: str) -> None:
        colour, label = self.STYLES.get(level, ("white", level.upper()))
        if level == "debug" and not self.verbose:
            return
        tag = Text(f"[{label}]", style=colour)
        body = Text.from_markup(escape(str(message)))
        self.console.print(tag, body, sep=" ", highlight=False)

    def debug(self, message: str) -> None:
        """Verbose-only diagnostic line."""
        self._emit("debug", message)

    def info(self, message: str) -> None:
        """Normal operation."""
        self._emit("info", message)

    def warn(self, message: str) -> None:
        """Non-fatal problem."""
        self._emit("warn", message)

    def error(self, message: str) -> None:
        """Fatal-for-this-command problem."""
        self._emit("error", message)

    def audit(self, message: str) -> None:
        """A control frame was successfully sent to a target."""
        self._emit("audit", message)

    def hints(self, hints: Sequence[str]) -> None:
        """Print indented remediation hints."""
        for hint in hints:
            self.console.print(Text(f"       {hint}", style="dim"))


# ---------------------------------------------------------------------------
# Fake-friendly protocol helpers for testing
# ---------------------------------------------------------------------------


def _char_properties(char: Any) -> List[str]:
    """Normalise characteristic properties to a lowercase list."""
    props = getattr(char, "properties", []) or []
    return [str(p).lower() for p in props]


def iter_services(client: Any) -> List[Any]:
    """Return GATT services as a list for any bleak version."""
    services = getattr(client, "services", None)
    if services is None:
        return []
    if hasattr(services, "services"):
        return list(services.services.values())
    return list(services)


def iter_characteristics(service: Any) -> List[Any]:
    """Return a service's characteristics as a list."""
    chars = getattr(service, "characteristics", None)
    if chars is None:
        return []
    if isinstance(chars, dict):
        return list(chars.values())
    return list(chars)


def find_characteristic(client: Any, uuid_value: str) -> Optional[Any]:
    """Find a characteristic by full or short UUID (case-insensitive)."""
    wanted = normalise_uuid(uuid_value)
    wanted_short = short_uuid(uuid_value)
    for service in iter_services(client):
        for char in iter_characteristics(service):
            char_uuid = str(getattr(char, "uuid", ""))
            if normalise_uuid(char_uuid) == wanted or short_uuid(char_uuid) == wanted_short:
                return char
    return None


MEDIA_CHARACTERISTIC_UUIDS: Tuple[str, ...] = (UUID_AVRCP_PASSTHROUGH, UUID_MCP, UUID_VCP)


def resolve_media_characteristic(client: Any, override: Optional[str] = None) -> Tuple[str, Any]:
    """Locate the media-control characteristic and its protocol.

    Order: explicit override, AVRCP pass-through point (0xAE02), MCS Media
    Control Point (0x2BA4), VCS Volume Control Point (0x2B7E), then a heuristic
    scan of writable characteristics whose service looks audio/media related.
    """
    if override:
        char = find_characteristic(client, override)
        if char is None:
            raise CharacteristicMismatch(
                f"no characteristic {override} on this device (see 'profile <MAC>')"
            )
        return protocol_for_uuid(str(getattr(char, "uuid", override))), char

    for uuid_value in MEDIA_CHARACTERISTIC_UUIDS:
        char = find_characteristic(client, uuid_value)
        if char is not None:
            return protocol_for_uuid(uuid_value), char

    for service in iter_services(client):
        haystack = f"{getattr(service, 'uuid', '')} {getattr(service, 'description', '')}".lower()
        if not any(word in haystack for word in ("avrcp", "media", "audio", "1848", "1844")):
            continue
        for char in iter_characteristics(service):
            props = _char_properties(char)
            if "write" in props or "write-without-response" in props:
                return protocol_for_uuid(str(getattr(char, "uuid", ""))), char

    writable = [
        str(getattr(c, "uuid", ""))
        for s in iter_services(client)
        for c in iter_characteristics(s)
        if "write" in _char_properties(c) or "write-without-response" in _char_properties(c)
    ]
    raise CharacteristicMismatch(
        "no media control characteristic found "
        f"(looked for {', '.join(MEDIA_CHARACTERISTIC_UUIDS[:1])} and LE Audio MCS/VCS). "
        + (
            f"Writable candidates: {', '.join(writable)}"
            if writable
            else "Device exposes no writable characteristics."
        )
    )


# ---------------------------------------------------------------------------
# BluetoothMaster
# ---------------------------------------------------------------------------


class BluetoothMaster:
    """Stateful controller for scanning, profiling and media-control injection.

    Parameters
    ----------
    console:
        Rich console (a quiet one is created for tests).
    verbose:
        Emit debug lines (``--verbose``).
    dry_run:
        Build and print payloads without touching hardware.
    authorized:
        Skip the interactive ownership prompt (``--yes``).
    audit_log:
        JSONL file that receives one record per active action.
    connect_timeout / write_timeout:
        Hard bounds; nothing in this class can wait forever.
    client_factory:
        Inject a client class (tests use a fake that mimics ``BleakClient``).
    """

    def __init__(
        self,
        *,
        console: Optional[Console] = None,
        verbose: bool = False,
        dry_run: bool = False,
        authorized: bool = False,
        audit_log: Optional[Path] = None,
        connect_timeout: float = 20.0,
        write_timeout: float = 5.0,
        client_factory: Any = None,
    ) -> None:
        self.console = console or Console(highlight=False)
        self.log = TagLogger(self.console, verbose=verbose)
        self.verbose = verbose
        self.dry_run = dry_run
        self.authorized = authorized
        self.audit_log = Path(audit_log) if audit_log else Path("bluescan-audit.log")
        self.connect_timeout = float(connect_timeout)
        self.write_timeout = float(write_timeout)
        self.client_factory = client_factory or BleakClient
        self.devices: Dict[str, ScanResult] = {}

    # -- audit --------------------------------------------------------------

    def _audit(self, **entry: Any) -> None:
        """Append one JSONL audit record (best effort, never raises)."""
        record = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "command": entry.pop("command", "unknown"),
            "target": entry.pop("target", None),
            "dry_run": self.dry_run,
            **entry,
        }
        try:
            self.audit_log.parent.mkdir(parents=True, exist_ok=True)
            with self.audit_log.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record) + "\n")
        except OSError as exc:  # pragma: no cover - filesystem edge case
            self.log.debug(f"could not write audit log: {exc}")

    def require_authorization(self, target: str) -> None:
        """Gate active tests behind an explicit ownership confirmation."""
        if self.authorized or self.dry_run:
            return
        if not sys.stdin.isatty():
            raise NotAuthorized(
                "refusing to send control traffic without confirmation. "
                "Re-run with --yes once you have confirmed you own this device."
            )
        answer = self.console.input(
            f"[yellow]Confirm you own [bold]{escape(target)}[/bold] "
            "or have written permission to test it (y/N): [/yellow]"
        )
        if answer.strip().lower() not in {"y", "yes"}:
            raise NotAuthorized("authorisation not confirmed - nothing was sent")

    @asynccontextmanager
    async def session(self, target: str, *, label: str = "connecting") -> AsyncIterator[Any]:
        """Connect with a spinner + timeout, always disconnecting afterwards."""
        address = normalise_mac(target)
        if self.dry_run:
            self.log.info(f"[dry-run] would connect to {address}")
            yield _DryRunClient()
            return

        client = self.client_factory(address, timeout=self.connect_timeout)
        try:
            with self.console.status(f"[cyan]{label} {escape(address)}...", spinner="dots"):
                await asyncio.wait_for(client.connect(), timeout=self.connect_timeout)
            self.log.info(f"connected to {address}")
            yield client
        except asyncio.TimeoutError as exc:
            raise DeviceNotFound(f"connection to {address} timed out") from exc
        finally:
            with suppress(Exception):
                if getattr(client, "is_connected", False):
                    await asyncio.wait_for(client.disconnect(), timeout=self.write_timeout)
                    self.log.debug(f"disconnected from {address}")

    # -- 1. scan ------------------------------------------------------------

    async def scan(
        self,
        duration: int = 10,
        *,
        name_filter: Optional[str] = None,
        services: bool = True,
    ) -> Dict[str, ScanResult]:
        """Discover BLE devices for ``duration`` seconds.

        Returns a dict keyed by address. Each entry carries RSSI, advertised
        service UUIDs and fingerprint tags (``AUDIO_TARGET`` / ``PHONE_TARGET``
        / ...). Classic-only devices never advertise over BLE, so they are
        identified here only when their GATT/advert data includes those UUIDs.
        """
        if self.dry_run:
            self.log.info(f"[dry-run] would scan for {duration}s and print a fingerprint table")
            return {}

        self.console.print()
        with self.console.status(
            f"[cyan]scanning for {duration}s (BLE advertisements)...", spinner="dots12"
        ):
            found: Dict[str, Any] = {}
            try:
                result = await asyncio.wait_for(
                    BleakScanner.discover(timeout=float(duration), return_adv=True),
                    timeout=float(duration) + 15.0,
                )
            except TypeError:  # older bleak without return_adv
                devices = await asyncio.wait_for(
                    BleakScanner.discover(timeout=float(duration)),
                    timeout=float(duration) + 15.0,
                )
                result = {d.address: (d, None) for d in devices}
            except asyncio.TimeoutError as exc:
                raise BluescanError("scan timed out - is the Bluetooth adapter up?") from exc
            except Exception as exc:  # noqa: BLE001 - mapped to a friendly message
                _level, message, _hints = friendly_error(exc)
                raise BluescanError(message) from exc
            found = result

        devices: Dict[str, ScanResult] = {}
        for address, payload in found.items():
            device, adv = payload
            uuids = [str(u).lower() for u in (getattr(adv, "service_uuids", None) or [])]
            name = getattr(adv, "local_name", None) or getattr(device, "name", None) or "-"
            rssi = getattr(adv, "rssi", None) if adv is not None else getattr(device, "rssi", None)
            labels, tags = profile_labels(uuids)
            if name_filter and name_filter.lower() not in str(name).lower():
                continue
            devices[address] = ScanResult(
                address=address,
                name=str(name),
                rssi=int(rssi) if isinstance(rssi, (int, float)) else None,
                service_uuids=uuids,
                profiles=labels,
                tags=tags or ["BLE_DEVICE"],
                manufacturer_ids=sorted(
                    int(k) for k in (getattr(adv, "manufacturer_data", None) or {})
                ),
            )

        self.devices = devices
        self._render_scan_table(devices, services=services)
        return devices

    def _render_scan_table(self, devices: Dict[str, ScanResult], *, services: bool = True) -> None:
        """Render scan results, high-value targets first."""
        if not devices:
            self.log.warn(
                "no BLE advertisers seen - move closer, or the device may be Classic-only"
            )
            return

        ordered = sorted(
            devices.values(),
            key=lambda d: (
                (
                    0
                    if d.primary_tag == "AUDIO_TARGET"
                    else 1 if d.primary_tag == "PHONE_TARGET" else 2
                ),
                -(d.rssi or -999),
                d.name.lower(),
            ),
        )
        table = Table(
            title=f"Bluetooth reconnaissance - {len(ordered)} device(s)",
            title_style="bold green",
            header_style="bold green",
            border_style="green",
            show_lines=False,
        )
        table.add_column("#", justify="right", style="dim", no_wrap=True)
        table.add_column("Address", style="white", no_wrap=True)
        table.add_column("Name", style="bold")
        table.add_column("RSSI", justify="right", no_wrap=True)
        table.add_column("Tag", no_wrap=True)
        table.add_column("Profiles")
        if services:
            table.add_column("Service UUIDs", overflow="fold")

        for index, device in enumerate(ordered, start=1):  # noqa: B007 - index is displayed
            tag = device.primary_tag
            style = (
                "bold green"
                if tag == "AUDIO_TARGET"
                else "yellow" if tag == "PHONE_TARGET" else "dim"
            )
            rssi = f"{device.rssi} dBm" if device.rssi is not None else "-"
            service_cell = (
                Text(
                    "\n".join(
                        (short_uuid(u) if short_uuid(u) != normalise_uuid(u) else u)
                        for u in device.service_uuids[:6]
                    )
                    or "-",
                    style="dim",
                )
                if services
                else Text("-", style="dim")
            )
            row: List[Any] = [
                str(index),
                device.address,
                escape(device.name),
                rssi,
                Text(tag, style=style),
                ", ".join(device.profiles) or "-",
            ]
            if services:
                row.append(service_cell)
            table.add_row(*row)
        self.console.print(table)

        audio = [d for d in ordered if d.primary_tag == "AUDIO_TARGET"]
        if audio:
            self.log.info(
                f"{len(audio)} AUDIO_TARGET(s) found - next: "
                f"bluescan.py profile {audio[0].address}"
            )

    # -- 2. profile ---------------------------------------------------------

    async def profile(self, target: str) -> ProfileReport:
        """Connect and enumerate GATT services/characteristics."""
        address = normalise_mac(target)
        async with self.session(address, label="connecting for profile") as client:
            services = iter_services(client)
            if not services:
                raise BluescanError(
                    "device returned an empty GATT database (it may require pairing first)"
                )
            report = ProfileReport(
                address=address,
                name=str(
                    getattr(client, "name", None)
                    or (self.devices.get(address).name if address in self.devices else "-")
                ),
            )
            for service in services:
                service_uuid = str(getattr(service, "uuid", ""))
                service_name = str(getattr(service, "description", "") or "")
                service_entry = {
                    "uuid": service_uuid,
                    "handle": getattr(service, "handle", None),
                    "description": service_name,
                    "characteristics": len(iter_characteristics(service)),
                }
                report.services.append(service_entry)
                for char in iter_characteristics(service):
                    char_uuid = str(getattr(char, "uuid", ""))
                    props = _char_properties(char)
                    writable = "write" in props or "write-without-response" in props
                    notifiable = "notify" in props or "indicate" in props
                    media = short_uuid(char_uuid) in {
                        short_uuid(UUID_AVRCP_PASSTHROUGH),
                        short_uuid(UUID_MCP),
                        short_uuid(UUID_VCP),
                    }
                    info = CharacteristicInfo(
                        service_uuid=service_uuid,
                        service_name=service_name,
                        uuid=char_uuid,
                        handle=int(getattr(char, "handle", -1)),
                        description=str(getattr(char, "description", "") or ""),
                        properties=props,
                        writable=writable,
                        notifiable=notifiable,
                        media_control=media,
                    )
                    report.characteristics.append(info)
                    if media:
                        report.media_candidates.append(
                            {
                                "uuid": char_uuid,
                                "handle": info.handle,
                                "protocol": protocol_for_uuid(char_uuid),
                                "properties": props,
                            }
                        )
            self._render_profile(report)
            self._audit(command="profile", target=address, services=len(report.services))
            return report

    def _render_profile(self, report: ProfileReport) -> None:
        """Print services, characteristics and the highlighted attack surface."""
        table = Table(
            title=f"GATT profile - {escape(report.name)} ({report.address})",
            title_style="bold green",
            header_style="bold green",
            border_style="green",
        )
        table.add_column("Service", style="green", no_wrap=True)
        table.add_column("Handle", justify="right", style="dim", no_wrap=True)
        table.add_column("Characteristic UUID", no_wrap=True)
        table.add_column("Service name", style="dim", overflow="fold")
        table.add_column("Properties")
        table.add_column("Flags", no_wrap=True)

        for char in report.characteristics:
            flags: List[Text] = []
            for flag in char.flags:
                style = (
                    "bold red"
                    if flag in {"WRITE", "WRITE_NR"}
                    else "yellow" if flag == "NOTIFY" else "bold magenta"
                )
                flags.append(Text(flag, style=style))
            table.add_row(
                short_uuid(char.service_uuid),
                str(char.handle),
                char.uuid,
                escape(char.service_name) or "-",
                ", ".join(char.properties) or "-",
                Text(" ").join(flags) or Text("-", style="dim"),
            )
        self.console.print(table)

        summary = Table.grid(padding=(0, 2))
        summary.add_column(style="dim")
        summary.add_column(style="bold")
        summary.add_row("services", str(len(report.services)))
        summary.add_row("characteristics", str(len(report.characteristics)))
        summary.add_row("writable (injectable)", Text(str(len(report.writable)), style="bold red"))
        summary.add_row(
            "notify/indicate (observable)", Text(str(len(report.notifiable)), style="yellow")
        )
        media_points = [c for c in report.characteristics if c.media_control]
        summary.add_row("media control points", str(len(media_points)))
        self.console.print(Panel(summary, title="attack surface", border_style="green"))

        if media_points:
            for point in media_points:
                self.log.info(
                    f"media control point {point.uuid} (handle {point.handle}, "
                    f"protocol {protocol_for_uuid(point.uuid)}) - ready for 'media' / "
                    "'simulate-takeover'"
                )
        else:
            self.log.warn(
                "no AVRCP/MCS/VCS characteristic found: this firmware does not expose BLE "
                "media control. If it is a Classic audio device, test it with BlueZ "
                "(bluetoothctl) instead."
            )

        writable_without_response = [
            c for c in report.writable if "write-without-response" in c.properties
        ]
        if writable_without_response:
            self.log.warn(
                f"{len(writable_without_response)} characteristic(s) accept writes without a "
                "response - a classic fuzzing surface (use 'raw' carefully)"
            )

    # -- 3. media control ---------------------------------------------------

    async def send_avrcp(
        self,
        client: Any,
        action: str,
        *,
        characteristic: Optional[str] = None,
        frame: str = "avc",
        release: bool = True,
        response: Optional[bool] = None,
    ) -> MediaCommandResult:
        """Send one media action to ``client`` and report timing/result.

        Resolves the control point, builds protocol-correct payloads and writes
        them sequentially (press then release for AVRCP). Never raises for a
        failed write: the failure is captured in the returned result so a
        takeover sequence can continue.
        """
        protocol, char = resolve_media_characteristic(client, characteristic)
        char_uuid = str(getattr(char, "uuid", characteristic or ""))
        payloads = (
            build_media_payloads(protocol, action, release=release)
            if protocol in {"mcp", "vcs"}
            else _avrcp_payloads(action, frame=frame, release=release)
        )

        started = time.perf_counter()
        try:
            for payload in payloads:
                await self._write(client, char, payload, response=response)
            elapsed = (time.perf_counter() - started) * 1000.0
            result = MediaCommandResult(
                action=action,
                protocol=protocol,
                characteristic=char_uuid,
                payload=b"".join(payloads),
                ok=True,
                elapsed_ms=elapsed,
                frames=list(payloads),
            )
            self.log.audit(
                f"{action} -> {char_uuid} [{protocol}] "
                + " | ".join(p.hex(" ").upper() for p in payloads)
                + f"  ({elapsed:.1f} ms)"
            )
            self._audit(
                command="media",
                target=str(getattr(client, "address", "") or "unknown"),
                action=action,
                protocol=protocol,
                characteristic=char_uuid,
                payload=[p.hex(" ") for p in payloads],
                ok=True,
                elapsed_ms=round(elapsed, 2),
            )
            return result
        except Exception as exc:  # noqa: BLE001 - reported, not raised
            elapsed = (time.perf_counter() - started) * 1000.0
            level, message, hints = friendly_error(exc)
            getattr(self.log, level if level in {"warn", "error"} else "error")(
                f"{action} failed: {message}"
            )
            self.log.hints(hints)
            self._audit(
                command="media",
                target=str(getattr(client, "address", "") or "unknown"),
                action=action,
                protocol=protocol,
                characteristic=char_uuid,
                ok=False,
                error=message,
            )
            return MediaCommandResult(
                action=action,
                protocol=protocol,
                characteristic=char_uuid,
                payload=b"".join(payloads),
                ok=False,
                elapsed_ms=elapsed,
                error=message,
                frames=list(payloads),
            )

    async def _write(
        self,
        client: Any,
        char: Any,
        payload: bytes,
        *,
        response: Optional[bool] = None,
    ) -> None:
        """Write one payload with the correct response mode and a hard timeout."""
        props = _char_properties(char)
        if "write" not in props and "write-without-response" not in props:
            raise UnsupportedAction(
                f"characteristic {getattr(char, 'uuid', '?')} is not writable "
                f"(properties: {', '.join(props) or 'none'})"
            )
        use_response = response if response is not None else ("write" in props)
        if use_response and "write" not in props:
            use_response = False
        if self.dry_run:
            self.log.debug(f"[dry-run] write {payload.hex(' ')} to {getattr(char, 'uuid', '?')}")
            return
        await asyncio.wait_for(
            client.write_gatt_char(char, payload, response=use_response),
            timeout=self.write_timeout,
        )

    async def media(
        self,
        target: str,
        action: str,
        *,
        characteristic: Optional[str] = None,
        frame: str = "avc",
        release: bool = True,
        repeat: int = 1,
        delay: float = 0.25,
    ) -> List[MediaCommandResult]:
        """Send ``action`` ``repeat`` times over a connection to ``target``."""
        address = normalise_mac(target)
        action = str(action).strip().lower()
        if action not in AVRCP_OPERATION_IDS:
            raise UnsupportedAction(f"unknown action '{action}'")
        self.require_authorization(address)

        results: List[MediaCommandResult] = []
        async with self.session(address, label="connecting for media control") as client:
            for index in range(max(1, int(repeat))):
                if index:
                    await asyncio.sleep(max(0.0, float(delay)))
                results.append(
                    await self.send_avrcp(
                        client,
                        action,
                        characteristic=characteristic,
                        frame=frame,
                        release=release,
                    )
                )
        return results

    # -- 4. takeover simulation --------------------------------------------

    async def simulate_takeover(
        self,
        target: str,
        *,
        hold: float = 30.0,
        characteristic: Optional[str] = None,
        frame: str = "avc",
    ) -> List[MediaCommandResult]:
        """Run the scripted state-machine stress test.

        Sequence: connect -> subscribe to every notify characteristic -> ``stop``
        -> ``prev`` x5 -> ``play`` -> hold the link open for ``hold`` seconds so
        the operator can watch the firmware/speaker state. Ctrl+C ends the hold
        early without leaving the device in a broken state.
        """
        address = normalise_mac(target)
        self.require_authorization(address)
        self.log.info(f"takeover sequence against {address} (you confirmed ownership)")
        self._audit(command="simulate-takeover", target=address, phase="start", hold=hold)

        results: List[MediaCommandResult] = []
        notifications: List[Tuple[str, int]] = []
        stop_event = asyncio.Event()

        def on_notify(char: Any, data: bytearray) -> None:
            char_uuid = str(getattr(char, "uuid", "?"))
            self.log.info(f"notify {char_uuid} <- {bytes(data).hex(' ').upper()}")
            for index, (uuid_value, count) in enumerate(notifications):
                if uuid_value == char_uuid:
                    notifications[index] = (uuid_value, count + 1)
                    break

        async with self.session(address, label="connecting for takeover test") as client:
            for service in iter_services(client):
                for char in iter_characteristics(service):
                    if "notify" not in _char_properties(
                        char
                    ) and "indicate" not in _char_properties(char):
                        continue
                    char_uuid = str(getattr(char, "uuid", "?"))
                    if self.dry_run:
                        notifications.append((char_uuid, 0))
                        continue
                    try:
                        await asyncio.wait_for(
                            client.start_notify(char, on_notify), timeout=self.write_timeout
                        )
                        notifications.append((char_uuid, 0))
                        self.log.debug(f"subscribed to {char_uuid}")
                    except Exception as exc:  # noqa: BLE001 - subscription is optional
                        self.log.warn(
                            f"could not subscribe to {char_uuid}: {friendly_error(exc)[1]}"
                        )

            sequence: List[Tuple[str, float]] = [
                ("stop", 1.0),
                ("prev", 0.3),
                ("prev", 0.3),
                ("prev", 0.3),
                ("prev", 0.3),
                ("prev", 1.0),
                ("play", 1.0),
            ]
            for action, pause in sequence:
                result = await self.send_avrcp(
                    client, action, characteristic=characteristic, frame=frame
                )
                results.append(result)
                if result.ok:
                    self.log.info(f"sent {action} in {result.elapsed_ms:.1f} ms")
                await asyncio.sleep(pause)

            self.console.print()
            self.log.info(
                f"holding the connection for {hold:.0f}s - watch the device: does it recover, "
                "stutter, drop, or accumulate state?  (Ctrl+C to end early)"
            )
            try:
                await self._hold(hold, stop_event)
            except (KeyboardInterrupt, asyncio.CancelledError):
                self.log.warn("hold interrupted by operator")
                raise

            for uuid_value, count in notifications:
                self.log.debug(f"{uuid_value}: {count} notification(s)")
            self._render_takeover_summary(results, notifications)

        self._audit(
            command="simulate-takeover",
            target=address,
            phase="complete",
            sent=[r.action for r in results],
            failures=sum(0 if r.ok else 1 for r in results),
        )
        return results

    async def _hold(self, seconds: float, stop_event: asyncio.Event) -> None:
        """Wait ``seconds`` while remaining responsive to cancellation."""
        deadline = time.monotonic() + max(0.0, seconds)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or stop_event.is_set():
                break
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(stop_event.wait(), timeout=min(1.0, remaining))
        self.console.print()

    def _render_takeover_summary(
        self, results: Sequence[MediaCommandResult], notifications: Sequence[Tuple[str, int]]
    ) -> None:
        """Table of every command sent plus notification counters."""
        table = Table(
            title="takeover sequence results",
            title_style="bold green",
            header_style="bold green",
            border_style="green",
        )
        table.add_column("#", justify="right", style="dim")
        table.add_column("Action", style="bold")
        table.add_column("Payload(s)")
        table.add_column("Latency", justify="right")
        table.add_column("Result")
        for index, result in enumerate(results, start=1):
            table.add_row(
                str(index),
                result.action,
                " | ".join(f.hex(" ").upper() for f in (result.frames or [result.payload])),
                f"{result.elapsed_ms:.1f} ms",
                (
                    Text("OK", style="green")
                    if result.ok
                    else Text(result.error or "FAILED", style="red")
                ),
            )
        self.console.print(table)
        if notifications:
            summary = ", ".join(f"{short_uuid(u)}={c}" for u, c in notifications)
            self.log.info(f"notifications observed: {summary}")
        else:
            self.log.warn("no notifications subscribed - state changes were not observable")

    # -- 5. raw injection ---------------------------------------------------

    async def raw_inject(
        self,
        target: str,
        char_uuid: str,
        hex_data: str,
        *,
        repeat: int = 1,
        delay: float = 0.2,
        chunk: int = 0,
        response: Optional[bool] = None,
    ) -> List[Dict[str, Any]]:
        """Write arbitrary bytes to ``char_uuid`` for fuzzing.

        ``chunk`` splits the payload into ATT-sized writes (``0`` = single
        write). Each repetition is logged; failures are reported per attempt and
        do not abort the run, so a crash in the target is immediately visible as
        a disconnect.
        """
        address = normalise_mac(target)
        payload = parse_hex(hex_data)
        self.require_authorization(address)

        chunks = chunk_bytes(payload, int(chunk))
        self.log.info(
            f"raw injection: {len(payload)} byte(s) -> {char_uuid} "
            f"({len(chunks)} write(s) x {max(1, int(repeat))} repetition(s))"
        )
        self._audit(
            command="raw",
            target=address,
            characteristic=char_uuid,
            payload=payload.hex(" "),
            repeat=repeat,
        )

        results: List[Dict[str, Any]] = []
        async with self.session(address, label="connecting for raw injection") as client:
            char = find_characteristic(client, char_uuid)
            if char is None:
                raise CharacteristicMismatch(
                    f"no characteristic {char_uuid} on {address} "
                    "(run 'profile <MAC>' to see valid UUIDs)"
                )
            for attempt in range(max(1, int(repeat))):
                for part in chunks:
                    started = time.perf_counter()
                    try:
                        await self._write(client, char, part, response=response)
                        elapsed = (time.perf_counter() - started) * 1000.0
                        self.log.audit(
                            f"raw {part.hex(' ').upper()} -> {char_uuid} ({elapsed:.1f} ms)"
                        )
                        results.append(
                            {
                                "attempt": attempt + 1,
                                "payload": part.hex(" "),
                                "ok": True,
                                "elapsed_ms": round(elapsed, 2),
                            }
                        )
                    except Exception as exc:  # noqa: BLE001 - continue fuzzing
                        level, message, hints = friendly_error(exc)
                        self.log.error(f"raw write failed: {message}")
                        self.log.hints(hints)
                        results.append(
                            {
                                "attempt": attempt + 1,
                                "payload": part.hex(" "),
                                "ok": False,
                                "error": message,
                            }
                        )
                        if not getattr(client, "is_connected", True):
                            self.log.error(
                                "target dropped the connection - stop and re-check the device"
                            )
                            return results
                    await asyncio.sleep(max(0.0, float(delay)) if delay else 0.0)
        return results


def _avrcp_payloads(action: str, *, frame: str = "avc", release: bool = True) -> List[bytes]:
    """AVRCP press/release payload list (thin wrapper over the pure builder)."""
    payloads = [build_avrcp_passthrough(action, pressed=True, frame=frame)]
    if release:
        payloads.append(build_avrcp_passthrough(action, pressed=False, frame=frame))
    return payloads


class _DryRunClient:
    """Stand-in client used by ``--dry-run`` (fabricated GATT database)."""

    address = "DRY-RUN"
    name = "DryRunDevice"
    is_connected = True

    def __init__(self) -> None:
        media = _FakeCh({"write", "read"}, UUID_AVRCP_PASSTHROUGH, handle=42)
        notify = _FakeCh({"notify"}, "00002b93-0000-1000-8000-00805f9b34fb", handle=43)
        self.services = [
            _FakeSvc(
                UUID_MCS,
                "Media Control Service",
                [media, notify],
                handle=40,
            )
        ]

    async def disconnect(self) -> None:
        """No-op disconnect."""
        self.is_connected = False

    async def write_gatt_char(self, char: Any, data: bytes, response: bool = True) -> None:
        """Pretend the write succeeded."""
        return None

    async def start_notify(self, char: Any, callback: Any) -> None:
        """Pretend the subscription succeeded."""
        return None


class _FakeCh:
    """Minimal characteristic used by the dry-run client and tests."""

    def __init__(self, props: Iterable[str], uuid_value: str, *, handle: int = 1) -> None:
        self.properties = list(props)
        self.uuid = uuid_value
        self.handle = handle
        self.description = "fake"

    @property
    def max_write_without_response_size(self) -> int:
        """ATT payload hint."""
        return DEFAULT_ATT_PAYLOAD


class _FakeSvc:
    """Minimal service used by the dry-run client and tests."""

    def __init__(self, uuid_value: str, name: str, chars: List[Any], *, handle: int = 1) -> None:
        self.uuid = uuid_value
        self.description = name
        self.characteristics = chars
        self.handle = handle


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


#: Defaults for global options. Applied after parsing because the options are
#: shared (via a parent parser) between the main parser and every subparser, and
#: are declared with ``default=SUPPRESS`` so a flag placed before the subcommand
#: is not reset by a subparser that never saw it.
GLOBAL_DEFAULTS: Dict[str, Any] = {
    "verbose": False,
    "json": False,
    "no_color": False,
    "dry_run": False,
    "yes": False,
    "audit_log": Path("bluescan-audit.log"),
    "connect_timeout": 20.0,
    "write_timeout": 5.0,
}


def _add_global_options(target: argparse.ArgumentParser) -> None:
    """Add the global flags to a parser (main or sub), without clobbering defaults."""
    target.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        default=argparse.SUPPRESS,
        help="debug-level logging",
    )
    target.add_argument(
        "--json",
        action="store_true",
        default=argparse.SUPPRESS,
        help="machine-readable output",
    )
    target.add_argument(
        "--no-color", action="store_true", default=argparse.SUPPRESS, help="disable colours"
    )
    target.add_argument(
        "--dry-run",
        action="store_true",
        default=argparse.SUPPRESS,
        help="build and print payloads without touching hardware",
    )
    target.add_argument(
        "--yes",
        action="store_true",
        default=argparse.SUPPRESS,
        help="confirm you own the target (skips the interactive prompt)",
    )
    target.add_argument(
        "--audit-log",
        type=Path,
        default=argparse.SUPPRESS,
        help="JSONL audit log path (default: bluescan-audit.log)",
    )
    target.add_argument(
        "--connect-timeout",
        type=float,
        default=argparse.SUPPRESS,
        metavar="SECONDS",
        help="connection timeout (default: 20)",
    )
    target.add_argument(
        "--write-timeout",
        type=float,
        default=argparse.SUPPRESS,
        metavar="SECONDS",
        help="per-write timeout (default: 5)",
    )


def build_parser() -> argparse.ArgumentParser:
    """Create the argparse CLI (kept separate so tests can parse safely).

    Global flags are accepted both before and after the subcommand, e.g.
    ``bluescan.py media --mac X --action play --dry-run``.
    """
    common = argparse.ArgumentParser(add_help=False)
    _add_global_options(common)

    parser = argparse.ArgumentParser(
        prog="bluescan.py",
        description=(
            "Bluescan: Advanced Bluetooth Reconnaissance & Protocol Auditor. "
            "Test only devices you own or have written permission to test."
        ),
        epilog=(
            "examples:\n"
            "  python bluescan.py scan --duration 10\n"
            "  python bluescan.py profile 00:1A:7D:DA:71:13\n"
            "  python bluescan.py media --mac 00:1A:7D:DA:71:13 --action pause --yes\n"
            "  python bluescan.py simulate-takeover --mac 00:1A:7D:DA:71:13 --yes\n"
            "  python bluescan.py raw --mac 00:1A:7D:DA:71:13 "
            '--char 0000ae02-0000-1000-8000-00805f9b34fb --hex "00 48 7C 44 00" --yes\n'
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        parents=[common],
    )
    parser.add_argument("--version", action="version", version=f"bluescan {__version__}")

    subparsers = parser.add_subparsers(dest="command", required=True, metavar="COMMAND")

    scan_parser = subparsers.add_parser(
        "scan", parents=[common], help="discover BLE devices and fingerprint them"
    )
    scan_parser.add_argument(
        "-d",
        "--duration",
        type=int,
        default=10,
        metavar="SECONDS",
        help="scan window (default: 10)",
    )
    scan_parser.add_argument("--name-filter", help="only show names containing this text")
    scan_parser.add_argument(
        "--no-services", action="store_true", help="hide the service UUID column"
    )

    profile_parser = subparsers.add_parser(
        "profile", parents=[common], help="enumerate GATT services/characteristics for a device"
    )
    profile_parser.add_argument(
        "mac", metavar="MAC", nargs="?", help="target address (AA:BB:CC:DD:EE:FF)"
    )
    profile_parser.add_argument(
        "--mac", dest="mac_flag", metavar="MAC", help="target address (alternative to positional)"
    )

    media_parser = subparsers.add_parser(
        "media", parents=[common], help="send an AVRCP/MCS/VCS media command"
    )
    media_parser.add_argument("--mac", required=True, metavar="MAC", help="target address")
    media_parser.add_argument(
        "--action",
        required=True,
        choices=list(MEDIA_ACTIONS),
        metavar="ACTION",
        help=f"one of: {', '.join(MEDIA_ACTIONS)}",
    )
    media_parser.add_argument(
        "--char", metavar="UUID", help="override the media control characteristic UUID"
    )
    media_parser.add_argument(
        "--frame",
        choices=["avc", "avc4", "avctp"],
        default="avc",
        help="AVRCP frame shape: spec AV/C (default), legacy 4-byte, or AVCTP-wrapped",
    )
    media_parser.add_argument(
        "--no-release", action="store_true", help="send only the press frame (long-press tests)"
    )
    media_parser.add_argument("--repeat", type=int, default=1, metavar="N", help="repeat count")
    media_parser.add_argument(
        "--delay", type=float, default=0.25, metavar="SECONDS", help="delay between repeats"
    )

    takeover_parser = subparsers.add_parser(
        "simulate-takeover",
        parents=[common],
        aliases=["takeover"],
        help="scripted stop -> prev x5 -> play sequence with notification monitoring",
    )
    takeover_parser.add_argument("--mac", required=True, metavar="MAC", help="target address")
    takeover_parser.add_argument(
        "--hold",
        type=float,
        default=30.0,
        metavar="SECONDS",
        help="keep the connection open for observation (default: 30)",
    )
    takeover_parser.add_argument("--char", metavar="UUID", help="override the media control UUID")
    takeover_parser.add_argument(
        "--frame", choices=["avc", "avc4", "avctp"], default="avc", help="AVRCP frame shape"
    )

    raw_parser = subparsers.add_parser(
        "raw", parents=[common], help="inject arbitrary hex bytes into a characteristic"
    )
    raw_parser.add_argument("--mac", required=True, metavar="MAC", help="target address")
    raw_parser.add_argument(
        "--char", required=True, metavar="UUID", help="target characteristic UUID"
    )
    raw_parser.add_argument(
        "--hex", required=True, metavar="HEX", help='payload, e.g. "AA BB CC" or "0xAA,0xBB"'
    )
    raw_parser.add_argument("--repeat", type=int, default=1, metavar="N", help="repeat count")
    raw_parser.add_argument(
        "--delay", type=float, default=0.2, metavar="SECONDS", help="delay between writes"
    )
    raw_parser.add_argument(
        "--chunk",
        type=int,
        default=0,
        metavar="BYTES",
        help="split into ATT-sized writes (0 = single write; 20 is MTU-safe)",
    )
    raw_parser.add_argument(
        "--no-response",
        action="store_true",
        help="force write-without-response (faster, less reliable)",
    )

    return parser


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    """Parse CLI arguments (indirection keeps tests fast and side-effect free)."""
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "profile":
        args.mac = args.mac or args.mac_flag
        if not args.mac:
            parser.error("profile needs a MAC address (positional or --mac)")
    if args.command in {"media", "simulate-takeover", "takeover", "raw"} and not args.mac:
        parser.error(f"{args.command} requires --mac")

    for key, value in GLOBAL_DEFAULTS.items():
        if not hasattr(args, key):
            setattr(args, key, value)
    return args


def _stack_hints() -> List[str]:
    """Remediation hints for 'no Bluetooth stack / adapter' failures."""
    system = platform.system()
    if system == "Linux":
        return [
            "Linux: install and start BlueZ, then confirm the adapter:",
            "  sudo apt install bluez  &&  sudo systemctl start bluetooth",
            "  ls /sys/class/bluetooth   (empty = no adapter)",
        ]
    if system == "Darwin":
        return [
            "macOS: enable Bluetooth in Control Centre and allow your terminal in Privacy settings"
        ]
    return ["Windows: turn Bluetooth on in Settings and allow desktop apps to use it"]


def _command_budget(args: argparse.Namespace) -> float:
    """Hard wall-clock budget per command so the event loop can never hang."""
    if args.command == "scan":
        return float(args.duration) + 60.0
    if args.command in {"simulate-takeover", "takeover"}:
        return float(args.hold) + 180.0
    return 180.0


def _configure_logging(verbose: bool) -> None:
    """Route bleak's own logs through rich (only shown with --verbose)."""
    handler = RichHandler(show_path=False, omit_repeated_times=False)
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.WARNING,
        format="%(message)s",
        datefmt="%H:%M:%S",
        handlers=[handler],
    )
    for noisy in ("bleak", "bleak.backends"):
        logging.getLogger(noisy).setLevel(logging.DEBUG if verbose else logging.ERROR)


async def _run_command(master: BluetoothMaster, args: argparse.Namespace, console: Console) -> int:
    """Dispatch one parsed command and translate results into an exit code."""
    command = args.command

    if command == "scan":
        devices = await master.scan(
            duration=args.duration,
            name_filter=args.name_filter,
            services=not args.no_services,
        )
        if args.json:
            console.print_json(json.dumps([d.to_dict() for d in devices.values()]))
        return 0 if (devices or args.dry_run) else 1

    if command == "profile":
        report = await master.profile(args.mac)
        if args.json:
            console.print_json(json.dumps(report.to_dict()))
        return 0

    if command == "media":
        results = await master.media(
            args.mac,
            args.action,
            characteristic=args.char,
            frame=args.frame,
            release=not args.no_release,
            repeat=args.repeat,
            delay=args.delay,
        )
        if args.json:
            console.print_json(json.dumps([r.to_dict() for r in results]))
        return 0 if all(r.ok for r in results) else 1

    if command in {"simulate-takeover", "takeover"}:
        results = await master.simulate_takeover(
            args.mac, hold=args.hold, characteristic=args.char, frame=args.frame
        )
        if args.json:
            console.print_json(json.dumps([r.to_dict() for r in results]))
        return 0 if all(r.ok for r in results) else 1

    if command == "raw":
        results = await master.raw_inject(
            args.mac,
            args.char,
            args.hex,
            repeat=args.repeat,
            delay=args.delay,
            chunk=args.chunk,
            response=False if args.no_response else None,
        )
        if args.json:
            console.print_json(json.dumps(results))
        return 0 if results and all(r["ok"] for r in results) else 1

    raise BluescanError(f"unknown command {command}")


async def _amain(args: argparse.Namespace, console: Console) -> int:
    """Build the controller, run the command under a global timeout."""
    master = BluetoothMaster(
        console=console,
        verbose=args.verbose,
        dry_run=args.dry_run,
        authorized=args.yes,
        audit_log=args.audit_log,
        connect_timeout=args.connect_timeout,
        write_timeout=args.write_timeout,
    )

    banner = Text()
    banner.append("BLUESCAN", style="bold green")
    banner.append(f" v{__version__}", style="dim")
    banner.append("  Bluetooth recon & protocol auditor", style="green")
    if args.dry_run:
        banner.append("   [DRY RUN]", style="bold yellow")
    console.print(Panel(banner, border_style="green"))

    try:
        return await asyncio.wait_for(
            _run_command(master, args, console), timeout=_command_budget(args)
        )
    except asyncio.TimeoutError:
        master.log.error(
            "command exceeded its time budget and was cancelled (no hanging threads left behind)"
        )
        return 1
    except NotAuthorized as exc:
        master.log.error(str(exc))
        return 3
    except (CharacteristicMismatch, DeviceNotFound, UnsupportedAction) as exc:
        level, message, hints = friendly_error(exc)
        getattr(master.log, "warn" if level == "warn" else "error")(message)
        master.log.hints(hints)
        return 1
    except BluescanError as exc:
        master.log.error(str(exc))
        master.log.hints(_stack_hints())
        return 1
    except KeyboardInterrupt:
        master.log.warn("interrupted - shutting down cleanly")
        return 130
    except Exception as exc:  # noqa: BLE001 - last-resort mapping
        level, message, hints = friendly_error(exc)
        master.log.error(message)
        master.log.hints(hints)
        if args.verbose:
            console.print_exception()
        return 1


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Entry point: parse arguments and run the asyncio event loop once."""
    args = parse_args(argv)
    _configure_logging(args.verbose)
    console = Console(highlight=False, no_color=args.no_color, soft_wrap=False)

    # Windows: the default Proactor loop is what WinRT/bleak wants, so we keep it.
    # Never leave a half-open loop behind: asyncio.run() closes it for us.
    try:
        return asyncio.run(_amain(args, console))
    except KeyboardInterrupt:
        console.print(Text("\ninterrupted", style="yellow"))
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
