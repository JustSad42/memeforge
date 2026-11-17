"""Draws the MemeForge icon: a violet-to-pink rounded square with a white speech bubble
holding a bold "M". Writes rust/icons/{icon.ico, 32x32.png, tray.png, icon.png}."""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "rust", "icons")
os.makedirs(OUT, exist_ok=True)


def draw(size):
    S = size * 4  # supersample
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # diagonal gradient
    grad = Image.new("RGBA", (S, S))
    gp = grad.load()
    a, b = (124, 58, 237), (236, 72, 153)
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2 * S - 2)
            gp[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.23), fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    # speech bubble
    m = S * 0.16
    box = [m, m * 1.05, S - m, S - m * 1.75]
    d.rounded_rectangle(box, radius=int(S * 0.13), fill=(255, 255, 255, 255))
    tail = [(S * 0.30, box[3] - 2), (S * 0.27, S * 0.86), (S * 0.47, box[3] - 2)]
    d.polygon(tail, fill=(255, 255, 255, 255))
    font = ImageFont.truetype("C:/Windows/Fonts/impact.ttf", int(S * 0.44))
    text = "M"
    l, t, r, btm = d.textbbox((0, 0), text, font=font)
    cx = (box[0] + box[2]) / 2 - (l + r) / 2
    cy = (box[1] + box[3]) / 2 - (t + btm) / 2
    d.text((cx, cy), text, font=font, fill=(124, 58, 237, 255))
    return img.resize((size, size), Image.LANCZOS)


big = draw(256)
big.save(os.path.join(OUT, "icon.png"))
draw(32).save(os.path.join(OUT, "32x32.png"))
draw(64).save(os.path.join(OUT, "tray.png"))
big.save(os.path.join(OUT, "icon.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("icons written to", os.path.abspath(OUT))
