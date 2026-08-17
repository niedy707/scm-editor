/* eslint-env browser */
/** TR/EN sözlük. Varsayılan dil Türkçe. */
(function (root) {
  'use strict';

  const DICT = {
    tr: {
      tagline: 'dosyan cihazından çıkmaz',
      dropTitle: 'GlobalClone00001.TLL dosyasını buraya sürükle',
      dropHint: 'veya seçmek için tıkla · dosya tarayıcının dışına çıkmaz',
      howTitle: "Dosyayı TV'den nasıl alırım?",
      how1: "<b>Tüm Ayarlar → Kanallar → Kanal Kopyalama → TV'den USB'ye</b> (uydu modellerinde)",
      how2: 'USB bellek <b>FAT32</b> olmalı, tercihen <b>16 GB veya altı</b>. NTFS/exFAT\'te TV bozuk dosya yazıyor.',
      how3: 'Dosyanın adını <b>değiştirme</b>. TV yalnız <code>GlobalClone00001.TLL</code> adını kabul ediyor.',
      how4: 'Eski model (2014 öncesi) ise menüde bu seçenek yoktur; kumandada Ayarlar\'a basılı tutup <code>1105</code> girilir.',
      howNote:
        'Kurulumda operatör listesi (ör. "Türksat TKGS → Sabit") seçilmişse liste ön-sıralı gelir ve elle sıralama kilitlenir. Sıralama yapabilmek için <b>Esnek</b> modu ya da operatörsüz tam tarama gerekir.',
      btnOriginal: 'Orijinali indir',
      btnClose: 'Kapat',
      searchPh: 'Kanal ara…',
      fAll: 'Tümü', fTv: 'Sadece TV', fRadio: 'Sadece radyo', fFta: 'Şifresiz',
      fScr: 'Şifreli', fChanged: 'Değişenler',
      undo: 'Geri al', redo: 'İleri al',
      btnRestore: 'Eski sıramı uygula…',
      thNo: 'No', thName: 'Kanal adı', thType: 'Tür', thFreq: 'Frekans',
      thSat: 'Uydu', thTurksat: "Türksat'a göre", thFlags: 'Durum',
      noRows: 'Eşleşen kanal yok.',
      btnSave: 'Kaydet (.TLL indir)',
      rTitle: 'Eski sıramı yeni listeye uygula',
      rIntro:
        'Yeniden tarama sıralamanı sıfırladıysa, eski sıranı buraya yükle. Kanallar kimlik (SVCID/TSID/ONID), ad ve PID üzerinden eşleştirilir; frekans yalnız son çare olarak ve ±2 MHz toleransla kullanılır.',
      rPick: 'Dosya seç (TV dökümü / sıra tarifi / CSV)',
      rHowTitle: 'Eski sıran nereden gelir?',
      rHow1: '<code>node tools/lgtv-read.mjs &lt;TV-IP&gt;</code> ile TV\'den WiFi üzerinden okunan JSON',
      rHow2: 'Daha önce bu araçtan indirdiğin <b>sıra tarifi</b> (.json)',
      rHow3: 'Eski bir <code>.TLL</code> dosyasını açıp "sıra tarifi indir" ile ürettiğin dosya',
      rHow4: 'CSV: <code>no;ad</code> sütunlu basit tablo',
      rExport: 'Bu listenin sıra tarifini indir',
      rApply: 'Sırayı uygula',
      cancel: 'Vazgeç',
      pTitle: 'Kaydetmeden önce',
      pDownload: 'İndir',
      radio: 'radyo', tv: 'TV',
      changed: 'değişti',
      noChange: 'Hiçbir değişiklik yok — dosya girdiyle birebir aynı inecek.',
      changeCount: (n) => `${n} kanalda değişiklik var`,
      matchSummary: (m, n, o) => `${m} kanal eşleşti · ${n} yeni · ${o} kaybolan`,
      applied: (n) => `${n} kanalın numarası güncellendi`,
      savedAs: (f) => `${f} indirildi`,
      errRead: 'Dosya okunamadı',
      protectedField: 'Korumalı alan',
    },
    en: {
      tagline: 'your file never leaves this device',
      dropTitle: 'Drop your GlobalClone00001.TLL here',
      dropHint: 'or click to pick · the file never leaves your browser',
      howTitle: 'How do I get the file off the TV?',
      how1: '<b>All Settings → Channels → Copy Channels → TV to USB</b> (satellite models)',
      how2: 'The USB stick must be <b>FAT32</b>, preferably <b>16 GB or smaller</b>. On NTFS/exFAT the TV writes a corrupt file.',
      how3: '<b>Do not rename</b> the file. The TV only accepts <code>GlobalClone00001.TLL</code>.',
      how4: 'On pre-2014 models this menu item does not exist; hold Settings on the remote and enter <code>1105</code>.',
      howNote:
        'If an operator list was chosen during setup (e.g. "Turksat TKGS → Fixed"), the list comes pre-ordered and manual sorting is locked. You need <b>Flexible</b> mode or a full scan without an operator.',
      btnOriginal: 'Download original',
      btnClose: 'Close',
      searchPh: 'Search channels…',
      fAll: 'All', fTv: 'TV only', fRadio: 'Radio only', fFta: 'Free to air',
      fScr: 'Encrypted', fChanged: 'Changed',
      undo: 'Undo', redo: 'Redo',
      btnRestore: 'Apply my old order…',
      thNo: 'No', thName: 'Channel name', thType: 'Type', thFreq: 'Frequency',
      thSat: 'Satellite', thTurksat: 'Per Türksat', thFlags: 'Flags',
      noRows: 'No matching channels.',
      btnSave: 'Save (download .TLL)',
      rTitle: 'Apply my old order to the new list',
      rIntro:
        'If a re-scan reset your order, load your old order here. Channels are matched by identity (SVCID/TSID/ONID), name and PIDs; frequency is only a last resort, with ±2 MHz tolerance.',
      rPick: 'Pick a file (TV dump / order recipe / CSV)',
      rHowTitle: 'Where does the old order come from?',
      rHow1: 'JSON read from the TV over WiFi via <code>node tools/lgtv-read.mjs &lt;TV-IP&gt;</code>',
      rHow2: 'An <b>order recipe</b> (.json) you exported from this tool earlier',
      rHow3: 'A recipe exported from an older <code>.TLL</code> file',
      rHow4: 'CSV with <code>number;name</code> columns',
      rExport: 'Export this list as an order recipe',
      rApply: 'Apply order',
      cancel: 'Cancel',
      pTitle: 'Before saving',
      pDownload: 'Download',
      radio: 'radio', tv: 'TV',
      changed: 'changed',
      noChange: 'Nothing changed — the download will be byte-identical to the input.',
      changeCount: (n) => `${n} channels changed`,
      matchSummary: (m, n, o) => `${m} matched · ${n} new · ${o} missing`,
      applied: (n) => `Renumbered ${n} channels`,
      savedAs: (f) => `Downloaded ${f}`,
      errRead: 'Could not read the file',
      protectedField: 'Protected field',
    },
  };

  let lang = 'tr';

  function t(key, ...args) {
    const v = (DICT[lang] && DICT[lang][key]) ?? (DICT.tr[key] ?? key);
    return typeof v === 'function' ? v(...args) : v;
  }
  function setLang(l) { lang = DICT[l] ? l : 'tr'; apply(); }
  function getLang() { return lang; }

  function apply() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.innerHTML = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
      el.placeholder = t(el.getAttribute('data-i18n-ph'));
    });
    document.documentElement.lang = lang;
  }

  root.I18N = { t, setLang, getLang, apply };
})(window);
