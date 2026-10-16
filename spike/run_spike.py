"""Milestone-0 spike: re-simulate one .sdfz with spring-headless + the BRV spike widget.

Usage:  python spike/run_spike.py <demo.sdfz> [workdir]

Everything the engine writes goes to <workdir>; the BAR install is only read.
"""
import os, re, shutil, subprocess, sys, time

sys.path.insert(0, os.path.dirname(__file__))
from demo_header import read_header, last_frame  # noqa: E402

BAR_DATA = r"D:\Dmitrii\Beyond-All-Reason\data"
DATA_DIRS = os.environ.get("SPIKE_DATADIRS", BAR_DATA)  # ";"-separated SPRING_DATADIR override
HERE = os.path.dirname(os.path.abspath(__file__))
ASCII_HOME = r"C:\Users\Public"


def is_ascii(s):
    return all(ord(c) < 128 for c in s)


def main():
    demo = os.path.abspath(sys.argv[1])
    work = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else os.path.join(HERE, "..", "simwork", "spike")
    work = os.path.normpath(work)
    if not is_ascii(work):
        sys.exit(f"write dir must be an ASCII-only path (engine limitation): {work}")

    h = read_header(demo)
    engine_dir = os.path.join(BAR_DATA, "engine", "recoil_" + h["engine"])
    exe = os.path.join(engine_dir, "spring-headless.exe")
    if not os.path.isfile(exe):
        sys.exit(f"missing {exe}")

    # isolated write dir with our widget pre-enabled
    os.makedirs(os.path.join(work, "LuaUI", "Widgets"), exist_ok=True)
    os.makedirs(os.path.join(work, "LuaUI", "Config"), exist_ok=True)
    widget_src = os.environ.get("SPIKE_WIDGET", os.path.join(HERE, "widget", "brv_spike.lua"))
    shutil.copy(widget_src, os.path.join(work, "LuaUI", "Widgets", "brv_spike.lua"))
    with open(os.path.join(work, "LuaUI", "Config", "BYAR.lua"), "w") as f:
        f.write('return { allowUserWidgets = true, order = { ["BRV Spike"] = 1 }, data = {} }\n')
    cfg = os.path.join(work, "springsettings.cfg")
    open(cfg, "a").close()
    local_demo = os.path.join(work, "demo.sdfz")  # copy: the demo path must be ASCII as well
    shutil.copy(demo, local_demo)

    env = dict(os.environ)
    # The engine crashes (std::filesystem "Illegal byte sequence") when these contain non-ASCII chars.
    for k in ("USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA"):
        env[k] = ASCII_HOME
    env["HOMEPATH"] = r"\Users\Public"
    env["SPRING_DATADIR"] = DATA_DIRS

    cmd = [exe, "--write-dir", work, "--config", cfg, "--only-local", "--nocolor", local_demo]
    print(" ".join(cmd))
    total = last_frame(demo, h)
    t0 = time.time()
    p = subprocess.Popen(cmd, cwd=work, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, encoding="utf-8", errors="replace")
    with open(os.path.join(work, "stdout.txt"), "w", encoding="utf-8") as log:
        for line in p.stdout:
            log.write(line)
            m = re.search(r"\[f=(\d+)\] \[BRV\] (.*)", line)
            if m:
                print(f"{time.time()-t0:6.1f}s frame {int(m.group(1)):>6}/{total} {m.group(2)}")
            elif "Error" in line or "[BRV]" in line:
                print(f"{time.time()-t0:6.1f}s {line.rstrip()}")
    print(f"exit={p.wait()} elapsed={time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
