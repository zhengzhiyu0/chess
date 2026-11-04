from pathlib import Path
from PIL import Image, ImageDraw

src = Path(r"C:\Users\admin\Downloads\01a19ace-509a-718d-91f4-a73b73101d9b.png")
out = src.with_name(src.stem + "_抠图.png")
preview = src.with_name(src.stem + "_抠图预览.png")

im = Image.open(src).convert("RGBA")
pix = im.load()
# The source background is white. Use the green chroma (G-R) to derive a
# soft alpha mask, preserving anti-aliased green edges while removing white.
for y in range(im.height):
    for x in range(im.width):
        r, g, b, _ = pix[x, y]
        chroma = max(0, g - r)
        # Values below 3 are neutral background/shadow; values above 28 are
        # solid logo. Smooth transition keeps the original edge antialiasing.
        t = max(0.0, min(1.0, (chroma - 2.0) / 26.0))
        alpha = int(round(t * t * (3.0 - 2.0 * t) * 255))
        pix[x, y] = (r, g, b, alpha)

im.save(out)

# Checkerboard preview for visual confirmation of transparency.
cell = 32
preview_im = Image.new("RGBA", im.size)
d = ImageDraw.Draw(preview_im)
light = (238, 238, 238, 255)
dark = (205, 205, 205, 255)
for y in range(0, im.height, cell):
    for x in range(0, im.width, cell):
        d.rectangle((x, y, min(x + cell - 1, im.width - 1), min(y + cell - 1, im.height - 1)), fill=light if ((x // cell + y // cell) % 2 == 0) else dark)
preview_im.alpha_composite(im)
preview_im.convert("RGB").save(preview)
print(out)
print(preview)
