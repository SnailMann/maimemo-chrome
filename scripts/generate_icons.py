from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "icons"

MASTER_SIZE = 1024
OUTPUT_SIZES = (16, 32, 48, 128)

BG_TOP = (247, 236, 218, 255)
BG_BOTTOM = (229, 199, 148, 255)
BG_BORDER = (210, 172, 116, 255)
OWL_DARK = (47, 50, 50, 255)
OWL_DARK_2 = (28, 31, 31, 255)
PUPIL = (61, 63, 63, 255)
TEAL = (16, 114, 95, 255)
AMBER = (173, 100, 32, 255)
WHITE = (255, 255, 255, 255)


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def gradient_fill(size: int, top: tuple[int, int, int, int], bottom: tuple[int, int, int, int]) -> Image.Image:
    image = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(image)

    for y in range(size):
        t = y / max(size - 1, 1)
        color = tuple(lerp(top[i], bottom[i], t) for i in range(4))
        draw.line((0, y, size, y), fill=color)

    return image


def add_soft_ellipse(layer: Image.Image, box: tuple[int, int, int, int], color: tuple[int, int, int, int], blur: int) -> None:
    glow = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse(box, fill=color)
    glow = glow.filter(ImageFilter.GaussianBlur(blur))
    layer.alpha_composite(glow)


def draw_background(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gradient = gradient_fill(size, BG_TOP, BG_BOTTOM)

    mask = Image.new("L", (size, size), 0)
    mask_draw = ImageDraw.Draw(mask)
    outer = (72, 72, size - 72, size - 72)
    mask_draw.rounded_rectangle(outer, radius=224, fill=255)

    image.paste(gradient, mask=mask)

    overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    add_soft_ellipse(overlay, (120, 80, 620, 440), (255, 255, 255, 88), 42)
    add_soft_ellipse(overlay, (180, 540, 900, 980), (196, 137, 57, 38), 54)
    image.alpha_composite(overlay)

    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(outer, radius=224, outline=BG_BORDER, width=18)
    draw.rounded_rectangle((108, 108, size - 108, size - 108), radius=190, outline=(255, 255, 255, 58), width=8)
    return image


def draw_owl(size: int) -> Image.Image:
    owl = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(owl)

    # Body silhouette: simplified from the official owl mark, tuned for 16px readability.
    body_points = [
        (292, 278),
        (370, 228),
        (492, 214),
        (616, 230),
        (716, 300),
        (744, 448),
        (720, 604),
        (654, 734),
        (548, 804),
        (424, 800),
        (324, 744),
        (270, 626),
        (256, 468),
    ]
    draw.polygon(body_points, fill=OWL_DARK)
    draw.pieslice((258, 238, 748, 818), start=156, end=384, fill=OWL_DARK)

    shade = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shade_draw = ImageDraw.Draw(shade)
    shade_draw.ellipse((322, 312, 726, 804), fill=OWL_DARK_2)
    shade_draw.polygon([(618, 254), (760, 360), (746, 648), (586, 790)], fill=OWL_DARK_2)
    shade = shade.filter(ImageFilter.GaussianBlur(18))
    owl.alpha_composite(shade)

    draw = ImageDraw.Draw(owl)
    draw.ellipse((278, 694, 756, 802), fill=TEAL)

    draw.ellipse((286, 312, 556, 580), fill=WHITE)
    draw.ellipse((468, 294, 738, 564), fill=WHITE)

    draw.ellipse((382, 390, 468, 476), fill=PUPIL)
    draw.ellipse((544, 368, 630, 454), fill=PUPIL)
    draw.ellipse((410, 408, 432, 430), fill=WHITE)
    draw.ellipse((570, 386, 592, 408), fill=WHITE)

    draw.polygon([(488, 522), (542, 552), (520, 620), (462, 568)], fill=AMBER)
    draw.polygon([(498, 540), (566, 512), (622, 570), (542, 574)], fill=OWL_DARK)

    return owl


def create_master() -> Image.Image:
    background = draw_background(MASTER_SIZE)
    owl = draw_owl(MASTER_SIZE)
    background.alpha_composite(owl)
    return background


def write_svg(path: Path) -> None:
    svg = """<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" fill="none">
  <defs>
    <linearGradient id="bg" x1="512" y1="72" x2="512" y2="952" gradientUnits="userSpaceOnUse">
      <stop stop-color="#F7ECDA"/>
      <stop offset="1" stop-color="#E5C794"/>
    </linearGradient>
    <filter id="glow" x="0" y="0" width="1024" height="1024" filterUnits="userSpaceOnUse">
      <feGaussianBlur stdDeviation="30"/>
    </filter>
    <filter id="shade" x="0" y="0" width="1024" height="1024" filterUnits="userSpaceOnUse">
      <feGaussianBlur stdDeviation="18"/>
    </filter>
  </defs>

  <rect x="72" y="72" width="880" height="880" rx="224" fill="url(#bg)"/>
  <rect x="72" y="72" width="880" height="880" rx="224" stroke="#D2AC74" stroke-width="18"/>
  <rect x="108" y="108" width="808" height="808" rx="190" stroke="#FFFFFF" stroke-opacity="0.23" stroke-width="8"/>

  <g filter="url(#glow)" opacity="0.9">
    <ellipse cx="370" cy="250" rx="220" ry="140" fill="#FFFFFF" fill-opacity="0.34"/>
    <ellipse cx="610" cy="770" rx="310" ry="150" fill="#C48939" fill-opacity="0.18"/>
  </g>

  <g>
    <path d="M292 278C337 245 405 220 492 214C614 230 716 300 744 448C742 585 697 690 612 758C561 797 496 815 424 800C329 765 275 702 256 468L292 278Z" fill="#2F3232"/>
    <g filter="url(#shade)">
      <ellipse cx="524" cy="558" rx="202" ry="246" fill="#1C1F1F"/>
      <path d="M618 254L760 360L746 648L586 790L618 254Z" fill="#1C1F1F"/>
    </g>
    <ellipse cx="517" cy="748" rx="239" ry="54" fill="#10725F"/>
    <circle cx="421" cy="446" r="135" fill="white"/>
    <circle cx="603" cy="429" r="135" fill="white"/>
    <circle cx="425" cy="433" r="43" fill="#3D3F3F"/>
    <circle cx="587" cy="411" r="43" fill="#3D3F3F"/>
    <circle cx="421" cy="419" r="11" fill="white"/>
    <circle cx="581" cy="397" r="11" fill="white"/>
    <path d="M488 522L542 552L520 620L462 568L488 522Z" fill="#AD6420"/>
    <path d="M498 540L566 512L622 570L542 574L498 540Z" fill="#2F3232"/>
  </g>
</svg>
"""
    path.write_text(svg, encoding="utf-8")


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)

    master = create_master()
    master.save(ICON_DIR / "icon-master.png")

    for size in OUTPUT_SIZES:
        icon = master.resize((size, size), Image.Resampling.LANCZOS)
        icon.save(ICON_DIR / f"icon{size}.png")

    write_svg(ICON_DIR / "icon.svg")


if __name__ == "__main__":
    main()
