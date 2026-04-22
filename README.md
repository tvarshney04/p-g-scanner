# P&G Intelligent Garment Scanner

A sorter-line tool for Goodwill facilities. Staff photograph a garment in three quick shots (full garment, brand tag, back); Gemini AI identifies the item, looks up original retail price and current resale value, and flags condition issues (stains, damage).

---

## Architecture

| Layer | What | Where |
|---|---|---|
| Mobile | React Native (Expo SDK 54), EAS Build | iOS, internal distribution |
| Backend | FastAPI + Gemini 2.5 Flash | Google Cloud Run (`pgscanner`, `us-central1`) |
| Storage | Firestore (scan catalog) + GCS (images) | GCP project `pgscanner` |
| Live preview | Firebase Realtime Database | Project `pgscanner-4188c` |
| Dashboard | Single-page HTML served at `/dashboard` | Same Cloud Run instance |

Live backend URL: `https://pg-scanner-158499852321.us-central1.run.app`

---

## Running the backend locally

### Prerequisites

- Python 3.11+
- `gcloud` CLI authenticated (`gcloud auth application-default login`)
- A [Google AI Studio](https://aistudio.google.com) API key

```bash
cd p&g-scanner
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# Set GEMINI_API_KEY in .env

uvicorn server:app --host 0.0.0.0 --port 8000 --reload
```

Dashboard: `http://localhost:8000/dashboard`  
Health check: `http://localhost:8000/health`

The server uses your local `gcloud` credentials for Firestore, GCS, and Firebase Admin. It needs access to the `pgscanner` GCP project.

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | Yes | — | Google AI Studio key |
| `GEMINI_MODEL` | No | `gemini-2.5-flash` | Model override |
| `GCP_PROJECT` | No | `pgscanner` | GCP project for Firestore + GCS |
| `GCS_BUCKET` | No | `pgscanner-items` | GCS bucket for scan images |

---

## Mobile app

The app uses native modules (`react-native-vision-camera`, `@react-native-firebase`) — **Expo Go will not work**. Builds go through EAS.

### Building (EAS)

```bash
cd mobile
npm install
eas build --platform ios --profile preview
```

Requires:
- EAS account: `danmae24` (Expo)
- Apple Developer Team: `3JZ4PDK26U`
- Device UDID registered in the provisioning profile for ad-hoc installs

To add a new device UDID: `eas device:create`, then rebuild.

### Pointing at a local backend

Open [mobile/App.js](mobile/App.js) and update:

```js
const API_BASE_URL = "http://192.168.x.x:8000"; // your machine's LAN IP
```

---

## Deploying the backend

```bash
gcloud run deploy pg-scanner \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=<your-key>
```

---

## Scan flow

1. **Photo 1 — Full garment**: condition assessment, graphic/logo identification
2. **Photo 2 — Brand tag**: brand name, size, model
3. **Photo 3 — Back of garment**: additional condition check (stains, wear)

The app supports a Bluetooth foot pedal (Space = capture/confirm, Enter = retake) and three zoom levels (0.5×, 1×, 2×).

---

## Database migration

If scans in Firestore have missing or non-standard `category` values:

```bash
GEMINI_API_KEY=<key> python fix_clothing_categories.py
```

---

## Tech stack

- **Backend**: FastAPI, Gemini 2.5 Flash, Pillow, Pydantic v2, Firestore, GCS
- **Mobile**: React Native (Expo SDK 54), react-native-vision-camera v4, @react-native-firebase
- **Live preview**: Firebase Realtime Database (push, ~100ms latency)
- **Builds**: EAS Build (iOS internal distribution)
