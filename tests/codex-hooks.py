import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parent.parent / "scripts"


class HookTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="codex hooks ")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.hooks = self.root / "hooks"
        self.hooks.mkdir()
        for name in ("codex-hooks.py", "dangerous-command-blocker.sh", "gitleaks-precommit.sh", "shared-test-runner.ts"):
            shutil.copyfile(SOURCE / name, self.hooks / name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        path = str(self.bin) + os.pathsep + os.environ["PATH"]
        (self.hooks / "runtime.json").write_text(json.dumps({"path": path}))
        self.repo = self.root / "repository with spaces"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        subprocess.run(["git", "-C", str(self.repo), "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial"], check=True)

    def binary(self, name, source):
        path = self.bin / name
        path.write_text("#!/bin/sh\n" + source)
        path.chmod(0o755)

    def hook(self, action, **fields):
        payload = {"cwd": str(self.repo), **fields}
        return subprocess.run([sys.executable, str(self.hooks / "codex-hooks.py"), action], input=json.dumps(payload), text=True, capture_output=True)

    def test_destructive_command_is_blocked_without_execution(self):
        result = self.hook("guard", tool_input={"command": "rm -rf /"})
        self.assertEqual(result.returncode, 2)
        self.assertIn("BLOCKED", result.stderr)

    def test_normal_command_is_allowed(self):
        self.assertEqual(self.hook("guard", tool_input={"command": "git status"}).returncode, 0)

    def test_commit_with_git_C_scans_correct_directory(self):
        self.binary("gitleaks", 'echo "mock secret finding"; exit 1\n')
        command = f'git -C "{self.repo}" commit -m test'
        result = self.hook("guard", cwd=str(self.root), tool_input={"command": command})
        self.assertEqual(result.returncode, 2)
        self.assertIn("mock secret finding", result.stderr)

    def test_tests_include_untracked_files_and_deduplicate_package(self):
        (self.repo / "go.mod").write_text("module example.com/test\n")
        (self.repo / "a.go").write_text("package test\n")
        (self.repo / "b.go").write_text("package test\n")
        count = self.root / "count"
        self.binary("bun", f'echo called >> "{count}"; echo pass; exit 0\n')
        result = self.hook("tests")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(count.read_text().splitlines(), ["called"])

    def test_failure_requests_repair_but_does_not_loop(self):
        (self.repo / "a.ts").write_text("export const a = 1\n")
        self.binary("bun", 'echo "test failed" >&2; exit 2\n')
        result = self.hook("tests")
        self.assertEqual(result.returncode, 2)
        self.assertIn("test failed", result.stderr)
        self.assertEqual(self.hook("tests", stop_hook_active=True).returncode, 0)

    def test_docs_do_not_trigger_tests(self):
        (self.repo / "README.md").write_text("documentation\n")
        self.binary("bun", 'echo "should not run" >&2; exit 2\n')
        result = self.hook("tests")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
