"""
Kitob Skaner — kamera orqali kitob sahifalarini nusxalab, PDF qilib beruvchi dastur.

Ishlash tartibi:
  1. Kamerada kitob sahifasini ko'rsating (yashil ramka sahifani topganini bildiradi).
  2. "Nusxa olish" (yoki Probel) tugmasini bosing — yoki "Avto-olish" yoqilgan bo'lsa,
     sahifa qimirlamay turganda dastur o'zi suratga oladi.
  3. Sahifa kesilib, tekislanib, tozalanib ko'rsatiladi. Tagida:
       "Keyingi sahifa"  — sahifani saqlab, keyingisiga o'tish
       "Qayta olish"     — shu sahifani qaytadan olish
       "Tugatish (PDF)"  — sahifani saqlab, hammasini bitta PDF qilish
"""

import os
import sys
import threading
import time
import tkinter as tk
from datetime import datetime
from tkinter import filedialog, messagebox, ttk

import cv2
import numpy as np
from PIL import Image, ImageTk

PREVIEW_MAX = (960, 720)        # ekrandagi ko'rinish o'lchami
DETECT_WIDTH = 640              # sahifani topish uchun kichraytirilgan kadr eni
AUTO_STABLE_SECONDS = 1.3       # avto-olish: sahifa shuncha vaqt qimirlamasa
AUTO_COOLDOWN_SECONDS = 2.5     # keyingi sahifaga o'tgandan keyin kutish
JPEG_QUALITY = 92
PDF_DPI = 150

MODES = ["Rangli", "Kulrang (toza)", "Oq-qora (skaner)"]


# --------------------------------------------------------------------------
# Tasvirga ishlov berish
# --------------------------------------------------------------------------

def order_points(pts):
    """To'rtburchak burchaklarini: yuqori-chap, yuqori-o'ng, past-o'ng, past-chap tartibiga keltiradi."""
    pts = np.asarray(pts, dtype=np.float32).reshape(4, 2)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).ravel()
    return np.array([pts[np.argmin(s)], pts[np.argmin(d)],
                     pts[np.argmax(s)], pts[np.argmax(d)]], dtype=np.float32)


def find_page(frame):
    """Kadrdagi eng katta to'rtburchak (sahifa)ni topadi. Topilmasa None qaytaradi."""
    h, w = frame.shape[:2]
    scale = DETECT_WIDTH / float(w)
    small = cv2.resize(frame, (DETECT_WIDTH, int(h * scale)))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)

    edges = cv2.Canny(gray, 50, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=2)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_area = small.shape[0] * small.shape[1]

    for c in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
        area = cv2.contourArea(c)
        if area < frame_area * 0.15:
            break
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) == 4 and cv2.isContourConvex(approx):
            return order_points(approx) / scale
    return None


def warp_page(frame, quad):
    """Sahifani perspektivadan to'g'rilab, tekis to'rtburchak qilib kesib oladi."""
    tl, tr, br, bl = quad
    width = int(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl)))
    height = int(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl)))
    dst = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]],
                   dtype=np.float32)
    m = cv2.getPerspectiveTransform(quad, dst)
    page = cv2.warpPerspective(frame, m, (width, height), flags=cv2.INTER_CUBIC)
    # Chetdagi stol/soya qoldiqlarini olib tashlash
    my, mx = int(height * 0.015), int(width * 0.015)
    return page[my:height - my, mx:width - mx]


