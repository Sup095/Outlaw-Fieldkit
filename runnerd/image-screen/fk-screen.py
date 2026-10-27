#!/usr/bin/python3 -u
# ============================================================
#  FieldKit RUNNER :: fk-screen — a program with a window, streamed
#
#  Runs INSIDE the sandbox, as the job's own user, so nothing here is
#  trusted more than the program it starts. It:
#
#    1. starts a virtual screen (Xvfb) and a window manager that makes
#       every window fill it,
#    2. starts a virtual sound card (PulseAudio, a null sink), if it can,
#    3. runs the program on them,
#    4. encodes the screen to H.264 and the sound to Opus (ffmpeg),
#    5. and writes everything to stdout as one stream of frames:
#
#         1 byte kind | 4 bytes length, big-endian | payload
#
#       V  one video frame (an H.264 access unit, Annex B), payload
#          starts with a flags byte: 1 = keyframe
#       A  one Opus packet
#       O  the program's stdout      E  the program's stderr
#       S  a JSON status line (screen size, sound on or off)
#
#  Input arrives on stdin as one JSON object per line, from runnerd:
#
#       {"t":"in","d":"text"}         typed text, to the program's stdin
#       {"t":"eof"}                   close the program's stdin
#       {"t":"m","x":10,"y":20}       pointer to a screen position
#       {"t":"b","b":1,"d":1}         mouse button 1-3 down (d 1) / up (d 0)
#       {"t":"w","y":1}               wheel: positive is down
#       {"t":"k","c":"KeyA","d":1}    a key by its physical code (KeyboardEvent.code)
#       {"t":"rate","k":900}          a new video bitrate, kbit/s: a fresh
#                                     encoder, starting with a keyframe
#
#  The exit code is the program's.
# ============================================================
import json, os, signal, stat, struct, subprocess, sys, threading, time

W = int(os.environ.get("FK_W", "1280"))
H = int(os.environ.get("FK_H", "720"))
FPS = int(os.environ.get("FK_FPS", "30"))
KBPS = int(os.environ.get("FK_KBPS", "1500"))
SOUND = os.environ.get("FK_SOUND", "1") == "1"
DISPLAY = ":1"

out = sys.stdout.buffer
out_lock = threading.Lock()
gone = threading.Event()


def clamp(v, lo, hi):
    return max(lo, min(hi, int(v)))


def emit(kind, payload):
    if gone.is_set():
        return
    try:
        with out_lock:
            out.write(kind + struct.pack(">I", len(payload)) + payload)
            out.flush()
    except (BrokenPipeError, OSError):
        gone.set()


def note(text):
    emit(b"E", ("[screen] " + text + "\n").encode())


def quiet(argv, env=None):
    return subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE, env=env)


def wait_for(path, secs, sock=False):
    end = time.time() + secs
    while time.time() < end:
        try:
            if not sock or stat.S_ISSOCK(os.stat(path).st_mode):
                if os.path.exists(path):
                    return True
        except OSError:
            pass
        time.sleep(0.05)
    return False


env = dict(os.environ)
env["DISPLAY"] = DISPLAY
env.setdefault("HOME", "/work")
env["XDG_RUNTIME_DIR"] = "/tmp/xdg"
os.makedirs("/tmp/xdg", mode=0o700, exist_ok=True)
# Software rendering, said out loud so nothing goes looking for a GPU.
env.setdefault("LIBGL_ALWAYS_SOFTWARE", "1")
env.setdefault("SDL_AUDIODRIVER", "pulseaudio")

helpers = []

# ---- 1. the screen ------------------------------------------------
xvfb = quiet(["Xvfb", DISPLAY, "-screen", "0", "%dx%dx24" % (W, H), "-nolisten", "tcp",
              "-noreset", "-dpi", "96", "+extension", "XTEST"])
helpers.append(xvfb)
if not wait_for("/tmp/.X11-unix/X1", 10):
    err = b""
    try:
        xvfb.kill()
        err = xvfb.stderr.read()[-400:]
    except Exception:
        pass
    note("could not start the virtual screen: " + err.decode("utf8", "replace"))
    sys.exit(70)
