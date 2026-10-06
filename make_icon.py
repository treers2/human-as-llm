"""生成大肥狗AI 的桌面图标 (.ico)
紫色圆角底 + 白色对话气泡 + 气泡里的「人」形剪影
"""
from PIL import Image, ImageDraw

SIZE = 256
PURPLE = (83, 74, 183, 255)
PURPLE_DARK = (60, 52, 137, 255)
WHITE = (255, 255, 255, 255)

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角底
d.rounded_rectangle([4, 4, SIZE - 4, SIZE - 4], radius=54, fill=PURPLE)

# 对话气泡（白色）
bx0, by0, bx1, by1 = 36, 46, SIZE - 36, 172
d.rounded_rectangle([bx0, by0, bx1, by1], radius=30, fill=WHITE)
# 气泡小尾巴
d.polygon([(88, 168), (88, 214), (140, 170)], fill=WHITE)

# 气泡里的「人」形：头 + 肩
cx = (bx0 + bx1) // 2
head_r = 20
d.ellipse([cx - head_r, by0 + 26, cx + head_r, by0 + 26 + head_r * 2], fill=PURPLE_DARK)
# 肩部：用半圆做
sh_y = by0 + 26 + head_r * 2 + 10
sh_w = 62
d.rounded_rectangle([cx - sh_w // 2, sh_y, cx + sh_w // 2, sh_y + 26], radius=13, fill=PURPLE_DARK)

# 右上角一个「在线」小点，暗示服务在跑
d.ellipse([SIZE - 80, 20, SIZE - 28, 72], fill=WHITE)
d.ellipse([SIZE - 72, 28, SIZE - 36, 64], fill=(29, 158, 117, 255))

img.save("dafeigou-ai.png")

sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)]
img.save("dafeigou-ai.ico", format="ICO", sizes=sizes)

# 顺手导出一张预览用的 PNG
img.resize((128, 128), Image.LANCZOS).save("dafeigou-ai-preview.png")
print("已生成 dafeigou-ai.ico", sizes)
