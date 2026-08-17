# LG Kanal Listesi Editörü

Türksat 3A'nın emekliye ayrılmasından (15→16 Ağustos 2026) sonra televizyonlar yeniden tarama
yapınca **kanal sıralaması sıfırlanıyor.** TKGS frekansları kendisi güncelliyor; çözmediği tek şey
senin kendi sıran. Bu araç tam olarak onu geri getirir.

Tamamen tarayıcıda çalışır, kurulum istemez, **dosyan cihazından çıkmaz.**

## Hibrit akış — fiziksel teması 3 adımdan 1'e indirir

```
1) Ağdan oku (temassız)      TV ← WiFi/SSAP →  node tools/lgtv-read.mjs 192.168.1.42
2) Veritabanını kur (temassız)  Türksat resmî tablosu → node tools/fetch-turksat.mjs
3) Yalnız yazarken USB        düzenlenmiş GlobalClone00001.TLL → USB → TV
```

Günlük kullanımda (bakma, planlama, karşılaştırma, "hangi kanalım nereye gitti") USB'ye hiç
dokunmazsın. USB yalnız değişikliği TV'ye işlerken devreye girer.

> **Neden 3. adım hâlâ USB?** LG'nin ağ API'si (SSAP) kanal listesini **okuyabiliyor** ama
> yeniden sıralayamıyor — yazma ucu yok. Eşleştirme manifestinde `SET_CHANNEL_SKIP`,
> `DELETE_SELECT_CHANNEL`, `CONTROL_CHANNEL_GROUP` gibi yazma **izinleri** ilan edilmiş durumda,
> yani belgelenmemiş uçlar olabilir; `--probe` bayrağı bunları **salt okunur** biçimde yoklar.
> Yeniden numaralandırma için bir izin ilan edilmemiş.

## Kurulum

Node.js 22+ dışında hiçbir bağımlılık yok. `npm install` gerekmez.

```bash
git clone <repo> && cd scm-editor
```

## Kullanım

### 1. TV'den kanal listesini oku (WiFi)

```bash
node tools/lgtv-read.mjs --discover          # ağdaki LG TV'leri bul
node tools/lgtv-read.mjs 192.168.1.42        # oku
node tools/lgtv-read.mjs 192.168.1.42 --probe  # belgelenmemiş uçları yokla (salt okunur)
```

