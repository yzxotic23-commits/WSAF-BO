#!/usr/bin/env python3
"""Remove gray/white gradient background from FeedFlow logo PNG."""
from collections import deque
from PIL import Image

SRC = r"C:\Users\GERI\.cursor\projects\e-Whatsapp-Auto-Feeding\assets\c__Users_GERI_AppData_Roaming_Cursor_User_workspaceStorage_7d0264ca1797029665067fd9fbfd3ef6_images_image-ea6db179-5347-49f2-9549-e5a51ae2cbd3.png"
OUT = r"E:\Whatsapp Auto Feeding\client\dist\assets\feedflow-logo.png"


def is_barrier(r: int, g: int, b: int) -> bool:
    """Black icon frame — do not flood through."""
    return r < 40 and g < 40 and b < 40


def is_background(r: int, g: int, b: int) -> bool:
    if is_barrier(r, g, b):
        return False
    # neutral gray gradient (low saturation)
    if max(r, g, b) - min(r, g, b) > 30:
        return False
    avg = (r + g + b) / 3
    return avg >= 75


def remove_background(img: Image.Image) -> Image.Image:
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()
    visited = [[False] * w for _ in range(h)]
    q = deque()

    for x in range(w):
        q.append((x, 0))
        q.append((x, h - 1))
    for y in range(h):
        q.append((0, y))
        q.append((w - 1, y))

    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h or visited[y][x]:
            continue
        visited[y][x] = True
        r, g, b, a = px[x, y]
        if is_barrier(r, g, b):
            continue
        if is_background(r, g, b):
            px[x, y] = (r, g, b, 0)
            q.extend([(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)])

    return img


def trim_and_square(img: Image.Image, padding_ratio: float = 0.06) -> Image.Image:
    bbox = img.getbbox()
    if not bbox:
        return img
    cropped = img.crop(bbox)
    cw, ch = cropped.size
    side = max(cw, ch)
    pad = int(side * padding_ratio)
    side += pad * 2
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    ox = (side - cw) // 2
    oy = (side - ch) // 2
    square.paste(cropped, (ox, oy), cropped)
    return square


def main() -> None:
    img = Image.open(SRC)
    img = remove_background(img)
    img = trim_and_square(img)
    # export common sizes
    img.save(OUT, "PNG", optimize=True)
    img.resize((512, 512), Image.Resampling.LANCZOS).save(
        OUT.replace(".png", "-512.png"), "PNG", optimize=True
    )
    print(f"Saved {OUT} ({img.size[0]}x{img.size[1]})")


if __name__ == "__main__":
    main()
