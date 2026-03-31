# P&G Intelligent Garment Scanner

A sorter-line tool for Goodwill facilities. Staff photograph a garment in three quick shots; the system uses Gemini AI with live Google Search grounding to identify the item, look up its original retail price and current resale value, then flag premium items for P&G chemical restoration.

---

## How it works

1. **Photo 1 — Garment**: capture the full item for condition assessment.
2. **Photo 2 — Brand tag**: inner neck/waist label for brand and model name.
3. **Photo 3 — Care tag**: side-seam label with the style number / SKU, used for precise MSRP lookup.

Gemini searches live Google Shopping data for the exact product page (via style number), current eBay/Poshmark sold listings, and returns:

- **Brand & model name**
- **Original retail price (MSRP)**
- **Current as-is resale value**
- **Direct link** to the original product listing
- **Condition assessment**
- **P&G Restoration flag** — shown in blue when the item is a premium brand with a minor, cleanable stain
- **Size of Prize** — MSRP minus as-is value (the restoration upside)

---

## Running the demo

### Prerequisites

- Python 3.11+
- Node.js 18+ and npm
- [Expo Go](https://expo.dev/go) installed on your iPhone
- A [Google AI Studio](https://aistudio.google.com) API key with Gemini access

### 1 — Backend (FastAPI)

```bash
# Clone and enter the repo
cd p&g-scanner

# Create and activate a virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Configure environment
cp .env.example .env
# Edit .env and set GEMINI_API_KEY=<your key>

# Start the server
uvicorn server:app --host 0.0.0.0 --port 8000 --reload
```

The API will be available at `http://<your-local-ip>:8000`.
Health check: `GET /health`

### 2 — Mobile app (Expo / React Native)

```bash
cd mobile
npm install
```

Open `App.js` and update the `API_BASE_URL` constant to your machine's local IP address (same network as your iPhone):

```js
const API_BASE_URL = "http://192.168.x.x:8000";
```

Then start Expo:

```bash
npx expo start --lan
```

Scan the QR code with your iPhone camera to open the app in Expo Go.

### 3 — Scan an item

1. Point the camera at the full garment → tap the shutter.
2. Point at the inner brand/neck tag → tap the shutter.
3. Point at the care/washing tag (side seam) → tap the shutter.
4. Wait ~10–20 seconds while Gemini queries live market data.
5. View the result: price, MSRP, condition, and (if eligible) the P&G restoration flag.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | Yes | — | Google AI Studio key |
| `GEMINI_MODEL` | No | `gemini-2.5-flash` | Gemini model ID |
| `BIGQUERY_PROJECT` | No | — | GCP project for analytics logging (leave blank to disable) |
| `BIGQUERY_DATASET` | No | `pg_scanner` | BigQuery dataset name |
| `BIGQUERY_TABLE` | No | `scan_results` | BigQuery table name |

---

## Cloud deployment (Google Cloud Run)

```bash
gcloud run deploy pg-scanner \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=<your-key>
```

Update `API_BASE_URL` in `mobile/App.js` to the Cloud Run service URL.

---

## Tech stack

- **Backend**: FastAPI, Google Gemini 2.5 Flash, Google Search grounding, Pillow, Pydantic v2
- **Mobile**: React Native (Expo SDK 54), expo-camera
- **Optional analytics**: Google BigQuery
