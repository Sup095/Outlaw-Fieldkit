/* ============================================================
   FieldKit :: git-console
   Git for a two-person Godot project, from a machine that has no
   terminal.

   WHY THIS EXISTS AND WHAT IT DELIBERATELY IS NOT

   FieldKit cannot run Git. A file:// page has no process, no
   filesystem write access, and no network beyond fetch-to-relay.
   Nothing here executes anything. Pretending otherwise would be
   the worst possible design: a Git tool that silently does not
   run is how repositories get lost.

   What it is instead is three things that are genuinely useful
   from the school Chromebook:

     1. A reference that explains Git in terms of THIS project,
        so the answer to "what do I type" does not require a
        working memory or a second device.
     2. A generator for the two files nobody gets right by hand —
        .gitignore and .gitattributes for Godot + Blender + LFS.
        Getting these wrong is what causes the 400 MB repo and the
        merge conflict in a binary file.
     3. A recipe builder: pick what you are trying to do, get the
        exact command sequence, copy it, run it on a machine that
        has a terminal.

   The repo settings it stores (remote URL, branch names, who
   works on what) live in the vault, because a private repo URL
   is a small secret and the note beside it usually is not.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "gitrepo";
  var ctx, ui, el, nodes = {}, repos = [], editingId = null, tab = "learn";

  /* ---- the .gitignore ------------------------------------------
     Godot 4 + Blender. Every line here is a mistake someone has
     made: committing .godot/ (regenerated, huge, conflicts every
     pull), committing export presets with credentials in them,
     committing Blender's autosave siblings.

     Kept as data rather than a blob of text so the UI can explain
     each group — an ignore file you do not understand is one you
     will fight later. */
  var IGNORE_GROUPS = [
    { title: "Godot engine artefacts", why:
        "Godot regenerates all of this from your source files. It is large, it changes on " +
        "every open, and it conflicts constantly. Committing it is the single most common " +
        "way a Godot repo becomes unusable for a second person.",
      lines: [".godot/", "/android/", "*.translation"] },
    { title: "Import metadata", why:
        "Godot writes a .import file beside every asset, containing a machine-local path and " +
        "a UID. Godot 4 wants the .godot/imported cache ignored but the .import files KEPT — " +
        "they carry your import settings, and losing them means every texture re-imports with " +
        "defaults. This is the one that surprises people, so it is listed as a keep, not an ignore.",
      lines: ["# KEEP *.import — do not ignore them (see note)"] },
    { title: "Export output", why:
        "Builds are derived. They are also huge, and export_presets.cfg can contain signing " +
        "credentials and store keys.",
      lines: ["export_presets.cfg", "/build/", "/builds/", "/exports/", "*.pck", "*.apk", "*.aab", "*.exe", "*.dmg"] },
    { title: "Blender working files", why:
        "Blender writes numbered backups on every save. They are as large as the .blend itself " +
        "and there is no reason for a second person to have them.",
      lines: ["*.blend1", "*.blend2", "*.blend3", "*.blend@", "/blender_autosave/"] },
    { title: "OS and editor noise", why:
        "Nobody needs your file manager's thumbnail database.",
      lines: [".DS_Store", "Thumbs.db", "desktop.ini", "*.swp", "*~", ".vscode/", ".idea/"] },
    { title: "Secrets", why:
        "Belt and braces. Secrets belong in FieldKit's CONFIG VAULT, not in a repo — but an " +
        "ignore rule costs nothing and has saved a lot of people.",
      lines: [".env", ".env.*", "*.key", "*.pem", "secrets.json", "credentials.json"] }
  ];

  /* ---- .gitattributes / LFS ------------------------------------
     The other half of the answer to "can we store game files".
     Git handles text well and binaries badly: it stores a whole
     new copy of a .blend on every commit, forever, and the repo
     grows without bound. LFS replaces the file content with a
     small pointer and stores the bytes elsewhere.

     Also sets Godot text formats to LF, because a mixed-line-
     ending .tscn diffs as "every line changed". */
  var LFS_PATTERNS = [
    { group: "3D and Blender", pats: ["*.blend", "*.blend1", "*.fbx", "*.glb", "*.gltf", "*.obj", "*.dae", "*.stl", "*.usd", "*.usdz"] },
    { group: "Textures", pats: ["*.png", "*.jpg", "*.jpeg", "*.tga", "*.psd", "*.exr", "*.hdr", "*.tiff", "*.ktx2", "*.dds"] },
    { group: "Audio", pats: ["*.wav", "*.ogg", "*.mp3", "*.flac", "*.aiff"] },
    { group: "Video", pats: ["*.mp4", "*.webm", "*.mov"] },
    { group: "Fonts and archives", pats: ["*.ttf", "*.otf", "*.woff2", "*.zip", "*.7z"] }
  ];

  var TEXT_PATTERNS = ["*.gd", "*.tscn", "*.tres", "*.godot", "*.cfg", "*.import", "*.gdshader", "*.md", "*.json"];

  function buildIgnore() {
    var out = ["# .gitignore — Godot 4 + Blender",
               "# Generated by FieldKit. Every line here is a mistake someone has already made.",
               ""];
    IGNORE_GROUPS.forEach(function (g) {
      out.push("# " + g.title);
      g.lines.forEach(function (l) { out.push(l); });
      out.push("");
    });
    return out.join("\n");
  }

  function buildAttributes() {
    var out = ["# .gitattributes — Godot 4 + Blender",
               "# Generated by FieldKit.",
               "#",
               "# Two jobs. First: hand every large binary to Git LFS, so the repo stores a",
               "# pointer instead of a fresh copy of your .blend on every single commit.",
               "# Second: force LF on Godot's text formats, so a .tscn edited on Windows and",
               "# on Linux does not diff as 'every line changed'.",
               "#",
               "# LFS must be installed and initialised BEFORE these files are first committed.",
               "# Adding LFS after the fact does not retroactively shrink history — see the",
               "# 'we already committed a big file' recipe.",
               ""];
    LFS_PATTERNS.forEach(function (g) {
      out.push("# " + g.group);
      g.pats.forEach(function (p) {
        out.push(p + " filter=lfs diff=lfs merge=lfs -text");
      });
      out.push("");
    });
    out.push("# Text formats: normalise line endings, keep them diffable");
    TEXT_PATTERNS.forEach(function (p) { out.push(p + " text eol=lf"); });
    out.push("");
    out.push("# Binary Godot resources should never be merged by line");
    out.push("*.res binary");
    out.push("*.pck binary");
    return out.join("\n");
  }

  /* ---- the teaching layer --------------------------------------
     Written for someone who has not used Git, in terms of the
     project they are actually working on. Concepts first, because
     a command list without the model behind it produces exactly
     the cargo-culting that ends in a lost afternoon. */
  var LESSONS = [
    { title: "What Git actually is",
      body:
        "Git is a machine that remembers every version of a folder, and can tell you what " +
        "changed between any two of them.\n\n" +
        "The folder is the repository. Every time you commit, Git stores a complete snapshot " +
        "of the folder as it was at that moment, plus a message saying why. It never " +
        "overwrites an old snapshot — that is the whole point. Anything committed can be got " +
        "back, which is what makes it safe to delete things and try ideas.\n\n" +
        "For two people, the second job matters more than the first: Git can take your " +
        "snapshots and your friend's snapshots and combine them, even if you both worked " +
        "at the same time on different files. That combining is the thing FieldKit's vault " +
        "cannot do, and it is why the game source belongs in Git." },

    { title: "The four places a file can be",
      body:
        "This is the model. Almost every confusing Git error is really a question about " +
        "which of these four a file is in.\n\n" +
        "1. WORKING TREE — the files as they are on disk right now. What Godot and Blender " +
        "see. Editing a file changes only this.\n\n" +
        "2. STAGING AREA (the 'index') — a list of changes you have marked as belonging in " +
        "the next snapshot. `git add` moves a change here. This exists so you can commit " +
        "three of the five things you changed.\n\n" +
        "3. LOCAL HISTORY — the snapshots on your machine. `git commit` takes what is staged " +
        "and makes a snapshot. Still entirely local; your friend cannot see it yet.\n\n" +
        "4. THE REMOTE — the copy on GitHub (or wherever). `git push` sends your snapshots " +
        "there; `git pull` brings theirs down.\n\n" +
        "The most common beginner surprise: committing does not share anything. You have to " +
        "push. And pushing does not update your friend's folder — they have to pull." },

    { title: "Branches, and why you want one",
      body:
        "A branch is a movable label pointing at a snapshot. `main` is just the label everyone " +
        "agrees is the real version.\n\n" +
        "When you make a branch, you get your own line of snapshots that does not disturb " +
        "`main`. You can break things freely. When it works, you merge it back.\n\n" +
        "For two people on a game this matters because of a specific failure: you are both " +
        "editing the same scene, both commit to `main`, and now Git has to merge two versions " +
        "of a .tscn. It can often do it — .tscn is text — but not always, and a badly merged " +
        "scene can be worse than a lost one because it opens and looks almost right.\n\n" +
        "The habit that avoids nearly all of it: one branch per thing you are working on, and " +
        "talk to each other before two people open the same scene." },

    { title: "Why binaries are the hard part",
      body:
        "Git is built for text. It stores changes efficiently because it can see that one line " +
        "of a 2000-line script changed.\n\n" +
        "A .blend file is binary. Git cannot see inside it, so every commit stores a complete " +
        "new copy. Save a 90 MB .blend twenty times and the repository contains 1.8 GB, " +
        "forever, and every person who clones it downloads all of it.\n\n" +
        "It is also unmergeable. If you and your friend both edit the same .blend, Git can " +
        "only offer 'keep yours or keep theirs'. There is no combining.\n\n" +
        "Two answers, and you want both:\n" +
        "  • GIT LFS stores the bytes outside the repository and commits a small pointer. " +
        "History stays navigable and clones stay small. Use the .gitattributes this module " +
        "generates.\n" +
        "  • DO NOT EDIT THE SAME BINARY AT THE SAME TIME. This is a talking-to-each-other " +
        "problem, and no tool solves it. Decide who owns which .blend." },

    { title: "Where FieldKit's vault fits",
      body:
        "The vault and Git are not competing. They hold different things, and the split is " +
        "about who should see them.\n\n" +
        "GIT holds the project: scenes, scripts, models, textures, audio. Everything a second " +
        "person needs to open the game and build it. It is versioned, diffable, mergeable, " +
        "and — eventually — probably public or at least shared.\n\n" +
        "THE VAULT holds what should not be in a repo: server credentials, the relay URL, API " +
        "keys, private design notes, incident history, decisions you have not announced yet, " +
        "and reference material too large or too awkward for Git. It is encrypted end to end " +
        "and it does not have a history you can walk.\n\n" +
        "The test: if losing it would hurt, Git. If SHOWING it would hurt, the vault. " +
        "Things that are both go in Git, in a private repo, with the secrets pulled out " +
        "into the vault and referenced by name." },

    { title: "The five commands that cover most days",
      body:
        "git status        — what has changed, and which of the four places it is in. " +
        "Run it constantly. It is the answer to almost every 'what is happening' moment.\n\n" +
        "git pull          — get your friend's work before you start. Do this FIRST, every " +
        "session. Most painful merges come from a day of work on top of a stale copy.\n\n" +
        "git add -A        — stage everything you changed.\n\n" +
        "git commit -m \"…\" — snapshot it, with a message saying why rather than what. " +
        "'fixed the jump' is useful; 'updated player.gd' is not, because Git can already " +
        "see which file changed.\n\n" +
        "git push          — send it up so your friend can get it.\n\n" +
        "That is a whole workflow. Everything else is recovery, and recovery is what the " +
        "RECIPES tab is for." }
  ];

  /* ---- recipes ------------------------------------------------
     Task first, commands second, and a plain-English warning
     wherever the command is destructive. Anything that can lose
     work is marked, because a copyable command list is exactly
     the sort of thing that gets pasted without reading. */
  var RECIPES = [
    { id: "first-repo", title: "Start a repo for the game (with LFS, from day one)",
      danger: false,
      note: "Do this once, on the machine that has the project. LFS must be set up BEFORE the " +
            "first commit of any binary, or the big files land in history permanently.",
      steps: [
        "cd path/to/your/godot/project",
        "git init",
        "git lfs install",
        "# put FieldKit's .gitignore and .gitattributes in the project root first",
        "git add .gitattributes .gitignore",
        "git commit -m \"Set up ignore rules and LFS tracking\"",
        "git add -A",
        "git commit -m \"Initial import of the project\"",
        "git branch -M main",
        "git remote add origin <YOUR-REPO-URL>",
        "git push -u origin main"
      ] },

    { id: "second-person", title: "Get the project onto the second person's machine",
      danger: false,
      note: "They need Git and Git LFS installed first. Without LFS, the big files arrive as " +
            "small text pointer files and Godot will not open them — that symptom confuses " +
            "everyone the first time.",
      steps: [
        "git lfs install",
        "git clone <YOUR-REPO-URL>",
        "cd <repo-folder>",
        "git lfs pull"
      ] },

    { id: "daily", title: "A normal working session",
      danger: false,
      note: "The pull at the start is the important part.",
      steps: [
        "git pull",
        "# ...work in Godot / Blender...",
        "git status",
        "git add -A",
        "git commit -m \"why you changed it, not what you changed\"",
        "git push"
      ] },

    { id: "branch", title: "Work on a feature without breaking main",
      danger: false,
      note: "",
      steps: [
        "git pull",
        "git switch -c feature/enemy-ai",
        "# ...work, commit as often as you like...",
        "git push -u origin feature/enemy-ai",
        "# when it works:",
        "git switch main",
        "git pull",
        "git merge feature/enemy-ai",
        "git push",
        "git branch -d feature/enemy-ai"
      ] },

    { id: "conflict", title: "A pull said CONFLICT",
      danger: false,
      note: "Not an error. Git is telling you it could not decide, and is asking. Nothing is " +
            "lost at this point. For a .tscn, open the file and look for the <<<<<<< markers.",
      steps: [
        "git status                       # lists exactly which files need a decision",
        "# open each one, remove the <<<<<<< ======= >>>>>>> markers, keep what you want",
        "git add <the-file>",
        "git commit                       # finishes the merge",
        "# or, to abandon the whole pull and go back to before it:",
        "git merge --abort"
      ] },

    { id: "binary-conflict", title: "A conflict in a .blend or a texture",
      danger: false,
      note: "Binaries cannot be merged. You must pick one version. Save the other one " +
            "somewhere first if there is any doubt — FieldKit's VAULT FILES is a good " +
            "place to park it while you decide.",
      steps: [
        "git checkout --ours  path/to/model.blend    # keep the version you had",
        "git checkout --theirs path/to/model.blend   # keep the version you pulled",
        "git add path/to/model.blend",
        "git commit"
      ] },

    { id: "undo-uncommitted", title: "Undo changes I have not committed",
      danger: true,
      note: "DESTRUCTIVE. This throws away your edits with no way back — they were never " +
            "committed, so Git has no copy. Be certain.",
      steps: [
        "git restore path/to/file          # one file",
        "git restore .                     # everything, and it means everything"
      ] },

    { id: "undo-commit", title: "Undo the last commit but keep the work",
      danger: false,
      note: "Safe. The changes come back to your working tree as if you had not committed. " +
            "Do not do this to a commit you have already pushed and your friend has pulled.",
      steps: [
        "git reset --soft HEAD~1"
      ] },

    { id: "big-file", title: "We already committed a huge file and the repo is enormous",
      danger: true,
      note: "This rewrites history. Everyone else must re-clone afterwards — their existing " +
            "copies become incompatible. Coordinate before running it, and take a full copy " +
            "of the folder first. If the repo is young, deleting it and starting again with " +
            "LFS set up properly is genuinely easier and safer.",
      steps: [
        "# 1. Take a backup copy of the whole folder. Actually do this.",
        "git lfs install",
        "git lfs migrate import --include=\"*.blend,*.png,*.wav,*.fbx\" --everything",
        "git push --force",
        "# 2. Everyone else: delete their copy and clone fresh."
      ] },

    { id: "who-changed", title: "Find out who changed something and when",
      danger: false,
      note: "",
      steps: [
        "git log --oneline -- path/to/file",
        "git log -p -- path/to/file        # with the actual changes",
        "git blame path/to/file            # line by line, who last touched it"
      ] },

    { id: "recover", title: "I think I lost work",
      danger: false,
      note: "Almost nothing committed is ever really gone. reflog is the list of every " +
            "position HEAD has been in, including ones no branch points at any more.",
      steps: [
        "git reflog                        # find the commit you want, note its hash",
        "git switch -c rescue <that-hash>  # bring it back on a new branch"
      ] }
  ];

  /* ---- repo notes (stored in the vault) ------------------------- */
  async function load() {
    repos = await ctx.store.list(TYPE);
    if (tab === "repos") renderRepos();
  }

  async function saveRepo() {
    var name = nodes.rName.value.trim();
    if (!name) { ui.toast("NAME REQUIRED", "warn"); return; }
    await ctx.store.put(TYPE, {
      name: name,
      url: nodes.rUrl.value.trim(),
      branch: nodes.rBranch.value.trim() || "main",
      lfs: nodes.rLfs.checked,
      owners: nodes.rOwners.value,
      note: nodes.rNote.value
    }, { id: editingId || undefined });
    ui.toast(editingId ? "REPO UPDATED" : "REPO SAVED", "ok");
    clearRepoForm();
    await load();
  }

  function clearRepoForm() {
    editingId = null;
    ["rName", "rUrl", "rOwners", "rNote"].forEach(function (k) { if (nodes[k]) nodes[k].value = ""; });
    if (nodes.rBranch) nodes.rBranch.value = "main";
    if (nodes.rLfs) nodes.rLfs.checked = true;
    if (nodes.rSave) nodes.rSave.textContent = "SAVE REPO";
    renderRepos();
  }

  function editRepo(id) {
    var r = repos.find(function (x) { return x.id === id; });
    if (!r) return;
    editingId = id;
    nodes.rName.value = r.data.name || "";
    nodes.rUrl.value = r.data.url || "";
    nodes.rBranch.value = r.data.branch || "main";
    nodes.rLfs.checked = r.data.lfs !== false;
    nodes.rOwners.value = r.data.owners || "";
    nodes.rNote.value = r.data.note || "";
    nodes.rSave.textContent = "UPDATE REPO";
    renderRepos();
  }

  async function removeRepo() {
    if (!editingId) return;
    if (!confirm("Delete this repo note? The repository itself is untouched.")) return;
    await ctx.store.remove(editingId);
    clearRepoForm();
    await load();
    ui.toast("REPO NOTE DELETED", "warn");
  }

  function renderRepos() {
    if (!nodes.repoList) return;
    ui.clear(nodes.repoList);
    if (!repos.length) {
      nodes.repoList.appendChild(el("div", { class: "gc-empty",
        text: "NO REPOSITORIES RECORDED. Add one so the URL and the branch rules are somewhere " +
              "you can reach from a machine with no terminal." }));
      return;
    }
    repos.forEach(function (r) {
      var d = r.data;
      nodes.repoList.appendChild(el("div", { class: "gc-repo" }, [
        el("div", { class: "gc-repo-head" }, [
          el("strong", { text: d.name }),
          el("span", { class: "gc-tag", text: d.branch || "main" }),
          d.lfs !== false ? el("span", { class: "gc-tag lfs", text: "LFS" }) : el("span")
        ]),
        d.url ? el("div", { class: "gc-repo-url", text: d.url }) : el("span"),
        d.owners ? el("div", { class: "gc-repo-meta", text: "OWNERSHIP: " + d.owners }) : el("span"),
        d.note ? el("div", { class: "gc-repo-note", text: d.note }) : el("span"),
        el("div", { class: "gc-row" }, [
          ui.button("EDIT", function () { editRepo(r.id); }),
          d.url ? ui.button("COPY CLONE COMMAND", function () {
            ui.copy("git lfs install && git clone " + d.url, { title: "CLONE" })
              .then(function (how) { if (how) ui.toast("COPIED", "ok"); });
          }) : el("span")
        ])
      ]));
    });
  }

  /* ---- rendering the tabs --------------------------------------- */
  function showTab(t) {
    tab = t;
    ["learn", "files", "recipes", "repos"].forEach(function (k) {
      if (nodes["tab_" + k]) nodes["tab_" + k].classList.toggle("on", k === t);
      if (nodes["pane_" + k]) nodes["pane_" + k].style.display = k === t ? "block" : "none";
    });
    if (t === "repos") renderRepos();
  }

  function renderLearn() {
    var pane = nodes.pane_learn;
    ui.clear(pane);
    pane.appendChild(el("div", { class: "gc-lead", text:
      "FieldKit cannot run Git — a file:// page has no processes and no filesystem. " +
      "Nothing on this screen executes. It explains, and it generates text you copy to a " +
      "machine that does have a terminal." }));
    LESSONS.forEach(function (l) {
      pane.appendChild(el("details", { class: "gc-lesson" }, [
        el("summary", { text: l.title }),
        el("div", { class: "gc-lesson-body", text: l.body })
      ]));
    });
  }

  function renderFiles() {
    var pane = nodes.pane_files;
    ui.clear(pane);

    pane.appendChild(el("div", { class: "gc-lead", text:
      "These two files decide whether the repository stays usable. Put both in the project " +
      "root — the folder containing project.godot — and commit them before anything else." }));

    var ig = buildIgnore();
    var at = buildAttributes();

    pane.appendChild(ui.panel(".gitignore", [
      el("div", { class: "gc-why", text:
        "What Git should not track at all. The critical one is .godot/ — it is regenerated, " +
        "it is large, and it conflicts on every single pull." }),
      el("div", { class: "gc-row" }, [
        ui.button("COPY .gitignore", function () {
          ui.copy(ig, { title: ".gitignore" }).then(function (h) { if (h) ui.toast("COPIED", "ok"); });
        }, { primary: true }),
        ui.button("DOWNLOAD", function () { ui.download(ig, "gitignore.txt"); }),
        ui.button("SHOW", function () { ui.textDump(ig, { title: ".gitignore" }); })
      ]),
      el("div", { class: "gc-groups" }, IGNORE_GROUPS.map(function (g) {
        return el("details", { class: "gc-group" }, [
          el("summary", { text: g.title }),
          el("div", { class: "gc-why", text: g.why }),
          el("pre", { class: "gc-pre", text: g.lines.join("\n") })
        ]);
      }))
    ]));

    pane.appendChild(ui.panel(".gitattributes  (Git LFS)", [
      el("div", { class: "gc-why", text:
        "Hands every large binary to Git LFS, so the repo stores a pointer instead of a fresh " +
        "copy of your .blend on every commit. Must be committed BEFORE the binaries are, or " +
        "they are in history permanently — see the recipe for fixing that, and note that it " +
        "rewrites history for everyone." }),
      el("div", { class: "gc-row" }, [
        ui.button("COPY .gitattributes", function () {
          ui.copy(at, { title: ".gitattributes" }).then(function (h) { if (h) ui.toast("COPIED", "ok"); });
        }, { primary: true }),
        ui.button("DOWNLOAD", function () { ui.download(at, "gitattributes.txt"); }),
        ui.button("SHOW", function () { ui.textDump(at, { title: ".gitattributes" }); })
      ]),
      el("div", { class: "gc-why", text:
        "Note the download comes out as gitignore.txt / gitattributes.txt — browsers will not " +
        "save a file whose name starts with a dot. Rename them after saving." })
    ]));
  }

  function renderRecipes() {
    var pane = nodes.pane_recipes;
    ui.clear(pane);
    pane.appendChild(el("div", { class: "gc-lead", text:
      "Pick what you are trying to do. Copy the block, run it in a terminal on the machine " +
      "that has the project. Anything marked DESTRUCTIVE can lose work — read the note." }));

    RECIPES.forEach(function (r) {
      var body = r.steps.join("\n");
      pane.appendChild(el("details", { class: "gc-recipe" + (r.danger ? " danger" : "") }, [
        el("summary", {}, [
          el("span", { text: r.title }),
          r.danger ? el("span", { class: "gc-tag danger", text: "DESTRUCTIVE" }) : el("span")
        ]),
        r.note ? el("div", { class: "gc-why" + (r.danger ? " danger" : ""), text: r.note }) : el("span"),
        el("pre", { class: "gc-pre", text: body }),
        el("div", { class: "gc-row" }, [
          ui.button("COPY", function () {
            ui.copy(body, { title: r.title }).then(function (h) { if (h) ui.toast("COPIED", "ok"); });
          })
        ])
      ]));
    });
  }

  function injectCSS() {
    if (document.getElementById("gc-style")) return;
    var s = document.createElement("style");
    s.id = "gc-style";
    s.textContent = [
      ".gc-wrap{display:flex;flex-direction:column;height:100%;gap:8px}",
      ".gc-tabs{display:flex;gap:4px;flex-wrap:wrap;flex:0 0 auto}",
      ".gc-tab{background:none;border:1px solid var(--fk-line);color:inherit;font:inherit;font-size:11px;letter-spacing:.06em;padding:4px 10px;cursor:pointer}",
      ".gc-tab.on{border-color:var(--fk-accent);color:var(--fk-accent)}",
      ".gc-panes{flex:1 1 auto;overflow:auto;padding-right:4px}",
      ".gc-lead{font-size:12px;line-height:1.6;opacity:.8;border-left:3px solid var(--fk-accent);padding:6px 10px;margin-bottom:10px}",
      ".gc-lesson,.gc-recipe,.gc-group{border:1px solid var(--fk-line);margin-bottom:6px;padding:6px 10px}",
      ".gc-lesson summary,.gc-recipe summary,.gc-group summary{cursor:pointer;font-weight:600;letter-spacing:.04em;display:flex;gap:8px;align-items:center}",
      ".gc-recipe.danger{border-color:var(--fk-warn)}",
      ".gc-lesson-body{font-size:12.5px;line-height:1.65;white-space:pre-wrap;margin-top:8px;opacity:.92}",
      ".gc-why{font-size:11.5px;line-height:1.55;opacity:.72;margin:6px 0}",
      ".gc-why.danger{opacity:1;color:var(--fk-warn)}",
      ".gc-pre{font-family:inherit;font-size:11.5px;line-height:1.5;background:rgba(255,255,255,0.04);padding:8px;overflow-x:auto;white-space:pre;margin:6px 0}",
      ".gc-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}",
      ".gc-tag{font-size:9px;letter-spacing:.08em;border:1px solid var(--fk-line);padding:0 4px;opacity:.75}",
      ".gc-tag.lfs{border-color:var(--fk-ok);color:var(--fk-ok)}",
      ".gc-tag.danger{border-color:var(--fk-warn);color:var(--fk-warn);margin-left:auto}",
      ".gc-repo{border:1px solid var(--fk-line);padding:8px 10px;margin-bottom:6px}",
      ".gc-repo-head{display:flex;gap:8px;align-items:center}",
      ".gc-repo-url{font-size:11px;opacity:.7;word-break:break-all;margin-top:3px}",
      ".gc-repo-meta,.gc-repo-note{font-size:11.5px;opacity:.75;margin-top:4px;white-space:pre-wrap}",
      ".gc-empty{opacity:.5;font-size:12px;padding:10px 0}",
      ".gc-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}",
      ".gc-check{display:flex;gap:6px;align-items:center;font-size:12px;margin:6px 0}"
    ].join("");
    document.head.appendChild(s);
  }

  function selfcheck(api) {
    return [
      { name: "IT NEVER CLAIMS TO RUN GIT", critical: true, run: async function () {
        /* The load-bearing property of this module. A Git panel
           that looks like it executes, and does not, is how work
           gets lost — someone presses a button, sees no error, and
           believes they pushed. Asserted against the real DOM. */
        var txt = api.host().textContent;
        if (!/cannot run git/i.test(txt)) {
          throw new Error("the panel does not state that it cannot run Git");
        }
        var buttons = api.host().querySelectorAll("button");
        var bad = [];
        Array.prototype.forEach.call(buttons, function (b) {
          var t = (b.textContent || "").toUpperCase();
          if (/^(PUSH|PULL|COMMIT|CLONE|MERGE|FETCH|CHECKOUT)$/.test(t.trim())) bad.push(t);
        });
        if (bad.length) throw new Error("buttons imply execution: " + bad.join(", "));
        return "states the limit, no action-shaped buttons";
      } },

      { name: "GITIGNORE COVERS THE GODOT TRAPS", critical: false, run: async function () {
        var ig = buildIgnore();
        var must = [".godot/", "export_presets.cfg", "*.blend1", ".env"];
        var missing = must.filter(function (m) { return ig.indexOf(m) < 0; });
        if (missing.length) throw new Error("missing: " + missing.join(", "));
        /* The .import trap: Godot 4 wants these KEPT. An ignore
           rule for them silently resets every texture's import
           settings for the second person, which looks like an
           engine bug rather than a Git mistake. */
        if (/^\*\.import\s*$/m.test(ig)) {
          throw new Error("*.import is ignored — Godot 4 needs those files committed");
        }
        return must.length + " traps covered, .import correctly kept";
      } },

      { name: "GITATTRIBUTES ROUTES BINARIES TO LFS", critical: false, run: async function () {
        var at = buildAttributes();
        var must = ["*.blend", "*.png", "*.wav", "*.fbx"];
        var missing = must.filter(function (m) {
          return at.indexOf(m + " filter=lfs") < 0;
        });
        if (missing.length) throw new Error("not routed to LFS: " + missing.join(", "));
        if (at.indexOf("*.gd text eol=lf") < 0) throw new Error("GDScript line endings not normalised");
        /* A text format handed to LFS would be a real bug: it
           would stop diffing and stop merging, which is the entire
           reason .tscn is worth having in Git. */
        var textToLfs = TEXT_PATTERNS.filter(function (p) {
          return at.indexOf(p + " filter=lfs") >= 0;
        });
        if (textToLfs.length) throw new Error("text formats sent to LFS: " + textToLfs.join(", "));
        return "binaries to LFS, text stays diffable";
      } },

      { name: "DESTRUCTIVE RECIPES ARE MARKED", critical: true, run: async function () {
        /* These get copied and pasted. Anything that can lose work
           has to carry its warning in the same block. */
        var risky = RECIPES.filter(function (r) {
          return /--force|reset --hard|restore \.|migrate import/.test(r.steps.join("\n"));
        });
        var unmarked = risky.filter(function (r) { return !r.danger; });
        if (unmarked.length) {
          throw new Error("unmarked destructive recipe(s): " +
            unmarked.map(function (r) { return r.id; }).join(", "));
        }
        var noNote = RECIPES.filter(function (r) { return r.danger && !r.note; });
        if (noNote.length) throw new Error("destructive recipe with no explanation");
        return risky.length + " destructive recipe(s), all marked and explained";
      } },

      { name: "REPO NOTES SAVE AND DELETE", critical: false, run: async function () {
        var marker = "SELFTEST-" + Math.random().toString(36).slice(2, 8);
        showTab("repos");
        nodes.rName.value = marker;
        nodes.rUrl.value = "https://example.invalid/probe.git";
        nodes.rBranch.value = "main";
        nodes.rOwners.value = "probe";
        nodes.rNote.value = "created by the system exercise";
        await saveRepo();

        var mine = repos.filter(function (r) { return r.data.name === marker; });
        if (mine.length !== 1) throw new Error("expected 1 saved repo, found " + mine.length);
        api.sandbox.track(mine[0].id);
        if (nodes.repoList.textContent.indexOf(marker) < 0) {
          throw new Error("saved repo is not listed");
        }
        await ctx.store.remove(mine[0].id);
        await load();
        showTab("learn");
        return "saved, listed, deleted";
      } }
    ];
  }

  FieldKit.register("git-console", {
    group: "PROJECT",
    about: "Git for the Godot project, from a machine with no terminal",
    keywords: "git github commit push pull godot repo",
    guestSafe: false,
    selfcheck: selfcheck,
    title: "GIT CONSOLE",
    icon: "⑂",
    width: 900,
    height: 640,

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.tab_learn = el("button", { class: "gc-tab on", type: "button", text: "HOW GIT WORKS",
        onclick: function () { showTab("learn"); } });
      nodes.tab_files = el("button", { class: "gc-tab", type: "button", text: "IGNORE + LFS",
        onclick: function () { showTab("files"); } });
      nodes.tab_recipes = el("button", { class: "gc-tab", type: "button", text: "RECIPES",
        onclick: function () { showTab("recipes"); } });
      nodes.tab_repos = el("button", { class: "gc-tab", type: "button", text: "OUR REPOS",
        onclick: function () { showTab("repos"); } });

      nodes.pane_learn = el("div");
      nodes.pane_files = el("div", { style: "display:none" });
      nodes.pane_recipes = el("div", { style: "display:none" });
      nodes.pane_repos = el("div", { style: "display:none" });

      nodes.rName = el("input", { class: "fk-input", placeholder: "the game" });
      nodes.rUrl = el("input", { class: "fk-input", placeholder: "https://github.com/…" });
      nodes.rBranch = el("input", { class: "fk-input", value: "main" });
      nodes.rOwners = el("input", { class: "fk-input",
        placeholder: "who owns which binaries — e.g. characters: me, environment: them" });
      nodes.rNote = el("textarea", { class: "fk-input", rows: "3",
        placeholder: "conventions you agreed, branch rules, anything the other person needs" });
      nodes.rLfs = el("input", { type: "checkbox" });
      nodes.rLfs.checked = true;
      nodes.rSave = ui.button("SAVE REPO", saveRepo, { primary: true });
      nodes.repoList = el("div");

      nodes.pane_repos.appendChild(el("div", {}, [
        el("div", { class: "gc-lead", text:
          "A repository's URL is a small secret and the conventions around it usually are not " +
          "written down anywhere. Both live here, in the vault, reachable from any machine " +
          "you can open FieldKit on." }),
        nodes.repoList,
        ui.panel("ADD / EDIT", [
          el("div", { class: "gc-grid" }, [
            el("label", { class: "fk-field" }, [
              el("span", { class: "fk-field-label", text: "NAME" }), nodes.rName]),
            el("label", { class: "fk-field" }, [
              el("span", { class: "fk-field-label", text: "DEFAULT BRANCH" }), nodes.rBranch])
          ]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "REMOTE URL" }), nodes.rUrl]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "BINARY OWNERSHIP" }), nodes.rOwners]),
          el("label", { class: "fk-field" }, [
            el("span", { class: "fk-field-label", text: "NOTES" }), nodes.rNote]),
          el("label", { class: "gc-check" }, [nodes.rLfs, el("span", { text: "Git LFS is set up on this repo" })]),
          el("div", { class: "gc-row" }, [
            nodes.rSave, ui.button("NEW", clearRepoForm), ui.button("DELETE", removeRepo, { danger: true })
          ])
        ])
      ]));

      host.appendChild(el("div", { class: "gc-wrap" }, [
        el("div", { class: "gc-tabs" }, [
          nodes.tab_learn, nodes.tab_files, nodes.tab_recipes, nodes.tab_repos
        ]),
        el("div", { class: "gc-panes" }, [
          nodes.pane_learn, nodes.pane_files, nodes.pane_recipes, nodes.pane_repos
        ])
      ]));

      renderLearn();
      renderFiles();
      renderRecipes();
      await load();
      showTab("learn");
    },

    unmount() { nodes = {}; repos = []; editingId = null; tab = "learn"; },

    searchIndex() {
      var out = LESSONS.map(function (l, i) {
        return { id: "lesson-" + i, module: "git-console", title: "GIT: " + l.title, body: l.body };
      }).concat(RECIPES.map(function (r) {
        return { id: "recipe-" + r.id, module: "git-console",
                 title: "GIT: " + r.title, body: r.note + " " + r.steps.join(" ") };
      }));
      return out.concat(repos.map(function (r) {
        return { id: r.id, module: "git-console", title: "REPO: " + r.data.name,
                 body: [r.data.url, r.data.branch, r.data.owners, r.data.note].join(" ") };
      }));
    }
  });
})(window.FieldKit);
