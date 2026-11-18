"""Draw the four original, fictional storyboard frames shipped with the app."""
from pathlib import Path
from random import Random

from PIL import Image, ImageDraw, ImageFilter

W, H = 1280, 720
OUTPUT = Path(__file__).resolve().parents[1] / 'resources' / 'sample'
OUTPUT.mkdir(parents=True, exist_ok=True)


def gradient(top, bottom):
    image = Image.new('RGB', (W, H))
    draw = ImageDraw.Draw(image)
    for y in range(H):
        t = y / H
        color = tuple(int(a + (b - a) * t) for a, b in zip(top, bottom))
        draw.line((0, y, W, y), fill=color)
    return image


def glow(image, center, radius, color):
    layer = Image.new('RGBA', (W, H))
    x, y = center
    ImageDraw.Draw(layer).ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)
    image.paste(layer.filter(ImageFilter.GaussianBlur(radius / 3)), (0, 0), layer.filter(ImageFilter.GaussianBlur(radius / 3)))


def mountains(draw, height, color, seed):
    rnd = Random(seed)
    outline = [(x, height + rnd.randint(-29, 30) + abs(x - 610) * -.10) for x in range(-40, W + 60, 63)]
    draw.polygon(outline + [(W, H), (0, H)], fill=color)


def pier(draw, x, y, s):
    draw.polygon([(x, y), (x + 310*s, y - 12*s), (x + 380*s, y + 58*s), (x - 70*s, y + 85*s)], fill='#161a32')
    for i in range(6):
        shift = i * 54*s
        draw.line((x+shift, y, x+shift-11*s, y+120*s), fill='#14182d', width=max(2, int(s*9)))
        draw.line((x+shift, y, x+shift+17*s, y+41*s), fill='#33324d', width=max(1, int(s*2)))


def tower(draw, x, y, s, lit=True):
    def p(points, fill):
        draw.polygon([(x + a*s, y + b*s) for a, b in points], fill=fill)
    p([(-37, 0), (37, 0), (25, -161), (-23, -161)], '#292642')
    p([(-37, 0), (-4, 0), (0, -160), (-23, -160)], '#5b4d63')
    p([(-34, -28), (35, -28), (33, -52), (-31, -52)], '#9c635d')
    p([(-32, -163), (33, -163), (33, -203), (-32, -203)], '#29243d')
    if lit:
        p([(-23, -169), (24, -169), (24, -197), (-23, -197)], '#ffdca1')
        for bar in [-12, 8]:
            draw.line((x+bar*s, y-198*s, x+bar*s, y-167*s), fill='#47364a', width=max(1,int(s*4)))
    p([(-41, -203), (0, -230), (42, -203)], '#24213a')
    draw.line((x-42*s,y-161*s,x+43*s,y-161*s), fill='#211d39', width=max(2,int(s*7)))
    draw.line((x,y-228*s,x,y-244*s), fill='#201d36', width=max(1,int(s*3)))


