# Firestore Index Deployment Gap — Root Cause of "Orders Coming In Slow"

## Symptom

Orders placed by the customer app were slow (or appeared to never arrive) in the
vendor and driver apps, despite all three apps using real-time Firestore
`.snapshots()` listeners (not polling) for order data.

## Root Cause

The driver app's "available orders" query in
`uni_eats_driver/lib/services/firestore_order_service.dart` (`streamAvailableOrders()`):

```dart
Stream<List<FirestoreOrder>> streamAvailableOrders() {
  return _col
      .where('status', isEqualTo: 'awaitingDriver')
      .where('orderType', isEqualTo: 'delivery')
      .where('driverId', isNull: true)
      .orderBy('createdAt')
      .snapshots()
      ...
}
```

...requires a Firestore **composite index** on `orders`:
`status (ASC), orderType (ASC), driverId (ASC), createdAt (ASC)`.

That index was correctly *defined* — but only inside
`admin-dashboard/firestore.indexes.json`, wired to the admin dashboard's own
separate `firebase.json` (which configures Hosting + indexes for that
sub-project). The **root** `firebase.json` — the one actually used every time
`firestore.rules` was deployed for the real `orders` collection — never
referenced an indexes file at all:

```json
{
  "firestore": {
    "rules": "firestore.rules"
  }
}
```

Without a deployed composite index, a multi-field Firestore query like this
doesn't just run slowly — it fails outright with `FAILED_PRECONDITION`. If
that error isn't surfaced loudly in the UI, it looks indistinguishable from
"orders are just slow to arrive," when in fact the driver's query may never
have been completing at all.

## Fix

1. Copied `admin-dashboard/firestore.indexes.json`'s content to the repo root
   as `firestore.indexes.json`.
2. Updated the root `firebase.json` to reference it:
   ```json
   {
     "firestore": {
       "rules": "firestore.rules",
       "indexes": "firestore.indexes.json"
     }
   }
   ```
3. Deployed: `firebase deploy --only firestore:indexes` (from the repo root).

## Verifying It Worked

- Firebase Console → Firestore Database → Indexes tab → confirm the
  `orders` composite index shows **Enabled** (not "Building"). Index builds
  can take several minutes after deploy — don't re-test immediately.
- Re-run the full order flow (place order → vendor accepts → driver sees it)
  once the index shows Enabled.

## Related, Already-Working Feature (re-confirmed during this investigation)

**"Delivery should be disabled when no driver is online"** is already
implemented, not missing:

- `uni-eats-v2-main/lib/features/cart/checkout_screen.dart` watches
  `deliveryCapacityProvider` (live count of drivers with `isOnline: true`).
  When zero drivers are online, the Delivery option card is dimmed,
  un-tappable (`onTap: null`), shows "No drivers available right now," and
  the screen auto-switches the selection to Pickup.
- The driver app's online/offline toggle (`driver_provider.dart`'s
  `toggleOnline()`) correctly writes `isOnline` to the `drivers/{uid}` doc
  on both transitions via `FirestoreOrderService.instance.setDriverOnline(...)`.

If this ever appears not to work, check the `isOnline` field on the actual
`drivers/{uid}` document in the Firebase Console first — `drivers.isOnline`
is a single-field query and does not need a composite index, so it should be
unaffected by the issue above.
