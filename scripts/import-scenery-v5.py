"""Copy selected original GameAssets exports into the game; never edit the library.

Run with the library root as the sole argument. Catalog metadata and provenance
are retained, including placement restrictions and the authors' license record.
"""
import hashlib
import json
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parent.parent
LIBRARY = Path(sys.argv[1]).resolve()
CATALOGS = {
    "nature": "07_Environment/Common_Nature/_Shared/CrossBiome_Nature_Kit_001/catalog.json",
    "settlement": "06_Buildings/Settlement_Architecture/_Shared/Settlement_Architecture_Kit_001/catalog.json",
    "daily": "08_Props/Life_Farm_Lineside/_Shared/Life_Farm_Lineside_Kit_001/catalog.json",
    "feature": "07_Environment/Biome_Features/_Shared/Biome_Features_Kit_001/catalog.json",
    "landmark": "07_Environment/Landmarks/_Shared/Low_Frequency_Landmarks_Kit_001/catalog.json",
}
# These need cut terrain, a connected watercourse or an engineered deck. They
# remain in the source library instead of being scattered on unprepared ground.
DEFERRED = {
    "Prop_Daily_DrainGrate_001": "requires a recessed installation",
    "Prop_Daily_CulvertMouth_001": "requires an actual opening in a bank",
    "Environment_Feature_Volcano_LavaTubeMouth_001": "requires an actual opening in a bank",
    "Environment_Feature_Pastoral_IrrigationBend_001": "requires a connected irrigation watercourse",
    "Environment_Feature_Rural_CurvedTerraces_001": "requires matching stepped terrain",
    "Prop_Feature_Rural_MossStoneSteps_001": "requires a connected stepped path",
    "Environment_Feature_Lakeside_CascadeLedge_001": "requires upstream and downstream water levels",
    "Environment_Feature_Lakeside_GravelBar_001": "requires a matching shallow bed",
    "Building_Landmark_Viaduct_001": "requires matching pier foundations and deck connections",
    "Building_Settlement_WatermillHouse_001": "requires a matching millrace and waterwheel level",
}


def read(p):
    return json.loads(p.read_text(encoding="utf-8-sig"))


def write(p, value):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def role(pack, a):
    if pack == "landmark":
        return "landmark"
    if pack == "settlement":
        return {"Residential": "home", "Commerce": "shop", "Production": "workshop", "Community": "civic"}[a["group"]]
    if pack == "daily":
        return "prop-" + {"Domestic": "domestic", "Farming": "farm", "Lineside": "lineside"}[a["group"]]
    if pack == "nature":
        return {"Trees": "tree", "Shrubs_Groundcover": "shrub", "Rocks": "rock", "Deadwood": "deadwood"}[a["group"]]
    aid = a["id"]
    if "LotusPatch" in aid:
        return "aquatic"
    if any(v in aid for v in ("VineyardRow", "Sunflowers", "PumpkinVines")):
        return "crop"
    if any(v in aid for v in ("Tree", "Pine", "Cherry", "Bamboo")):
        return "tree"
    if aid.startswith("Plant_"):
        return "shrub"
    return "feature"


