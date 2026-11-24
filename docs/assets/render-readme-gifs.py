#!/usr/bin/env python3
"""Regenerate the README animations from their static SVG sources."""

import argparse
from itertools import pairwise
from math import dist
from pathlib import Path
import re
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from xml.etree import ElementTree as ET


ASSETS = Path(__file__).resolve().parent
SVG_NS = "http://www.w3.org/2000/svg"
BACKGROUND = "#F8FAFC"
GREEN = "#14765B"
ET.register_namespace("", SVG_NS)


def svg(name):
    return f"{{{SVG_NS}}}{name}"


def by_id(root, element_id):
    element = root.find(f".//*[@id='{element_id}']")
    if element is None:
        raise ValueError(f"Missing SVG element #{element_id}")
    return element


def marker(root, x, y, radius, color):
    return ET.SubElement(root, svg("circle"), {
        "cx": str(x), "cy": str(y), "r": str(radius),
        "fill": color, "stroke": BACKGROUND, "stroke-width": "2",
    })


def ortho_points(path):
    """Read the sequence diagram's absolute M/H/V shaft coordinates."""
    match = re.fullmatch(r"M(\d+) (\d+)((?:[HV]\d+)+)", path)
    if match is None:
        return []
    x, y, commands = match.groups()
    points = [(int(x), int(y))]
    for axis, coordinate in re.findall(r"([HV])(\d+)", commands):
        x, y = points[-1]
        points.append((int(coordinate), y) if axis == "H" else (x, int(coordinate)))
    return points


def along(points, progress):
    segments = [(start, end, dist(start, end)) for start, end in pairwise(points) if start != end]
    remaining = progress * sum(length for _, _, length in segments)
    for (x, y), (end_x, end_y), length in segments:
        if remaining <= length:
            return x + (end_x - x) * remaining / length, y + (end_y - y) * remaining / length
        remaining -= length
    return points[-1]


def pricing_frames(source):
    phase_holds = (("match", 24), ("reply", 24), ("prompt", 24),
                   ("wait", 88), ("email", 24), ("link", 104))
    for phase, hold in phase_holds:
        root = ET.fromstring(source)
        # An opaque canvas lets the GIF encode just the changing region.
        root.insert(2, ET.Element(svg("rect"), {
            "width": root.get("width"), "height": root.get("height"), "fill": BACKGROUND,
        }))
        by_id(root, f"{phase}-band").attrib.update(fill="#DDF3EA", stroke="#87B9AD")
        shafts = []
        for path in by_id(root, phase).findall(svg("path")):
            classes = path.get("class", "").split()
            if "arrow" in classes:
                points = ortho_points(path.get("d", ""))
                if points:
                    shafts.append(points)
                path.set("class", " ".join(name for name in classes if name != "arrow"))
                path.attrib.update({"fill": "none", "stroke": GREEN, "stroke-width": "2.4"})
            if "tip" in classes:
                path.attrib.pop("class")
                path.set("fill", GREEN)
        yield ET.tostring(root), 16
        for points in shafts:
            for step in range(7):
                x, y = along(points, 0.05 + 0.90 * step / 6)
                token = marker(root, f"{x:.1f}", f"{y:.1f}", 8.8, GREEN)
                yield ET.tostring(root), 8
                root.remove(token)
        yield ET.tostring(root), hold


def recovery_frames(source):
    root = ET.fromstring(source)
    states = ("leased", "uncertain", "sent")
    cards = [by_id(root, state).find(svg("rect")).attrib for state in states]
    centers = [int(card["y"]) + int(card["height"]) / 2 for card in cards]
    connectors = []
    for state in states[1:]:
        # The vertical shaft is followed by a relative arrowhead.
        path = by_id(root, f"to-{state}").get("d", "")
        match = re.fullmatch(r"M(\d+) (\d+)v(\d+)(m.+)", path)
        if match is None:
            raise ValueError(f"Expected a vertical shaft and arrowhead for #{state}")
        x, start, length, tip = match.groups()
        connectors.append((x, int(start), int(start) + int(length), tip))

    for index, hold in enumerate((120, 190, 260)):
        y = centers[index]
        positions = [(y, hold)]
        if index < len(connectors):
            distance = centers[index + 1] - y
            positions.extend((round(y + distance * step / 11, 2), 5) for step in range(1, 11))

        for position, delay in positions:
            overlay = ET.SubElement(root, svg("g"))
            card = cards[index]
            ET.SubElement(overlay, svg("rect"), {
                **card, "fill": "none", "stroke-width": "5",
            })
            for next_card, (x, start, end, tip) in enumerate(connectors, start=1):
                frontier = min(position, end)
                if frontier > start:
                    ET.SubElement(overlay, svg("path"), {
                        "d": f"M{x} {start}V{frontier}" + (tip if frontier == end else ""),
                        "fill": "none", "stroke": cards[next_card]["stroke"], "stroke-width": "4",
                        "stroke-linecap": "round", "stroke-linejoin": "round",
                    })
            marker(overlay, connectors[0][0], position, 8, card["stroke"])
            yield ET.tostring(root), delay
            root.remove(overlay)


def render(name, frames, output, rasterizer, palette_options):
    source = (ASSETS / f"{name}.svg").read_bytes()
    with TemporaryDirectory(prefix="readme-gif-") as directory:
        work = Path(directory)
        playlist = ["ffconcat version 1.0"]
        for index, (frame, delay) in enumerate(frames(source)):
            vector = work / f"{index:03d}.svg"
            raster = vector.with_suffix(".png")
            vector.write_bytes(frame)
            if rasterizer == "sips":
                command = ["sips", "-s", "format", "png", str(vector), "--out", str(raster)]
            else:
                command = ["rsvg-convert", "--output", str(raster), str(vector)]
            subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
            playlist.extend([f"file {raster.name}", "option framerate 100", f"duration {delay / 100:.2f}"])

        manifest = work / "frames.ffconcat"
        manifest.write_text("\n".join(playlist) + "\n", encoding="utf-8")
        target = work / f"{name}.gif"
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-f", "concat", "-safe", "0", "-i", str(manifest),
            "-vf", "split[a][b];[a]palettegen=max_colors=112[p];[b][p]paletteuse=dither=none" + palette_options,
            "-fps_mode", "vfr", "-loop", "0", "-final_delay", str(delay), str(target),
        ], check=True)
        shutil.copyfile(target, output / target.name)
        print(f"{name}.gif: {index + 1} frames, {target.stat().st_size:,} bytes")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ASSETS, help="destination directory (default: docs/assets)")
    options = parser.parse_args()
    rasterizer = "sips" if sys.platform == "darwin" else "rsvg-convert"
    for command in ("ffmpeg", rasterizer):
        if shutil.which(command) is None:
            parser.error(f"{command} is required and was not found on PATH")
    options.output_dir.mkdir(parents=True, exist_ok=True)
    render("pricing-sequence", pricing_frames, options.output_dir, rasterizer, ":diff_mode=rectangle")
    render("uncertain-send", recovery_frames, options.output_dir, rasterizer, "")


if __name__ == "__main__":
    main()
