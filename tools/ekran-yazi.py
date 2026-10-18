#!/usr/bin/env python3
"""
TV ekran görüntüsünün belirli bölgelerindeki yazıyı okur (Tesseract) — Netflix oynatıcısının başlık/bölüm
satırları için (Apple TV'nin "şu an oynayan" bilgisinde Netflix başlık vermiyor; ekranda ise yazıyor).

    python3 ekran-yazi.py <jpeg | ->  → stdout: {"sag_ust": [...], "sol_ust": [...], "alt": [...]}   (- → stdin)

Bölgeler ekranın oranıyla (1080p'ye bağlı değil). Netflix oynatıcı yazıları beyaz: gri tona çevrilir, 2× büyütülür,
açık pikseller siyah yazıya (kalan beyaz zemine) eşiklenir — video arka planı yazıyı bozmasın.
Gerekenler: tesseract-ocr, tesseract-ocr-tur, python3-pil.
"""
import json
import subprocess
import sys

from PIL import Image

BOLGELER = {
    # Netflix (tvOS) duraklatınca: sağ üstte dizi/film adı + "S1: B1 “Bölüm”", sol üstte "SEÇENEKLER",
    # altta ilerleme çubuğunun iki yanında süreler.
    "sag_ust": (0.50, 0.04, 0.985, 0.22),
    "sol_ust": (0.02, 0.04, 0.32, 0.25),
    "alt": (0.04, 0.78, 0.96, 0.93),
}
ESIK = 175


def oku(goruntu, kutu):
    g = goruntu.width, goruntu.height
    k = goruntu.crop((int(kutu[0] * g[0]), int(kutu[1] * g[1]), int(kutu[2] * g[0]), int(kutu[3] * g[1])))
    k = k.convert("L").resize((k.width * 2, k.height * 2), Image.LANCZOS)
    k = k.point(lambda p: 0 if p >= ESIK else 255)
    sonuc = subprocess.run(
        ["tesseract", "stdin", "stdout", "-l", "tur+eng", "--psm", "6"],
        input=_png(k), capture_output=True, timeout=30,
    )
    metin = sonuc.stdout.decode("utf-8", "replace")
    return [s.strip() for s in metin.splitlines() if s.strip()]


def _png(goruntu):
    import io
    b = io.BytesIO()
    goruntu.save(b, format="PNG")
    return b.getvalue()


def main():
    import io
    kaynak = io.BytesIO(sys.stdin.buffer.read()) if sys.argv[1] == "-" else sys.argv[1]
    goruntu = Image.open(kaynak).convert("RGB")
    print(json.dumps({ad: oku(goruntu, kutu) for ad, kutu in BOLGELER.items()}, ensure_ascii=False))


if __name__ == "__main__":
    main()