manifest = read(ROOT / "asset-manifest.json")
selected = []
for pack, relative in CATALOGS.items():
    catalog = read(LIBRARY / relative)
    for a in catalog["assets"]:
        aid = a["id"]
        if aid in DEFERRED:
            continue
        metadata_path = LIBRARY / a["metadata"]
        metadata = read(metadata_path)
        assert metadata["status"] == "game_ready", aid
        assert metadata["license"]["allowsPublicWebDelivery"] is True, aid
        src = LIBRARY / a["gameFile"]
        dst = ROOT / "assets" / "models" / src.name
        shutil.copyfile(src, dst)
        lod = metadata["lods"][0]
        lod_src = metadata_path.parent / lod["file"]
        lod_dst = ROOT / "assets" / "models" / lod_src.name
        shutil.copyfile(lod_src, lod_dst)
        provenance = {
            "sourceLibraryMetadata": a["metadata"],
            "sourceLibraryExport": a["gameFile"],
            "copiedWithoutGeometryChanges": True,
            "mainSha256": hashlib.sha256(dst.read_bytes()).hexdigest(),
            "lod1Sha256": hashlib.sha256(lod_dst.read_bytes()).hexdigest(),
            "metadata": metadata,
        }
        proof = metadata_path.parent / metadata["license"]["proofFile"]
        if proof.exists():
            provenance["licenseProof"] = proof.read_text(encoding="utf-8-sig")
        write(ROOT / "assets" / "provenance" / f"{aid}.json", provenance)
        info = {
            "id": aid, "name": a["name"], "url": f"assets/models/{dst.name}",
            "category": metadata["category"], "biome": metadata.get("primaryBiome"),
            "dimensions": metadata["dimensionsMetersXYZ"], "bounds": metadata["boundsMeters"],
            "triangles": metadata["polycount"], "meshNodeCount": 1, "bytes": dst.stat().st_size,
            "scenePack": pack, "sceneRole": role(pack, a),
            "compatibleBiomes": metadata["compatibleBiomes"],
            "biomeConditions": metadata.get("biomeConditions", {}),
            "frequency": metadata.get("frequency", metadata["placement"].get("frequency", "uncommon")),
            "footprintRadius": metadata["footprintRadiusMeters"],
            "minimumRailOffset": metadata["suggestedMinRailCenterOffsetMeters"],
            "placement": metadata["placement"],
            "lod": {"url": f"assets/models/{lod_dst.name}", "bytes": lod_dst.stat().st_size,
                    "triangles": lod["triangles"], "switchDistance": lod["switchToLOD1Meters"]},
            "provenance": f"assets/provenance/{aid}.json",
        }
        manifest["models"][aid] = info
        selected.append(aid)

# Existing biome-specific houses, fences and crop patches also get contextual
# rules. In particular, the red-roofed village house is no longer wilderness.
for biome, definition in manifest["biomes"].items():
    for aid in definition["models"]:
        info = manifest["models"][aid]
        info["compatibleBiomes"] = [biome]
        if any(s in aid for s in ("WaterTile", "StraightShore", "Rowboat", "WoodenPier", "RaisedField", "Oasis8")):
            scene_role = "fixed"
        elif "VillageHouse" in aid:
            scene_role = "home"
            info["compatibleBiomes"] += ["Pastoral", "Hills", "Lakeside"]
        elif "CountryBarn" in aid or "WindPump" in aid:
            scene_role = "workshop"
            info["compatibleBiomes"] = ["Pastoral", "Rural"]
        elif any(s in aid for s in ("FarmFence", "HayBale")):
            scene_role = "prop-farm"
        elif any(s in aid for s in ("RoofedWell", "StoneWall", "Mailbox", "Clothesline")):
            scene_role = "prop-domestic"
        elif "WheatCluster" in aid or "CornCluster" in aid:
            scene_role = "crop"
            info["compatibleBiomes"] = ["Pastoral", "Rural"]
        elif aid.startswith("Plant_"):
            scene_role = "tree" if any(s in aid for s in ("Tree", "Cedar", "Willow", "Palm")) else "shrub"
        elif any(s in aid for s in ("FallenLog", "TreeStump")):
            scene_role = "deadwood"
        elif any(s in aid for s in ("RoundHill", "RollingRidge", "DistantRidge", "DuneTile", "Cone16", "Lava", "IceWall", "FrozenPond", "StrataRockface", "BasaltCliff")):
            scene_role = "feature"
        else:
            scene_role = "rock"
        info["sceneRole"] = scene_role
        info["scenePack"] = "original"
        bounds = info.get("bounds")
        if bounds:
            info["footprintRadius"] = max((x*x+z*z)**0.5 for x in [bounds["min"][0], bounds["max"][0]] for z in [bounds["min"][2], bounds["max"][2]])
        else:
            info["footprintRadius"] = (info["dimensions"][0]**2+info["dimensions"][2]**2)**0.5/2

manifest["version"] = 5
manifest["scenery"] = {"version": "5.0.0", "additionalModels": selected,
    "selectedAdditionalCount": len(selected), "deferredModels": DEFERRED,
    "note": "Contextual settlements, mixed native nature, farm rows, waterside plants and globally limited landmarks; main/LOD1 counts are one model type."}
write(ROOT / "asset-manifest.json", manifest)
print(json.dumps({"addedModelTypes": len(selected), "totalModelTypes": len(manifest["models"]), "lods": len(selected)}, ensure_ascii=False))
