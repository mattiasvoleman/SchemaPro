"""The host the deployment document tells an operator to start the engine with, held against what uvicorn does with it.

docs/DEPLOYMENT.md 5.3 (omgång 15, the 2026-11-23 incident) gives a custom start command for an engine whose private
network is IPv6 only. The first draft said `--host ::` and that "a `::` socket accepts IPv4 as well, so the public domain
keeps working". It does not: uvicorn with one worker hands the host to asyncio (uvloop), and both set IPV6_V6ONLY on an
IPv6 socket, so `::` takes IPv6 only and IPv4 is refused (measured on this image: uvicorn 0.39.0, uvloop 0.22.1, Linux).
An empty host makes the loop bind every address of both families. The first test runs the command's own host against both
families and fails for `::`; the second says why the document does not use it, so that a uvicorn that one day changes the
answer sends someone back to the paragraph.
"""

from __future__ import annotations

import re
import socket
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import uvicorn

DEPLOYMENT = Path(__file__).resolve().parents[2] / "docs" / "DEPLOYMENT.md"


def _documented_host() -> str:
    """The `--host` of the custom start command section 5.3 gives (an empty one is written `''`)."""
    text = DEPLOYMENT.read_text(encoding="utf8")
    section = text[text.index("### 5.3 The road to the engine") : text.index("## 6. Deploy the web app")]
    found = re.search(r'sh -c "exec uvicorn app\.main:app --host (\'\'|""|\S+) --port', section)
    assert found is not None, "section 5.3 no longer gives the custom start command this test reads"
    return "" if found.group(1) in {"''", '""'} else found.group(1)


def _ipv6_loopback_works() -> bool:
    if not socket.has_ipv6:
        return False
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as probe:
            probe.bind(("::1", 0))
        return True
    except OSError:
        return False


pytestmark = pytest.mark.skipif(not _ipv6_loopback_works(), reason="this machine has no IPv6 loopback to listen on")


async def _ok(scope: dict[str, Any], receive: Any, send: Any) -> None:
    if scope["type"] == "http":
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-length", b"2")]})
        await send({"type": "http.response.body", "body": b"ok"})


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


@pytest.fixture
def listening() -> Iterator[Any]:
    started: list[tuple[uvicorn.Server, threading.Thread]] = []

    def start(host: str) -> int:
        port = _free_port()
        # One worker, as the Dockerfile and the document start it: the path that hands the host to the event loop.
        server = uvicorn.Server(uvicorn.Config(_ok, host=host, port=port, workers=1, lifespan="off", log_level="warning"))
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        deadline = time.monotonic() + 15
        while not server.started and time.monotonic() < deadline:
            time.sleep(0.05)
        assert server.started, "uvicorn did not come up"
        started.append((server, thread))
        return port

    yield start
    for server, thread in started:
        server.should_exit = True
        thread.join(15)


def _answers(family: int, address: str, port: int) -> bool:
    try:
        with socket.socket(family, socket.SOCK_STREAM) as client:
            client.settimeout(3)
            client.connect((address, port))
            client.sendall(b"GET / HTTP/1.0\r\n\r\n")
            return client.recv(64).startswith(b"HTTP/1.1 200")
    except OSError:
        return False


def test_the_start_command_the_document_gives_listens_on_both_address_families(listening: Any) -> None:
    port = listening(_documented_host())

    assert _answers(socket.AF_INET, "127.0.0.1", port), "IPv4 is refused: the public domain would not reach the engine"
    assert _answers(socket.AF_INET6, "::1", port), "IPv6 is refused: the private network would not reach the engine"


def test_a_bare_double_colon_host_is_ipv6_only_which_is_why_the_document_does_not_use_it(listening: Any) -> None:
    port = listening("::")

    assert _answers(socket.AF_INET6, "::1", port)
    assert not _answers(socket.AF_INET, "127.0.0.1", port)
