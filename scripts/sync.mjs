#!/usr/bin/env node
// Build the QM2027 program snapshot from the public Indico exports and write site/program.json,
// which the publish workflow deploys to https://qm2027.github.io/program-data/program.json.
//
//   node scripts/sync.mjs                                           # QM2027
//   EVENT_ID=1334113 node scripts/sync.mjs --out /tmp/qm2025.json    # any public event (QM2025)
//
// Two exports are merged:
//   timetable      sessions, breaks and every scheduled talk with its time and room
//   contributions  every contribution, including posters, which Indico doesn't place in the
//                  timetable one by one. A poster takes the time of the poster session it belongs to.
// overrides.json is applied on top, for corrections that can't wait for Indico.
//
// The snapshot is never committed. The previous one is the published file (PREVIOUS_URL), so the
// change history carries over between runs and an Indico outage keeps what is live. This never
// fails the run: on any problem it keeps the previous snapshot, or writes an empty one. In GitHub
// Actions it sets the step output `changed=true|false` (whether the published file would change).

import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

const EVENT_ID = process.env.EVENT_ID ?? "1622375";
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : "site/program.json";
const PREVIOUS_URL = process.env.PREVIOUS_URL;
const OVERRIDES = new URL("../overrides.json", import.meta.url);
const BASE = "https://indico.cern.ch";
const MAX_CHANGES = 200;

function warn(msg) {
  console.warn(`::warning::sync: ${msg}. Keeping the previous snapshot.`);
}

