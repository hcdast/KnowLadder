"""Finish local website media from actual captures and previously generated clips.

No network, credentials, model calls or business data writes. Existing outputs are
never overwritten. CUA source JPEGs and timestamp manifests remain in the cache.
"""
import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "web/public/website"
CAPTURE = ROOT / "media-upload/.cache/capture-287"
WORK = CAPTURE / "edit"
NEW_NAMES = [
    *[f"r0{i}-product-{name}{suffix}" for i, name in enumerate(
        ("personal", "course", "review", "teaching"), 1)
      for suffix in ("-master.png", ".webp")],
    *[f"v01-brand-learning{suffix}" for suffix in (
        "-master.mp4", ".mp4", "-poster-master.png", "-poster.webp",
        ".zh.vtt", "-transcript-zh.txt")],
    "v02-ai-review-motion-poster-master.png", "v02-ai-review-motion-transcript-zh.txt",
    *[f"v03-product-tour{suffix}" for suffix in (
        "-master.mp4", ".mp4", "-poster-master.png", "-poster.webp",
        ".zh.vtt", "-transcript-zh.txt")],
]


def refresh_v02_poster(ffmpeg):
    """Select a stable late frame, preserving the previous poster and receipt."""
    receipts = list((ROOT / "media-upload/.cache").glob("V02-*.json"))
    assert len(receipts) == 1, "V02_RECEIPT_AMBIGUOUS"
    receipt_path = receipts[0]
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    name = "v02-ai-review-motion-poster.webp"
    previous = next(file for file in receipt["files"] if file["name"] == name)
    current = OUTPUT / name
    assert hashlib.sha256(current.read_bytes()).hexdigest() == previous["sha256"], "V02_POSTER_CHANGED"
    backup = CAPTURE / "before-poster-edit"
    backup.mkdir(exist_ok=True)
    for source in (current, receipt_path):
        with (backup / source.name).open("xb") as target:
            target.write(source.read_bytes())
    result = subprocess.run([str(ffmpeg), "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", "4.5",
                             "-i", str(OUTPUT / "v02-ai-review-motion-master.mp4"), "-frames:v", "1", "-y",
                             str(WORK / "v02-ai-review-motion-poster-master.png")], capture_output=True)
    assert result.returncode == 0, "V02_FRAME_EXTRACTION_FAILED"
    temporary = WORK / name
    Image.open(WORK / "v02-ai-review-motion-poster-master.png").save(temporary, quality=94)
    data = temporary.read_bytes()
    record = {"name": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    receipt["files"] = [record if item["name"] == name else item for item in receipt["files"]]
    receipt["posterEdit287"] = {"frameSeconds": 4.5, "previous": previous, "backup": "capture-287/before-poster-edit"}
    # Recheck immediately before replacing only our matching generated poster.
    assert hashlib.sha256(current.read_bytes()).hexdigest() == previous["sha256"]
    temporary.replace(current)
    receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", required=True, type=Path)
    parser.add_argument("--font", required=True, type=Path)
    args = parser.parse_args()
    assert args.ffmpeg.is_file() and args.font.is_file(), "Existing tools required"
    OUTPUT.mkdir(parents=True, exist_ok=True)
    assert not any((OUTPUT / name).exists() for name in NEW_NAMES), "OUTPUT_ALREADY_EXISTS"
    WORK.mkdir(parents=True, exist_ok=True)
    fonts = {size: ImageFont.truetype(str(args.font), size) for size in (22, 26, 30, 40, 52, 72)}

    def command(*parts):
        result = subprocess.run([str(args.ffmpeg), "-hide_banner", "-loglevel", "error", "-nostdin", *map(str, parts)],
                                capture_output=True)
        if result.returncode:
            raise RuntimeError(result.stderr.decode("utf-8", errors="replace")[-2000:])

    def stage(name):
        return WORK / name

    def label(image, text):
        draw = ImageDraw.Draw(image)
        width = int(draw.textlength(text, font=fonts[22])) + 36
        draw.rounded_rectangle((image.width-width-24, 16, image.width-24, 60), 10, fill="#102c46")
        draw.text((image.width-width-6, 21), text, font=fonts[22], fill="white")

    # Preserve screenshot pixels; add only a small canvas border and disclosure.
    for i, name in enumerate(("personal", "course", "review", "teaching"), 1):
        source = Image.open(CAPTURE / f"r0{i}.jpg").convert("RGB")
        assert source.width <= 2400 and source.height <= 1500
        canvas = Image.new("RGB", (2400, 1500), "#f3f8fb")
        canvas.paste(source, ((2400-source.width)//2, (1500-source.height)//2))
        label(canvas, "实际界面 · 示例数据" + (" · 教师" if i == 4 else " · 学习者"))
        canvas.save(stage(f"r0{i}-product-{name}-master.png"))
        canvas.resize((1600, 1000), Image.Resampling.LANCZOS).save(stage(f"r0{i}-product-{name}.webp"), quality=93)

    logo = Image.open(CAPTURE / "logo.jpg").convert("RGB")
    logo.thumbnail((68, 68), Image.Resampling.LANCZOS)
    captions = ("好奇，是第一步。", "把所学，用在生活里。", "成长，可以贯穿一生。")
    clips = ("v01-a-parent-child-master.mp4", "v01-b-work-practice-master.mp4", "v01-c-senior-learning-master.mp4")
    for index, (clip, text) in enumerate(zip(clips, captions)):
        overlay = Image.new("RGBA", (1920, 1080), (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        # Cover generated bottom captions in this derivative; preserve source clips.
        draw.rectangle((0, 860, 1920, 1080), fill="#102c46")
        draw.text((96, 898), text, font=fonts[52], fill="white")
        draw.text((100, 984), "知阶 KnowLadder  ·  让每一步学习，都有回响", font=fonts[26], fill="#c7e2ef")
        overlay.paste(logo, (1710, 918))
        overlay.save(stage(f"brand-overlay-{index}.png"))
        command("-i", OUTPUT / clip, "-i", stage(f"brand-overlay-{index}.png"), "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto,format=yuv420p[v]",
                "-map", "[v]", "-t", 5, "-an", "-r", 24, "-c:v", "libx264", "-preset", "fast", "-crf", 16, "-threads", 2, "-y", stage(f"brand-{index}.mp4"))
    stage("brand.txt").write_text("".join(f"file 'brand-{i}.mp4'\n" for i in range(3)), encoding="utf-8")
    command("-f", "concat", "-safe", 0, "-i", stage("brand.txt"), "-c", "copy", "-movflags", "+faststart", "-y", stage("v01-brand-learning-master.mp4"))

    def web_video(prefix, fps):
        command("-i", stage(prefix + "-master.mp4"), "-an", "-r", fps, "-c:v", "libx264", "-preset", "fast", "-crf", 23,
                "-pix_fmt", "yuv420p", "-threads", 2, "-movflags", "+faststart", "-y", stage(prefix + ".mp4"))

    web_video("v01-brand-learning", 24)

    manifest = json.loads((CAPTURE / "frames.json").read_text(encoding="utf-8"))
    hero = ImageOps.fit(Image.open(CAPTURE / "h01.webp").convert("RGB"), (1920, 1080))

    def title_card(title, subtitle):
        image = hero.copy()
        shade = Image.new("RGBA", image.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(shade)
        draw.rectangle((0, 0, 1030, 1080), fill=(246, 250, 253, 245))
        image = Image.alpha_composite(image.convert("RGBA"), shade).convert("RGB")
        image.paste(logo, (110, 200))
        draw = ImageDraw.Draw(image)
        draw.text((110, 310), "知阶 KnowLadder", font=fonts[40], fill="#1263b0")
        draw.text((110, 410), title, font=fonts[72], fill="#102c46")
        draw.text((114, 530), subtitle, font=fonts[30], fill="#087f78")
        draw.text((114, 890), "实际界面 · 示例数据 · 无旁白", font=fonts[26], fill="#526b80")
        return image

    title_card("每一步，都算数。", "从课程阅读，到实践与回顾").save(stage("intro.jpg"), quality=96)
    title_card("让学习，持续发生。", "知阶 · 连接个人学习与教学协作").save(stage("outro.jpg"), quality=96)
    concat = ["file 'intro.jpg'\nduration 3\n"]
    # Fixed-rate image2 input avoids per-image concat time-base rounding.
    grid_sources = ["intro.jpg"] * 90
    labels = {
        "personal": ("学习者", "从个人学习空间继续原创课程"),
        "course": ("学习者", "阅读单元 · 完成选择练习 · 填写实践与回顾"),
        "notes": ("学习者", "查看个人笔记与真实复习历史"),
        "teacher": ("已切换：教师", "打开真实提交 · 查看已发布的教师反馈"),
    }
    capture_stats = {}
    for segment, duration in manifest["segments"].items():
        frames = [frame for frame in manifest["frames"] if frame["segment"] == segment and frame["timeMs"] < duration*1000]
        assert len(frames) > 1 and frames[0]["timeMs"] < 250
        capture_stats[segment] = {"frames": len(frames), "seconds": duration, "averageSamplesPerSecond": round(len(frames)/duration, 2)}
        for index, frame in enumerate(frames):
            source = Image.open(CAPTURE / frame["file"]).convert("RGB")
            assert source.width <= 1920 and source.height <= 1080
            image = Image.new("RGB", (1920, 1080), "#f3f8fb")
            image.paste(source, ((1920-source.width)//2, (1080-source.height)//2))
            role, caption = labels[segment]
            if not frame.get("prepared"):
                label(image, "实际界面 · 示例数据 | " + role)
                draw = ImageDraw.Draw(image)
                draw.rectangle((0, 1000, 1920, 1080), fill="#102c46")
                draw.text((72, 1017), caption, font=fonts[30], fill="white")
            filename = "edit-" + frame["file"]
            image.save(stage(filename), quality=94)
            start = 0 if index == 0 else frame["timeMs"] / 1000
            end = frames[index+1]["timeMs"] / 1000 if index+1 < len(frames) else duration
            concat.append(f"file '{filename}'\nduration {end-start:.6f}\n")
        cursor = 0
        for tick in range(duration * 30):
            timestamp = tick * 1000 / 30
            while cursor + 1 < len(frames) and frames[cursor + 1]["timeMs"] <= timestamp:
                cursor += 1
            grid_sources.append("edit-" + frames[cursor]["file"])
    grid_sources.extend(["outro.jpg"] * 60)
    assert len(grid_sources) == 900
    grid = stage("grid")
    grid.mkdir(exist_ok=True)
    for index, source in enumerate(grid_sources):
        destination = grid / f"{index:05d}.jpg"
        assert not destination.exists(), "ENCODE_GRID_ALREADY_EXISTS"
        os.link(stage(source), destination)
    concat.append("file 'outro.jpg'\nduration 2\nfile 'outro.jpg'\n")
    stage("tour.txt").write_text("".join(concat), encoding="utf-8")
    command("-framerate", 30, "-i", grid / "%05d.jpg", "-frames:v", 900,
            "-vf", "scale=in_range=full:out_range=tv,format=yuv420p", "-color_range", "tv",
            "-an", "-c:v", "libx264", "-preset", "fast", "-crf", 17, "-pix_fmt", "yuv420p", "-threads", 2,
            "-movflags", "+faststart", "-y", stage("v03-product-tour-master.mp4"))
    web_video("v03-product-tour", 30)

    for prefix, second in (("v01-brand-learning", 1.5), ("v03-product-tour", 5)):
        command("-ss", second, "-i", stage(prefix + "-master.mp4"), "-frames:v", 1, "-y", stage(prefix + "-poster-master.png"))
        Image.open(stage(prefix + "-poster-master.png")).save(stage(prefix + "-poster.webp"), quality=94)
    updated_poster = refresh_v02_poster(args.ffmpeg)

    def vtt(name, cues):
        def stamp(seconds):
            return f"00:{seconds//60:02d}:{seconds%60:02d}.000"
        stage(name).write_text("WEBVTT\n\n" + "\n".join(f"{stamp(start)} --> {stamp(end)}\n{text}\n" for start, end, text in cues), encoding="utf-8")

    vtt("v01-brand-learning.zh.vtt", [(0, 5, captions[0]), (5, 10, captions[1]), (10, 15, captions[2])])
    vtt("v03-product-tour.zh.vtt", [(0, 3, "知阶 KnowLadder：每一步，都算数。"), (3, 10, labels["personal"][1]),
        (10, 17, labels["course"][1]), (17, 23, labels["notes"][1]), (23, 28, "已切换到教师：查看提交与已发布反馈。"),
        (28, 30, "让学习，持续发生。")])
    stage("v01-brand-learning-transcript-zh.txt").write_text(
        "知阶品牌片｜15秒｜无音轨、无旁白。AI生成场景，经后期拼接。\n"
        "00:00—00:05 亲子在桌边阅读绘本，孩子指向书页。字幕：好奇，是第一步。\n"
        "00:05—00:10 成人在工作桌前整理、书写实践材料。字幕：把所学，用在生活里。\n"
        "00:10—00:15 长者使用平板学习，调整设备。字幕：成长，可以贯穿一生。\n"
        "三段直接切换；下方为后期统一字幕与知阶品牌标识。并非产品功能录像或学习成效证明。\n", encoding="utf-8")
    stage("v02-ai-review-motion-transcript-zh.txt").write_text(
        "AI辅助与人工复核概念动效｜5秒｜无音轨、无旁白。\n"
        "暖色桌面上有三组纸张；蓝色与青绿色路径连接、移动，表达材料整理与复核的概念。纸面含模型生成线条/文字，不应作为可读正文。\n"
        "该画面为AI生成示意，不是实际产品界面、模型回复或已执行审核的记录。海报选自4.5秒的后段稳定画面。\n", encoding="utf-8")
    stage("v03-product-tour-transcript-zh.txt").write_text(
        "知阶产品导览｜30秒｜无音轨、无旁白。实际本地界面，隔离一次性数据库与合成账号/数据。\n"
        "00:00—00:03 使用H01已链接素材与实际知阶标识开场：每一步，都算数。\n"
        "00:03—00:10 示例学习者的个人空间，显示继续学习与当周安排；点击继续学习，打开原创课程。\n"
        "00:10—00:17 阅读‘让状态可以被核对’，选择‘议程草稿已完成，待审核’，填写实践记录与学习回顾。\n"
        "00:17—00:23 打开笔记与复习，查看已保存笔记、已回顾次数及真实复习历史。\n"
        "00:23—00:28 已切换为示例教师，打开‘制作一张观察记录卡’的提交与批阅，显示真实已发布反馈。身份标签明确区分教师与学习者；未展示独立审核员操作。\n"
        "00:28—00:30 H01品牌画面结束：让学习，持续发生。\n"
        "制作说明：CUA按实际时间戳连续采集JPEG屏幕帧，按片段剪辑、保留真实操作，再导出1920×1080/30fps；不是原生30fps屏幕录像。字幕带与示例/身份标签为后期叠加，未重绘界面、伪造业务状态或配音。\n", encoding="utf-8")

    records = []
    for name in NEW_NAMES:
        file = stage(name)
        if file.suffix in (".mp4", ".png", ".webp"):
            command("-i", file, "-f", "null", "-")
        if file.suffix in (".png", ".webp"):
            image = Image.open(file)
            expected = (1600, 1000) if name.startswith("r0") and name.endswith(".webp") else (2400, 1500) if name.startswith("r0") else (1920, 1080)
            assert image.size == expected, (name, image.size)
        records.append({"name": name, "bytes": file.stat().st_size, "sha256": hashlib.sha256(file.read_bytes()).hexdigest()})
    for record in records:
        # Exclusive create: a concurrent/user output is never replaced.
        with (OUTPUT / record["name"]).open("xb") as target:
            target.write(stage(record["name"]).read_bytes())
    evidence = {"createdAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
                "newFiles": records, "updatedFiles": [updated_poster], "capture": capture_stats,
                "limitations": ["V03 is timestamped browser JPEG sequence, not native 30fps recording", "AI source visual deviations from revision286 remain"],
                "fullDecode": "passed for all new PNG/WebP/MP4 files"}
    (CAPTURE / "delivery.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"newFiles": len(records), "bytes": sum(item["bytes"] for item in records), "capture": capture_stats}, ensure_ascii=False))


if __name__ == "__main__":
    main()
