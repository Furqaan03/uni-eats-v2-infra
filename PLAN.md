# Uni Eats v2 — Cross-App Integration Plan

## Architecture

All 3 apps share a single **Firebase project** (Firestore + FCM).

```
User App ──── places order ────► Firestore /orders/{id}
                                        │
                  Vendor App listens ◄──┘  (real-time stream)
                  Vendor accepts/ready ──► Firestore update
                                        │
                  Driver App listens ◄──┘  (when online, status==ready)
                  Driver accepts/delivers ► Firestore updates
                                        │
                  User App listens ◄────┘  (order status stream)
```

## Firestore Schema

### /orders/{orderId}
```
id:               string
userId:           string
vendorId:         string   ← matches restaurant ID in user app
driverId:         string?  ← null until driver accepts
customerName:     string
restaurantName:   string
items:            [{name, qty, price}]
subtotal:         number
deliveryFee:      number
total:            number
status:           'placed' | 'preparing' | 'ready' | 'assigned' | 'pickedUp' | 'enRoute' | 'delivered' | 'cancelled'
orderType:        'pickup' | 'delivery'
deliveryAddress:  string?
createdAt:        Timestamp
estimatedDelivery: Timestamp?
driverName:       string?
```

### /drivers/{driverId}
```
name:      string
isOnline:  bool
fcmToken:  string?
```

## Order Flow

1. **User places order** → write to Firestore with `status: 'placed'`
2. **Vendor** streams `orders where vendorId == myId && status == 'placed'` → sees new order instantly
3. **Vendor accepts** → update `status: 'preparing'`
4. **Vendor marks ready** → update `status: 'ready'`
   - If pickup: vendor updates `status: 'delivered'` when customer picks up
   - If delivery: continue to step 5
5. **Driver** (when online) streams `orders where status == 'ready' && orderType == 'delivery'` → incoming order alert
6. **Driver accepts** → update `status: 'assigned', driverId, driverName`
7. **Driver at restaurant** → update `status: 'pickedUp'`
8. **Driver en route** → update `status: 'enRoute'`
9. **Driver delivers** → update `status: 'delivered'`
10. **User** streams their order → sees status updates in real time

## Status Mapping

| Firestore string | User app enum    | Vendor app enum | Driver step    |
|------------------|------------------|-----------------|----------------|
| placed           | placed           | newOrder        | —              |
| preparing        | preparing        | preparing       | —              |
| ready            | ready            | ready           | —              |
| assigned         | pickedUp         | ready           | toRestaurant   |
| pickedUp         | pickedUp         | delivered       | atRestaurant   |
| enRoute          | delivering       | delivered       | enRoute        |
| delivered        | delivered        | delivered       | delivered      |
| cancelled        | cancelled        | cancelled       | —              |

## Setup Required (one-time)

1. Create Firebase project at console.firebase.google.com
2. Add Android apps for all 3 packages:
   - `com.unieats.app` (User)
   - `com.unieats.vendor` (Vendor)
   - `com.unieats.driver` (Driver)
3. Download `google-services.json` → place in each app's `android/app/`
4. Run `flutterfire configure` in each app directory (generates `lib/firebase_options.dart`)
5. Enable Firestore in Firebase console
6. Set `kUseFirebase = true` in each app's `lib/services/firestore_order_service.dart`

## Files Changed

### User App (uni-eats-v2-main)
- `lib/main.dart` — Firebase init
- `lib/services/firestore_order_service.dart` — NEW: place + stream orders
- `lib/features/orders/providers/orders_provider.dart` — Firestore stream
- `lib/features/cart/checkout_screen.dart` — write order to Firestore

### Vendor App (unieats_vendor)
- `pubspec.yaml` — added firebase_core, cloud_firestore
- `lib/main.dart` — Firebase init
- `lib/services/firestore_order_service.dart` — NEW: stream + update vendor orders
- `lib/core/providers/vendor_provider.dart` — Firestore-backed orders

### Driver App (uni_eats_driver)
- `pubspec.yaml` — added firebase_core, cloud_firestore
- `lib/main.dart` — Firebase init
- `lib/services/firestore_order_service.dart` — NEW: stream available + update delivery
- `lib/core/providers/driver_provider.dart` — Firestore-backed incoming orders
