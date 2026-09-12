#!/usr/bin/env python3
"""
MicroScan ML Pipeline — ml_pipeline.py

Hybrid ML architecture:
  Stage 1: Dish boundary detection (Hough circles — pure geometry)
  Stage 2: MobileSAM — two-pass prompted segmentation:
           Pass A: Coarse grid → find all disc pads by size/shape filtering
           Pass B: Per-disc → prompt inward from each pad to get zone mask
  Stage 3: GMM clustering — validate zone mask:
           Cluster ROI into 3 classes (disc_paper / clear_agar / bacteria_lawn)
           Use texture + intensity features; require strong clear-class occupancy
  Stage 4: Calibration & measurement output
"""

import cv2
import numpy as np
import json
import sys
import base64
import math
import os
import urllib.request

KNOWN_DISH_DIAMETER_MM = 100.0
KNOWN_DISC_DIAMETER_MM = 6.0
CHECKPOINT_DIR = os.path.join(os.path.dirname(__file__), "checkpoints")
MOBILE_SAM_CKPT = os.path.join(CHECKPOINT_DIR, "mobile_sam.pt")
MOBILE_SAM_URL = "https://github.com/ChaoningZhang/MobileSAM/raw/master/weights/mobile_sam.pt"


# ─── Image I/O ────────────────────────────────────────────────────────────────
def decode_image(source):
    if isinstance(source, str) and source.startswith("data:image"):
        _, data = source.split(",", 1)
        arr = np.frombuffer(base64.b64decode(data), np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    else:
        img = cv2.imread(source)
    return img

def encode_image(img, quality=88):
    _, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    return f"data:image/jpeg;base64,{base64.b64encode(buf).decode()}"


# ─── Stage 1: Dish Detection ──────────────────────────────────────────────────
def detect_dish(gray, w, h):
    blurred = cv2.GaussianBlur(gray, (15, 15), 3)
    min_dim = min(w, h)
    for params in [
        dict(dp=1, minDist=min_dim*0.6, param1=60, param2=35,
             minRadius=int(min_dim*0.28), maxRadius=int(min_dim*0.55)),
        dict(dp=1.2, minDist=min_dim*0.5, param1=40, param2=25,
             minRadius=int(min_dim*0.22), maxRadius=int(min_dim*0.58)),
    ]:
        c = cv2.HoughCircles(blurred, cv2.HOUGH_GRADIENT, **params)
        if c is not None:
            c = np.round(c[0]).astype(int)
            best = c[np.argmax(c[:, 2])]
            return int(best[0]), int(best[1]), int(best[2])
    return w//2, h//2, int(min_dim*0.42)


# ─── Stage 2a: SAM disc pad detection ────────────────────────────────────────
def ensure_checkpoint():
    os.makedirs(CHECKPOINT_DIR, exist_ok=True)
    if not os.path.exists(MOBILE_SAM_CKPT):
        print("[ML] Downloading MobileSAM checkpoint...", file=sys.stderr)
        urllib.request.urlretrieve(MOBILE_SAM_URL, MOBILE_SAM_CKPT)

def load_sam_predictor():
    ensure_checkpoint()
    try:
        from mobile_sam import sam_model_registry, SamPredictor
        import torch
        sam = sam_model_registry["vit_t"](checkpoint=MOBILE_SAM_CKPT)
        sam.eval()
        predictor = SamPredictor(sam)
        return predictor
    except Exception as e:
        print(f"[ML] SAM load failed: {e}", file=sys.stderr)
        return None


def sam_find_discs(predictor, gray_img, img_rgb, dish_cx, dish_cy, dish_r, expected_r):
    """
    Find antibiotic disc pads using a dense grid + SAM segmentation.
    Uses a finer grid (step = ~8% of dish radius) to catch all 8+2 nodes.
    Filters masks by:
      - Expected disc area (±70%)
      - Circularity > 0.20 (to allow thick spokes)
    """
    expected_area = math.pi * (expected_r ** 2)
    predictor.set_image(img_rgb)

    grid_pts = []
    step = max(int(dish_r * 0.08), 15)
    for y in range(int(dish_cy - dish_r * 0.92), int(dish_cy + dish_r * 0.92), step):
        for x in range(int(dish_cx - dish_r * 0.92), int(dish_cx + dish_r * 0.92), step):
            if math.hypot(x - dish_cx, y - dish_cy) < dish_r * 0.90:
                grid_pts.append([x, y])

    disc_centers = []
    disc_masks_raw = []

    for pt in grid_pts:
        masks, scores, _ = predictor.predict(
            point_coords=np.array([pt]),
            point_labels=np.array([1]),
            multimask_output=True,
        )
        for mask, score in zip(masks, scores):
            if score < 0.70:
                continue
            area = float(mask.sum())
            if not (expected_area * 0.25 < area < expected_area * 3.8):
                continue

            mask_u8 = mask.astype(np.uint8) * 255
            cnts, _ = cv2.findContours(mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not cnts:
                continue
            cnt = max(cnts, key=cv2.contourArea)
            perim = cv2.arcLength(cnt, True)
            if perim == 0:
                continue
            circ = 4 * math.pi * (cv2.contourArea(cnt) / (perim ** 2))
            
            # Very relaxed circularity because SAM merges the node with its spoke
            if circ < 0.20:
                continue

            ys_m, xs_m = np.where(mask)
            cx, cy_m = int(xs_m.mean()), int(ys_m.mean())

            if math.hypot(cx - dish_cx, cy_m - dish_cy) > dish_r * 0.94:
                continue

            # NMS — avoid merging close nodes
            if any(math.hypot(cx - ex, cy_m - ey) < expected_r * 1.5 for ex, ey in disc_centers):
                continue

            disc_centers.append((cx, cy_m))
            disc_masks_raw.append(mask)

    # Filter out inner printed ring (dead zone 38-54% of radius)
    final_centers, final_masks = [], []
    for (cx, cy), msk in zip(disc_centers, disc_masks_raw):
        dist = math.hypot(cx - dish_cx, cy - dish_cy)
        if not (dish_r * 0.38 < dist < dish_r * 0.54):
            final_centers.append((cx, cy))
            final_masks.append(msk)

    return final_centers, final_masks


# ─── Stage 2b: SAM zone detection ─────────────────────────────────────────────
def sam_find_zone(predictor, img_rgb, disc_cx, disc_cy, disc_r, dish_cx, dish_cy, dish_r):
    """
    Prompt SAM to find the inhibition zone around a specific disc.

    For INNER discs (close to dish center): the zone may cover the entire inner area —
    we use a wider background ring at 5.5x disc radius.

    For OUTER discs (on the Octodisc ring): zone is bounded by adjacent bacteria —
    we use tighter background ring at 4.0x disc radius.
    """
    h_img, w_img = img_rgb.shape[:2]
    dist_to_center = math.hypot(disc_cx - dish_cx, disc_cy - dish_cy)
    is_inner = dist_to_center < dish_r * 0.35

    fg_pts = [[disc_cx, disc_cy]]
    fg_ring_r = disc_r * 1.5
    for angle in np.linspace(0, 2*math.pi, 6, endpoint=False):
        px = int(disc_cx + math.cos(angle) * fg_ring_r)
        py = int(disc_cy + math.sin(angle) * fg_ring_r)
        if 0 <= px < w_img and 0 <= py < h_img:
            fg_pts.append([px, py])

    # Inner discs: push background far out; outer discs: tighter bg
    bg_ring_r = disc_r * (5.5 if is_inner else 4.0)
    bg_pts = []
    for angle in np.linspace(0, 2*math.pi, 8, endpoint=False):
        px = int(disc_cx + math.cos(angle) * bg_ring_r)
        py = int(disc_cy + math.sin(angle) * bg_ring_r)
        if 0 <= px < w_img and 0 <= py < h_img:
            bg_pts.append([px, py])

    all_pts = fg_pts + bg_pts
    all_lbl = [1]*len(fg_pts) + [0]*len(bg_pts)

    masks, scores, _ = predictor.predict(
        point_coords=np.array(all_pts),
        point_labels=np.array(all_lbl),
        multimask_output=True,
    )

    disc_area  = math.pi * (disc_r**2)
    # Inner discs can have zones up to 50% of dish; outer capped at 40%
    max_zone_r = dish_r * (0.50 if is_inner else 0.40)

    best_mask, best_score = None, -1.0
    best_r = 0.0

    for mask, score in zip(masks, scores):
        area = float(mask.sum())
        if area <= disc_area * 1.4:
            continue
        ys_m, xs_m = np.where(mask)
        if len(xs_m) == 0:
            continue
        dists = np.sqrt((xs_m - disc_cx)**2 + (ys_m - disc_cy)**2)
        r_est = float(np.percentile(dists, 85))

        if r_est > max_zone_r:
            continue

        if best_mask is None or (score > best_score - 0.05 and r_est < best_r):
            best_mask = mask
            best_score = float(score)
            best_r = r_est

    return best_mask, best_score, is_inner



# ─── Stage 3: GMM Validation ──────────────────────────────────────────────────
def gmm_validate_zone(img_rgb, candidate_mask, disc_cx, disc_cy, disc_r, relax=False):
    """
    Validate the candidate zone using a 3-component GMM.

    Key insight: In transmitted-light Petri dish images, the clear inhibition zone
    can be EITHER lighter OR darker than the bacterial lawn depending on the light
    source angle. So we cannot sort components by intensity alone.

    Instead we use TEXTURE as the primary discriminator:
    - Bacterial lawn: HIGH texture (dense colonies = rough surface)
    - Clear agar zone: LOW texture (transparent agar = smooth)
    - Disc paper: VERY HIGH texture OR very bright (white paper)

    A genuine zone is genuine if:
    1. The low-texture GMM component occupies >22% of the annular region
    2. Those low-texture pixels are spatially compact near the disc center
       (printed labels are far from disc center, zones are near it)
    """
    from sklearn.mixture import GaussianMixture

    h, w = img_rgb.shape[:2]
    gray = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)

    roi_r = int(disc_r * 6)
    x1, y1 = max(0, disc_cx - roi_r), max(0, disc_cy - roi_r)
    x2, y2 = min(w, disc_cx + roi_r), min(h, disc_cy + roi_r)

    roi = gray[y1:y2, x1:x2]
    if roi.size == 0:
        return False, None, 0.0

    # Texture = absolute diff from Gaussian blur (captures colony roughness)
    blur    = cv2.GaussianBlur(roi, (9, 9), 2)
    texture = np.abs(roi.astype(np.float32) - blur.astype(np.float32))

    # Distance from disc centre (normalized by disc_r) as 3rd feature
    yy, xx = np.mgrid[y1:y2, x1:x2]
    dist_feat = np.sqrt((xx - disc_cx)**2 + (yy - disc_cy)**2).astype(np.float32) / (disc_r * 5.0)
    dist_feat = dist_feat[:roi.shape[0], :roi.shape[1]]

    pix_feat = np.column_stack([
        roi.ravel() / 255.0,
        texture.ravel() / 50.0,   # normalize texture
        dist_feat.ravel(),
    ])

    gmm = GaussianMixture(n_components=3, covariance_type='full', max_iter=200, random_state=42)
    try:
        gmm.fit(pix_feat)
        labels_flat = gmm.predict(pix_feat)
        labels_2d   = labels_flat.reshape(roi.shape)
    except Exception:
        return False, None, 0.0

    # Sort components by TEXTURE mean (ascending) — clear agar = smoothest = lowest texture
    texture_means = gmm.means_[:, 1]  # texture column
    order        = np.argsort(texture_means)
    clear_lbl    = int(order[0])   # smoothest = clear agar
    # bacteria = middle or highest texture; disc paper = often brightest or farthest
    bacteria_lbl = int(order[2])   # roughest = bacteria

    # Build annular evaluation region (1.2R to 5R from disc center)
    local_cx = disc_cx - x1
    local_cy = disc_cy - y1
    annular  = np.zeros(roi.shape, dtype=np.uint8)
    cv2.circle(annular, (local_cx, local_cy), int(disc_r * 5.0), 255, -1)
    cv2.circle(annular, (local_cx, local_cy), int(disc_r * 1.2), 0,   -1)

    # Build candidate mask in ROI coords
    if candidate_mask is not None:
        cand_roi = candidate_mask[y1:y2, x1:x2].astype(np.uint8) * 255
    else:
        cand_roi = annular.copy()

    eval_region = cv2.bitwise_and(cand_roi, annular)

    # Clear agar pixels within eval region
    clear_map      = (labels_2d == clear_lbl).astype(np.uint8) * 255
    clear_in_annul = cv2.bitwise_and(clear_map, eval_region)

    eval_area  = max(1.0, float(eval_region.sum() / 255))
    clear_area = float(clear_in_annul.sum() / 255)
    clear_ratio = clear_area / eval_area

    # Spatial compactness check:
    # A genuine zone's clear pixels must be concentrated near the disc.
    # Printed labels far from center will have high mean distance.
    clear_ys, clear_xs = np.where(clear_in_annul > 0)
    if len(clear_xs) > 10:
        mean_dist_to_disc = float(np.mean(
            np.sqrt((clear_xs + x1 - disc_cx)**2 + (clear_ys + y1 - disc_cy)**2)
        ))
        # Genuine zones are within 3.5× disc_r; labels are further
        spatially_close = mean_dist_to_disc < disc_r * 3.5
    else:
        spatially_close = False

    # Texture check: clear component must be smoother than bacteria component
    t_clear = float(texture[labels_2d == clear_lbl].mean()) if (labels_2d == clear_lbl).any() else 99
    t_bact  = float(texture[labels_2d == bacteria_lbl].mean()) if (labels_2d == bacteria_lbl).any() else 0
    texture_ok = t_clear < t_bact * 1.3

    is_genuine = (clear_ratio > (0.12 if relax else 0.22)) and texture_ok and spatially_close
    confidence = min(0.97, clear_ratio * 2.5) if is_genuine else clear_ratio * 0.4

    refined = np.zeros((h, w), dtype=np.uint8)
    refined[y1:y2, x1:x2] = clear_in_annul

    return is_genuine, refined, confidence



# ─── Stage 4: Radius from mask ────────────────────────────────────────────────
def radius_from_mask(mask, disc_cx, disc_cy):
    ys, xs = np.where(mask > 0)
    if len(xs) == 0:
        return 0.0
    dists = np.sqrt((xs - disc_cx)**2 + (ys - disc_cy)**2)
    return float(np.percentile(dists, 85))


# ─── Fallback: Hough disc detection ──────────────────────────────────────────
def _hough_disc_fallback(gray, dish_cx, dish_cy, dish_r, expected_r):
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8,8))
    enhanced = clahe.apply(gray)
    blurred = cv2.GaussianBlur(enhanced, (9, 9), 2)
    circles = cv2.HoughCircles(blurred, cv2.HOUGH_GRADIENT, 1, int(dish_r * 0.12),
                               param1=45, param2=24,
                               minRadius=int(expected_r * 0.5), maxRadius=int(expected_r * 1.8))
    centers = []
    if circles is not None:
        for cx, cy, r in np.round(circles[0]).astype(int):
            if math.hypot(cx - dish_cx, cy - dish_cy) < dish_r * 0.98:
                if not any(math.hypot(cx - ex, cy - ey) < expected_r * 2.0 for ex, ey in centers):
                    centers.append((int(cx), int(cy)))
    return centers, [None]*len(centers)


