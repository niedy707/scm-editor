# Çözümler — scm-editor

> **Zor kazanılmış çözümler defteri.** Bir sorunu çözdükten sonra buraya yazılıp
> yazılmayacağının testi: *"Aynı sorun 3 ay sonra karşıma çıksa, çözümü yeniden
> bulmam ne kadar sürerdi?"*
>
> **Yazma:** tipo, eksik import, unutulmuş `await`, bilinen framework hatası — tek
> aramayla çıkan şeyler. Bunlar gürültüdür ve defteri okunmaz hale getirir.
>
> **Yaz:** standart dışı bir yöntem uygulandıysa · bariz çözümün neden işe yaramadığı ·
> bir aracın belgelenmemiş davranışı · bu projeye ya da ekosisteme özgü bir tuzak ·
> geri alınması pahalı bir karar.

> 📌 **Bu defterden önce yazılmış kayıt:** [`NOTLAR-saha-16agustos2026.md`](NOTLAR-saha-16agustos2026.md)
> — 16.08.2026 saha notları. Yeni kayıtlar buraya, o dosyaya değil.

## 15.10.2026 — TV'nin verdiği yayın akışı ERTESİ GÜNÜN akışı; tarih kaydırarak "düzeltmek" yanlış program gösterir

**Belirti:** Kumanda sayfasında kanalların altına "şu an ne var" konacaktı. `ssap://tv/getChannelProgramInfo
{channelId}` başka kanallar için akış döndürdü (55SM8000PLA): Star TV "Star Haber 19:00–20:00, Uncharted
20:00–22:30", Kanal D "Kanal D Ana Haber 19:00–20:00, Beyaz'la Joker 20:00–23:15" — ama hepsi **16.10**
tarihli; Mac, pi63, VPS ve TV'nin kendi saati (`com.webos.service.tv.time/getCurrentTime`) 15.10'du.
**Kök neden:** Veri yanlış etiketlenmiş bugünün akışı değil, gerçekten yarının akışı: Beyaz'la Joker bu
hafta cumaya alınmıştı (16.10 Cuma 20:00) ve o akşam ~19:57'de Kanal D'de akışın "Ana Haber" dediği
saatte bir dizi yayındaydı (ekran görüntüsüyle görüldü). Salon TV (webOS 26) HDMI'dayken akış hiç vermedi.
**Çözüm:** `tools/tv-ajan.mjs` → `programSec`: yalnız gerçek ana uyan kayıt kabul edilir; panel program
satırını yalnız böyle bir veri gelirse gösterir (`aqara/public/tv.js`). Sonuç: şimdilik pratikte boş.
Güvenilir EPG için dış kaynak gerekiyor (kullanıcı kararı bekliyor — `TODO.md`).
**Neden bariz olan işe yaramadı:** "TV'nin tarihi bir gün kaymış, ±1 gün kaydırıp günün saatine göre
eşleştir" düzeltmesi yazıldı, birim testi geçti — ama gerçek akışla karşılaştırılınca yanlış programı
"şimdi" diye gösterdiği anlaşıldı ve geri alındı. Ders: tarih uyuşmazlığını "etiket hatası" saymadan önce
içeriği dışarıdan doğrula.

## 15.10.2026 — Uzun ömürlü ajanda ekran görüntüsü ikinci istekten itibaren "LG sertifikası sunmadı"

**Belirti:** `tools/tv.mjs ekran` hep çalışıyordu; ajan (`tv-ajan.mjs`) ise ilk görüntüyü alıp sonrakileri
`Ekran görüntüsü sunucusu LG cihaz sertifikası sunmadı` ile reddetti.
**Kök neden:** Node'un ortak HTTPS ajanı bağlantıyı/TLS oturumunu yeniden kullanıyor; devam ettirilen
oturumda `res.socket.getPeerCertificate()` boş dönüyor, bizim ad üzerinden sertifika denetimimiz de haklı
olarak reddediyor. Tek seferlik CLI süreci bunu hiç yaşamıyor.
**Çözüm:** `tools/net/lg-screen.mjs` → `https.get(..., { agent: false })`: her indirme yeni TLS el sıkışması.
**Neden bariz olan işe yaramadı:** Denetimi gevşetmek (`allowAnyCertificate`) hatayı susturur ama TV'den
geldiğini doğrulamadığımız görüntüyü panele taşır. Sorun sertifikada değil, oturum yeniden kullanımında.

