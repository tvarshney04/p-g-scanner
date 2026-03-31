"""
P&G Intelligent Scanner — FastAPI Backend
==========================================
Production-ready microservice. Designed for deployment on Google Cloud Run.

Run locally:
    uvicorn server:app --host 0.0.0.0 --port 8000 --reload

Required environment variables:
    GEMINI_API_KEY      — your Google AI Studio key
    GEMINI_MODEL        — (optional) defaults to gemini-2.0-flash
    BIGQUERY_PROJECT    — (optional) GCP project ID for analytics logging
    BIGQUERY_DATASET    — (optional) defaults to pg_scanner
    BIGQUERY_TABLE      — (optional) defaults to scan_results
"""

import asyncio
import io
import json
import logging
import os
import re
from contextlib import asynccontextmanager

# Load .env automatically in local development.
# In production (Cloud Run) env vars are injected directly; dotenv is a no-op.
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types
from PIL import Image
from pydantic import BaseModel, Field

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)
log = logging.getLogger(__name__)

# ── Configuration (all tunable via environment variables) ─────────────────────
GEMINI_API_KEY: str = os.environ.get("GEMINI_API_KEY", "")
MODEL_ID: str = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
IMAGE_MAX_DIM: int = 512          # pixels — keeps token cost low
REQUEST_TIMEOUT_SECS: int = 45   # Gemini + search grounding can be slow

BIGQUERY_PROJECT: str = os.environ.get("BIGQUERY_PROJECT", "")
BIGQUERY_DATASET: str = os.environ.get("BIGQUERY_DATASET", "pg_scanner")
BIGQUERY_TABLE: str = os.environ.get("BIGQUERY_TABLE", "scan_results")

# ── The Prompt ────────────────────────────────────────────────────────────────
# Heavily engineered to produce clean JSON every time.
# The explicit schema + "ONLY a valid JSON object" instruction is the
# most reliable way to get structured output when google_search grounding
# is active (response_schema cannot be combined with grounding tools).
SCAN_PROMPT = """
You are an AI assistant embedded in a Goodwill sorting-line scanner.
You are given two images: IMAGE 1 is the GARMENT, IMAGE 2 is the INNER TAG.

Follow these steps exactly:

1. Read IMAGE 2 (tag) to identify the exact brand and model name.
2. Inspect IMAGE 1 (garment) to assess condition — note any stains,
   pilling, fading, tears, or missing hardware.
3. Use your knowledge of 2025-2026 retail and resale market data to estimate:
   - original_msrp (USD float): the price this item sold for brand-new.
   - estimated_as_is_value (USD float): its current eBay/Poshmark value
     given its actual condition.
4. Set pg_restoration_eligible = true ONLY when BOTH are true:
   - The brand is a recognised premium, outdoor, or luxury label
     (e.g. Patagonia, Arc'teryx, Canada Goose, Lululemon, Ralph Lauren,
     The North Face, Barbour, Filson, Moncler, Gucci, Prada, Burberry).
   - The defect is a MINOR, CLEANABLE stain — not a tear, severe fading,
     broken zipper, or structural damage.
5. Compute size_of_prize = original_msrp − estimated_as_is_value.

Respond with ONLY a valid JSON object. No prose, no markdown, no code fences.
Use exactly this schema:
{
  "brand": "string",
  "model_name": "string",
  "condition_assessment": "string",
  "original_msrp": 0.00,
  "estimated_as_is_value": 0.00,
  "pg_restoration_eligible": false,
  "size_of_prize": 0.00
}
"""

# ── Pydantic Models ───────────────────────────────────────────────────────────
class ScanResult(BaseModel):
    brand: str = Field(..., description="Brand name from tag image")
    model_name: str = Field(..., description="Model or product line")
    condition_assessment: str = Field(..., description="Plain-language condition summary")
    original_msrp: float = Field(..., description="Original retail price (USD)")
    estimated_as_is_value: float = Field(..., description="Current resale value as-is (USD)")
    pg_restoration_eligible: bool = Field(..., description="True = divert to P&G restoration")
    size_of_prize: float = Field(..., description="MSRP minus as-is value (USD)")


class ScanResponse(BaseModel):
    status: str
    facility: Optional[str]
    data: ScanResult
    scan_timestamp: str


# ── App Lifespan: initialise the Gemini client once at startup ────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    if not GEMINI_API_KEY:
        raise RuntimeError(
            "GEMINI_API_KEY is not set. "
            "Export it as an environment variable before starting the server."
        )
    app.state.gemini = genai.Client(api_key=GEMINI_API_KEY)
    log.info(f"Gemini client ready. Model: {MODEL_ID}")
    yield
    log.info("Server shutting down.")