# ─── Main Pipeline ─────────────────────────────────────────────────────────────
def measure_plate(source, dish_diameter_mm=KNOWN_DISH_DIAMETER_MM, measurement_mode="full_zone_diameter"):
    import time
    t0 = time.time()

    img_bgr = decode_image(source)
    if img_bgr is None:
        return {"ok": False, "error": "Could not load image."}

    h, w = img_bgr.shape[:2]
    img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    gray    = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)

    # Stage 1
    dish_cx, dish_cy, dish_r = detect_dish(gray, w, h)
    pixels_per_mm  = (dish_r * 2.0) / dish_diameter_mm
    expected_disc_r = int((KNOWN_DISC_DIAMETER_MM / 2.0) * pixels_per_mm)

    # Stage 2a — Load SAM + find pads
    predictor = load_sam_predictor()
    use_sam   = predictor is not None

    if use_sam:
        disc_centers, disc_masks_raw = sam_find_discs(
            predictor, gray, img_rgb, dish_cx, dish_cy, dish_r, expected_disc_r)
    else:
        disc_centers, disc_masks_raw = _hough_disc_fallback(
            gray, dish_cx, dish_cy, dish_r, expected_disc_r)

    results = []

    for i, (dc_x, dc_y) in enumerate(disc_centers):
        # Stage 2b — SAM zone
        if use_sam:
            zone_mask, sam_score, is_inner = sam_find_zone(
                predictor, img_rgb, dc_x, dc_y, expected_disc_r,
                dish_cx, dish_cy, dish_r)
        else:
            zone_mask, sam_score, is_inner = None, 0.0, False

        # Stage 3 — GMM validation
        # For inner discs, relax the GMM threshold since the zone covers the whole interior
        is_genuine, refined_mask, gmm_conf = gmm_validate_zone(
            img_rgb, zone_mask, dc_x, dc_y, expected_disc_r,
            relax=(is_inner if use_sam else False))

        if not is_genuine:
            zone_r_px    = expected_disc_r
            measured_mm  = KNOWN_DISC_DIAMETER_MM  # 6mm — disc size, no zone
            confidence   = max(0.80, 1.0 - gmm_conf)
            is_resistant = True
        else:
            use_mask   = refined_mask if refined_mask is not None else zone_mask
            zone_r_px  = radius_from_mask(use_mask, dc_x, dc_y) if use_mask is not None else expected_disc_r

            # Sanity bounds
            if zone_r_px < expected_disc_r * 1.3:
                zone_r_px    = expected_disc_r
                measured_mm  = KNOWN_DISC_DIAMETER_MM  # 6mm
                confidence   = 0.88
                is_resistant = True
            else:
                max_r = dish_r * (0.52 if is_inner else 0.42)
                zone_r_px    = min(zone_r_px, max_r)
                measured_mm  = (zone_r_px * 2.0) / pixels_per_mm
                confidence   = min(0.97, (gmm_conf + sam_score) / 2.0)
                is_resistant = False


        results.append({
            "id": i + 1,
            "antibiotic": "UNKNOWN",
            "centerX": int(dc_x),
            "centerY": int(dc_y),
            "discRadiusPx": int(expected_disc_r),
            "discDiameterMm": round(KNOWN_DISC_DIAMETER_MM, 1),
            "zoneRadiusPx": round(zone_r_px, 1),
            "zoneDiameterPx": round(zone_r_px * 2.0, 1),
            "zoneRadiusMm": round(measured_mm / 2.0, 1),
            "zoneDiameterMm": round(measured_mm, 1),
            "resistant": is_resistant,
            "confidence": round(confidence, 3),
            "reviewRequired": confidence < 0.70,
            "manuallyCorrected": False,
            "detectionMethod": "mobilesam_gmm_hybrid",
            "samScore": round(float(sam_score), 3),
            "gmmConf": round(float(gmm_conf), 3),
        })

    return {
        "ok": True,
        "plate": {"centerX": dish_cx, "centerY": dish_cy, "radiusPx": dish_r, "diameterMm": dish_diameter_mm},
        "calibration": {"method": "known_dish_diameter", "knownDiameterMm": dish_diameter_mm, "pixelsPerMm": round(pixels_per_mm, 3)},
        "measurementMode": measurement_mode,
        "discs": results,
        "durationMs": int((time.time() - t0) * 1000),
        "imageWidth": w, "imageHeight": h,
        "source": "mobilesam_gmm_hybrid",
        "valid": all(not d["reviewRequired"] for d in results),
    }


