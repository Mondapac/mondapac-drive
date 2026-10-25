# Store listing draft (English)

Draft for App Store Connect and Google Play. Items marked **Owner** need a decision or an
account before submission. Screenshots are placeholders until a preview build runs against the
pilot API.

## Identity

| Field | Value |
| --- | --- |
| App name | Mondapac Courier |
| Subtitle (iOS, 30 chars) | Deliveries for Mondapac couriers |
| Short description (Play, 80 chars) | Take delivery jobs, navigate to stops and prove each delivery. |
| Category | Business (both stores) |
| Bundle id / package | `com.mondapac.drive.courier` (preview: `….preview`, dev: `….development`) |
| Audience | Couriers invited by Mondapac operations; not for the public. Age rating 4+ / Everyone. |
| Support URL, marketing URL | **Owner** |
| Privacy policy URL | **Owner** (must cover the text below) |
| Sign-in for review | **Owner**: a demo courier account on the pilot API, with a delivery it can take |

## Full description

Mondapac Courier is the app for couriers who deliver Mondapac marketplace orders.

- Go online when you are ready to work and offline when you stop.
- See a delivery offer with its pickup area and drop-off area, and accept it before the timer
  runs out.
- Follow each step: to the pickup, collected, on the way, delivered.
- Open your maps app for directions to every stop.
- Record chilled and frozen temperatures for cold-chain orders.
- Prove the delivery with the customer's PIN or a photo.
- See what you earned today and this week.

You need a courier account set up by Mondapac to sign in.

## Privacy text (location, camera and photos)

**Location.** While you are online, the app shares your device's location with Mondapac
dispatch, also when the app is in the background or the screen is off. It is used to offer you
nearby deliveries, to show the operations team and the customer where an order is, and to
record the delivery route. Sharing stops as soon as you go offline or sign out; no location is
collected while you are offline. Android shows a notification the whole time location is shared.
The in-app map is drawn by Google Maps (Android) or Apple Maps (iOS), which load the map of the
area around you; the privacy policy names both as service providers.

**Camera, photos and files.** The camera is used only to take a proof-of-delivery photo, or a
photo of your courier documents (licence, insurance) while you set up your account, when you
choose to. Documents can also be picked from your files. The app does not browse your photo
library. The photo is resized and its metadata (including
GPS position and device details) is removed before upload, and the copy on the phone is deleted
once it is uploaded.

**Account data.** Your email, the session token (kept in the phone's secure keystore), your
shift status, your deliveries and earnings are processed to run deliveries and pay you.

**Not collected.** Contacts, microphone, advertising identifiers; no tracking
across other companies' apps; no data is sold.

## Store data forms (answers to prepare)

- Apple App Privacy: Precise Location (App Functionality, linked to the user, not tracking);
  Photos (App Functionality, linked); Other User Content: courier documents (App Functionality,
  linked); Contact Info: email (App Functionality, linked); User ID
  (App Functionality, linked).
- Google Data safety: Location (precise, collected, not shared with third parties beyond
  service providers, required, background); Photos (collected, required for photo proof);
  Personal info: email; Files and docs: courier documents (licence, insurance); data encrypted in transit; deletion on request (**Owner**: the process).
- Google background location declaration: a short video of going online and the in-app notice
  (`permissions.location` copy), and the reason "core delivery tracking while on shift".
- Encryption: standard HTTPS only (`ITSAppUsesNonExemptEncryption` is false in the config).

## Assets

| Asset | File | Status |
| --- | --- | --- |
| App icon 1024 x 1024 | `store/assets/icon.png` | placeholder mark in the panel's primary colour |
| Android adaptive icon foreground | `store/assets/adaptive-icon.png` | placeholder |
| Splash mark | `store/assets/splash.png` | placeholder |
| Play feature graphic 1024 x 500 | `store/assets/feature-graphic.png` | placeholder |
| Screenshots: iPhone 6.9", Android phone | not yet | take from a preview build on the pilot API: sign-in, home online with an offer, job steps, proof, earnings |

Replace the placeholders when the Mondapac brand logo is final.
