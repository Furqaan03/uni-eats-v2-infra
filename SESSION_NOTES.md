# Session Notes — Handoff Summary

Cross-app work across all 4 apps (`uni_eats_driver`, `unieats_vendor`, `uni-eats-v2-main`, `admin-dashboard`). Use this to pick up cold in a new session. See also `PLAN.md` (architecture) and `ORDER_LIFECYCLE.md` (order status state machine) for the underlying system reference — both predate this session and weren't rewritten, just relied on.

## 1. Security fix — admin privilege escalation (deployed)

**Found:** `firestore.rules`'s `admins/{uid}` collection allowed *any* signed-in user (e.g. a customer account from the user app) to self-create an admin doc with a non-`super_admin` role, instantly gaining `isAdmin()` read access to `users`/`orders`/`drivers`/`vendors`/`admins`.

**Fixed:**
- `firestore.rules`: `admins/{adminUid}` now has `allow create: if false` — no client path exists at all.
- `scripts/bootstrap_admin.js`: new Node script using the Firebase Admin SDK + a service-account key (never shipped to any client) to provision admin accounts out-of-band. Run with `GOOGLE_APPLICATION_CREDENTIALS=<path> node bootstrap_admin.js <email> [role]`. Setup instructions are in the file header.
- `scripts/.gitignore` blocks any `.json` file except `package.json`, so a service-account key can't get committed by accident.
- `admin-dashboard/public/index.html`: removed the dead client-side self-bootstrap code path that used to try writing that doc.
- **Status: rules deployed to production** (`uni-eats-v2-aabf5`) via `firebase deploy --only firestore:rules`.
- **Action for you:** if you suspect the old hole was ever exploited, check the `admins` collection in the Firebase Console for any doc you don't recognize — I don't have credentials in this environment to check it myself (that's by design now).

## 2. Tier-A audit fixes (hardcoded/fake data → real data)

Driven by a full "where is data faked" audit across all 4 apps. All of these are committed in code (not yet deployed to Hosting where relevant — see §6).

**Driver app:**
- Earnings payout chip + next-payout date now computed from real data instead of hardcoded "QAR 142" / "Friday, Jun 20"
- Earnings bar chart pulls real per-day Firestore aggregation (`fetchDailyEarnings`)
- ETA on real orders computed from the real `estimatedDelivery` timestamp instead of hardcoded 15 min
- Restaurant address uses the real `restaurantAddr` field (see §4) instead of string-concatenating `"{name} UDST Qatar"`
- Driver phone (`kDriverPhone`) now flows to Firestore on order accept — needed for vendor's real call/SMS button
- Profile name/phone/bank details (IBAN, account name, mobile) are now editable and persisted
- Order Statement export (Excel via `share_plus`) added to Profile

**Vendor app:**
- Delivery tracker card rebuilt — no more fake "Mohammed Al-Rashid" driver or fake animated progress bar; shows real `driverName`/`driverPhone` (with tap-to-call/SMS) and real binary status steps
- `estimatedMinutes` computed from real `estimatedDelivery` instead of hardcoded 15
- `_kRestaurantInfo` deduped from 3 copies into one `lib/core/constants/restaurants.dart`
- Vouchers now persist to Firestore (`menus/{id}/vouchers`) instead of in-memory only
- Profile settings (hours/notifications/language) persist to Firestore instead of resetting every restart
- Feedback form actually writes to a `vendorFeedback` collection instead of being a no-op toast

**Admin dashboard:**
- Top Performers + Recent Activity computed live from the real `orders` collection instead of permanently hardcoded ("Zinger Burger", "#1042", "2m ago" forever)
- Profit Overview labeled "Demo data" — no real commission-rate model exists, so it can't be computed for real (left as an honest disclosure rather than fabricated)
- Sidebar badges (Onboarding "3", Payouts "5") visually marked as demo data

## 3. Rating system (new feature)

Real end-to-end ratings, replacing fake/stuck numbers everywhere.

- **Customer app**: existing "How was [restaurant]?" prompt on Orders → Past tab was previously local-only (`rateOrder()` never reached Firestore). Now writes to `ratings/{orderId}` (doc ID = order ID, enforces one rating per order). Extended to also ask for a driver rating when the order had one.
- **Firestore rule**: `ratings/{orderId}` create is verified against the *real* order doc via `get()` — must be the customer's own delivered order, vendorId/driverId must match. Immutable once submitted. **Deployed.**
- **Driver app**: `DriverProfile.rating` used to be permanently stuck at the signup-default (5.0) forever. Now `loadRealRating()` computes a real average from `ratings where driverId == me` on launch.
- **Vendor app**: same pattern — `avgRating`/`ratingCount` computed from `ratings where vendorId == me`, replacing the fake "4.7★" and permanently-0 analytics rating.
- No running aggregate is kept on driver/restaurant docs (would need the customer's client to write to a doc they don't own) — both apps just query and average at read time. Fine at campus scale.

## 4. Real campus map + vendor-controlled restaurant location (new)

- Found UDST's actual official campus directory map already sitting unused in `uni-eats-v2-main/assets/images/campus_map.webp` (never wired into pubspec or any code).
- Built `lib/campus_map/real_campus_map.dart`, replacing the old `CampusMapPainter` (a fully fabricated abstract block diagram) on both the home screen preview and the tracking screen.
- Re-derived real coordinates for all 8 demo restaurants from the actual map layout (e.g. Tim Hortons/Oakberry/Bold Café → Building 04/UHUB, the campus's real food-court hub per the map's own legend).
- **Vendor → customer → driver propagation**: the vendor app could already edit restaurant name/location (Profile page), but customer/driver apps never read it — they only ever saw the frozen demo-seed value. Fixed: `restaurantStatusProvider` (customer app) now streams `name`/`location` live from the same Firestore doc the vendor edits, and `checkout_screen.dart` reads that live value (not the static mock) when placing an order, so it flows into the order doc's `restaurantAddr` — which is the only way the driver app ever sees restaurant location at all.
- **Known limitation, explicitly tabled by you:** this only covers building/location text. A literal indoor floor-plan map does not exist publicly anywhere — UDST doesn't publish one, and there's no realistic way to source one without asking the university directly (their Facilities Management & Procurement Directorate, Building 16). Discussed and explicitly deferred — not a bug, a real-world constraint.
- Map coordinates (`campusX`/`campusY`) are still static per-restaurant in `mock_data_service.dart` — there's no vendor-facing map-tap picker yet. Flagged as a natural follow-up, not done.

## 5. Cross-app live monitoring in admin dashboard (new)

- `loadRealData()` used to be a one-time `.get()` fetch, only run once at login — nothing updated until manual page reload.
- Replaced with 5 persistent `onSnapshot` listeners (`users`, `orders`, `restaurants`, `vendorAccounts`, `drivers`). Any write from any of the three apps now updates the dashboard immediately — KPIs, Live Orders Snapshot, Top Performers, Recent Activity, and the currently-open resource table (Customers/Restaurants/Delivery Boys/Live Orders/Order History) all recompute live.
- Added pulsing "● Live" indicators on Live Orders Snapshot and Recent Activity so it's visibly real-time.
- Listeners torn down on logout/auth-rejection to avoid leaking across sessions.

## 6. Deployment status — what's live vs. what's only local

| Component | Status |
|---|---|
| `firestore.rules` (admin privilege fix + ratings collection) | **Deployed** to `uni-eats-v2-aabf5` |
| `admin-dashboard/public/index.html` (live listeners, overflow-free, demo labeling) | **Not deployed** — only a local file change. Deploy with `firebase deploy --only hosting` from `admin-dashboard/` when ready. |
| All Flutter app code (driver/vendor/customer) | Source changes only — ships whenever you next build/release each app normally. |

## 7. Explicitly deferred / not done

These came up and were deliberately not built, per your calls in-session — not forgotten, just out of scope for now:

- **Real distance calculation** — restaurant coordinates are now real; customer drop-off coordinates still don't exist anywhere (no address/location picker in checkout). Tabled.
- **Indoor/floor-level maps** — see §4. Requires either asking UDST directly or accepting text-based wayfinding (building/floor/room + free-text instructions) as the realistic baseline, same as how DoorDash/Grubhub handle campus delivery. Not built — just discussed.
- **Customer app's full Firestore migration** off `mock_data_service.dart` (8 restaurants/57 menu items/etc., self-flagged in its own TODO at the top of that file) — too large for this pass, restaurant *status fields* (open/busy/name/location) now stream live per-restaurant (§4), but the base directory/menu data is still the static seed.
- **Vendor-facing map-coordinate picker** — see §4.
- A handful of small known-fake bits flagged during the original audit but not prioritized: the driver-side home screen flash-sale countdown (no real flash-sale backend exists), and the admin dashboard's remaining `DEMO_PAGES` (Disputes, Foods, Categories, Offers, Owners, Onboarding, Payouts, Commission, Revenue, Banners, Documents) — these are self-disclosed via an in-app banner already, just never made real.

## Quick reference — new files this session

- `scripts/bootstrap_admin.js`, `scripts/package.json`, `scripts/.gitignore`
- `uni_eats_driver/lib/services/order_statement_service.dart`
- `unieats_vendor/lib/core/constants/restaurants.dart`
- `uni-eats-v2-main/lib/campus_map/real_campus_map.dart` (replaces deleted `campus_map_painter.dart`)
- This file (`SESSION_NOTES.md`)
