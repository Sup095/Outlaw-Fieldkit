/* ============================================================
   FieldKit runnerd :: admin — punishments, the audit log, blocked
   files, and the commands only an admin may send.

   WHO IS AN ADMIN is not decided here. The relay decides it, signs
   it into the ticket, and this file only ever checks `tier`. There
   is no second admin list to fall out of step with MESSAGES.

   RUNNER-ONLY PUNISHMENTS live here (RUNNER_PLAN.md §8). A
   messaging ban is the relay's and needs nothing from this file:
   the relay stops issuing tickets, and a session has to renew its
   ticket every ten minutes, so a ban reaches an open session within
   twenty.

     warn       a message the person sees the next time they connect
     cooldown   no new runs until a time
     suspend    no RUNNER at all until a time
     nogpu      no graphics card, until an admin gives it back ("gpu")
     clear      lifts both, keeps the record

   Every action, by anyone, is written to the audit log with who did
   it, to whom, and why.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const zip = require("./zip");

const AUDIT_KEEP = 1000;
const SHA_RE = /^[a-f0-9]{64}$/;
const HANDLE_RE = /^[a-z0-9._-]{3,24}$/;

class Admin {
  constructor(root) {
    this.files = { people: path.join(root, "people.json"), audit: path.join(root, "audit.json"),
      deny: path.join(root, "deny.json") };
  }

  _read(k, empty) {
    try { return JSON.parse(fs.readFileSync(this.files[k], "utf8")); } catch (e) { return empty; }
  }
  _write(k, v) {
    const tmp = this.files[k] + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(v), "utf8");
    fs.renameSync(tmp, this.files[k]);
  }

  /* ---- the record ---- */
  audit(by, action, target, detail) {
    const a = this._read("audit", { version: 1, entries: [] });
    a.entries.push({ at: new Date().toISOString(), by: by, action: action, target: target || null,
      detail: detail ? String(detail).slice(0, 300) : null });
    if (a.entries.length > AUDIT_KEEP) a.entries = a.entries.slice(-AUDIT_KEEP);
    this._write("audit", a);
  }
  recent(n) { return this._read("audit", { entries: [] }).entries.slice(-(n || 50)).reverse(); }

  /* ---- punishments ---- */
  _people() { return this._read("people", { version: 1, handles: {} }); }

  /* What applies to this person right now. Expired punishments read
     as nothing; they stay on file for the record. */
  state(handle, now) {
    now = now || Date.now();
    const p = this._people().handles[handle] || {};
    const live = (x) => (x && x.until && x.until > now ? x : null);
    return { suspended: live(p.suspended), cooldown: live(p.cooldown), noGpu: p.noGpu || null,
      warnings: (p.warnings || []).filter((w) => !w.seenAt) };
  }

  /* Marks the warnings as delivered, so each is shown once. */
  seen(handle) {
    const all = this._people();
    const p = all.handles[handle];
    if (!p || !p.warnings || !p.warnings.some((w) => !w.seenAt)) return;
    const at = new Date().toISOString();
    p.warnings.forEach((w) => { if (!w.seenAt) w.seenAt = at; });
    this._write("people", all);
  }

  punish(by, handle, action, opts) {
    opts = opts || {};
    if (!HANDLE_RE.test(String(handle || ""))) throw new Error("no such handle");
    if (handle === by) throw new Error("you cannot punish yourself");
    const reason = String(opts.reason || "").trim().slice(0, 300);
    if (action !== "clear" && action !== "gpu" && !reason) throw new Error("say why. The person is shown the reason.");

    const all = this._people();
    const p = all.handles[handle] = all.handles[handle] || {};
    const stamp = { by: by, at: new Date().toISOString(), reason: reason };
    if (action === "warn") {
      (p.warnings = p.warnings || []).push(stamp);
    } else if (action === "cooldown") {
      const min = Math.max(1, Math.min(7 * 24 * 60, Number(opts.minutes) || 60));
      p.cooldown = Object.assign({ until: Date.now() + min * 60000 }, stamp);
    } else if (action === "suspend") {
      const days = Math.max(1, Math.min(3650, Number(opts.days) || 7));
      p.suspended = Object.assign({ until: Date.now() + days * 86400000 }, stamp);
    } else if (action === "clear") {
      p.cooldown = null;
      p.suspended = null;
    } else if (action === "nogpu") {
      p.noGpu = stamp;
    } else if (action === "gpu") {
      p.noGpu = null;
    } else throw new Error("no such punishment: " + action);
    this._write("people", all);
    this.audit(by, action, handle, reason || null);
    return this.state(handle);
  }

  /* ---- blocked files ---- */
  denied(sha) { return this._read("deny", { hashes: {} }).hashes[sha] || null; }
  denyList() {
    const h = this._read("deny", { hashes: {} }).hashes;
    return Object.keys(h).map((k) => Object.assign({ sha256: k }, h[k]));
  }
  deny(by, sha, reason, name) {
    if (!SHA_RE.test(String(sha || ""))) throw new Error("that is not a file hash");
    const d = this._read("deny", { version: 1, hashes: {} });
    d.hashes[sha] = { by: by, at: new Date().toISOString(), reason: String(reason || "").slice(0, 300),
      name: name ? String(name).slice(0, 100) : null };
    this._write("deny", d);
    this.audit(by, "block-file", name || sha.slice(0, 12), reason);
  }
  undeny(by, sha) {
    const d = this._read("deny", { version: 1, hashes: {} });
    if (!d.hashes[sha]) return false;
    delete d.hashes[sha];
    this._write("deny", d);
    this.audit(by, "unblock-file", sha.slice(0, 12), null);
    return true;
  }
}