def generate_overlay_image(source, result):
    img = decode_image(source)
    if img is None or not result.get("ok"):
        return None
    plate = result["plate"]
    cv2.circle(img, (plate["centerX"], plate["centerY"]), plate["radiusPx"], (0, 220, 120), 2)
    for disc in result["discs"]:
        cx, cy = disc["centerX"], disc["centerY"]
        dr  = disc["discRadiusPx"]
        zr  = int(disc["zoneRadiusPx"])
        is_resistant = disc.get("resistant", disc["zoneDiameterMm"] <= KNOWN_DISC_DIAMETER_MM)
        conf    = disc["confidence"]
        # Blue = resistant (6mm = disc only), Green = genuine zone, Amber = low-confidence zone
        zone_color = (60, 60, 220) if is_resistant else ((80, 240, 130) if conf >= 0.80 else (80, 200, 240))
        if zr > dr and not is_resistant:
            cv2.circle(img, (cx, cy), zr, zone_color, 2)
        cv2.circle(img, (cx, cy), dr, (255, 255, 255), 1)
        cv2.circle(img, (cx, cy), 3, (255, 255, 255), -1)
        # Label: show actual mm value (6mm for resistant, >6mm for zones)
        lbl = f"{disc['zoneDiameterMm']}mm {'(R)' if is_resistant else ''}"
        fscale = max(0.35, min(0.55, img.shape[1] / 1800))
        ty = max(20, cy - max(zr, dr) - 8)
        cv2.putText(img, lbl, (cx - 20, ty), cv2.FONT_HERSHEY_SIMPLEX, fscale, zone_color, 1, cv2.LINE_AA)
    return encode_image(img)


if __name__ == "__main__":
    if len(sys.argv) >= 2 and not sys.argv[1].startswith("{"):
        res = measure_plate(sys.argv[1], measurement_mode=sys.argv[2] if len(sys.argv) > 2 else "full_zone_diameter")
        ov = generate_overlay_image(sys.argv[1], res)
        if ov: res["overlayImage"] = ov
        print(json.dumps(res, ensure_ascii=False))
    else:
        raw = sys.stdin.read().strip()
        if not raw: sys.exit(1)
        payload = json.loads(raw)
        img_src = payload.get("imageBase64") or payload.get("imagePath", "")
        res = measure_plate(img_src, measurement_mode=payload.get("measurementMode", "full_zone_diameter"))
        ov = generate_overlay_image(img_src, res)
        if ov: res["overlayImage"] = ov
        print(json.dumps(res, ensure_ascii=False))
