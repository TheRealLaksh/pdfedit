"""Turns flat renderings into simulated photographs: perspective, uneven light, blur, grain, JPEG."""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

out = sys.argv[1]
rng = np.random.default_rng(7)
truth = json.load(open(os.path.join(out, "truth.json"), encoding="utf-8"))


def coefficients(src, dst):
    """PIL perspective coefficients mapping destination pixels back to source pixels"""
    a, b = [], []
    for (x, y), (u, v) in zip(dst, src):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        b += [u, v]
    return np.linalg.solve(np.array(a, float), np.array(b, float))


def forward(src, dst):
    c = coefficients(dst, src)

    def f(p):
        x, y = p
        d = c[6] * x + c[7] * y + 1
        return [(c[0] * x + c[1] * y + c[2]) / d, (c[3] * x + c[4] * y + c[5]) / d]

    return f


def texture(w, h, base, amount, scale):
    small = rng.normal(0, 1, (h // scale + 2, w // scale + 2))
    big = np.array(Image.fromarray(((small * 40) + 128).clip(0, 255).astype(np.uint8)).resize((w + scale * 2, h + scale * 2), Image.BICUBIC), float)[:h, :w]
    return np.clip(np.array(base, float)[None, None, :] + ((big - 128) / 40 * amount)[:, :, None], 0, 255)


def finish(img, blur, noise, quality, name, light=0.0):
    a = np.array(img.filter(ImageFilter.GaussianBlur(blur)), float)
    h, w, _ = a.shape
    if light:
        yy, xx = np.mgrid[0:h, 0:w]
        a *= (1 + light * (0.5 - (xx / w * 0.7 + yy / h * 0.3)))[:, :, None]
    grain = rng.normal(0, noise, (h, w))
    a += grain[:, :, None] + rng.normal(0, noise * 0.35, (h, w, 3))
    Image.fromarray(a.clip(0, 255).astype(np.uint8)).save(os.path.join(out, name), quality=quality)


def warp_scene(source, name, corners, size, backdrop, **kw):
    flat = Image.open(os.path.join(out, source + ".png")).convert("RGB")
    w, h = flat.size
    src = [(0, 0), (w, 0), (w, h), (0, h)]
    warped = flat.transform(size, Image.PERSPECTIVE, coefficients(src, corners), Image.BICUBIC)
    mask = Image.new("L", flat.size, 255).transform(size, Image.PERSPECTIVE, coefficients(src, corners), Image.BICUBIC)
    base = Image.fromarray(backdrop.astype(np.uint8))
    base.paste(warped, (0, 0), mask)
    f = forward(src, corners)
    truth[name.split(".")[0]] = [{"id": b["id"], "text": b["text"], "quad": [f(p) for p in b["quad"]]} for b in truth[source]]
    finish(base, name=name, **kw)


# a printed poster hanging on a wall, photographed at an angle
warp_scene("poster-flat", "poster.jpg", [(150, 90), (1420, 170), (1385, 1230), (190, 1300)], (1600, 1400),
           texture(1600, 1400, (150, 142, 132), 14, 3), blur=0.9, noise=3.2, quality=86, light=0.22)
# a painted board with Hindi lettering, photographed nearly straight
warp_scene("hindi-flat", "hindi.jpg", [(70, 80), (1500, 40), (1515, 740), (60, 760)], (1600, 820),
           texture(1600, 820, (96, 78, 60), 16, 4), blur=0.7, noise=2.4, quality=88, light=0.16)


def paper_scene(name, angle, blur, noise, quality):
    w, h = 1500, 1100
    paper = texture(w, h, (232, 228, 218), 5, 2) + rng.normal(0, 1.2, (h, w))[:, :, None]
    img = Image.fromarray(paper.clip(0, 255).astype(np.uint8))
    d = ImageDraw.Draw(img)
    font = lambda f, s: ImageFont.truetype(os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts", f), s)
    lines = [
        ("shop", (130, 110), "timesbd.ttf", 68, "Greenfield Hardware Store", (28, 28, 34)),
        ("addr", (132, 205), "times.ttf", 36, "24 Station Road, Rampur", (46, 46, 52)),
        ("date", (132, 305), "arial.ttf", 40, "Date: 08 October 2027", (30, 30, 40)),
        ("item1", (132, 420), "arial.ttf", 40, "Brass door handle, pair", (30, 30, 40)),
        ("p1", (1080, 420), "arial.ttf", 40, "1,260.00", (30, 30, 40)),
        ("item2", (132, 500), "arial.ttf", 40, "Wood screws, box of 200", (30, 30, 40)),
        ("p2", (1080, 500), "arial.ttf", 40, "385.00", (30, 30, 40)),
        ("total", (132, 640), "arialbd.ttf", 48, "Total payable: Rs 1,645.00", (20, 20, 28)),
        ("stamp", (132, 760), "cour.ttf", 38, "Ref no. GH-77815-QX", (36, 44, 110)),
        ("thanks", (132, 880), "timesi.ttf", 38, "Thank you for shopping with us.", (60, 52, 48)),
    ]
    d.line([(130, 590), (1300, 590)], fill=(90, 90, 96), width=3)
    boxes = []
    for key, pos, file, size, text, colour in lines:
        f = font(file, size)
        d.text(pos, text, font=f, fill=colour)
        x0, y0, x1, y1 = d.textbbox(pos, text, font=f)
        boxes.append({"id": key, "text": text, "quad": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]})
    c, s = np.cos(np.radians(angle)), np.sin(np.radians(angle))
    rotated = img.rotate(-angle, Image.BICUBIC, fillcolor=(120, 104, 88), center=(w / 2, h / 2))
    turn = lambda p: [w / 2 + (p[0] - w / 2) * c - (p[1] - h / 2) * s, h / 2 + (p[0] - w / 2) * s + (p[1] - h / 2) * c]
    truth[name.split(".")[0]] = [{**b, "quad": [turn(p) for p in b["quad"]]} for b in boxes]
    finish(rotated, blur, noise, quality, name, light=0.3)


paper_scene("receipt.jpg", 1.8, 0.8, 3.0, 82)
paper_scene("scan.png", 0.0, 0.35, 1.2, 92)

# white lettering painted on brick: the hardest background to rebuild
w, h = 1300, 620
brick = texture(w, h, (150, 74, 56), 18, 3)
img = Image.fromarray(brick.astype(np.uint8))
d = ImageDraw.Draw(img)
for row in range(0, h, 62):
    d.line([(0, row), (w, row)], fill=(196, 180, 164), width=7)
    for col in range((row // 62 % 2) * 75, w, 150):
        d.line([(col, row), (col, row + 62)], fill=(196, 180, 164), width=7)
font = lambda f, s: ImageFont.truetype(os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts", f), s)
boxes = []
for key, pos, file, size, text in [("open", (120, 120), "impact.ttf", 130, "OPEN DAILY"), ("hours", (125, 340), "arialbd.ttf", 74, "From 9 am to 11 pm")]:
    f = font(file, size)
    d.text((pos[0] + 3, pos[1] + 3), text, font=f, fill=(70, 34, 28))
    d.text(pos, text, font=f, fill=(244, 238, 226))
    x0, y0, x1, y1 = d.textbbox(pos, text, font=f)
    boxes.append({"id": key, "text": text, "quad": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]})
truth["brick"] = boxes
finish(img, 0.6, 2.0, 88, "brick.jpg")

json.dump(truth, open(os.path.join(out, "truth.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
print("scenes written to", out)