/* ---- what an admin's panel sees ---------------------------------- */
function overview(ctx) {
  const { store, admin, jobs, sessions } = ctx;
  const disk = store.disk();
  const users = store.handles().map((h) => {
    const files = store.list({ kind: "user", handle: h });
    const st = admin.state(h);
    return { handle: h, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0),
      suspended: st.suspended, cooldown: st.cooldown, noGpu: st.noGpu,
      online: Array.from(sessions.values()).some((x) => x.handle === h) };
  });
  return {
    disk: disk, ttlDays: Math.round(ctx.ttlMs() / 86400000), pressure: ctx.pressure(),
    sessions: Array.from(sessions.values()).map((x) => ({ handle: x.handle, tier: x.tier, since: x.since })),
    jobs: Array.from(jobs.values()).map((j) => ({ id: j.id, handle: j.handle, tier: j.tier, name: j.name,
      startedAt: j.startedAt, library: !!j.library, watched: j.watchers ? j.watchers.size > 0 : true,
      internet: !!j.wantNet, screen: !!j.screen, gpu: !!j.gpu,
      cpu: j.use ? j.use.cpu : null, memMb: j.use ? j.use.memMb : null, memLimitMb: j.limits ? j.limits.memoryMb : null,
      outKb: Math.round((j.bytes || 0) / 1024) })),
    users: users,
    library: store.library(),
    trash: store.trash().slice(0, 50).map((x) => ({ id: x.entry.id, name: x.entry.name, size: x.entry.size,
      from: x.from, reason: x.reason, by: x.by, deletedAt: x.deletedAt })),
    blocked: admin.denyList(),
    power: ctx.power ? ctx.power.view() : null,
    sleep: ctx.sleep ? ctx.sleep.view(ctx.helperSec ? ctx.helperSec() : null) : null,
    access: ctx.access ? ctx.access.view(ctx.runningOf) : null,
    audit: admin.recent(40)
  };
}

/* ---- what an admin may do ----------------------------------------
   Called only for a session whose ticket said "admin". Returns a
   short sentence for the panel, or throws one. */
