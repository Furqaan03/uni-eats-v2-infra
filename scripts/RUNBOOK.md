# Uni Eats — Admin Scripts Runbook

Copy-paste commands for adding/removing data and admins. All privileged
scripts use the **Firebase Admin SDK** and bypass Firestore rules by design,
so they need a service-account key. **Project: `uni-eats-v2-aabf5` (production)** —
every command here writes to the real database. There is no separate staging
project; TEST vs LIVE is just a collection-name prefix (see below).

---

## 0. One-time setup (do this first, each new PowerShell window)

PowerShell rejects `&&`, so run these **one line at a time**:

```powershell
cd "C:\Users\syedf\Desktop\Furqaan\Uni Eats v2\scripts"
npm install
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\Users\syedf\Downloads\uni-eats-v2-aabf5-firebase-adminsdk-fbsvc-0247e48acb.json"
```

- `npm install` only needs to be run once (installs `firebase-admin`).
- The `$env:GOOGLE_APPLICATION_CREDENTIALS` line must be re-run in **every new
  terminal** (it doesn't persist). If a script says "GOOGLE_APPLICATION_CREDENTIALS
  is not set", you forgot this line.
- The key file grants **full admin access** — never commit it, never share it.

---

## 1. TEST vs LIVE — what the prefix means

Two environments share one database via a collection-name prefix:

| | TEST (default) | LIVE |
|---|---|---|
| Collections | `orders`, `users`, `vouchers`, … | `live_orders`, `live_users`, `live_vouchers`, … |
| Scripts target it by | (nothing — default) | passing `--live` |
| Dashboard shows it when | toggle = TESTING | toggle = LIVE |

`admins` is shared (never prefixed).

---

## 2. Orders — list / remove

```powershell
# List in-flight orders so you can find the one to remove:
node delete_order.js --list                      # TEST (orders)
node delete_order.js --list --live               # LIVE (live_orders)

# Dry run — prints the order, deletes nothing:
node delete_order.js "#D3296"
node delete_order.js "#D3296" --live

# Actually delete (after checking the dry run):
node delete_order.js "#D3296" --confirm          # from TEST
node delete_order.js "#D3296" --live --confirm   # from LIVE
```

Use the `orderNumber` shown in the app/dashboard (e.g. `#D3296`), not the doc id.
The script refuses to act if two orders share a number.

---

## 3. LIVE seed data — add / remove (for dashboard validation)

```powershell
node seed_live.js            # ADD the 15 sample live_ docs (restaurants/vendors/users/drivers/orders)
node seed_live.js --clean    # REMOVE those same 15 docs
```

`--clean` only removes the specific seed docs (ids `live_o001…`, `live_u001…`, etc.),
not other live data. Re-running the seed is safe (idempotent).

---

## 4. Vouchers / promo codes — add

Edit the `VOUCHERS` list at the top of `seed_vouchers.js`, then:

```powershell
node seed_vouchers.js        # writes vouchers/{code} (TEST env)
```

(Vendors can also create their own codes from the app's Promotions screen.)

---

## 5. Admins — add / promote

```powershell
# 1. Have the person sign in once at the dashboard login (creates their Auth account; will be rejected).
# 2. Grant them a role:
node bootstrap_admin.js someone@example.com super_admin
# Valid roles: super_admin, operations, finance, support, qa  (defaults to super_admin)
```

To **remove/suspend** an admin, use the dashboard's Role & Access page (super-admin only),
or delete the `admins/{uid}` doc in the Firebase console (§7).

---

## 6. User directory backfill (one-off maintenance)

```powershell
node backfill_user_directory.js   # rebuilds userDirectory/{email|universityId} for old accounts
```

Only needed once after the wallet-transfer feature; harmless to re-run.

---

## 7. Removing things from different places

There are three ways to remove data — pick by situation:

1. **Scripts (this folder)** — best for orders and seed data (handles the
   orderNumber→docId lookup and the TEST/LIVE prefix for you). See §2–§3.

2. **Firebase Console** (manual, any collection) —
   <https://console.firebase.google.com/project/uni-eats-v2-aabf5/firestore/data>
   → open a collection (`orders`, `live_orders`, `users`, `admins`, …) → click a
   doc → **⋮ → Delete document** (or **Delete collection** to wipe all docs).
   Use this for one-off deletes the scripts don't cover.

3. **Admin Dashboard UI** (<https://uni-eats-v2-aabf5.web.app>) — doesn't hard-delete,
   but it's the right tool for *operational* changes: block a customer, suspend a
   restaurant/driver, change an admin's role. These write status flags, not deletes.

**Rule of thumb:** orders → script (§2); seed/demo → script (§3); a single stray
doc → console (§7.2); blocking/suspending a live account → dashboard (§7.3).

---

## 8. Dashboard deploy (after editing admin-dashboard/public/index.html)

```powershell
cd "C:\Users\syedf\Desktop\Furqaan\Uni Eats v2\admin-dashboard"
firebase deploy --only hosting
```

Rules / indexes (from repo root):

```powershell
cd "C:\Users\syedf\Desktop\Furqaan\Uni Eats v2"
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
```
