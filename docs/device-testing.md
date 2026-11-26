# Physical Device Test Procedure: Staff QR Scanner

Status: **not yet performed on physical devices.** Automated browser tests use Microsoft Edge with a simulated camera only. Compatibility must not be claimed for any device until it has been tested and recorded below.

## Setup
1. Run the stack over **HTTPS** (cameras require a secure context; plain `http://localhost` works only on the same computer). Options: a staging deployment, or a temporary HTTPS tunnel to the local server approved for testing.
2. Create a test staff account with a branch: `npm run create-user -- --email <test address> --role collection_staff --name "Device Tester" --branch DEV-RUH-01`, then open the emailed setup link.
3. Create a test customer registration at the same branch, and display its QR on a second device or print it.
4. Use only test data. Never test with real patients.

## Test cases (run on each device)

| # | Step | Expected |
|---|---|---|
| 1 | Sign in at `/traced/staff/sign-in/` | Dashboard with branch and today's counts |
| 2 | Scan → **Start camera** | Permission prompt; after allowing, live preview (rear camera on phones/tablets) |
| 3 | If several cameras: change **Camera** | Preview switches; scanning continues |
| 4 | Show the customer QR | Decoded within ~2 s; camera light turns **off**; result shows tracking ID, age, gender, hair, status, branch only |
| 5 | Hold the same QR in view after the result | No repeated requests (single result) |
| 6 | Deny camera permission (browser settings) and start | Clear "Camera access was denied" message; manual entry still works |
| 7 | Navigate away / lock the screen while scanning | Camera light turns off |
| 8 | Scan a non-TRACED QR (e.g. a website) | "Not a TRACED customer QR code"; no navigation to the URL |
| 9 | Type a tracking ID in manual entry | Rejected |
| 10 | Complete dev verification + checklist + confirm (test environments only) | "Sample collected"; scanning again shows "already collected" |
| 11 | Arabic: repeat 2–4 at `/ar/traced/staff/scan/` | Right-to-left layout, Arabic messages |
| 12 | Rotate the device | Layout adapts; no horizontal scrolling |

### USB / Bluetooth keyboard-wedge scanner
Focus the **QR code content** field, scan a customer QR, and confirm the scanner sends Enter. Expected: the same result as case 4. If the scanner doesn't send Enter, configure its suffix.

## Devices to record

| Device | OS / version | Browser / version | Cases passed | Notes | Tester / date |
|---|---|---|---|---|---|
| Android phone | | Chrome | | | |
| iPhone | iOS ≥ 15 | Safari | | iOS needs inline video (`playsinline`, set) | |
| Tablet (Android or iPad) | | | | | |
| Desktop with webcam | Windows / macOS | Edge / Chrome / Safari / Firefox | | Firefox and Safari use the ZXing fallback | |
| USB QR scanner | model | any | | | |

Scanner engine: native `BarcodeDetector` where the browser supports QR (e.g. Chrome on Android/macOS), otherwise ZXing (`@zxing/browser` 0.2.1, vendored in `dist/portal/vendor/`). Frames are decoded on the device and never uploaded.
