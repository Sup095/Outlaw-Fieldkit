/* ============================================================
   FieldKit runnerd :: sandbox — the box an uploaded file runs in

   EVERYTHING THAT RUNS HERE IS TREATED AS HOSTILE. Not because
   the people are, but because "run this file I was sent" is
   exactly the sentence malware depends on, and the machine it
   would land on is somebody's home server.

   So a job gets, and this list is the security model:

     no network                   (--network none), or for a member
                                  a private network made for this
                                  one job, whose only other member
                                  is the filtering proxy (egress.js)
     a read-only filesystem       (--read-only), with a small
                                  in-memory /work and /tmp
     no capabilities              (--cap-drop ALL)
     no way to gain any           (no-new-privileges)
     an unprivileged user         (65534, "nobody")
     hard ceilings                on memory, CPU and process count
     its one file, read-only      mounted at /job
     a member's saved folder      mounted at /save, size-watched
                                  by server.js while the job runs
     nothing else from the host   no socket, no devices, and no GPU
                                  except a member's screen, below

   A job with a screen is the same box with a different image: a
   virtual display, sound card and encoder run INSIDE it next to the
   program (image-screen/fk-screen.py), and what comes out of it is
   one stream of frames, split up again here. It is as untrusted as
   the program, because the program could write to it.

   A member's screen is encoded on the graphics card when the server
   has a GPU runtime (cfg.gpu.runtime, "runsc-gpu" from setup.sh):
   gVisor still, with its nvproxy layer checking every call to the
   driver, and only the video and utility parts of the driver. The
   card is NEVER handed to a job through a runtime that is not gVisor
   unless the config says gpu.unsandboxed, which nothing here sets.

   On Bastion 2 the runtime is gVisor (runsc), which puts a second
   kernel between the job and the real one. That is configuration,
   not code: the same flags run under the ordinary runtime on a
   development machine, which is how this is tested.

   There is a second driver, "process", that runs the file as a
   plain child process with NONE of the above. It exists so the
   test suite can run without Docker. server.js refuses to start
   with it unless it is explicitly asked for AND only listening on
   loopback.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ARG_MAX = 16, ARG_LEN = 200;

/* What to execute for a file, decided from its first bytes and its
   extension. Returns { argv, image } or throws with a sentence a
   person can read. `at` is where the file sits inside the box. */
function plan(name, kind, args, at, screen) {
  if (screen) {
    const p = plan(name, kind, args, at, false);
    return { argv: ["fk-screen"].concat(p.argv), image: "screen", screen: true };
  }
  const ext = (String(name).match(/\.([A-Za-z0-9]+)$/) || [, ""])[1].toLowerCase();
  const file = at + "/" + name;
  const extra = cleanArgs(args);

  if (kind === "pe" || ext === "exe") return { argv: ["wine-run", file].concat(extra), image: "wine" };
  if (kind === "elf") return { argv: [file].concat(extra), image: "base" };
  if (ext === "py") return { argv: ["python3", "-u", file].concat(extra), image: "base" };
  if (ext === "js" || ext === "mjs" || ext === "cjs") return { argv: ["node", file].concat(extra), image: "base" };
  if (ext === "sh" || ext === "bash") return { argv: ["bash", file].concat(extra), image: "base" };
  if (kind === "script") return { argv: [file].concat(extra), image: "base" };

  throw new Error("RUNNER does not know how to run a ." + (ext || "(no extension)") +
    " file. It runs Python (.py), JavaScript (.js), shell scripts (.sh), Linux programs, " +
    "and Windows programs (.exe).");
}

function cleanArgs(args) {
  if (!Array.isArray(args)) return [];
  if (args.length > ARG_MAX) throw new Error("too many arguments (" + ARG_MAX + " at most)");
  return args.map((a) => {
    const s = String(a);
    if (s.length > ARG_LEN) throw new Error("an argument is too long");
    return s;
  });
}

/* The runtime a job that gets the graphics card runs under, or null.
   Only a gVisor one, unless the config explicitly says otherwise. */
