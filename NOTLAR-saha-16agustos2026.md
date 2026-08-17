# Saha Notları — 16 Ağustos 2026 Türksat Geçişi

**Derleme tarihi:** 2026-08-17
**Kaynak:** ekşi sözlük "16 ağustos 2026 tv frekans güncellemesi" başlığı (63 sayfa, 70 entry görüntülendi)
· <https://eksisozluk.com/16-agustos-2026-tv-frekans-guncellemesi--8128792>
**İçindeki dış bağlantılar (üçü de açıldı):**
- TUYAD açıklaması / CNN Türk, 16.08.2026 — <https://www.cnnturk.com/turkiye/televizyonda-kanal-ve-frekans-sorunu-nasil-cozulur-iste-adim-adim-yapilmasi-gerekenler-3455299>
- Türksat resmî frekans listesi — <https://www.turksat.com.tr/uydu/yayincilik-hizmetleri/turksat-frekans-listesi?page=1>
- TKGS + şebeke tarama anlatan video — <https://www.youtube.com/watch?v=2D51_53-uyg> (⚠️ izlenmedi, yalnız varlığı kaydedildi)

> **Not:** Bu dosya kullanıcı beyanlarını **veri** olarak derler. Forum içeriği anonimdir (K3);
> resmî/kurumsal kaynaklar ayrıca işaretlenmiştir. Bir iddia birden çok bağımsız kaynakta
> geçiyorsa veya bizim kendi ölçümümüzle örtüşüyorsa bu belirtilmiştir.

---

## 1. Bizim ölçümümüzü doğrulayan bulgular

### 1.1 Tarama frekansları — resmî değerlerle birebir

Birden çok yazar aynı iki değeri veriyor ve bunlar Türksat'ın resmî duyurusuyla örtüşüyor:

| Frekans | Pol | Symbol Rate | FEC | Kapsama |
|---|---|---|---|---|
| **12380 MHz** | V (dikey) | 27500 | 3/4 | Türkiye + Avrupa |
| **12423 MHz** | H (yatay) | 30000 | 3/4 | Türkiye + Orta Asya |

Kritik şart, birden çok yazarda tekrar ediyor: **"şebeke arama / ağ arama / network (NIT) taraması" AÇIK olmalı.**
Kapalıysa yalnız o transponderdeki kanallar gelir, diğerleri gelmez.

> "12380 mhz / dikey (v) / sr: 27500 / fec 3/4 — 12423 mhz / yatay (h) / sr: 30000 / fec 3/4 …
> şebeke/network (nıt) tarama seçeneği açık yapılacak"
> — *primarymaster*, 16.08.2026 12:02

Bizim `data/turksat-42e-latest.json` çekicimiz aynı transponderleri **12379 V** ve **12422 H**
olarak görüyor. Bu 1 MHz'lik fark, aracın frekans eşleştirmesini **±2 MHz toleranslı** yapma
kararının saha karşılığıdır — tam eşitlik arayan bir araç burada sessizce başarısız olurdu.

### 1.2 TKGS "Çalışma Şekli" — sıralamanın kilidi

Araştırma fazında bunu ikincil kaynaklardan çıkarmıştık; şimdi bir uygulayıcının adım adım
tarifiyle doğrulandı:

> "tkgs kurulumu → çalışma şekli → **otomatik** olarak değiştirin → güncellemeyi başlat →
> tüm kanallar otomatik gelecek. Tüm kanallar geldikten sonra **tkgs çalışma şeklini 'esnek'**
> olarak değiştirirseniz kanal listesinde kısmen de olsa sıralama yapabilirsiniz."
> — *luzumsuzbilgileransiklopedisi*, 16.08.2026 12:37

**Projeye etkisi:** Bu, aracın işe yarayıp yaramayacağını belirleyen ön koşul. Doğru sıra:
`otomatik` ile listeyi doldur → `esnek`e al → sonra sırala. Arayüzde bu sıra açıkça anlatılmalı.

### 1.3 TKGS'nin kişisel sıralamayı ezmesi

Başlıkta tekrar tekrar "kanalların yerleri değişti, yeniden dizmek gerekiyor" şikâyeti var.
Bu, bizim kendi ölçümümüzle birebir örtüşüyor: salon TV'sinde (OLED83G55LW) liste öğlen 682
kanaldı, akşam 644'e düştü ve **numaralandırma boşluklu kanonik TKGS sırasına** geçti
(1 TRT1, 2 ATV, 3 Kanal D, … 11, 13, 15, 17, 20 — atlanan numaralar dış otorite ataması
göstergesi). Türksat tablosuna frekans uyumu %61 → %88'e çıktı.

---

## 2. Bizim bilmediğimiz, araca eklenmesi gereken bulgular

### 2.1 ⭐ Ses gelmiyor sorunu — A-PID elle düzeltiliyor

En değerli bulgu. Bazı kanallarda görüntü var ama **ses yok**; çözüm, o kanalın **audio PID**
değerini Türksat'ın resmî tablosundan bulup cihaza elle girmek:

> "ses sorunu … değişmiyorsa o kanalın **audio pid (a-pıd)** değerini aşağıdaki listeden bulup
> elle değiştirmeniz gerekiyor" + Türksat frekans listesi bağlantısı
> — *primarymaster*, 16.08.2026 15:34 (düzenleme)

**Neden bizim için önemli:** Türksat tablosunu zaten **V-PID ve A-PID sütunlarıyla** çekiyoruz
(749 satır). Yani "hangi kanalın A-PID'i yanlış" sorusunu **otomatik** cevaplayabiliriz — kullanıcının
tabloda elle satır araması gereken işi araç yapar. Üstelik `audioPid` webOS 5+ yazılabilir alan
listemizde zaten var.

