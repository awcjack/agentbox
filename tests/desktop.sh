#!/usr/bin/env bash
set -euo pipefail
# Run separately so hosts denying user namespaces can still test the desktop.
if [[ ${1:-} == --sandbox ]]; then
  exec python3 - "${2:?package path required}" <<'PY'
import os
from pathlib import Path
import re
import resource
import signal
import subprocess
import sys
import tempfile

browser = Path(sys.argv[1]) / 'bin/chromium'
wrapper = browser.read_text()
assert '--disable-setuid-sandbox "$@"' in wrapper
assert '--no-sandbox' not in wrapper and '--disable-seccomp' not in wrapper
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
with tempfile.TemporaryDirectory(prefix='agentbox-sandbox-test-') as directory:
    log = Path(directory) / 'log'
    with log.open('w') as output:
        p = subprocess.Popen([str(browser), '--headless', '--no-first-run',
                              '--disable-crashpad-for-testing',
                              f'--user-data-dir={directory}/profile', '--dump-dom',
                              '--allow-chrome-scheme-url', 'chrome://sandbox'],
                             stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        status = p.wait(timeout=25)
    finally:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        p.wait(timeout=5)
    result = log.read_text()
    if status == 0:
        text = re.sub('<[^>]+>', ' ', result)
        assert re.search(r'Namespace sandbox\s+Yes', text, re.I), result
        assert re.search(r'Seccomp-BPF sandbox\s+Yes', text, re.I), result
        print('PASS Chromium reports namespace sandbox and seccomp-BPF enabled')
    else:
        assert 'No usable sandbox!' in result, result
        assert 'SUID sandbox helper binary was found' not in result, result
        probe = subprocess.run(['unshare', '-Ur', 'true'], capture_output=True, text=True)
        assert probe.returncode != 0, result
        print('PASS Chromium fails closed without falling back to a setuid helper')
        print('SKIP browser rendering: user namespaces unavailable: ' + probe.stderr.strip())
PY
fi
# Optional real package smoke test: bash tests/desktop.sh --real /nix/store/...-agentbox-desktop
if [[ ${1:-} == --real ]]; then
  exec python3 - "${2:?package path required}" <<'PY'
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

package = Path(sys.argv[1])
authority = Path(f'/tmp/agentbox-desktop-{os.getuid()}/Xauthority')
assert not authority.exists(), 'desktop already active'
ports = []
for _ in range(2):
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        ports.append(s.getsockname()[1])
assert ports[0] != ports[1]
display = 20000 + os.getpid() % 30000
with tempfile.TemporaryDirectory(prefix='agentbox-desktop-real-') as directory:
    log = Path(directory) / 'log'
    env = dict(os.environ, PATH=str(package / 'bin'), DISPLAY=f':{display}',
               XAUTHORITY=str(authority), AGENTBOX_DESKTOP_VNC_PORT=str(ports[0]),
               AGENTBOX_DESKTOP_WEB_PORT=str(ports[1]))
    with log.open('w') as output:
        p = subprocess.Popen([str(package / 'bin/agentbox-desktop')], env=env,
                             stdout=output, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 30
        while 'ready on' not in log.read_text():
            assert p.poll() is None, log.read_text()
            assert time.monotonic() < deadline, log.read_text()
            time.sleep(0.1)
        result = subprocess.check_output(['xdpyinfo'], env=env, text=True, timeout=5)
        assert '1440x900 pixels' in result
        denied = subprocess.run(['xdpyinfo'], env=dict(env, XAUTHORITY='/dev/null'),
                                capture_output=True, timeout=5)
        assert denied.returncode != 0, 'X accepted a client without the cookie'
        subprocess.run(['xdotool', 'mousemove', '100', '100'], env=env, check=True, timeout=5)
        shot = Path(directory) / 'desktop.png'
        subprocess.run(['scrot', str(shot)], env=env, check=True, timeout=5)
        assert shot.stat().st_size > 100
        with urllib.request.urlopen(f'http://127.0.0.1:{ports[1]}/vnc.html', timeout=5) as response:
            assert b'noVNC' in response.read()
        with socket.create_connection(('127.0.0.1', ports[0]), timeout=5) as s:
            assert s.recv(12).startswith(b'RFB ')
        listeners = []
        for table in ('/proc/net/tcp', '/proc/net/tcp6'):
            for line in Path(table).read_text().splitlines()[1:]:
                fields = line.split()
                address, port = fields[1].split(':')
                if fields[3] == '0A':
                    assert int(port, 16) != 6000 + display, 'X TCP listener found'
                    if int(port, 16) in ports:
                        assert address == '0100007F', f'non-loopback listener: {line}'
                        listeners.append(int(port, 16))
        assert sorted(listeners) == sorted(ports)
        browser = (package / 'bin/chromium').read_text()
        assert '--disable-setuid-sandbox "$@"' in browser
        assert '--no-sandbox' not in browser and '--disable-seccomp' not in browser
        font_config = re.search(r'export FONTCONFIG_FILE=(\S+)', browser)[1]
        fonts = subprocess.check_output(['fc-list'], env=dict(env, FONTCONFIG_FILE=font_config), text=True)
        assert 'DejaVu' in fonts and 'Liberation' in fonts and 'Emoji' in fonts
        print('PASS real X/authentication, resolution, input, screenshot, VNC, noVNC HTTP, loopback-only listeners, browser fonts')
    finally:
        p.terminate()
        p.wait(timeout=8)
        assert not authority.exists()
        assert not Path(f'/tmp/.X{display}-lock').exists()
        assert not Path(f'/tmp/.X11-unix/X{display}').exists()
    print('PASS real shutdown cleanup')
PY
fi
# No GUI or Nix required: Bash, Python 3, coreutils, and util-linux suffice.
exec python3 - "${1:-$(dirname "$0")/../scripts/agentbox-desktop.sh}" <<'PY'
import os
from pathlib import Path
import signal
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time

launcher = str(Path(sys.argv[1]).resolve())
runtime = Path(f"/tmp/agentbox-desktop-{os.getuid()}")
if (runtime / "Xauthority").exists():
    sys.exit("Refusing to test while a desktop Xauthority exists")

mock = r'''#!/usr/bin/env python3
import os, pathlib, signal, socket, subprocess, sys, time
name = pathlib.Path(sys.argv[0]).name
root = pathlib.Path(os.environ['MOCK_ROOT'])
with (root / 'calls').open('a') as f:
    f.write(name + ' ' + ' '.join(sys.argv[1:]) + '\n')
if name == 'xauth':
    assert len(sys.argv[-1]) == 32
    assert pathlib.Path(os.environ['XAUTHORITY']).stat().st_mode & 0o777 == 0o600
    sys.exit(0)
if name in ('xdpyinfo', 'dbus-send'):
    if os.environ.get('MOCK_HANG') == name:
        time.sleep(60)
    target = 'Xvfb' if name == 'xdpyinfo' else 'dbus-daemon'
    sys.exit(0 if (root / (target + '.ready')).exists() else 1)
with (root / 'pids').open('a') as f:
    f.write(str(os.getpid()) + '\n')
if os.environ.get('MOCK_FAIL') == name:
    sys.exit(7)
if name == 'openbox':
    child = subprocess.Popen([sys.executable, '-c',
        'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(120)'])
    with (root / 'pids').open('a') as f:
        f.write(str(child.pid) + '\n')
if name in ('x11vnc', 'websockify'):
    port = int(sys.argv[sys.argv.index('-rfbport') + 1]) if name == 'x11vnc' else int(sys.argv[-2].split(':')[1])
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('127.0.0.1', port))
    s.listen()
    s.settimeout(0.1)
(root / (name + '.ready')).touch()
while True:
    if (root / (name + '.crash')).exists():
        sys.exit(8)
    if name in ('x11vnc', 'websockify'):
        try:
            conn, _ = s.accept()
            conn.close()
        except socket.timeout:
            pass
    else:
        time.sleep(0.05)
'''

def until(predicate, seconds=8):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError('deadline exceeded')

def alive(pid):
    try:
        return Path(f'/proc/{pid}/stat').read_text().split()[2] != 'Z'
    except FileNotFoundError:
        return False

with tempfile.TemporaryDirectory(prefix='agentbox-desktop-test-') as directory:
    root = Path(directory)
    bin_dir = root / 'bin'
    bin_dir.mkdir()
    program = bin_dir / 'mock'
    program.write_text(mock)
    program.chmod(0o755)
    for name in ('Xvfb', 'xauth', 'xdpyinfo', 'dbus-daemon', 'dbus-send', 'openbox', 'x11vnc', 'websockify'):
        (bin_dir / name).symlink_to(program)
    sockets = [socket.socket(), socket.socket()]
    for s in sockets:
        s.bind(('127.0.0.1', 0))
    ports = [str(s.getsockname()[1]) for s in sockets]
    for s in sockets:
        s.close()
    env = dict(os.environ, PATH=f'{bin_dir}:' + os.environ['PATH'],
               DISPLAY=f':{20000 + os.getpid() % 30000}',
               AGENTBOX_DESKTOP_NOVNC=directory,
               AGENTBOX_DESKTOP_DBUS_CONFIG='/dev/null',
               AGENTBOX_DESKTOP_VNC_PORT=ports[0], AGENTBOX_DESKTOP_WEB_PORT=ports[1])
    processes = []

    def launch(name, **extra):
        case = root / name
        case.mkdir()
        log = case / 'log'
        with log.open('w') as output:
            p = subprocess.Popen(['bash', launcher], env=dict(env, MOCK_ROOT=str(case), **extra),
                                 stdout=output, stderr=subprocess.STDOUT)
        processes.append(p)
        return p, case, log

    def ready(p, log):
        until(lambda: 'ready on' in log.read_text() or p.poll() is not None)
        assert p.poll() is None, log.read_text()

    def stopped(p, case, log, seconds=8, restarted=False):
        assert p.wait(timeout=seconds) != 0, log.read_text()
        pids = case / 'pids'
        if pids.exists():
            until(lambda: not any(alive(int(pid)) for pid in pids.read_text().split()))
        if not restarted:
            assert not (runtime / 'Xauthority').exists(), log.read_text()

    try:
        for key, value in [('DISPLAY', 'remote:10'), ('DISPLAY', ':1.0'),
                           ('AGENTBOX_DESKTOP_VNC_PORT', '0'), ('AGENTBOX_DESKTOP_WEB_PORT', '65536'),
                           ('AGENTBOX_DESKTOP_WEB_PORT', ports[0]),
                           ('AGENTBOX_DESKTOP_RESOLUTION', 'bad')]:
            p, case, log = launch(f'invalid-{len(processes)}', **{key: value})
            stopped(p, case, log)
            assert not (case / 'calls').exists()
        print('PASS input validation', flush=True)

        # Use a high unused display; never remove or replace another server's lock.
        display_lock = Path(f'/tmp/.X{env["DISPLAY"][1:]}-lock')
        with display_lock.open('x') as f:
            f.write('occupied')
        try:
            p, case, log = launch('occupied-display')
            stopped(p, case, log)
            assert 'occupied' in log.read_text()
            assert display_lock.read_text() == 'occupied'
        finally:
            display_lock.unlink()
        print('PASS display refusal', flush=True)

        with socket.socket() as occupied:
            occupied.bind(('127.0.0.1', int(ports[0])))
            occupied.listen()
            p, case, log = launch('occupied-port')
            stopped(p, case, log)
            assert 'already occupied' in log.read_text()
            assert not (case / 'calls').exists()
        print('PASS occupied port refusal', flush=True)

        for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            p, case, log = launch(f'signal-{sig}')
            ready(p, log)
            calls = (case / 'calls').read_text()
            assert '-nolisten tcp -auth ' in calls
            assert '-listen 127.0.0.1' in calls and '-nopw' in calls
            assert f'websockify --web {directory} 127.0.0.1:{ports[1]} 127.0.0.1:{ports[0]}' in calls
            assert 'chromium' not in calls and '--no-sandbox' not in calls
            assert (runtime / 'Xauthority').stat().st_mode & 0o777 == 0o600
            if sig == signal.SIGTERM:
                started = time.monotonic()
                competitor, competitor_case, competitor_log = launch('lock-timeout')
                assert competitor.wait(timeout=13) != 0
                assert 9 <= time.monotonic() - started < 13
                assert 'timed out waiting for desktop lock' in competitor_log.read_text()
                assert not (competitor_case / 'calls').exists()
                assert (runtime / 'Xauthority').exists()
            p.send_signal(sig)
            # A stubborn descendant keeps cleanup active and the lock held.
            competitor, competitor_case, competitor_log = launch(f'restarting-{sig}')
            time.sleep(0.1)
            assert competitor.poll() is None
            assert not (competitor_case / 'calls').exists()
            ready(competitor, competitor_log)
            stopped(p, case, log, restarted=True)
            competitor.terminate()
            stopped(competitor, competitor_case, competitor_log)
        print('PASS bounded lock timeout, TERM/HUP/INT, descendant KILL, waiting immediate restart', flush=True)

        if shutil.which('tmux'):
            tmux = ['tmux', '-S', str(root / 'tmux.sock'), '-f', '/dev/null']
            case = root / 'tmux-original'
            case.mkdir()
            log = case / 'log'
            # An independent anchor keeps the isolated server alive while the
            # desktop session is killed/recreated, without touching user tmux.
            subprocess.run(tmux + ['new-session', '-d', '-s', 'anchor', 'sleep 120'],
                           env=env, check=True, timeout=5)
            def tmux_start(case, log):
                settings = [f'{key}={value}' for key, value in env.items()
                            if key in ('PATH', 'DISPLAY') or key.startswith('AGENTBOX_DESKTOP_')]
                command = shlex.join(['env', *settings, f'MOCK_ROOT={case}', 'bash', launcher])
                subprocess.run(tmux + ['new-session', '-d', '-s', 'desktop',
                                       f'exec {command} >{shlex.quote(str(log))} 2>&1'],
                               check=True, timeout=5)
                pid = int(subprocess.check_output(tmux + ['display-message', '-p', '-t',
                                                         'desktop', '#{pane_pid}'], text=True))
                return pid
            try:
                first = tmux_start(case, log)
                until(lambda: not alive(first) or (log.exists() and 'ready on' in log.read_text()))
                assert alive(first), log.read_text()
                subprocess.run(tmux + ['kill-session', '-t', 'desktop'], check=True, timeout=5)
                next_case = root / 'tmux-restarted'
                next_case.mkdir()
                next_log = next_case / 'log'
                second = tmux_start(next_case, next_log)
                time.sleep(0.1)
                assert alive(second) and not (next_case / 'calls').exists()
                until(lambda: not alive(second) or (next_log.exists() and 'ready on' in next_log.read_text()))
                assert alive(second), next_log.read_text()
                until(lambda: not alive(first) and not any(alive(int(pid)) for pid in (case / 'pids').read_text().split()))
                subprocess.run(tmux + ['kill-session', '-t', 'desktop'], check=True, timeout=5)
                until(lambda: not alive(second) and not any(alive(int(pid)) for pid in (next_case / 'pids').read_text().split()))
                assert not (runtime / 'Xauthority').exists()
                print('PASS actual tmux kill-session and immediate same-session restart', flush=True)
            finally:
                subprocess.run(tmux + ['kill-server'], capture_output=True, timeout=5)
                for pid in (locals().get('first'), locals().get('second')):
                    if pid and alive(pid):
                        os.kill(pid, signal.SIGTERM)
                        until(lambda: not alive(pid))
        else:
            print('SKIP tmux lifecycle (tmux not installed)', flush=True)

        for child in ('Xvfb', 'dbus-daemon', 'openbox', 'x11vnc', 'websockify'):
            p, case, log = launch(f'failure-{child}', MOCK_FAIL=child)
            stopped(p, case, log)
        print('PASS partial startup failures', flush=True)

        p, case, log = launch('startup-signal', MOCK_HANG='xdpyinfo')
        until(lambda: (case / 'Xvfb.ready').exists())
        p.terminate()
        stopped(p, case, log)
        print('PASS signal during partial startup', flush=True)

        p, case, log = launch('running-failure')
        ready(p, log)
        (case / 'Xvfb.crash').touch()
        stopped(p, case, log)
        print('PASS running child failure', flush=True)

        p, case, log = launch('readiness-timeout', MOCK_HANG='xdpyinfo')
        stopped(p, case, log, seconds=26)
        assert 'timed out waiting for X' in log.read_text()
        print('PASS bounded readiness (including hung probes)', flush=True)
    finally:
        for p in processes:
            if p.poll() is None:
                p.terminate()
                p.wait(timeout=8)
        # On assertion failure do not leave mock descendants behind.
        for pid_file in root.glob('*/pids'):
            for pid in pid_file.read_text().split():
                if alive(int(pid)):
                    os.kill(int(pid), signal.SIGKILL)
PY
