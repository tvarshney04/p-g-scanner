"""
One-time backfill: assign Good/Better/Best tier to existing scans that lack it.
Uses the same logic as the Gemini prompt — computed from existing structured fields.

Run:
  python fix_tiers.py
  (requires gcloud auth application-default login)
"""

from google.cloud import firestore

GCP_PROJECT = "pgscanner"

PREMIUM_BRANDS = {
    "arc'teryx", "arcteryx", "patagonia", "lululemon", "moncler",
    "canada goose", "burberry", "gucci", "prada", "the north face",
    "north face", "filson", "barbour", "stone island", "acne studios",
    "ami", "allbirds", "on running",
}


def compute_tier(item: dict) -> str:
    value = float(item.get("estimated_as_is_value") or 0)
    flags = item.get("flags") or []
    rating = int(item.get("condition_rating") or 5)
    brand = (item.get("brand") or "").lower().strip()

    has_damage = "damage" in flags
    has_stain = "stain" in flags
    is_premium = any(p in brand for p in PREMIUM_BRANDS)

    if has_damage:
        return "good"

    if value < 10:
        return "good"

    # Best: high value, clean — or premium brand with only light stain + good rating
    if value >= 30:
        if not has_stain:
            return "best"
        if is_premium and rating >= 6:
            return "best"

    # Better: clean (or very light wear), value >= $10
    if not has_stain and not has_damage and value >= 10:
        return "better"

    return "good"


def main():
    db = firestore.Client(project=GCP_PROJECT)
    all_docs = list(db.collection("scans").stream())

    to_fix = [d for d in all_docs if "tier" not in (d.to_dict() or {})]
    print(f"Found {len(to_fix)} scans without tier (out of {len(all_docs)} total)")

    if not to_fix:
        print("Nothing to fix.")
        return

    counts = {"best": 0, "better": 0, "good": 0}
    errors = 0

    for doc in to_fix:
        data = doc.to_dict()
        try:
            tier = compute_tier(data)
            db.collection("scans").document(doc.id).update({"tier": tier})
            counts[tier] += 1
            brand = data.get("brand", "?")
            value = data.get("estimated_as_is_value", 0)
            print(f"  {tier.upper():6}  {doc.id[:8]}  {brand} — ${value:.2f}")
        except Exception as e:
            print(f"  ERROR  {doc.id[:8]}  {e}")
            errors += 1

    print(f"\nDone. best={counts['best']}  better={counts['better']}  good={counts['good']}  errors={errors}")


if __name__ == "__main__":
    main()
