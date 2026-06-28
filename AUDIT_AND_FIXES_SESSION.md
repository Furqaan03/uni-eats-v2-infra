# Audit & Fixes — Session Summary

Cross-app work across all three Flutter apps (`uni_eats_driver`, `unieats_vendor`,
`uni-eats-v2-main`) plus the shared `firestore.rules`. Distinct from
`SESSION_NOTES.md`, which documents a separate body of work (rating system, real
campus map, admin dashboard live monitoring) — this file covers only what was
done in this session. See also `ORDER_LIFECYCLE.md` for the order status state
machine this work builds on.

## 1. Hardcoded/mock-data audit — 3-phase fix

A full sweep of all three apps for hardcoded data masquerading as real backend
state. Findings were triaged into phases and fixed one app at a time.

**Phase 1 — Vendor app:**
- `VendorProvider` used to eagerly subscribe to Tim Hortons' (`r001`) live
  Firestore order stream and menu for *every* vendor session, before the real
  authenticated vendor's `setRestaurant()` ever ran. Fixed: nothing loads until
  the real vendor id is known; `kVendorId` is now only used in the legitimate
  offline single-device test mode.
- The 8-restaurant list was hand-duplicated in 3 files — consolidated into
  `lib/core/constants/restaurants.dart` (`kCampusRestaurants`).
- Deleted the legacy plaintext test-credential migration path (`vendor123` × 8
  `@testrun.qa` accounts) now that it's served its purpose.
- Added vendor-editable `category`/`description`/`deliveryTimeMin`/`minOrder`/
  `offersDelivery`/`offersPickup` fields (pre-filled from known defaults), so
  the customer app's restaurant catalog has a real source for fields that
  previously had no vendor-side UI at all.
- Vouchers (`WELCOME10`/`SAVE5`) explicitly left as-is — skipped per your call,
  not a bug.

**Phase 2 — Driver app:**
- Driver payout was `deliveryFee > 0 ? deliveryFee : total * 0.15` — a
  variable amount instead of the confirmed flat **QAR 5/delivery** rate. Fixed
  everywhere it was read (`FirestoreOrder.payout`, `fetchTodayStats`,
  `fetchTripHistory`, mock templates) → `kDriverPayoutPerDelivery = 5.0`.
- `new_order_screen.dart`'s "no data" fallback used to fabricate a full fake
  order ("Campus Kitchen", QAR 18.50) — now bails out/rejects instead of ever
  showing a phantom order to act on.
- Removed the fake "Payout Processed: QAR 142.00…" and "Bonus Zone"
  notifications seeded every session regardless of truth.
- Earnings bar charts and the "Next Payout" date were static mock data — now
  computed from real trip history and the actual upcoming Friday.
- `_kMaxOrders`/`_kMaxOrdersPerDriver` (concurrent-order cap) — confirmed as
  **never actually decided on**; left untouched, explicitly not made "official."

**Phase 3 — User app:**
- Customer delivery fee hardcoded to QAR 2.50 → fixed to the confirmed flat
  **QAR 5.00** (matches driver payout — platform takes no margin on delivery).
- Restaurant catalog and per-restaurant menus never read Firestore at all —
  added `streamRestaurants()`/`streamMenuItems()`, which merge real vendor
  edits over per-restaurant defaults field-by-field. New `restaurantsProvider`/
  `menuItemsProvider` replace direct `MockDataService.restaurants` reads in
  `home_screen.dart`, `restaurant_detail_screen.dart`, `profile_screen.dart`,
  `checkout_screen.dart`. A restaurant whose vendor hasn't edited anything
  still shows complete data — Tim Hortons et al. stay usable for testing.
- Removed the now-superseded `menuItemOverridesProvider`/
  `streamMenuItemOverrides` (folded into the richer `streamMenuItems`).
- Wallet transactions never actually read Firestore in the UI — moved
  ownership of the transaction list into `WalletNotifier` itself (still
  synced from/to Firestore exactly as before) and deleted the 4 hardcoded fake
  seed transactions.

## 2. Wallet negative-balance bug (critical, deployed)

**Symptom:** wallet balance went to -42, -173, -200 QAR, worsening on every
app relaunch.

**Root cause:** `firestore.rules`'s `orders/{orderId}` update rule had **no
branch at all** permitting a customer to flip their own order's
`paymentStatus` from `held` → `captured`. Every capture write was silently
`PERMISSION_DENIED`. The order's `paymentStatus` stayed `held` forever no
matter how far the order progressed, so every fresh app launch re-ran escrow
resolution, saw `held` again, and re-deducted the wallet for the same order —
compounding worse each relaunch.