## 15.10.2026 — Kapalı TV'ye bağlanmak 41–47 sn; eski TV kapanışa yanıt vermeyince süreç hiç bitmiyor

**Belirti:** (1) Panelden durum sorgusu iki TV kapalıyken 47 sn sürdü, panel 15 sn'de "yanıt yok" dedi.
(2) 55SM8000PLA'ya karşı `tools/tv.mjs` işini bitirdiği hâlde terminalde asılı kaldı.
**Kök neden:** (1) `connectAuto` varsayılan olarak 4 tur × 2 port (3001 wss + 3000 ws) dener, aralarda
bekler; fişi çekik TV SYN'e yanıt vermediği için her deneme zaman aşımını sonuna kadar bekler.
(2) `WsConnection.close()` kapanış çerçevesi gönderip TCP'nin yarısını kapatıyordu; webOS 26 karşılık
veriyor, webOS 4.5 vermiyor → soket yarı açık kalıyor, Node olay döngüsü boşalmıyor.
**Çözüm:** (1) `tv-ajan.mjs` → bağlanmadan önce 0,8 sn TCP yoklaması (`portAcik`), sonra `retries: 0`
(`LgSsap.connect` artık `retries` geçiriyor) → 0,8 sn. (2) `tools/ws-client.mjs` → `close()` 1 sn sonra
soketi `destroy()` eder (zamanlayıcı `unref`).
**Neden bariz olan işe yaramadı:** Panel tarafında zaman aşımını uzatmak kullanıcıyı 47 sn bekletir;
CLI'da `process.exit()` eklemek sorunu yalnız CLI'da gizler, uzun ömürlü ajanda sızıntı olarak kalırdı.

## 15.10.2026 — `.vercelignore` varken Vercel `.gitignore`'u OKUMUYOR; takma adlar eski yayına sabit

**Belirti:** `git push` sonrası site güncellenmedi; `vercel --prod` öncesi kontrolde git dışı dosyaların
(TV listesi — ev ağı adresleri, `data/yerel/` — yedekler ve TV ekran görüntüleri, seri numarası taşıyan
tarihli döküm) yayına gideceği fark edildi. Yayından sonra 6 takma adın (`kanalsirala`…) hâlâ eskiyi sunduğu görüldü.
**Kök neden:** Proje Vercel'e git ile bağlı değil (yayınlar Ağustos'ta CLI'dan). `.vercelignore` dosyası
varken Vercel yalnız onu uygular, `.gitignore`'a bakmaz. Takma adlar `vercel alias set` ile belli bir
yayına bağlanmış — projenin "son üretim yayınını izle" alan adları değiller.
**Çözüm:** `.vercelignore`'a git dışı dosyalar ayrıca eklendi; yayından sonra 7 adreste bu dosyaların
404 döndüğü doğrulandı; 6 takma ad `vercel alias set <yeni-yayın> <ad>.vercel.app` ile taşındı.
**Neden bariz olan işe yaramadı:** "`.gitignore`'da var, yayına gitmez" varsayımı; ve "yayın Ready, alias
`scm-editor.vercel.app` güncellendi" çıktısına bakıp bitti saymak — diğer adresler ölçülmeden fark edilmezdi.

## 14.10.2026 — Taşı modunda hedef seçilince yüzen satır odağı kaybediyor, OK hiçbir şey yapmıyor

**Belirti:** Sürücü "A2" kanalını (66 → 27) üç denemede de taşıyamadı ve durdu; aynı oturumda önceki 7
taşıma sorunsuzdu, liste de değişmemişti. Ekranda Taşı modu açık, odak hedefteki "27 ÜLKE TV HD"
satırında ama satır **gri**; A2'nin yüzen satırı (⇅) hiçbir yerde görünmüyor. OK'e basmak modu
kapatmıyor, hiçbir şey olmuyor.
**Kök neden:** Numara penceresinden hedef seçilince yüzen satır kavramsal olarak doğru konuma gidiyor
ama bazen odak yüzen satır yerine liste satırında kalıyor; OK gri satıra gidiyor ve yok sayılıyor.
Elle adım adım ölçüldü: bir ok tuşu yüzen satırı yeniden görünür/etkin kılıyor **ve bir sıra
kaydırıyor** (YUKARI → hedefin bir üstü); ters yöndeki tuş onu hedefe geri getiriyor.
**Çözüm:** `tools/net/lg-editor.mjs` → `move()`: hedef seçildikten sonra her seferinde
YUKARI + AŞAĞI (hedef listenin en üstüyse AŞAĞI + YUKARI — en üstte YUKARI işlemez), sonra OK.
Normal durumda da zararsız: yüzen satır bir çıkıp bir iniyor. Sonraki 40 taşımada bu hata görülmedi.
**Neden bariz olan işe yaramadı:** Daha uzun beklemek çözmüyor — elle denemede saniyelerce beklendi,
satır yine gelmedi. Hata deterministik değil (aynı oturumda 100 → 20 gibi daha uzun atlamalar
sorunsuzdu), bu yüzden "uzun atlamada şunu yap" gibi koşullu bir kural kurulamıyor; nudge her
taşımada yapılıyor. Yalnız ok tuşlarıyla taşımak (numara penceresiz) yüzlerce tuş demek.

