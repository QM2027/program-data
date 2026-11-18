// Pure functions behind scripts/sync.mjs: Indico exports in, program snapshot out. No I/O here,
// so test/sync.test.mjs can run them on small fixtures.

import { createHash } from "node:crypto";

export const SCHEMA = 2;
export const INDICO = "https://indico.cern.ch";
const MAX_CHANGES = 300;
/** More same-kind changes than this in one session collapse into one entry. */
const COLLAPSE_OVER = 20;
/** A scheduled run refuses to publish if contributions shrink by more than this share. */
const MAX_SHRINK = 0.3;

// ---------------------------------------------------------------------------------------------
// Time: Indico exports may use the server's zone (Europe/Zurich) instead of the event's, so every
// time is converted to the event time zone and written with that zone's offset. The site slices
// the ISO strings for wall-clock values, so they must already be event-local.

function zoneParts(ms, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return p;
}

function offsetMin(ms, tz) {
  const p = zoneParts(ms, tz);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms) / 60000);
}

/** Wall-clock date and time in `tz` → epoch ms. */
export function zonedToMs(date, time, tz) {
  const guess = Date.parse(`${date}T${time}Z`);
  let ms = guess - offsetMin(guess, tz) * 60000;
  const again = guess - offsetMin(ms, tz) * 60000; // settles DST edges
  if (again !== ms) ms = again;
  return ms;
}

