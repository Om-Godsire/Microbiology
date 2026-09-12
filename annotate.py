import cv2
import os
import glob

# Paths
IMG_DIR = "e:/Microbiology/data/yolo_dataset/images/train"
LBL_DIR = "e:/Microbiology/data/yolo_dataset/labels/train"
os.makedirs(IMG_DIR, exist_ok=True)
os.makedirs(LBL_DIR, exist_ok=True)

# Classes: 0 = node, 1 = zone
CLASSES = {ord('n'): 0, ord('z'): 1}
CLASS_NAMES = {0: "Node", 1: "Zone"}
COLORS = {0: (0, 0, 255), 1: (0, 255, 0)} # Red for node, Green for zone

drawing = False
ix, iy = -1, -1
current_img = None
temp_img = None
boxes = [] # (class_id, x_min, y_min, x_max, y_max)

def draw_rect(event, x, y, flags, param):
    global ix, iy, drawing, current_img, temp_img
    
    if event == cv2.EVENT_LBUTTONDOWN:
        drawing = True
        ix, iy = x, y

    elif event == cv2.EVENT_MOUSEMOVE:
        if drawing:
            temp_img = current_img.copy()
            cv2.rectangle(temp_img, (ix, iy), (x, y), (255, 255, 255), 1)
            cv2.imshow('Annotator', temp_img)

    elif event == cv2.EVENT_LBUTTONUP:
        drawing = False
        cv2.rectangle(current_img, (ix, iy), (x, y), (255, 255, 255), 2)
        cv2.imshow('Annotator', current_img)
        
        print("\nBox drawn! Press 'n' for Node, 'z' for Zone, 'c' to cancel box.")
        key = cv2.waitKey(0) & 0xFF
        
        if key in CLASSES:
            class_id = CLASSES[key]
            x_min, y_min = min(ix, x), min(iy, y)
            x_max, y_max = max(ix, x), max(iy, y)
            boxes.append((class_id, x_min, y_min, x_max, y_max))
            print(f"Added {CLASS_NAMES[class_id]}")
        else:
            print("Box cancelled.")
        redraw_boxes()

def redraw_boxes():
    global current_img, clean_img
    current_img = clean_img.copy()
    for class_id, x_min, y_min, x_max, y_max in boxes:
        color = COLORS[class_id]
        cv2.rectangle(current_img, (x_min, y_min), (x_max, y_max), color, 2)
        cv2.putText(current_img, CLASS_NAMES[class_id], (x_min, y_min - 5), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
    cv2.imshow('Annotator', current_img)

def save_yolo(img_path, h, w):
    base = os.path.basename(img_path)
    name = os.path.splitext(base)[0]
    lbl_path = os.path.join(LBL_DIR, f"{name}.txt")
    
    with open(lbl_path, "w") as f:
        for class_id, x_min, y_min, x_max, y_max in boxes:
            # YOLO format: class x_center y_center width height (normalized 0-1)
            xc = ((x_min + x_max) / 2.0) / w
            yc = ((y_min + y_max) / 2.0) / h
            bw = (x_max - x_min) / float(w)
            bh = (y_max - y_min) / float(h)
            f.write(f"{class_id} {xc:.6f} {yc:.6f} {bw:.6f} {bh:.6f}\n")
    print(f"Saved {len(boxes)} labels to {lbl_path}")

images = glob.glob(os.path.join(IMG_DIR, "*.jpg")) + glob.glob(os.path.join(IMG_DIR, "*.jpeg")) + glob.glob(os.path.join(IMG_DIR, "*.png"))

if not images:
    print(f"No images found in {IMG_DIR}!")
    print("Please copy some raw petri dish images into that folder first.")
    exit()

cv2.namedWindow('Annotator')
cv2.setMouseCallback('Annotator', draw_rect)

for img_path in images:
    # Check if already labeled
    base = os.path.basename(img_path)
    lbl_path = os.path.join(LBL_DIR, f"{os.path.splitext(base)[0]}.txt")
    if os.path.exists(lbl_path):
        print(f"Skipping {base} (already labeled)")
        continue

    print(f"\n--- Annotating {base} ---")
    print("- Click and drag to draw a box")
    print("- Then press 'n' for Node, 'z' for Zone")
    print("- Press 'c' to clear all boxes on current image")
    print("- Press 'Space' to save and go to next image")
    print("- Press 'q' to quit")
    
    clean_img = cv2.imread(img_path)
    # Resize for display if too big
    h, w = clean_img.shape[:2]
    if h > 900:
        scale = 900 / h
        clean_img = cv2.resize(clean_img, (int(w * scale), 900))
    
    h, w = clean_img.shape[:2]
    current_img = clean_img.copy()
    boxes = []
    
    redraw_boxes()
    
    while True:
        key = cv2.waitKey(1) & 0xFF
        if key == ord(' '):  # Next image
            if boxes:
                save_yolo(img_path, h, w)
            else:
                print("Skipped image (no boxes)")
            break
        elif key == ord('c'):  # Clear
            boxes = []
            redraw_boxes()
            print("Cleared boxes")
        elif key == ord('q'):  # Quit
            print("Quitting annotation tool.")
            cv2.destroyAllWindows()
            exit()

cv2.destroyAllWindows()
print("\nAll done!")
