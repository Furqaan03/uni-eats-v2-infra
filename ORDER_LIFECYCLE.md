# Order Lifecycle — Cross-App Delivery Flow

Canonical reference for how a **delivery** order moves through Firestore and
how the User, Vendor, and Driver apps each react to it. Pickup orders follow
a short subset of this (see bottom).

All three apps read/write the same `orders/{orderId}` document. Each app maps
the raw Firestore `status` string into its own local enum independently —
there is no shared model package, so any new status must be added to all
three apps' switch statements or it silently falls into a default case.

## Firestore fields that drive everything

| Field | Written by | Meaning |
|---|---|---|
| `status` | vendor, driver | the kitchen/delivery stage — see table below |
| `driverAtRestaurant` | driver | `true` the instant the driver is physically at the restaurant. **Independent of `status`** — the driver can arrive before the food is ready, and this must never overwrite `preparing`/`ready`. |
| `driverId` / `driverName` | driver (on accept) | who claimed the order |
| `paymentStatus` | user, vendor (escrow) | `held` → `captured` / `released` |
| `cancelReason` | user, vendor | set on cancellation/rejection |

## Status sequence

| # | `status` string | Who writes it | What it means |
|---|---|---|---|
| 1 | `placed` | user (checkout) | Order created, payment held in escrow |
| 2 | `awaitingDriver` | vendor (Accept) | Vendor accepted, but the **kitchen does not start cooking yet** — waiting for a driver to commit. Pickup-type orders skip this and go straight to `preparing`. |
| 3 | `preparing` | driver (claims the order) | A driver accepted the order — *this* is what starts the kitchen, not the vendor's Accept tap. |
| — | *(no status change)* `driverAtRestaurant: true` | driver (taps "At Restaurant") | Driver is physically there, order may still be `preparing`. Triggers a "Driver Arrived" notification in vendor + user apps without moving any dashboard bucket. |
| 4 | `ready` | vendor (Mark Ready) | Kitchen done. Notifies the driver to come pick it up. |
| 5 | `pickedUp` | driver (taps "Picked Up") | Driver has the order and is now out for delivery — this is the moment vendor's dashboard moves the order to "Out for Delivery". |
| 6 | `enRoute` | driver (auto, same action as pickup) | Mirror of `pickedUp` for apps that key off it; written immediately, not on a delay. |
| 7 | `arrivedAtCustomer` | driver (taps "Arrived") | Driver is at the customer's location, not yet handed off. |
| 8 | `delivered` | driver (taps "Delivered") | Order complete. Driver earnings/trip count recorded. |
| — | `cancelled` | user or vendor | Can happen any time before `delivered`. Wallet hold released if cancelled while still `placed`. |

### Why `driverAtRestaurant` is a separate field

Early in this project, "driver arrived" was written directly into `status`
(`'driverArrived'`). That broke the vendor dashboard: a driver who reached
the restaurant *before* the food was ready would instantly flip the order
into the vendor's "Out for Delivery" bucket, even though the kitchen was
still cooking — because `status` is a single field and writing into it
necessarily overwrites whatever the kitchen had set. Splitting "driver
arrived" into its own boolean fixes this: the kitchen's `preparing`/`ready`
value is never touched by the driver's arrival, and each app derives its own
"driver arrived" *display* state by combining `status` with this flag rather
than reading it as a status value.

### Why there's no separate "en route" status with a delay

An earlier version tried to give "out for delivery" its own status by
writing `pickedUp` immediately and then `enRoute` a few seconds later via a
delayed Firestore write. This was a race condition: on short delivery routes
the driver could reach the customer and tap "Arrived" (writing
`arrivedAtCustomer`) before the delayed write fired — which then landed
afterward and silently regressed the order back to `enRoute`, showing "Out
for Delivery" even though the driver was already at the door. Fixed by
writing `pickedUp` (and its mirror `enRoute`) synchronously, with no delay.

## Per-app behavior at each stage

### User app (`uni-eats-v2-main`)