**Fixed:**
- Added the missing rule branch (customer may flip `paymentStatus`
  `held`→`captured`/`released` on their own order, scoped to that field only).
  **Deployed.**
- Separately hardened the client side too: `capturePayment()`/
  `updateWalletBalanceWithTransaction()` now write balance + transaction +
  `paymentStatus` as a single atomic Firestore batch, so a force-close
  mid-write can no longer leave a half-applied state for the retry logic to
  misread.
- Fixed `WalletNotifier` keying wallet reads/writes off
  `MockDataService.currentUser` (a mutable singleton never cleared on
  sign-out) — now uses the real `authProvider`-derived id directly.

## 3. Two severe pre-existing Firestore rules bugs (found incidentally, deployed)

While building the driver-cancel feature (§4), found:

- **No rule allowed claiming an `awaitingDriver` order at all** — only the
  rarer `ready`→`assigned` path worked. Since most orders start at
  `awaitingDriver`, this blocked the *common* claim path entirely.
- **No rule allowed the "driver arrived at restaurant" flag write**
  (`driverAtRestaurant`) while status stayed unchanged — `markArrivedAtRestaurant`
  matched no existing branch.

Both added and **deployed**.

## 4. New feature — driver cancels delivery / no drivers available

Per your spec: if a driver gives up an order and no replacement is online,
notify the vendor; the vendor can contact the customer; the customer gets a
choice to pick up themselves or cancel.

- **Driver app**: new "Cancel Delivery" action (reason picker, pre-pickup
  only — matches the new Firestore rule's scoping) that puts the order back
  in the available-orders pool and checks if any other driver can take over.
  New rule branch: assigned driver may roll status back to `awaitingDriver`
  with `driverId`/`driverName` cleared, before `pickedUp`.
- **Vendor app**: new "Driver Cancelled" and "No Drivers Available"
  notifications. Also fixed `customerPhone` being hardcoded blank in
  `VendorOrder` — the tap-to-call UI already existed in
  `order_detail_screen.dart`, it just had no real phone number to call. Now
  the user app writes `customerPhone` at checkout and the vendor app reads it.
- **User app**: new banner on the tracking screen when `noDriversAvailable`
  fires — "Pick Up Myself" (switches to pickup, refunds the delivery fee from
  the order total) or "Cancel Order," both with confirmation dialogs. Also
  fixed `tracking_screen.dart` reading from `MockDataService.orders` instead
  of the real `ordersProvider` (it was never wired up).

## 5. Checkout delivery-option glitches (fixed)

Two real bugs, not glitches in the UI's rendering:

- Driver capacity was checked when *rendering* the checkout screen but never
  **re-checked at the moment of placing the order** — a delivery order could
  slip through in the race window between drivers going offline and the UI's
  auto-switch-to-pickup effect running. Added the same live re-check at
  place-order time.
- `restaurant.offersDelivery` was just a label on the detail screen —
  checkout never enforced it. A customer could select Delivery for a
  pickup-only restaurant. Now blocked the same way, with its own message.

## 6. Driver "go offline" glitch (fixed)

You reported: online, an order offer shows up, you don't want it, but you
should still be able to go offline without the "order in progress" block —
that block should only apply once you've actually **accepted** an order.

Fixed: `goOffline()`/`toggleOnline()` now auto-decline any pending,
not-yet-accepted incoming order the instant you go offline. `canGoOffline`
itself was already correctly scoped to `_activeOrders` (accepted deliveries
only) — the gap was the dangling incoming-offer state never getting cleared.

## 7. UI fixes

- **Dark-mode contrast bug, repeated pattern**: `AppColors.orange` is a
  near-black brand color (`#2D2D2D`) — fine as an accent on light surfaces,
  invisible when used as a *foreground* accent on dark ones (literally
  identical to some card backgrounds in places). Found and fixed across the
  driver app's active-delivery screen, new-order screen, earnings screen, and
  history screen — swapped to a real visible accent (`AppColors.yellow`) in
  dark mode only.
- **Earnings/History dedup**: Earnings screen had its own "Trip History" list
  per tab (Today/Week/Month), duplicating the same data as the dedicated
  History tab. Removed; Earnings now stays focused on the hero card, payout
  card, and bar chart.
- **History screen** was 100% hardcoded mock data, disconnected from
  Firestore entirely. Rewired to real `fetchTripHistory`, with working search,
  real filters (Delivery/Pickup/This Week — swapped out Cancelled, which had
  no real backing data), tappable detail sheets, dynamic date grouping,
  pull-to-refresh.
- **Vendor menu card render-overflow bug**: "Original Blend Coffee" showed
  Flutter's own yellow/black debug overflow stripes (confirmed via
  screenshot: "OVERFLOWED BY 47 PIXELS"). Root cause: the price `Row`
  (discounted price + strikethrough + `-X%` badge + calories) wasn't built to
  handle a discounted item with calories — fixed by switching it to a `Wrap`.