function gpuRuntime(cfg) {
  const g = cfg.gpu || {};
  const r = String(g.runtime || "");
  if (!r) return null;
  return /runsc/.test(r) || g.unsandboxed === true ? r : null;
}

/* ---- a screen's stream ------------------------------------------- */
/* fk-screen writes  kind (1 byte) | length (4, big-endian) | payload.
   Split back up and handed to on.out / on.video / on.audio / on.status.
   A frame bigger than any real one means the stream is garbage (or a
   program is writing into it), and the rest of it is dropped. */
const FRAME_MAX = 4 * 1024 * 1024;
const K = { O: 0x4f, E: 0x45, V: 0x56, A: 0x41, S: 0x53 };

function demux(on) {
  let buf = Buffer.alloc(0), broken = false;
  return (chunk) => {
    if (broken) return;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 5) {
      const len = buf.readUInt32BE(1);
      if (len > FRAME_MAX) {
        broken = true;
        on.out("stderr", Buffer.from("[RUNNER: the screen's stream stopped making sense, so the picture has stopped]\n"));
        return;
      }
      if (buf.length < 5 + len) break;
      const k = buf[0], body = buf.subarray(5, 5 + len);
      buf = buf.subarray(5 + len);
      if (k === K.O) on.out("stdout", body);
      else if (k === K.E) on.out("stderr", body);
      else if (k === K.V && body.length > 1) { if (on.video) on.video(body.subarray(1), (body[0] & 1) === 1); }
      else if (k === K.A && body.length) { if (on.audio) on.audio(body); }
      else if (k === K.S && on.status) {
        let st = null;
        try { st = JSON.parse(body.toString("utf8")); } catch (e) {}
        if (st && typeof st === "object") on.status(st);
      }
    }
  };
}

/* ---- docker ------------------------------------------------------ */
const EGRESS = { enabled: true, container: "fk-egress", proxy: "http://egress:3128" };
/* 720p at 30 frames a second in about 1.5 Mbit/s: the house's upload
   is ~20 Mbit/s and shared, so a screen has to be modest. */
const SCREEN = { width: 1280, height: 720, fps: 30, kbps: 1500, sound: true };

