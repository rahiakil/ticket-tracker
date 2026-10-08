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

Use this if the main GitHub Pages URL is down. It is the same app and uses the **same Google Drive record** (`recordUrl`), so scans and locks stay one source of truth.

Open https://rahiakil.github.io/ticket-tracker/backup/ and sign in as usual. The order list comes from the same catalog and the same Drive text file as the main page.

The Drive file is viewable from your Google account. Sharing that file as “anyone with the link can view” lets someone look at the text. Updates from the phones go through the web app link. I did not create the Drive file.

A saved status means the shared Drive file has that order. It does not prove that someone photographed the QR or received a product. The camera starts only after **Scan QR**. Photos are decoded on the phone and are not uploaded.

`npm test` checks the scan rules in code. It does not open a phone camera.

## Print QR cards

`scripts/print-qr-cards.mjs` turns an order-list CSV into letter-size food coupons (entry lines and kids pizza are left off). Each coupon is a colored card with a QR of the last five digits of the order number.

```bash
npm run print-qr-cards -- "E:\Downloads\order_list_10_08_2026_.csv" "E:\Downloads\uttaron-qr-cards-10-08-2026.pdf" --sort --letter-page --nospace
```

| Flag | What it does |
| --- | --- |
| `--sort` | Sort by the first letter of the name, then full name, then item. This is the default. `--no-sort` keeps the CSV order. |
| `--letter-page` | Start a new page whenever the first letter changes, so A, B, and C are not mixed on one sheet. This is the default. `--no-letter-page` keeps filling the page. |
| `--nospace` | Shrink the page margin to 0.12 in and tighten the gap between cards. Use this when a normal print leaves a wide white border and you would otherwise scale to about 110%. |
| `--food-only` / `--entry-only` | Limit the sheet to one lane. Food is already the default because entry rows are skipped. |

Word has to be installed. The script writes an HTML file, then asks Word to save a PDF with those same margins so the border stays tight at 100% scale.
