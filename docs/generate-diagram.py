from PIL import Image, ImageDraw, ImageFont

W, H = 1400, 950
img = Image.new('RGB', (W, H), '#FFFFFF')
draw = ImageDraw.Draw(img)

try:
    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 16)
    font_sm = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 13)
    font_title = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 22)
    font_label = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 11)
except:
    font = ImageFont.load_default()
    font_sm = font
    font_title = font
    font_label = font

BLUE = '#232F3E'
ORANGE = '#FF9900'
LIGHT_BLUE = '#EBF5FF'
LIGHT_GREEN = '#EBF8EB'
DARK_BLUE = '#1A5C9E'
PURPLE = '#6B48C7'
RED_CACHE = '#C7131A'
GREEN_DDB = '#3B7D3C'

def box(x, y, w, h, fill, outline, text, subtitle=None):
    draw.rounded_rectangle([x, y, x+w, y+h], radius=6, fill=fill, outline=outline, width=1)
    tw = draw.textlength(text, font=font_sm)
    draw.text((x + (w - tw)//2, y + 6), text, fill='white', font=font_sm)
    if subtitle:
        sw = draw.textlength(subtitle, font=font_label)
        draw.text((x + (w - sw)//2, y + 24), subtitle, fill='#DDDDDD', font=font_label)

def arrow_down(x, y1, y2, color='#444', width=2, label=None, label_side='right'):
    draw.line([(x, y1), (x, y2)], fill=color, width=width)
    draw.polygon([(x-5, y2-8), (x+5, y2-8), (x, y2)], fill=color)
    if label:
        lx = x + 8 if label_side == 'right' else x - draw.textlength(label, font=font_label) - 8
        draw.text((lx, (y1+y2)//2 - 6), label, fill='#666', font=font_label)

def arrow_line(x1, y1, x2, y2, color='#444', width=2):
    draw.line([(x1, y1), (x2, y2)], fill=color, width=width)

# Layout
DDB_TOP = 470
DDB_BOT = 545
PROJ_TOP = 615
PROJ_BOT = 647
REDIS_TOP = 725
REDIS_BOT = 767

# Title
draw.text((W//2 - 280, 15), "Multi-Region Active-Active Architecture", fill=BLUE, font=font_title)
draw.text((W//2 - 150, 45), "CQRS / Event Sourcing - Loan Originations", fill='#666', font=font_sm)

# Route53
box(560, 80, 280, 32, ORANGE, '#CC7A00', 'Route53 Latency-Based Routing')

# Region boxes
draw.rounded_rectangle([50, 145, 650, 840], radius=12, fill=LIGHT_BLUE, outline='#1565C0', width=2)
draw.text((260, 152), "us-east-1 (Primary)", fill='#1565C0', font=font)
draw.rounded_rectangle([750, 145, 1350, 840], radius=12, fill=LIGHT_GREEN, outline='#2E7D32', width=2)
draw.text((955, 152), "us-west-2 (Secondary)", fill='#2E7D32', font=font)

# Route53 arrows
arrow_line(640, 112, 350, 190, '#333')
arrow_line(760, 112, 1050, 190, '#333')

# ===== DynamoDB boxes (NARROW - only under Command Lambda) =====
# us-east-1 DDB: right side only (under Command Lambda at x=380-550)
DDB1_X = 350
DDB1_W = 230
draw.rounded_rectangle([DDB1_X, DDB_TOP, DDB1_X+DDB1_W, DDB_BOT], radius=10, fill=GREEN_DDB, outline='#1B5E20', width=2)
draw.text((DDB1_X+20, DDB_TOP+12), "DynamoDB (Events)", fill='white', font=font_sm)
draw.text((DDB1_X+10, DDB_TOP+35), "PK: aggregateId | SK: version", fill='#C8E6C9', font=font_label)
draw.text((DDB1_X+40, DDB_TOP+52), "Streams enabled", fill='#A5D6A7', font=font_label)

# us-west-2 DDB: left side only (under Command Lambda at x=800-970)
DDB2_X = 820
DDB2_W = 230
draw.rounded_rectangle([DDB2_X, DDB_TOP, DDB2_X+DDB2_W, DDB_BOT], radius=10, fill=GREEN_DDB, outline='#1B5E20', width=2)
draw.text((DDB2_X+20, DDB_TOP+12), "DynamoDB (Events)", fill='white', font=font_sm)
draw.text((DDB2_X+10, DDB_TOP+35), "PK: aggregateId | SK: version", fill='#C8E6C9', font=font_label)
draw.text((DDB2_X+40, DDB_TOP+52), "Streams enabled", fill='#A5D6A7', font=font_label)

# Global Tables connector
draw.line([(DDB1_X+DDB1_W, DDB_TOP+38), (DDB2_X, DDB_TOP+38)], fill='#1B5E20', width=2)
draw.text((640, DDB_TOP+15), "Global Tables", fill='#1B5E20', font=font_sm)
draw.text((640, DDB_TOP+35), "bi-directional", fill='#4CAF50', font=font_label)
draw.text((650, DDB_TOP+50), "replication", fill='#4CAF50', font=font_label)
draw.polygon([(DDB1_X+DDB1_W, DDB_TOP+33), (DDB1_X+DDB1_W, DDB_TOP+43), (DDB1_X+DDB1_W+8, DDB_TOP+38)], fill='#1B5E20')
draw.polygon([(DDB2_X, DDB_TOP+33), (DDB2_X, DDB_TOP+43), (DDB2_X-8, DDB_TOP+38)], fill='#1B5E20')

# ======== us-east-1 ========
box(200, 190, 250, 30, '#D13212', '#A01015', 'AWS WAF v2')
arrow_down(325, 220, 248)
box(200, 248, 250, 30, PURPLE, '#4B2D9E', 'API Gateway (REST)')

# Query Lambda LEFT (outer), Command Lambda RIGHT (inner)
QRY1_X, QRY1_Y, QRY1_W, QRY1_H = 80, 320, 170, 32
CMD1_X, CMD1_Y, CMD1_W, CMD1_H = 380, 320, 170, 32

arrow_line(280, 278, QRY1_X + QRY1_W//2, QRY1_Y, '#333')
arrow_line(370, 278, CMD1_X + CMD1_W//2, CMD1_Y, '#333')

box(QRY1_X, QRY1_Y, QRY1_W, QRY1_H, ORANGE, '#CC7A00', 'Query Lambda')
box(CMD1_X, CMD1_Y, CMD1_W, CMD1_H, ORANGE, '#CC7A00', 'Command Lambda')

# Command -> DynamoDB
CMD1_CX = CMD1_X + CMD1_W // 2
arrow_down(CMD1_CX, CMD1_Y + CMD1_H, DDB_TOP, DARK_BLUE, label="write event")

# Kinesis — BELOW the Command Lambda, offset left so it doesn't overlap the arrow
box(80, 385, 150, 26, DARK_BLUE, '#13476B', 'Kinesis (2 shards)')
arrow_line(CMD1_X + 20, CMD1_Y + CMD1_H, 155, 385, DARK_BLUE, 1)

# Query -> Redis (outer column, clear of DDB)
QRY1_CX = QRY1_X + QRY1_W // 2
arrow_down(QRY1_CX, QRY1_Y + QRY1_H, REDIS_TOP, RED_CACHE, label="reads Redis", label_side='left')

# DDB -> Projector
PROJ1_CX = DDB1_X + DDB1_W // 2
box(PROJ1_CX - 85, PROJ_TOP, 170, PROJ_BOT - PROJ_TOP, ORANGE, '#CC7A00', 'Projector Lambda')
arrow_down(PROJ1_CX, DDB_BOT, PROJ_TOP, '#555', label="DDB Streams")

# Projector -> Redis
arrow_down(PROJ1_CX, PROJ_BOT, REDIS_TOP, RED_CACHE, label="updates")

# Redis
box(70, REDIS_TOP, 520, REDIS_BOT - REDIS_TOP, RED_CACHE, '#A01015', 'ElastiCache Redis', subtitle='Multi-AZ (1P + 2R)')

# ======== us-west-2 ========
box(900, 190, 250, 30, '#D13212', '#A01015', 'AWS WAF v2')
arrow_down(1025, 220, 248)
box(900, 248, 250, 30, PURPLE, '#4B2D9E', 'API Gateway (REST)')

# Command Lambda LEFT (inner), Query Lambda RIGHT (outer)
CMD2_X, CMD2_Y, CMD2_W, CMD2_H = 800, 320, 170, 32
QRY2_X, QRY2_Y, QRY2_W, QRY2_H = 1150, 320, 170, 32

arrow_line(980, 278, CMD2_X + CMD2_W//2, CMD2_Y, '#333')
arrow_line(1070, 278, QRY2_X + QRY2_W//2, QRY2_Y, '#333')

box(CMD2_X, CMD2_Y, CMD2_W, CMD2_H, ORANGE, '#CC7A00', 'Command Lambda')
box(QRY2_X, QRY2_Y, QRY2_W, QRY2_H, ORANGE, '#CC7A00', 'Query Lambda')

# Command -> DynamoDB
CMD2_CX = CMD2_X + CMD2_W // 2
arrow_down(CMD2_CX, CMD2_Y + CMD2_H, DDB_TOP, DARK_BLUE, label="write event", label_side='left')

# Kinesis — offset right
box(1170, 385, 150, 26, DARK_BLUE, '#13476B', 'Kinesis (2 shards)')
arrow_line(CMD2_X + CMD2_W - 20, CMD2_Y + CMD2_H, 1245, 385, DARK_BLUE, 1)

# Query -> Redis (outer)
QRY2_CX = QRY2_X + QRY2_W // 2
arrow_down(QRY2_CX, QRY2_Y + QRY2_H, REDIS_TOP, RED_CACHE, label="reads Redis")

# DDB -> Projector
PROJ2_CX = DDB2_X + DDB2_W // 2
box(PROJ2_CX - 85, PROJ_TOP, 170, PROJ_BOT - PROJ_TOP, ORANGE, '#CC7A00', 'Projector Lambda')
arrow_down(PROJ2_CX, DDB_BOT, PROJ_TOP, '#555', label="DDB Streams")

# Projector -> Redis
arrow_down(PROJ2_CX, PROJ_BOT, REDIS_TOP, RED_CACHE, label="updates")

# Redis
box(810, REDIS_TOP, 520, REDIS_BOT - REDIS_TOP, RED_CACHE, '#A01015', 'ElastiCache Redis', subtitle='Multi-AZ (1P + 2R)')

# Legend
LY = 880
draw.text((80, LY), "Legend:", fill=BLUE, font=font)
draw.rounded_rectangle([160, LY-2, 200, LY+15], radius=3, fill=ORANGE)
draw.text((210, LY), "Lambda", fill='#333', font=font_sm)
draw.rounded_rectangle([310, LY-2, 350, LY+15], radius=3, fill=DARK_BLUE)
draw.text((360, LY), "Stream", fill='#333', font=font_sm)
draw.rounded_rectangle([440, LY-2, 480, LY+15], radius=3, fill=RED_CACHE)
draw.text((490, LY), "Read Model", fill='#333', font=font_sm)
draw.rounded_rectangle([620, LY-2, 660, LY+15], radius=3, fill=GREEN_DDB)
draw.text((670, LY), "Event Store", fill='#333', font=font_sm)
draw.rounded_rectangle([800, LY-2, 840, LY+15], radius=3, fill=PURPLE)
draw.text((850, LY), "API", fill='#333', font=font_sm)
draw.rounded_rectangle([910, LY-2, 950, LY+15], radius=3, fill='#D13212')
draw.text((960, LY), "WAF", fill='#333', font=font_sm)

draw.text((80, LY+28), "CQRS: Command writes to DynamoDB (inner). Query reads from Redis (outer). Projector bridges DDB Streams to Redis.", fill='#555', font=font_label)

img.save('/Users/epatro/github/axon-poc/docs/architecture-diagram.jpg', 'JPEG', quality=95)
print("Done")