İlk çalıştırmada **TV ekranında eşleştirme onayı** çıkar, kumandayla kabul et. Alınan anahtar
`.lgtv-clients.json` dosyasına yazılır (git'e girmez) ve TV bir daha sormaz.

Çıktı `data/tv-<ip>.json` — kanal listesi + model + firmware + **alan kapsamı raporu**
(hangi tuner alanlarının gerçekten geldiğini gösterir; eşleştirmenin ne kadar güvenilir
olacağını bu belirler).

TV açık ve aynı ağda olmalı; uyku modunda SSAP kapalıdır.

### 2. Türksat frekans veritabanını çek

```bash
node tools/fetch-turksat.mjs
```

Resmî tabloyu (Kanal · Frekans · Pol · SR · FEC · **V-PID** · **A-PID** · Uydu) sayfa sayfa çeker,
`data/turksat-42e-<tarih>.json` ve `data/turksat-42e-latest.json` olarak yazar. Resmî XLSX/PDF
dışa aktarma uçları HTTP 500 döndürdüğü için HTML tablosu ayrıştırılır.

Türksat 3A kayıtları **"şüpheli"** işaretlenir: uydu emekli olmasına rağmen tabloda hâlâ
duruyorlar ve yayında olup olmadıkları doğrulanamadı.

### 3. Editörü aç

```bash
node tools/serve.mjs        # http://127.0.0.1:8173
```

`web/index.html` dosyasını çift tıklayarak da açabilirsin; tek fark, `file://` üzerinden
Türksat veri dosyası okunamadığı için "Türksat'a göre" sütununun boş kalmasıdır.

### 4. Testler

```bash
node tools/make-fixtures.mjs   # sentetik test dosyaları üret
node tools/roundtrip-test.mjs  # 31 test
```

## Desteklenen formatlar

LG'nin üç kuşağı **aynı dosya adını** (`GlobalClone00001.TLL`) kullanır, bu yüzden format
uzantıdan değil **içerikten** tespit edilir.

| Kuşak | Tespit | Durum |
|---|---|---|
| webOS 5/6/7 (2020+) | `<legacybroadcast>` → XML zarf içinde JSON | ✅ oku + yaz |
| webOS 2-4 (2015-2019) | `<TLLDATA>` → düz XML | ✅ oku + yaz |
| NetCast (2009-2014) | `<` ile başlamaz → bloklu binary | ⛔ tanır, açıklayıcı hata verir |

NetCast desteklenmiyor çünkü DVB-S bloğunun 5 alt bloğu için CRC32, tahsis haritası (allocation
bitmap), kanal bağlı listesi ve transponder sayaç tutarlılığı gerekiyor — ayrıca symbol rate bazı
firmware'lerde 2× veya 0.5× ölçekte yazılıyor ve tek kayda bakarak doğru okunamıyor.

## Tasarım ilkeleri

**Byte-sadıklık.** Dosya asla baştan üretilmez; yalnız değişen alanın karakter aralığı yamalanır.
Hiçbir değişiklik yapmazsan çıktı girdiyle **birebir aynıdır** (test edilir). "Dosyayı hiç
değiştirmedim ama TV'ye geri koyunca liste bozuldu" şikayet sınıfının tek yapısal savunması budur.

**Korumalı alanlar.** Yazıcı katmanında sabit bir izin listesi var. Şu alanlara **asla** yazılmaz:

| Alan | Neden |
|---|---|
| `disableUpdate` | Yazılması tüm listeyi bloke ediyor ve **fabrika ayarlarına dönmeyi** gerektiriyor |
| `userEditChNumber`, `userSelCHNo` | Set olunca **sonraki import'ları engelliyor** |
| `deleted`, `factoryDefault` | webOS 5+'ta gerçek silme TV'yi kararsızlaştırıyor |

Bu alanlara yazma denemesi kod düzeyinde hata fırlatır; dosyada **olmayan bir alan da eklenmez**.

**İsim yazımı atomiktir.** LG adı iki yerde tutar (`channelName` + `chNameBase64`; eski formatta
`vchName` + `hexVchName` + uzunluk alanları). Biri güncellenmezse TV eski adı gösterir. Bu araç
hepsini tek işlemde yazar, Türkçe karakterlerde `0x15` UTF-8 gösterge baytını ekler.

**Eşleştirmede frekans birincil anahtar değildir.** Türksat'ın kendi duyurusu 12380/12423 derken
kendi frekans tablosu aynı transponderları 12379/12422 yazıyor. Tam eşitlikle eşleştiren araç bu
1 MHz'de sessizce başarısız olur. Sıra: **kimlik (SVCID+TSID+ONID) → ad → PID → frekans (±2 MHz)**.

**Silme yok.** webOS 5+'ta silinen kanallar aynı transponderdaki başka bir kanala geçildiği anda
rastgele yerlere geri geliyor. Bu araç bilerek silme sunmuyor; "sona at" ve "atla" var.

**Sıfır dış istek.** CDN yok, font yok, analytics yok. CSP `connect-src 'self'` — yalnız kendi
kökündeki Türksat veri dosyası okunabilir. DevTools → Network ile kendin doğrulayabilirsin.

## Bilinen sınırlar (dürüstçe)

- **Favoriler webOS 5+'ta düzenlenemez** — export edilen veriye hiç dahil değiller.
- **TKGS "Sabit" modunda sıralama kilitli.** LG uydu kurulumunda operatör "Türksat TKGS" seçiliyse
  *Çalışma Şekli* **Esnek** olmalı; "Sabit" ise hiçbir editör işe yaramaz.
- **Kırılgan olan export değil, import.** Export raporları neredeyse hep başarılı; başarısızlıklar
  TV'ye geri yükleme adımında. Bu yüzden "Orijinali indir" düğmesi her zaman görünür.
- **Sentetik test dosyaları gerçek TV çıktısı değildir.** Belgelenmiş şemaya göre kurulmuşlardır.
  Bir modelin gerçekten desteklendiğini ancak o modelden alınmış gerçek bir dosya kanıtlar —
  kendi dosyalarını `fixtures/local/` altına koy (git'e girmez).
- **2025-2026 modeller (webOS 25)** hakkında ne olumlu ne olumsuz doğrulanmış rapor bulunabildi.

## TV'den dosyayı alma

**Tüm Ayarlar → Kanallar → Kanal Kopyalama → TV'den USB'ye** (uydu modellerinde).

- USB **FAT32** olmalı, tercihen **≤16 GB**. NTFS/exFAT'te TV bozuk dosya yazıyor.
- Dosya adını **değiştirme**; TV yalnız `GlobalClone00001.TLL` kabul ediyor.
- 2014 öncesi modellerde bu menü yok: kumandada Ayarlar'a basılı tutup `1105` girilir.
- Tarama yaparken operatör/sağlayıcı listesi değil **"yok/diğer/tümü" + tam tarama** seç.

## Lisans

MIT — bkz. [LICENSE](LICENSE).

`tools/ssap-handshake.json`, LG SSAP eşleştirme sabitidir ve MIT lisanslı
[hobbyquaker/lgtv2](https://github.com/hobbyquaker/lgtv2) projesinden alınmıştır.

LG format bilgisi [ChanSort](https://github.com/PredatH0r/ChanSort) (GPLv3) incelenerek
**öğrenilmiş**, kodu veya offset tabloları **kopyalanmamıştır**; bu depodaki tüm uygulama
sıfırdan yazılmıştır.

## İlgili

- [scm-editor_tara.md](scm-editor_tara.md) — bu projenin dayandığı geliştirme tarama raporu
  (rakip analizi, kullanıcı şikayeti temaları, ICE puanlı öneriler, yol haritası)
