# QM2027 program data

Publishes the Quark Matter 2027 program, including posters, as one JSON file:

**https://qm2027.github.io/program-data/program.json**

The visitor guide ([QM2027/qm2027.github.io](https://github.com/QM2027/qm2027.github.io)) loads
it in the browser, so program updates reach the site without rebuilding it. Indico stays the
source of truth. This repository only reshapes the Indico data and applies urgent corrections.

> **For now this publishes QM2025 (Indico event 1334113)**, so the site can be tested with real
> data. The site labels it as a preview. When the QM2027 timetable is on Indico, change
> `EVENT_ID` in `.github/workflows/publish.yml` to `1622375`.

## How it works

`.github/workflows/publish.yml` runs `scripts/sync.mjs` and deploys `site/program.json` to
GitHub Pages:

| Trigger | When | Publishes |
| --- | --- | --- |
| schedule | every 6 h, every 5 min on 15–28 March | only if the program changed |
| push to `main` | e.g. after editing `overrides.json` | always |
| Actions → **Run workflow** | right after changing the timetable on Indico | always |

The script merges two public Indico exports:

- **timetable** (`/export/timetable/<id>.json`): sessions, breaks, and each talk's time and room.
- **contributions** (`/export/event/<id>.json?detail=contributions`): every contribution.
  Posters only appear here. Each poster takes the time of the first block of its poster session.

Nothing is committed. The previously published `program.json` serves as the previous snapshot:
the `changes` list (moved / added / removed) carries over from it, and if Indico fails the
published file stays as it is. GitHub's scheduled runs can start several minutes late.

## Corrections

`overrides.json` patches sessions or contributions by id, for fixes that can't wait for Indico:

```json
{
  "sessions": { "s6757551": { "room": "Halla Hall" } },
  "contributions": { "6289971": { "room": "Samda A", "board": "P-112" } }
}
```

Ids are the `id` values in `program.json`. A patch that changes a time or room appears in the
site's Updates tab. Push the change and it is live within a few minutes. Remove the patch once
Indico is fixed.

## Run locally

Node 22 or later, no dependencies:

```bash
npm run sync                                            # QM2027 → site/program.json
EVENT_ID=1334113 node scripts/sync.mjs --out qm2025.json # QM2025, for testing the site
```

## Setup (once)

- **Settings → Pages → Source:** GitHub Actions.
- Workflow permissions can stay read-only.
- GitHub disables scheduled workflows after 60 days without repository activity. Check the
  Actions tab before the conference.
