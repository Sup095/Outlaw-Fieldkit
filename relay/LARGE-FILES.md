# Storing large files on the relay — a design note

**Status: BUILT, 2026-08-14.** This document was written as the analysis before
anything existed, and the analysis stands — so it is kept as written below rather
than rewritten to sound prescient. What changed is that the chunked design it
describes turned out to be worth building after all.

**What exists now:**

| Piece | Where |
|---|---|
| Blob routes (`GET`/`PUT`/`DELETE /blobs/:key`, `GET /blobs`) | `relay/server.js` |
| Chunking, sealing, manifests, verify, orphan GC | `core/files.js` |
| The panel, and the advice about what belongs where | `modules/vault-files.js` |
| Raw-byte seal/open (`sealRaw`/`openRaw`) | `core/crypto.js` |
| 48 checks on the chunking, 40 against a live relay | `tests/files.test.js`, `test-blobs.js` |

Chunks are 4 MB of plaintext by default, each sealed under its own random IV and
uploaded as raw bytes — no base64, no JSON, no 2 MB ceiling. Peak memory is roughly
one chunk regardless of file size, so a 500 MB `.blend` costs what a 5 MB one does.

**The recommendation at the bottom of this document has not changed.** Git is still
the right tool for a Godot project, and `modules/git-console.js` exists to make that
easy from a machine with no terminal. The blob store is for what Git is bad at:
large binaries you want encrypted and reachable, reference material, and parking a
file while you decide what to do with it. `VAULT FILES` says so at the moment you
pick a file, which is the only moment anyone reads advice.

**One gap worth knowing before relying on it:** manifests are records and ride along
in vault backups; **blobs do not**. A restored vault will list files whose chunks are
gone. `VERIFY` reports that per file, and `FIND ORPHANED CHUNKS` handles the reverse.
The garbage-collection section below is still the honest account of why this is hard.

---

## The original analysis (2026-08-13), unchanged

The ask: keep a shared Godot project's assets on the relay, encrypted, reachable
from any machine holding the drive. The instinct is that FieldKit already stores
encrypted records, so this is just "more records". It is not, and the gap is worth
writing down before anyone tries.

---

## Why the record path cannot carry them

Three hard limits, all of them real today:

| Limit | Where | Value |
|---|---|---|
| Request body cap | `server.js` `maxBodyBytes` | **2 MB** |
| Base64 inflation | `core/crypto.js` seals to a JSON string | **+33%** |
| No streaming encryption | `crypto.subtle.encrypt(ArrayBuffer)` | whole file in RAM |

That last one is the killer. `crypto.subtle` has no streaming interface — you hand
it one buffer and get one buffer back. For a single 500 MB asset on the school
Chromebook (**4 GB total RAM**, ChromeOS and Chrome already resident):

```
  500 MB   the file, read into an ArrayBuffer
+ 500 MB   the AES-GCM ciphertext
+ 667 MB   base64 of the ciphertext, as a JS string
= ~1.7 GB peak for one file
```

That tab dies. And even if it survived, the body is 833× the relay's limit.

Raising `maxBodyBytes` does not fix it — it converts a clean rejection into an
out-of-memory crash on the weakest machine in the fleet, which is the one that
matters.

---

## What would actually work

**Chunk before encrypting.** Fixed 4 MB chunks, each sealed independently with its
own IV, uploaded as raw bytes. Peak memory becomes ~12 MB *regardless of file size* —
a 10 GB file costs the same as a 10 MB one.

**A manifest record points at the chunks.** This is the part that fits neatly: the
manifest is small enough to live in the existing encrypted record store, unchanged.

```
  10 GB file ÷ 4 MB chunks = 2,560 chunks
  2,560 × 32-byte hash     = 82 KB of manifest
```

82 KB is comfortably inside the 2 MB record limit. So the catalogue, the ordering,
the filenames and the sizes all stay in the zero-knowledge store that already works,
and only the opaque bytes need somewhere new to live.

**A separate raw-bytes endpoint.** `PUT /blobs/:id` and `GET /blobs/:id` speaking
`application/octet-stream`, streamed to and from disk, never buffered whole and never
JSON-encoded. That removes the 33% base64 tax and the 2 MB cap in one move, and it
keeps the existing record routes untouched — a blob route that cannot parse JSON
cannot be confused with a record route.

The relay still sees only ciphertext. It never learns a filename, a directory
structure, or a file type; the manifest that knows those things is sealed.

---

## The trade-offs you would be accepting

**Content-addressing does not dedupe.** Naming a chunk by the hash of its
*ciphertext* means the same asset encrypted twice, with different IVs, produces
different names — so no deduplication and no cross-machine resume. Deriving the IV
from the plaintext instead (convergent encryption) buys both back, at the cost of
leaking equality: the relay could tell that two people uploaded the same file, and
could confirm a guess about a file's contents by encrypting a candidate and looking
for the hash. For a two-person game project that is probably an acceptable trade,
but it is a trade and it should be made deliberately, not by accident.

**Garbage collection becomes a real problem.** Delete the manifest and the chunks
are orphaned — unreferenced, unreadable, and taking up quota forever. The relay
cannot tell which chunks are still referenced, because the references are inside
sealed records it cannot read. Either the client sweeps (needs the vault unlocked,
and needs to be sure it has seen *every* manifest, including a collaborator's), or
chunks carry a lease and expire unless refreshed. Neither is free.

**The disk quota is unknown and is the real ceiling.** The Pterodactyl container's
allocation is the hard limit on all of this, and nobody has checked it. Ask that
before writing a line of code — a 5 GB container makes this entire design moot.

**Two people writing at once still last-write-wins.** The manifest is an ordinary
record and inherits the vault's conflict behaviour, which is a timestamp comparison
and a warning. That is fine for notes. For a 4 GB asset it means one person's upload
is silently the loser.

---

## What to use instead, today

Be honest about the alternative: **for a Godot project, Git is the right tool for
almost all of it.** `.gd`, `.tscn`, `.tres` and `project.godot` are text and diff
properly. Git handles two people, branches, history and merges — all things this
design does not attempt and would do worse.

The genuinely FieldKit-shaped part is narrower and still worth having:

- the **catalogue** — where each asset is, what it is for, and whether you are
  allowed to ship it (`asset-library.js`, built)
- **licence tracking**, which Git does not do and which is how a game ends up
  shipping someone else's art
- **encrypted-anywhere access** to material you specifically do not want in a
  GitHub repo

So the recommendation is: Git for the project, the drive for bulk, FieldKit for the
index and the things that must stay private. Revisit the blob store only if a
concrete need survives that split — and check the container's disk quota first.

---

## If it is built, the order is

1. Find out the Pterodactyl disk allocation. Stop here if it is small.
2. Decide convergent-vs-random IV **explicitly**, and write the reasoning down.
3. `PUT/GET /blobs/:id`, streamed, tailnet-only for writes (same reasoning as §9D —
   filling someone's disk is a state change).
4. Client-side chunked seal/unseal with a progress UI and resume.
5. Manifest record type, and an asset-library entry kind that points at one.
6. Orphan sweep, before the first real upload rather than after.
