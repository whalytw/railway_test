"""Create the v12 rendering meshes from the local, unchanged v11 GLBs.

Run Blender in background mode with the RailLoopLab project as the working directory.
"""
import hashlib
import json
from pathlib import Path

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform


ROOT = Path.cwd()
MODELS = ROOT / "assets" / "models"
OUTPUT = MODELS / "lod"
OUTPUT.mkdir(exist_ok=True)


def read_source(asset_id):
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    path = MODELS / f"{asset_id}.glb"
    bpy.ops.import_scene.gltf(filepath=str(path), merge_vertices=True)
    return path, [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]


def make_prism(name, cross_section, start, end, source):
    """Retain the original outline in a mesh with long, planar sides."""
    count = len(cross_section)
    vertices = [(x, y, z) for y in (start, end) for x, z in cross_section]
    faces = [(i, (i + 1) % count, count + (i + 1) % count, count + i) for i in range(count)]
    faces += [tuple(reversed(range(count))), tuple(range(count, 2 * count))]
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    node = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(node)

    # Project the matching part of the original atlas onto each planar face.
    # The longitudinal UV gradient lets the original texture's mipmaps keep
    # the same tone across the detail change.
    uv_layer = mesh.uv_layers.new()
    original = source.data
    original_uv = original.uv_layers.active.data
    bvh = BVHTree.FromObject(source, bpy.context.evaluated_depsgraph_get())
    for face in mesh.polygons:
        hit, _, index, _ = bvh.find_nearest(face.center)
        polygon = original.polygons[index]
        loops = list(polygon.loop_indices)
        if len(loops) == 3:
            positions = [original.vertices[original.loops[i].vertex_index].co for i in loops]
            uvs = [Vector((*original_uv[i].uv, 0)) for i in loops]
            low = [min(uv[k] for uv in uvs) for k in range(2)]
            high = [max(uv[k] for uv in uvs) for k in range(2)]
            for i in face.loop_indices:
                co = mesh.vertices[mesh.loops[i].vertex_index].co
                projected = barycentric_transform(co, *positions, *uvs)
                uv_layer.data[i].uv = [min(high[k], max(low[k], projected[k])) for k in range(2)]
        else:
            uv = sum((original_uv[i].uv for i in loops), Vector((0, 0))) / len(loops)
            for i in face.loop_indices:
                uv_layer.data[i].uv = uv
    return node


def reduce_mesh(obj, ratio):
    bpy.context.view_layer.objects.active = obj
    modifier = obj.modifiers.new("v12 rendering mesh", type="DECIMATE")
    modifier.ratio = ratio
    modifier.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def export_asset(source, nodes, suffix, reuse_materials=False):
    path = OUTPUT / (source.stem + suffix + ".glb")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in nodes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = nodes[0]
    bpy.ops.export_scene.gltf(
        filepath=str(path), use_selection=True, export_yup=True,
        export_texcoords=True, export_animations=False,
        export_materials="NONE" if reuse_materials else "EXPORT",
    )
    triangles = 0
    for obj in nodes:
        obj.data.calc_loop_triangles()
        triangles += len(obj.data.loop_triangles)
    return {
        "source": source.relative_to(ROOT).as_posix(),
        "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "url": path.relative_to(ROOT).as_posix(),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "triangles": triangles,
        "bytes": path.stat().st_size,
        "reuseMaterials": reuse_materials,
    }


records = []
source, (rail,) = read_source("Environment_Rail_RailSection_1m_001")
right = [(0.100, 0), (0.105, 0.012), (0.105, 0.035), (0.027, 0.060),
         (0.027, 0.138), (0.052, 0.159), (0.052, 0.185), (0.045, 0.200)]
profile = right + [(-x, z) for x, z in reversed(right)]
records.append(export_asset(source, [make_prism("RailSection_Distant", profile, 0, -1, rail)], "_v12_LOD1", True))

source, (sleeper,) = read_source("Environment_Rail_Sleeper_001")
profile = [(1.25, 0), (1.25, 0.18), (-1.25, 0.18), (-1.25, 0)]
records.append(export_asset(source, [make_prism("Sleeper_Distant", profile, 0.15, -0.15, sleeper)], "_v12_LOD1", True))

source, tunnel = read_source("Building_Tunnel_RockStraight4m_001")
for obj in tunnel:
    reduce_mesh(obj, 0.40)
records.append(export_asset(source, tunnel, "_v12_Lining"))

source, slope_grass = read_source("Plant_Hills_SlopeGrass_001")
for obj in slope_grass:
    reduce_mesh(obj, 0.20)
records.append(export_asset(source, slope_grass, "_v12_LOD1"))

metadata = ROOT / "assets" / "provenance" / "render-meshes-v12.json"
metadata.write_text(json.dumps({"blender": bpy.app.version_string, "meshes": records}, indent=2) + "\n", encoding="utf-8")
print("RAIL_LOD", json.dumps(records), flush=True)
