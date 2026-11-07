---
name: archive-event-analytics
description: >-
  File a Uttoron event day into the site-admin archive and a Drive-ready folder.
  Use when the user asks to archive an event, sort a door log by date, classify
  desk and food activity, file Kali Pujo, Sharodotsav, or the External Artist
  Gala, or prepare analytics for Google Drive.
---

# Archive event analytics

File one event from the dates the user gives. Site admin sees it under Past events. Volunteer and desk phones do not load these files.

## What the user supplies

They give the dates, and usually the event name. Infer the id from the name (`kali-pujo-2027`). If the name or dates are missing, ask once, then file.

## Classify

Use only these generic buckets. Do not invent sections.

- **Desk:** scans, entry marked, entry reverted, new sales, sale changes, Bhoomi books, practice-scan clears.
- **Food:** food picked up, food reverted.

Sort from the morning of the first date forward, hour by hour in Pacific time. Inside each hour, sort guest names A to Z.

## File it

From the `ticket-tracker` repo:

```bash
node scripts/file-event.mjs --id <id> --name "<Event name>" --when "<label>" --dates YYYY-MM-DD
```

Repeat `--dates` for each day they named. The script reads the live door log, keeps those Pacific dates, classifies desk and food, and writes:

- `web/archive/events/<id>/summary.json` and updates `web/archive/events/index.json` (site admin Past events)
- `reports/<id>/` with `desk.csv`, `food.csv`, and `summary.json` for Google Drive

An empty log still creates the folder and marks it upcoming, the same way Kali Pujo is held for November 8, 2027.

Show the user the hour-by-hour counts, morning forward, and the two paths. Commit and push the `web/archive/events` update only when they ask the site to publish it.

## Google Drive

Do not ask for a password or token. This environment has no Google Drive connection, so do not upload. Tell them to upload `reports/<id>/`. If a Drive tool is actually available in the session, upload that folder and return the link.