| Status / flag | Notification pushed | Timeline step (current) |
|---|---|---|
| `placed` | — | Order Placed |
| `awaitingDriver` | "Restaurant Confirmed! — finding you a driver" | Finding a Driver |
| `preparing` | "Preparing Your Order" | Preparing |
| `driverAtRestaurant` (synthetic `driverArrived`, only while `preparing`/`ready`) | "Driver Arrived at Restaurant" | Driver Arrived (also covers plain `ready`, so there's no gap) |
| `ready` | — (covered by Driver Arrived step) | Driver Arrived |
| `pickedUp` / `enRoute` | "Picked Up by Driver" then "Out for Delivery!" | Out for Delivery |
| `arrivedAtCustomer` | "Your Driver Has Arrived!" | Driver Has Arrived |
| `delivered` | "Order Delivered!" | Delivered |
| `cancelled` | "Order Rejected" (if rejected post-accept) | — (separate Cancelled tab, not the timeline) |

`OrderStatus` enum order matters: several places compare `.index >=` to mean
"at or past this stage." `cancelled` sits after `delivered` in the enum,
which is a latent footgun for any future index comparison — currently
harmless because cancelled orders render through a separate `_CancelledTab`
that never touches the timeline.

### Vendor app (`unieats_vendor`)

| Status / flag | Dashboard bucket | Notification pushed |
|---|---|---|
| `newOrder` | New Orders | "New Order Received" |
| `awaitingDriver` | Awaiting Driver | — |
| `preparing` | Preparing | "Driver Found — Start Preparing!" (on `awaitingDriver → preparing`) |
| `driverAtRestaurant: true` (status still `preparing`/`ready`) | stays in Preparing/Ready, badge added | "Driver Arrived" |
| `ready` | Ready for Pickup | — |
| `pickedUp`/`enRoute`/`arrivedAtCustomer` (all bucketed as local `onTheWay`) | Out for Delivery | "Order Picked Up" (on bucket entry) |
| `delivered` | (removed from active lists) | "Order Delivered" |
| `cancelled` | (filtered out of the stream entirely) | "Order Cancelled" |

`readyOrders` and `outForDeliveryOrders` are two distinct getters in
`VendorProvider` — they used to be one combined `readyOrders` getter that
included `onTheWay`, which is what caused the dashboard to mislabel
"Out for Delivery" orders as "Ready for Pickup".

### Driver app (`uni_eats_driver`)

| Local `DeliveryStep` | Firestore write | UI action |
|---|---|---|
| (claiming) | `awaitingDriver → preparing`, sets `driverId`/`driverName` | Accept in the available-orders feed |
| `toRestaurant` | `driverAtRestaurant: true` (status untouched) | "At Restaurant" button — always tappable, no readiness gate |
| `atRestaurant` | `status: pickedUp` | "Picked Up" button |
| `enRoute` | `status: arrivedAtCustomer` | "Arrived" button |
| `atCustomer` | `status: delivered` | "Delivered" button — records earnings/trip |

The driver also gets a one-time push notification ("Order Ready!") if it's
still waiting when `status` flips to `ready` — implemented as a Firestore
listener (`_watchForReady`) started right after a successful claim, which
self-cancels once it fires.

There used to be an `isStillPreparing()` check that blocked the "At
Restaurant" tap with an error if the kitchen wasn't done yet. It's been
removed — the driver can always mark arrival; it's informational only and
never blocks any action.

## Pickup orders (abbreviated flow)

Pickup-type orders never involve a driver, so they skip `awaitingDriver`,
`driverAtRestaurant`, and the whole `pickedUp → delivered` driver leg:

`placed → preparing → ready → delivered` (vendor marks `delivered` directly
once the customer collects it; written as `pickedUp` in Firestore for
historical reasons, mapped to `delivered` client-side for pickup orders).

## Known non-issues (intentionally left as-is)

- The vendor's `_fromFirestore` and `_toFirestoreStatus` switches still have
  a dead case for the now-unused literal `'driverArrived'` status value —
  harmless, just never hit since the driver app no longer writes it.
- `OrderStatus.cancelled` being declared after `delivered` in the user app's
  enum (see above) — not actively buggy today, worth fixing if any new
  `.index >=` comparison is ever added that could see a cancelled order.
