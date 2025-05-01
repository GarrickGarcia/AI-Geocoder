import os
import base64
import json
from openai import OpenAI
from arcgis.gis import GIS
from arcgis.features import FeatureLayer
from arcgis.geocoding import geocode

# ---------------------------
# CONFIGURATION VARIABLES
# ---------------------------
AGOL_USERNAME = "xxx"
AGOL_PASSWORD = "xxx"
OPENAI_API_KEY = "xxx"

# Folder containing permit images
IMAGE_FOLDER = r"xxx"

# URL of the target FeatureLayer
FEATURE_LAYER_URL = "xxx"

# Spatial reference for created points
SPATIAL_REF = {"wkid": 4326}

# ---------------------------
# SET UP CLIENTS
# ---------------------------
client = OpenAI(api_key=OPENAI_API_KEY)

gis = GIS("https://www.arcgis.com", AGOL_USERNAME, AGOL_PASSWORD)
feature_layer = FeatureLayer(FEATURE_LAYER_URL, gis=gis)

# ---------------------------
# FUNCTIONS
# ---------------------------
def analyze_image(filepath):
    """
    Sends an image to OpenAI and parses the JSON response containing permit fields.
    Returns a dict with keys: address, date, size, material, notes.
    """
    # Read and encode image
    with open(filepath, "rb") as f:
        img_bytes = f.read()
    img_b64 = base64.b64encode(img_bytes).decode("utf-8")

    # Compose prompt
    messages = [
        {
            "role": "system",
            "content": (
                "You are an expert OCR assistant trained specifically to interpret handwritten water/sewer connection permits. "
                "You will be given a base64-encoded image of a permit filled out by applicants. "
                "Your task is to extract handwritten entries from known labeled sections of the form, which may vary slightly in position across permits. "
                "Each field is identified by printed text followed by a handwritten response on or near an underlined blank."

                "When given an image, extract and return ONLY a JSON object with the following keys and rules (do not include any explanation or extra text):\n"
                "  • address: The handwritten address next to 'Location of Installation'. Append ' Marion Indiana 46952' to the result.\n"
                "  • date: The handwritten date next to the top-left 'Date:' label. Format it as MM-DD-YYYY.\n"
                "  • size: The first part of the handwritten value next to 'Size and Type of Service Line'. Convert to decimal inches (e.g., 3/4\" becomes 0.75, 1 1/2 becomes 1.5).\n"
                "  • material: The second part of the same field after the size. Interpret 'K' as 'copper', 'PVC' or 'poly' as 'PVC'. If no material is written, return null.\n"
                "  • notes: Capture any additional handwritten information near that section that does not belong to the other fields (such as 'behind curb' or hydrant direction), or return null if there are no notes.\n"

                "Assume handwriting may vary and values may be slightly misaligned. Only extract the fields listed above and return valid JSON."
            )
        },
        {
            "role": "user",
            "content": f"Here is the base64-encoded permit image:\n\n{img_b64}"
        }
    ]

    response = client.chat.completions.create(
        model="gpt-4.1-mini",
        messages=messages,
        temperature=0
    )
    text = response.choices[0].message.content.strip()

    # Parse JSON
    return json.loads(text)


def geocode_address(address):
    """
    Geocodes an address using the arcgis.geocoding.geocode function.
    Returns a dict with 'x' and 'y', or None if no result.
    """
    if not address:
        return None

    # Geocode a single-line address string
    results = geocode(
        address,
        max_locations=1,
        as_featureset=False
    )

    if results:
        loc = results[0]['location']
        return {'x': loc['x'], 'y': loc['y']}
    return None


def add_feature(attributes, geometry):
    """
    Adds a single point feature to the configured FeatureLayer.
    """
    feature = {"attributes": attributes, "geometry": geometry}
    feature_layer.edit_features(adds=[feature])


# ---------------------------
# MAIN PROCESS
# ---------------------------
def main():
    for fname in os.listdir(IMAGE_FOLDER):
        if not fname.lower().endswith(('.jpg', '.jpeg', '.png')):
            continue

        path = os.path.join(IMAGE_FOLDER, fname)
        print(f"Processing: {fname}")

        try:
            data = analyze_image(path)

            addr = data.get('address')
            if not addr:
                print(f"  No address found; skipping {fname}")
                continue

            if addr and not addr.lower().endswith('marion indiana 46952'):
                addr = f"{addr}, Marion Indiana 46952"

            # Geocode
            loc = geocode_address(addr)
            if loc is None:
                print(f"  Geocode failed for: {addr}")
                continue

            # Prepare attributes & geometry
            attrs = {
                'address': addr,
                'installdate': data.get('date'),
                'diameter': data.get('size'),
                'material': data.get('material'),
                'notes': data.get('notes')
            }
            geom = {'x': loc['x'], 'y': loc['y'], 'spatialReference': SPATIAL_REF}

            # Add to feature layer
            add_feature(attrs, geom)
            print(f"  Added feature for {fname}")

        except Exception as e:
            print(f"  Error processing {fname}: {e}")


if __name__ == '__main__':
    main()
