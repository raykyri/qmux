#!/usr/bin/env python3
"""Opt-in real-process runtime regression. Requires tmux 3.3+ and a built binary.
Usage: python3 scripts/test-runtime.py src-tauri/target/debug/qmux-runtime
All workspaces, credentials and sockets are created below a temporary directory.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

binary = Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix="qmux-rt-") as temporary:
    root = Path(temporary)
    workspace = root / "workspace"
    workspace.mkdir()
    config = root / "config.json"
    config.write_text(json.dumps({"workspaceRoot": str(workspace), "socketPath": str(root / "control.sock")}))
    environment = {key: value for key, value in os.environ.items() if not key.startswith("QMUX_")}
    environment["QMUX_CONFIG"] = str(config)
    runtime = root / "runtime"
    log = open(root / "service.log", "w+")
    service = subprocess.Popen([str(binary), "serve", str(runtime)], env=environment, stdout=log, stderr=log)

    def cli(*args):
        result = subprocess.run([str(binary), *args], env=environment, text=True, capture_output=True, timeout=30)
        if result.returncode:
            raise AssertionError(result.stderr)
        return json.loads(result.stdout) if result.stdout.strip() else None

    def call(method, args):
        return cli("call", str(runtime), method, json.dumps(args))

    def eventually(read, check, label):
        deadline = time.monotonic() + 20
        last = None
        while time.monotonic() < deadline:
            try:
                last = read()
                if check(last):
                    return last
            except AssertionError as error:
                last = str(error)
            if service.poll() is not None:
                log.seek(0)
                raise AssertionError(log.read())
            time.sleep(0.05)
        raise AssertionError(f"{label}: {last}")

    try:
        eventually(lambda: cli("snapshot", str(runtime)), lambda value: "state" in value, "runtime readiness")
        group = call("group_create", {"request": {"name": "Runtime regression", "dir": str(workspace)}})
        pane = call("spawn_shell", {"groupId": group["id"]})
        pane_id = pane["id"]
        # Each call uses a fresh client process. Process identity survives all
        # disconnects and queue/input ownership stays in the service.
        def send(command):
            call("pane_write", {"options": {"paneId": pane_id, "data": command, "paste": True, "submit": True}})
        def capture():
            return call("terminal_capture", {"paneId": pane_id, "history": True})
        send("printf 'QMUX_PID:%s\\n' \"$$\"")
        output = eventually(capture, lambda text: re.search(r"QMUX_PID:(\d+)", text), "first prompt")
        pid = re.search(r"QMUX_PID:(\d+)", output).group(1)
        call("create_global_draft", {"text": "draft survives client detach"})
        snapshot = cli("snapshot", str(runtime))
        assert snapshot["state"]["globalDrafts"][0]["text"] == "draft survives client detach"
        send("printf 'QMUX_AGAIN:%s\\n' \"$$\"")
        eventually(capture, lambda text: f"QMUX_AGAIN:{pid}" in text, "reconnected prompt")
        other = subprocess.run([str(binary), "serve", str(root / "other-runtime")], env=environment,
                               text=True, capture_output=True, timeout=15)
        assert other.returncode != 0 and "owner" in other.stderr, other.stderr
        assert service.poll() is None
        cli("stop", str(runtime))
        assert service.wait(timeout=20) == 0
        saved = json.loads((workspace / ".qmux" / "state.json").read_text())
        assert any(item["id"] == pane_id for item in saved["panes"]), "shutdown erased the pane before saving"
        assert saved["globalDrafts"][0]["text"] == "draft survives client detach"
        # A clean restart may recreate a shell, but a crash with surviving PTYs
        # must refuse to replay saved work or adopt invalid hook credentials.
        service = subprocess.Popen([str(binary), "serve", str(runtime)], env=environment, stdout=log, stderr=log)
        eventually(lambda: cli("snapshot", str(runtime)), lambda value: bool(value["state"]["panes"]), "clean restart")
        attachment = call("terminal_attachment", {"paneId": pane_id})
        terminal_socket = attachment["args"][1]
        service.kill()
        service.wait(timeout=10)
        rejected = subprocess.run([str(binary), "serve", str(runtime)], env=environment,
                                  text=True, capture_output=True, timeout=15)
        assert rejected.returncode != 0 and "persistent terminals still exist" in rejected.stderr, rejected.stderr
        alive = subprocess.run([attachment["program"], "-S", terminal_socket, "list-sessions"], capture_output=True)
        assert alive.returncode == 0, "refused recovery killed surviving work"
        subprocess.run([attachment["program"], "-S", terminal_socket, "kill-server"], check=True, capture_output=True)
        print("runtime process regression passed: disconnect, input, identity, ownership, persistence, clean restart, crash fencing, shutdown")
    finally:
        if service.poll() is None:
            service.terminate()
            try:
                service.wait(timeout=20)
            except subprocess.TimeoutExpired:
                service.kill()
                service.wait()
        # This socket belongs exclusively to this test's temporary directory.
        if (runtime / "terminals" / "tmux.sock").exists():
            subprocess.run(["tmux", "-S", str(runtime / "terminals" / "tmux.sock"), "kill-server"], capture_output=True)
        log.close()
