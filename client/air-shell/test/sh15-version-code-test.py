#!/usr/bin/env python3
"""SH-15 app version scheme in build.py only: parsing, Android version codes and the descriptor's versionNumber.
No SDK, extraction, signing or network."""
import argparse
import importlib.util
import subprocess
import sys
from pathlib import Path

path = Path(__file__).resolve().parents[1] / "build.py"
spec = importlib.util.spec_from_file_location("shell_build", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def adt_code(version_number):
    """What ADT makes of a versionNumber: MAJOR * 1000000 + MINOR * 1000 + PATCH, each part up to three digits."""
    parts = [int(part) for part in version_number.split(".")]
    assert len(parts) == 3 and all(0 <= part <= 999 for part in parts), version_number
    return parts[0] * 1000000 + parts[1] * 1000 + parts[2]


codes = {"0.1.0": (10099, "0.10.99"), "0.2.0-beta.1": (20031, "0.20.31"), "0.2.0-alpha": (20000, "0.20.0"),
         "0.2.0-alpha.29": (20029, "0.20.29"), "0.2.0-beta": (20030, "0.20.30"), "0.2.0-pre.1": (20061, "0.20.61"),
         "1.2.3": (1020399, "1.20.399"), "999.99.99": (999999999, "999.999.999")}
for text, (code, number) in codes.items():
    assert module.app_version(text) == text, text
    assert module.version_code(text) == code, (text, module.version_code(text))
    assert module.version_number(text) == number, (text, module.version_number(text))
    assert adt_code(number) == code, text

assert module.app_version(" 00.02.000-beta.03\n") == "0.2.0-beta.3"
ordered = ["0.2.0-alpha", "0.2.0-alpha.1", "0.2.0-alpha.2", "0.2.0-beta", "0.2.0-beta.1", "0.2.0-pre.1", "0.2.0",
           "0.2.1-alpha", "0.2.1", "0.10.0-beta", "1.0.0"]
assert [module.version_code(v) for v in ordered] == sorted(module.version_code(v) for v in ordered)
assert len({module.version_code(v) for v in ordered}) == len(ordered)

for bad in ["1.2.3-rc.1", "1.2.3-beta.30", "1.100.0", "1.0.100", "1000.0.0", "1.2.3-BETA", "1.2.3-beta.", "1.2.3-",
            "1.2.3-alpha1", "1.2.3+build", "1.2", "v1.2.3", "١.2.3", "",
            "0.0.0-alpha", "0.0.0-pre.21"]:  # the last two give codes 0 and 81, not above the pre-versioning builds
    try:
        module.app_version(bad)
    except argparse.ArgumentTypeError:
        continue
    raise AssertionError("app version accepted: " + bad)
assert module.app_version("0.0.0-pre.22") == "0.0.0-pre.22", "code 82 is above the pre-versioning builds"

with open(module.VERSION_FILE, encoding="utf-8") as f:
    module.app_version(f.read())
result = subprocess.run([sys.executable, "-I", str(path), "--apk", "/nonexistent/not-extracted.apk",
                         "--version", "1.2.3-rc.1"], capture_output=True, text=True)
assert result.returncode == 2 and "must be MAJOR.MINOR.PATCH" in result.stderr, result.stderr
assert "Traceback" not in result.stderr
print("App version codes: build.py maps each version to the expected Android version code and versionNumber")