def skyline(scene):
    rnd = Random(705 + scene)
    sunset = scene == 4
    img = gradient((24, 21, 49) if not sunset else (63, 48, 86), (141, 100, 137) if not sunset else (238, 140, 134))
    glow(img, (898, 253), 218, (254, 155, 130, 117))
    d = ImageDraw.Draw(img)
    for _ in range(56):
        x, y = rnd.randrange(W), rnd.randrange(200)
        d.point((x, y), fill='#c3acc5')
    moon = (925, 211) if scene == 1 else (978, 173)
    x, y = moon
    d.ellipse((x-36, y-36, x+36, y+36), fill='#f9cbb1' if sunset else '#f9d8bb')
    for i in range(8):
        cx, cy = rnd.randrange(-180, W), rnd.randrange(92, 315)
        size = rnd.randrange(200, 470)
        d.polygon([(cx,cy), (cx+size*.17,cy-14), (cx+size*.43,cy-12), (cx+size*.53,cy-23),
                   (cx+size*.73,cy-11), (cx+size,cy), (cx+size*.5,cy+8)], fill='#65506f')
    mountains(d, 390, '#595677' if not sunset else '#79546b', 3)
    mountains(d, 429, '#424465' if not sunset else '#53405f', 8)
    d.rectangle((0, 415, W, H), fill='#343755' if not sunset else '#513f60')
    for i in range(265):
        y = rnd.randrange(416, H)
        x = rnd.randrange(-120, W + 12)
        depth = (y-414) / 300
        around = abs(x - 920) < (48 + 190*depth)
        palette = ['#71627e','#8d6c85','#9c768a','#c58b97','#574b6e'] if around else ['#424165','#535071','#65607b','#4c496c']
        d.line((x, y, x+rnd.randint(12, 40) + int(depth*108), y), fill=rnd.choice(palette), width=rnd.choice([1, 2, 3]))
    if scene == 1:
        d.polygon([(0, 464), (151, 432), (259, 450), (399, 447), (633, 465), (726, 499),
                   (663, 526), (524, 545), (440, 578), (211, 599), (0, 636)], fill='#252842')
        d.polygon([(0, 534), (108, 501), (181, 519), (341, 497), (377, 505), (492, 494), (591, 514),
                   (386, 567), (385, 614), (0, 691)], fill='#1b1d34')
        for n in range(22):
            x = 12 + n*29
            y = rnd.randint(475, 537) - n*2
            w = rnd.randint(16, 49)
            h = rnd.randint(16, 41)
            color = rnd.choice(['#24223c','#323049','#43384f','#292742'])
            d.rectangle((x, y-h, x+w, y), fill=color)
            d.polygon([(x-3,y-h), (x+w/2,y-h-13), (x+w+4,y-h)], fill='#1c1c32')
            for wx in range(x+6,x+w-4,10):
                if rnd.random() > .23:
                    d.rectangle((wx,y-h+7,wx+3,y-h+12), fill=rnd.choice(['#ecaa76','#c08267','#a77677']))
        tower(d, 651, 475, .77)
        pier(d, 17, 571, 1.12)
        d.polygon([(0,H), (0,654), (139,628), (274,665), (478,H)], fill='#14172b')
        d.line((0,669,191,617,482,646),fill='#625069',width=3)
    else:
        d.polygon([(0,613), (117,592), (397,613), (646,556), (837,570), (1132,494),(W,499),(W,H),(0,H)], fill='#25233d')
        pier(d, 575, 562, .75)
        tower(d, 1042, 521, .83)
        d.polygon([(324,720),(566,720),(682,627),(883,566),(825,559),(609,592)],fill='#6f5272')
        d.line((330,716,612,592,825,560), fill='#df9981', width=2)
    return img


def letter():
    img = gradient((29, 28, 55), (66, 50, 75))
    glow(img, (684, 228), 257, (255, 170, 128, 115))
    d = ImageDraw.Draw(img)
    for x in range(-110, W, 182):
        d.line((x, 720, 550 + (x-550)*.31, 106), fill='#554159', width=3)
    for y in range(123, H, 77):
        d.line((0, y, W, y-14), fill='#342c46', width=5)
    d.polygon([(351, 246), (974, 221), (1031, 549), (435, 603)], fill='#251d33')
    d.polygon([(326, 210), (914, 176), (1001, 516), (411, 562)], fill='#d79882')
    d.polygon([(326, 210), (914, 176), (705, 400)], fill='#f0b69a')
    d.line((411,562,590,369,1001,516),fill='#ae706f',width=3)
    d.ellipse((662,354,733,410),fill='#964967')
    d.ellipse((670,361,725,401),outline='#d88998',width=2)
    d.polygon([(0,240),(141,241),(210,364),(339,407),(376,471),(342,544),(203,525),(125,468),(0,432)],fill='#29253d')
    d.line((14,252,122,276,182,389,326,443),fill='#826073',width=6)
    return img


def lighthouse():
    img = gradient((29, 25, 55), (150, 105, 133))
    glow(img, (557, 232), 294, (239, 164, 138, 100))
    d = ImageDraw.Draw(img)
    mountains(d, 435, '#56516c', 17)
    mountains(d, 496, '#3a3b5c', 93)
    draw_layer = Image.new('RGBA', (W, H))
    overlay = ImageDraw.Draw(draw_layer)
    overlay.polygon([(664,250),(0,111),(0,430),(664,275)],fill=(255,208,160,96))
    overlay.polygon([(658,256),(0,191),(0,347),(659,269)],fill=(255,218,176,67))
    img.paste(draw_layer, (0, 0), draw_layer)
    d = ImageDraw.Draw(img)
    d.polygon([(0,670),(208,580),(433,606),(537,520),(719,485),(886,512),(1012,480),(W,527),(W,H),(0,H)],fill='#28253e')
    d.polygon([(340,H),(463,643),(582,621),(664,559),(699,562),(614,646),(561,H)],fill='#8f6077')
    tower(d, 682, 578, 1.74)
    return img


for i, image in enumerate([skyline(1), letter(), lighthouse(), skyline(4)], 1):
    rnd = Random(i)
    dust = Image.effect_noise((W, H), 32).convert('RGB')
    image = Image.blend(image, dust, .08)
    edge = ImageDraw.Draw(image)
    for _ in range(360):
        x, y = rnd.randrange(W), rnd.randrange(H)
        color = image.getpixel((x, y))
        edge.point((x, y), fill=tuple(min(255,c+13) for c in color))
    image.save(OUTPUT / f'{i:02}.jpg', quality=92, optimize=True)
