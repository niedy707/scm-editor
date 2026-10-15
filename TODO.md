# TODO — scm-editor

> Son güncelleme: 14.10.2026

Görev eklerken sadece başlık yazma: **ne yapılacak**, **nerede** (`dosya:satır`),
**neden bekliyor** ve varsa **engeli** belirt. Kullanıcı bir karar verdiyse kararı da yaz.

Kökteki [`../TODO.md`](../TODO.md) merkez listedir; buradaki kayıtlar onun detay
referansıdır. Bir görev kapandığında kökteki karşılığı `../TODO_done.md`'ye taşınır.

Öneri numaraları (Ö-N) [`scm-editor_tara.md`](scm-editor_tara.md) raporuna aittir.

---

## Tamamlanan (14.10.2026)

- [x] **Salon TV'de onaylı sıra uygulandı.** 72 kanallık baş sıra (A → Habertürk · CNN Türk · Bloomberg HT ·
      NTV → E → B → C → D → F → G → H) TV'de; `sirala --tarif data/yerel/oneri-prime-time.json` artık
      "taşıma gerekmiyor" diyor. İki gecede toplam 55 taşıma. Numaralar Türksat boşluklarını koruyor
      (11, 13, 15, 17, 20…). TV çalışma sırasında kendi kayıt yenilemesiyle 15 yeni servis ekledi
      (432 → 447); yeni gelenler listenin sonunda.
- [x] **Sürücü cihazda doğrulandı.** Yenilemeye dayanıklı kimlik ve yeniden deneme gerçek koşulda çalıştı
      (3 takılma kendiliğinden toparlandı). Ek düzeltme: yüzen satırın odak kaybı (`COZUMLER.md`).

## Önce bu

- [ ] **Değişiklikleri commit et — önce Ö-40.** Bugüne kadarki kodun tamamı çalışma dizininde, commit
      edilmedi. Depo **public**: izlenen `data/tv-salon*.json` dosyalarında TV seri numarası var
      (geçmişteki üç dosya için karar kullanıcıda). Tarihli yeni dökümler artık `.gitignore`'da.

## Sırada

- [ ] **Ö-32 — USB ile dışa aktarımı dene (salon TV).** Menü 13.10.2026'da ekrandan doğrulandı:
      Ayarlar → Genel → Kanallar → Kanalları Kopyala → "TV - USB" / "USB - TV" (USB takılı
      olmadığı için gri). Yapılacak: FAT32 ≤16 GB bellek tak, dışa aktar, dosyayı
      `web/editor.html`'de aç (biçim webOS 5+ ile aynı mı?), sonra tek kanallık pilot içe aktarım.
      **Engel:** fiziksel USB bellek. İçe aktarım pilotu ayrıca kullanıcı onayı ister.

- [ ] **Ö-34 — Sıra kayması tespiti + yeniden uygula.** `tools/tv.mjs` içine yalnız okuyan
      `durum --tarif …` komutu. Bugün öğrenildi: TV kendi kendine kayıt yeniliyor ve kanal
      ekleyip çıkarıyor; otomatik güncelleme ayarı ağdan okunamıyor (`500`).

- [ ] **Ö-33 + Ö-41 — "Sıram" sürükle-bırak sayfası.** `web/sira.html`, `tools/bridge.mjs`'e
      `plan`/`uygula`/`ilerleme`/`ekran` uçları; yazan uçlar yalnız `127.0.0.1`, TV başına tek iş
      kilidi, zorunlu yedek.

- [ ] **Ö-36 — Oda TV (55SM8000PLA, webOS 4.5).** 13.10.2026'da kapalıydı, hiçbir şey denenmedi.
      Ekran görüntüsü ucu orada çalışıyor mu, Kanal Yöneticisi'nin tuş tarifi ne? Alternatif:
      o TV'de USB yolu yüksek kanıtlı. **Engel:** TV açık olmalı.

- [ ] **Ö-37 — Kalıcı regresyon testi.** Planlayıcı benzetimi ve sürücünün hata yolları
      (`tools/roundtrip-test.mjs`'e). Bugünkü kesinti tam olarak test edilmemiş bir yolda oldu.

- [ ] **Ö-38 — Anahtar deposunu cihaz kimliğine bağla.** `.lgtv-clients.json` IP'ye göre; ağ
      değişince elle taşındı.

- [ ] **Ö-35 — "Kanal Numaralarını Düzenle" (mavi tuş).** Ölçüldü: taşıma numara kümesini
      koruyor, boşluklar yerinde kalıyor (11. sıradaki Habertürk 11, 12. sıradaki CNN Türk 13
      oldu). Tam numara atamak gerekiyorsa bu ekran keşfedilmeli.

## Bilinen küçük eksikler

- [ ] `tools/tv.mjs` yalnız IP kabul ediyor ("salon"/"oda" takma adı yok). Adresler
      `../Network/ev_cihaz_envanteri.md`'de; buraya kopyalanmamalı.
- [ ] Radyo listesi (231 kanal) sürücünün kapsamı dışında.
- [ ] `README.md` hâlâ "yazma yalnız USB ile" diyor; ağdan sıralama anlatılmıyor.
