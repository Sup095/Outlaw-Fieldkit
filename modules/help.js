/* ============================================================
   FieldKit :: help
   The manual. Everything you need to set this up, share it, fix
   it, and understand what it is doing with your data.

   Three rules this file follows:

     1. It ships on the drive. There is no network dependency and
        no "see the wiki" — the machine that needs the manual is
        the one that cannot reach anything.
     2. It is written from the content, not the code. Sections are
        plain data, so search, the command palette and the printed
        version all come from one source.
     3. It says what does NOT work as plainly as what does. A
        manual that oversells is worse than no manual, because you
        find out the difference at the worst moment.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var ctx, ui, el, nodes = {};
  var current = "start";
  var query = "";

  /* ---- content --------------------------------------------------
     Each section: { id, title, tag, body: [blocks] }
     A block is a string (paragraph), or:
       { h: "..." }            sub-heading
       { list: [...] }         bullets
       { steps: [...] }        numbered
       { code: "..." }         monospace block
       { note: "..." }         aside
       { warn: "..." }         something that will bite you
       { rows: [[k,v],...] }   a small table
       { see: ["id", ...] }    links to other sections
  */
  var SECTIONS = [
    {
      id: "start",
      title: "START HERE",
      tag: "basics",
      body: [
        "FieldKit is a portable console that lives on a USB drive. The code is on the " +
        "drive; your data is not. Data lives encrypted on a small server (the relay), " +
        "and is decrypted in the browser after you type your master password.",

        { h: "WHY IT IS SPLIT THAT WAY" },
        "A USB drive gets lost, and a lost drive full of notes is a bad day. This drive " +
        "can be lost with no consequence beyond buying another one: everything on it is " +
        "code, and the code is not secret. Your actual work is on the relay, encrypted " +
        "with a key the relay has never seen.",

        { h: "THE THIRTY SECOND VERSION" },
        { steps: [
          "Plug in the drive and open FIELDKIT.html.",
          "It runs a self-test, then tries to reach the relay.",
          "Type your master password. Everything decrypts in the browser.",
          "Work. Changes save automatically, encrypted before they leave the machine.",
          "Close the tab. Nothing readable is left behind."
        ] },

        { h: "IF THIS IS THE FIRST TIME EVER" },
        "You need a relay running before you can create a vault, because the vault header " +
        "has to live somewhere. Set that up first.",
        { see: ["relay", "firstrun"] }
      ]
    },

    {
      id: "firstrun",
      title: "FIRST RUN — CREATING THE VAULT",
      tag: "basics",
      body: [
        "The first time FieldKit reaches a relay with no vault on it, it offers to create " +
        "one. This happens once, ever, for a given relay.",

        { h: "WHAT YOU CHOOSE" },
        "A master password. Minimum eight characters, but that is a floor and not a " +
        "recommendation — this password is the only thing protecting everything. There is " +
        "no reset, no recovery email, and nobody who can help you. Use a passphrase you " +
        "will not forget and would not guess.",

        { h: "WHAT YOU ARE GIVEN" },
        "A recovery key: a long random string, shown once. It opens the vault without the " +
        "password. Write it down on paper. It is not stored anywhere you can get it back " +
        "from — not on the drive, not on the relay, not in the vault.",

        { warn: "If you lose both the password and the recovery key, the data is gone. " +
                "Not \"gone until support restores it\". Gone. The encryption is doing " +
                "exactly what it is supposed to do, and there is no other door." },

        { h: "WHAT ACTUALLY HAPPENS" },
        { steps: [
          "A random master key (the MDK) is generated in the browser. It never leaves.",
          "Your password goes through PBKDF2, 600,000 iterations, against a random salt.",
          "That result is split into two: one half wraps the MDK, the other becomes an " +
          "auth token for talking to the relay.",
          "The recovery key wraps the MDK a second time, independently.",
          "The relay is sent: the salt, both wrapped copies, and a hash of the auth token. " +
          "It is not sent the password, the MDK, or the recovery key."
        ] },
        "So the relay holds a locked box and a note saying what a correct key sounds like. " +
        "It cannot open the box, and neither can anyone who steals it.",
        { see: ["vault", "recovery"] }
      ]
    },

    {
      id: "vault",
      title: "HOW THE ENCRYPTION WORKS",
      tag: "security",
      body: [
        "Worth understanding, because it explains what is and is not possible later.",

        { h: "ENVELOPE ENCRYPTION" },
        "Every record is encrypted with one random master key (the MDK), not with your " +
        "password. Your password encrypts the MDK. This is why changing your password is " +
        "cheap — it re-wraps one key rather than re-encrypting everything — and why two " +
        "different keys (password and recovery key) can both open the same vault without " +
        "either knowing about the other.",

        { rows: [
          ["MDK", "random, generated once, encrypts every record"],
          ["password KEK", "PBKDF2(password, salt) — wraps the MDK"],
          ["recovery KEK", "derived from the recovery key — wraps the MDK again"],
          ["auth token", "derived alongside the password KEK, proves you to the relay"]
        ] },

        { h: "WHAT THE RELAY CAN SEE" },
        "Being honest about this matters more than claiming perfection.",
        { list: [
          "It CANNOT see: your password, the MDK, the recovery key, or the contents of " +
          "any record.",
          "It CAN see: how many records exist, what type each one is (note, snippet, " +
          "incident), and when each was last changed.",
          "That metadata is plaintext on purpose — sync cannot work without it. The " +
          "relay knows you have eleven notes and when you last touched them. It does " +
          "not know a single word of what they say."
        ] },

        { h: "THE ONE UNAUTHENTICATED ROUTE" },
        "GET /vault hands out the vault header — salt and wrapped keys — to anyone who " +
        "asks. It has to: you need the salt before you can derive the token that would " +
        "authenticate you. There is no way around that ordering.",
        "What defends it: 600,000 PBKDF2 iterations make each password guess expensive, " +
        "and the relay rate-limits that route hard. Everything rests on the master " +
        "password being a real one.",
        { see: ["passwords", "relay"] }
      ]
    },

    {
      id: "relay",
      title: "SETTING UP THE RELAY",
      tag: "setup",
      body: [
        "The relay is a small Node server with no dependencies. It stores encrypted " +
        "records and forwards AI requests. It runs on the Pterodactyl container.",

        { h: "INSTALL" },
        { steps: [
          "Upload the contents of relay/ to the container.",
          "Copy config.example.json to config.json.",
          "Set provisionToken to a long random string. This is the one-time secret that " +
          "allows a vault to be created. After the vault exists it is useless.",
          "Point the container's allocated port at the port in the config. Pterodactyl " +
          "injects SERVER_PORT and the relay prefers it, so a mismatched config cannot " +
          "cause a silent bind failure.",
          "Start it. The console should say it is listening."
        ] },

        { h: "CONFIG KEYS THAT MATTER" },
        { rows: [
          ["provisionToken", "one-time secret for creating the vault"],
          ["aiTargets", "where to find LM Studio, in priority order"],
          ["statusServices", "read-only health probes for BASTION STATUS"],
          ["trustProxy", "whose X-Forwarded-For to believe — see below"],
          ["httpProxy", "set when Tailscale runs in userspace mode"],
          ["actions", "the quick-action whitelist, empty by default"],
          ["usageLog", "count requests and AI tiers, on by default"],
          ["rateLimit", "windowMs, max, vaultMax, authFailMax, actionMax"]
        ] },

        { warn: "Leave trustProxy as false while the relay is directly internet-exposed. " +
                "That header is written by whoever is calling, so believing it lets " +
                "anyone reset their own rate limit — including the limit protecting " +
                "GET /vault. Only set it to \"loopback\" once a tunnel sits in front and " +
                "the relay itself listens on 127.0.0.1." },

        { h: "QUICK ACTIONS — THE KILL SWITCH" },
        "BASTION REMOTE can restart a server or pull logs through the relay. It is off " +
        "until you configure it: with no actions in config.json, the relay has no ability " +
        "to change anything at all.",
        "FieldKit sends an action id and nothing else. It cannot pass arguments, cannot " +
        "pass a command, and cannot compose one — the commands live in your config file " +
        "and are run without a shell, so nothing in an argument can escape into a command " +
        "line. If you need a variant, that is a second entry in the file.",
        { warn: "Actions are tailnet-only and that is not configurable. Away from the " +
                "tailnet, BASTION REMOTE will say so — that is the design, not a fault. " +
                "Status, sync and AI keep working from anywhere." },
        { note: "The loopback trap: a tunnel such as cloudflared connects to the relay " +
                "from 127.0.0.1, so once trustProxy is set, loopback stops counting as " +
                "the tailnet — otherwise the public internet would arrive pre-approved. " +
                "The practical consequence is that with a tunnel running, curl from the " +
                "box itself is refused. Test from a real tailnet address." },

        { h: "USAGE COUNTERS" },
        "How often the AI tier gets used, which target served it, and how often it fell " +
        "back. Counters only — no prompts, no message contents, no record contents, no " +
        "addresses. Record ids are counted by shape (GET /records/:x) and never by value, " +
        "because a counter keyed by record id would be a list of which records exist and " +
        "how often each is touched.",

        { h: "CHECKING IT WORKS" },
        "Open RELAY LINK, enter the URL, press TEST. Or from anywhere:",
        { code: "curl https://your-relay/health" },
        "It should answer with JSON saying up: true.",
        { see: ["network", "provision"] }
      ]
    },

    {
      id: "provision",
      title: "GETTING THE VAULT KEY FROM THE SERVER",
      tag: "setup",
      body: [
        "This comes up constantly, and the phrasing hides an important detail.",

        { warn: "The server does not have your vault key and never did. There is no " +
                "command that retrieves it, no admin panel that reveals it, and no " +
                "support process that recovers it. If that is what you are looking for, " +
                "stop looking — the answer is the recovery key you wrote down." },

        { h: "WHAT THE SERVER DOES HAVE" },
        "The vault header. That is: the salt, the two wrapped copies of the MDK, and a " +
        "hash of the auth token. All of it is inert without a password. You can fetch it " +
        "yourself and look at it:",
        { code: "curl https://your-relay/vault" },
        "You will get something like:",
        { code: "{\n  \"kdf\": { \"salt\": \"...\", \"iterations\": 600000 },\n" +
                "  \"wrap\": { \"password\": {...}, \"recovery\": {...} },\n" +
                "  \"authKeyHash\": \"...\"\n}" },
        "None of those fields can be turned into your data. They are the locked box.",

        { h: "SO HOW DOES A NEW MACHINE GET IN?" },
        "It fetches that same header and does the work locally:",
        { steps: [
          "Point FieldKit at the relay URL in RELAY LINK.",
          "It fetches the header automatically — that is the unauthenticated GET /vault.",
          "You type the master password.",
          "The browser derives the key, unwraps the MDK, and pulls the records.",
          "Nothing secret ever crossed the network in either direction."
        ] },
        "That is the whole onboarding flow. There is no key to copy across, because the " +
        "key is reconstructed from what you know, not transported.",

        { h: "THE PROVISION TOKEN IS A DIFFERENT THING" },
        "provisionToken in config.json only authorises *creating* a vault on an empty " +
        "relay. It grants no read access and is worthless once a vault exists. It is not " +
        "a backdoor and cannot be used as one. FieldKit never puts it in a backup either " +
        "— it is on the export denylist.",
        { see: ["sharing", "recovery"] }
      ]
    },

    {
      id: "sharing",
      title: "SHARING A VAULT WITH SOMEONE ELSE",
      tag: "setup",
      body: [
        "Yes, this works, and it needed no changes — the design allows it already. A " +
        "vault is not tied to a device, an account, or a drive. It is tied to a password.",

        { h: "WHAT TO DO" },
        { steps: [
          "Copy the drive, or have them download the same build.",
          "Give them the relay URL.",
          "Give them the master password, in person or over something end-to-end " +
          "encrypted. Not in a Discord message you leave sitting there.",
          "They open FieldKit, set the relay URL, and unlock. They now see everything " +
          "you see, and their work appears for you."
        ] },
        "The recovery key works the same way if you would rather hand that over — it " +
        "opens the vault without revealing the password.",

        { h: "WHO WROTE WHAT" },
        "SETTINGS → SHARED VAULT → YOUR NAME. It gets stamped on every record you write " +
        "from then on, so you can tell your work from theirs. It travels *inside* the " +
        "encrypted record, not on the metadata the relay can read — a random device id " +
        "in the clear is one thing, a human name is another.",
        { note: "It is a label, not a login. It proves nothing and is not a security " +
                "boundary: anyone with the password can set any name. Records written " +
                "before you set one simply have no author, and stay perfectly readable." },

        { h: "WORKING AT THE SAME TIME" },
        "Records are pulled when you unlock, whenever you press REFRESH in the tray, and " +
        "on a timer if you turn one on — SETTINGS → SHARED VAULT → CHECK FOR OTHER " +
        "PEOPLE'S CHANGES. It is off by default because a vault only one person uses has " +
        "nothing to poll for. Only records that actually changed are fetched, so it stays " +
        "cheap on a large vault.",
        { list: [
          "Different records at the same time: completely fine.",
          "The same record at the same time: the newer write wins.",
          "When your save overwrites something newer, you are told — a notice names the " +
          "record and whose work it replaced. Losing a collaborator's work silently is " +
          "the thing that makes shared editing untrustworthy, so it is said out loud.",
          "A record deleted on the other machine disappears here on the next pull, and " +
          "that is reported too."
        ] },
        { warn: "There is no merge. If you are both editing the same document at the " +
                "same moment, one of you will lose that edit. Press REFRESH before " +
                "starting on something, and split the work by record rather than by " +
                "paragraph." },

        { h: "WHAT THIS IS NOT" },
        { list: [
          "Not per-person passwords. One shared password, one vault. Someone leaving " +
          "means changing the password and telling everyone the new one.",
          "Not permissions. Everyone who can read can write and delete.",
          "Not real-time. Nobody sees your keystrokes; changes land when they are saved " +
          "and pulled.",
          "Not an audit log. The name on a record says who wrote it, and that name is " +
          "self-assigned."
        ] },
        "For two people building games together, that is usually the right trade. If it " +
        "ever needs to be more than that, per-person key slots are the change to make.",
        { see: ["passwords", "identity"] }
      ]
    },

    {
      id: "identity",
      title: "IDENTITY AND ATTRIBUTION",
      tag: "setup",
      body: [
        "SETTINGS → SHARED VAULT sets the name stamped on records you write, and how " +
        "often FieldKit checks for other people's changes.",
        { rows: [
          ["your name", "inside the encrypted record — the relay cannot read it"],
          ["device id", "random per-machine, plaintext, generated on first run"],
          ["pull interval", "off by default; 20s to 5min when sharing"]
        ] },
        "Neither name nor device id is verified. The device id is plaintext because " +
        "last-write-wins needs to tell two machines apart even when nobody has set a " +
        "name; it is random and says nothing about you.",
        { note: "Leave the name blank and records simply carry no author. That is fine " +
                "on your own and confusing with two people — set it before you start " +
                "sharing rather than after." },
        { see: ["sharing"] }
      ]
    },

    {
      id: "passwords",
      title: "PASSWORDS, RECOVERY KEYS AND LOCKS",
      tag: "security",
      body: [
        { h: "THREE DIFFERENT THINGS" },
        { rows: [
          ["master password", "opens the vault. Everything depends on it."],
          ["recovery key", "opens the vault without the password. Shown once."],
          ["screen PIN", "hides an already-open session. Not encryption."]
        ] },

        { h: "THE SCREEN LOCK IS NOT ENCRYPTION" },
        "Ctrl+L drops a PIN gate over an open session. The vault is already decrypted in " +
        "memory behind it, and the PIN hash lives in that same vault. It stops someone " +
        "who sits down at your keyboard. It does nothing against someone who takes the " +
        "drive, and the app says so rather than implying otherwise.",
        "The one real control there: five wrong attempts destroys the session and reloads.",

        { h: "GUEST MODE" },
        "Chosen at the unlock gate instead of a password. It swaps the store for an " +
        "in-memory one, so no module can reach the vault even if it tried. Modules must " +
        "opt in to being guest-safe; anything unflagged is sealed, so the default fails " +
        "closed. There is no exiting guest mode — leaving reloads and asks for the " +
        "password, because anything softer leaves an open vault one step from a stranger.",
        { note: "Guest mode protects your data, not the drive. A guest can read every " +
                "source file on the USB. There is nothing secret in them." },
        { see: ["recovery"] }
      ]
    },

    {
      id: "recovery",
      title: "BACKUP AND DISASTER RECOVERY",
      tag: "security",
      body: [
        "Everything lives on one relay. If that container is lost and there is no second " +
        "copy, the data is gone. This is the part people skip and then regret.",

        { h: "TAKE AN ARCHIVE" },
        "BACKUP → EXPORT ENCRYPTED ARCHIVE. One JSON file: the vault header, every record " +
        "still sealed exactly as the relay held it, and a checksum. It contains no " +
        "password, no key, and no readable content — it is exactly as strong as your " +
        "master password. Keep one on the drive.",

        { h: "AUTOMATIC LOCAL SNAPSHOTS" },
        "FieldKit also keeps a rolling set of sealed snapshots in this browser's storage, " +
        "written without asking. They survive the relay dying.",
        { warn: "They do not survive the browser profile being cleared or the machine " +
                "being reset. A snapshot is not a substitute for a file on the drive." },

        { h: "WHEN THE RELAY IS GONE" },
        { steps: [
          "Stand up a new relay. Empty is fine.",
          "Point FieldKit at it. It will offer to create a vault.",
          "Choose RESTORE FROM ARCHIVE instead.",
          "Pick the archive file. It shows you what is inside and verifies the checksum " +
          "before touching anything.",
          "Confirm. The header and every sealed record upload.",
          "Unlock with the password that archive was made with."
        ] },
        "Nothing in that path knows your password, which is exactly why the unlock " +
        "succeeding is the proof it worked.",

        { h: "GETTING SOMETHING BACK YOU DELETED" },
        "BACKUP → LOAD ARCHIVE FILE, then MERGE. Only missing or newer records are " +
        "written, so merging is safe to repeat. OVERWRITE MATCHING replaces records the " +
        "archive also has — that is the rollback button, and it is destructive.",

        { h: "LEAVING FIELDKIT" },
        "EXPORT PLAINTEXT writes everything readable to disk. It is not a backup and the " +
        "UI makes you type UNENCRYPTED to confirm. It exists so your notes are never " +
        "hostage to this app.",
        { see: ["provision"] }
      ]
    },

    {
      id: "ai",
      title: "THE AI RELAY",
      tag: "setup",
      body: [
        "FieldKit talks to a model on your own machine, through the relay. Nothing goes " +
        "to a third party.",

        { h: "THE TWO HOPS" },
        { rows: [
          ["hop 1", "this browser → the relay, over the internet"],
          ["hop 2", "the relay → LM Studio on your PC, over Tailscale"]
        ] },
        "The boot screen resolves both separately, so when it fails you know which half " +
        "broke. Hop 2 is checked after unlock, because listing AI targets needs auth.",

        { h: "SETTING UP THE MODEL" },
        { steps: [
          "Install LM Studio on the PC that will host the model.",
          "Load a model and start the server.",
          "Enable \"Serve on Local Network\" — the default binds to localhost only, and " +
          "the relay is not on that machine.",
          "Put the address in aiTargets in the relay config, lowest priority number wins."
        ] },

        { h: "THE THREE TIERS" },
        { rows: [
          ["tier 1", "a real model via the relay. What you want."],
          ["tier 2", "in-browser model. A registered slot, not built."],
          ["tier 3", "built-in heuristics. Always available, no network."]
        ] },
        "Tier 3 is not a language model. It pattern-matches and gives useful canned " +
        "answers so the assistant is never simply dead. The UI always says which tier " +
        "answered, so you are never guessing whether that reply came from a model.",
        { see: ["network"] }
      ]
    },

    {
      id: "network",
      title: "WHEN IT WILL NOT CONNECT",
      tag: "fixing",
      body: [
        "Open LINK DOCTOR first. The browser only ever says \"failed to fetch\", which " +
        "covers DNS, firewalls, TLS, refusals and CORS all at once. LINK DOCTOR runs a " +
        "battery of probes and names which one it is.",

        { h: "THE TELL IS TIMING" },
        "A firewall dropping packets makes a probe hang until it times out. A machine " +
        "with nothing listening refuses in milliseconds. That gap separates \"blocked\" " +
        "from \"not running\", and it is the single most useful measurement here.",

        { h: "COMMON VERDICTS" },
        { rows: [
          ["PORT LOOKS BLOCKED", "a firewall allows 80/443 only. Move to 443."],
          ["CONNECTION REFUSED", "the relay is not running, or the port is wrong."],
          ["NOT THE RELAY", "a filter's block page answered instead."],
          ["NO NETWORK AT ALL", "captive portal, or wifi is not really connected."],
          ["DISCARDED THE REPLY", "CORS. A relay-side problem, not the network."]
        ] },

        { h: "RESTRICTIVE NETWORKS" },
        "Plain HTTP on a non-standard port fails on most school, corporate and public " +
        "networks. A domain name alone does not fix it, because a hostname does not " +
        "change the port. What works is a real hostname on port 443 with valid TLS, " +
        "which a Cloudflare tunnel gives you without any port forwarding at all.",
        "Full walkthrough: relay/CONNECTIVITY.md on the drive.",
        { note: "If a network administrator is deliberately blocking personal servers, " +
                "going around that may breach the acceptable-use policy you agreed to, " +
                "and a managed device logs where it connects. Worth deciding knowingly." },

        { h: "OFFLINE MODE" },
        "If the relay is unreachable, FieldKit still boots and every module still loads " +
        "— the code is on the drive. New work is queued locally and uploads on the next " +
        "successful connect. Records already on the relay stay unreadable, because they " +
        "are encrypted over there. The UI states this loudly rather than degrading " +
        "quietly.",
        { see: ["fixing"] }
      ]
    },

    {
      id: "fixing",
      title: "WHEN SOMETHING IS BROKEN",
      tag: "fixing",
      body: [
        { h: "RUN THE EXERCISE" },
        "DIAGNOSTICS → FULL SYSTEM EXERCISE. It mounts every module, sends a real message " +
        "to the AI, exercises every feature against a sandbox, and puts everything back. " +
        "The NEEDS ATTENTION block at the top is your list.",

        { h: "GETTING THE REPORT OFF THE MACHINE" },
        { list: [
          "COPY REPORT — the clipboard, when policy allows it.",
          "COPY PROBLEMS ONLY — just the failures, short enough to retype.",
          "SHOW RAW TEXT — puts it on screen, selected. This route cannot be blocked.",
          "SAVE .TXT — tries a download. A blocked download is silent, so this can only " +
          "tell you it tried."
        ] },

        { h: "IF THE DESKTOP NEVER APPEARS" },
        "The boot console above the prompt is the log. It names the step that failed. " +
        "A failed self-test halts on purpose rather than starting a broken session.",

        { h: "IF A MODULE WILL NOT OPEN" },
        "A module that throws while mounting gets a dead window with the error and a " +
        "RETRY button — it does not take the desktop with it. Report the error text.",

        { h: "IF THE VAULT WILL NOT UNLOCK" },
        { list: [
          "ACCESS DENIED means the password did not derive the right key. Check caps lock.",
          "Five wrong PIN attempts at the screen lock destroys the session by design.",
          "If the relay is unreachable, the header may be a cached copy — you can still " +
          "unlock, but old records stay unreadable until you reconnect."
        ] },
        { see: ["network"] }
      ]
    },

    {
      id: "keys",
      title: "KEYBOARD AND HIDDEN THINGS",
      tag: "basics",
      body: [
        { rows: [
          ["just type", "on the desktop: find an app; Enter opens the first hit"],
          ["Ctrl+K", "command palette — search apps, notes, records and actions"],
          ["Ctrl+L", "screen lock, if a PIN is set"],
          ["Escape", "close a dialog or overlay"]
        ] },
        { h: "THE DESKTOP" },
        "The search bar at the top finds any app by its name, by what it does (\"chat\", " +
        "\"backup\", \"run a program\") or by its group. You do not have to click it: typing " +
        "anywhere on the desktop starts a search, and Enter opens the first result. Its last " +
        "row hands the same words to Ctrl+K, which also searches your notes and records.",
        "YOUR APPS, under it, are the ones you use most, counting how often and how lately; " +
        "until you have used a few it shows the usual ones. That count lives on this machine, " +
        "not in the vault — it has to work in a guest session where there is no vault at all, " +
        "and on a shared vault your friend's habits should not be reordering your desktop.",
        "ALL APPS are six folders named for what is in them: ONLINE (browser, messages, " +
        "RUNNER, the AI), FILES, PROJECT, SERVERS, TOOLS and SYSTEM. Each card lists what it holds.",
        { h: "THERE ARE THINGS TO FIND" },
        "Five of them. They do nothing important and break nothing. One is a sequence " +
        "most people already know; the others are words you type on the desktop with " +
        "nothing focused. ACHIEVEMENTS lists them with hints once you have found the " +
        "first, and the hints do not give away their own answers.",
        { note: "Typing into any text field never triggers them. That is deliberate and " +
                "tested — writing a note about a bastion should not set off fireworks." }
      ]
    },

    {
      id: "projects",
      title: "TRACKING A PROJECT",
      tag: "reference",
      body: [
        "Several modules want the same idea of \"which thing are we working on\", so there " +
        "is one project list shared between them. Create a project once, in CHANGELOG, and " +
        "it turns up everywhere else.",
        { note: "One list matters more than it sounds. Three modules each keeping their own " +
                "is how you end up with IRONMARCH, Ironmarch and \"ironmarch \" as three " +
                "separate projects forever." },

        { h: "CHANGELOG" },
        "Record what changed while you still remember it. Entries go in one at a time and " +
        "start life unreleased; CUT A VERSION stamps everything pending with a version and " +
        "a date in one pass.",
        { list: [
          "Categories follow Keep a Changelog — Added, Changed, Fixed, Removed, Deprecated, " +
          "Security. They exist to force a useful question about each line.",
          "BREAKING marks anything someone has to act on. It gets its own block at the top " +
          "of the release.",
          "Cutting is all or nothing, so a half-finished release cannot exist. Reopening a " +
          "version puts every entry back to unreleased.",
          "Re-using a version name is refused — it would silently merge two releases.",
          "COPY MARKDOWN gives you something to paste straight into a README or a release, " +
          "with who wrote each line if you have names set."
        ] },

        { h: "MANIFEST" },
        "How big the project is and whether it is growing. The plan was to point it at a " +
        "folder; the Chromebook has never let us invoke a directory picker, and a tool that " +
        "works on one machine is not a tool. So you paste instead.",
        { steps: [
          "Run whatever you already run — wc -l, cloc, npm test, jest, vitest.",
          "Paste the output into the box. The numbers get pulled out of it.",
          "Fill in anything it could not find, or leave it blank.",
          "TAKE SNAPSHOT. That moment is recorded and never edited."
        ] },
        { warn: "It never guesses. If it cannot see a test count in what you pasted, it says " +
                "so and leaves the field empty rather than recording a zero. A stat tracker " +
                "that quietly reports zero is worse than one that shrugs." },
        "Two snapshots or more and you get a line chart. One number is trivia; a line is " +
        "information.",

        { h: "SAVE CODES" },
        "Decode, edit, re-encode and compare a game's save codes. You describe the format " +
        "once as a schema and every code in it decodes — a new game needs a new schema, not " +
        "a new decoder.",
        { rows: [
          ["RAW JSON", "the code is json already"],
          ["BASE64 → JSON", "either alphabet, padding optional"],
          ["HEX → JSON", "0x prefix tolerated"],
          ["DELIMITED", "positional fields, e.g. v1|100|50|3"]
        ] },
        "COMPARE decodes both codes and diffs the results, so you are comparing what they " +
        "mean rather than how they are spelled — two codes in different encodings that say " +
        "the same thing are reported as identical.",
        { note: "Nothing here runs what it decodes. A save code is data: no eval, no " +
                "Function, no innerHTML anywhere in the decode path, and a probe checks " +
                "that by reading the source." },
        { warn: "If a delimited field contains the separator, encoding is refused rather " +
                "than producing a code that would decode to something else." },
        { see: ["modules"] }
      ]
    },

    {
      id: "planning",
      title: "PLANNING AND DESIGN TOOLS",
      tag: "reference",
      body: [
        "Three tools for deciding things before they exist. All of them work with no " +
        "network at all, which is the point — planning is what you do before there is " +
        "anything out there to ask.",

        { h: "TOPOLOGY" },
        "A draggable diagram of what talks to what. It ships with the real Bastion layout " +
        "already drawn, so it is useful before you have touched it.",
        { list: [
          "Drag a node, or Tab to it and use the arrow keys. Shift makes the steps small.",
          "Edges that point at a node you deleted are dropped rather than drawn into " +
          "nowhere.",
          "COPY SVG and SAVE SVG both produce a standalone file — the colours are baked in, " +
          "so it still looks right in a README or a document that knows nothing about FieldKit."
        ] },

        { h: "MESH PLANNER" },
        "Where the LoRa nodes go, and whether they will actually hear each other. Drag " +
        "nodes on a grid, mark what is in the way, and read off who can reach the gateway " +
        "and in how many hops.",
        { warn: "The range ring is an estimate and the module says so on screen. It is " +
                "free-space path loss plus a terrain margin — a sanity check, not a " +
                "survey. Real LoRa range is dominated by what is between the antennas, " +
                "and this only knows about obstacles you drew yourself." },
        "The terrain margin is doing all the work. Free-space maths alone says two hundred " +
        "kilometres, which is true and useless. Forty decibels is roughly suburban with no " +
        "line of sight and lands near two kilometres on SF9; clear line of sight is nearer " +
        "ten, and woodland is sixty or worse. The field shows a plain-words hint for " +
        "whatever number you put in.",
        { note: "Hop counts and unreachable nodes are exact, not estimated — that half is " +
                "pure graph work on the links you accepted, so it is a fact rather than a " +
                "guess. It also names single points of failure: nodes that reach the mesh " +
                "through exactly one neighbour." },
        "COPY PLAN JSON exports positions in metres, ready to grow into real Meshtastic " +
        "config later.",

        { h: "SECURITY SANDBOX" },
        "A design sandbox for the Bastion security tab, which does not exist yet. Sketch " +
        "the panel layout, then write the part that actually matters: the action whitelist.",
        { warn: "Every figure in the mockup is invented and stamped SYNTHETIC. The module " +
                "has no network access at all, by construction, and a probe fails if any " +
                "networking ever appears in it." },
        "The whitelist is the real output. Each action carries a blast radius, who may run " +
        "it, whether it is tailnet-only, and a cooldown. A linter holds the policy to four " +
        "rules and refuses to let you forget them:",
        { list: [
          "Nothing destructive runs automatically — there is no undo to fall back on.",
          "Detective proposes, Enforcer acts. The moment Detective can change state, the " +
          "split has stopped being a safety mechanism.",
          "Anything that changes state is tailnet-only.",
          "Automatic mutating actions carry a cooldown, or they can react to their own " +
          "side effects in a loop."
        ] },
        "COPY SPEC gives you a markdown document with the table, the reasoning behind each " +
        "entry, and any rules the policy currently breaks.",
        { see: ["relay", "modules"] }
      ]
    },

    {
      id: "assets",
      title: "THE ASSET LIBRARY",
      tag: "reference",
      body: [
        "Reusable art, sprites and audio across projects. The important thing about it is " +
        "what it does not do: it does not store the files.",
        { note: "The bytes stay in assets/assets-library/ on the drive. What is encrypted " +
                "in the vault is the catalogue — where each file is, what it is for, and " +
                "whether you are allowed to ship it. Pushing a sprite sheet through " +
                "envelope encryption to the relay would be a slow way to fill somebody's " +
                "disk." },

        { h: "LICENCES ARE NOT OPTIONAL" },
        "Every entry gets asked where it came from. An asset library without licence " +
        "tracking is how a game ends up shipping someone else's art, and by then nobody " +
        "remembers where the file came from.",
        { list: [
          "Anything without a usable licence is excluded from the build manifest — and " +
          "listed separately with the reason, because silently dropping it would hide the " +
          "problem the field exists to surface.",
          "CC-BY with no source recorded is flagged: the licence needs attribution and " +
          "there is nothing to credit.",
          "COPY CREDITS builds the attribution list for you."
        ] },

        { h: "VERIFY" },
        "The failure mode of any catalogue is rot — files get moved and the index quietly " +
        "points at nothing. VERIFY ALL walks every entry and reports three states, not two:",
        { rows: [
          ["FOUND", "the browser loaded it, so it is there"],
          ["MISSING", "the browser tried and failed"],
          ["UNCHECKABLE", "a file:// page cannot probe this kind at all"]
        ] },
        { warn: "That third state matters. Images, audio, video and fonts can be probed " +
                "from here; .aseprite, .tmx, .blend and .json cannot. Reporting those as " +
                "MISSING would send you hunting for a file sitting exactly where it " +
                "should be." },
        { see: ["projects", "modules"] }
      ]
    },

    {
      id: "browser",
      title: "THE BROWSER, AND WHAT IT CANNOT DO",
      tag: "reference",
      body: [
        "BROWSER is a window onto a proxy. Your relay fetches each page, rewrites every " +
        "link and script URL to come back through itself, and serves the result into an " +
        "iframe. That is the only shape that can work: a page opened from the drive is a " +
        "file:// page, which cannot fetch across origins at all, and most sites refuse " +
        "to be put in a frame directly.",

        { h: "WHEN YOUR RELAY RUNS A REAL BROWSER" },
        "If the relay has a browser of its own, BROWSER shows that instead: a real " +
        "Chromium on the relay, streamed to this panel as video. Pages work as they do " +
        "anywhere else, because nothing is rewritten. The panel is a picture of the " +
        "page, so the things a picture cannot do are asked of the real page:",
        { rows: [
          ["Ctrl+C, Ctrl+X", "copy or cut the page's selection to your clipboard."],
          ["Ctrl+V", "paste your clipboard into the page."],
          ["Ctrl+F, FIND", "find on the page. Enter: next. Shift+Enter: back. Esc: close."],
          ["Ctrl + / −", "zoom, 50% to 200%. Ctrl 0 or the % button: 100%."],
          ["Ctrl+L", "the address bar. F5 or Ctrl+R reloads."],
          ["COOKIES, WIPE", "forget the cookies, or end the session and its data."]
        ] },
        "A minimised panel is sent nothing, which saves the relay's upload; it picks up " +
        "where it was when you open it again. The rest of this page is about the proxy.",

        { h: "THE CONTROLS, AND WHY THERE ARE TWO SETS" },
        "There is an address bar inside the page and back/forward/reload buttons above " +
        "it in the FieldKit panel. That is not duplication by accident.",
        "This page is file:// and the frame is your relay — different origins, " +
        "permanently. Nothing out here can READ where the frame went, which is why the " +
        "address bar had to move inside the page. But the history lives on the relay, " +
        "keyed by your browse pass, so the buttons out here do not need to read " +
        "anything: they tell the relay to move and point the frame at the answer.",
        { rows: [
          ["◁ ▷", "back and forward. Greyed out when there is nowhere to go."],
          ["↻", "reload the page the relay says you are on."],
          ["FULLSCREEN", "gives this window the whole screen. Esc comes back."],
          ["NEW SESSION", "a fresh pass, an empty history, and a new cookie jar."],
          ["ENGINES", "test every search engine from the relay and switch."]
        ] },

        { h: "IF A SEARCH COMES BACK EMPTY" },
        "Press ENGINES. It fetches a test query through the relay from every candidate " +
        "and tells you which ones actually answered, then lets you switch with one " +
        "button. The switch lasts as long as the browse pass — nothing on the server " +
        "changes and no restart is needed.",
        "The reason this happens: search engines treat hosted servers as robots. Some " +
        "answer with a CAPTCHA, which the proxy detects and names. Others answer with a " +
        "perfectly ordinary page that has no results in it, which used to look exactly " +
        "like a broken browser. The proxy now counts the results and says so on the page.",
        { warn: "Nothing in FieldKit tries to get past a bot check. No fake browser " +
                "identity, no CAPTCHA solving, no traffic shaped to look like something " +
                "it is not. If an engine will not answer your relay, the answer is a " +
                "different engine." },

        { h: "GAMES AND VIDEO" },
        "The frame is allowed fullscreen, a gamepad, pointer lock and autoplay, so " +
        "browser games mostly work. What still fails is a game whose files come from a " +
        "second host that blocks your relay's address — common for game CDNs behind " +
        "Cloudflare. The symptom is specific and recognisable: the page loads fine and " +
        "the game box inside it shows a message instead of a game.",
        "There is no setting that fixes that one. The block is at the other end, it is " +
        "about where the request came from rather than what it asked for, and getting " +
        "past it would mean pretending to be something else.",

        { h: "WHAT IT IS NOT" },
        { list: [
          "Not anonymity. Your relay sees every address you ask for, and the network " +
          "you are on sees a connection to your relay for the whole session.",
          "Not isolated per site. Every page you open here lands on one origin — the " +
          "relay's — so a site you visit can read what another site left in storage. " +
          "Do not sign in to anything here you would mind another site reading.",
          "Not live. WebSockets do not go through, so chat and anything that updates " +
          "by itself will sit still.",
          "Not a way into FieldKit. The frame is a different origin from this page and " +
          "cannot navigate the top window. That is the wall the whole design rests on."
        ] },
        { see: ["network", "limits"] }
      ]
    },

    {
      id: "scripting",
      title: "CRITTERSCRIPT — THE TUTORIAL",
      tag: "reference",
      body: [
        "There is a small programming language built into TERMINAL. It is called " +
        "CritterScript and it exists because a lot of the useful things this drive can " +
        "do are three commands long — count the lines in a note, pull one field out of " +
        "an API, check which services are down — and none of them deserve a module.",

        "It is deliberately not like other languages. If you have written any code " +
        "before, the thing to un-learn first is quoting: there is no syntax for \"this " +
        "is a string\", because everything already is one.",

        { h: "THE THREE RULES" },
        "That is the whole language. Everything else is commands.",
        { steps: [
          "$name is a variable. Everything else is a literal.",
          "| sends the answer along to the next step.",
          "-> at the end of a line names the answer instead of printing it."
        ] },

        { code:
          "say hello world              prints: hello world\n" +
          "let who = Ada\n" +
          "say hello $who               prints: hello Ada\n" +
          "say \"hello, $who!\"           quotes interpolate too" },

        { h: "THE PIPE IS THE POINT" },
        "Most lines you write will be a chain. The answer of each step becomes the " +
        "first argument of the next one, so a line reads left to right in the order " +
        "the work actually happens:",
        { code:
          "list 3 1 10 2 | sort | join \", \"      1, 2, 3, 10\n" +
          "read notes | words | count             how many words\n" +
          "split \"a,b,c\" , | count -> $n         $n is now 3" },
        "If a step mentions $it, the answer goes there instead and nothing is put in " +
        "front. That is how you pipe into the middle of a sentence:",
        { code: "list x y z | count | say \"there are $it items\"" },

        { note: "A step that prints rather than produces cannot be piped. " +
          "say hello | upper is an error, and it says so by name rather than " +
          "quietly uppercasing nothing." },

        { h: "BLOCKS CLOSE WITH end" },
        { code:
          "if $n == 1\n" +
          "  say one\n" +
          "elif $n == 2\n" +
          "  say two\n" +
          "else\n" +
          "  say many\n" +
          "end\n\n" +
          "for name in (list a b c)\n" +
          "  say $name\n" +
          "end\n\n" +
          "repeat 3\n" +
          "  say tick\n" +
          "end" },

        { h: "BRACKETS HAND BACK, BARE COMMANDS PRINT" },
        "Without brackets a command prints its answer. With brackets it hands the " +
        "answer back to whatever surrounds it. That is the entire difference between " +
        "the two forms, and it is worth reading twice.",
        { code:
          "upper hello                  prints HELLO\n" +
          "say (upper hello)            also prints HELLO\n" +
          "let n = (count (list a b c)) n is 3" },

        { h: "YOUR OWN COMMANDS" },
        "A def behaves exactly like a built-in, pipes included. It has its own " +
        "variables and cannot see or change yours — which is why a script somebody " +
        "sent you cannot quietly rewrite your $count.",
        { code:
          "def double n\n" +
          "  return ($n * 2)\n" +
          "end\n" +
          "list 1 2 3 | first | double  2" },

        { h: "TWO THINGS THAT CATCH EVERYONE ONCE" },
        { list: [
          "Arguments are one word each. f $n - 1 passes three things. For arithmetic " +
          "use brackets: f ($n - 1).",
          "A minus glued to digits is a negative number, so item $l -1 really does " +
          "mean the last item."
        ] },

        { h: "IT STOPS ITSELF" },
        "Every run has a step ceiling, a loop ceiling, an output ceiling and a call " +
        "depth ceiling. A runaway loop ends with a message naming the line rather " +
        "than hanging the tab — which matters, because the tab is also holding your " +
        "unlocked vault.",

        { h: "WHERE THE FULL REFERENCE IS" },
        "Open the CRITTERSCRIPT module. It lists every command that exists, read " +
        "from the live registry rather than written down, and it exports the whole " +
        "language as Markdown or JSON in one click. That export is the thing to take " +
        "with you if CritterScript is ever going to be rebuilt somewhere else.",
        { see: ["scripting-relay", "modules"] }
      ]
    },

    {
      id: "scripting-relay",
      title: "SCRIPTS THAT REACH THE WEB",
      tag: "reference",
      body: [
        "Six CritterScript commands go through the relay: fetch, find, ask, sum-up, " +
        "services and uptime. They are worth understanding separately, because they " +
        "are the only part of the language that leaves the machine.",

        { h: "WHY THEY HAVE TO GO THROUGH THE RELAY" },
        "FIELDKIT.html is opened from the drive, as a file:// page. A file:// page " +
        "cannot fetch anything across origins — not with permission, not with a flag, " +
        "not at any length of code. Reading one line of the web is simply not " +
        "something the drive can do on its own. The relay can, so through the relay " +
        "it becomes one word.",

        { h: "WHAT THEY HAND BACK" },
        "Values, not pages. fetch gives you a record with the title, the readable " +
        "text and the links in it; find gives you a list of records with a title and " +
        "a url each. Both are ordinary CritterScript values, so field, pluck, where " +
        "and the rest work on them with nothing new to learn.",
        { code:
          "fetch example.com | field title\n" +
          "find godot navmesh | pluck url\n" +
          "find godot navmesh | first | field url | fetch $it | field text | sum-up\n" +
          "services | where ok false | pluck name" },

        { h: "NONE OF THEM CHANGE ANYTHING" },
        "There is no command here that restarts a service, runs a whitelisted action, " +
        "writes config or deletes anything, and that is a deliberate line rather than " +
        "an oversight. A script is something you paste from a chat window and run to " +
        "see what it does. That has to stay a safe thing to do, and no confirmation " +
        "prompt fixes it once the command exists to be typed.",

        { h: "WHAT THEY NEED" },
        { list: [
          "A relay configured and reachable. See RELAY LINK.",
          "The vault unlocked — that is what proves who you are to the relay.",
          "Not guest mode. All six are sealed, and a guest is told which command " +
          "was refused rather than getting a blank."
        ] },

        { warn: "fetch and find spend the relay's rate budget and ask spends an AI " +
          "provider's quota. A loop that fetches a hundred pages will be rate " +
          "limited, and the message will say so." },

        { h: "THE EXTRACTION IS HONEST, NOT CLEVER" },
        "fetch does not try to guess which part of a page is the article. It strips " +
        "what is definitely not prose — scripts, styles, embedded frames — turns tags " +
        "into whitespace, and stops. So the navigation menu is in the text you get " +
        "back. That is on purpose: an extractor that guesses is one that sometimes " +
        "eats the article, and it fails silently and differently on every site.",
        { see: ["scripting", "network", "ai"] }
      ]
    },

    {
      id: "modules",
      title: "WHAT EVERY MODULE DOES",
      tag: "reference",
      body: [
        "Built from the live registry, so it cannot go stale.",
        { modules: true },
        { h: "GUEST-SAFE" },
        "A module marked guest-safe can be opened in a guest session. Anything touching " +
        "the relay, settings or secrets is not, and unflagged modules are sealed by " +
        "default — the safe direction to be wrong in."
      ]
    },

    {
      id: "limits",
      title: "WHAT THIS IS NOT",
      tag: "reference",
      body: [
        "Stated plainly so you find out here rather than at a bad moment.",
        { list: [
          "Not multi-user with separate accounts. One password, one vault, everyone " +
          "who has it can read and write everything.",
          "Not real-time collaboration. Changes land when saved and pulled, not as you " +
          "type.",
          "Not a defence against someone with your master password. There is nothing " +
          "underneath it.",
          "Not resistant to a compromised machine. If something is reading your browser " +
          "memory while the vault is open, it has everything.",
          "The screen lock is not encryption. See PASSWORDS.",
          "Guest mode hides your data, not the drive's source files.",
          "Record metadata — type, timestamps, count — is plaintext on the relay. Only " +
          "content is encrypted.",
          "Window positions are not remembered between sessions.",
          "The command palette only indexes modules that are currently open.",
          "QR codes are byte mode, level M, up to 106 bytes. Over that it refuses rather " +
          "than silently truncating.",
          "Rate limits reset when the relay restarts. They are abuse damping, not a " +
          "security control."
        ] },
        { see: ["vault", "sharing"] }
      ]
    }
  ];

  /* ---- search ----------------------------------------------------
     Flattened once, because searching structure is a nuisance and
     searching text is not. */
  function blockText(b) {
    if (typeof b === "string") return b;
    if (!b || typeof b !== "object") return "";
    if (b.h) return b.h;
    if (b.list) return b.list.join(" ");
    if (b.steps) return b.steps.join(" ");
    if (b.code) return b.code;
    if (b.note) return b.note;
    if (b.warn) return b.warn;
    if (b.rows) return b.rows.map(function (r) { return r.join(" "); }).join(" ");
    return "";
  }

  function sectionText(s) {
    return (s.title + " " + s.body.map(blockText).join(" ")).toLowerCase();
  }

  function search(q) {
    q = String(q || "").trim().toLowerCase();
    if (!q) return SECTIONS.slice();
    var terms = q.split(/\s+/);
    return SECTIONS.filter(function (s) {
      var hay = sectionText(s);
      return terms.every(function (t) { return hay.indexOf(t) >= 0; });
    });
  }

  /* ---- rendering ------------------------------------------------- */
  function renderNav() {
    ui.clear(nodes.nav);
    var hits = search(query);
    var ids = {};
    hits.forEach(function (s) { ids[s.id] = true; });

    if (!hits.length) {
      nodes.nav.appendChild(el("div", { class: "hp-none", text: "NOTHING MATCHES" }));
      return;
    }
    SECTIONS.forEach(function (s) {
      if (!ids[s.id]) return;
      var b = el("button", {
        class: "hp-navitem" + (s.id === current ? " on" : ""),
        text: s.title,
        onclick: function () { show(s.id); }
      });
      nodes.nav.appendChild(b);
    });
  }

  function renderBody() {
    ui.clear(nodes.body);
    var s = SECTIONS.filter(function (x) { return x.id === current; })[0];
    if (!s) {
      nodes.body.appendChild(el("div", { class: "hp-none", text: "PICK A SECTION" }));
      return;
    }
    nodes.body.appendChild(el("h2", { class: "hp-title", text: s.title }));
    s.body.forEach(function (b) {
      var n = renderBlock(b);
      if (n) nodes.body.appendChild(n);
    });
  }

  function renderBlock(b) {
    if (typeof b === "string") return el("p", { class: "hp-p", text: b });
    if (!b || typeof b !== "object") return null;

    if (b.h) return el("div", { class: "hp-h", text: b.h });
    if (b.note) return el("div", { class: "hp-note", text: b.note });
    if (b.warn) return el("div", { class: "hp-warn", text: b.warn });
    if (b.code) return el("pre", { class: "hp-code", text: b.code });

    if (b.list) {
      return el("ul", { class: "hp-list" }, b.list.map(function (t) {
        return el("li", { text: t });
      }));
    }
    if (b.steps) {
      return el("ol", { class: "hp-steps" }, b.steps.map(function (t) {
        return el("li", { text: t });
      }));
    }
    if (b.rows) {
      return el("div", { class: "hp-rows" }, b.rows.map(function (r) {
        return el("div", { class: "hp-row" }, [
          el("span", { class: "hp-key", text: r[0] }),
          el("span", { class: "hp-val", text: r[1] })
        ]);
      }));
    }
    if (b.see) {
      return el("div", { class: "hp-see" }, [el("span", { class: "hp-see-lbl", text: "SEE ALSO" })]
        .concat(b.see.map(function (id) {
          var t = SECTIONS.filter(function (x) { return x.id === id; })[0];
          return el("button", { class: "hp-link", text: t ? t.title : id,
            onclick: function () { show(id); } });
        })));
    }
    if (b.modules) return renderModuleTable();
    return null;
  }

  /* Read from the registry rather than a hand-kept list, so a new
     module documents itself the moment it is added. */
  function registered() {
    var m = FieldKit.modules ? FieldKit.modules() : {};
    return Object.keys(m).map(function (k) { return m[k]; });
  }

  function renderModuleTable() {
    var mods = registered();
    if (!mods.length) return el("div", { class: "hp-none", text: "NO MODULES REGISTERED" });
    return el("div", { class: "hp-rows" }, mods.slice().sort(function (a, b) {
      return a.title < b.title ? -1 : 1;
    }).map(function (m) {
      return el("div", { class: "hp-row" }, [
        el("span", { class: "hp-key", text: (m.icon ? m.icon + "  " : "") + m.title }),
        el("span", { class: "hp-val" + (m.guestSafe ? "" : " hp-sealed"),
          text: m.guestSafe ? "guest-safe" : "needs the vault" })
      ]);
    }));
  }

  function show(id) {
    current = id;
    renderNav();
    renderBody();
    if (nodes.body.scrollTop !== undefined) nodes.body.scrollTop = 0;
  }

  /* ---- plain text, for printing or pasting ----------------------- */
  function asText(only) {
    var out = ["FIELDKIT — MANUAL", "v" + FieldKit.VERSION, ""];
    SECTIONS.forEach(function (s) {
      if (only && s.id !== only) return;
      out.push(new Array(62).join("="));
      out.push(s.title);
      out.push(new Array(62).join("="));
      out.push("");
      s.body.forEach(function (b) {
        if (typeof b === "string") { out.push(wrap(b).join("\n")); out.push(""); return; }
        if (b.h) { out.push("-- " + b.h + " --"); out.push(""); return; }
        if (b.note) { out.push(wrap("NOTE: " + b.note).join("\n")); out.push(""); return; }
        if (b.warn) { out.push(wrap("WARNING: " + b.warn).join("\n")); out.push(""); return; }
        if (b.code) { out.push(b.code.split("\n").map(function (l) { return "    " + l; }).join("\n")); out.push(""); return; }
        if (b.list) { b.list.forEach(function (t) { out.push(bullet("  - ", t)); }); out.push(""); return; }
        if (b.steps) { b.steps.forEach(function (t, i) { out.push(bullet("  " + (i + 1) + ". ", t)); }); out.push(""); return; }
        if (b.rows) {
          b.rows.forEach(function (r) { out.push("  " + pad(r[0], 20) + r[1]); });
          out.push("");
        }
      });
    });
    return out.join("\n").replace(/\n{3,}/g, "\n\n");
  }

  function bullet(prefix, text) {
    var lines = wrap(text, 68 - prefix.length);
    var indent = new Array(prefix.length + 1).join(" ");
    return prefix + lines[0] + lines.slice(1).map(function (l) { return "\n" + indent + l; }).join("");
  }

  function pad(s, n) { s = String(s); return s + new Array(Math.max(1, n - s.length + 1)).join(" "); }

  function wrap(text, width) {
    width = width || 70;
    var words = String(text || "").split(/\s+/), lines = [], line = "";
    words.forEach(function (w) {
      if (!line.length) { line = w; return; }
      if (line.length + 1 + w.length > width) { lines.push(line); line = w; }
      else line += " " + w;
    });
    if (line.length) lines.push(line);
    return lines.length ? lines : [""];
  }

  /* Reads text out of a node tree. A real DOM aggregates textContent
     up the tree and hands back an HTMLCollection; the test harness
     does neither. This copes with both rather than assuming one. */
  function flatten(node) {
    if (!node) return "";
    var out = [];
    (function walk(n) {
      if (!n) return;
      if (n.textContent) out.push(n.textContent);
      var kids = n.children;
      if (!kids) return;
      for (var i = 0; i < kids.length; i++) walk(kids[i]);
    })(node);
    return out.join(" ");
  }

  /* ---- probes ---------------------------------------------------- */
  function selfcheck(api) {
    return [
      { name: "EVERY SECTION IS WELL FORMED", critical: false, run: async function () {
        var ids = {};
        SECTIONS.forEach(function (s) {
          if (!s.id || !s.title) throw new Error("a section has no id or title");
          if (ids[s.id]) throw new Error("duplicate section id: " + s.id);
          ids[s.id] = true;
          if (!Array.isArray(s.body) || !s.body.length) throw new Error(s.id + " has no body");
          s.body.forEach(function (b) {
            if (typeof b === "string") return;
            var known = ["h", "list", "steps", "code", "note", "warn", "rows", "see", "modules"];
            var keys = Object.keys(b);
            if (!keys.length) throw new Error(s.id + " has an empty block");
            keys.forEach(function (k) {
              if (known.indexOf(k) < 0) throw new Error(s.id + " has an unknown block type '" + k + "'");
            });
          });
        });
        return SECTIONS.length + " sections, all well formed";
      } },

      { name: "EVERY CROSS-REFERENCE RESOLVES", critical: false, run: async function () {
        var ids = {};
        SECTIONS.forEach(function (s) { ids[s.id] = true; });
        var broken = [];
        SECTIONS.forEach(function (s) {
          s.body.forEach(function (b) {
            if (b && b.see) {
              b.see.forEach(function (id) { if (!ids[id]) broken.push(s.id + " -> " + id); });
            }
          });
        });
        if (broken.length) throw new Error("dangling: " + broken.join(", "));
        return "no dangling SEE ALSO links";
      } },

      /* The manual is only useful if you can find the thing you are
         panicking about. */
      { name: "SEARCH FINDS THE THINGS PEOPLE ASK FOR", critical: false, run: async function () {
        var expect = [
          ["recovery key", "recovery"],
          ["vault key from the server", "provision"],
          ["share", "sharing"],
          ["blocked", "network"],
          ["guest", "passwords"],
          ["backup", "recovery"],
          ["lm studio", "ai"],
          ["provision token", "provision"]
        ];
        for (var i = 0; i < expect.length; i++) {
          var hits = search(expect[i][0]).map(function (s) { return s.id; });
          if (hits.indexOf(expect[i][1]) < 0) {
            throw new Error("'" + expect[i][0] + "' did not find " + expect[i][1] +
              " (found: " + (hits.join(",") || "nothing") + ")");
          }
        }
        if (search("zzzznotathing").length) throw new Error("a nonsense query matched something");
        if (search("").length !== SECTIONS.length) throw new Error("an empty query should list everything");
        return expect.length + " lookups, each finds the right section";
      } },

      { name: "THE MODULE LIST COMES FROM THE REGISTRY", critical: false, run: async function () {
        var mods = registered();
        if (!mods.length) throw new Error("no modules registered");
        var node = renderModuleTable();
        var text = flatten(node);
        var missing = mods.filter(function (m) { return text.indexOf(m.title) < 0; });
        if (missing.length) {
          throw new Error("not documented: " + missing.map(function (m) { return m.id; }).join(", "));
        }
        return "all " + mods.length + " registered modules appear";
      } },

      { name: "IT DOES NOT OVERSELL", critical: true, run: async function () {
        /* If the limits section ever quietly loses its teeth, the
           manual becomes a liability rather than a document. */
        var limits = SECTIONS.filter(function (s) { return s.id === "limits"; })[0];
        if (!limits) throw new Error("the limits section is gone");
        var text = sectionText(limits);
        var mustSay = ["not multi-user", "not real-time", "not encryption", "plaintext"];
        var missing = mustSay.filter(function (p) { return text.indexOf(p) < 0; });
        if (missing.length) throw new Error("no longer states: " + missing.join(", "));

        var sharing = sectionText(SECTIONS.filter(function (s) { return s.id === "sharing"; })[0]);
        if (sharing.indexOf("not per-person passwords") < 0) {
          throw new Error("sharing no longer says it is one shared password");
        }
        return "the limits are still stated plainly";
      } },

      { name: "THE MANUAL CONTAINS NO SECRETS", critical: true, run: async function () {
        var text = asText();
        var forbidden = [];
        var tok = ctx.settings.get("relayProvisionToken");
        if (tok) forbidden.push(tok);
        var url = ctx.settings.get("relayUrl");
        if (url) forbidden.push(url);
        if (ctx.store.vault && ctx.store.vault() && ctx.store.vault().authToken) {
          forbidden.push(ctx.store.vault().authToken);
        }
        for (var i = 0; i < forbidden.length; i++) {
          if (text.indexOf(forbidden[i]) >= 0) {
            throw new Error("something from this install leaked into the manual");
          }
        }
        return "generic documentation only, nothing from this install";
      } },

      { name: "PLAIN TEXT EXPORT IS COMPLETE", critical: false, run: async function () {
        var text = asText();
        var missing = SECTIONS.filter(function (s) { return text.indexOf(s.title) < 0; });
        if (missing.length) {
          throw new Error("missing from export: " + missing.map(function (s) { return s.id; }).join(", "));
        }
        /* Named tags, not "anything in angle brackets". The old check
           banned the character outright, which the scripting sections
           trip on constantly: `->` is how CritterScript names an
           answer — the third of the three rules — and `read <name>`
           is how every usage line is written. Neither is markup. What
           this is actually guarding against is a body block authored
           as HTML and shipped raw into a plain-text export, so look
           for tags by name. */
        var tag = /<\/?(?:a|b|i|p|br|hr|em|ul|ol|li|h[1-6]|div|span|pre|code|strong|table|tr|td|th|img|script|style)\b[^>]*>/i.exec(text);
        if (tag) throw new Error("the export contains markup: " + tag[0]);
        var longest = text.split("\n").reduce(function (m, l) { return Math.max(m, l.length); }, 0);
        if (longest > 90) throw new Error("lines are " + longest + " chars — will not paste cleanly");
        return text.split("\n").length + " lines, longest " + longest + " chars";
      } },

      { name: "EVERY SECTION RENDERS", critical: false, run: async function () {
        var was = current;
        try {
          for (var i = 0; i < SECTIONS.length; i++) {
            show(SECTIONS[i].id);
            if (!nodes.body.children || !nodes.body.children.length) {
              throw new Error(SECTIONS[i].id + " rendered nothing");
            }
          }
          return SECTIONS.length + " sections rendered without throwing";
        } finally {
          show(was);
        }
      } }
    ];
  }

  FieldKit.register("help", {
    group: "SYSTEM",
    about: "The manual: setting up, sharing and fixing FieldKit",
    keywords: "help manual docs guide how instructions",
    /* Documentation is the one thing a guest should absolutely be
       able to read — it explains why half the console is sealed. */
    guestSafe: true,
    selfcheck: selfcheck,
    title: "MANUAL",
    icon: "?",
    width: 820,
    height: 640,

    /* Every section is findable from Ctrl+K. The palette opens the
       module; `current` is set here so it lands on the right page. */
    searchIndex: function () {
      return SECTIONS.map(function (s) {
        return {
          id: "help:" + s.id,
          title: s.title,
          body: s.body.map(blockText).join(" "),
          open: function () { current = s.id; }
        };
      });
    },

    async mount(host, context) {
      ctx = context; ui = ctx.ui; el = ui.el;
      injectCSS();

      nodes.nav = el("div", { class: "hp-nav" });
      nodes.body = el("div", { class: "hp-body" });

      var searchField = ui.field("SEARCH THE MANUAL", { placeholder: "recovery key, blocked, sharing..." });
      searchField.input.addEventListener("input", function () {
        query = searchField.input.value;
        renderNav();
        /* Jump to the first hit so typing lands you somewhere. */
        var hits = search(query);
        if (query && hits.length && hits.indexOf(
          SECTIONS.filter(function (s) { return s.id === current; })[0]) < 0) {
          show(hits[0].id);
        }
      });

      host.appendChild(el("div", { class: "hp-wrap" }, [
        el("div", { class: "hp-top" }, [
          searchField,
          el("div", { class: "hp-topbtns" }, [
            ui.button("COPY WHOLE MANUAL", function () {
              ui.copy(asText(), { title: "FIELDKIT MANUAL",
                note: "Clipboard access is blocked here. Select this and press Ctrl+C." })
                .then(function (how) { if (how) ui.toast("MANUAL COPIED", "ok"); });
            }),
            ui.button("THIS SECTION", function () {
              ui.textDump(asText(current), "MANUAL — " +
                (SECTIONS.filter(function (s) { return s.id === current; })[0] || {}).title,
                "Select and copy, or just read it here.");
            })
          ])
        ]),
        el("div", { class: "hp-cols" }, [nodes.nav, nodes.body])
      ]));

      show(current);
    },

    unmount() { nodes = {}; query = ""; }
  });

  function injectCSS() {
    if (document.getElementById("hp-style")) return;
    var s = document.createElement("style");
    s.id = "hp-style";
    s.textContent = `
.hp-wrap{height:100%;display:flex;flex-direction:column}
.hp-top{padding:0 0 8px;border-bottom:1px solid var(--line2)}
.hp-topbtns{display:flex;gap:6px;margin-top:8px}
.hp-topbtns .fk-btn{flex:1}
.hp-cols{flex:1;display:flex;min-height:0}
.hp-nav{width:230px;flex:0 0 230px;overflow:auto;border-right:1px solid var(--line2);
  padding-right:6px}
.hp-navitem{display:block;width:100%;text-align:left;background:none;border:none;
  color:var(--fg-dim);font:inherit;font-size:10px;letter-spacing:.12em;padding:7px 8px;
  cursor:pointer;border-left:2px solid transparent}
.hp-navitem:hover{color:var(--fg);background:var(--panel2)}
.hp-navitem.on{color:var(--accent);border-left-color:var(--accent);background:var(--panel2)}
.hp-body{flex:1;overflow:auto;padding:0 4px 20px 14px;min-width:0}
.hp-title{font-size:15px;letter-spacing:.16em;color:var(--accent);margin:4px 0 12px;
  font-weight:normal}
.hp-h{font-size:10px;letter-spacing:.18em;color:var(--accent-dim);margin:16px 0 6px;
  padding-bottom:3px;border-bottom:1px solid var(--line2)}
.hp-p{font-size:11px;line-height:1.75;color:var(--fg-dim);margin:0 0 10px}
.hp-list,.hp-steps{margin:0 0 10px;padding-left:20px;font-size:11px;line-height:1.75;
  color:var(--fg-dim)}
.hp-list li,.hp-steps li{margin-bottom:5px}
.hp-code{background:var(--bg2);border:1px solid var(--line2);padding:9px 11px;
  font-size:10px;line-height:1.6;color:var(--fg);overflow-x:auto;margin:0 0 10px;
  white-space:pre}
.hp-note{font-size:10px;line-height:1.65;color:var(--fg-dimmer);margin:0 0 10px;
  border-left:2px solid var(--line2);padding-left:9px}
.hp-warn{font-size:10px;line-height:1.65;color:var(--warn);margin:0 0 10px;
  border-left:2px solid var(--warn);padding-left:9px}
.hp-rows{margin:0 0 10px;border:1px solid var(--line2)}
.hp-row{display:flex;gap:10px;padding:5px 9px;border-bottom:1px solid var(--line2);
  font-size:10px;line-height:1.6}
.hp-row:last-child{border-bottom:none}
.hp-key{flex:0 0 170px;color:var(--accent-dim);letter-spacing:.08em}
.hp-val{flex:1;color:var(--fg-dim)}
.hp-val.hp-sealed{color:var(--fg-dimmer)}
.hp-see{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:14px 0 4px}
.hp-see-lbl{font-size:9px;letter-spacing:.18em;color:var(--fg-dimmer)}
.hp-link{background:none;border:1px solid var(--line2);color:var(--accent);font:inherit;
  font-size:9px;letter-spacing:.12em;padding:4px 8px;cursor:pointer}
.hp-link:hover{border-color:var(--accent)}
.hp-none{padding:12px;text-align:center;color:var(--fg-dimmer);font-size:10px;
  letter-spacing:.16em}
@media (max-width: 620px){
  .hp-cols{flex-direction:column}
  .hp-nav{width:auto;flex:0 0 auto;max-height:130px;border-right:none;
    border-bottom:1px solid var(--line2)}
  .hp-body{padding-left:0}
  .hp-key{flex:0 0 110px}
}
`;
    document.head.appendChild(s);
  }
})(window.FieldKit);
