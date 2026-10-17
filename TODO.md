# TODO — scm-editor

> Son güncelleme: 17.10.2026

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

## Tamamlanan (16.10.2026)

- [x] **EPG kaynağı kararı:** kullanıcı "tvplus/digiturk rehberinden topla" dedi. digiturk asıl kaynak
      (VPS'e 403 → pi63 çeker), tvplus yedek. TV'den akış okuma kaldırıldı (`COZUMLER.md`).

## Tamamlanan (15.10.2026)

- [x] **TV kumandaları ev panelinde yayında** — ev paneli → 📺 TV kumandaları (`/tv`).
      pi63'te `tv-ajan` (systemd, Tailscale `:3027`), panel `aqara/tvKumanda.js`. Commit + push + yayın
      yapıldı (scm-editor `a52784f`, aqara `29311c2`); canlıda önbellek v29, `/tv` girişli, VPS → ajan 200.
- [x] **Oturma odası TV'si (55SM8000PLA) ağdan erişilebilir** — eşleşme, kumanda soketi, ekran görüntüsü
      (1920×1080), kanal listesi, Kanal Yöneticisi açılıyor (2 sütunlu ızgara, numarayla atlama var).

## Önce bu

- [ ] **Kullanıcının telefonda canlı denemesi.** Girişli sayfayı ben açamıyorum; panel → ajan yolu
      birim testleri + VPS'ten ajana doğrudan istekle doğrulandı, panel sürecinin içinden değil.
- [ ] **Uzaktan açmayı oturma odası TV'sinde doğrula.** 16.10.2026'da kuruldu. **Salon doğrulandı**
      (16.10 22:10, kapalıyken Kanal D'ye basıldı → açılıp kanala geçti; kullanıcı: "çalışıyor").
      Rehber pi63'ten çalışıyor, gece gün değişiminde yeni günü kendisi çekti (17.10 01:58, 108 kanal).
      Kalan: oturma odası (55SM8000PLA — kapalıyken ağı tamamen kapanıyor, "Wi-Fi ile aç" ayarına bağlı).
      Kod hazır, testli (`npm test` → 27 ajan testi; aqara 375): rehberden EPG (`tools/net/rehber.mjs`),
      kapalı TV'yi Wake-on-LAN ile açıp kanalı açma (`tools/net/wol.mjs`, `tv-ajan.mjs` → `uyan`/`kanalAc`,
      yeni `/ac` ucu), panelde ⏻ Aç/Kapat. Kurulum: kaynak + `tv-ajan.tvler.json` (artık `mac` alanlı) pi63'e
      → `sudo ./tools/tv-ajan/kur.sh` (servis birimi değişti: `StateDirectory`, `AF_NETLINK`).
      Evde sınanacaklar:
      1. **İki TV'de "Mobil TV Açık" / "Wi-Fi ile aç"** ayarı açık mı (menüdeki yeri sürüme göre değişir,
         iki TV'de de henüz bakılmadı) — kapalıysa sihirli paket TV'yi açmaz, ajan 40 sn sonra bu ipucuyla
         504 döner. Ekran görüntüsüyle menüden bakılabilir.
      2. TV kapalıyken panelden bir kanala bas → açılıp o kanala geçmeli. Süre ölçülmeli (beklenen 15-40 sn).
      3. pi63'ten digiturk 200 mü (`journalctl -u tv-ajan` → `[rehber] digiturk <gün>: N kanal`), tvplus
         evden bağlanıyor mu (yedek; doğrulanmadı).
- [ ] **Ö-40 — geçmişteki üç döküm dosyasında TV seri numarası** (`data/tv-salon*.json`, public depo).
      Yeni dökümler artık git ve Vercel dışında. Geçmişten silmek zorla push ister — karar kullanıcıda.
- [ ] **15.10 `/tara` raporu** (odak: hızlı erişim) yazılmadı — araştırma yapıldı (hazır paneller
      matrisi: hiçbiri kanal sıralamıyor, iki TV'yi birlikte gösteren yok), kullanıcı doğrudan uygulamaya
      geçti. Bulgular `scm-editor_tara.md`'ye eklenmeli.

- [ ] **Uzaktan açılıştan sonra salon TV'de çıkan pencere (akşam, kullanıcıyla).** 16.10 22:10'da TV
      uyandırılıp Kanal D'ye geçince ekranda bir pencere çıktı; kullanıcı panelden iki kez OK'a bastı
      (22:11, 22:14 — ajan kaydı). Ne olduğu bilinmiyor. Plan: kullanıcı yanındayken salonu kapat → panelden
      aç → hemen `ekran` ile görüntü + ön plandaki uygulama kimliği (`getForegroundAppInfo`). Her açılışta
      çıkıyorsa ajan tanıyıp kapatabilir (`kanalAc` sonrası). Körlemesine OK basılmaz: ne onayladığı
      bilinmeden "evet" demek istenmeyen bir ayarı kabul edebilir. ⛔ Oturma odası TV'si ile deneme yok
      (kullanıcı 17.10: odada uyuyan var) — o TV için ayrıca izin beklenir.

## Yedek plan (kurulmadı — kullanıcı kararı 17.10.2026)

- [ ] **Kumandanın yerel yolu (evdeyken buluta çıkmadan).** Kullanıcı: "gerekli değilse boşver, internette sorun
      olursa diye yedek plan olarak kalsın". **Ölçüm (17.10.2026, evden, `/tvler` durum sorgusu):** ajan + TV
      ~38 ms · telefon→VPS ~80 ms (ısınmış) · VPS→pi63→TV ~175-240 ms → bulut tuşu ~190-260 ms, yerel ~45 ms.
      Kanal değişiminde fark hissedilmez (TV'nin görüntüyü değiştirmesi ~1 sn); yalnız art arda tuşta ~0,15 sn.
      Kurulursa tasarım: aynı adres (`kumanda.ibrahimyagci.com`) açılışta pi63'ü 0,3 sn yoklar, ulaşırsa
      komutlar doğrudan gider ("🏠 Yerel" / "☁️ Bulut" işareti); giriş bulutta kalır, panel kısa ömürlü
      imzalı "ev bileti" verir, pi63'te ev LAN'ına açık ikinci dinleyici yalnız bileti + izin listesini kabul
      eder. HTTPS şart (karışık içerik): ya `ev-kumanda.ibrahimyagci.com` → 10.63.0.8 + DNS doğrulamalı
      sertifika (Mac 60 günde yeniler; ev modemi özel IP'ye çözülen adı engellemiyor — ölçüldü) ya da telefona
      Tailscale + `tailscale cert`. İnternet tamamen giderse sayfa da yüklenmez → yedek planın gerçek değeri
      ancak sayfa önbellekte (service worker) tutulursa ortaya çıkar. O zamana kadar yedek: gerçek kumanda.

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
