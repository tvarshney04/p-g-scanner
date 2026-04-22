"""
One-time migration: re-classify scans stuck with category="Clothing".
Uses Gemini to infer the correct department label from existing brand/model/garment_type.

Run:
  GEMINI_API_KEY=<key> GOOGLE_APPLICATION_CREDENTIALS=<path> python fix_clothing_categories.py
  OR just: python fix_clothing_categories.py  (if already authenticated via gcloud)
"""

import os
import sys
from google.cloud import firestore
from google import genai
from google.genai import types

GCP_PROJECT = "pgscanner"
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

CATEGORY_OPTIONS = """
Men's Jackets, Men's Sweaters, Men's Hoodies, Men's T-Shirts, Men's Shirts,
Men's Pants, Men's Jeans, Women's Jackets, Women's Sweaters, Women's Hoodies,
Women's T-Shirts, Women's Shirts, Women's Pants, Women's Jeans, Women's Dresses,
Women's Skirts, Kids' Clothing, Shoes — Men's, Shoes — Women's, Shoes — Kids',
Electronics, Housewares
""".strip()


def classify_category(client, brand: str, model_name: str, garment_type: str) -> str:
    prompt = (
        f"Garment info:\n"
        f"  Brand: {brand}\n"
        f"  Model/description: {model_name}\n"
        f"  Type: {garment_type}\n\n"
        f"Choose the single best category from this list:\n{CATEGORY_OPTIONS}\n\n"
        f"Reply with ONLY the category label, nothing else."
    )
    response = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(temperature=0),
    )
    return response.text.strip()


def main():
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        sys.exit("Set GEMINI_API_KEY env var before running.")

    gemini = genai.Client(api_key=api_key)
    db = firestore.Client(project=GCP_PROJECT)

    VALID = {
        "Men's Jackets","Men's Sweaters","Men's Hoodies","Men's T-Shirts","Men's Shirts",
        "Men's Pants","Men's Jeans","Women's Jackets","Women's Sweaters","Women's Hoodies",
        "Women's T-Shirts","Women's Shirts","Women's Pants","Women's Jeans","Women's Dresses",
        "Women's Skirts","Kids' Clothing","Shoes — Men's","Shoes — Women's","Shoes — Kids'",
        "Electronics","Housewares",
    }
    all_docs = list(db.collection("scans").stream())
    stale = [d for d in all_docs if d.to_dict().get("category") not in VALID]
    print(f"Found {len(stale)} scans with missing or non-standard category (out of {len(all_docs)})")

    if not stale:
        print("Nothing to fix.")
        return

    updated = 0
    errors = 0
    for doc in stale:
        data = doc.to_dict()
        brand = data.get("brand", "Unknown")
        model_name = data.get("model_name", "")
        garment_type = data.get("garment_type", "")

        try:
            new_cat = classify_category(gemini, brand, model_name, garment_type)
            db.collection("scans").document(doc.id).update({"category": new_cat})
            print(f"  ✓ {doc.id[:8]}  {brand} — {garment_type}  →  {new_cat}")
            updated += 1
        except Exception as e:
            print(f"  ✗ {doc.id[:8]}  error: {e}")
            errors += 1

    print(f"\nDone. {updated} updated, {errors} errors.")


if __name__ == "__main__":
    main()
