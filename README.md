# Ticket Tracker

A separate mobile page for a short event. It is published only on GitHub Pages:

https://rahiakil.github.io/ticket-tracker/

People who are not signed in see: “For you, without login, we will not allow you.”

Sign in on that page with the one admin account. The username and password are single words and are checked in the browser. There is no Cloudflare worker and no other service.

Scans are saved in this phone’s browser for 3 days. Another phone keeps its own list. GitHub Pages cannot share one live file across phones without a separate server, and this event does not use one.

**Seen** means a scan was saved on that phone. It does not prove that someone photographed the QR or received a product.

QR links look like `https://rahiakil.github.io/ticket-tracker/?c=<id>`. Opening the link does not mark it seen. After sign-in, tap **Confirm seen**. The camera starts only after **Scan QR**. Photos are decoded on the phone and are not uploaded.

`npm test` checks the scan rules in code. It does not open a phone camera.
