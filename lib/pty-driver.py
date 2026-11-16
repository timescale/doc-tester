#!/usr/bin/env python3
# Runs a shell script on a pty and answers the prompts a plan declares (docs/adr/0007).
#
# Shipped to the box by lib/walk-ec2.mjs and run as the default user. Stdlib only on purpose: a bare
# target has the OS and nothing else, and python3 is already there (cloud-init needs it), so the
# harness does not add packages the guide never asked for.
#
# usage: pty-driver.py SCRIPT SPEC.json
#   SPEC: {"answers": [{"prompt": str, "reply": str, "shown": str, "each": bool}], "idle": seconds, "redact": [str]}
#
# Each declared answer is typed once, the first time its prompt text appears, unless it is marked
# `each`: then it is typed every time (timescaledb-tune asks per settings category, and how many need
# changes depends on the box). A prompt that never appears is only reported ("not asked"): apt asks
# "Do you want to continue?" only when an install pulls in extra packages, so whether it is asked
# depends on the box. A prompt that appears
# and is NOT declared is the failure this exists to catch: nothing answers it, the script stalls, and
# the run ends after `idle` seconds of silence with the last output in the reason. Any output resets
# that clock, so a slow download is not mistaken for a hung prompt.
#
# Prints a cleaned transcript tail (no colour codes, progress repaints collapsed, secrets redacted),
# then one line `@@doctest-pty@@ {json}`. Exits with the script's status, or 124 on idle timeout.
import fcntl, json, os, pty, re, select, signal, struct, sys, termios, time

MARK = "@@doctest-pty@@"
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[78]")
# dpkg's status bar, redrawn at the bottom of the screen with save/restore cursor: not output.
STATUS_BAR = re.compile(r"^Progress: \[ *\d+%\]")


def clean(text, redact, keep=80, cap=6000):
    text = ANSI.sub("", text).replace("\r\n", "\n")
    for s in redact:
        if s:
            text = text.replace(s, "***")
    lines = []
    for line in text.split("\n"):
        # A progress bar repaints one line with \r; only the last paint is worth reading.
        parts = [p for p in line.split("\r") if p.strip()]
        line = (parts[-1] if parts else "").rstrip()
        if STATUS_BAR.match(line):
            continue
        if line and (not lines or lines[-1] != line):
            lines.append(line)
    out = "\n".join(lines[-keep:])
    return out[-cap:]


def settle(buf, pending, fd, answered):
    """Type the answer for every declared prompt now visible in buf; return what is left of buf."""
    while True:
        for i, p in enumerate(pending):
            at = buf.find(p["prompt"])
            if at >= 0:
                # `raw` is a key press (Ctrl-D), which is not followed by Enter.
                os.write(fd, (p["reply"] + ("" if p.get("raw") else "\r")).encode())
                answered.append({"prompt": p["prompt"], "reply": p.get("shown", p["reply"])})
                if not p.get("each"):
                    del pending[i]
                buf = buf[at + len(p["prompt"]):]
                break
        else:
            return buf


def exit_code(st):
    return os.WEXITSTATUS(st) if os.WIFEXITED(st) else 128 + os.WTERMSIG(st)


def main():
    script, spec_path = sys.argv[1:3]
    with open(spec_path) as f:
        spec = json.load(f)
    pending, answered = list(spec.get("answers", [])), []
    redact, idle = spec.get("redact", []), float(spec.get("idle", 120))

    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm"
        os.execvp("bash", ["bash", script])
    # Wide and tall enough that psql and friends do not start a pager for a short result.
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 200, 0, 0))

    chunks, buf, status, reason, last = [], "", None, None, time.time()
    while True:
        ready, _, _ = select.select([fd], [], [], 1.0)
        if ready:
            try:
                data = os.read(fd, 4096)
            except OSError:  # EIO: the child closed its end
                data = b""
            if not data:
                break
            last = time.time()
            text = data.decode("utf-8", "replace")
            chunks.append(text)
            buf = settle((buf + ANSI.sub("", text).replace("\r", ""))[-8192:], pending, fd, answered)
        else:
            done, st = os.waitpid(pid, os.WNOHANG)
            if done:  # exited while a background process still holds the pty open
                status = st
                break
            if time.time() - last > idle:
                tail = clean("".join(chunks), redact, keep=3).replace("\n", " | ")
                reason = f"no output for {idle:g}s, so a prompt nothing declared is probably waiting. Last output: {tail}"
                try:
                    os.killpg(pid, signal.SIGTERM)
                    time.sleep(2)
                    os.killpg(pid, signal.SIGKILL)
                except OSError:
                    pass
                break

    if status is None:
        try:
            _, status = os.waitpid(pid, 0)
        except ChildProcessError:
            status = 0
    rc = 124 if reason else exit_code(status)

    print(clean("".join(chunks), redact))
    print(MARK, json.dumps({"exit": rc, "reason": reason, "answered": answered, "not_asked": [p["prompt"] for p in pending if p["prompt"] not in {a["prompt"] for a in answered}]}))
    sys.exit(rc)


if __name__ == "__main__":
    main()
