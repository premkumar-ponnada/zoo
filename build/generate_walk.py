#!/usr/bin/env python3
"""
Architecture A — one continuous walk through the zoo.

Why this replaces the previous build: seven separate dioramas, each dived into from its
own wide establishing shot, read as seven pages rather than one journey. Architecture A
fixes that at the root — every leg's FIRST frame is the previous leg's ACTUAL LAST frame,
so the camera never resets. Habitats come into view ahead of the visitor as they walk,
which is the whole point.

  leg 1 : starts from a generated still
  leg n : starts from leg (n-1)'s extracted last frame  <- the chain
  no connectors: the legs ARE the journey (SKILL Step 4, architecture A)

Each prompt carries the motion-handoff contract verbatim — begin by continuing the same
forward glide, end settling back into one — which is what lets six separate renders read
as a single uninterrupted move.

Chain-specific risk: every leg after the first starts from a compressed video frame
rather than a clean still, so quality compounds downward. `--reseed N` regenerates a
fresh still at leg N and restarts the chain there, trading one seam for a clean image.

Costs are read off each run and accumulated; the script refuses a leg it cannot afford.
"""

import json
import os
import re
import subprocess
import sys
import urllib.request

import imageio_ffmpeg

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GEN = os.path.join(HERE, "walk")
VID = os.path.join(ROOT, "assets", "vid")
POST = os.path.join(ROOT, "assets", "posters")
for p in (GEN, VID, POST):
    os.makedirs(p, exist_ok=True)

MONID = os.path.join(os.environ["APPDATA"], "npm", "monid.cmd")

RESOLUTION = "720p"
SECONDS = 4
PER_SEC = {"360p": 0.04, "720p": 0.11, "1080p": 0.16}[RESOLUTION]
LEG_COST = PER_SEC * SECONDS
STILL_COST = 0.0035

STYLE = ("Soft matte clay 3D render, rounded toy-model shapes, gentle warm studio "
         "lighting, soft shadows, tilt-shift miniature look, palette of jungle green, "
         "warm sand, terracotta and deep teal.")

OPENING_STILL = (
    "Isometric low-poly 3D diorama of a jungle zoo entrance seen from just outside the "
    "gates, looking straight down the entrance path into the zoo. Soft matte clay 3D "
    "render, rounded toy-model shapes, gentle warm studio lighting, soft long shadows, "
    "tilt-shift miniature look. A carved wooden gateway with a peaked shingled roof and "
    "lanterns, thatched ticket huts either side, a timber fence, a sandy path leading "
    "through the arch deeper into the zoo, tall rounded jungle trees, ferns and "
    "flowering bushes, tiny clay monkeys on the arch and parrots overhead, a few tiny "
    "clay visitors walking in. Cohesive palette of jungle green, warm sand, terracotta, "
    "soft cream and deep teal. Highly detailed, absolutely no text, no letters, no "
    "numbers, no logos."
)

CONTRACT_IN = "A single continuous shot, no cuts. Continue the same slow, steady forward glide."
CONTRACT_OUT = ("In the final second, settle back into a slow, steady forward glide "
                "toward {next}.")
TAIL = ("Smooth, graceful, slow motion, subtle parallax, the world opening up ahead of "
        "the camera. No text, no captions. No dialogue, no music, no sound effects.")

# Each leg says what comes INTO VIEW AHEAD — never "begin high and far", which is what
# made the previous build restart every scene.
SEED_STILLS = {
    3: ("Eye-level view along a sandy jungle trail that opens ahead onto a wide "
        "watering hole. Soft matte clay 3D render, rounded toy-model shapes, gentle "
        "warm studio lighting, soft shadows, tilt-shift miniature look. Elephants and "
        "their calves stand in the shallow water, pink flamingos wade at the edge, "
        "rounded jungle trees and ferns frame both sides of the trail. Palette of "
        "jungle green, warm sand, terracotta and deep teal. No text, no letters."),
    4: ("Eye-level view along a sandy trail where the jungle thins and opens ahead onto "
        "wide golden grassland. Soft matte clay 3D render, rounded toy-model shapes, "
        "gentle warm studio lighting, tilt-shift miniature look. Tall giraffes browse "
        "flat-topped trees, zebras graze beyond. Palette of jungle green, warm sand, "
        "terracotta and deep teal. No text, no letters."),
    5: ("Eye-level view along a dusty trail with a rocky ridge rising ahead. Soft matte "
        "clay 3D render, rounded toy-model shapes, gentle warm studio lighting, "
        "tilt-shift miniature look. Lions rest on the warm stone above, bamboo and "
        "rounded trees to one side. Palette of jungle green, warm sand, terracotta and "
        "deep teal. No text, no letters."),
    6: ("Eye-level view along a lantern-lit path with a tall domed aviary rising ahead. "
        "Soft matte clay 3D render, rounded toy-model shapes, gentle warm studio "
        "lighting, tilt-shift miniature look. Peacocks and macaws inside the dome, "
        "rounded trees around it. Palette of jungle green, warm sand, terracotta and "
        "deep teal. No text, no letters."),
}

