"""Unit tests for bluescan.

Run with:  python -m pytest -q

No Bluetooth hardware is required: protocol builders are pure functions and the
controller is exercised against an in-memory fake BleakClient plus ``--dry-run``.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bluescan as bs  # noqa: E402

# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class FakeCharacteristic:
    """Mimics ``BleakGATTCharacteristic`` for the controller."""

    def __init__(self, uuid_value: str, properties: List[str], handle: int = 1) -> None:
        self.uuid = uuid_value
        self.properties = properties
        self.handle = handle
        self.description = "fake characteristic"

    @property
    def max_write_without_response_size(self) -> int:
        """ATT payload hint."""
        return 20


class FakeService:
    """Mimics ``BleakGATTService``."""

    def __init__(
        self, uuid_value: str, characteristics: List[FakeCharacteristic], name: str = ""
    ) -> None:
        self.uuid = uuid_value
        self.characteristics = characteristics
        self.description = name
        self.handle = 1


class FakeServices:
    """Mimics ``BleakGATTServiceCollection`` (dict of handle -> service)."""

    def __init__(self, services: List[FakeService]) -> None:
        self.services = {index: service for index, service in enumerate(services)}


class FakeClient:
    """In-memory stand-in for ``BleakClient`` that records every write."""

    def __init__(self, services: List[FakeService], *, address: str = "00:1A:7D:DA:71:13") -> None:
        self.services = FakeServices(services)
        self.address = address
        self.name = "FakeSpeaker"
        self.is_connected = True
        self.writes: List[Dict[str, Any]] = []
        self.notifications: List[str] = []
        self.disconnected = False
        self.fail_writes = False

    async def write_gatt_char(
        self, char: Any, data: bytes, response: Optional[bool] = None
    ) -> None:
        """Record a write (or raise when ``fail_writes`` is set)."""
        if self.fail_writes:
            raise bs.BleakError("write failed: connection refused")
        self.writes.append(
            {"uuid": str(getattr(char, "uuid", char)), "data": bytes(data), "response": response}
        )

    async def start_notify(self, char: Any, callback: Any) -> None:
        """Record a subscription."""
        self.notifications.append(str(getattr(char, "uuid", char)))

    async def disconnect(self) -> None:
        """Mark the fake link closed."""
        self.disconnected = True
        self.is_connected = False


def avrcp_client() -> FakeClient:
    """Client exposing the AVRCP pass-through point plus a notify characteristic."""
    media = FakeCharacteristic(bs.UUID_AVRCP_PASSTHROUGH, ["write", "read"], handle=42)
    notify = FakeCharacteristic(bs.UUID_VCS, ["notify"], handle=43)
    return FakeClient([FakeService(bs.UUID_MCS, [media, notify], "Media Control Service")])


# ---------------------------------------------------------------------------
# Protocol constants and payloads
# ---------------------------------------------------------------------------


def test_operation_ids_match_the_spec() -> None:
    """Operation ids must match AVRCP 1.3+/AV/C (verified against BlueZ & Android)."""
    assert bs.AVRCP_OPERATION_IDS["play"] == 0x44
    assert bs.AVRCP_OPERATION_IDS["stop"] == 0x45
    assert bs.AVRCP_OPERATION_IDS["pause"] == 0x46  # NOT 0x43 (that is mute)
    assert bs.AVRCP_OPERATION_IDS["mute"] == 0x43
    assert bs.AVRCP_OPERATION_IDS["volume_up"] == 0x41
    assert bs.AVRCP_OPERATION_IDS["volume_down"] == 0x42
    assert bs.AVRCP_OPERATION_IDS["next"] == 0x4B  # FORWARD
    assert bs.AVRCP_OPERATION_IDS["prev"] == 0x4C  # BACKWARD
    assert bs.AVC_OPCODE_PASSTHROUGH == 0x7C
    assert bs.AVC_SUBUNIT_PANEL << bs.AVC_SUBTYPE_SHIFT == 0x48


@pytest.mark.parametrize(
    ("action", "expected"),
    [
        ("play", "00 48 7C 44 00"),
        ("stop", "00 48 7C 45 00"),
        ("pause", "00 48 7C 46 00"),
        ("next", "00 48 7C 4B 00"),
        ("prev", "00 48 7C 4C 00"),
        ("volume_up", "00 48 7C 41 00"),
        ("volume_down", "00 48 7C 42 00"),
        ("mute", "00 48 7C 43 00"),
    ],
)
def test_passthrough_press_frames(action: str, expected: str) -> None:
    """Spec AV/C frame: ctype, panel subunit 0x48, opcode 0x7C, opid, data length."""
    assert bs.build_avrcp_passthrough(action) == bytes.fromhex(expected.replace(" ", ""))


def test_passthrough_release_sets_state_bit() -> None:
    """Releasing sets bit 7 of the operation-id octet (0x44 -> 0xC4)."""
    assert bs.build_avrcp_passthrough("play", pressed=False) == bytes.fromhex("00487CC400")


def test_avctp_frame_matches_captured_packet() -> None:
    """AVCTP header = <label><0x11><0x0E>; label 2 reproduces a real capture."""
    assert bs.build_avrcp_passthrough("play", frame="avctp", transaction_label=2) == bytes.fromhex(
        "20110E00487C4400"
    )
    assert bs.build_avrcp_passthrough("pause", frame="avctp", transaction_label=3) == bytes.fromhex(
        "30110E00487C4600"
    )


def test_legacy_four_byte_frame() -> None:
    """The vendor 4-byte variant omits the subunit octet."""
    assert bs.build_avrcp_passthrough("play", frame="avc4") == bytes.fromhex("007C4400")


def test_unknown_action_and_frame_are_rejected() -> None:
    """Typos never produce silent garbage on the wire."""
    with pytest.raises(bs.UnsupportedAction):
        bs.build_avrcp_passthrough("dance")
    with pytest.raises(bs.UnsupportedAction):
        bs.build_avrcp_passthrough("play", frame="carrier-pigeon")


def test_avrcp_payload_pairs() -> None:
    """A default AVRCP action is a press followed by a release."""
    payloads = bs.build_media_payloads("avrcp", "play")
    assert len(payloads) == 2
    assert payloads[0] == bytes.fromhex("00487C4400")
    assert payloads[1] == bytes.fromhex("00487CC400")
    assert bs.build_media_payloads("avrcp", "play", release=False) == [bytes.fromhex("00487C4400")]


def test_le_audio_mcp_and_vcs_encodings() -> None:
    """MCS/VCS use their own one-byte opcodes instead of AV/C frames."""
    assert bs.build_media_payloads("mcp", "play") == [b"\x01"]
    assert bs.build_media_payloads("mcp", "next") == [b"\x05"]
    assert bs.build_media_payloads("vcs", "volume_up") == [b"\x00"]
    assert bs.build_media_payloads("vcs", "volume_down") == [b"\x01"]
    with pytest.raises(bs.UnsupportedAction):
        bs.build_media_payloads("mcp", "volume_up")  # volume lives in VCS
    with pytest.raises(bs.UnsupportedAction):
        bs.build_media_payloads("vcs", "play")
    with pytest.raises(bs.UnsupportedAction):
        bs.build_media_payloads("nope", "play")


def test_protocol_for_uuid() -> None:
    """Media Control Point maps to mcp, Volume Control Point to vcs, else avrcp."""
    assert bs.protocol_for_uuid(bs.UUID_MCP) == "mcp"
    assert bs.protocol_for_uuid(bs.UUID_VCP) == "vcs"
    assert bs.protocol_for_uuid(bs.UUID_AVRCP_PASSTHROUGH) == "avrcp"
    assert bs.protocol_for_uuid("2ba4") == "mcp"


# ---------------------------------------------------------------------------
# Fingerprinting / parsing helpers
# ---------------------------------------------------------------------------


def test_fingerprint_audio_targets() -> None:
    """AVRCP and A2DP UUIDs tag a device as AUDIO_TARGET."""
    for uuid_value in (
        "0000110e-0000-1000-8000-00805f9b34fb",
        "110F",
        "0000110a-0000-1000-8000-00805f9b34fb",
    ):
        labels, tags = bs.profile_labels([uuid_value])
        assert "AUDIO_TARGET" in tags, uuid_value
        assert labels


def test_fingerprint_phone_targets() -> None:
    """HFP/HSP UUIDs tag a device as PHONE_TARGET."""
    for uuid_value in (
        "0000111e-0000-1000-8000-00805f9b34fb",
        "00001108-0000-1000-8000-00805f9b34fb",
        "1203",
    ):
        labels, tags = bs.profile_labels([uuid_value])
        assert "PHONE_TARGET" in tags, uuid_value


def test_fingerprint_unknown_uuid_is_not_tagged() -> None:
    """Unknown services fall back to a generic BLE device."""
    labels, tags = bs.profile_labels(["0000fff0-0000-1000-8000-00805f9b34fb"])
    assert labels == [] and tags == []
    result = bs.ScanResult(address="AA:BB:CC:DD:EE:FF", name="x", rssi=-70, tags=tags)
    assert result.primary_tag == "BLE_DEVICE"


def test_primary_tag_priority_prefers_audio() -> None:
    """AUDIO_TARGET outranks PHONE_TARGET when both are present."""
    result = bs.ScanResult(
        address="AA:BB:CC:DD:EE:FF",
        name="buds",
        rssi=-50,
        tags=["PHONE_TARGET", "AUDIO_TARGET"],
    )
    assert result.primary_tag == "AUDIO_TARGET"


def test_short_and_normalised_uuid() -> None:
    """16-bit UUIDs expand to the Bluetooth base UUID and back."""
    assert bs.normalise_uuid("110E") == "0000110e-0000-1000-8000-00805f9b34fb"
    assert bs.short_uuid("0000110e-0000-1000-8000-00805f9b34fb") == "110e"
    assert bs.short_uuid("12345678-1234-1234-1234-123456789abc") == (
        "12345678-1234-1234-1234-123456789abc"
    )


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("AA BB CC", b"\xaa\xbb\xcc"),
        ("aabbcc", b"\xaa\xbb\xcc"),
        ("0xAA,0xBB", b"\xaa\xbb"),
        ("AA:BB:CC", b"\xaa\xbb\xcc"),
        ("00 48 7C 44 00", bytes.fromhex("00487C4400")),
    ],
)
def test_parse_hex_accepts_common_formats(text: str, expected: bytes) -> None:
    """Operators paste hex in several styles; all should work."""
    assert bs.parse_hex(text) == expected


@pytest.mark.parametrize("bad", ["", "ABC", "ZZ", "AA BB CC DD " + "11 " * 600])
def test_parse_hex_rejects_bad_input(bad: str) -> None:
    """Odd length, non-hex and oversized payloads are refused."""
    with pytest.raises(bs.BluescanError):
        bs.parse_hex(bad)


def test_chunk_bytes() -> None:
    """Chunking is ATT-safe and preserves order."""
    assert bs.chunk_bytes(b"", 20) == []
    assert bs.chunk_bytes(b"abc", 20) == [b"abc"]
    assert bs.chunk_bytes(b"abc", 0) == [b"abc"]
    assert bs.chunk_bytes(b"abcdef", 2) == [b"ab", b"cd", b"ef"]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("00:1a:7d:da:71:13", "00:1A:7D:DA:71:13"),
        ("AA:BB:CC:DD:EE:FF", "AA:BB:CC:DD:EE:FF"),
        ("aabbccddeeff", "AA:BB:CC:DD:EE:FF"),  # bare hex is expanded
    ],
)
def test_normalise_mac(raw: str, expected: str) -> None:
    """MAC addresses are upper-cased; opaque macOS UUIDs pass through."""
    assert bs.normalise_mac(raw) == expected


@pytest.mark.parametrize("bad", ["", "not-a-mac", "00:11:22"])
def test_normalise_mac_rejects_junk(bad: str) -> None:
    """Nonsense addresses fail before any radio traffic."""
    with pytest.raises(bs.BluescanError):
        bs.normalise_mac(bad)


# ---------------------------------------------------------------------------
# Error mapping
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("exc", "needle"),
    [
        (bs.DeviceNotFound("nope"), "device not found"),
        (bs.CharacteristicMismatch("nope"), "uuid mismatch"),
        (PermissionError("denied"), "permission denied"),
        (ConnectionError("Connection refused (111)"), "connection refused"),
        (FileNotFoundError("[Errno 2] No such file or directory"), "bluetooth stack"),
    ],
)
def test_friendly_error_messages(exc: BaseException, needle: str) -> None:
    """Each documented failure mode gets a clear, actionable message."""
    level, message, hints = bs.friendly_error(exc)
    assert level in {"warn", "error"}
    assert needle in message.lower()
    assert isinstance(hints, list)


def test_friendly_error_timeout_is_a_warning() -> None:
    """Timeouts are recoverable, so they are warnings with a retry hint."""
    level, message, hints = bs.friendly_error(asyncio.TimeoutError())
    assert level == "warn"
    assert "timed out" in message
    assert hints


# ---------------------------------------------------------------------------
# CLI parsing
# ---------------------------------------------------------------------------


def test_parser_scan_defaults_and_duration() -> None:
    """scan --duration is a validated integer."""
    args = bs.parse_args(["scan", "--duration", "10"])
    assert args.command == "scan" and args.duration == 10
    assert bs.parse_args(["scan", "-d", "3"]).duration == 3


def test_parser_profile_positional_and_flag() -> None:
    """profile accepts both 'profile MAC' and 'profile --mac MAC'."""
    assert bs.parse_args(["profile", "00:1A:7D:DA:71:13"]).mac == "00:1A:7D:DA:71:13"
    assert bs.parse_args(["profile", "--mac", "AA:BB:CC:DD:EE:FF"]).mac == "AA:BB:CC:DD:EE:FF"


def test_parser_media_flags() -> None:
    """--mac and --action are required and actions are constrained."""
    args = bs.parse_args(["media", "--mac", "00:1A:7D:DA:71:13", "--action", "pause"])
    assert args.mac == "00:1A:7D:DA:71:13"
    assert args.action == "pause"
    assert args.frame == "avc" and args.repeat == 1

    with pytest.raises(SystemExit):
        bs.parse_args(["media", "--action", "pause"])
    with pytest.raises(SystemExit):
        bs.parse_args(["media", "--mac", "00:1A:7D:DA:71:13", "--action", "dance"])


def test_parser_takeover_and_raw() -> None:
    """simulate-takeover has an alias; raw requires char + hex."""
    args = bs.parse_args(["simulate-takeover", "--mac", "AA:BB:CC:DD:EE:FF"])
    assert args.command == "simulate-takeover" and args.hold == 30.0
    assert bs.parse_args(["takeover", "--mac", "AA:BB:CC:DD:EE:FF"]).command == "takeover"

    raw = bs.parse_args(
        ["raw", "--mac", "AA:BB:CC:DD:EE:FF", "--char", bs.UUID_AVRCP_PASSTHROUGH, "--hex", "AA BB"]
    )
    assert raw.char == bs.UUID_AVRCP_PASSTHROUGH and raw.hex == "AA BB"
    with pytest.raises(SystemExit):
        bs.parse_args(["raw", "--mac", "AA:BB:CC:DD:EE:FF", "--hex", "AA"])


# ---------------------------------------------------------------------------
# Controller behaviour against a fake client
# ---------------------------------------------------------------------------


def test_send_avrcp_writes_press_then_release() -> None:
    """Against a fake speaker the controller emits exactly two frames."""
    client = avrcp_client()
    master = bs.BluetoothMaster(
        console=_quiet_console(), audit_log=Path("/tmp/bluescan-test-audit.log")
    )

    result = asyncio.run(master.send_avrcp(client, "play"))

    assert result.ok, result.error
    assert [w["data"] for w in client.writes] == [
        bytes.fromhex("00487C4400"),
        bytes.fromhex("00487CC400"),
    ]
    assert client.writes[0]["response"] is True
    assert result.elapsed_ms >= 0
    assert [f.hex() for f in result.frames] == ["00487c4400", "00487cc400"]
    assert (
        json.loads(Path("/tmp/bluescan-test-audit.log").read_text().splitlines()[-1])["action"]
        == "play"
    )


def test_send_avrcp_reports_write_failures_without_raising() -> None:
    """A refused write becomes a failed result, so a sequence can continue."""
    client = avrcp_client()
    client.fail_writes = True
    master = bs.BluetoothMaster(
        console=_quiet_console(), audit_log=Path("/tmp/bluescan-test-audit2.log")
    )

    result = asyncio.run(master.send_avrcp(client, "next"))

    assert result.ok is False
    assert "refused" in (result.error or "").lower()


def test_resolve_media_characteristic_override_missing() -> None:
    """An explicit UUID that does not exist raises a UUID-mismatch error."""
    client = avrcp_client()
    with pytest.raises(bs.CharacteristicMismatch):
        bs.resolve_media_characteristic(client, "0000ffff-0000-1000-8000-00805f9b34fb")


def test_resolve_media_characteristic_heuristic() -> None:
    """Without the known UUIDs, a writable audio-ish characteristic is used."""
    service = FakeService(
        "00001848-0000-1000-8000-00805f9b34fb",
        [FakeCharacteristic("00002ba4-0000-1000-8000-00805f9b34fb", ["write-without-response"])],
        "Media Control",
    )
    client = FakeClient([service])
    protocol, char = bs.resolve_media_characteristic(client)
    assert protocol == "mcp"
    assert str(char.uuid).startswith("00002ba4")


def test_raw_inject_chunks_and_repeats() -> None:
    """raw_inject splits payloads and records every attempt."""
    client = avrcp_client()
    master = bs.BluetoothMaster(
        console=_quiet_console(), audit_log=Path("/tmp/bluescan-test-audit3.log")
    )

    # Patch the session so we do not need a radio.
    async def run() -> List[Dict[str, Any]]:
        master.authorized = True
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(master, "session", _fake_session(client))
            return await master.raw_inject(
                "00:1A:7D:DA:71:13",
                bs.UUID_AVRCP_PASSTHROUGH,
                "AA BB CC DD",
                chunk=2,
                repeat=2,
                delay=0,
            )

    results = asyncio.run(run())
    assert len(results) == 4  # 2 chunks x 2 repeats
    assert sum(1 for r in results if r["ok"]) == 4
    assert len(client.writes) == 4


def test_raw_inject_unknown_characteristic() -> None:
    """A wrong UUID surfaces as a characteristic mismatch, not a crash."""
    client = avrcp_client()
    master = bs.BluetoothMaster(
        console=_quiet_console(), audit_log=Path("/tmp/bluescan-test-audit4.log")
    )

    async def run() -> None:
        master.authorized = True
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(master, "session", _fake_session(client))
            await master.raw_inject(
                "00:1A:7D:DA:71:13", "0000dead-0000-1000-8000-00805f9b34fb", "AA"
            )

    with pytest.raises(bs.CharacteristicMismatch):
        asyncio.run(run())


def test_simulate_takeover_sequence_and_notifications() -> None:
    """Takeover sends stop, prev x5, play and subscribes to notifications."""
    client = avrcp_client()
    master = bs.BluetoothMaster(
        console=_quiet_console(), audit_log=Path("/tmp/bluescan-test-audit5.log")
    )

    async def run() -> List[bs.MediaCommandResult]:
        master.authorized = True
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(master, "session", _fake_session(client))
            return await master.simulate_takeover("00:1A:7D:DA:71:13", hold=0.1)

    results = asyncio.run(run())
    assert [r.action for r in results] == ["stop", "prev", "prev", "prev", "prev", "prev", "play"]
    assert all(r.ok for r in results)
    assert client.notifications, "should subscribe to notify characteristics"
    # 7 commands x (press + release) writes
    assert len(client.writes) == 14


def test_authorization_gate_blocks_active_tests(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without --yes and without a TTY, active tests refuse to run."""

    class _NotATty:
        def isatty(self) -> bool:
            return False

    monkeypatch.setattr(sys, "stdin", _NotATty())
    master = bs.BluetoothMaster(
        console=_quiet_console(), audit_log=Path("/tmp/bluescan-test-audit6.log")
    )
    with pytest.raises(bs.NotAuthorized):
        master.require_authorization("00:1A:7D:DA:71:13")

    master.authorized = True
    master.require_authorization("00:1A:7D:DA:71:13")  # must not raise


