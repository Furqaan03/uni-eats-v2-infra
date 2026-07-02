# Admin Dashboard — Progress & Status

Last updated: 2026-07 · Project: `uni-eats-v2-aabf5` · Live URL: https://uni-eats-v2-aabf5.web.app

The admin dashboard is a single static page (`admin-dashboard/public/index.html`,
Firebase Web SDK compat) served via Firebase Hosting, in the infra repo
(`uni-eats-v2-infra`). It shares one Firebase/Firestore project with all three
Flutter apps (customer, vendor, driver).

---

## ✅ Done

### Apps ↔ dashboard integration (live)
- Dashboard shares Firestore with the 3 apps — no separate backend.
- **6 live `onSnapshot` listeners**: `users`, `orders`, `restaurants`,
  `vendorAccounts`, `vendors`, `drivers`. Updates render in real time.
- Fixed a real gap: the dashboard cross-referenced `vendorAccounts` for restaurant
  owner emails, but the vendor app actually writes `vendors/{uid}`
  (`restaurantId`, `email`, `name`). Added a live `vendors` listener and merged it
  into the owner lookup, so real vendor sign-ups now link to their restaurant.

### Live / Test environment separation (real)
- The Live/Testing switch used to be cosmetic ("visual only — UX demo"): label +
  banner, same data. **Now it genuinely separates data.**
- Mechanism — collection-namespace prefix via `envCol(name)`:
  - **TEST** → unprefixed collections (`orders`, `users`, …) = all current data. Default.
  - **LIVE** → `live_`-prefixed collections (`live_orders`, …) = real launch data.
  - `admins` is **shared** across both (same admin signs into either env).
- Switching: persists the choice (`localStorage`), tears down + re-subscribes the
  live listeners against the other dataset, re-renders the open page.
- All 16 env-scoped `db.collection(...)` refs routed through `envCol`; `admins`
  stays literal.

### Apps made environment-aware
- Each app's Firestore service has `AppEnv.col()` prefixing top-level collections
  (subcollections inherit their parent's namespace).
- Default is **test** (empty prefix) → current app behavior unchanged.
- To go live: set `AppEnv.current = DataEnv.live` in each app's
  `lib/services/firestore_order_service.dart` (one line each).

### Infrastructure (deployed)
- `firestore.rules`: mirrored **15 env-scoped collections** under `live_` with the
  same security posture, plus live-aware helper variants (`vendorRestaurantIdLive`,
  `isVendorOfLive`, `isValidVoucherDiscountLive`) reading `live_vendors` /
  `live_vouchers`. `admins` not mirrored (shared). Compiled + deployed.
- `firestore.indexes.json`: mirrored the two `orders` composite indexes for
  `live_orders`. Deployed.
- Dashboard deployed to Firebase Hosting.

---

## ⏳ Not done / known gaps
- **Secondary collections not live-surfaced** in the dashboard: `vouchers`,
  `wallets`, `ratings`, `orderDeclines`. The dashboard centers on core entities
  (orders/users/restaurants/vendors/drivers); these are app-internal.
- **No runtime click-through of the env switch** with a real admin login (no
  credentials during dev). Validated via JS compile-check + successful deploy +
  HTTP 200 + logic review. LIVE will show empty until real data exists; TESTING
  shows all current data.
- Bundled service-account key in the mobile apps remains an open item (tracked
  separately; not a dashboard concern).

---

## How the two environments behave
| | TEST (default) | LIVE |
|---|---|---|
| Collections | `orders`, `users`, … | `live_orders`, `live_users`, … |
| Current data | all of it (test data) | empty until launch |
| Apps write here when | `AppEnv.current == test` | `AppEnv.current == live` |
| Dashboard reads here when | switch = TESTING | switch = LIVE |
| `admins` | shared (same in both) | shared (same in both) |

## Verify / operate
- Open https://uni-eats-v2-aabf5.web.app, sign in as an admin.
- Toggle the LIVE / TESTING chip (top bar) — lists re-subscribe to the other
  dataset. TESTING = current data; LIVE = empty (no real data yet).
- Redeploy dashboard: `cd admin-dashboard && firebase deploy --only hosting`
- Deploy rules/indexes: from repo root, `firebase deploy --only firestore:rules`
  / `firestore:indexes`.

## Relevant commits
- `8654538` dashboard real Live/Test separation
- `0706c63` dashboard surfaces real vendors
- `7b2fe2c` rules + indexes mirrored under `live_`
- App env-awareness: customer `65ae5ca`, vendor `e522240`, driver `f53b637`

See `PLAN.md` (ADDENDUM section) for the architecture rationale.