LEGS = [
    dict(n=1, id="entrance", first=True,
         body=("The camera glides forward through the wooden zoo gateway and in under "
               "the arch, past the ticket huts, monkeys swinging overhead and parrots "
               "crossing above, the sandy path opening ahead into the green zoo."),
         nxt="the jungle trail ahead"),
    dict(n=2, id="jungle",
         body=("The path ahead opens into dense jungle. Sliding into view ahead: tall "
               "canopy trees and hanging vines, tiny clay monkeys and a sloth in the "
               "branches, a green snake coiled on a limb, toucans, butterflies, a small "
               "frog on a leaf, deer stepping across the trail."),
         nxt="the sound of water ahead"),
    dict(n=3, id="water",
         body=("The trail opens onto a wide watering hole ahead. Elephants and their "
               "calves stand in the shallows, pink flamingos wade at the edge, zebras "
               "and deer drink nearby, turtles rest on a log."),
         simple=("A wide watering hole opens ahead with elephants and flamingos "
                 "standing in the shallow water."),
         nxt="open grassland ahead"),
    dict(n=4, id="savanna",
         body=("The jungle thins and open golden grassland spreads ahead. Tall giraffes "
               "browse the flat-topped trees, zebras and rhinos graze, ostriches stride "
               "past, meerkats stand watch on a mound."),
         simple=("Open golden grassland spreads ahead with giraffes and zebras "
                 "grazing among flat-topped trees."),
         nxt="a rocky ridge ahead"),
    dict(n=5, id="predators",
         body=("A rocky ridge rises ahead. Lions rest on the warm stone, a tiger steps "
               "out of the bamboo below, a leopard lies along a branch, a brown bear "
               "moves at the treeline."),
         simple=("A rocky ridge rises ahead with lions resting on the warm stone and "
                 "a tiger below."),
         nxt="a tall aviary ahead"),
    dict(n=6, id="aviary", finale=True,
         body=("A tall domed aviary comes into view ahead, filled with peacocks, macaws "
               "and cranes, with pandas and koalas in the trees beside it. The camera "
               "glides through it and then rises steadily until the whole miniature zoo "
               "lies below, its winding lantern-lit paths joining every habitat."),
         simple=("A tall domed aviary full of birds comes into view ahead, then the "
                 "camera rises until the whole miniature zoo lies below."),
         nxt="the open sky"),
]


def monid(args, out_file):
    r = subprocess.run([MONID] + args + ["-w", "420", "-j", "-o", out_file],
                       capture_output=True, text=True)
    if not os.path.exists(out_file):
        raise RuntimeError(f"monid failed: {r.stdout[-800:]} {r.stderr[-800:]}")
    return json.load(open(out_file, encoding="utf-8"))


def write(obj, path):
    json.dump(obj, open(path, "w", encoding="utf-8"))
    return path


def balance():
    # `balance` takes neither -w nor -o, unlike `run`, so it can't go through monid().
    r = subprocess.run([MONID, "balance", "-j"], capture_output=True, text=True)
    try:
        d = json.loads(r.stdout)
        v = d.get("balance", d)
        if isinstance(v, dict):
            v = v.get("value", v.get("amount", 0))
        return float(v)
    except Exception:
        m = re.search(r"\$?([0-9]+\.[0-9]+)", r.stdout)
        return float(m.group(1)) if m else 0.0


def host(local, remote):
    """Upload a local file to sfs and return a public signed URL (both $0)."""
    req = write({"path": remote, "sizeBytes": os.path.getsize(local), "ttl": "7d"},
                os.path.join(HERE, "w_put.json"))
    put = monid(["run", "-p", "sfs", "-e", "/put", "-f", req],
                os.path.join(HERE, "w_put_run.json"))
    rq = urllib.request.Request(put["uploadUrl"], data=open(local, "rb").read(),
                                method="PUT")
    rq.add_header("Content-Type", "image/jpeg")
    with urllib.request.urlopen(rq) as r:
        assert r.status in (200, 201), r.status
    req = write({"path": remote}, os.path.join(HERE, "w_cat.json"))
    return monid(["run", "-p", "sfs", "-e", "/cat", "-f", req],
                 os.path.join(HERE, "w_cat_run.json"))["url"]