→ **Aksiyon:** doğrulama raporuna "PID uyuşmazlığı" kontrolü ekle; editörde A-PID düzeltme.

### 2.2 ⭐ "Tek kablo" (unicable) tuzağı

> "çoğu uydu alıcısında **tek kablo** seçili geliyor. tek kablo yerine **diseq 1.0** seçince çalıştı."
> — *alphateam*, 16.08.2026 08:14

> "sinyal alamazsanız **lnb frekansının 9750/10600** olduğundan emin olun. diseq ayarında da
> seçe seçe sinyalin gelmesini bekleyin."
> — *mozartin yaveri*, 16.08.2026 12:16

Kullanıcı "hiç kanal gelmiyor" diyorsa sebep frekans değil, **LNB/DiSEqC ayarı** olabilir. Araç
frekansı doğru gösterse bile bu katmanı bilmeden teşhis eksik kalır.

→ **Aksiyon:** "hiç kanal bulunamadı" durumunda LNB 9750/10600 ve DiSEqC 1.0 kontrol adımını göster.

### 2.3 ⭐ TUYAD: LG ve Samsung'da TKGS hatası — resmî teyit (K2)

Sektör derneği TUYAD'ın 16.08.2026 tarihli açıklaması (CNN Türk üzerinden):

> "özellikle bazı **Samsung Smart TV ve LG modellerinde TKGS verilerinin otomatik işlenmesinde
> aksaklıklar** yaşandığı…"
> "Kalıcı çözüm için ilgili televizyon üreticisinin, cihaz yazılımlarını TKGS sistemiyle tam uyumlu
> hâle getirecek **yazılım/firmware güncellemesini sunması gerekmektedir**."

**Bu, projenin varlık gerekçesinin kurumsal teyididir:** üretici yamayı verene kadar kullanıcı
elle çözmek zorunda; araç tam da bu boşlukta duruyor. Araştırma fazında "LG/Samsung'un bu geçişe
özel resmî açıklaması bulunamadı" demiştik — bu bulgu o boşluğu kapatıyor (üretici değil, sektör
derneği tarafından).

### 2.4 Şifresiz açılan kanallar (doğrulanmadı)

> "nat geo, nat geo wild ve fx kanalları şuan şifresiz açık bi şekilde izlenebiliyor …
> bahsettiğim şifresiz izleme **11807/10000/h** frekansında."
> — *yordam bilen adam*, 16.08.2026 11:47

⚠️ **Doğrulanmadı.** Tek kaynak, anonim. Geçici bir yapılandırma hatası olabilir. Araca
gömülmemeli; yalnız "şifreli/şifresiz durumu tablodan farklı" uyarısı anlamlı olur.

### 2.5 LG için rehber talebi — doğrudan pazar sinyali

> "hiç anlamadığım mevzu, bir damat olarak şurda **lg televizyonu** falan genel olarak açıklayacak
> babayiğit yazarları beklemekteyim"
> — *artemiskm*, 16.08.2026 11:16

Yardım eden yazar da LG'yi erteliyor: *"şuan vestel, seg, hi-level için destek olabilirim.
yarın lg vs diğer markalarda."* Yani geçişin ilk gününde **LG sahipleri açıkta kalmış**.

### 2.6 Sıralamanın "siyasi" olduğu iddiası

Birden çok entry, TKGS'nin dayattığı sıralamanın belirli kanalları öne/arkaya aldığını iddia ediyor.
⚠️ **Doğrulanamaz bir iddiadır** ve bu projede taraf tutulacak bir konu değildir. Ancak teknik
karşılığı gerçek ve tarafsızdır: **kullanıcı kendi sırasını istiyor.** Aracın işlevi tam olarak budur —
hangi sırayı istediğine kullanıcı karar verir.

---

## 3. Bulgulardan çıkan iş listesi

| # | İş | Kaynak | Durum |
|---|---|---|---|
| N-1 | Doğrulama raporuna **A-PID/V-PID uyuşmazlığı** kontrolü | §2.1 | açık |
| N-2 | Editörde **A-PID düzeltme** (webOS 5+ yazılabilir alan) | §2.1 | açık |
| N-3 | "Hiç kanal yok" akışına **LNB 9750/10600 + DiSEqC 1.0** adımı | §2.2 | açık |
| N-4 | Onboarding'e **TKGS: otomatik → güncelle → esnek** sırası | §1.2 | açık |
| N-5 | Tarama parametrelerini (12380 V 27500 / 12423 H 30000, NIT açık) arayüzde göster | §1.1 | açık |
| N-6 | **LG'ye özel adım adım rehber** — pazar boşluğu | §2.5 | açık |
| N-7 | Şifreleme durumu tablodan farklıysa uyar | §2.4 | açık (düşük öncelik) |

---

## 4. Kaynak değerlendirmesi

| Kaynak | Katman | Değerlendirme |
|---|---|---|
| TUYAD açıklaması (CNN Türk üzerinden) | **K2** | Sektör derneği beyanı; LG/Samsung TKGS sorununun en güçlü teyidi |
| Türksat resmî frekans listesi | **K1** | Zaten projenin veri kaynağı; A-PID kullanımı bu başlıkta doğrulandı |
| ekşi entry'leri | **K3** | Anonim; ama tarama parametreleri ve TKGS akışı birden çok yazarda tutarlı ve resmî veriyle örtüşüyor |
| YouTube videosu | — | ⚠️ İzlenmedi, yalnız kaydedildi |

**Çelişki yok:** Bu başlıktaki teknik değerler, Türksat'ın resmî duyurusu ve bizim ölçümlerimizle
tutarlı. Tek fark 12380/12423 ile tablodaki 12379/12422 arasındaki 1 MHz'dir; bu zaten bilinen ve
tolerans ile ele alınan bir konudur.
