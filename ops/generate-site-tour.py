"""Create an original, silent interface tour from approved local product screenshots.

Requires Pillow and an explicitly supplied FFmpeg executable. No network or real data access.
"""
import argparse
import hashlib
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "web/public/visuals"
STAGES = [
    (4, "知阶 KnowLadder", "连接课程、实践与教师反馈", "每一步学习，都有方向。", None),
    (8, "学员学习", "下一步学习，清晰可见", "查看已分配课程与任务，持续积累学习记录。", "product-learning.webp"),
    (8, "教师授课", "把教学环节连接起来", "组织课程与实践任务，按审核流程发布。", "product-teaching.webp"),
    (7, "组织培训", "围绕班级，协作有序", "按有效授课关系组织培训，权限决定可用功能。", "product-organization.webp"),
    (3, "开启你的学习旅程", "从第一次登录开始", "获取账号 · 进入工作区 · 开始学习或授课", None),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", required=True, type=Path)
    parser.add_argument("--font", required=True, type=Path, help="Locally licensed Chinese font")
    args = parser.parse_args()
    if not args.ffmpeg.is_file() or not args.font.is_file():
        parser.error("FFmpeg and font must be existing local files")
    fonts = {size: ImageFont.truetype(str(args.font), size) for size in (24, 30, 34, 44, 60, 74)}

    def frame(stage):
        _, label, title, body, source = stage
        image = Image.new("RGB", (1920, 1080), "#f4f8fc")
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((72, 64, 1848, 1016), radius=36, fill="white", outline="#dce8f1", width=2)
        draw.text((120, 110), "知阶  /  KNOWLADDER", font=fonts[30], fill="#1263b0")
        draw.text((1380, 114), "产品界面导览 · 示例数据", font=fonts[24], fill="#667f91")
        if source:
            draw.text((120, 290), label, font=fonts[34], fill="#087f78")
            # Deliberate wrapping keeps Chinese copy readable without cropping.
            lines = {
                "product-learning.webp": ("下一步学习，", "清晰可见。"),
                "product-teaching.webp": ("把教学环节", "连接起来。"),
                "product-organization.webp": ("围绕班级，", "协作有序。"),
            }[source]
            for n, line in enumerate(lines):
                draw.text((120, 365 + n * 90), line, font=fonts[60], fill="#19354b")
            for n in range(0, len(body), 14):
                draw.text((120, 620 + (n // 14) * 54), body[n:n+14], font=fonts[30], fill="#536b7d")
            screen = Image.open(ASSETS / source).convert("RGB")
            screen.thumbnail((1100, 760), Image.Resampling.LANCZOS)
            x, y = 684 + (1100 - screen.width) // 2, 248 + (760 - screen.height) // 2
            image.paste(screen, (x, y))
            draw.rounded_rectangle((x-2, y-2, x+screen.width+2, y+screen.height+2), radius=8, outline="#d3e1ec", width=2)
        else:
            draw.text((140, 335), label, font=fonts[44], fill="#087f78")
            draw.text((140, 450), title, font=fonts[74], fill="#19354b")
            draw.text((140, 590), body, font=fonts[34], fill="#536b7d")
            for n, text in enumerate(("课程学习", "实践任务", "教师反馈")):
                x = 140 + n * 475
                draw.rounded_rectangle((x, 750, x+380, 844), radius=18, fill="#eaf3fa")
                draw.text((x+45, 773), text, font=fonts[34], fill="#1263b0")
        draw.text((120, 951), "实际示例界面剪辑；可用功能以账号授权与配置为准。", font=fonts[24], fill="#667f91")
        return image

    ASSETS.mkdir(exist_ok=True)
    frame(STAGES[0]).resize((1280, 720), Image.Resampling.LANCZOS).save(ASSETS / "product-tour-poster.webp", quality=90)
    command = [str(args.ffmpeg), "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "1920x1080", "-r", "12", "-i", "pipe:0", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(ASSETS / "product-tour.mp4")]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    try:
        for stage in STAGES:
            pixels = frame(stage).tobytes()
            for _ in range(stage[0] * 12):
                process.stdin.write(pixels)
    finally:
        process.stdin.close()
    if process.wait() != 0:
        raise SystemExit("FFmpeg encoding failed")
    captions = ["WEBVTT", ""]
    elapsed = 0
    for duration, label, title, body, _ in STAGES:
        captions.extend([f"00:00:{elapsed:02d}.000 --> 00:00:{elapsed+duration:02d}.000", f"{label}：{title}。{body}", ""])
        elapsed += duration
    (ASSETS / "product-tour.zh.vtt").write_text("\n".join(captions), encoding="utf-8")
    for name in ("product-tour.mp4", "product-tour-poster.webp", "product-tour.zh.vtt"):
        data = (ASSETS / name).read_bytes()
        print(name, len(data), hashlib.sha256(data).hexdigest())


if __name__ == "__main__":
    main()