def make_still(tag, prompt):
    body = {"model": "image-01", "prompt": prompt, "aspect_ratio": "16:9",
            "response_format": "url", "n": 1, "seed": 20260918}
    req = write(body, os.path.join(HERE, f"w_still_{tag}.json"))
    out = monid(["run", "-p", "minimax", "-e", "/v1/image_generation", "-f", req],
                os.path.join(HERE, f"w_still_{tag}_run.json"))
    jpg = os.path.join(GEN, f"still_{tag}.jpg")
    urllib.request.urlretrieve(out["data"]["image_urls"][0], jpg)
    return jpg


def last_frame(mp4, out_png):
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-sseof", "-0.12",
                    "-i", mp4, "-frames:v", "1", "-q:v", "2", out_png], check=True)
    jpg = out_png.replace(".png", ".jpg")
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", out_png,
                    "-q:v", "2", jpg], check=True)
    return jpg


def make_leg(leg, start_url):
    for attempt, text in enumerate((leg["body"], leg.get("simple", leg["body"]))):
        parts = [CONTRACT_IN, text, CONTRACT_OUT.format(next=leg["nxt"]), STYLE, TAIL]
        body = {"prompt": " ".join(parts), "image_urls": [start_url],
                "resolution": RESOLUTION, "aspect_ratio": "16:9", "duration": SECONDS}
        req = write(body, os.path.join(HERE, f"w_vid_{leg['n']:02d}.json"))
        out = monid(["run", "-p", "gemini", "-e", "/v1/video/omni-flash-i2v", "-f", req],
                    os.path.join(HERE, f"w_vid_{leg['n']:02d}_run.json"))
        if "video" in out:
            mp4 = os.path.join(VID, f"{leg['n']:02d}-{leg['id']}.mp4")
            urllib.request.urlretrieve(out["video"]["download_link"], mp4)
            return mp4, out.get("billed_seconds", SECONDS)
        err = (out.get("error") or {}).get("message", str(out))[:120]
        print(f"    attempt {attempt + 1} rejected ({err}) — a blocked run costs nothing",
              flush=True)
    raise RuntimeError(f"leg {leg['n']} ({leg['id']}) blocked on both wordings")


def main():
    start_at = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    bal = balance()
    print(f"balance ${bal:.2f} | leg ${LEG_COST:.2f} @ {RESOLUTION}/{SECONDS}s\n")

    start_url = None
    if start_at == 1:
        print("opening still...", flush=True)
        jpg = make_still("open", OPENING_STILL)
        bal -= STILL_COST
        from PIL import Image
        Image.open(jpg).save(os.path.join(POST, "01-entrance.webp"), quality=90, method=4)
        start_url = host(jpg, "walk/open.jpg")
    else:
        prev = LEGS[start_at - 2]
        mp4 = os.path.join(VID, f"{prev['n']:02d}-{prev['id']}.mp4")
        jpg = last_frame(mp4, os.path.join(GEN, f"last_{prev['n']:02d}.png"))
        start_url = host(jpg, f"walk/last_{prev['n']:02d}.jpg")

    for leg in LEGS:
        if leg["n"] < start_at:
            continue
        if bal < LEG_COST + 0.01:
            print(f"\nOUT OF FUNDS before leg {leg['n']} ({leg['id']}): "
                  f"${bal:.2f} left, need ${LEG_COST:.2f}")
            print(f"resume with:  python build/generate_walk.py {leg['n']}")
            break
        print(f"[{leg['n']}] {leg['id']} ...", flush=True)
        try:
            mp4, secs = make_leg(leg, start_url)
        except RuntimeError:
            if leg["n"] not in SEED_STILLS:
                raise
            print(f"    chained frame refused — reseeding leg {leg['n']} from a fresh "
                  f"still (costs one frame-identical seam)", flush=True)
            jpg = make_still(f"seed{leg['n']}", SEED_STILLS[leg["n"]])
            bal -= STILL_COST
            start_url = host(jpg, f"walk/seed_{leg['n']:02d}.jpg")
            mp4, secs = make_leg(leg, start_url)
        bal -= PER_SEC * secs
        # poster for this leg = its own first frame
        pf = os.path.join(GEN, f"first_{leg['n']:02d}.png")
        subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-ss", "0", "-i", mp4,
                        "-frames:v", "1", pf], check=True)
        from PIL import Image
        Image.open(pf).save(os.path.join(POST, f"{leg['n']:02d}-{leg['id']}.webp"),
                            quality=90, method=4)
        print(f"[{leg['n']}] {leg['id']} done ({secs}s) — ${bal:.2f} left", flush=True)
        if leg is not LEGS[-1]:
            jpg = last_frame(mp4, os.path.join(GEN, f"last_{leg['n']:02d}.png"))
            start_url = host(jpg, f"walk/last_{leg['n']:02d}.jpg")
    print("\ndone")


if __name__ == "__main__":
    main()
