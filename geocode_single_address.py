from arcgis.gis import GIS
from arcgis.features import FeatureLayer
from arcgis.geocoding import geocode

# --- Configuration ---
AGOL_USERNAME = "xxx"
AGOL_PASSWORD = "xxx"
FEATURE_LAYER_URL = "https://services5.arcgis.com/S5JQ6TlhA1BbeUBC/arcgis/rest/services/AIGeocoder/FeatureServer/0"
SPATIAL_REF = {"wkid": 4326}

def geocode_address(address):
    """Geocode an address; return {'x': ..., 'y': ...} or None."""
    if not address:
        return None
    results = geocode(address, max_locations=1, as_featureset=False)
    if results:
        loc = results[0]["location"]
        return {"x": loc["x"], "y": loc["y"]}
    return None

def add_feature(layer, attributes, geometry):
    """Add a single point feature to the FeatureLayer."""
    feature = {"attributes": attributes, "geometry": geometry}
    layer.edit_features(adds=[feature])

def main():
    # Connect to ArcGIS Online
    gis = GIS("https://www.arcgis.com", AGOL_USERNAME, AGOL_PASSWORD)
    layer = FeatureLayer(FEATURE_LAYER_URL, gis=gis)

    address = input("Enter address to geocode: ").strip()
    if not address:
        print("No address provided; exiting.")
        return
    if not address.lower().endswith("marion indiana 46952"):
        address = f"{address}, Marion Indiana 46952"

    loc = geocode_address(address)
    if loc is None:
        print(f"Geocode failed for: {address}")
        return

    attributes = {"address": address}
    geometry = {"x": loc["x"], "y": loc["y"], "spatialReference": SPATIAL_REF}
    add_feature(layer, attributes, geometry)
    print(f"Added feature for {address}")

if __name__ == "__main__":
    main()