class DockerDriver {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log || (() => {});
    this.name = "docker";
    /* dockerBin may be [program, ...args] — the tests put a stand-in
       for docker there, so the screen path is tested without Docker. */
    const b = Array.isArray(cfg.dockerBin) ? cfg.dockerBin : [cfg.dockerBin || "docker"];
    this.bin = b[0];
    this.pre = b.slice(1);
    this.sp = (args, o) => spawn(this.bin, this.pre.concat(args), o);
    this.sps = (args, o) => spawnSync(this.bin, this.pre.concat(args), o);
    this.egress = Object.assign({}, EGRESS, cfg.egress || {});
  }

  /* One docker command, as a promise of null (worked) or why not.
     With out, what it printed lands in out.text. */
  _do(args, out) {
    return new Promise((resolve) => {
      const p = this.sp(args, { stdio: ["ignore", "pipe", "pipe"] });
      let err = "", text = "";
      p.stdout.on("data", (d) => { text += d; });
      p.stderr.on("data", (d) => { err += d; });
      p.on("error", (e) => resolve(e.message));
      p.on("close", (c) => {
        if (out) out.text = text;
        resolve(c === 0 ? null : (err.trim().slice(0, 200) || "exit " + c));
      });
    });
  }

  /* The job's own network: internal (no route out), and the egress
     container joined to it under the name the proxy settings use.
     One per job rather than one shared, so two people's programs can
     never reach each other. */
  async _netUp(job) {
    const e1 = await this._do(["network", "create", "--internal",
      "--label", "fk.runner=1", "--label", "fk.job=" + job.id, job.net]);
    if (e1) return e1;
    const e2 = await this._do(["network", "connect", "--alias", "egress", job.net, this.egress.container]);
    if (e2) { await this._do(["network", "rm", job.net]); return e2; }
    /* The proxy's address on this network, handed to the job as a
       number. Under gVisor the job cannot ask Docker's name server
       (it lives on a loopback address gVisor's own network stack
       never routes to the host), so "egress" would not resolve. */
    const got = {};
    const e3 = await this._do(["inspect", "--format", "{{json .NetworkSettings.Networks}}", this.egress.container], got);
    let ip = null;
    try { ip = JSON.parse(got.text)[job.net].IPAddress || null; } catch (e) {}
    if (e3 || !ip || !/^[\d.]+$/.test(ip)) {
      await this._do(["network", "disconnect", "-f", job.net, this.egress.container]);
      await this._do(["network", "rm", job.net]);
      return e3 || "could not find the proxy's address on the job's network";
    }
    job.proxyIp = ip;
    return null;
  }

  _netDown(name) {
    this._do(["network", "disconnect", "-f", name, this.egress.container])
      .then(() => this._do(["network", "rm", name]));
  }

  /* Is the thing there, and are the images? Said at boot, where it
     is a two-minute fix, instead of on somebody's first run. */
  check() {
    const v = this.sps(["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
    if (v.status !== 0) return { ok: false, why: "docker did not answer: " + String(v.stderr || v.error || "").trim().slice(0, 200) };
    const out = { ok: true, version: v.stdout.trim(), images: {} };
    Object.keys(this.cfg.images || {}).forEach((k) => {
      const img = this.cfg.images[k];
      if (!img) { out.images[k] = null; return; }
      const r = this.sps(["image", "inspect", "--format", "{{.Id}}", img], { encoding: "utf8" });
      out.images[k] = r.status === 0;
    });
    const g = gpuRuntime(this.cfg);
    if (this.cfg.runtime || g) {
      const r = this.sps(["info", "--format", "{{json .Runtimes}}"], { encoding: "utf8" });
      const has = (name) => r.status === 0 && r.stdout.indexOf('"' + name + '"') >= 0;
      if (this.cfg.runtime) out.runtime = has(this.cfg.runtime);
      out.gpu = !!g && has(g);
    }
    if (this.egress.enabled) {
      const r = this.sps(["inspect", "--format", "{{.State.Running}}", this.egress.container], { encoding: "utf8" });
      out.egress = r.status === 0 && r.stdout.trim() === "true";
    }
    return out;
  }

  /* Containers left behind by a runnerd that was killed. They are
     labelled, so this cannot touch anything that is not ours. */
  sweep() {
    const r = this.sps(["ps", "-aq", "--filter", "label=fk.runner=1"], { encoding: "utf8" });
    const ids = String(r.stdout || "").split(/\s+/).filter(Boolean);
    if (ids.length) this.sps(["rm", "-f"].concat(ids));
    /* And their networks, which hold an address range each. */
    const nr = this.sps(["network", "ls", "-q", "--filter", "label=fk.runner=1"], { encoding: "utf8" });
    String(nr.stdout || "").split(/\s+/).filter(Boolean).forEach((net) => {
      this.sps(["network", "disconnect", "-f", net, this.egress.container]);
      this.sps(["network", "rm", net]);
    });
    return ids.length;
  }

  /* Where the store is as the DOCKER DAEMON sees it. runnerd itself
     runs in a container; a path it knows as /srv/fieldkit/store is
     only meaningful to the daemon if the host calls it that too, or
     if this says what the host calls it. */
  hostPath(p) {
    const inside = this.cfg.storePath, outside = this.cfg.storeHostPath;
    if (!outside || outside === inside) return p;
    const rel = path.relative(inside, p);
    const sep = outside.indexOf("/") < 0 && outside.indexOf(String.fromCharCode(92)) >= 0
      ? String.fromCharCode(92) : "/";
    return outside.replace(/[\/]+$/, "") + sep + rel.split(path.sep).join(sep);
  }

  args(job) {
    const L = job.limits, cname = "fk-" + job.id;
    const image = (this.cfg.images || {})[job.plan.image];
    if (!image) {
      throw new Error(job.plan.image === "wine"
        ? "Windows programs are not switched on for this server yet"
        : job.plan.image === "screen" ? "programs with a window are not switched on for this server yet"
          : "this server has no image to run that in");
    }
    const a = ["run", "--rm", "-i", "--name", cname,
      "--label", "fk.runner=1", "--label", "fk.job=" + job.id,
      "--network", job.net || "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--user", "65534:65534",
      "--pids-limit", String(L.pids),
      "--memory", L.memoryMb + "m", "--memory-swap", L.memoryMb + "m",
      "--cpus", String(L.cpus),
      "--ipc", "none",
      "--hostname", "sandbox",
      "--log-driver", "none",
      "--stop-timeout", "2",
      "--tmpfs", "/work:rw,exec,nosuid,nodev,size=" + L.workMb + "m,uid=65534,gid=65534,mode=0700",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=" + (job.plan.screen ? 64 : 16) + "m,mode=1777",
      "--workdir", "/work",
      "--env", "HOME=/work", "--env", "TMPDIR=/tmp", "--env", "PYTHONDONTWRITEBYTECODE=1",
      "--mount", "type=bind,source=" + this.hostPath(job.dir) + ",target=/job,readonly"];
    if (job.save) {
      a.push("--mount", "type=bind,source=" + this.hostPath(job.save) + ",target=/save", "--env", "SAVE=/save");
    }
    if (job.net) {
      /* Both spellings: curl reads the lower-case ones, most else
         the upper. Nothing else is set, so nothing bypasses it. By
         address once it is known (see _netUp), and "egress" in the
         job's hosts file for anything that wants a name. */
      let proxy = this.egress.proxy;
      if (job.proxyIp) {
        const u = new URL(this.egress.proxy);
        proxy = u.protocol + "//" + job.proxyIp + ":" + (u.port || "3128");
        a.push("--add-host", "egress:" + job.proxyIp);
      }
      ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].forEach((k) => a.push("--env", k + "=" + proxy));
    }
    if (job.plan.screen) {
      /* The screen's size, speed and sound, read by fk-screen. */
      const sc = Object.assign({}, SCREEN, this.cfg.screen || {});
      a.push("--env", "FK_W=" + (sc.width | 0), "--env", "FK_H=" + (sc.height | 0), "--env", "FK_FPS=" + (sc.fps | 0),
        "--env", "FK_KBPS=" + ((job.kbps || sc.kbps) | 0), "--env", "FK_SOUND=" + (sc.sound ? 1 : 0));
    }
    if (job.gpu) {
      const g = gpuRuntime(this.cfg);
      if (!g) throw new Error("this server has no sandboxed runtime for the graphics card");
      a.push("--runtime", g, "--gpus", "all", "--env", "NVIDIA_DRIVER_CAPABILITIES=video,utility", "--env", "FK_ENC=gpu");
    } else if (this.cfg.runtime) a.push("--runtime", this.cfg.runtime);
    return { cname: cname, argv: a.concat([image], job.plan.argv) };
  }

  /* job.wantNet asks for the filtered internet. Everything that can
     be refused (no image for this kind of file) is refused here,
     synchronously, before anything is made; the network is then made
     in the background and the container started on it. If the
     network cannot be made the job still runs, offline, and says so. */
  start(job, on) {
    job.net = job.wantNet && this.egress.enabled ? "fk-j-" + job.id : null;
    let built = this.args(job);
    let proc = null, killed = false, done = false, inputEnded = false, madeNet = null;
    const queued = [];
    const finish = (code, why) => {
      if (done) return;
      done = true;
      if (madeNet) this._netDown(madeNet);
      on.exit(code, why);
    };

    const launch = () => {
      if (killed) return finish(null, null);
      proc = this.sp(built.argv, { stdio: ["pipe", "pipe", "pipe"] });
      const fromBox = job.plan.screen ? demux(on) : (b) => on.out("stdout", b);
      proc.stdout.on("data", fromBox);
      proc.stderr.on("data", (b) => on.out("stderr", b));
      proc.stdin.on("error", () => {});
      proc.on("error", (e) => finish(null, "could not start docker: " + e.message));
      proc.on("close", (code) => finish(code, null));
      queued.forEach((d) => { try { proc.stdin.write(d); } catch (e) {} });
      if (inputEnded) { try { proc.stdin.end(); } catch (e) {} }
    };

    if (!job.net) launch();
    else {
      this._netUp(job).then((why) => {
        if (why) {
          this.log("WARN", "runnerd: no network for job " + job.id + " — " + why);
          on.out("stderr", Buffer.from("[RUNNER: the internet is not available for this run, so it is running offline]\n"));
          job.net = null;
          built = this.args(job);
        } else madeNet = job.net;
        /* Again, now that the proxy's address on the network is known. */
        built = this.args(job);
        launch();
      });
    }

    return {
      write: (d) => { if (proc) { try { proc.stdin.write(d); } catch (e) {} } else queued.push(d); },
      endInput: () => { inputEnded = true; if (proc) { try { proc.stdin.end(); } catch (e) {} } },
      /* Its processor use now, in % of one (docker stats; ~2 s, and
         it works under gVisor). null if it cannot be told. */
      cpu: () => {
        if (!proc || killed || done) return Promise.resolve(null);
        const got = {};
        return this._do(["stats", "--no-stream", "--format", "{{.CPUPerc}}", built.cname], got).then((why) => {
          const n = parseFloat(String(got.text || "").trim());
          return why || !isFinite(n) ? null : n;
        });
      },
      /* Killing the CLI only detaches from the container. The
         container is what has to die, and it is asked by name. */
      kill: () => {
        killed = true;
        if (!proc) return;
        const k = this.sp(["kill", built.cname], { stdio: "ignore" });
        k.on("error", () => {});
        k.on("close", () => { try { proc.kill(); } catch (e) {} });
      }
    };
  }
}