def test_dry_run_media_end_to_end(tmp_path: Path) -> None:
    """--dry-run exercises the whole CLI path without a radio."""
    audit = tmp_path / "audit.log"
    code = bs.main(
        [
            "media",
            "--mac",
            "00:1A:7D:DA:71:13",
            "--action",
            "pause",
            "--dry-run",
            "--yes",
            "--no-color",
            "--audit-log",
            str(audit),
        ]
    )
    assert code == 0
    assert audit.exists()


def test_dry_run_profile_and_takeover(tmp_path: Path) -> None:
    """profile and simulate-takeover also run cleanly in dry-run mode."""
    assert (
        bs.main(
            [
                "profile",
                "00:1A:7D:DA:71:13",
                "--dry-run",
                "--no-color",
                "--audit-log",
                str(tmp_path / "a.log"),
            ]
        )
        == 0
    )
    assert (
        bs.main(
            [
                "simulate-takeover",
                "--mac",
                "00:1A:7D:DA:71:13",
                "--hold",
                "0",
                "--dry-run",
                "--no-color",
                "--audit-log",
                str(tmp_path / "b.log"),
            ]
        )
        == 0
    )


def test_scan_dry_run_returns_immediately(tmp_path: Path) -> None:
    """scan --dry-run must not touch the adapter and must exit quickly."""
    import time

    started = time.monotonic()
    code = bs.main(
        [
            "scan",
            "--duration",
            "5",
            "--dry-run",
            "--no-color",
            "--audit-log",
            str(tmp_path / "c.log"),
        ]
    )
    assert code == 0
    assert time.monotonic() - started < 5


def test_invalid_hex_exits_non_zero(tmp_path: Path) -> None:
    """A bad --hex payload is reported, not crashed on."""
    code = bs.main(
        [
            "raw",
            "--mac",
            "00:1A:7D:DA:71:13",
            "--char",
            bs.UUID_AVRCP_PASSTHROUGH,
            "--hex",
            "ZZ",
            "--dry-run",
            "--yes",
            "--no-color",
            "--audit-log",
            str(tmp_path / "d.log"),
        ]
    )
    assert code == 1


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _quiet_console() -> Any:
    """Console that never writes to the real terminal."""
    from rich.console import Console

    return Console(quiet=True, no_color=True, width=100)


def _fake_session(client: FakeClient) -> Any:
    """Return an async context manager yielding ``client`` (replaces BleakClient)."""
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _session(*_args: Any, **_kwargs: Any) -> Any:
        yield client

    return _session
