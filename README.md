# Ticket Tracker

A separate mobile page for a short event. It is published only on GitHub Pages:

https://rahiakil.github.io/ticket-tracker/

Backup page (same features, separate Drive record):

https://rahiakil.github.io/ticket-tracker/backup/

People who are not signed in see: “For you, without login, we will not allow you.”

Sign in on that page with the one admin account. The username and password are single words and are checked in the browser. The page stays on GitHub Pages. The order list is the text file in Google Drive.

A recognized QR looks like `order-12196-variant-992|993|997`. It is stored in a text file in your Google Drive, `ticket-tracker-scans.txt`. A code that does not match that pattern is Invalid QR. A new matching code is Scanned but not taken. Marking some variants makes it Partially taken. Marking all of them makes it Taken.

Anyone with the web app link can read and change that file. The page still asks for the siteadmin login before showing the scanner.

## Google Drive record

The shared folder is https://drive.google.com/drive/folders/1r679tCaeKA5-y4sXuUEX3xB2GCxx7Xg7?usp=sharing. It is named TicketTracker and is currently empty. The scan text file is created inside that folder.

1. Open https://script.google.com while signed in as the owner of that folder.
2. New project, then paste `scripts/google-record.gs`.
3. Deploy, Manage deployments, New deployment, type Web app.
4. Execute as Me. Who has access: Anyone.
5. Authorize Drive access.
6. Copy the web app URL that ends in `/exec`.
7. On the Ticket Tracker page, paste that URL into Google record link and tap Save link on this phone.

## Backup page

Use this if the main page or its Drive record is down. The backup page is the same app with its own config and its own scan file.

1. Open https://script.google.com and create a **new** project (do not reuse the main one).
2. Paste `scripts/google-record-backup.gs`.
3. Deploy as a Web app the same way: Execute as Me, Who has access Anyone.
4. Copy the `/exec` URL into `web/backup/config.js` as `recordUrl`, or paste it on the backup page under Google record link.
5. Open https://rahiakil.github.io/ticket-tracker/backup/ and sign in as usual.

The backup writes `ticket-tracker-scans-backup.txt` in the TicketTracker folder. It does not share live state with the main page. Switch everyone to the backup page only when the main one is unavailable.

The Drive file is viewable from your Google account. Sharing that file as “anyone with the link can view” lets someone look at the text. Updates from the phones go through the web app link. I did not create the Drive file.

A saved status means the shared Drive file has that order. It does not prove that someone photographed the QR or received a product. The camera starts only after **Scan QR**. Photos are decoded on the phone and are not uploaded.

`npm test` checks the scan rules in code. It does not open a phone camera.
