"""
P&G Intelligent Scanner — FastAPI Backend
==========================================
Run locally:
    uvicorn server:app --host 0.0.0.0 --port 8000 --reload

Required env vars:
    GEMINI_API_KEY      — Google AI Studio key
    GEMINI_MODEL        — (optional) defaults to gemini-2.5-flash
    GCP_PROJECT         — GCP project ID (for Firestore + Storage)
    GCS_BUCKET          — Cloud Storage bucket name (default: pgscanner-items)
"""

import asyncio
import csv
import io
import json
import logging
import os
import re
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import quote_plus

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types
from PIL import Image, ImageOps
from pydantic import BaseModel, Field

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)
log = logging.getLogger(__name__)

GEMINI_API_KEY: str = os.environ.get("GEMINI_API_KEY", "")
MODEL_ID: str = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
GCP_PROJECT: str = os.environ.get("GCP_PROJECT", "pgscanner")
GCS_BUCKET: str = os.environ.get("GCS_BUCKET", "pgscanner-items")
IMAGE_MAX_DIM: int = 768
VISION_TIMEOUT_SECS: int = 20
SEARCH_TIMEOUT_SECS: int = 30

# ── Brand search URL map ──────────────────────────────────────────────────────
BRAND_SEARCH_URLS = {
    "h&m": "https://www2.hm.com/en_us/search-results.html?q={q}",
    "hm": "https://www2.hm.com/en_us/search-results.html?q={q}",
    "zara": "https://www.zara.com/us/en/search?searchTerm={q}",
    "gap": "https://www.gap.com/browse/search.do?searchText={q}",
    "old navy": "https://oldnavy.gap.com/browse/search.do?searchText={q}",
    "banana republic": "https://bananarepublic.gap.com/browse/search.do?searchText={q}",
    "j.crew": "https://www.jcrew.com/search?q={q}",
    "jcrew": "https://www.jcrew.com/search?q={q}",
    "madewell": "https://www.madewell.com/search?q={q}",
    "uniqlo": "https://www.uniqlo.com/us/en/search?q={q}",
    "nike": "https://www.nike.com/w?q={q}&vst={q}",
    "adidas": "https://www.adidas.com/us/search?q={q}",
    "under armour": "https://www.underarmour.com/en-us/search/?q={q}",
    "underarmour": "https://www.underarmour.com/en-us/search/?q={q}",
    "puma": "https://us.puma.com/us/en/search?q={q}",
    "reebok": "https://www.reebok.com/search?q={q}",
    "new balance": "https://www.newbalance.com/search?q={q}",
    "patagonia": "https://www.patagonia.com/search/?q={q}",
    "the north face": "https://www.thenorthface.com/search?query={q}",
    "north face": "https://www.thenorthface.com/search?query={q}",
    "columbia": "https://www.columbia.com/search?q={q}",
    "arcteryx": "https://www.google.com/search?tbm=shop&q=Arc%27teryx+{q}",
    "arc'teryx": "https://www.google.com/search?tbm=shop&q=Arc%27teryx+{q}",
    "rei": "https://www.rei.com/search?q={q}",
    "lululemon": "https://shop.lululemon.com/search?Ntt={q}",
    "athleta": "https://athleta.gap.com/browse/search.do?searchText={q}",
    "ralph lauren": "https://www.ralphlauren.com/search?q={q}",
    "polo": "https://www.ralphlauren.com/search?q={q}",
    "tommy hilfiger": "https://usa.tommy.com/en/search?q={q}",
    "calvin klein": "https://www.calvinklein.us/search?q={q}",
    "lacoste": "https://www.lacoste.com/us/search/?Ntt={q}",
    "levi": "https://www.levi.com/US/en_US/search?q={q}",
    "levis": "https://www.levi.com/US/en_US/search?q={q}",
    "wrangler": "https://www.wrangler.com/search?q={q}",
    "canada goose": "https://www.canadagoose.com/us/en/search?q={q}",
    "moncler": "https://www.moncler.com/en-us/search?q={q}",
    "burberry": "https://us.burberry.com/search/?q={q}",
    "gucci": "https://www.gucci.com/us/en/search?q={q}",
    "prada": "https://www.google.com/search?tbm=shop&q=Prada+{q}",
    "barbour": "https://www.barbour.com/us/search?q={q}",
    "filson": "https://www.filson.com/search?q={q}",
    "express": "https://www.express.com/search?q={q}",
    "forever 21": "https://www.forever21.com/search?q={q}",
    "urban outfitters": "https://www.urbanoutfitters.com/search?q={q}",
    "free people": "https://www.freepeople.com/search?q={q}",
    "anthropologie": "https://www.anthropologie.com/search?q={q}",
    "nordstrom": "https://www.nordstrom.com/sr?keyword={q}",
}


def build_explore_url(brand: str, model_name: str) -> str:
    query = quote_plus(model_name)
    brand_lower = brand.lower().strip()
    for key, template in BRAND_SEARCH_URLS.items():
        if key in brand_lower or brand_lower in key:
            return template.format(q=query)
    return f"https://www.google.com/search?tbm=shop&q={quote_plus(brand + ' ' + model_name)}"