def normalize_light(gray):
    """Yorug'lik notekisligini yo'qotadi: qog'oz oq, matn qora bo'lib qoladi."""
    k = max(31, (min(gray.shape[:2]) // 12) | 1)
    background = cv2.morphologyEx(gray, cv2.MORPH_CLOSE,
                                  cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    background = cv2.GaussianBlur(background, (k, k), 0)
    norm = cv2.divide(gray, background, scale=255)
    return cv2.normalize(norm, None, 0, 255, cv2.NORM_MINMAX)


def enhance(page, mode):
    if mode == MODES[0]:  # Rangli
        lab = cv2.cvtColor(page, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        l = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(l)
        out = cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)
        blur = cv2.GaussianBlur(out, (0, 0), 2)
        return cv2.addWeighted(out, 1.5, blur, -0.5, 0)

    gray = cv2.cvtColor(page, cv2.COLOR_BGR2GRAY)
    clean = normalize_light(gray)
    if mode == MODES[1]:  # Kulrang (toza)
        return cv2.cvtColor(clean, cv2.COLOR_GRAY2BGR)

    # Oq-qora (skaner)
    bw = cv2.adaptiveThreshold(clean, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                               cv2.THRESH_BINARY, 31, 15)
    return cv2.cvtColor(bw, cv2.COLOR_GRAY2BGR)


def process(frame, quad, mode):
    page = warp_page(frame, quad) if quad is not None else frame.copy()
    return enhance(page, mode)


def to_photo(bgr, max_size):
    img = Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    img.thumbnail(max_size, Image.LANCZOS)
    return ImageTk.PhotoImage(img)


# --------------------------------------------------------------------------
# Kamera (alohida oqimda o'qiydi, interfeys qotib qolmasligi uchun)
# --------------------------------------------------------------------------

class Camera:
    def __init__(self, source):
        self.source = source
        if isinstance(source, int) and sys.platform.startswith("win"):
            self.cap = cv2.VideoCapture(source, cv2.CAP_DSHOW)
        else:
            self.cap = cv2.VideoCapture(source)
        if not self.cap.isOpened():
            raise RuntimeError(f"Kamerani ochib bo'lmadi: {source}")
        # Iloji boricha yuqori sifat
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
        self.frame = None
        self.lock = threading.Lock()
        self.running = True
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def _loop(self):
        while self.running:
            ok, frame = self.cap.read()
            if ok:
                with self.lock:
                    self.frame = frame
            else:
                time.sleep(0.05)

    def read(self):
        with self.lock:
            return None if self.frame is None else self.frame.copy()

    def release(self):
        self.running = False
        self.thread.join(timeout=1)
        self.cap.release()


# --------------------------------------------------------------------------
# Interfeys
# --------------------------------------------------------------------------

class App:
    def __init__(self, root):
        self.root = root
        root.title("Kitob Skaner")
        root.configure(bg="#1e1e24")
        root.minsize(900, 640)

        self.camera = None
        self.pages = []            # JPEG baytlari ro'yxati
        self.state = "live"        # "live" yoki "review"
        self.current = None        # ko'rib chiqilayotgan sahifa (BGR)
        self.last_quad = None
        self.stable_since = None
        self.cooldown_until = 0.0

        self._build_ui()
        self.connect_camera()
        root.bind("<space>", lambda e: self.on_space())
        root.bind("<Return>", lambda e: self.next_page() if self.state == "review" else None)
        root.bind("<Escape>", lambda e: self.retake() if self.state == "review" else None)
        root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.tick()

    # ---------- UI ----------
    def _build_ui(self):
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("TFrame", background="#1e1e24")
        style.configure("TLabel", background="#1e1e24", foreground="#e8e8ee", font=("Segoe UI", 10))
        style.configure("TCheckbutton", background="#1e1e24", foreground="#e8e8ee", font=("Segoe UI", 10))
        style.map("TCheckbutton", background=[("active", "#1e1e24")])
        style.configure("Big.TButton", font=("Segoe UI", 12, "bold"), padding=(18, 10))
        style.configure("Go.TButton", font=("Segoe UI", 12, "bold"), padding=(18, 10),
                        background="#2e7d32", foreground="white")
        style.map("Go.TButton", background=[("active", "#388e3c")])
        style.configure("Done.TButton", font=("Segoe UI", 12, "bold"), padding=(18, 10),
                        background="#1565c0", foreground="white")
        style.map("Done.TButton", background=[("active", "#1976d2")])

        top = ttk.Frame(self.root, padding=(10, 8))
        top.pack(fill="x")
        ttk.Label(top, text="Kamera:").pack(side="left")
        self.source_var = tk.StringVar(value="0")
        src = ttk.Combobox(top, textvariable=self.source_var, width=34,
                           values=["0", "1", "2", "http://192.168.1.5:8080/video"])
        src.pack(side="left", padx=(4, 4))
        ttk.Button(top, text="Ulash", command=self.connect_camera).pack(side="left")

        ttk.Label(top, text="   Rejim:").pack(side="left")
        self.mode_var = tk.StringVar(value=MODES[1])
        mode = ttk.Combobox(top, textvariable=self.mode_var, values=MODES, state="readonly", width=18)
        mode.pack(side="left", padx=4)
        mode.bind("<<ComboboxSelected>>", lambda e: self.reprocess())

        self.auto_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(top, text="Avto-olish", variable=self.auto_var).pack(side="left", padx=12)

        self.count_label = ttk.Label(top, text="Sahifalar: 0", font=("Segoe UI", 11, "bold"))
        self.count_label.pack(side="right")

        self.view = tk.Label(self.root, bg="#111114")
        self.view.pack(fill="both", expand=True, padx=10)

        self.status = ttk.Label(self.root, text="", anchor="center", padding=(0, 6))
        self.status.pack(fill="x")

        self.bar = ttk.Frame(self.root, padding=(10, 4, 10, 12))
        self.bar.pack(fill="x")

        # Jonli rejim tugmalari
        self.live_bar = ttk.Frame(self.bar)
        ttk.Button(self.live_bar, text="📷  Nusxa olish  (Probel)", style="Go.TButton",
                   command=self.capture).pack(side="left", expand=True, fill="x", padx=4)
        self.live_finish = ttk.Button(self.live_bar, text="✔  Tugatish (PDF)", style="Done.TButton",
                                      command=self.finish)
        self.live_finish.pack(side="left", expand=True, fill="x", padx=4)

        # Ko'rib chiqish rejimi tugmalari
        self.review_bar = ttk.Frame(self.bar)
        ttk.Button(self.review_bar, text="▶  Keyingi sahifa  (Enter)", style="Go.TButton",
                   command=self.next_page).pack(side="left", expand=True, fill="x", padx=4)
        ttk.Button(self.review_bar, text="↺  Qayta olish  (Esc)", style="Big.TButton",
                   command=self.retake).pack(side="left", expand=True, fill="x", padx=4)
        ttk.Button(self.review_bar, text="⟳  Burish", style="Big.TButton",
                   command=self.rotate).pack(side="left", fill="x", padx=4)
        ttk.Button(self.review_bar, text="✔  Tugatish (PDF)", style="Done.TButton",
                   command=self.finish).pack(side="left", expand=True, fill="x", padx=4)

        self.show_bar()

    def show_bar(self):
        self.live_bar.pack_forget()
        self.review_bar.pack_forget()
        if self.state == "live":
            self.live_bar.pack(fill="x")
            self.live_finish.state(["!disabled"] if self.pages else ["disabled"])
            self.set_status("Sahifani kameraga ko'rsating va «Nusxa olish»ni bosing.")
        else:
            self.review_bar.pack(fill="x")
            self.set_status(f"{len(self.pages) + 1}-sahifa tayyor. Keyingi sahifaga o'tasizmi yoki tugatasizmi?")

    def set_status(self, text):
        self.status.config(text=text)

    def update_count(self):
        self.count_label.config(text=f"Sahifalar: {len(self.pages)}")

    # ---------- Kamera ----------
    def connect_camera(self):
        raw = self.source_var.get().strip()
        source = int(raw) if raw.isdigit() else raw
        if self.camera:
            self.camera.release()
            self.camera = None
        try:
            self.camera = Camera(source)
        except RuntimeError as e:
            messagebox.showerror("Kamera", f"{e}\n\nBoshqa raqamni (0, 1, 2) yoki telefon kamerasi "
                                           "manzilini (IP Webcam) kiriting.")

    # ---------- Asosiy sikl ----------
    def tick(self):
        if self.state == "live" and self.camera:
            frame = self.camera.read()
            if frame is not None:
                quad = find_page(frame)
                self.last_frame, self.last_quad = frame, quad
                shown = frame.copy()
                if quad is not None:
                    cv2.polylines(shown, [quad.astype(np.int32)], True, (60, 220, 90), 4)
                    for p in quad.astype(np.int32):
                        cv2.circle(shown, tuple(p), 10, (60, 220, 90), -1)
                self.handle_auto(quad, shown)
                self.photo = to_photo(shown, self.view_size())
                self.view.config(image=self.photo)
        self.root.after(33, self.tick)

    def handle_auto(self, quad, shown):
        if not self.auto_var.get() or time.time() < self.cooldown_until:
            self.stable_since = None
            return
        if quad is None:
            self.stable_since = None
            self._prev_quad = None
            return
        prev = getattr(self, "_prev_quad", None)
        moved = prev is None or np.abs(quad - prev).max() > shown.shape[1] * 0.01
        self._prev_quad = quad
        if moved:
            self.stable_since = time.time()
            return
        held = time.time() - (self.stable_since or time.time())
        progress = min(held / AUTO_STABLE_SECONDS, 1.0)
        h, w = shown.shape[:2]
        cv2.rectangle(shown, (0, h - 14), (int(w * progress), h), (60, 220, 90), -1)
        if held >= AUTO_STABLE_SECONDS:
            self.stable_since = None
            self.capture()

    def view_size(self):
        w = max(self.view.winfo_width(), 200)
        h = max(self.view.winfo_height(), 200)
        return (min(w, 2000), min(h, 2000))

    # ---------- Tugmalar ----------
    def on_space(self):
        if self.state == "live":
            self.capture()

    def capture(self):
        frame = getattr(self, "last_frame", None)
        if frame is None:
            self.set_status("Kameradan tasvir kelmayapti.")
            return
        self.raw_frame, self.raw_quad = frame, self.last_quad
        self.rotation = 0
        self.reprocess(show=False)
        self.state = "review"
        self.show_current()
        self.show_bar()

    def reprocess(self, show=True):
        if getattr(self, "raw_frame", None) is None:
            return
        page = process(self.raw_frame, self.raw_quad, self.mode_var.get())
        for _ in range(getattr(self, "rotation", 0)):
            page = cv2.rotate(page, cv2.ROTATE_90_CLOCKWISE)
        self.current = page
        if show and self.state == "review":
            self.show_current()

    def show_current(self):
        self.photo = to_photo(self.current, self.view_size())
        self.view.config(image=self.photo)

    def rotate(self):
        self.rotation = (self.rotation + 1) % 4
        self.current = cv2.rotate(self.current, cv2.ROTATE_90_CLOCKWISE)
        self.show_current()

    def accept_current(self):
        ok, buf = cv2.imencode(".jpg", self.current, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        if ok:
            self.pages.append(buf.tobytes())
        self.current = None
        self.raw_frame = None
        self.update_count()

    def next_page(self):
        self.accept_current()
        self.back_to_live()

    def retake(self):
        self.current = None
        self.raw_frame = None
        self.back_to_live()

    def back_to_live(self):
        self.state = "live"
        self.cooldown_until = time.time() + AUTO_COOLDOWN_SECONDS
        self._prev_quad = None
        self.show_bar()

    def finish(self):
        if self.state == "review" and self.current is not None:
            self.accept_current()
        if not self.pages:
            messagebox.showinfo("Kitob Skaner", "Hali birorta ham sahifa olinmagan.")
            self.back_to_live()
            return

        default = f"Kitob_{datetime.now():%Y-%m-%d_%H-%M}.pdf"
        path = filedialog.asksaveasfilename(
            title="PDF ni saqlash", defaultextension=".pdf", initialfile=default,
            initialdir=os.path.join(os.path.expanduser("~"), "Documents"),
            filetypes=[("PDF fayl", "*.pdf")])
        if not path:
            self.set_status("Saqlash bekor qilindi. Sahifalar hali xotirada turibdi.")
            self.back_to_live()
            return

        save_pdf(self.pages, path)
        n = len(self.pages)
        self.pages = []
        self.update_count()
        self.back_to_live()
        self.set_status(f"Tayyor! {n} sahifa saqlandi: {path}")
        if messagebox.askyesno("Kitob Skaner", f"{n} sahifali PDF saqlandi:\n{path}\n\nOchib ko'rasizmi?"):
            open_file(path)

    def on_close(self):
        if self.pages and not messagebox.askyesno(
                "Chiqish", f"{len(self.pages)} ta sahifa hali PDF ga saqlanmagan. Baribir chiqasizmi?"):
            return
        if self.camera:
            self.camera.release()
        self.root.destroy()


def save_pdf(pages, path):
    import io
    images = [Image.open(io.BytesIO(b)).convert("RGB") for b in pages]
    images[0].save(path, "PDF", save_all=True, append_images=images[1:], resolution=PDF_DPI)


def open_file(path):
    if sys.platform.startswith("win"):
        os.startfile(path)
    elif sys.platform == "darwin":
        os.system(f'open "{path}"')
    else:
        os.system(f'xdg-open "{path}"')


def main():
    root = tk.Tk()
    root.geometry("1100x800")
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