helpers.append(quiet(["matchbox-window-manager", "-use_titlebar", "no", "-use_cursor", "no"], env))

# ---- 2. the sound card, if it will start ----------------------------
sound = False
if SOUND:
    env["PULSE_SERVER"] = "unix:/tmp/xdg/snd"
    pa = quiet(["pulseaudio", "--daemonize=no", "--exit-idle-time=-1", "--disallow-exit",
                "--disable-shm", "-n",
                "--load=module-null-sink sink_name=fk rate=48000 channels=2",
                "--load=module-native-protocol-unix socket=/tmp/xdg/snd auth-anonymous=1",
                "--load=module-always-sink"], env)
    helpers.append(pa)
    sound = wait_for("/tmp/xdg/snd", 5, sock=True)
    if not sound:
        env.pop("PULSE_SERVER", None)
        note("no sound for this run (the virtual sound card did not start)")

emit(b"S", json.dumps({"w": W, "h": H, "fps": FPS, "sound": sound}).encode())

# ---- 3. the program -----------------------------------------------
argv = sys.argv[1:]
if not argv:
    note("nothing to run")
    sys.exit(64)
try:
    prog = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env, cwd=os.getcwd())
except OSError as e:
    note("could not start the program: " + str(e))
    sys.exit(127)


def pump(src, kind):
    while True:
        b = src.read1(65536) if hasattr(src, "read1") else src.read(4096)
        if not b:
            return
        emit(kind, b)


threading.Thread(target=pump, args=(prog.stdout, b"O"), daemon=True).start()
threading.Thread(target=pump, args=(prog.stderr, b"E"), daemon=True).start()

# ---- 4. the encoders ------------------------------------------------
# Constrained baseline with no B-frames: every Chromebook decodes it in
# hardware, and a frame can be shown the moment it arrives. A keyframe
# every two seconds is how someone who opens the panel mid-run gets a
# picture. A marker (an AUD) starts every frame, which is how frames are
# found in the stream below.
#
# FK_ENC=gpu asks for the graphics card's encoder (NVENC), which takes
# the encoding off the CPU almost entirely. It is tried once, on a
# tiny test picture; if the card is not reachable from in here, the
# CPU encoder is used and the run says so.
GRAB = ["ffmpeg", "-nostdin", "-loglevel", "error",
        "-f", "x11grab", "-draw_mouse", "0", "-framerate", str(FPS), "-video_size", "%dx%d" % (W, H),
        "-i", DISPLAY]
def rate(k):
    return ["-b:v", "%dk" % k, "-maxrate", "%dk" % k, "-bufsize", "%dk" % max(200, k // 2)]
X264 = ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
        "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-threads", "2",
        "-g", str(FPS * 2), "-bf", "0", "-x264-params", "aud=1:repeat-headers=1:scenecut=0"]
NVENC = ["-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ull", "-zerolatency", "1", "-delay", "0",
         "-rc", "cbr", "-profile:v", "baseline",
         "-g", str(FPS * 2), "-bf", "0", "-aud", "1", "-forced-idr", "1"]


def gpu_works():
    try:
        r = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "color=s=256x144:r=30",
                            "-frames:v", "2"] + NVENC + ["-f", "null", "-"],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        return r.returncode == 0
    except Exception:
        return False


ENC = "cpu"
if os.environ.get("FK_ENC") == "gpu":
    if gpu_works():
        ENC = "gpu"
    else:
        note("the graphics card's video encoder is not available, so the CPU is encoding this screen")