## 13.10.2026 — TV, seçilen kanalın transponderini kendiliğinden yeniliyor; kanal kimliği değişiyor

**Belirti:** 55 taşımalık sıralama 7. taşımadan sonra `istenen sıradaki kanal TV listesinde yok:
122_30_11301_0` hatasıyla durdu. Kanal sayısı çalışma sırasında 429'dan 432'ye çıktı,
"CNN TURK HD" adı "CNN TÜRK HD" oldu, o sırada yapılan Bloomberg HT taşıması yarıda kaldı
(ekranda kanal seçili ama taşınmamış).
**Kök neden:** Düzenleyicide bir kanalı seçmek TV'yi o kanala geçiriyor; TV geçtiği
transponderin **bütün** kayıtlarını canlı yayından yeniliyor. 12034 MHz'deki 38 kayıtta
TSID 30→3, ONID 0→66 oldu, 4 servis silindi, 12 servis eklendi. Yenileme kanala geçtikten
~10-15 sn sonra iniyor ve o an açık olan düzenleyici ekranını sıfırlıyor. Sürücü kanalı
`physicalNumber + signalChannelId` (TSID_SVCID_ONID) ile tanıyordu; kimlik değişince kanalı
kaybetti. Listedeki 663 kaydın 407'si (32 transponder) aynı bayat durumda (ONID=0) — yani bu
tek seferlik bir kaza değil, her büyük sıralamada onlarca kez olacak.
**Çözüm:** Kimlik `physicalNumber + SVCID` oldu (`tools/net/lg-editor.mjs` → `channelKey`;
güncel listede 0 tekrar, yenilemede değişmiyor). Doğrulama tam eşitlik yerine iki listede de
bulunan kanalların sırasını karşılaştırıyor (`siraTuttu`). Tutmayan adımda liste yeniden
okunup gerçek durumdan plan kuruluyor; aynı kanal 3 kez tutmazsa duruluyor. Tarif eşleştirmesine
`SVCID + frekans(±2)` katmanı eklendi (`web/lib/order.js`, 1c turu).
14.10.2026'da cihazda doğrulandı: 40 taşımalık çalışmada yenileme üç kez tetiklendi ("TİVİ 6" →
"Tivi6", "A NEWS HD" → "A NEWS" gibi), üçünde de sürücü durumu yeniden okuyup ikinci denemede taşıdı.
Çalışma boyunca TV 15 yeni servis ekledi (432 → 447).
**Neden bariz olan işe yaramadı:** "Tam DVB kimliği en güvenilir anahtardır" varsayımı bu TV'de
yanlış: TKGS'nin yazdığı TSID/ONID yer tutucu değerler ve TV onları ilk fırsatta düzeltiyor.
`channelId` zaten kanal numarasını içerdiği için taşımada değişiyor. Ada göre eşleştirme de
çözüm değil — aynı ad birden çok frekansta var ("CNN TÜRK HD" iki kez, "TRT1 HD" dört kez).
Otomatik güncellemeyi kapatmayı denemek de mümkün olmadı: `settings/getSystemSettings` kanal
kategorisi webOS 26'da `500` dönüyor, ayar ağdan okunamıyor bile.

## 13.10.2026 — "TV ekranını göremiyoruz" engeli: `tv/executeOneShot` ekran görüntüsü veriyor