/** "2027-03-22" + "09:00:00" in an IANA zone → ISO string with that zone's offset. */
function toIso({ date, time, tz }) {
  const naive = new Date(`${date}T${time}Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(naive)
      .map((p) => [p.type, p.value]),
  );
  const asLocal = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offsetMin = Math.round((asLocal - naive.getTime()) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `${date}T${time}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

const text = (html) =>
  (html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const isDateTime = (d) => d && typeof d.date === "string" && typeof d.time === "string" && typeof d.tz === "string";
const absUrl = (u) => (u ? (u.startsWith("http") ? u : `${BASE}${u}`) : undefined);
const isPosterType = (t) => /poster/i.test(t ?? "");

// The two exports spell people differently.
const ttPerson = (p) => ({ name: [p.firstName, p.familyName].filter(Boolean).join(" ") || p.name, affiliation: p.affiliation || undefined });
const evPerson = (p) => ({ name: [p.first_name, p.last_name].filter(Boolean).join(" ") || p.fullName, affiliation: p.affiliation || undefined });

/** Timetable export → sessions, breaks and scheduled contributions. */
function fromTimetable(days) {
  const sessions = [];
  const contributions = [];
  const breaks = [];
  const blocksByTitle = new Map(); // session title → its timetable blocks, for placing posters

  const addContribution = (c, sessionId) => {
    if (!isDateTime(c.startDate) || !isDateTime(c.endDate)) throw new Error(`contribution ${c.id} has no dates`);
    contributions.push({
      id: String(c.contributionId ?? c.id),
      title: c.title,
      start: toIso(c.startDate),
      end: toIso(c.endDate),
      room: c.room || undefined,
      sessionId,
      speakers: (c.presenters ?? []).map(ttPerson),
      abstract: text(c.description) || undefined,
      board: c.board_number || undefined,
      url: absUrl(c.url),
    });
  };

  for (const day of Object.values(days)) {
    for (const e of Object.values(day)) {
      if (!isDateTime(e.startDate) || !isDateTime(e.endDate)) throw new Error(`entry ${e.id} has no dates`);
      if (e.entryType === "Session") {
        const session = {
          id: String(e.id),
          title: e.slotTitle && e.slotTitle !== e.title ? `${e.title}: ${e.slotTitle}` : e.title,
          start: toIso(e.startDate),
          end: toIso(e.endDate),
          room: e.room || undefined,
          conveners: (e.conveners ?? []).map(ttPerson).map((p) => p.name),
          poster: Boolean(e.isPoster) || undefined,
          color: e.color || undefined,
          url: absUrl(e.url),
        };
        sessions.push(session);
        blocksByTitle.set(e.title, [...(blocksByTitle.get(e.title) ?? []), session]);
        for (const c of Object.values(e.entries ?? {})) {
          if (c.entryType === "Contribution") addContribution(c, session.id);
          else if (c.entryType === "Break") breaks.push({ title: c.title, start: toIso(c.startDate), end: toIso(c.endDate) });
        }
      } else if (e.entryType === "Contribution") {
        addContribution(e, undefined);
      } else if (e.entryType === "Break") {
        breaks.push({ title: e.title, start: toIso(e.startDate), end: toIso(e.endDate) });
      }
    }
  }
  return { sessions, contributions, breaks, blocksByTitle };
}

/**
 * Adds track and poster flags to scheduled talks, and adds the contributions the timetable leaves
 * out: posters, placed in the first block of their poster session.
 */
function mergeContributions(tt, all) {
  const byId = new Map(tt.contributions.map((c) => [c.id, c]));
  let unplaced = 0;

  for (const ev of all) {
    const id = String(ev.db_id ?? ev.id);
    const poster = isPosterType(ev.type);
    const scheduled = byId.get(id);
    if (scheduled) {
      scheduled.track = ev.track || undefined;
      if (poster) scheduled.poster = true;
      continue;
    }
    const block = tt.blocksByTitle.get(ev.session ?? "")?.slice().sort((a, b) => a.start.localeCompare(b.start))[0];
    const own = isDateTime(ev.startDate) && isDateTime(ev.endDate);
    if (!block && !own) {
      unplaced++;
      continue;
    }
    tt.contributions.push({
      id,
      title: ev.title,
      start: own ? toIso(ev.startDate) : block.start,
      end: own ? toIso(ev.endDate) : block.end,
      room: ev.room || undefined,
      sessionId: block?.id,
      speakers: (ev.speakers ?? []).map(evPerson),
      abstract: text(ev.description) || undefined,
      board: ev.board_number || undefined,
      track: ev.track || undefined,
      poster: poster || undefined,
      url: absUrl(ev.url),
    });
  }

  // A session is a poster session if Indico says so or its contributions are posters.
  const posterSessions = new Set(tt.contributions.filter((c) => c.poster && c.sessionId).map((c) => c.sessionId));
  for (const s of tt.sessions) if (posterSessions.has(s.id)) s.poster = true;
  return unplaced;
}

/** Shallow per-id patches: { "sessions": { "<id>": {...} }, "contributions": { "<id>": {...} } }. */
async function applyOverrides(program) {
  let overrides;
  try {
    overrides = JSON.parse(await readFile(OVERRIDES, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw new Error(`overrides.json is not valid JSON (${e.message})`);
  }
  for (const key of ["sessions", "contributions"]) {
    const patches = overrides[key] ?? {};
    for (const item of program[key]) if (patches[item.id]) Object.assign(item, patches[item.id]);
    const unknown = Object.keys(patches).filter((id) => !program[key].some((x) => x.id === id));
    if (unknown.length) console.warn(`::warning::overrides.json: no ${key} with id ${unknown.join(", ")}`);
  }
}

function diff(prev, next, detectedAt) {
  const before = new Map(prev.map((c) => [c.id, c]));
  const after = new Map(next.map((c) => [c.id, c]));
  const changes = [];
  for (const c of next) {
    const old = before.get(c.id);
    if (!old) changes.push({ id: c.id, title: c.title, kind: "added", detectedAt, start: c.start });
    else if (old.start !== c.start || old.room !== c.room)
      changes.push({ id: c.id, title: c.title, kind: "moved", detectedAt, from: { start: old.start, room: old.room }, start: c.start, room: c.room });
  }
  for (const c of prev) if (!after.has(c.id)) changes.push({ id: c.id, title: c.title, kind: "removed", detectedAt, start: c.start });
  return changes;
}

const empty = () => ({ eventId: EVENT_ID, syncedAt: "", sessions: [], contributions: [], breaks: [], changes: [] });
const isSnapshot = (p) =>
  p && p.eventId === EVENT_ID && ["sessions", "contributions", "breaks", "changes"].every((k) => Array.isArray(p[k]));

/** The published snapshot, or a local file when testing without PREVIOUS_URL. */
async function loadPrevious() {
  if (PREVIOUS_URL) {
    try {
      const res = await fetch(PREVIOUS_URL, { signal: AbortSignal.timeout(30_000), cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const live = await res.json();
      if (isSnapshot(live)) return live;
      console.log(`sync: ${PREVIOUS_URL} is not a snapshot for event ${EVENT_ID}; starting fresh`);
    } catch (e) {
      console.log(`sync: no published snapshot at ${PREVIOUS_URL} (${e.message}); starting fresh`);
    }
    return undefined;
  }
  try {
    const local = JSON.parse(await readFile(OUT, "utf8"));
    if (isSnapshot(local)) return local;
  } catch {}
  return undefined;
}

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

/** Both exports or nothing: a timetable without posters would look like hundreds of removals. */
async function fetchProgram() {
  let tt, ev;
  try {
    [tt, ev] = await Promise.all([getJson(`/export/timetable/${EVENT_ID}.json`), getJson(`/export/event/${EVENT_ID}.json?detail=contributions`)]);
  } catch (e) {
    return warn(`fetch failed (${e.message})`);
  }
  const days = tt?.results?.[EVENT_ID];
  const all = ev?.results?.[0]?.contributions;
  if (!days || typeof days !== "object" || !Array.isArray(all)) return warn("unexpected response shape");

  try {
    const parsed = fromTimetable(days);
    const unplaced = mergeContributions(parsed, all);
    const byStart = (a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title);
    const program = { sessions: parsed.sessions.sort(byStart), contributions: parsed.contributions.sort(byStart), breaks: parsed.breaks.sort(byStart) };
    await applyOverrides(program);
    const posters = program.contributions.filter((c) => c.poster).length;
    console.log(`sync: ${program.sessions.length} sessions, ${program.contributions.length - posters} talks, ${posters} posters` + (unplaced ? `, ${unplaced} unscheduled left out` : ""));
    return program;
  } catch (e) {
    return warn(`could not build the program (${e.message})`);
  }
}

async function write(snapshot) {
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(snapshot) + "\n");
}

/** Writes OUT and returns whether it differs from the previous snapshot. */
async function main() {
  const previous = await loadPrevious();
  const program = await fetchProgram();

  const content = (p) => JSON.stringify([p.sessions, p.contributions, p.breaks]);
  if (!program || (previous && content(previous) === content(program))) {
    if (program) console.log("sync: no changes");
    await write(previous ?? empty());
    return !previous;
  }

  const now = new Date().toISOString();
  // Only report changes against a previously published program, not the first import.
  const newChanges = previous?.contributions?.length ? diff(previous.contributions, program.contributions, now) : [];
  const changes = [...newChanges, ...(previous?.changes ?? [])].slice(0, MAX_CHANGES);
  await write({ eventId: EVENT_ID, syncedAt: now, ...program, changes });
  console.log(`sync: wrote ${OUT} (${newChanges.length} new changes)`);
  return true;
}

const changed = await main();
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