def start_venc(k):
    p = subprocess.Popen(GRAB + (NVENC if ENC == "gpu" else X264) + rate(k) + ["-flush_packets", "1", "-f", "h264", "-"],
                         stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    helpers.append(p)
    return p


kbps = KBPS
venc = start_venc(kbps)
venc_lock = threading.Lock()


# runnerd steps the bitrate down while the house upload is busy or
# people are waiting, and back up later. A fresh encoder each time: its
# first frame is a keyframe, so the panel picks up cleanly.
def set_rate(k):
    global venc, kbps
    k = clamp(k, 150, 8000)
    with venc_lock:
        if k == kbps:
            return
        kbps = k
        old, venc = venc, start_venc(k)
    try:
        old.terminate()
    except Exception:
        pass
emit(b"S", json.dumps({"w": W, "h": H, "fps": FPS, "sound": sound, "enc": ENC}).encode())

AUD = b"\x00\x00\x00\x01\x09"


def is_key(au):
    i = 0
    while True:
        i = au.find(b"\x00\x00\x01", i)
        if i < 0 or i + 3 >= len(au):
            return False
        if au[i + 3] & 0x1F == 5:
            return True
        i += 3


def video():
    while True:
        enc = venc
        frames(enc)
        if enc is venc:
            break      # it stopped by itself; the main loop says why
        # replaced by set_rate: read the new one


def frames(enc):
    buf = b""
    while True:
        b = enc.stdout.read1(262144)
        if not b:
            break
        buf += b
        # Everything before the last frame marker is whole frames.
        start = buf.find(AUD)
        while start >= 0:
            nxt = buf.find(AUD, start + len(AUD))
            if nxt < 0:
                break
            au = buf[start:nxt]
            emit(b"V", bytes([1 if is_key(au) else 0]) + au)
            start = nxt
        if start > 0:
            buf = buf[start:]
        if len(buf) > 8 * 1024 * 1024:
            buf = b""
    if buf.startswith(AUD):
        emit(b"V", bytes([1 if is_key(buf) else 0]) + buf)


threading.Thread(target=video, daemon=True).start()


def audio_pages(src):
    """Opus packets out of an Ogg stream, the two header packets skipped."""
    buf = b""
    pending = b""
    seen = 0
    while True:
        b = src.read1(65536)
        if not b:
            return
        buf += b
        while True:
            if len(buf) < 27:
                break
            if buf[:4] != b"OggS":
                j = buf.find(b"OggS", 1)
                buf = buf[j:] if j >= 0 else b""
                continue
            n = buf[26]
            if len(buf) < 27 + n:
                break
            segs = buf[27:27 + n]
            size = sum(segs)
            if len(buf) < 27 + n + size:
                break
            data = buf[27 + n:27 + n + size]
            buf = buf[27 + n + size:]
            p = 0
            for s in segs:
                pending += data[p:p + s]
                p += s
                if s < 255:
                    seen += 1
                    if seen > 2 and pending:
                        emit(b"A", pending)
                    pending = b""


# 40 ms reads and a cheaper Opus setting: measured under gVisor, the
# defaults (10 ms reads, complexity 10) cost about a whole CPU core
# between this and PulseAudio; these cost about a seventh of one.
if sound:
    acmd = ["ffmpeg", "-nostdin", "-loglevel", "error",
            "-f", "pulse", "-fragment_size", "7680", "-i", "fk.monitor",
            "-c:a", "libopus", "-b:a", "64k", "-compression_level", "3",
            "-application", "lowdelay", "-frame_duration", "20",
            "-ar", "48000", "-ac", "2",
            "-page_duration", "20000", "-flush_packets", "1", "-f", "ogg", "-"]
    aenc = subprocess.Popen(acmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, env=env)
    helpers.append(aenc)
    threading.Thread(target=audio_pages, args=(aenc.stdout,), daemon=True).start()

# ---- input ----------------------------------------------------------
# Physical key codes (KeyboardEvent.code) to X key names. Codes, not
# characters, so Shift and the layout work the way games expect.
KEYS = {"Enter": "Return", "Backspace": "BackSpace", "Tab": "Tab", "Escape": "Escape",
        "Space": "space", "ArrowUp": "Up", "ArrowDown": "Down", "ArrowLeft": "Left",
        "ArrowRight": "Right", "ShiftLeft": "Shift_L", "ShiftRight": "Shift_R",
        "ControlLeft": "Control_L", "ControlRight": "Control_R", "AltLeft": "Alt_L",
        "AltRight": "Alt_R", "MetaLeft": "Super_L", "MetaRight": "Super_R",
        "CapsLock": "Caps_Lock", "Delete": "Delete", "Insert": "Insert", "Home": "Home",
        "End": "End", "PageUp": "Prior", "PageDown": "Next", "Minus": "minus",
        "Equal": "equal", "BracketLeft": "bracketleft", "BracketRight": "bracketright",
        "Backslash": "backslash", "Semicolon": "semicolon", "Quote": "apostrophe",
        "Comma": "comma", "Period": "period", "Slash": "slash", "Backquote": "grave",
        "NumpadEnter": "KP_Enter", "NumpadAdd": "KP_Add", "NumpadSubtract": "KP_Subtract",
        "NumpadMultiply": "KP_Multiply", "NumpadDivide": "KP_Divide",
        "NumpadDecimal": "KP_Decimal"}
for ch in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
    KEYS["Key" + ch] = ch.lower()
for d in "0123456789":
    KEYS["Digit" + d] = d
    KEYS["Numpad" + d] = "KP_" + d
for n in range(1, 13):
    KEYS["F%d" % n] = "F%d" % n

xd = None
try:
    from Xlib import X, XK, display as xdisplay
    from Xlib.ext import xtest
    xd = xdisplay.Display(DISPLAY)
except Exception as e:
    note("keyboard and mouse are unavailable: " + str(e))


def act(m):
    t = m.get("t")
    if t == "rate":
        set_rate(m.get("k", KBPS))
        return
    if t == "in":
        prog.stdin.write(str(m.get("d", "")).encode())
        prog.stdin.flush()
        return
    if t == "eof":
        prog.stdin.close()
        return
    if xd is None:
        return
    if t == "m":
        xtest.fake_input(xd, X.MotionNotify, x=clamp(m.get("x", 0), 0, W - 1), y=clamp(m.get("y", 0), 0, H - 1))
    elif t == "b":
        b = clamp(m.get("b", 1), 1, 3)
        xtest.fake_input(xd, X.ButtonPress if m.get("d") else X.ButtonRelease, b)
    elif t == "w":
        b = 5 if m.get("y", 0) > 0 else 4
        xtest.fake_input(xd, X.ButtonPress, b)
        xtest.fake_input(xd, X.ButtonRelease, b)
    elif t == "k":
        name = KEYS.get(str(m.get("c", "")))
        if not name:
            return
        code = xd.keysym_to_keycode(XK.string_to_keysym(name))
        if code:
            xtest.fake_input(xd, X.KeyPress if m.get("d") else X.KeyRelease, code)
    xd.flush()


def inputs():
    for line in sys.stdin.buffer:
        if len(line) > 65536:
            continue
        try:
            m = json.loads(line)
            if isinstance(m, dict):
                act(m)
        except (ValueError, OSError, BrokenPipeError):
            pass
        except Exception:
            pass
    try:
        prog.stdin.close()
    except Exception:
        pass


threading.Thread(target=inputs, daemon=True).start()

# ---- the end ----------------------------------------------------------
def stop(*_):
    try:
        prog.terminate()
    except Exception:
        pass


signal.signal(signal.SIGTERM, stop)

code = None
while code is None:
    code = prog.poll()
    if code is None and venc.poll() is not None:
        note("the screen encoder stopped: " + venc.stderr.read()[-300:].decode("utf8", "replace"))
        stop()
        try:
            code = prog.wait(timeout=3)
        except subprocess.TimeoutExpired:
            prog.kill()
            code = prog.wait()
        break
    time.sleep(0.1)

time.sleep(0.3)  # the last frames and output
for h in helpers:
    try:
        h.terminate()
    except Exception:
        pass
sys.exit(code if code >= 0 else 128 - code)
