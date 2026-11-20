#!/usr/bin/env python3
"""New baked-server CLI policy regression only; no SDK, extraction, signing or network."""
import argparse
import subprocess
import sys
import importlib.util
from pathlib import Path

path = Path(__file__).resolve().parents[1] / "build.py"
spec = importlib.util.spec_from_file_location("shell_build", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.server_address("") == ""
assert module.server_address("host:8000") == "https://host:8000"
for value in ["https://host/", "HTTPS://HOST:443///", "http://[::1]:80/"]:
    assert module.server_address(value) == value.rstrip("/")
for value in ["http://host/deployment", "http://host/deployment///", "https://host/%2f", "https://host/.",
              "http://host:0", "http://host:-1", "http://host:65536", "http://host:", "http://user:pass@host", "https://host?q=x", "https://host#x", "https://host?", "https://host#"]:
    try:
        module.server_address(value)
    except argparse.ArgumentTypeError:
        continue
    raise AssertionError("Unsupported baked server accepted: " + value)
for invalid in ["https://host/deployment", "http://host:0"]:
    result = subprocess.run([sys.executable, "-I", str(path), "--apk", "/nonexistent/not-extracted.apk", "--server", invalid],
                            capture_output=True, text=True)
    assert result.returncode == 2
    assert "--server needs" in result.stderr
    assert "Traceback" not in result.stderr, "validation must precede APK extraction or SDK work"
print("Baked --server host-only validation checks passed")
