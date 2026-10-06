# Draws the red-glow face icon (arches + smile) at several sizes.
from PIL import Image, ImageDraw, ImageFilter
def face(size, pad):
    S = size * 2; im = Image.new('RGB', (S, S), (0, 0, 0))
    lay = Image.new('RGB', (S, S), (0, 0, 0)); d = ImageDraw.Draw(lay)
    inner = S * (1 - 2 * pad); o = S * pad; u = inner / 100
    lw = max(3, int(6.5 * u))
    for cx in (27, 73):
        d.arc([o + (cx - 17) * u, o + 26 * u, o + (cx + 17) * u, o + 60 * u], 180, 360, fill=(255, 40, 22), width=lw)
    d.arc([o + 22 * u, o + 36 * u, o + 78 * u, o + 78 * u], 20, 160, fill=(255, 40, 22), width=int(lw * .7))
    glow = lay.filter(ImageFilter.GaussianBlur(S * .03)); glow2 = lay.filter(ImageFilter.GaussianBlur(S * .008))
    core = lay.convert('L').point(lambda v: 255 if v > 30 else 0).convert('RGB').filter(ImageFilter.MinFilter(max(3, (lw // 3) | 1)))
    from PIL import ImageChops
    out = ImageChops.add(ImageChops.add(glow, glow2), lay)
    out = ImageChops.lighter(out, core.point(lambda v: int(v * .9)))
    return out.resize((size, size), Image.LANCZOS)
D = '/workspace/gibson-app/icons/'
face(192, .08).save(D + 'icon-192.png'); face(512, .08).save(D + 'icon-512.png')
face(512, .18).save(D + 'maskable-512.png'); face(180, .1).save(D + 'apple-touch-icon.png'); face(64, .05).save(D + 'favicon.png')
print('icons ok')
