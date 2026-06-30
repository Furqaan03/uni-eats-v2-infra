# Push Notifications — Design & Plan

Real FCM push across the three apps (customer / vendor / driver), modelled on the
`theunieats/app_*` reference repos. **No Cloud Functions** — sending is done
client-side via the FCM HTTP v1 API, so it runs on the free (Spark) plan and
still reaches apps that are backgrounded or fully killed.

## How it works

### Sending (`lib/services/push/send_notification.dart` in each sending app)
1. Fetch a Firebase **service-account JSON** from a hosted URL (`PushConfig.serviceAccountJsonUrl`).
2. Mint an OAuth2 access token (`googleapis_auth`, scope `firebase.messaging`).
3. POST to `https://fcm.googleapis.com/v1/projects/<projectId>/messages:send`
   with the recipient device token, `notification` (title/body), `android`
   (channel + custom sound), and a `data` payload (orderId, type) for tap routing.

> ⚠️ **Security tradeoff (accepted for now):** this ships a service-account
> credential to clients. Scope the service account to *Firebase Cloud Messaging
> API* only. The correct long-term fix is a server holding the key. Tracked here
> so it isn't forgotten.

### Receiving (`lib/services/push/notification_service.dart` in each app)
- `firebase_messaging` receives; `flutter_local_notifications` renders.
- Two Android channels: `orders_channel` (importance max, custom `order_sound`)
  for the loud new-order/new-delivery alerts; `default_channel` for the rest.
- Foreground → `onMessage` → local-notification `display()`. Background/killed →
  the system shows the FCM `notification` block automatically.
- Tap → deep-link to the relevant order/tracking screen.
- Token written on login/refresh, removed on logout.

## Token storage (Firestore)
| Recipient | Doc | Field |
|---|---|---|
| Customer | `users/{uid}` | `fcmToken` |
| Vendor | `restaurants/{restaurantId}` | `fcmToken` (written by vendor app for its active restaurant) |
| Driver | `drivers/{driverId}` | `fcmToken` |

"All available drivers" = `drivers where isOnline == true` filtered by the
existing heartbeat-freshness rule (`lastActiveAt` within 5 min) — reuses the
ghost-driver fix so we never alert a driver whose app died.

## Events
| Trigger (Firestore) | Sender app | Recipient | Channel |
|---|---|---|---|
| order created (`placed`) | customer | vendor (`restaurants/{vendorId}.fcmToken`) | orders (loud) |
| `placed → awaitingDriver`, delivery | vendor | all live drivers | orders (loud) |
| `awaitingDriver` (confirmed) | vendor/driver | customer | default |
| `preparing` | driver | customer | default |
| `ready` (pickup) | vendor | customer | default |
| `arrivedAtCustomer` | driver | customer | default |
| `delivered` | driver | customer | default |
| `cancelled` (post-accept) | vendor | customer | default |

## Config (`lib/services/push/push_config.dart`, per app)
- `projectId = 'uni-eats-v2-aabf5'`
- `serviceAccountJsonUrl` — set by Furqaan (hosted service-account JSON).

## Android setup (per app)
- `firebase_messaging`, `flutter_local_notifications`, `googleapis_auth`, `http`.
- `android/app/src/main/res/raw/order_sound.wav` (from reference apps; vendor + driver).
- `POST_NOTIFICATIONS` permission (Android 13+), default-channel metadata.

## Phasing
1. Customer infra + send-to-vendor on order. ← first slice
2. Vendor receive + notify-all-drivers on accept.
3. Driver receive new-delivery + send status pushes to customer.
4. Customer receive lifecycle status pushes + tap routing.