**Belirti:** Ağdan yazma sürücüsü Ağustos'tan beri yazılamıyordu; kumanda tuşu gönderilebiliyor
ama menünün nerede olduğu görülemiyordu, körlemesine OK basmak riskliydi.
**Kök neden:** Eksik olan bir "göz"dü. `ssap://tv/executeOneShot` 960×540 JPEG döndürüyor ve
görüntü **arayüz katmanını da içeriyor** (bildirim balonuyla sınandı). Hiçbir yaygın
kütüphanenin belgesinde öne çıkmıyor; yalnız bscpylgtv'de var.
**Çözüm:** `tools/net/lg-screen.mjs` + `tools/tv.mjs ekran`. Tuş tarifi ekrandan çıkarıldı
(`tools/net/lg-editor.mjs` başındaki açıklama): Kanal Yöneticisi → OK → SAĞ; `<no>` OK = satıra
atla; OK = seç; SARI = Taşı; `<hedef no>` OK = konumlan; OK = bırak. Taşıma araya girme
(takas değil); numara kümesi korunuyor, boşluklar yerinde kalıyor.
**Neden bariz olan işe yaramadı:** Kullanıcıdan ekran fotoğrafı istemek her menü adımı için
insan gerektirirdi. Uç boyut/biçim parametrelerini **yok sayıyor** (1080p, PNG, "yalnız arayüz"
denendi — hep 960×540 JPEG) ve ~2,8 kare/sn veriyor; video ya da ses için kullanılamaz.
`com.webos.service.capture/executeOneShot` uzun adıyla çağrılınca `ERROR_NOT_ENOUGH_MEMORY` dönüyor.

## 13.10.2026 — webOS 26 eşleştirmeyi reddediyor: `403 … blacklisted certificate detected`

**Belirti:** Ağustos'ta çalışan `lgtv-read` aynı TV'de `403 Pairing rejected: blacklisted
certificate detected` verdi; ekranda onay kutusu bile çıkmadı.
**Kök neden:** TV yazılımı webOS 25'ten 26'ya (43.x) güncellenmiş. LG, bütün üçüncü taraf
kütüphanelerin taşıdığı 2014 tarihli `test-signing-cert` imzasını kara listeye aldı. Reddedilen
şey manifestteki `signatures` bloğu; `appId` önemsiz.
**Çözüm:** `tools/net/lg-ssap.mjs` → `unsignedHandshake()`: önce imzalı manifest, yalnız bu
403'te `signed` + `signatures` atılıp imzalı izinler dış listeye katılarak yeniden denenir.
Ağustos'ta alınan anahtar imzasız manifestle, yeni onay istemeden kabul edildi.
**Neden bariz olan işe yaramadı:** İmzayı her zaman atmak (aiowebostv ≥ 0.9.2'nin yaptığı) eski
TV'de (webOS 4.5) hâlâ geçerli olan imzalı izinleri gereksiz yere kaybettirir. İmzalı izinleri
dış listeye taşımak onları geri getirmiyor: `getCurrentSWInformation` webOS 26'da kalıcı olarak
`401` — yazılım sürümü bu uçtan artık okunamıyor.

## 13.10.2026 — Ev ağı değişince eşleştirme anahtarları "kayboldu"

**Belirti:** İki TV için de "eşleştirme anahtarı yok" — oysa `.lgtv-clients.json` doluydu.
**Kök neden:** Anahtar deposu IP'ye göre anahtarlanıyor; ev ağı 24.08.2026'da
`192.168.1.0/24` → `10.63.0.0/24` taşındı. Anahtar TV'ye bağlı, adrese değil.
**Çözüm:** Anahtarlar yeni adreslere elle kopyalandı (eski kayıtlar duruyor). Kalıcı çözüm
(cihaz kimliğine bağlamak) yapılmadı — `scm-editor_tara.md` Ö-38.
**Neden bariz olan işe yaramadı:** Yeniden eşleşmek TV başında birinin onay vermesini gerektirir;
oda TV'si kapalıyken mümkün değildi.

<!-- Yeni girişler EN ÜSTE eklenir (en yeni önce). Biçim:

## GG.AA.YYYY — <sorun tek cümlede>

**Belirti:** Ne görüldü — hata mesajı, yanlış çıktı ya da sessiz başarısızlık.
**Kök neden:** Belirtinin kendisi değil, altındaki gerçek sebep.
**Çözüm:** Ne yapıldı — `dosya:satır`, komut, ayar.
**Neden bariz olan işe yaramadı:** Denenip elenen yollar. Bu kısım defterin asıl değeridir;
boş bırakılırsa giriş büyük ölçüde anlamsızlaşır.

-->