# ── FastAPI App ───────────────────────────────────────────────────────────────
app = FastAPI(
    title="P&G Intelligent Scanner API",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS — allow the Expo React Native app from any origin during development.
# In production, replace allow_origins=["*"] with your specific app domain.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Helper: image compression ─────────────────────────────────────────────────
def compress_image(raw_bytes: bytes) -> Image.Image:
    """
    Resize the longest dimension to IMAGE_MAX_DIM while preserving aspect ratio.
    Converting to RGB strips alpha channels and normalises exotic formats.
    """
    img = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
    img.thumbnail((IMAGE_MAX_DIM, IMAGE_MAX_DIM), Image.LANCZOS)
    return img


# ── Helper: extract JSON from Gemini text ─────────────────────────────────────
def extract_json(text: str) -> dict:
    """
    Gemini occasionally wraps its output in markdown code fences even when
    instructed not to. This function strips those fences and parses the JSON.
    Falls back to a regex sweep for the first {...} block if clean parsing fails.
    """
    # Strip ```json ... ``` or ``` ... ``` fences
    cleaned = re.sub(r"```(?:json)?\s*", "", text).strip().rstrip("`").strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned, re.DOTALL)
        if match:
            return json.loads(match.group())
        raise ValueError(
            f"Could not parse JSON from Gemini response. "
            f"First 400 chars: {text[:400]}"
        )


# ── Helper: BigQuery async logging ───────────────────────────────────────────
async def log_to_bigquery(payload: dict) -> None:
    """
    Fire-and-forget async task. Failures are logged but never surface to the
    client — analytics logging must not block or break the scan response.
    """
    if not BIGQUERY_PROJECT:
        return  # BigQuery not configured in this environment — skip silently

    try:
        from google.cloud import bigquery  # type: ignore — optional dependency

        def _insert() -> None:
            bq = bigquery.Client(project=BIGQUERY_PROJECT)
            table_ref = f"{BIGQUERY_PROJECT}.{BIGQUERY_DATASET}.{BIGQUERY_TABLE}"
            errors = bq.insert_rows_json(table_ref, [payload])
            if errors:
                log.warning(f"BigQuery insert errors: {errors}")
            else:
                log.info("Scan result logged to BigQuery.")

        await asyncio.to_thread(_insert)

    except ImportError:
        log.warning("google-cloud-bigquery not installed — skipping BQ log.")
    except Exception as exc:
        log.warning(f"BigQuery logging failed (non-fatal): {exc}")


# ── Primary Endpoint ──────────────────────────────────────────────────────────
@app.post("/api/v1/scan", response_model=ScanResponse)
async def scan_item(
    jacket_image: UploadFile = File(..., description="Full garment photo"),
    tag_image: UploadFile = File(..., description="Macro shot of inner tag"),
    facility: Optional[str] = Query(None, description="Facility name for analytics"),
):
    """
    Accept two JPEG/PNG uploads, run the P&G Gemini pipeline with live
    search grounding, and return a validated ScanResult JSON object.
    Also fires a non-blocking BigQuery analytics write.
    """
    log.info(f"Scan request — facility={facility!r}")

    # ── 1. Read uploaded files ────────────────────────────────────────────────
    try:
        jacket_bytes = await jacket_image.read()
        tag_bytes = await tag_image.read()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to read uploads: {exc}")

    if not jacket_bytes or not tag_bytes:
        raise HTTPException(
            status_code=400,
            detail="Both jacket_image and tag_image files are required.",
        )

    # ── 2. Compress images ────────────────────────────────────────────────────
    try:
        jacket_img = compress_image(jacket_bytes)
        tag_img = compress_image(tag_bytes)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Image processing failed: {exc}")

    # ── 3. Gemini inference (wrapped in asyncio.to_thread + timeout) ──────────
    # generate_content is synchronous; to_thread prevents it from blocking
    # FastAPI's async event loop while waiting on the Gemini network call.
    try:
        gemini_client: genai.Client = app.state.gemini

        response = await asyncio.wait_for(
            asyncio.to_thread(
                gemini_client.models.generate_content,
                model=MODEL_ID,
                # Order matters: garment first, then tag — matches the prompt wording.
                contents=[jacket_img, tag_img, SCAN_PROMPT],
                config=types.GenerateContentConfig(
                    # google_search grounding lets the model query live 2026
                    # shopping data for accurate MSRP and resale pricing.
                    tools=[types.Tool(google_search=types.GoogleSearch())],
                    temperature=0.1,  # Minimal randomness — we want factual answers
                ),
            ),
            timeout=REQUEST_TIMEOUT_SECS,
        )

    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail=(
                f"Gemini inference timed out after {REQUEST_TIMEOUT_SECS}s. "
                "The search grounding step can be slow — please retry."
            ),
        )
    except Exception as exc:
        log.error(f"Gemini API error: {exc}", exc_info=True)
        raise HTTPException(status_code=502, detail=f"AI inference error: {exc}")

    # ── 4. Parse and validate the response ───────────────────────────────────
    try:
        raw_dict = extract_json(response.text)
        scan_result = ScanResult(**raw_dict)
    except (ValueError, TypeError, KeyError) as exc:
        log.error(
            f"JSON parse/validation failed: {exc}\n"
            f"Raw Gemini text (first 600 chars): {response.text[:600]}"
        )
        raise HTTPException(
            status_code=502,
            detail=f"Failed to parse structured data from AI response: {exc}",
        )

    # ── 5. Async BigQuery analytics log (fire and forget) ────────────────────
    timestamp = datetime.now(timezone.utc).isoformat()
    asyncio.create_task(
        log_to_bigquery(
            {**scan_result.model_dump(), "facility": facility, "scan_timestamp": timestamp}
        )
    )

    # ── 6. Return structured response ────────────────────────────────────────
    return ScanResponse(
        status="success",
        facility=facility,
        data=scan_result,
        scan_timestamp=timestamp,
    )


# ── Health check (used by Cloud Run) ─────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL_ID}


# ── Local dev entry point ─────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
