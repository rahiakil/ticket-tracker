# Ticket Tracker

A separate mobile page for a short event. It is published only on GitHub Pages:

https://rahiakil.github.io/ticket-tracker/

People who are not signed in see: “For you, without login, we will not allow you.”

Sign in on that page with the one admin account. The username and password are single words and are checked in the browser. There is no Cloudflare worker and no other service.

A recognized QR looks like `order-12196-variant-992|993|997`. It is stored in the private file `rahiakil/ticket-tracker-data/scans.txt`. A code that does not match that pattern is Invalid QR. A new matching code is Scanned but not taken. Marking some variants makes it Partially taken. Marking all of them makes it Taken.

The phone writes that file with a GitHub token saved only in that browser. Create a fine-grained token that can access only `ticket-tracker-data`, with Contents set to read and write, then paste it into Private record token. Do not use an account-wide token.

**Seen** means a scan was saved on that phone. It does not prove that someone photographed the QR or received a product.

QR links look like `https://rahiakil.github.io/ticket-tracker/?c=<id>`. Opening the link does not mark it seen. After sign-in, tap **Confirm seen**. The camera starts only after **Scan QR**. Photos are decoded on the phone and are not uploaded.

`npm test` checks the scan rules in code. It does not open a phone camera.