/** Epoch ms → "YYYY-MM-DDTHH:MM:SS+HH:MM" in `tz`. */
export function msToZonedIso(ms, tz) {
  const p = zoneParts(ms, tz);
  const off = offsetMin(ms, tz);
  const abs = Math.abs(off);
  const sign = off >= 0 ? "+" : "-";
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

const isDateTime = (d) => d && typeof d.date === "string" && typeof d.time === "string" && typeof d.tz === "string";
const iso = (d, tz) => msToZonedIso(zonedToMs(d.date, d.time, d.tz), tz);

// ---------------------------------------------------------------------------------------------
// Text and people

const ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export const text = (html) =>
  (html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
      e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m),
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const absUrl = (u) => (u ? (u.startsWith("http") ? u : `${INDICO}${u}`) : undefined);
const isPosterType = (t) => /poster/i.test(t ?? "");

// The two exports spell people differently.
const ttPerson = (p) => ({ name: [p.firstName, p.familyName].filter(Boolean).join(" ") || p.name, affiliation: p.affiliation || undefined });
const evName = (p) => [p.first_name, p.last_name].filter(Boolean).join(" ") || p.fullName;
const evPerson = (p) => ({ name: evName(p), affiliation: p.affiliation || undefined });

/** Authors who aren't speakers, names only (they go in the abstracts file). */
function otherAuthors(ev, speakers) {
  const speaking = new Set(speakers.map((s) => s.name));
  const names = [...(ev.primaryauthors ?? []), ...(ev.coauthors ?? [])].map(evName).filter((n) => n && !speaking.has(n));
  return [...new Set(names)];
}

// ---------------------------------------------------------------------------------------------
// Build

/**
 * Merges the timetable export (sessions, breaks, scheduled talks) with the contributions export
 * (every contribution; posters only appear there) into the published shape.
 *
 * Posters are decided by placement: a contribution is a poster when it sits in a poster session.
 * A session is a poster session when Indico flags it or most of its contributions are of a
 * poster type. A poster-type item scheduled in a talk session (a flash talk) stays a talk.
 */
export function buildProgram({ timetableDays, contributions: all, tz }) {
  const evById = new Map(all.map((c) => [String(c.db_id ?? c.id), c]));

  // Contribution types per session title, to recognise poster sessions.
  const posterShare = new Map();
  for (const c of all) {
    if (!c.session) continue;
    const s = posterShare.get(c.session) ?? { posters: 0, total: 0 };
    s.total++;
    if (isPosterType(c.type)) s.posters++;
    posterShare.set(c.session, s);
  }
  const isPosterTitle = (title) => {
    const s = posterShare.get(title);
    return Boolean(s && s.posters > s.total / 2);
  };

  const sessions = [];
  const contributions = [];
  const breaks = [];
  const blocksByTitle = new Map();
  const placed = new Set();

  const talk = (c, session) => {
    if (!isDateTime(c.startDate) || !isDateTime(c.endDate)) throw new Error(`contribution ${c.id} has no dates`);
    const id = String(c.contributionId ?? c.id);
    const ev = evById.get(id);
    placed.add(id);
    contributions.push({
      id,
      friendlyId: ev?.friendly_id ?? c.friendlyId ?? undefined,
      title: c.title,
      start: iso(c.startDate, tz),
      end: iso(c.endDate, tz),
      room: c.room || undefined,
      sessionId: session?.id,
      speakers: (c.presenters ?? []).map(ttPerson),
      board: c.board_number || ev?.board_number || undefined,
      track: ev?.track || undefined,
      poster: session?.poster || undefined,
      url: absUrl(c.url ?? ev?.url),
    });
  };

  for (const day of Object.values(timetableDays)) {
    for (const e of Object.values(day)) {
      if (!isDateTime(e.startDate) || !isDateTime(e.endDate)) throw new Error(`entry ${e.id} has no dates`);
      if (e.entryType === "Session") {
        const session = {
          id: String(e.id),
          group: e.sessionId != null ? String(e.sessionId) : undefined,
          title: e.slotTitle && e.slotTitle !== e.title ? `${e.title}: ${e.slotTitle}` : e.title,
          start: iso(e.startDate, tz),
          end: iso(e.endDate, tz),
          room: e.room || undefined,
          conveners: (e.conveners ?? []).map(ttPerson).map((p) => p.name),
          poster: Boolean(e.isPoster) || isPosterTitle(e.title) || undefined,
          color: e.color || undefined,
          url: absUrl(e.url),
        };
        sessions.push(session);
        blocksByTitle.set(e.title, [...(blocksByTitle.get(e.title) ?? []), session]);
        for (const c of Object.values(e.entries ?? {})) {
          if (c.entryType === "Contribution") talk(c, session);
          else if (c.entryType === "Break") breaks.push({ title: c.title, start: iso(c.startDate, tz), end: iso(c.endDate, tz) });
        }
      } else if (e.entryType === "Contribution") {
        talk(e, undefined);
      } else if (e.entryType === "Break") {
        breaks.push({ title: e.title, start: iso(e.startDate, tz), end: iso(e.endDate, tz) });
      }
    }
  }

  // Contributions the timetable leaves out: posters go into their poster session's blocks, the
  // rest are listed as unscheduled until Indico gives them a time.
  const unscheduled = [];
  for (const [id, ev] of evById) {
    if (placed.has(id)) continue;
    const speakers = (ev.speakers ?? []).map(evPerson);
    const base = {
      id,
      friendlyId: ev.friendly_id ?? undefined,
      title: ev.title,
      room: ev.room || undefined,
      speakers,
      board: ev.board_number || undefined,
      track: ev.track || undefined,
      url: absUrl(ev.url),
    };
    const blocks = (blocksByTitle.get(ev.session ?? "") ?? []).slice().sort((a, b) => a.start.localeCompare(b.start));
    const inPosterSession = blocks.length > 0 && blocks[0].poster;
    if (inPosterSession) {
      contributions.push({
        ...base,
        start: blocks[0].start,
        end: blocks[0].end,
        sessionId: blocks[0].id,
        slots: blocks.length > 1 ? blocks.map((b) => b.id) : undefined,
        poster: true,
      });
    } else if (isDateTime(ev.startDate) && isDateTime(ev.endDate)) {
      contributions.push({ ...base, start: iso(ev.startDate, tz), end: iso(ev.endDate, tz), sessionId: blocks[0]?.id, poster: undefined });
    } else {
      unscheduled.push({ ...base, session: ev.session || undefined, poster: isPosterType(ev.type) || undefined });
    }
  }

  const byStart = (a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title);
  const byTitle = (a, b) => a.title.localeCompare(b.title);
  const tracks = [...new Set([...contributions, ...unscheduled].map((c) => c.track).filter(Boolean))].sort();

  const abstracts = {};
  for (const c of [...contributions, ...unscheduled]) {
    const ev = evById.get(c.id);
    if (!ev) continue;
    const abstract = text(ev.description) || undefined;
    const authors = otherAuthors(ev, c.speakers);
    if (abstract || authors.length) abstracts[c.id] = { abstract, authors: authors.length ? authors : undefined };
  }

  const materials = {};
  for (const c of [...contributions, ...unscheduled]) {
    const files = materialsOf(evById.get(c.id));
    if (files.length) materials[c.id] = files;
  }

  return {
    program: {
      sessions: sessions.sort(byStart),
      contributions: contributions.sort(byStart),
      unscheduled: unscheduled.sort(byTitle),
      breaks: breaks.sort(byStart),
      tracks,
    },
    abstracts,
    materials,
  };
}

function kindOf(a) {
  if (a.type === "link") return "link";
  const t = a.content_type ?? "";
  if (t === "application/pdf") return "pdf";
  if (/presentation|powerpoint|keynote/.test(t)) return "slides";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("image/")) return "image";
  return "file";
}

