# RUNNER: the run server (Bastion 2)

Upload a file in FieldKit, it runs here, and what it prints comes back.
The plan is `RUNNER_PLAN.md`; this is how to set it up and what was built.

---

## The parts

| Part | Where | What it does |
|---|---|---|
| **RUNNER panel** | FieldKit and OUTPOST | Checks the file, hashes it, uploads it, shows the output. |
| **Relay** (`relay/runner.js`) | Bastion 1 | Says whether the run server is up, and signs a one-minute ticket saying who you are and what tier. No file ever passes through it. |
| **runnerd** (this folder) | Bastion 2 | Believes the ticket, runs the file in a sandbox, streams the output. |

Three tiers, decided by the relay from the MESSAGES account:

| | Guest (not approved) | Member | Admin |
|---|---|---|---|
| Files | Deleted when the panel closes or the connection drops | Kept | Kept |
| Per file / total | 32 MB / 64 MB | 1 GB / 5 GB | 4 GB / 20 GB |
| Per run | 2 minutes, 512 MB RAM, 1 core | 30 minutes, 2 GB, 2 cores | 2 hours, 4 GB, 2 cores |
| At once | 1 | 2 | 4 |
| GPU | Never | No: the K2200 is too old for gVisor's GPU layer, so windows are encoded on the processor | Same |

A lost connection is noticed within about 20 seconds; a closed panel at once.
The numbers live in `limits.js` and can be changed per tier in the settings file.

---

## What a job is allowed

Everything uploaded is treated as hostile. A job gets:

