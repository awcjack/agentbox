#!/usr/bin/env python3
"""Exercise the real launcher template with a JSON-printing fake Chromium."""
import json
import os
from pathlib import Path
import subprocess
import sys

launcher = sys.argv[1]
env = dict(os.environ)
env.pop("DISPLAY", None)
env.pop("WAYLAND_DISPLAY", None)
for flag in (
    "no-sandbox", "disable-namespace-sandbox", "disable-seccomp-filter-sandbox",
    "disable-gpu-sandbox", "single-process", "no-zygote",
):
    for prefix in ("-", "--"):
        for suffix in ("", "=true", "=false"):
            result = subprocess.run(
                [launcher, prefix + flag + suffix], env=env, capture_output=True, text=True
            )
            assert result.returncode == 64, (flag, result)
            assert "refusing sandbox-disabling argument" in result.stderr
            assert not result.stdout, "Chromium was invoked despite rejected flag"
args = ["--remote-debugging-port=0", "--user-data-dir=/tmp/profile with spaces", "about:blank"]
result = subprocess.run([launcher, *args], env=env, capture_output=True, text=True, check=True)
actual = json.loads(result.stdout)
assert actual["args"] == ["--headless=new", "--disable-setuid-sandbox", *args], actual
assert Path(actual["fontconfig"]).is_file(), actual
assert "--no-sandbox" not in actual["args"]
print("PASS: 36 sandbox-bypass variants rejected; headless/namespace flags, argv and fonts preserved")
