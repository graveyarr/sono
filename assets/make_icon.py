"""Рисует логотип и значок Sono (нужен Pillow: pip install pillow). Запуск: python assets/make_icon.py

- assets/logo.png — логотип: чёрный квадрат, ровно посередине «sono.» (шрифт Century Gothic Bold);
- assets/sono.ico — значок программы: чёрный скруглённый квадрат с «sono.»; в самых мелких размерах
  (16–32 px, панель задач, Проводник) слово не прочитать — там «s.»;
- assets/sono.png — значок 256×256 (для README).
Century Gothic есть в Windows; на другой системе укажите путь к шрифту первым аргументом.
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
FONT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"C:\Windows\Fonts\GOTHICB.TTF")


def text_square(text: str, size: int, width_share: float, radius: float = 0) -> Image.Image:
    """Чёрный квадрат (со скруглением radius — доля стороны) и белая надпись ровно по центру."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=size * radius, fill=(0, 0, 0, 255))
    font_size = size // 4
    for _ in range(4):   # подбираем размер шрифта под нужную ширину надписи
        font = ImageFont.truetype(str(FONT), font_size)
        l, t, r, b = d.textbbox((0, 0), text, font=font)
        font_size = int(font_size * size * width_share / (r - l))
    font = ImageFont.truetype(str(FONT), font_size)
    l, t, r, b = d.textbbox((0, 0), text, font=font)
    # Центр — по видимым очертаниям букв, а не по строке шрифта
    d.text(((size - (r - l)) / 2 - l, (size - (b - t)) / 2 - t), text, font=font, fill=(255, 255, 255, 255))
    return img


# Логотип — полностью чёрный квадрат
text_square("sono.", 1024, 0.64).convert("RGB").save(HERE / "logo.png")

# Значок: рисуем крупно и уменьшаем (так края гладкие); мелкие размеры — отдельным рисунком «s.»
big = text_square("sono.", 1024, 0.72, radius=0.22)
small = text_square("s.", 1024, 0.58, radius=0.22)
sizes = [16, 24, 32, 48, 64, 128, 256]
frames = [(small if s <= 32 else big).resize((s, s), Image.LANCZOS) for s in sizes]
frames[-1].save(HERE / "sono.ico", sizes=[(s, s) for s in sizes], append_images=frames[:-1])
frames[-1].save(HERE / "sono.png")
print("готово: logo.png, sono.ico, sono.png")
