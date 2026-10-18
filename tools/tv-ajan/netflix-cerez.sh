#!/usr/bin/env bash
# Netflix oturum çerezlerini evdeki TV ajanına (pi63) kaydeder — izleme geçmişinden başlık doğrulaması için.
# Değerler ekranda GÖRÜNMEZ (read -s), kabuk geçmişine, koda, git'e, sohbete girmez; pi63'te yalnız ajan
# kullanıcısının okuyabildiği dosyaya yazılır (600, tvajan).
#
#   bash tools/tv-ajan/netflix-cerez.sh            # varsayılan hedef: pi63
#   bash tools/tv-ajan/netflix-cerez.sh --sil      # çerez dosyasını siler
#
# Değerler: tarayıcıda netflix.com'a giriş → Geliştirici araçları → Application → Cookies → netflix.com →
# NetflixId ve SecureNetflixId satırlarının "Value" sütunu.
set -euo pipefail
HEDEF=pi63
DOSYA=/var/lib/tv-ajan/netflix.cerez

if [ "${1:-}" = "--sil" ]; then
  ssh "$HEDEF" "sudo rm -f $DOSYA && echo 'silindi: $DOSYA'"
  exit 0
fi

read -rsp "NetflixId (yapıştır, görünmez): " NID; echo
read -rsp "SecureNetflixId (yapıştır, görünmez): " SNID; echo
if [ -z "$NID" ] || [ -z "$SNID" ]; then echo "İkisi de gerekli — hiçbir şey kaydedilmedi."; exit 1; fi

printf 'NETFLIX_ID=%s\nSECURE_NETFLIX_ID=%s\n' "$NID" "$SNID" |
  ssh "$HEDEF" "sudo sh -c 'umask 077; cat > $DOSYA; chown tvajan:tvajan $DOSYA' && echo 'kaydedildi: $DOSYA (yalnız ajan okur)'"
unset NID SNID
