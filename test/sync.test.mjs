import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOverrides, buildProgram, diffPrograms, materialsOf, msToZonedIso, shrinkReason, text, zonedToMs } from "../scripts/lib.mjs";

const at = (date, time, tz = "Europe/Zurich") => ({ date, time, tz });

/** A small event: one talk session, one poster session in two blocks, one flash talk. */
function fixture() {
  const timetableDays = {
    20270322: {
      s1: {
        entryType: "Session", id: "s1", sessionId: 10, title: "Parallel 1", room: "Halla A",
        startDate: at("2027-03-22", "01:00:00"), endDate: at("2027-03-22", "02:30:00"), conveners: [],
        entries: {
          c100: { entryType: "Contribution", id: "c100", contributionId: 100, title: "Jet quenching", room: "Halla A", startDate: at("2027-03-22", "01:00:00"), endDate: at("2027-03-22", "01:20:00"), presenters: [{ firstName: "Ada", familyName: "Kim" }], url: "/event/1/contributions/100/" },
          c101: { entryType: "Contribution", id: "c101", contributionId: 101, title: "Flash: my poster", startDate: at("2027-03-22", "01:20:00"), endDate: at("2027-03-22", "01:25:00"), presenters: [] },
        },
      },
      p1: { entryType: "Session", id: "p1", sessionId: 20, title: "Poster session", startDate: at("2027-03-22", "07:00:00"), endDate: at("2027-03-22", "09:00:00"), conveners: [], entries: {} },
      p2: { entryType: "Session", id: "p2", sessionId: 20, title: "Poster session", startDate: at("2027-03-23", "07:00:00"), endDate: at("2027-03-23", "09:00:00"), conveners: [], entries: {} },
      b1: { entryType: "Break", id: "b1", title: "Coffee", startDate: at("2027-03-22", "02:30:00"), endDate: at("2027-03-22", "03:00:00") },
    },
  };
  const contributions = [
    { db_id: 100, friendly_id: 1, title: "Jet quenching", type: "Oral", session: "Parallel 1", track: "Jets", description: "<p>About &amp; $J/\\psi$ &#946;</p>", speakers: [], primaryauthors: [{ first_name: "Ada", last_name: "Kim" }], coauthors: [{ first_name: "Bo", last_name: "Lee" }] },
    { db_id: 101, friendly_id: 2, title: "Flash: my poster", type: "Poster", session: "Parallel 1", track: "Jets" },
    { db_id: 200, friendly_id: 3, title: "Poster A", type: "Poster", session: "Poster session", track: "Flow", speakers: [{ first_name: "Cy", last_name: "Park" }] },
    { db_id: 201, friendly_id: 4, title: "Poster B", type: "Poster", session: "Poster session", track: "Jets", board_number: "P-7" },
    { db_id: 300, friendly_id: 5, title: "Lost poster", type: "Poster", session: null },
    { db_id: 301, friendly_id: 6, title: "Plenary later", type: "Oral", session: "Parallel 1" },
  ];
  return { timetableDays, contributions, tz: "Asia/Seoul" };
}

test("times are converted to the event time zone", () => {
  // Indico exports QM2027 in Europe/Zurich; 00:30 CET is 08:30 KST.
  assert.equal(msToZonedIso(zonedToMs("2027-03-21", "00:30:00", "Europe/Zurich"), "Asia/Seoul"), "2027-03-21T08:30:00+09:00");
  // Across a DST change (Zurich switches on 28 March 2027).
  assert.equal(msToZonedIso(zonedToMs("2027-03-28", "03:30:00", "Europe/Zurich"), "Asia/Seoul"), "2027-03-28T10:30:00+09:00");
  const { program } = buildProgram(fixture());
  assert.equal(program.sessions.find((s) => s.id === "s1").start, "2027-03-22T09:00:00+09:00");
});

test("posters are placed by session; flash talks stay talks; the rest is unscheduled", () => {
  const { program } = buildProgram(fixture());
  const byId = new Map(program.contributions.map((c) => [c.id, c]));

  assert.equal(program.sessions.find((s) => s.id === "p1").poster, true);
  assert.equal(program.sessions.find((s) => s.id === "s1").poster, undefined);

  const a = byId.get("200");
  assert.equal(a.poster, true);
  assert.equal(a.sessionId, "p1");
  assert.deepEqual(a.slots, ["p1", "p2"]);
  assert.equal(a.start, "2027-03-22T15:00:00+09:00");
  assert.equal(byId.get("201").board, "P-7");

  assert.equal(byId.get("101").poster, undefined, "poster-type item in a talk session is a talk");
  assert.equal(byId.get("100").friendlyId, 1);
  assert.equal(byId.get("100").url, "https://indico.cern.ch/event/1/contributions/100/");

  assert.deepEqual(program.unscheduled.map((c) => [c.id, c.poster]), [["300", true], ["301", undefined]]);
  assert.deepEqual(program.tracks, ["Flow", "Jets"]);
  assert.equal(program.breaks.length, 1);
});