# ── Prompts ───────────────────────────────────────────────────────────────────
VISION_PROMPT = """
You are an AI assistant embedded in a Goodwill sorting-line scanner.
You are given TWO or THREE images:
  IMAGE 1 — the GARMENT (front)
  IMAGE 2 — the BRAND TAG (inner neck/waist label)
  IMAGE 3 — the BACK OF GARMENT (if provided — use for additional condition assessment)

1. Read IMAGE 2:
   - brand: the brand name exactly as printed (e.g. "H&M", "Patagonia", "Nike")
   - size: the size as printed (e.g. "M", "L", "32x30", "XS"). estimate if not visible/unreadable (write estimate if it is)

2. garment_type: 1-2 words for the generic garment category only.
   Examples: "Hoodie", "Bomber Jacket", "Jeans", "Puffer Vest", "Flannel Shirt".
   NO colours, NO materials, NO fit descriptors.

3. category: Exact department label. Choose the single best match:
   Clothing — Men's: "Men's Jackets", "Men's Sweaters", "Men's Hoodies",
     "Men's T-Shirts", "Men's Shirts", "Men's Pants", "Men's Jeans",
     "Men's Shorts", "Men's Activewear", "Men's Coats"
   Clothing — Women's: "Women's Jackets", "Women's Sweaters", "Women's Hoodies",
     "Women's T-Shirts", "Women's Tops", "Women's Pants", "Women's Jeans",
     "Women's Shorts", "Women's Dresses", "Women's Activewear", "Women's Coats"
   Clothing — Kids': "Kids' Clothing"
   Shoes: "Men's Shoes", "Women's Shoes", "Kids' Shoes"
   Electronics: "Electronics"  (smartwatches, phones, headphones, etc.)
   Wares: "Wares"  (bags, backpacks, water bottles, accessories, housewares, etc.)
   If unsure between Men's/Women's for clothing, use the most common buyer demographic.

4. model_name: 2-3 words MAX. Format: [Identifier] + [garment_type].
   PRIORITY ORDER — use the first that applies:
   a) GRAPHIC/CHARACTER/IP: If IMAGE 1 shows any cartoon, movie, TV, band, game,
      or pop-culture graphic — you MUST name it. Use the franchise/show/character
      name as printed or as you recognise it. Do NOT describe the graphic; name it.
      "The Simpsons" → "Simpsons Hoodie". "Homer Simpson" → "Simpsons Hoodie".
      "Star Wars stormtrooper" → "Star Wars Hoodie". "AC/DC" → "AC/DC Tee".
   b) LOGO/SLOGAN: visible text graphic (band name, slogan, university name).
   c) PATTERN: distinctive pattern (Plaid, Camo, Tie-Dye, Argyle).
   d) Default: garment_type only (e.g. "Hoodie").

5. condition_assessment: 1 sentence. Be blunt and specific about what you see
   across ALL provided images. Name the issue and where it is.
   Examples: "Visible stain on left sleeve and moderate pilling across chest."
             "Fading along shoulders with a small bleach spot on the back."
             "No visible issues — garment appears clean and unworn."
   Do NOT soften language. "Light wear" is fine; never say "gently used" for stained
   or damaged items.

6. flags: Array of condition flags. Include ALL that apply (can be both at once):
   - "damage": visible rips, tears, holes, pilling, fraying, heavy wear-through,
     or any structural deterioration
   - "stain": ANY stain, mark, discoloration, yellowing, fading, bleach spots,
     color inconsistency, or uneven color anywhere on the garment — even subtle ones.
     Fading on shoulders/cuffs counts. Yellowed underarms count.
   Return [] ONLY if the garment is genuinely clean with no visible issues.
   When in doubt, flag it.

   MANDATORY ZONE INSPECTION — check every zone before deciding on flags.
   Do NOT give a clean result without explicitly examining each of these:
   ▸ UNDERARMS/ARMPITS: the sleeve-to-body junction area. This is the #1 missed
     defect. On white, cream, or light-colored garments look for ANY yellowing,
     gray patches, brown tinge, or darkening at this junction. Even subtle
     discoloration = "stain". Sweat stains here are often yellow or gray.
   ▸ COLLAR/NECKLINE: ring-around-collar, yellowing, body oil buildup, discoloration
   ▸ CUFFS/SLEEVE ENDS: staining, fraying, pilling, wear
   ▸ FRONT BODY: food stains, graphic cracks, fading, pilling
   ▸ BACK BODY: seat wear, underarm staining visible from back, fading
   ▸ HEMLINE: fraying, staining, uneven wear
   If you cannot clearly see a zone (e.g. underarms are folded under), note it
   but still flag based on what IS visible.

7. condition_rating: integer 1-10. Be strict — err on the low side.
   10 = brand new with tags, 8-9 = excellent (no visible wear),
   6-7 = good (minor wear only, completely clean),
   3-4 = fair (stain OR damage present — REQUIRED if any flag is set),
   1-2 = poor (multiple issues, heavy staining, or significant damage).
   If ANY flag is set, rating MUST be 4 or below. Wrinkles alone do not lower score.

7. original_msrp: USD float. The typical original retail price for this brand/garment
   when new. Use your knowledge of typical retail prices for this brand.
   If genuinely unknown, use null.

9. estimated_as_is_value: USD float. What this sells for used given its condition.


Respond with ONLY valid JSON, no markdown, no prose:
{
  "brand": "string",
  "size": "string or null",
  "garment_type": "string",
  "category": "string",
  "model_name": "string",
  "condition_assessment": "string",
  "flags": [],
  "condition_rating": 7,
  "original_msrp": 0.00,
  "estimated_as_is_value": 0.00
}
"""

DASHBOARD_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>P&G Scanner &mdash; Live</title>
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0A0A14;--card:#111120;--border:#1C1C30;--accent:#E94560;--text:#F0F0F0;--muted:#5A5A78;--sub:#9090B0;--white:#FFFFFF;--green:#16A34A;--red:#DC2626;--yellow:#EAB308}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;overflow-x:hidden}

/* Header */
.hdr{display:flex;align-items:center;justify-content:space-between;padding:14px 28px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--bg);z-index:100}
.hdr-title{font-size:15px;font-weight:900;letter-spacing:3px;text-transform:uppercase;color:var(--white)}
.hdr-title b{color:var(--accent)}
.status-pill{display:flex;align-items:center;gap:7px;padding:6px 14px;border-radius:20px;background:var(--card);border:1px solid var(--border);font-size:11px;font-weight:800;letter-spacing:2px;color:var(--muted);transition:all .3s}
.status-pill.live{border-color:var(--green);color:var(--green)}
.sdot{width:7px;height:7px;border-radius:50%;background:var(--muted);transition:background .3s}
.status-pill.live .sdot{background:var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}

