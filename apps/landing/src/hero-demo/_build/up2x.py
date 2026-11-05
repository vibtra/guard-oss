import sys, os, glob, shutil
from PIL import Image, ImageFilter
from concurrent.futures import ProcessPoolExecutor

def one(a):
    i, o = a
    im = Image.open(i).convert("RGB")
    im = im.resize((im.width * 2, im.height * 2), Image.LANCZOS).filter(ImageFilter.UnsharpMask(radius=1.2, percent=35, threshold=2))
    im.save(o, compress_level=1)

def main():
    src, dst = sys.argv[1], sys.argv[2]
    jobs = []
    for d in ["claude/content", "claude/surface", "chatgpt/surface"]:
        os.makedirs(os.path.join(dst, d), exist_ok=True)
        shutil.copy(os.path.join(src, d, "manifest.json"), os.path.join(dst, d, "manifest.json"))
        for f in sorted(glob.glob(os.path.join(src, d, "f*.png"))):
            jobs.append((f, os.path.join(dst, d, os.path.basename(f))))
    with ProcessPoolExecutor() as ex:
        list(ex.map(one, jobs, chunksize=8))
    print(len(jobs))

if __name__ == "__main__":
    main()