- **Vendor Analytics page**: added real interactivity — tap a revenue-chart
  bar to see that day's exact figures (replacing a long-press-only `Tooltip`
  nobody would discover), tap a top-seller row for a rank/revenue-share detail
  sheet, plus an explicit empty state for zero-revenue periods.
- **Tab bar indicator** (Earnings screen): default `TabBarIndicatorSize`
  only sized the pill to the label text, not the full tab segment — fixed
  with `indicatorSize: TabBarIndicatorSize.tab`.

## 8. Driver profile — new features + full interactivity pass

- **Bank details**: new locked-down `drivers/{uid}/private/bankDetails`
  Firestore subcollection (**deployed**) — deliberately *not* on the main
  `drivers/{uid}` doc, which is readable by any signed-in user (needed for
  online-status visibility) and would otherwise expose IBAN/bank info to
  every customer/vendor. Dialog collects exactly **Full Name (on the card),
  IBAN, Mobile**. The old "Update Bank Details" button was wired to nothing
  at all (missing `onTap`) — now functional.
- **Order Statement export**: new `order_statement_service.dart` generates a
  real `.xlsx` (via the `excel` package) from actual Firestore trip history —
  order number, restaurant, customer, dropoff, type, items, order value,
  driver earnings, timestamps, trip duration, plus a totals footer — and opens
  the OS share sheet (`share_plus`) so it can be saved or emailed to a
  supervisor. Period picker: 7/30/90 days, all-time.
- **Whole profile page made interactive** — almost nothing on it actually did
  anything before this pass, despite several rows showing a misleading
  chevron implying tappability:
  - Personal Info: name/phone/campus now editable; email explains why it
    can't be (tied to sign-in).
  - Documents: tap for status + a resubmit affordance.
  - Help & Support / Privacy Policy: real dialog content instead of dead taps.
  - Dark Mode row: whole row toggles, not just the switch.
  - App Version: no longer shows a chevron implying an action that didn't
    exist.
- **Not done**: avatar is still a static emoji placeholder, no tap-to-change.
  Flagged, not silently skipped.

## Deployment status — what's live vs. local

| Component | Status |
|---|---|
| `firestore.rules` (wallet capture fix, driver-claim fix, driver-arrival fix, driver-cancel branch, bank-details subcollection) | **Deployed** to `uni-eats-v2-aabf5` |
| All three Flutter apps' source changes | Committed and **pushed** to their respective GitHub repos (`uni-eats-v2-user`, `uni-eats-v2-driver`, `uni-eats-v2-vendor`) |
| Root-level shared infra (`firestore.rules`, `firebase.json`, indexes, admin-dashboard, scripts) | Committed and pushed to a new repo, `uni-eats-v2-infra` (this folder previously had no git remote at all) |

## New files this session

- `uni_eats_driver/lib/services/order_statement_service.dart`
- `unieats_vendor/lib/core/constants/restaurants.dart`
- `uni-eats-v2-main/lib/features/restaurant/providers/restaurants_provider.dart`
- This file (`AUDIT_AND_FIXES_SESSION.md`)

## Explicitly deferred / not done

- Driver concurrent-order cap (`_kMaxOrders`) — never decided on, deliberately
  untouched.
- Customer delivery-fee vs. driver-payout margin — both are QAR 5 flat,
  meaning zero platform margin on delivery. Flagged as worth confirming is
  intentional; not changed either way.
- Profile avatar tap-to-change — not built.
- Campus map building locations (`campusX`/`campusY`) — confirmed out of
  scope; these are static physical map positions, not vendor-owned business
  data, and there's no map-pin-placement UI to set them yet.
- Loyalty points/tiers, mock vouchers, support contact info in the user app —
  flagged in the original audit as lower-priority feature decisions, not
  hardcoded-data bugs; not addressed this session.