- **no network at all**
- a **read-only** filesystem, with a small in-memory scratch folder
- **no privileges** and no way to gain any; it runs as "nobody"
- hard limits on memory, CPU, processes, time and output
- **its one file**, read-only, and nothing else from the machine (a
  .zip is unpacked into the box's own scratch folder, inside the box)
- on Bastion 2, **gVisor** as a second wall between it and the real kernel

Tested by running hostile files through it: network and DNS attempts fail, the
filesystem refuses writes, a memory bomb and a fork bomb are contained, an
endless loop is stopped at the time limit, and a flood of output is cut off.

`runnerd` itself holds the Docker socket, so it is as powerful as root on this
machine. That is why it is small, has no dependencies, and never executes
anything a user sent. Jobs get none of that.

---

## Setting it up (once)

### 1. Make the tunnel (Cloudflare website, about 3 minutes)

This gives Bastion 2 its own web address without opening a port on your router.
It is the same thing the relay already uses.

1. Go to **one.dash.cloudflare.com** and open **Networks → Tunnels**.
2. **Create a tunnel** → choose **Cloudflared** → name it `bastion-2` → **Save**.
3. It shows an install command containing a long token starting with `eyJ`.
   **Copy only the token.** You do not run their command.
4. **Next**, then add a **public hostname**:
   - Subdomain: `run`   Domain: `outlawfieldkit.com`
   - Service type: `HTTP`   URL: `runnerd:25580`
5. **Save.**

### 2. Install on Bastion 2 (two commands from your PC)

`node tools/make-deploy.js` writes these, with your values in, to
`deploy/NEXT-STEPS.txt`. They are:

```bash
scp deploy/bastion2.tar.gz YOUR-USER@bastion-2:~/
```

```bash
ssh -t YOUR-USER@bastion-2 "tar xzf bastion2.tar.gz && sudo bash bastion2/runnerd/setup.sh --tunnel-token PASTE-TOKEN"
```

It asks one question (whether to create RUNNER's disk), takes about 15 minutes
the first time, and ends with a block headed **PASTE THIS BACK**.

### 3. Update the relay

Upload the files in `deploy/relay-upload/` and restart it. `config.json` there
already has `runner.enabled` and the run server's addresses: `innerUrl`, how the
relay reaches it over the tailnet (`http://<this machine's tailnet address>:25580`),
which lets panels use RUNNER through the relay's own address, and `publicUrl`,
the tunnel's name, kept as a spare.

---

## Updating later

The same two commands as step 2, without the token. The settings file and
everyone's files are left alone.

## Where things are on Bastion 2

| Path | What |
|---|---|
| `/srv/fieldkit/` | RUNNER's own fixed-size disk |
| `/srv/fieldkit/store/` | Uploaded files |
| `/srv/fieldkit/etc/runnerd.json` | Settings. `config.example.json` explains each one |
| `/srv/fieldkit/etc/tunnel.env` | The tunnel token (readable by root only) |
| `/srv/fieldkit/app/` | The installed copy of this folder |
| `/srv/fieldkit/run/power.json` | What the machine draws, written once a minute by the `fk-power` service |

```bash
sudo docker logs --tail 50 fieldkit-runner-runnerd-1
```

## Looking after it (admins)

In RUNNER, an admin has an **ADMIN** button. It shows the disk, what is running,
everyone's files, the shared library, the bin and the last actions taken.

- **Unused files are deleted after 30 days** (14 when the disk is over 80% full).
  Running a file resets its clock. People see a warning in the last 7 days.
- **Deleted files go to the bin for 48 hours** and can be restored from there.
- **MAKE PERMANENT** moves a file into the shared library: everyone can run it,
  it never expires.
- **WARN, COOLDOWN 1H, SUSPEND 7D** each ask for a reason, which the person is
  shown. A full ban is done in MESSAGES (REPORTS) and reaches RUNNER within 20
  minutes, because every session has to renew its sign-in that often.
- **BLOCK** deletes every copy of a file, on every account, and refuses it if
  anyone uploads the same bytes again.
- Over 90% full, uploads stop for everyone but admins.
- **LOAD AND THE LINE** shows how busy the processor, memory and upload
  are, and who is waiting. Guests get in under 60% load and 50% of the
  upload, members under 85%, admins always; everyone else waits in line
  (members ahead of guests) and gets 60 seconds to press START when it is
  their turn. MOVE TO FRONT, REMOVE, and the thresholds are all here.
- **POWER** shows what the processor and graphics card draw now, the day's
  average with an estimate for the rest of the PC, and what a month costs at
  that. Set your price per kWh there. The readings come from `fk-power`, a
  small root service setup.sh installs (`sudo systemctl status fk-power`); it
  only reads, and may write nowhere but `/srv/fieldkit/run`.

Every one of these is written to `/srv/fieldkit/store/audit.json`.

## What members get (phase 5)

- **Programs keep running** after RUNNER is closed, up to their time limit.
  Opening RUNNER again, on any device, re-attaches with the recent output. A
  program that finished while nobody was watching leaves its result, shown once,
  for 24 hours. Guests' programs still stop the moment they leave.
- **A saved folder**, `/save` inside every run, kept between runs (1 GB for
  members, 4 GB for admins). It is listed, downloaded and emptied from the panel.
  It lives in `/srv/fieldkit/store/save/<name>` and is deleted after 30 days
  without a run.
- **Windows programs keep their saves.** A member's .exe (loose or in a .zip)
  keeps its Windows user folder (Documents, Saved Games, AppData) and its user
  registry in `/save/Windows/<program>`, one folder per program, so a game's
  saves and settings are there next time. The registry is written back when the
  program ends normally; a program that is killed keeps its files but not
  registry changes from that run.
- **The web, filtered.** Each member's job gets a private network whose only
  other member is the `fk-egress` container. That proxy looks every name up
  through CleanBrowsing, refuses this house's and the tailnet's addresses, opens
  only web ports, and holds each job to 1 Mbit/s up and 8 Mbit/s down. Programs
  find it through `HTTPS_PROXY`; anything that ignores that has no internet.
  Guests stay offline.

The filter and the speeds are in `/srv/fieldkit/etc/egress.env`:

```bash
sudo nano /srv/fieldkit/etc/egress.env
```

```bash
cd /srv/fieldkit/app && sudo docker compose -f runnerd/compose.yml up -d egress
```

## Programs with a window (phase 6)

**RUN IN WINDOW** (members and admins) runs the file on a virtual screen
and streams it into the panel: the picture as H.264, the sound as Opus,
and the mouse and keyboard back. Python with tkinter or pygame-style
windows, Linux programs, and Windows programs through Wine all work;
OpenGL and Vulkan are drawn in software (Mesa), enough for 2D games and
Godot's Compatibility renderer.

- It is the same sandbox as every other job, gVisor included. The
  screen, sound card and encoder run *inside* it, next to the program
  (`image-screen/fk-screen.py`), so nothing new runs outside it.
- Two screens at once on the whole machine (`machine.maxScreens`).
- 1280×720, 30 frames a second, about 1.5 Mbit/s per viewer
  (`screen` in runnerd.json). The server never passes on more than
  twice that, whatever the box writes.
- **Cost:** about one CPU core per screen when the CPU encodes, about a
  fifth of one when the graphics card does (measured on Bastion 2).
- **The graphics card** encodes members' screens when setup.sh found
  that it works from inside gVisor (`"gpu": { "runtime": "runsc-gpu" }`,
  a second gVisor runtime with its NVIDIA layer switched on). Nothing
  ever gets the card outside gVisor. ADMIN → **NO GPU** takes it away
  from one person; **GPU BACK** returns it.
- Windows programs take about 15–20 seconds to show their window:
  Wine starts slowly inside gVisor.

## What programs are using

While anything runs, runnerd reads each box's CPU and memory every 10
seconds (`docker stats`). ADMIN → RUNNING NOW lists programs busiest
first with those figures, and each person sees their own program's in
its row.

## The library's cards

In ADMIN → SHARED LIBRARY, **CARD** gives a title its name, a line about
it, the arguments PLAY uses, the program inside a .zip to start, and
whether it opens in a window. Members then see one **PLAY** (or **START**)
button that does all of that, and how many people are playing it now.
An empty card clears it.

## Programs that are a folder (.zip)

Zip the folder and upload the .zip. On RUN the panel lists the files
inside that can start (.exe, .py, .js, .sh) and asks which, or just
runs it if there is only one. Each run unpacks the zip **inside the
box** into its own /work, then starts the chosen file from its own
folder. A zip that would unpack to more than 85% of the box's /work is
stopped before anything is written (guests: about 54 MB; members:
about 435 MB). The server only ever reads the zip's index (`zip.js`).

The Windows image needs Python for this: rerun setup.sh once after
updating.

## Not built yet

Games drawn on the graphics card (needs a Turing-or-newer card for
gVisor) and the shared game library with saves per game: phases 6b
and the rest of 7. (The relay's browser uses this server's thresholds, read from
its health check, and its upload counts here.)
