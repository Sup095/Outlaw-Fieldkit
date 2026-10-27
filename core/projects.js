/* ============================================================
   FieldKit :: projects
   A shared idea of "which thing are we working on".

   Several modules want the same list — the changelog, the build
   manifest, later the home screen — and three modules each keeping
   their own list is how you end up with "IRONMARCH", "Ironmarch"
   and "ironmarch " as separate projects forever.

   So one record type, one service, one slug. Everything else
   references a project by its id.

   Deliberately thin: a project is a name, a slug, a status and
   some notes. It is not a task tracker or a repository. Modules
   hang their own record types off the id.
   ============================================================ */
(function (FieldKit) {
  "use strict";

  var TYPE = "project";
  var STATUSES = ["active", "paused", "shipped", "archived"];

  function store() { return FieldKit.need("store"); }

  /* A stable, human-readable key. Used in exported filenames and
     markdown headings, so it has to survive a round trip through a
     filesystem and a text editor. */
  function slugify(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/['"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "untitled";
  }

  function normalise(p) {
    return {
      name: String(p.name || "").trim().slice(0, 80),
      slug: p.slug || slugify(p.name),
      status: STATUSES.indexOf(p.status) >= 0 ? p.status : "active",
      colour: p.colour || null,
      notes: String(p.notes || "").slice(0, 4000),
      createdAt: p.createdAt || new Date().toISOString()
    };
  }

  async function all(opts) {
    opts = opts || {};
    var rows = await store().list(TYPE);
    return rows
      .map(function (r) {
        var p = normalise(r.data);
        p.id = r.id;
        p.author = r.meta.author || null;
        p.updatedAt = r.meta.updatedAt;
        return p;
      })
      .filter(function (p) { return opts.includeArchived ? true : p.status !== "archived"; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  async function get(id) {
    var d = await store().get(id);
    if (!d) return null;
    var p = normalise(d);
    p.id = id;
    return p;
  }

  async function create(name, extra) {
    name = String(name || "").trim();
    if (!name) throw new Error("a project needs a name");

    /* Slug collisions are the whole reason this service exists. */
    var existing = await all({ includeArchived: true });
    var slug = slugify(name);
    if (existing.some(function (p) { return p.slug === slug; })) {
      throw new Error("a project called '" + name + "' already exists");
    }

    var rec = await store().put(TYPE, normalise(Object.assign({ name: name }, extra || {})));
    return await get(rec.id);
  }

  async function update(id, patch) {
    var current = await get(id);
    if (!current) throw new Error("no such project");
    var next = normalise(Object.assign({}, current, patch));
    /* The slug follows the name, but only while nothing has been
       exported under the old one — renaming is cheap, rewriting
       someone's filed changelogs is not. */
    if (patch && patch.name && patch.name !== current.name) next.slug = slugify(patch.name);
    await store().put(TYPE, next, { id: id });
    return await get(id);
  }

  async function remove(id) { return store().remove(id); }

  /* Modules that hang records off a project want them gone with it,
     but deleting someone else's records by surprise is worse than
     leaving orphans. So this reports rather than acts. */
  async function dependents(id, types) {
    var out = {};
    for (var i = 0; i < types.length; i++) {
      var rows = await store().list(types[i]);
      out[types[i]] = rows.filter(function (r) { return r.data && r.data.projectId === id; }).length;
    }
    return out;
  }

  FieldKit.provide("projects", {
    TYPE: TYPE,
    STATUSES: STATUSES,
    slugify: slugify,
    all: all,
    get: get,
    create: create,
    update: update,
    remove: remove,
    dependents: dependents
  });
})(window.FieldKit);