/* ---- process: NO ISOLATION, tests only --------------------------- */
class ProcessDriver {
  constructor(cfg, log) { this.cfg = cfg; this.log = log || (() => {}); this.name = "process"; }
  check() { return { ok: true, version: "none — plain child processes, NOT a sandbox", images: {} }; }
  sweep() { return 0; }

  start(job, on) {
    if (job.plan.screen) throw new Error("programs with a window need the docker driver");
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "fk-job-"));
    /* The plan was written for the box, where the file is at /job.
       Here it is wherever the store put it. */
    const argv = job.plan.argv.map((a) => a.indexOf("/job/") === 0 ? path.join(job.dir, a.slice(5)) : a);
    if (argv[0] === "node") argv[0] = process.execPath;
    const env = { PATH: process.env.PATH, HOME: work, TMPDIR: work, SystemRoot: process.env.SystemRoot };
    if (job.save) env.SAVE = job.save;
    const proc = spawn(argv[0], argv.slice(1), { cwd: work, stdio: ["pipe", "pipe", "pipe"], env: env });
    let done = false;
    const finish = (code, why) => {
      if (done) return;
      done = true;
      try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) {}
      on.exit(code, why);
    };
    proc.stdout.on("data", (b) => on.out("stdout", b));
    proc.stderr.on("data", (b) => on.out("stderr", b));
    proc.stdin.on("error", () => {});
    proc.on("error", (e) => finish(null, "could not start: " + e.message));
    proc.on("close", (code) => finish(code, null));
    return {
      write: (d) => { try { proc.stdin.write(d); } catch (e) {} },
      endInput: () => { try { proc.stdin.end(); } catch (e) {} },
      kill: () => { try { proc.kill("SIGKILL"); } catch (e) {} }
    };
  }
}

function make(cfg, log) {
  return cfg.driver === "process" ? new ProcessDriver(cfg, log) : new DockerDriver(cfg, log);
}

module.exports = { make, plan, cleanArgs, demux, gpuRuntime, DockerDriver, ProcessDriver, ARG_MAX, ARG_LEN, EGRESS, SCREEN };