/* ── WAIT VIEW ── */
#waitView{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:72vh;gap:14px;padding:40px}
.w-ico{font-size:56px;opacity:.08}
.w-text{font-size:18px;color:var(--muted);font-weight:700}
.w-sub{font-size:13px;color:#1e1e34;text-align:center;max-width:320px}

/* ── SCAN VIEW ── */
#scanView{padding:24px 28px;display:none}
.scan-step-row{display:flex;align-items:center;justify-content:center;gap:16px;margin-bottom:10px}
.step-dot{width:11px;height:11px;border-radius:50%;background:var(--border);transition:background .3s,transform .25s}
.step-dot.active{background:var(--accent);transform:scale(1.45)}
.step-dot.done{background:var(--green)}
.step-label{font-size:11px;font-weight:800;letter-spacing:3px;color:var(--muted);text-align:center;margin-bottom:20px;min-height:16px}
.scan-body{display:flex;gap:14px;height:calc(100vh - 260px);min-height:520px}

/* Left thumbnail column — slides open when photos confirmed */
.thumb-col{width:0;overflow:hidden;transition:width .45s cubic-bezier(.4,0,.2,1);flex-shrink:0;display:flex;flex-direction:column;gap:10px;align-items:flex-start}
.thumb-col.has-items{width:100px}
.conf-thumb{width:92px;height:92px;border-radius:10px;overflow:hidden;background:#0d0d1a;border:2px solid var(--border);flex-shrink:0;animation:thumbIn .4s;position:relative}
.conf-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.ct-label{position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,.76);text-align:center;font-size:8px;font-weight:800;letter-spacing:1.5px;color:var(--sub);padding:3px 0}
@keyframes thumbIn{from{opacity:0;transform:scale(.55)}to{opacity:1;transform:scale(1)}}

/* Center live photo */
.scan-photo-wrap{flex:1;border-radius:16px;overflow:hidden;background:#0d0d1a;border:1px solid var(--border);position:relative}
.scan-photo-wrap img{width:100%;height:100%;object-fit:cover;display:none}
.scan-photo-ph{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--muted)}
.scan-photo-ph .sph-ico{font-size:52px;opacity:.1}
.scan-photo-ph .sph-txt{font-size:13px;font-weight:700;letter-spacing:1.5px}

/* ── RESULT VIEW ── */
#resultView{padding:24px 28px;display:none}
.result-grid{display:grid;grid-template-columns:380px 1fr;gap:24px;align-items:start}
@media(max-width:860px){.result-grid{grid-template-columns:1fr}}

/* Photo gallery (result) */
.gallery{display:flex;flex-direction:column;gap:10px}
.main-photo{width:100%;aspect-ratio:3/4;border-radius:16px;overflow:hidden;background:#0d0d1a;border:1px solid var(--border);display:flex;align-items:center;justify-content:center}
.main-photo img{width:100%;height:100%;object-fit:cover;display:none}
.photo-placeholder{display:flex;flex-direction:column;align-items:center;gap:10px;color:var(--muted);padding:20px;text-align:center}
.photo-placeholder .ico{font-size:44px;opacity:.12}
.photo-placeholder .pt{font-size:14px;font-weight:600;letter-spacing:1px}
.thumbs{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.thumb{aspect-ratio:1;border-radius:10px;overflow:hidden;background:#0d0d1a;border:2px solid var(--border);cursor:pointer;position:relative;transition:border-color .2s}
.thumb.active{border-color:var(--accent)}
.thumb img{width:100%;height:100%;object-fit:cover}
.tlabel{position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,.72);text-align:center;font-size:8px;font-weight:800;letter-spacing:1.5px;color:var(--sub);padding:3px 0}
.thumb.active .tlabel{color:var(--accent)}

/* Info panel */
.info{background:var(--card);border:1px solid var(--border);border-radius:20px;padding:28px;display:flex;flex-direction:column;gap:20px;transition:border-color .6s,box-shadow .6s}
.info.flash{border-color:var(--accent);box-shadow:0 0 40px rgba(233,69,96,.25)}
.brand-row{display:flex;align-items:center;gap:10px}
.brand{font-size:11px;color:var(--muted);font-weight:700;letter-spacing:3px;text-transform:uppercase}
.sz{font-size:11px;color:var(--muted);background:rgba(255,255,255,.05);border:1px solid var(--border);padding:3px 10px;border-radius:6px;font-weight:600}
.model{font-size:38px;font-weight:900;color:var(--white);line-height:1.1}
.flags{display:flex;gap:8px;flex-wrap:wrap}
.flag{padding:8px 18px;border-radius:24px;font-size:13px;font-weight:800;letter-spacing:.5px;border:1px solid}
.fg{background:rgba(22,163,74,.15);border-color:var(--green);color:var(--green)}
.fd{background:rgba(220,38,38,.15);border-color:var(--red);color:var(--red)}
.fs{background:rgba(202,138,4,.15);border-color:#CA8A04;color:var(--yellow)}
.price-row{display:flex;align-items:flex-end;gap:28px}
.plabel{font-size:10px;color:var(--muted);font-weight:700;letter-spacing:3px;margin-bottom:2px}
.pval{font-size:60px;font-weight:900;color:var(--accent);letter-spacing:-2px;line-height:1}
.msrp-val{font-size:30px;font-weight:700;color:var(--muted)}
.pdiv{width:1px;height:56px;background:var(--border);align-self:flex-end}
.cond-row{display:flex;align-items:flex-start;gap:14px}
.cond-text{flex:1;font-size:15px;color:var(--sub);line-height:1.7}
.rating{background:#0d0d1a;border:1px solid var(--border);border-radius:12px;padding:8px 16px;text-align:center;flex-shrink:0}
.rnum{font-size:22px;font-weight:900;color:var(--white)}
.rdenom{font-size:12px;color:var(--muted)}
.actions{display:flex;gap:12px}
.btn-sec{flex:1;padding:15px;border-radius:14px;border:1px solid var(--border);background:transparent;color:var(--sub);font-size:13px;font-weight:700;letter-spacing:1px;cursor:pointer;text-decoration:none;text-align:center;transition:border-color .2s,color .2s}
.btn-sec:hover{border-color:var(--sub);color:var(--white)}
.btn-pri{flex:1;padding:15px;border-radius:14px;border:none;background:#F5C800;color:#111;font-size:13px;font-weight:900;letter-spacing:1.5px;cursor:pointer;transition:opacity .2s}
.btn-pri:hover{opacity:.88}

/* Recent strip */
.recent-wrap{padding:0 28px 36px}
.recent-hdr{font-size:10px;color:var(--muted);font-weight:700;letter-spacing:3px;padding:20px 0 14px;border-top:1px solid var(--border)}
.strip{display:flex;gap:12px;overflow-x:auto;padding-bottom:4px}
.strip::-webkit-scrollbar{height:4px}
.strip::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.rc{flex-shrink:0;width:136px;background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden;cursor:pointer;transition:border-color .2s}
.rc:hover{border-color:var(--sub)}
.rc img,.rc-ph{width:100%;height:94px;object-fit:cover;display:block;background:#0d0d1a}
.rc-ph{display:flex;align-items:center;justify-content:center;font-size:26px;opacity:.1}
.rc-body{padding:8px 10px}
.rc-brand{font-size:9px;color:var(--muted);font-weight:700;letter-spacing:2px;text-transform:uppercase}
.rc-model{font-size:12px;color:var(--white);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:2px 0 4px}
.rc-price{font-size:15px;font-weight:900;color:var(--accent)}
.rc-flags{display:flex;gap:4px;margin-top:4px}
.rf{width:8px;height:8px;border-radius:50%}

/* Print tag modal */
.tag-overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);display:none;align-items:center;justify-content:center;z-index:200}
.tag-overlay.open{display:flex}
.tag-card{background:#fff;border-radius:8px;width:330px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.6);position:relative}
.tag-x{position:absolute;top:10px;left:12px;z-index:10;background:none;border:none;font-size:15px;color:#555;cursor:pointer;font-weight:700;padding:4px}
.tag-hdr{padding:28px 20px 14px;text-align:center}
.tag-hdr-title{font-size:28px;font-weight:900;letter-spacing:3px}
.tag-cat-block{padding:12px 20px 10px;text-align:center}
.tag-cat{font-size:15px;font-weight:600;color:#333}
.tag-brand-sub{font-size:13px;color:#666;margin-top:2px}
.tag-divider{height:1px;background:#ddd;margin:0 20px}
.tag-detail{padding:18px 24px;text-align:center;display:flex;flex-direction:column;gap:6px;align-items:center}
.tag-size{font-size:16px;color:#333;font-weight:500}
.tag-price{font-size:48px;font-weight:900;color:#111;letter-spacing:-1px}
.tag-barcode{padding:12px 20px 16px;display:flex;flex-direction:column;align-items:center;gap:6px}
.bc-row{display:flex;align-items:flex-end;height:40px;gap:1px}
.bc-bar{height:100%;background:#111}
.bc-num{font-size:10px;color:#555;letter-spacing:2px;font-family:monospace}
.tag-print-btn{display:block;width:calc(100% - 40px);margin:0 20px 16px;padding:12px;background:#111;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:700;letter-spacing:1px;cursor:pointer}

@media print{
  body>*:not(.tag-overlay){display:none!important}
  .tag-overlay{display:flex!important;position:static!important;background:none!important}
  .tag-x,.tag-print-btn{display:none!important}
  .tag-card{box-shadow:none!important}
}
</style>
</head>
<body>

<div class="hdr">
  <span class="hdr-title">P&amp;G <b>Scanner</b></span>
  <div class="status-pill" id="pill"><div class="sdot"></div><span id="stext">CONNECTING</span></div>
</div>

<!-- WAIT VIEW -->
<div id="waitView">
  <div class="w-ico">&#128247;</div>
  <div class="w-text">Waiting for scan&hellip;</div>
  <div class="w-sub">Scan a garment using the foot pedal &mdash; results appear here instantly</div>
</div>

<!-- SCAN VIEW: live capture in progress -->
<div id="scanView">
  <div class="scan-step-row">
    <div class="step-dot" id="sd0"></div>
    <div class="step-dot" id="sd1"></div>
    <div class="step-dot" id="sd2"></div>
  </div>
  <div class="step-label" id="stepLbl"></div>
  <div class="scan-body">
    <!-- Confirmed thumbnails slide in from left -->
    <div class="thumb-col" id="thumbCol"></div>
    <!-- Current photo fills remaining space -->
    <div class="scan-photo-wrap" id="scanPhotoWrap">
      <div class="scan-photo-ph" id="scanPhotoPh">
        <div class="sph-ico">&#128247;</div>
        <div class="sph-txt">WAITING FOR PHOTO</div>
      </div>
      <img id="scanImg" src="" alt="">
    </div>
  </div>
</div>

<!-- RESULT VIEW: full scan complete -->
<div id="resultView">
  <div class="result-grid">
    <div class="gallery">
      <div class="main-photo" id="mainPhoto">
        <div class="photo-placeholder" id="photoPH">
          <div class="ico">&#128247;</div>
          <div class="pt">NO PHOTO</div>
        </div>
        <img id="mainImg" src="" alt="">
      </div>
      <div class="thumbs">
        <div class="thumb active" id="th0" onclick="sel(0)"><img id="ti0" src="" alt=""><div class="tlabel">GARMENT</div></div>
        <div class="thumb" id="th1" onclick="sel(1)"><img id="ti1" src="" alt=""><div class="tlabel">TAG</div></div>
        <div class="thumb" id="th2" onclick="sel(2)"><img id="ti2" src="" alt=""><div class="tlabel">BACK</div></div>
      </div>
    </div>
    <div class="info" id="infoPanel">
      <div class="brand-row">
        <span class="brand" id="iBrand"></span>
        <span class="sz" id="iSize" style="display:none"></span>
      </div>
      <div class="model" id="iModel"></div>
      <div class="flags" id="iFlags"></div>
      <div class="price-row">
        <div><div class="plabel">AS-IS VALUE</div><div class="pval" id="iPrice"></div></div>
        <div class="pdiv" id="iPDiv" style="display:none"></div>
        <div id="iMsrpBlock" style="display:none"><div class="plabel">RETAIL</div><div class="msrp-val" id="iMsrp"></div></div>
      </div>
      <div class="cond-row">
        <div class="cond-text" id="iCond"></div>
        <div class="rating"><span class="rnum" id="iRating"></span><span class="rdenom">/10</span></div>
      </div>
      <div class="actions">
        <a class="btn-sec" id="iExplore" href="#" target="_blank" rel="noopener">Explore Similar</a>
        <button class="btn-pri" onclick="openTag()">Print Tag</button>
      </div>
    </div>
  </div>
</div>

<!-- Recent scans (always visible) -->
<div class="recent-wrap">
  <div class="recent-hdr">RECENT SCANS</div>
  <div class="strip" id="strip"><span style="color:#1e1e34;font-size:13px">No scans yet</span></div>
</div>

<!-- Print Tag Modal -->
<div class="tag-overlay" id="tagOverlay" onclick="if(event.target===this)closeTag()">
  <div class="tag-card">
    <button class="tag-x" onclick="closeTag()">&#10005;</button>
    <div class="tag-hdr" id="tagHdr"><div class="tag-hdr-title" id="tagTitle">GOODWILL</div></div>
    <div class="tag-cat-block">
      <div class="tag-cat" id="tagCat"></div>
      <div class="tag-brand-sub" id="tagBrandSub"></div>
    </div>
    <div class="tag-divider"></div>
    <div class="tag-detail">
      <div class="tag-size" id="tagSz"></div>
      <div class="tag-price" id="tagPrc"></div>
    </div>
    <div class="tag-divider"></div>
    <div class="tag-barcode">
      <div class="bc-row" id="bcRow"></div>
      <div class="bc-num" id="bcNum"></div>
    </div>
    <button class="tag-print-btn" onclick="window.print()">&#128424; Print Tag</button>
  </div>
</div>

<script>
// ── State ─────────────────────────────────────────────────────────────────────
var cur = null;
var resultPhotos = [null, null, null];
var hist = [];
var viewState = 'wait';
var curStepN = -1;
var stepPhotos = [null, null, null];
var lastId = null;
var initialized = false;
var lastPreviewAt = null;

var STEP_N = {garment: 0, tag: 1, back: 2};
var STEP_LABELS = ['1 / 3  \u2014  GARMENT', '2 / 3  \u2014  TAG', '3 / 3  \u2014  BACK'];
var STEP_SHORT = ['GARMENT', 'TAG', 'BACK'];

// ── View switcher ─────────────────────────────────────────────────────────────
function showView(v) {
  viewState = v;
  document.getElementById('waitView').style.display = v === 'wait' ? 'flex' : 'none';
  document.getElementById('scanView').style.display = v === 'scan' ? 'block' : 'none';
  document.getElementById('resultView').style.display = v === 'result' ? 'block' : 'none';
}

// ── Scan view helpers ─────────────────────────────────────────────────────────
function resetScanView() {
  curStepN = -1;
  stepPhotos = [null, null, null];
  document.getElementById('thumbCol').innerHTML = '';
  document.getElementById('thumbCol').classList.remove('has-items');
  var img = document.getElementById('scanImg');
  img.src = '';
  img.style.display = 'none';
  document.getElementById('scanPhotoPh').style.display = 'flex';
  document.getElementById('stepLbl').textContent = '';
  updateStepDots(-1);
}

function updateStepDots(n) {
  for (var i = 0; i < 3; i++) {
    var dot = document.getElementById('sd' + i);
    dot.className = 'step-dot' + (i < n ? ' done' : i === n ? ' active' : '');
  }
  document.getElementById('stepLbl').textContent = n >= 0 ? STEP_LABELS[n] : '';
}

function addConfirmedThumb(url, n) {
  if (!url) return;
  var col = document.getElementById('thumbCol');
  var div = document.createElement('div');
  div.className = 'conf-thumb';
  div.innerHTML = '<img src="' + url + '" alt=""><div class="ct-label">' + STEP_SHORT[n] + '</div>';
  col.appendChild(div);
  col.classList.add('has-items');
}

function setScanPhoto(url) {
  var img = document.getElementById('scanImg');
  var ph = document.getElementById('scanPhotoPh');
  if (url) {
    img.src = url;
    img.style.display = 'block';
    ph.style.display = 'none';
  } else {
    img.style.display = 'none';
    ph.style.display = 'flex';
  }
}

// Called each time a new preview arrives from the phone
function onNewPreview(url, step) {
  var n = (STEP_N[step] !== undefined) ? STEP_N[step] : 0;
  // Detect start of a new scan
  var isNewScan = (n === 0 && (curStepN > 0 || viewState === 'result'));
  if (isNewScan) {
    if (cur) addToStrip(cur); // push completed scan to recent strip
    resetScanView();
  }
  // If step advanced, slide previous photo into thumbnail column
  if (n > curStepN && curStepN >= 0) {
    addConfirmedThumb(stepPhotos[curStepN], curStepN);
  }
  stepPhotos[n] = url;
  curStepN = n;
  updateStepDots(n);
  setScanPhoto(url);
  if (viewState !== 'scan') showView('scan');
}

// ── Result view helpers ───────────────────────────────────────────────────────
function hdrColor(cat) {
  var c = (cat || '').toLowerCase();
  if (c.includes('women')) return '#E85D8A';
  if (c.includes('men'))   return '#2A7DC9';
  if (c.includes('kids'))  return '#4CAF50';
  if (c.includes('electronics')) return '#9C27B0';
  if (c.includes('wares')) return '#FF7043';
  return '#F5C800';
}

function sel(i) {
  for (var j = 0; j < 3; j++) {
    document.getElementById('th' + j).classList.toggle('active', j === i);
  }
  var url = resultPhotos[i];
  var img = document.getElementById('mainImg');
  var ph  = document.getElementById('photoPH');
  if (url) { img.src = url; img.style.display = 'block'; ph.style.display = 'none'; }
  else     { img.style.display = 'none'; ph.style.display = 'flex'; }
}

function renderFlags(flags) {
  var el = document.getElementById('iFlags');
  el.innerHTML = '';
  if (!flags || !flags.length) {
    el.innerHTML = '<div class="flag fg">&#10003;&nbsp; Good Condition</div>';
    return;
  }
  flags.forEach(function(f) {
    var cls = f === 'damage' ? 'fd' : 'fs';
    var lbl = f === 'damage' ? '&#9888;&nbsp; Damage Detected' : '&#9711;&nbsp; Stain Detected';
    el.innerHTML += '<div class="flag ' + cls + '">' + lbl + '</div>';
  });
}

function showResult(item) {
  cur = item;
  resultPhotos = [item.image_url || null, item.tag_image_url || null, item.back_image_url || null];
  showView('result');

  ['image_url', 'tag_image_url', 'back_image_url'].forEach(function(k, i) {
    var ti = document.getElementById('ti' + i);
    ti.src = item[k] || '';
    ti.style.opacity = item[k] ? '1' : '0.15';
  });
  sel([0, 1, 2].find(function(i) { return resultPhotos[i]; }) || 0);

  document.getElementById('iBrand').textContent  = item.brand || '';
  document.getElementById('iModel').textContent  = item.model_name || '';
  document.getElementById('iPrice').textContent  = '$' + (item.estimated_as_is_value || 0).toFixed(2);
  document.getElementById('iCond').textContent   = item.condition_assessment || '';
  document.getElementById('iRating').textContent = item.condition_rating != null ? item.condition_rating : '\u2013';

  var szel = document.getElementById('iSize');
  if (item.size) { szel.textContent = item.size; szel.style.display = ''; }
  else { szel.style.display = 'none'; }

  var mb = document.getElementById('iMsrpBlock'), pd = document.getElementById('iPDiv');
  if (item.original_msrp > 0) {
    document.getElementById('iMsrp').textContent = '$' + item.original_msrp.toFixed(2);
    mb.style.display = ''; pd.style.display = '';
  } else { mb.style.display = 'none'; pd.style.display = 'none'; }

  document.getElementById('iExplore').href = item.explore_url || '#';
  renderFlags(item.flags || []);

  var panel = document.getElementById('infoPanel');
  panel.classList.remove('flash');
  void panel.offsetWidth;
  panel.classList.add('flash');
  setTimeout(function() { panel.classList.remove('flash'); }, 1300);
}

// ── Recent strip ──────────────────────────────────────────────────────────────
function addToStrip(item) {
  if (!item) return;
  if (hist.find(function(h) { return h.id === item.id; })) return; // no duplicates
  hist.unshift(item);
  var strip = document.getElementById('strip');
  if (hist.length === 1) strip.innerHTML = '';
  var flags = item.flags || [];
  var dots = flags.length === 0
    ? '<div class="rf" style="background:#16A34A"></div>'
    : flags.map(function(f) {
        return '<div class="rf" style="background:' + (f === 'damage' ? '#DC2626' : '#EAB308') + '"></div>';
      }).join('');
  var th = item.image_url ? '<img src="' + item.image_url + '" alt="">' : '<div class="rc-ph">&#128247;</div>';
  var el = document.createElement('div');
  el.className = 'rc';
  el.innerHTML = th + '<div class="rc-body">'
    + '<div class="rc-brand">'  + (item.brand || '') + '</div>'
    + '<div class="rc-model">'  + (item.model_name || '') + '</div>'
    + '<div class="rc-price">$' + (item.estimated_as_is_value || 0).toFixed(2) + '</div>'
    + '<div class="rc-flags">'  + dots + '</div></div>';
  el.onclick = function() { showResult(item); };
  strip.insertBefore(el, strip.firstChild);
}

// ── Print tag ─────────────────────────────────────────────────────────────────
function buildBarcode(id) {
  var row = document.getElementById('bcRow');
  row.innerHTML = '';
  var ws = [1, 2, 1, 3, 1, 2, 1, 1, 2, 3];
  for (var i = 0; i < 30; i++) {
    var b = document.createElement('div');
    b.className = 'bc-bar';
    b.style.width = ws[i % 10] + 'px';
    row.appendChild(b);
  }
  document.getElementById('bcNum').textContent = (id || '').replace(/-/g, '').slice(0, 12).toUpperCase();
}

function openTag() {
  if (!cur) return;
  var color = hdrColor(cur.category);
  document.getElementById('tagHdr').style.background = color;
  var isDark = color === '#2A7DC9' || color === '#9C27B0';
  document.getElementById('tagTitle').style.color = isDark ? '#fff' : '#111';
  document.getElementById('tagCat').textContent      = cur.category || 'Clothing';
  document.getElementById('tagBrandSub').textContent = cur.brand || '';
  document.getElementById('tagSz').textContent       = cur.size ? 'Size  ' + cur.size : '';
  document.getElementById('tagPrc').textContent      = '$' + (cur.estimated_as_is_value || 0).toFixed(2);
  buildBarcode(cur.id);
  document.getElementById('tagOverlay').classList.add('open');
}
function closeTag() { document.getElementById('tagOverlay').classList.remove('open'); }

// ── Status pill ───────────────────────────────────────────────────────────────
function setStatus(live) {
  var pill = document.getElementById('pill');
  pill.className = 'status-pill' + (live ? ' live' : '');
  document.getElementById('stext').textContent = live ? 'LIVE' : 'RECONNECTING';
}

// ── Polling ───────────────────────────────────────────────────────────────────
async function poll() {
  try {
    var res = await fetch('/api/v1/scans');
    if (!res.ok) throw new Error(res.status);
    var data = await res.json();
    setStatus(true);
    var items = data.items || [];
    if (!initialized) {
      initialized = true;
      items.slice(0, 8).reverse().forEach(function(item) { addToStrip(item); });
      if (items.length > 0) { lastId = items[0].id; showResult(items[0]); }
    } else if (items.length > 0 && items[0].id !== lastId) {
      lastId = items[0].id;
      showResult(items[0]);
      addToStrip(items[0]);
    }
  } catch (e) { setStatus(false); }
}

poll();
setInterval(poll, 2500);
</script>
<script src="https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js"></script>
<script>
firebase.initializeApp({
  apiKey: "AIzaSyA59fEi3RVl6apMHouuQYaCKMXKZS2ASmw",
  databaseURL: "https://pgscanner-4188c-default-rtdb.firebaseio.com",
  projectId: "pgscanner-4188c",
});
firebase.database().ref('/preview/current').on('value', function(snap) {
  var d = snap.val();
  if (!d || !d.updated_at) return;
  if (d.updated_at === lastPreviewAt) return;
  var prev = lastPreviewAt;
  lastPreviewAt = d.updated_at;
  if (!d.thumbnail || d.step === 'completed') {
    if (viewState === 'scan') showView(cur ? 'result' : 'wait');
    return;
  }
  // Prime on first load — ignore stale RT DB state
  if (prev === null) return;
  onNewPreview('data:image/jpeg;base64,' + d.thumbnail, d.step);
});
</script>
</body></html>"""

PRICING_PROMPT_TEMPLATE = """
What is the current original retail price (MSRP) for this garment?
  Brand: {brand}
  Model: {model_name}

Search Google for "{brand} {model_name} retail price" and return the price
from the brand's website or a major retailer (Nordstrom, REI, Macy's).

Return ONLY valid JSON, no markdown, no prose:
{{
  "original_msrp": 0.00
}}
"""

# ── Pydantic Models ───────────────────────────────────────────────────────────
class ScanResult(BaseModel):
    id: str
    brand: str
    size: Optional[str] = None
    garment_type: str
    category: str = "Clothing"
    model_name: str
    condition_assessment: str
    flags: list[str] = Field(default_factory=list)
    condition_rating: int = 5
    original_msrp: Optional[float] = None
    estimated_as_is_value: float
    explore_url: str
    image_url: Optional[str] = None
    tag_image_url: Optional[str] = None
    back_image_url: Optional[str] = None
    source_urls: list[str] = Field(default_factory=list)
    scan_timestamp: str


class ScanResponse(BaseModel):
    status: str
    facility: Optional[str]
    data: ScanResult


class CatalogResponse(BaseModel):
    status: str
    items: list[ScanResult]


# ── App Lifespan ──────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY is not set.")
    app.state.gemini = genai.Client(api_key=GEMINI_API_KEY)
    log.info(f"Gemini client ready. Model: {MODEL_ID}")
    yield
    log.info("Server shutting down.")


app = FastAPI(title="P&G Intelligent Scanner API", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

# ── SSE broadcast ─────────────────────────────────────────────────────────────
_sse_clients: set[asyncio.Queue] = set()

async def broadcast_scan(data: dict) -> None:
    dead = set()
    for q in _sse_clients:
        try:
            q.put_nowait(data)
        except Exception:
            dead.add(q)
    _sse_clients -= dead


# ── Helpers ───────────────────────────────────────────────────────────────────
def compress_image(raw_bytes: bytes, max_dim: int = IMAGE_MAX_DIM) -> tuple[Image.Image, bytes]:
    """Returns both PIL image (for Gemini) and compressed JPEG bytes (for storage)."""
    img = Image.open(io.BytesIO(raw_bytes))
    img = img.convert("RGB")
    img.thumbnail((max_dim, max_dim), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return img, buf.getvalue()


def extract_json(text: str) -> dict:
    cleaned = re.sub(r"```(?:json)?\s*", "", text).strip().rstrip("`").strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned, re.DOTALL)
        if match:
            return json.loads(match.group())
        raise ValueError(f"Could not parse JSON. First 400 chars: {text[:400]}")


async def upload_image_to_gcs(image_bytes: bytes, path: str) -> Optional[str]:
    """Upload image to GCS at the given path and return public URL."""
    try:
        from google.cloud import storage

        def _upload():
            client = storage.Client(project=GCP_PROJECT)
            bucket = client.bucket(GCS_BUCKET)
            blob = bucket.blob(path)
            blob.upload_from_string(image_bytes, content_type="image/jpeg")
            return f"https://storage.googleapis.com/{GCS_BUCKET}/{path}"

        return await asyncio.to_thread(_upload)
    except Exception as exc:
        log.warning(f"GCS upload failed (non-fatal): {exc}")
        return None


async def save_to_firestore(scan_data: dict) -> None:
    """Save scan metadata to Firestore."""
    try:
        from google.cloud import firestore

        def _save():
            db = firestore.Client(project=GCP_PROJECT)
            db.collection("scans").document(scan_data["id"]).set(scan_data)

        await asyncio.to_thread(_save)
        log.info(f"Saved scan {scan_data['id']} to Firestore.")
    except Exception as exc:
        log.warning(f"Firestore save failed (non-fatal): {exc}")


async def save_preview_to_firestore(data: dict) -> None:
    try:
        from google.cloud import firestore

        def _save():
            db = firestore.Client(project=GCP_PROJECT)
            db.collection("preview").document("latest").set(data)

        await asyncio.to_thread(_save)
    except Exception as exc:
        log.warning(f"Preview save failed (non-fatal): {exc}")


async def load_preview_from_firestore() -> dict:
    try:
        from google.cloud import firestore

        def _load():
            db = firestore.Client(project=GCP_PROJECT)
            doc = db.collection("preview").document("latest").get()
            return doc.to_dict() if doc.exists else {}

        return await asyncio.to_thread(_load)
    except Exception as exc:
        log.warning(f"Preview load failed: {exc}")
        return {}


async def load_catalog_from_firestore() -> list[dict]:
    """Load all scans ordered by timestamp."""
    try:
        from google.cloud import firestore

        def _load():
            db = firestore.Client(project=GCP_PROJECT)
            docs = db.collection("scans").order_by(
                "scan_timestamp", direction=firestore.Query.DESCENDING
            ).limit(100).stream()
            return [doc.to_dict() for doc in docs]

        return await asyncio.to_thread(_load)
    except Exception as exc:
        log.warning(f"Firestore load failed: {exc}")
        return []


# ── Endpoints ─────────────────────────────────────────────────────────────────
@app.post("/api/v1/scan", response_model=ScanResponse)
async def scan_item(
    jacket_image: UploadFile = File(...),
    tag_image: UploadFile = File(...),
    back_image: UploadFile = File(...),
    facility: Optional[str] = Query(None),
):
    log.info(f"Scan request — facility={facility!r}")
    scan_id = str(uuid.uuid4())

    try:
        jacket_bytes_raw = await jacket_image.read()
        tag_bytes_raw = await tag_image.read()
        back_bytes_raw = await back_image.read()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to read uploads: {exc}")

    if not jacket_bytes_raw or not tag_bytes_raw or not back_bytes_raw:
        raise HTTPException(status_code=400, detail="jacket_image, tag_image, and back_image are required.")

    try:
        jacket_img, jacket_compressed = compress_image(jacket_bytes_raw)
        tag_img, tag_compressed = compress_image(tag_bytes_raw)
        back_img, back_compressed = compress_image(back_bytes_raw)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Image processing failed: {exc}")

    gemini_client: genai.Client = app.state.gemini

    # Call 1: Vision
    try:
        vision_response = await asyncio.wait_for(
            asyncio.to_thread(
                gemini_client.models.generate_content,
                model=MODEL_ID,
                contents=[jacket_img, tag_img, back_img, VISION_PROMPT],
                config=types.GenerateContentConfig(temperature=0.1),
            ),
            timeout=VISION_TIMEOUT_SECS,
        )
        vision_data = extract_json(vision_response.text)
        log.info(f"Vision: {vision_data.get('brand')} {vision_data.get('model_name')}")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Vision analysis failed: {exc}")

    brand = vision_data.get("brand", "Unknown")
    model_name = vision_data.get("model_name", "Unknown")
    garment_type = vision_data.get("garment_type", model_name)
    category = vision_data.get("category", "Clothing")
    flags = [f for f in vision_data.get("flags", []) if f in ("damage", "stain")]
    raw_rating = int(vision_data.get("condition_rating", 5))
    condition_rating = min(raw_rating, 4) if flags else raw_rating
    size = vision_data.get("size")
    # Use garment_type (simple, generic) for explore URL — better search results
    explore_url = build_explore_url(brand, garment_type)

    original_msrp_raw = vision_data.get("original_msrp")
    original_msrp: Optional[float] = float(original_msrp_raw) if original_msrp_raw else None
    log.info(f"MSRP={original_msrp}")

    estimated_as_is_value = float(vision_data.get("estimated_as_is_value", 0.0))
    timestamp = datetime.now(timezone.utc).isoformat()

    # Upload all 3 images to GCS in parallel (non-fatal)
    image_url, tag_image_url, back_image_url = await asyncio.gather(
        upload_image_to_gcs(jacket_compressed, f"scans/{scan_id}/jacket.jpg"),
        upload_image_to_gcs(tag_compressed,    f"scans/{scan_id}/tag.jpg"),
        upload_image_to_gcs(back_compressed,   f"scans/{scan_id}/back.jpg"),
    )

    scan_result = ScanResult(
        id=scan_id,
        brand=brand,
        size=size,
        garment_type=garment_type,
        category=category,
        model_name=model_name,
        condition_assessment=vision_data.get("condition_assessment", ""),
        flags=flags,
        condition_rating=condition_rating,
        original_msrp=original_msrp,
        estimated_as_is_value=estimated_as_is_value,
        explore_url=explore_url,
        image_url=image_url,
        tag_image_url=tag_image_url,
        back_image_url=back_image_url,
        source_urls=[],
        scan_timestamp=timestamp,
    )

    asyncio.create_task(save_to_firestore({
        **scan_result.model_dump(),
        "facility": facility,
    }))
    asyncio.create_task(broadcast_scan(scan_result.model_dump()))
    # Clear preview so the dashboard doesn't show stale photos on next load
    asyncio.create_task(save_preview_to_firestore({
        "step": "completed",
        "url": None,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }))

    return ScanResponse(status="success", facility=facility, data=scan_result)


@app.get("/api/v1/scans", response_model=CatalogResponse)
async def get_catalog():
    """Return all scanned items ordered by most recent."""
    items_raw = await load_catalog_from_firestore()
    items = []
    for raw in items_raw:
        try:
            items.append(ScanResult(**{k: v for k, v in raw.items() if k != "facility"}))
        except Exception:
            continue
    return CatalogResponse(status="success", items=items)


@app.delete("/api/v1/scans/{scan_id}")
async def delete_scan(scan_id: str):
    """Delete a scan from Firestore and its image from GCS."""
    try:
        from google.cloud import firestore

        def _delete_firestore():
            db = firestore.Client(project=GCP_PROJECT)
            db.collection("scans").document(scan_id).delete()

        await asyncio.to_thread(_delete_firestore)
        log.info(f"Deleted scan {scan_id} from Firestore.")
    except Exception as exc:
        log.warning(f"Firestore delete failed: {exc}")
        raise HTTPException(status_code=500, detail=f"Failed to delete scan: {exc}")

    # Delete image from GCS (non-fatal)
    try:
        from google.cloud import storage

        def _delete_gcs():
            client = storage.Client(project=GCP_PROJECT)
            bucket = client.bucket(GCS_BUCKET)
            blob = bucket.blob(f"{scan_id}.jpg")
            blob.delete()

        await asyncio.to_thread(_delete_gcs)
        log.info(f"Deleted image {scan_id}.jpg from GCS.")
    except Exception as exc:
        log.warning(f"GCS image delete failed (non-fatal): {exc}")

    return {"status": "deleted", "id": scan_id}


@app.get("/api/v1/scans/export.csv")
async def export_csv():
    """Export all scans as a CSV file."""
    items_raw = await load_catalog_from_firestore()
    fields = ["id", "brand", "size", "category", "garment_type", "model_name",
              "condition_rating", "condition_assessment", "original_msrp",
              "estimated_as_is_value", "scan_timestamp", "image_url"]

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    for item in items_raw:
        writer.writerow({k: item.get(k, "") for k in fields})

    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=pg_scanner_export.csv"},
    )


@app.post("/api/v1/preview-photo")
async def upload_preview_photo(
    photo: UploadFile = File(...),
    step: str = Query(...),
):
    """Receive a single in-progress photo and store it for the live dashboard."""
    try:
        raw = await photo.read()
        _, compressed = compress_image(raw)
        preview_id = str(uuid.uuid4())[:8]
        url = await upload_image_to_gcs(compressed, f"preview/{preview_id}.jpg")
        record = {"step": step, "url": url, "updated_at": datetime.now(timezone.utc).isoformat()}
        asyncio.create_task(save_preview_to_firestore(record))
        return record
    except Exception as exc:
        log.warning(f"Preview upload failed: {exc}")
        return {"step": step, "url": None, "updated_at": None}


@app.get("/api/v1/preview-photo")
async def get_preview_photo():
    """Return the latest in-progress photo for the dashboard."""
    return await load_preview_from_firestore()


@app.get("/api/v1/stream")
async def stream_events(request: Request):
    """SSE endpoint — pushes each completed scan to all connected browsers."""
    queue: asyncio.Queue = asyncio.Queue()
    _sse_clients.add(queue)

    async def generator():
        try:
            yield f"data: {json.dumps({'type': 'connected'})}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    data = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"data: {json.dumps(data)}\n\n"
                except asyncio.TimeoutError:
                    yield f"data: {json.dumps({'type': 'ping'})}\n\n"
        finally:
            _sse_clients.discard(queue)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard():
    return HTMLResponse(content=DASHBOARD_HTML)


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL_ID}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