test("abstracts carry text and non-speaker authors", () => {
  const { abstracts } = buildProgram(fixture());
  assert.equal(abstracts["100"].abstract, "About & $J/\\psi$ β");
  assert.deepEqual(abstracts["100"].authors, ["Bo Lee"], "the speaker is not repeated as an author");
  assert.equal(abstracts["200"], undefined);
});

test("overrides patch by id and report unknown ids", () => {
  const { program } = buildProgram(fixture());
  const warnings = applyOverrides(program, { contributions: { 200: { board: "P-1" }, 300: { board: "P-2" }, 999: { room: "x" } } });
  assert.equal(program.contributions.find((c) => c.id === "200").board, "P-1");
  assert.equal(program.unscheduled.find((c) => c.id === "300").board, "P-2");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /999/);
});

test("diff reports moves, speakers, scheduling, and collapses a session-wide shuffle", () => {
  const prev = buildProgram(fixture()).program;
  const next = structuredClone(prev);
  const sessionsById = new Map(next.sessions.map((s) => [s.id, s]));

  next.contributions.find((c) => c.id === "100").room = "Halla B";
  next.contributions.find((c) => c.id === "101").speakers = [{ name: "New Person" }];
  const late = next.unscheduled.splice(next.unscheduled.findIndex((c) => c.id === "301"), 1)[0];
  next.contributions.push({ ...late, start: "2027-03-24T09:00:00+09:00", end: "2027-03-24T09:30:00+09:00" });

  const changes = diffPrograms(prev, next, "now", sessionsById);
  const kinds = Object.fromEntries(changes.map((c) => [c.id, c.kind]));
  assert.deepEqual(kinds, { 100: "moved", 101: "speaker", 301: "scheduled" });
  assert.deepEqual(changes.find((c) => c.id === "100").from, { start: "2027-03-22T09:00:00+09:00", room: "Halla A", board: undefined });

  // 25 posters in one session moving together become one entry.
  const many = structuredClone(prev);
  many.contributions = many.contributions.filter((c) => !c.poster);
  for (let i = 0; i < 25; i++) many.contributions.push({ id: `p${i}`, title: `P${i}`, start: "2027-03-22T15:00:00+09:00", end: "2027-03-22T17:00:00+09:00", sessionId: "p1", speakers: [], poster: true });
  const moved = structuredClone(many);
  for (const c of moved.contributions) if (c.poster) c.start = "2027-03-22T16:00:00+09:00";
  const collapsed = diffPrograms(many, moved, "now", sessionsById);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].count, 25);
  assert.equal(collapsed[0].ids.length, 25);
  assert.equal(collapsed[0].title, "Poster session");
});

test("a program that suddenly shrinks is not published", () => {
  const prev = buildProgram(fixture()).program;
  const empty = { ...prev, sessions: [], contributions: [], unscheduled: [] };
  assert.match(shrinkReason(prev, empty), /sessions dropped/);
  assert.match(shrinkReason(prev, { ...prev, contributions: prev.contributions.slice(0, 1), unscheduled: [] }), /contributions dropped/);
  assert.equal(shrinkReason(prev, prev), undefined);
  assert.equal(shrinkReason(undefined, empty), undefined);
});

test("materials: public direct links, latest of a re-upload, links and protected files", () => {
  const file = (id, title, extra = {}) => ({ id, type: "file", title, download_url: `https://indico.cern.ch/a/${id}/${title}`, content_type: "application/pdf", size: 1000, ...extra });
  const ev = {
    folders: [
      {
        is_protected: false,
        attachments: [
          file(1, "poster.pdf", { modified_dt: "2027-03-20T10:00:00" }),
          file(2, "poster.pdf", { modified_dt: "2027-03-21T10:00:00", size: 2000 }),
          file(3, "slides.pptx", { content_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }),
          { id: 4, type: "link", title: "Google slides", download_url: "https://indico.cern.ch/a/4/go", link_url: "https://docs.google.com/x" },
          file(5, "secret.pdf", { is_protected: true }),
        ],
      },
      { is_protected: true, attachments: [file(6, "hidden.pdf")] },
    ],
  };
  assert.deepEqual(materialsOf(ev), [
    { title: "poster.pdf", url: "https://indico.cern.ch/a/2/poster.pdf", kind: "pdf", size: 2000 },
    { title: "slides.pptx", url: "https://indico.cern.ch/a/3/slides.pptx", kind: "slides", size: 1000 },
    { title: "Google slides", url: "https://docs.google.com/x", kind: "link", size: undefined },
  ]);
  assert.deepEqual(materialsOf(undefined), []);

  const fx = fixture();
  fx.contributions.find((c) => c.db_id === 200).folders = ev.folders;
  const { materials } = buildProgram(fx);
  assert.deepEqual(Object.keys(materials), ["200"]);
});

test("html entities and tags are stripped", () => {
  assert.equal(text("a<br>b&nbsp;&lt;c&gt; &#x3b1; &unknown;"), "a\nb <c> α &unknown;");
});
