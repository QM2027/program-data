#!/usr/bin/env node
// Build the program from the public Indico exports into site/, which the publish workflow
// deploys to https://qm2027.github.io/program-data/.
//
//   node scripts/sync.mjs                                   # QM2027 → site/
//   EVENT_ID=1334113 node scripts/sync.mjs --out /tmp/qm25  # any public event (QM2025)
//
// Output (schema 2):
//   index.json                 small, the only file clients poll: names the two files below
//   program.<hash>.json        sessions, contributions (talks and posters), unscheduled, breaks,
//                              tracks, changes
//   abstracts.<hash>.json      { id: { abstract, authors } }, loaded after the program
//   materials.<hash>.json      { id: [{ title, url, kind, size }] }: direct links to the slides and
//                              posters on Indico. Separate because uploads continue all week.
// Hashed files never change, so clients can cache them for good. The previous version's files
// are published too, so a client holding the old index.json doesn't hit a 404 mid-deploy.
//
// The previous snapshot is the published one (PREVIOUS_URL), so nothing is committed. This
// never fails the run: if Indico fails or the program shrinks suspiciously, it keeps what is
// published (FORCE=true overrides the shrink check). In GitHub Actions it sets the step output
// `publish=true|false`: true when the content changed, or when the published `checkedAt` is
// older than an hour (a heartbeat, so the site can tell a stalled sync from a quiet program).

import { readFile, writeFile, mkdir, rm, appendFile } from "node:fs/promises";
import { join } from "node:path";
import {
  INDICO,
  SCHEMA,
  applyOverrides,
  buildProgram,
  contentKey,
  diffPrograms,
  hashName,
  mergeChanges,
  shrinkReason,
} from "./lib.mjs";

const EVENT_ID = process.env.EVENT_ID ?? "1622375";
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : "site";
const PREVIOUS_URL = process.env.PREVIOUS_URL?.replace(/\/$/, "");
const FORCE = process.env.FORCE === "true";
const HEARTBEAT_MS = 60 * 60_000;
const OVERRIDES = new URL("../overrides.json", import.meta.url);

const warn = (msg) => console.warn(`::warning::sync: ${msg}`);

async function getJson(url, timeout = 120_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout), cache: "no-store" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** The published snapshot ({ index, core, abstracts, files }), or undefined. */
async function loadPrevious() {
  const read = PREVIOUS_URL
    ? (name) => getJson(`${PREVIOUS_URL}/${name}`, 30_000)
    : async (name) => JSON.parse(await readFile(join(OUT, name), "utf8"));
  try {
    const index = await read("index.json");
    if (index.schema !== SCHEMA || index.eventId !== EVENT_ID) {
      console.log(`sync: published snapshot is for event ${index.eventId}, schema ${index.schema}; starting fresh`);
      return undefined;
    }
    const [core, abstracts, materials] = await Promise.all([read(index.program), read(index.abstracts), index.materials ? read(index.materials) : {}]);
    const files = { [index.program]: core, [index.abstracts]: abstracts, ...(index.materials ? { [index.materials]: materials } : {}) };
    return { index, core, abstracts, materials, files };
  } catch (e) {
    console.log(`sync: no previous snapshot (${e.message}); starting fresh`);
    return undefined;
  }
}

/** Both exports or nothing: a timetable without posters would look like hundreds of removals. */
async function fetchIndico() {
  try {
    const [tt, ev] = await Promise.all([
      getJson(`${INDICO}/export/timetable/${EVENT_ID}.json`),
      getJson(`${INDICO}/export/event/${EVENT_ID}.json?detail=contributions`),
    ]);
    const timetableDays = tt?.results?.[EVENT_ID];
    const event = ev?.results?.[0];
    if (!timetableDays || typeof timetableDays !== "object" || !Array.isArray(event?.contributions)) throw new Error("unexpected response shape");
    return { timetableDays, contributions: event.contributions, tz: event.timezone || "UTC" };
  } catch (e) {
    warn(`Indico fetch failed (${e.message}); keeping the published program`);
    return undefined;
  }
}