function command(ctx, s, m) {
  const { store, admin } = ctx;
  const by = s.handle;
  const h = String(m.handle || "").toLowerCase();
  const user = (handle) => ({ kind: "user", handle: handle });

  switch (m.t) {
    case "adm-user":
      return { files: store.list(user(h)).map((f) => ctx.decorate(f)) };

    case "adm-rm": {
      const e = store.discard(h, m.file, "deleted by an admin", by);
      if (!e) throw new Error("no such file");
      admin.audit(by, "delete-file", h, e.name);
      return { done: "deleted " + e.name + " (it can be restored for " + ctx.tombHours() + " hours)" };
    }
    case "adm-pin": {
      const e = store.pin(h, m.file, by);
      if (!e) throw new Error("no such file");
      admin.audit(by, "make-permanent", h, e.name);
      return { done: e.name + " is now in the shared library" };
    }
    case "adm-unpin": {
      const r = store.unpin(m.file);
      if (!r) throw new Error("no such library file");
      admin.audit(by, "unpin", r.handle, r.file.name);
      return { done: r.file.name + " went back to " + r.handle + " with a fresh 30-day clock" };
    }
    /* A library title's card: its name and a line about it, the
       arguments and the file inside a zip that PLAY uses, and whether
       it opens in a window. Every field is checked here, because
       everyone who opens RUNNER is shown it and PLAY sends it back. */
    case "adm-lib-set": {
      const e = store.find(user(by), m.file);
      if (!e || !e.library) throw new Error("no such library file");
      const line = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
      const card = { title: line(m.title, 60), about: line(m.about, 200), args: line(m.args, 200), window: !!m.window };
      if (m.entry) {
        const en = zip.cleanEntry(m.entry);
        if (!en) throw new Error("that is not a file name inside a zip");
        if (store.sniff(user(by), m.file) !== "zip") throw new Error(e.name + " is not a zip, so there is no file inside to choose");
        if (zip.runnable(zip.list(store.pathOf(user(by), m.file)).entries).indexOf(en) < 0) {
          throw new Error(en + " is not a program inside " + e.name);
        }
        card.entry = en;
      }
      const empty = !card.title && !card.about && !card.args && !card.window && !card.entry;
      store.libSet(m.file, empty ? null : card);
      admin.audit(by, "library-card", null, e.name);
      return { done: empty ? "the card for " + e.name + " was cleared" : e.name + " now shows as " + (card.title || e.name) };
    }
    case "adm-lib-rm": {
      const e = store.libRemove(m.file, by);
      if (!e) throw new Error("no such library file");
      admin.audit(by, "delete-library-file", null, e.name);
      return { done: "removed " + e.name + " from the library" };
    }
    case "adm-restore": {
      const r = store.restore(m.file);
      if (!r) throw new Error("that file is no longer in the bin");
      admin.audit(by, "restore", r.to, r.file.name);
      return { done: "restored " + r.file.name + " to " + r.to };
    }
    /* The line (RUNNER_PLAN.md §22). */
    case "adm-line-up": {
      const e = ctx.access.bump(String(m.id));
      if (!e) throw new Error("that place in the line has gone");
      admin.audit(by, "line-move-up", e.handle, e.kind);
      ctx.tickAccess(false);
      return { done: "moved " + (e.tier === "guest" ? "a guest" : e.handle) + " to the front" };
    }
    case "adm-line-rm": {
      const e = ctx.access.leave(String(m.id));
      if (!e) throw new Error("that place in the line has gone");
      admin.audit(by, "line-remove", e.handle, m.reason || null);
      ctx.tellWho(e.who, { t: "line-gone", id: e.id, why: "an admin took you out of the line" + (m.reason ? ": " + String(m.reason).slice(0, 200) : "") });
      ctx.tickAccess(false);
      return { done: "removed " + (e.tier === "guest" ? "a guest" : e.handle) + " from the line" };
    }
    case "adm-access": {
      const st = ctx.access.set({ guest: m.guest, member: m.member, uploadMbps: m.uploadMbps });
      admin.audit(by, "access-settings", null, "guests " + st.guest.load + "%/" + st.guest.upload + "% up, members " +
        st.member.load + "%/" + st.member.upload + "% up, upload " + st.uploadMbps + " Mbit/s");
      ctx.tickAccess(false);
      return { done: "saved: guests in under " + st.guest.load + "% load and " + st.guest.upload + "% of the upload, members under " +
        st.member.load + "% and " + st.member.upload + "%, upload " + st.uploadMbps + " Mbit/s" };
    }
    case "adm-power": {
      const st = ctx.power.set({ pricePerKwh: m.price, otherWatts: m.other, currency: m.currency });
      admin.audit(by, "power-settings", null, st.currency + st.pricePerKwh + "/kWh, rest of the PC " + st.otherWatts + " W");
      return { done: "saved: " + st.currency + st.pricePerKwh + " per kWh, " + st.otherWatts + " W for the rest of the PC" };
    }
    case "adm-sleep": {
      const st = ctx.sleep.set({ enabled: m.enabled, idleMinutes: m.idleMinutes, quietFrom: m.quietFrom,
        quietTo: m.quietTo, tz: m.tz });
      const q = st.quietFrom == null ? "no quiet hours" : "quiet " + st.quietFrom + ":00-" + st.quietTo + ":00 " + st.tz;
      admin.audit(by, "sleep-settings", null, (st.enabled ? "sleeps after " + st.idleMinutes + " idle min" : "never sleeps") + ", " + q);
      ctx.sleepTick();
      return { done: st.enabled ? "saved: Bastion 2 sleeps after " + st.idleMinutes + " idle minutes, " + q
        : "saved: Bastion 2 stays awake" };
    }
    case "adm-sleep-now": {
      ctx.sleep.sleepNow(by);
      admin.audit(by, "sleep-now", null, null);
      ctx.sleepTick();
      return { done: "Bastion 2 goes to sleep in about a minute, once nothing is running. Opening RUNNER wakes it." };
    }
    case "adm-sleep-cancel": {
      ctx.sleep.cancel();
      ctx.sleepTick();
      return { done: "it stays awake" };
    }
    case "adm-kill": {
      const j = ctx.jobs.get(String(m.job));
      if (!j) throw new Error("that job has already ended");
      j.stop("stopped by an admin");
      admin.audit(by, "kill-job", j.handle, j.name);
      return { done: "stopped " + j.name };
    }
    case "adm-kick": {
      const n = ctx.kick(h, "an admin disconnected you");
      admin.audit(by, "disconnect", h, null);
      return { done: "disconnected " + n + " session(s)" };
    }
    case "adm-punish": {
      const st = admin.punish(by, h, String(m.action), { minutes: m.minutes, days: m.days, reason: m.reason });
      if (m.action === "suspend") ctx.kick(h, "suspended from RUNNER: " + st.suspended.reason);
      if (m.action === "cooldown") {
        for (const j of ctx.jobs.values()) if (j.handle === h) j.stop("an admin put you on a cooldown");
      }
      if (m.action === "nogpu") {
        for (const j of ctx.jobs.values()) if (j.handle === h && j.gpu) j.stop("an admin turned off your use of the graphics card");
      }
      return { done: m.action === "clear" ? "lifted for " + h : m.action === "gpu" ? "graphics card given back to " + h
        : m.action + " recorded for " + h };
    }
    case "adm-purge": {
      if (h === by) throw new Error("delete your own files from your own list");
      const n = store.purgeUser(h, by);
      /* The saved folder has no bin: it is the program's scratch, not
         something anyone uploaded. */
      if (ctx.saves) ctx.saves.drop(h);
      admin.audit(by, "purge-files", h, n + " file(s) and the saved folder");
      return { done: "moved " + n + " of " + h + "'s files to the bin" };
    }
    case "adm-block": {
      /* By file, so the admin never has to handle a hash. */
      const e = h ? store.get(user(h), m.file) : store.find(user("library"), m.file);
      const sha = e ? e.sha256 : String(m.sha256 || "");
      admin.deny(by, sha, m.reason, e ? e.name : null);
      for (const j of ctx.jobs.values()) if (j.sha256 === sha) j.stop("that file was blocked by an admin");
      const n = store.dropHash(sha);
      return { done: "blocked" + (e ? " " + e.name : "") + ": removed " + n + " cop" + (n === 1 ? "y" : "ies") +
        ", and it can never be uploaded again" };
    }
    case "adm-unblock":
      if (!admin.undeny(by, String(m.sha256 || ""))) throw new Error("that hash is not blocked");
      return { done: "unblocked" };
    case "adm-sweep": {
      const r = ctx.sweep();
      admin.audit(by, "sweep-now", null, r.expired.length + " expired, " + r.purged + " purged");
      return { done: r.expired.length + " file(s) expired, " + r.purged + " removed from the bin for good" };
    }
    default:
      throw new Error("no such admin command");
  }
}

module.exports = { Admin, overview, command, SHA_RE };
