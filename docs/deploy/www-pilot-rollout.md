# Restricted pilot on www.tracedmena.life: deployment and rollback plan

**27 Nov 2026.** Owner decision: **www.tracedmena.life** is the canonical application domain. It is a Production domain in Vercel project `tracedlife`; `tracedmena.life` redirects to it with 308; `tracedlife.vercel.app` also serves Production. The API stays at `api.tracedmena.life` (Oracle, Riyadh). **The pilot keeps using the isolated database `traced_preview`.** The clean production database `traced` is not touched, and real-patient registration and collection stay disabled.

## Verified before the change
- `https://www.tracedmena.life/`: 200, Let's Encrypt certificate (CN `www.tracedmena.life`, valid to 25 Feb 2027).
- `tracedmena.life`: certificate valid; `http://` → `https://`, then `tracedmena.life` → `www` (308).
- The live Production deployment is public-only: `/traced/` 200, portal paths 404.

## What changes
1. **`middleware.ts` (pilot gate, by path, on every host).**
   - Portal pages (`/traced|/ar/traced` + `account|staff|admin|lab|c|s`), `/portal/` and `/api/v1/` need HTTP Basic credentials: user `traced` + `TRACED_PILOT_PASSWORD`.
   - It fails closed (503) without a password.
   - Encodings, double slashes, backslashes and case are normalised, so alternate hosts or encodings cannot bypass it (tests: `server/test/vercel-middleware.test.ts`).
   - Marketing pages stay public. `/api/v1/*` is rewritten to the API with the proxy secret.
2. **Production build.** `TRACED_BUILD_PORTAL=1` includes the portal pages. The build **refuses** unless `TRACED_PILOT_PASSWORD` (12+ characters) and `middleware.ts` are present. A refused build leaves the current live deployment serving.
3. **Vercel Production environment.**
   - Set by Claude: `TRACED_BUILD_PORTAL=1`, `TRACED_API_ORIGIN=https://api.tracedmena.life`.
   - **Set by the owner** (Sensitive): `TRACED_PILOT_PASSWORD` and `TRACED_PROXY_SECRET`. The proxy secret is the same value as the Preview one: the Vault content of `traced-proxy-secret` exactly as the OCI Console shows it.
4. **API.** `APP_ORIGIN=https://www.tracedmena.life`, still preview mode on `traced_preview` (`vm_07 … preview`). All emailed links (setup, verification, reset, staff/lab invitations) then point at www. The old `vercel.app` preview origin stops working for API writes (CSRF origin check).
5. **Deployment.** Production deploy from the reviewed checkout of `feature/traced-portal` with `vercel deploy --prod` (as for the public site). Nothing is merged into `main`.
6. **Fresh invitation.** `vm_15_resend_setup.sh info@tracedmena.life` expires the old setup link and sends a new one on www.

## Checks after deployment
- Marketing pages are 200 on www, `tracedmena.life` → 308, and `tracedlife.vercel.app` is 200.
- Portal paths and `/api/v1` answer **401** without pilot credentials on www, `tracedmena.life`, `tracedlife.vercel.app` and the deployment URL. Encoded and double-slash variants also answer 401.
- With pilot credentials, the TRACED pages load and `/api/v1/auth/me` → 401 JSON from the API (correct, signed out).
- `api.tracedmena.life` direct → 403 (proxy-secret gate). PostgreSQL stays closed.
- The invitation link opens `www.tracedmena.life/traced/admin/accept-invite/` behind the pilot prompt, with **no Vercel login**. Password, then two-step verification, then admin dashboard.

## Rollback
| What | How | Time |
|---|---|---|
| Website (any problem) | Vercel → tracedlife → Deployments → the previous Production deployment → **Promote to Production** (or `vercel rollback --scope linus-bio-mena`). The previous one is public-only | 1 minute |
| Portal exposure concern | Remove `TRACED_PILOT_PASSWORD` from Production and redeploy: the gate fails closed (503) on all portal paths; marketing pages unaffected | 2 minutes |
| API origin | Re-run `vm_07 … preview` with the previous origin | 2 minutes |
| Invitation | Re-run `vm_15` (each run expires the previous link) | 1 minute |

## Result (28 Nov 2026, 00:11 Riyadh)

- **Rollback checkpoint:** previous Production deployment `dpl_9WTxpjM6hhSyzXJjHX8RKw8vpF9n` (`tracedlife-bsy2bls5s…`, public-only). Promote it to roll back.
- Three Production builds were **refused** by the safeguard while `TRACED_PILOT_PASSWORD` was missing or under 12 characters. The live site stayed on the checkpoint each time.
- **Live:** `dpl` at `tracedlife-4xkyn1hq8-linus-bio-mena.vercel.app`, aliased to **www.tracedmena.life** (portal included behind the gate; build from `feature/traced-portal` at `0ae2882`; nothing merged into `main`).
- **Verified from the internet:**
  - marketing pages `/`, `/traced/`, `/ar/traced/`, FAQs and product: **200**;
  - every portal path and `/api/v1` on www **and** `tracedlife.vercel.app`: **401** with `WWW-Authenticate: Basic realm="TRACED restricted pilot"`, `no-store`, `noindex`;
  - `tracedmena.life` → **308** → www;
  - bypass attempts (`%61dmin`, upper case, `index.html`, `%2F`): **401**; `//traced/admin/` → 308 to `/traced/admin/` → 401;
  - the deployment URL is behind Vercel Authentication;
  - API direct `/auth/me`: **403**, health 200; ports 22 and 5432 closed.
- **API:** `APP_ORIGIN=https://www.tracedmena.life`, still preview mode on **`traced_preview`**. Production database `traced`: **0 users**, untouched.
- **Invitation:** `vm_15_resend_setup.sh info@tracedmena.life` sent a fresh setup email (first attempt). Exactly **1 usable** setup link for account `68e1a2d9…`; the 2 earlier links are dead; audited.
- **No-Vercel-account test:** the built-in browser has no Vercel login. `https://www.tracedmena.life/traced/admin/accept-invite/` stays on www and shows the TRACED pilot gate (401); there is **no Vercel redirect**. The steps after the prompt need the owner's pilot password and are completed by the owner.
- The `vercel.app` Preview build has no `TRACED_PILOT_PASSWORD`, so its portal paths now fail closed (503) behind Vercel Authentication. The pilot is on www.
