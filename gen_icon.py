from PIL import Image, ImageDraw, ImageFont
import os

size = 1024
img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Blue gradient background
for y in range(size):
    ratio = y / size
    r = int(30 + (10 - 30) * ratio)
    g = int(100 + (50 - 100) * ratio)
    b = int(220 + (180 - 220) * ratio)
    draw.line([(0, y), (size, y)], fill=(r, g, b, 255))

# Draw a terminal window shape
margin = 150
# Terminal window background (darker)
draw.rounded_rectangle(
    [margin, margin + 50, size - margin, size - margin],
    radius=30,
    fill=(30, 30, 40, 240)
)

# Terminal title bar
draw.rounded_rectangle(
    [margin, margin + 50, size - margin, margin + 130],
    radius=30,
    fill=(50, 50, 60, 255)
)
# Fix bottom of title bar (square off)
draw.rectangle(
    [margin, margin + 110, size - margin, margin + 130],
    fill=(50, 50, 60, 255)
)

# Three dots (traffic lights)
dot_y = margin + 90
for i, color in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
    cx = margin + 50 + i * 50
    draw.ellipse([cx - 15, dot_y - 15, cx + 15, dot_y + 15], fill=color + (255,))

# Terminal prompt symbol ">_"
try:
    font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 120)
except:
    font = ImageFont.load_default()

# Draw ">_" prompt
text_y = margin + 200
draw.text((margin + 60, text_y), ">_", fill=(100, 255, 150, 255), font=font)

out_path = "/Users/zifang/workplace/ceo_workplace/z-biz-tool-terminal/app-icon.png"
img.save(out_path)
print(f"Icon saved to {out_path}")
print(f"Size: {img.size}")