/**
 * Public attachments as direct links: { title, url, kind, size?, modified? }. Protected ones are
 * left out, since the link would only show a login page. A file uploaded twice under the same
 * name keeps its latest version. `modified` (Indico's modified_dt) lets the site mark files that
 * changed since a visitor last looked.
 */
export function materialsOf(ev) {
  const byTitle = new Map();
  for (const folder of ev?.folders ?? []) {
    if (folder.is_protected) continue;
    for (const a of folder.attachments ?? []) {
      if (a.is_protected) continue;
      const url = a.type === "link" ? a.link_url : a.download_url;
      if (!url) continue;
      const title = a.title || a.filename || "Attachment";
      const old = byTitle.get(title);
      if (old && (old.modified ?? "") > (a.modified_dt ? a.modified_dt.slice(0, 19) + "Z" : "")) continue;
      byTitle.set(title, {
        title,
        url,
        kind: kindOf(a),
        size: a.type === "link" ? undefined : a.size || undefined,
        modified: a.modified_dt ? a.modified_dt.slice(0, 19) + "Z" : undefined,
      });
    }
  }
  return [...byTitle.values()];
}

/** Shallow per-id patches: { "sessions": { "<id>": {...} }, "contributions": { "<id>": {...} } }. */
export function applyOverrides(program, overrides) {
  const warnings = [];
  for (const key of ["sessions", "contributions"]) {
    const patches = overrides?.[key] ?? {};
    const items = key === "contributions" ? [...program.contributions, ...program.unscheduled] : program.sessions;
    const ids = new Set(items.map((x) => x.id));
    for (const item of items) if (patches[item.id]) Object.assign(item, patches[item.id]);
    const unknown = Object.keys(patches).filter((id) => !ids.has(id));
    if (unknown.length) warnings.push(`overrides.json: no ${key} with id ${unknown.join(", ")}`);
  }
  return warnings;
}

// ---------------------------------------------------------------------------------------------
// Changes

const speakerKey = (c) => c.speakers.map((s) => s.name).join(", ");

/**
 * Changes between two published programs. Kinds: added, removed, moved (time, room or board),
 * speaker, scheduled (got a time), unscheduled (lost it). Title and abstract edits are ignored.
 * A session-wide shuffle (more than COLLAPSE_OVER same-kind changes in one session, e.g. a poster
 * block moving) becomes one entry with the session's title, a count and the affected ids.
 */
