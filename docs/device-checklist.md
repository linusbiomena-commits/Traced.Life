# TRACED: Physical device and label-printer checklist (Phase 7)

**Status: no physical device or printer has been tested.** All automated tests use Microsoft Edge on Windows with a simulated camera and a simulated print call. Nothing in this repository may claim compatibility with a phone, tablet, scanner or printer until a row below is filled in by a named tester with the date. Test on staging (HTTPS) with synthetic data only, never real patients.

Detailed staff-scanner steps: `docs/device-testing.md`. This checklist adds the laboratory, labels, printers and branch conditions.

## 1. Devices to approve

| Role | Device class | Minimum to test | Result | Tester / date |
|---|---|---|---|---|
| Collection staff | Android phone (Chrome) | 1 current + 1 older (2–3 years) | | |
| Collection staff | iPhone (Safari, iOS ≥ 15) | 1 | | |
| Collection staff | Tablet at the counter (Android or iPad) | 1 | | |
| Collection staff | Windows PC + USB webcam (Edge/Chrome) | 1 | | |
| Collection staff | USB / Bluetooth keyboard-wedge QR scanner | the model Wareed uses | | |
| Laboratory | Windows/macOS PC + webcam or handheld scanner | the lab's setup | | |
| Admin | Desktop browsers (Edge, Chrome, Safari, Firefox) | latest | | |
| Customer | Phones showing the QR (bright/dim screen), printed QR | Android, iPhone, paper | | |

## 2. Scanning cases (each staff/lab device)

| # | Case | Expected | Pass? |
|---|---|---|---|
| 1 | Customer QR on a phone screen, normal light | decoded ≤ 2 s; camera light off after the read; age + gender only | |
| 2 | Same, low light / glare / cracked screen protector | decodes or manual entry works | |
| 3 | Printed customer QR (A4, home printer) | decodes | |
| 4 | Sample label QR (50 × 30 mm) on a sample bag, curved surface | decodes | |
| 5 | Sample label QR after handling (crease, moisture, cold chain) | decodes, or sample ID typed manually works | |
| 6 | Non-TRACED QR / tracking ID typed | refused, no navigation | |
| 7 | Camera permission denied / no camera | clear message; manual entry works | |
| 8 | Arabic portal (RTL) | messages and layout correct | |
| 9 | Screen lock / app switch while scanning | camera stops | |
| 10 | Keyboard-wedge scanner into the QR field | same result as camera; sends Enter | |
| 11 | Poor network (3G profile / airplane toggle mid-action) | clear error; retry does not duplicate (idempotency) | |

## 3. Label printers

Labels are HTML pages printed through the browser with CSS page sizes (default 50 × 30 mm; also on A4 sheets). Nothing has been printed on real hardware.

| # | Check | Expected | Printer model / driver | Pass? |
|---|---|---|---|---|
| 1 | Direct thermal / thermal transfer label printer (e.g. the model Wareed uses), 50 × 30 mm media | one label per page, no scaling, no blank second page | | |
| 2 | Browser print settings: margins none, scale 100%, headers/footers off | settings remembered per printer | | |
| 3 | Printed QR module size and quiet zone | scans reliably at arm's length with every approved device | | |
| 4 | Sample ID text `TRC-SA-MM/YY-XXXXX-SXX` | fully legible, not truncated, no patient data on the label | | |
| 5 | Resolution 203 dpi vs 300 dpi | QR still scans at 203 dpi | | |
| 6 | A4 label sheet on an office laser printer (fallback) | alignment within the label cells | | |
| 7 | Durability: freezer/fridge, alcohol wipe, 7 days | QR and text readable | | |
| 8 | Reprint flow | reason required; print count increases; audited | | |

## 4. Branch conditions

- [ ] HTTPS reachable from the branch network (camera requires a secure context)
- [ ] Branch Wi-Fi / mobile data allows the portal domain; no TLS interception that breaks cookies
- [ ] Devices are managed (screen lock, OS updates, no shared personal accounts); staff sign out at shift end
- [ ] Printer drivers installed on the counter PC; paper/label stock rules defined

## 5. Sign-off

| Item | Owner | Date |
|---|---|---|
| Approved device list published to branches | Wareed operations | |
| Approved printer + media | Wareed operations | |
| Laboratory scanning setup | Laboratory lead | |