async function readOverrides() {
  try {
    return JSON.parse(await readFile(OVERRIDES, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw new Error(`overrides.json is not valid JSON (${e.message})`);
  }
}

async function writeSite(index, files) {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  for (const [name, data] of Object.entries(files)) await writeFile(join(OUT, name), JSON.stringify(data));
  await writeFile(join(OUT, "index.json"), JSON.stringify(index, null, 1) + "\n");
}

async function main() {
  const previous = await loadPrevious();
  const now = new Date().toISOString();
  const keepPublished = async () => {
    if (previous) await writeSite(previous.index, previous.files);
    else await writeSite(...emptySite(now));
    return !previous; // first run: publish the empty site so the URL exists
  };

  const indico = await fetchIndico();
  if (!indico) return keepPublished();

  let built;
  try {
    built = buildProgram(indico);
    for (const w of applyOverrides(built.program, await readOverrides())) warn(w);
  } catch (e) {
    warn(`could not build the program (${e.message}); keeping the published program`);
    return keepPublished();
  }
  const { program, abstracts, materials } = built;
  const posters = program.contributions.filter((c) => c.poster).length;
  console.log(
    `sync: event ${EVENT_ID} (${indico.tz}): ${program.sessions.length} sessions, ${program.contributions.length - posters} talks, ` +
      `${posters} posters, ${program.unscheduled.length} unscheduled, ${program.tracks.length} tracks, ` +
      `${Object.values(materials).flat().length} attachments`,
  );

  const shrink = shrinkReason(previous?.core, program);
  if (shrink && !FORCE) {
    warn(`${shrink}; not publishing. Run the workflow with force to publish anyway`);
    return keepPublished();
  }

  const sameProgram = previous && contentKey(previous.core) === contentKey(program);
  const sameAbstracts = previous && JSON.stringify(previous.abstracts) === JSON.stringify(abstracts);
  const sameMaterials = previous && JSON.stringify(previous.materials) === JSON.stringify(materials);
  if (sameProgram && sameAbstracts && sameMaterials) {
    const stale = Date.now() - Date.parse(previous.index.checkedAt) > HEARTBEAT_MS;
    console.log(`sync: no changes${stale ? "; refreshing checkedAt" : ""}`);
    await writeSite({ ...previous.index, checkedAt: now }, previous.files);
    return stale;
  }

  const sessionsById = new Map(program.sessions.map((s) => [s.id, s]));
  const fresh = previous && !sameProgram ? diffPrograms(previous.core, program, now, sessionsById) : [];
  // The program file (and its syncedAt) only changes with the program: new abstracts or uploads
  // alone don't make every client download it again.
  const core = sameProgram
    ? previous.core
    : { schema: SCHEMA, eventId: EVENT_ID, tz: indico.tz, syncedAt: now, ...program, changes: mergeChanges(fresh, previous?.core.changes) };
  const coreJson = JSON.stringify(core);
  const absJson = JSON.stringify(abstracts);
  const matJson = JSON.stringify(materials);
  const index = {
    schema: SCHEMA,
    eventId: EVENT_ID,
    tz: indico.tz,
    syncedAt: core.syncedAt,
    checkedAt: now,
    counts: { talks: program.contributions.length - posters, posters, unscheduled: program.unscheduled.length },
    program: hashName("program", coreJson),
    abstracts: hashName("abstracts", absJson),
    materials: hashName("materials", matJson),
  };
  await writeSite(index, { ...previous?.files, [index.program]: core, [index.abstracts]: abstracts, [index.materials]: materials });
  console.log(
    `sync: wrote ${OUT}/ (${fresh.length} new changes; program ${coreJson.length} B, abstracts ${absJson.length} B, materials ${matJson.length} B)`,
  );
  return true;
}

function emptySite(now) {
  const core = { schema: SCHEMA, eventId: EVENT_ID, tz: "UTC", syncedAt: "", sessions: [], contributions: [], unscheduled: [], breaks: [], tracks: [], changes: [] };
  const index = {
    schema: SCHEMA,
    eventId: EVENT_ID,
    tz: "UTC",
    syncedAt: "",
    checkedAt: now,
    counts: { talks: 0, posters: 0, unscheduled: 0 },
    program: hashName("program", JSON.stringify(core)),
    abstracts: hashName("abstracts", "{}"),
    materials: hashName("materials", "{}"),
  };
  return [index, { [index.program]: core, [index.abstracts]: {}, [index.materials]: {} }];
}

const publish = await main();
console.log(`sync: publish=${publish}`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `publish=${publish}\n`);
