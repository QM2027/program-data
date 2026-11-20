# QM2027 program data

Publishes the Quark Matter 2027 program, talks and posters, as JSON on GitHub Pages:

**https://qm2027.github.io/program-data/index.json**

The visitor guide ([QM2027/qm2027.github.io](https://github.com/QM2027/qm2027.github.io)) loads
these files in the browser, so program updates reach the site without rebuilding it. Indico
stays the source of truth. This repository only reshapes the Indico data and applies urgent
corrections.

## Which event

The repository variable **`EVENT_ID`** chooses the Indico event. Set it under **Settings →
Secrets and variables → Actions → Variables**, then run the workflow.

| `EVENT_ID` | Publishes |
| --- | --- |
| unset or `1622375` | QM2027 |
| `1334113` | QM2025, to test the site with real data. The site labels it as a preview. |

Changing the event starts a fresh snapshot. The change history of the other event is not
carried over.

## Files

| File | What | Size (QM2025, gzip) |
| --- | --- | --- |
| `index.json` | `schema`, `eventId`, `tz`, `syncedAt` (last change), `checkedAt` (last successful check), counts, and the names of the two files below. The only file clients poll. | < 1 KB |
| `program.<hash>.json` | `sessions`, `contributions` (talks and posters), `unscheduled`, `breaks`, `tracks`, `changes` | 60 KB |
| `abstracts.<hash>.json` | `{ "<id>": { abstract, authors } }`. `authors` lists the authors who aren't speakers. | 317 KB |
| `materials.<hash>.json` | `{ "<id>": [{ title, url, kind, size, modified }] }`: direct links to the public slides and posters on Indico. `kind` is `pdf`, `slides`, `video`, `image`, `link` or `file`. | 26 KB |

- **Hashed files** never change, so clients can cache them for good. The previous version's
  files stay published next to the new ones.
- **Materials are a separate file** because speakers upload all week. A new upload changes only
  this file; the program file and `syncedAt` stay as they are.
- **Attachment links:** protected attachments are left out. A file re-uploaded under the same
  name keeps only its latest version. Indico resolves attachment links by attachment id, so a
  file replaced in place keeps working at the old link. A deleted and re-added file gets a new
  id: the site re-checks `index.json` when a contribution is opened, and always links the
  contribution page too.
- **Times** are ISO strings in the event's time zone (`tz`), even when Indico exports them in
  another zone. Slicing a time string gives the local wall-clock time.
- **Posters** are contributions with `poster: true`. A contribution is a poster when it belongs
  to a poster session. A session is a poster session when Indico flags it or most of its
  contributions are of a poster type. A poster takes the time of its session's first block;
  `slots` lists every block when there are several. A poster-type contribution scheduled in a
  talk session (a flash talk) stays a talk.
- **`unscheduled`** lists contributions that have no time yet and no poster session.
- **`changes`** lists recent changes. Kinds: `added`, `removed`, `moved` (time, room or board),
  `speaker`, `scheduled`, `unscheduled`. More than 20 changes of the same kind in one session
  collapse into one entry with `count` and `ids`.

## How it works

`.github/workflows/publish.yml` runs the tests and `scripts/sync.mjs`, then deploys `site/`:

| Trigger | When | Publishes |
| --- | --- | --- |
| Cloudflare Worker (dispatch with `scheduled`) | every 10 min, every 5 min on 15–28 March | if the program changed, or hourly to refresh `checkedAt` |
| push to `main` | e.g. after editing `overrides.json` | always |
| Actions → **Run workflow** | right after changing the timetable on Indico | always |

`scripts/sync.mjs` merges two public Indico exports:

- **timetable** (`/export/timetable/<id>.json`): sessions, breaks, and scheduled talks with their
  times and rooms.
- **contributions** (`/export/event/<id>.json?detail=contributions`): every contribution, with
  track, type, authors and abstract. Posters only appear here.

Nothing is committed. The published files serve as the previous snapshot, so the change history
carries over between runs.

When something goes wrong, the published program stays as it is:

- **Indico can't be reached.**
- **The program shrinks suspiciously:** sessions drop to zero, or contributions drop by more than
  30%. Check Indico, then publish anyway with **Run workflow** and **force** ticked.

GitHub's own scheduled runs start late and are often dropped, so a Cloudflare Worker cron
triggers the workflow through the API (`workflow_dispatch` with `scheduled: true`) instead.
There is no GitHub schedule in the workflow.

## Corrections

`overrides.json` patches sessions or contributions by id, for fixes that can't wait for Indico.
This includes board numbers while there is no other source for them:

```json
{
  "sessions": { "s6757551": { "room": "Halla Hall" } },
  "contributions": { "6289971": { "room": "Samda A", "board": "P-112" } }
}
```

- **Ids** are the `id` values in the program file.
- **Updates tab:** a patch that changes a time, room or board appears there.
- **Going live:** push the change and it is live within a few minutes.
- **Clean-up:** remove the patch once Indico is fixed.

## Run locally

Node 22 or later, no dependencies:

```bash
npm test
npm run sync                                         # QM2027 → site/
EVENT_ID=1334113 node scripts/sync.mjs --out qm2025  # QM2025, for testing the site
```

Running the sync again into the same folder uses that folder as the previous snapshot.

## Setup (once)

- **Organisation → Settings → Actions → General:** allow actions created by GitHub.
- **Settings → Pages → Source:** GitHub Actions.
- **Workflow permissions:** can stay read-only.
- **External cron:** a Cloudflare Worker dispatches this workflow with a fine-grained token
  (Actions: read and write on this repository). Renew the token before it expires.