export function diffPrograms(prev, next, detectedAt, sessionsById) {
  const scheduledBefore = new Map(prev.contributions.map((c) => [c.id, c]));
  const unscheduledBefore = new Map((prev.unscheduled ?? []).map((c) => [c.id, c]));
  const scheduledAfter = new Map(next.contributions.map((c) => [c.id, c]));
  const unscheduledAfter = new Map(next.unscheduled.map((c) => [c.id, c]));
  const raw = [];

  for (const c of next.contributions) {
    const old = scheduledBefore.get(c.id);
    if (!old) {
      raw.push({ id: c.id, title: c.title, kind: unscheduledBefore.has(c.id) ? "scheduled" : "added", detectedAt, start: c.start, room: c.room, sessionId: c.sessionId });
    } else if (old.start !== c.start || old.room !== c.room || old.board !== c.board) {
      raw.push({ id: c.id, title: c.title, kind: "moved", detectedAt, from: { start: old.start, room: old.room, board: old.board }, start: c.start, room: c.room, board: c.board, sessionId: c.sessionId });
    } else if (speakerKey(old) !== speakerKey(c)) {
      raw.push({ id: c.id, title: c.title, kind: "speaker", detectedAt, from: { speakers: speakerKey(old) }, speakers: speakerKey(c), start: c.start, sessionId: c.sessionId });
    }
  }
  for (const c of prev.contributions) {
    if (scheduledAfter.has(c.id)) continue;
    raw.push({ id: c.id, title: c.title, kind: unscheduledAfter.has(c.id) ? "unscheduled" : "removed", detectedAt, start: c.start, sessionId: c.sessionId });
  }
  for (const c of prev.unscheduled ?? []) {
    if (!scheduledAfter.has(c.id) && !unscheduledAfter.has(c.id)) raw.push({ id: c.id, title: c.title, kind: "removed", detectedAt });
  }
  for (const c of next.unscheduled) {
    if (!scheduledBefore.has(c.id) && !unscheduledBefore.has(c.id)) raw.push({ id: c.id, title: c.title, kind: "added", detectedAt });
  }

  const groups = new Map();
  for (const ch of raw) {
    const key = ch.sessionId ? `${ch.kind}|${ch.sessionId}` : `${ch.kind}|${ch.id}`;
    groups.set(key, [...(groups.get(key) ?? []), ch]);
  }
  const out = [];
  for (const list of groups.values()) {
    if (list.length <= COLLAPSE_OVER || !list[0].sessionId) {
      out.push(...list);
      continue;
    }
    const first = list[0];
    const session = sessionsById.get(first.sessionId);
    const from = first.from && first.kind === "moved" ? { start: prevSessionStart(prev, first.sessionId) ?? first.from.start, room: first.from.room } : undefined;
    out.push({
      id: first.sessionId,
      title: session?.title ?? first.title,
      kind: first.kind,
      detectedAt,
      sessionId: first.sessionId,
      count: list.length,
      ids: list.map((c) => c.id),
      start: session?.start ?? first.start,
      room: session?.room ?? first.room,
      from,
    });
  }
  return out;
}

function prevSessionStart(prev, sessionId) {
  return prev.sessions?.find((s) => s.id === sessionId)?.start;
}

export const mergeChanges = (fresh, older) => [...fresh, ...(older ?? [])].slice(0, MAX_CHANGES);

/** Why a scheduled run should not publish `next` over `prev`, or undefined. */
export function shrinkReason(prev, next) {
  if (!prev) return undefined;
  const before = prev.contributions.length + (prev.unscheduled?.length ?? 0);
  const after = next.contributions.length + next.unscheduled.length;
  if (prev.sessions.length > 0 && next.sessions.length === 0) return `sessions dropped from ${prev.sessions.length} to 0`;
  if (before > 0 && after < before * (1 - MAX_SHRINK)) return `contributions dropped from ${before} to ${after}`;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Files

/** Same content, same name: hashed files can be cached forever. */
export const hashName = (prefix, json) => `${prefix}.${createHash("sha256").update(json).digest("hex").slice(0, 10)}.json`;

/** What a program comparison looks at: everything except bookkeeping. */
export const contentKey = (core) => JSON.stringify([core.sessions, core.contributions, core.unscheduled, core.breaks]);
