"""
P&G Intelligent Scanner — Local Test Script
============================================
Runs a single scan against jacket.jpg / tag.jpg in the current directory.
Uses the same Gemini logic as the server but without the HTTP layer.

Usage:
    source .env && python main.py
    # or with python-dotenv installed:
    python main.py
"""

import os
from google import genai
from PIL import Image

# Load .env if python-dotenv is available (local dev convenience)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # In production, env vars are injected directly


def run_final_scan(jacket_path="jacket.jpg", tag_path="tag.jpg"):
    print("INITIALIZING P&G INTELLIGENT SCANNER...")

    try:
        # genai.Client() automatically reads GEMINI_API_KEY from environment
        client = genai.Client()

        # --- 1. AUTO-DETECT MODEL ---
        print(" Auto-detecting approved models for your API key...")
        valid_model = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")

        for m in client.models.list():
            if "flash" in m.name:
                valid_model = m.name.replace("models/", "")
                break

        print(f"✅ Secured model: {valid_model}")

        # --- 2. AUTO-COMPRESS IMAGES ---
        print("Loading and compressing images to prevent Quota Limits...")
        jacket_img = Image.open(jacket_path)
        jacket_img.thumbnail((512, 512))

        tag_img = Image.open(tag_path)
        tag_img.thumbnail((512, 512))

        # --- 3. THE PROMPT ---
        prompt = """
        Analyze this clothing item for a Goodwill processing line:
        1. Identify the exact Brand and Model using the 'tag' image.
        2. Assess the condition (stains, pilling) using the 'jacket' image.
        3. Estimate a resale price.
        4. CRITICAL LOGIC: If it is a premium brand but has a minor stain,
           mark 'pg_restoration_eligible' as True.

        Return the result as a clean JSON summary.
        """

        print("AI Reasoning (Cross-referencing tag and garment)...")

        response = client.models.generate_content(
            model=valid_model,
            contents=[jacket_img, tag_img, prompt],
        )

        print("\n--- FINAL AI DETERMINATION ---")
        print(response.text)

    except FileNotFoundError:
        print("\n❌ ERROR: Cannot find jacket.jpg or tag.jpg in this folder.")
    except Exception as e:
        print(f"\n❌ ERROR: {e}")


if __name__ == "__main__":
    run_final_scan()
