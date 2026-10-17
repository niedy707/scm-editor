#!/usr/bin/env bash
# ── TV ajanı kurulumu (pi63 / Debian) ──
#
# Kullanım (pi63'te, depo düzeninde kopyalanmış kaynak klasöründe):
#   sudo ./tools/tv-ajan/kur.sh
#
# Tekrar çalıştırılabilir: var olanı günceller. /etc/tv-ajan.env zaten varsa ÜZERİNE
# YAZMAZ — belirteç değişirse panel bağlantısı kopar.
#
# Kaynak klasörde depo dışı iki dosya da olmalı (ilk kurulumda; sonra /opt'takiler kalır):
#   tv-ajan.tvler.json   TV listesi (yerel adresler + uzaktan açma için MAC)
#   .lgtv-clients.json   TV eşleşme anahtarları
set -euo pipefail

HEDEF=/opt/tv-ajan
AYAR=/etc/tv-ajan.env
KAYNAK="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

[[ $EUID -eq 0 ]] || { echo "Bu betik root gerektirir:  sudo $0"; exit 1; }

echo "── 1/6  Node.js"
SURUM=$(node -p 'process.versions.node.split(".")[0]')
(( SURUM >= 20 )) || { echo "!!  Node $SURUM — en az 20 gerekli"; exit 1; }
echo "     Node $(node -v) ✓"

echo "── 2/6  Servis kullanıcısı"
id -u tvajan >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin tvajan
echo "     tvajan ✓"

echo "── 3/6  Dosyalar → $HEDEF"
# tv-ajan.mjs bunların hepsini içe aktarıyor — eksik biri servisi MODULE_NOT_FOUND ile düşürür.
DOSYALAR=(
  tools/tv-ajan.mjs tools/ws-client.mjs tools/ssap-handshake.json
  tools/net/lg-ssap.mjs tools/net/lg-input.mjs tools/net/lg-screen.mjs tools/net/kanal-bul.mjs
  tools/net/rehber.mjs tools/net/wol.mjs tools/net/zamanlayici.mjs
  web/lib/order.js
)
for f in "${DOSYALAR[@]}"; do
  install -D -o root -g root -m 644 "$KAYNAK/$f" "$HEDEF/$f"
done
# Dağıtım bütünlüğü (ev-ajani Ö-5 dersi): kaynak ile kurulu dosya birebir aynı olmalı.
for f in "${DOSYALAR[@]}"; do
  A=$(sha256sum "$KAYNAK/$f" | cut -d' ' -f1); B=$(sha256sum "$HEDEF/$f" | cut -d' ' -f1)
  [[ "$A" == "$B" ]] || { echo "!!  Bütünlük bozuk: $f"; exit 1; }
done
echo "     ${#DOSYALAR[@]} dosya, sha256 doğrulandı ✓"

echo "── 4/6  TV listesi ve eşleşme anahtarları"
for f in tv-ajan.tvler.json .lgtv-clients.json; do
  if [[ -f "$KAYNAK/$f" ]]; then
    install -o root -g tvajan -m 640 "$KAYNAK/$f" "$HEDEF/$f"
    echo "     $f güncellendi"
  elif [[ -f "$HEDEF/$f" ]]; then
    echo "     $f mevcut — dokunulmadı"
  else
    echo "!!  $f yok (ne kaynakta ne $HEDEF'te)"; exit 1
  fi
done

echo "── 5/6  Ayar dosyası ($AYAR)"
if [[ -f $AYAR ]]; then
  echo "     Zaten var — dokunulmadı."
else
  TS_IP=$(tailscale ip -4 2>/dev/null | head -1)
  [[ -n "$TS_IP" ]] || { echo "!!  Tailscale adresi okunamadı (tailscale up?)"; exit 1; }
  ( umask 077; cat > "$AYAR" <<EOF
# Panelde (aqara .env) TV_AJAN_TOKEN aynı değer olmalı.
TV_AJAN_TOKEN=$(openssl rand -hex 32)
# Yalnız Tailscale adresine bağlanır: panel (VPS) buradan ulaşır, ev ağına açık değil.
TV_AJAN_HOST=$TS_IP
TV_AJAN_PORT=3027
TV_AJAN_TVLER=$HEDEF/tv-ajan.tvler.json
TV_AJAN_ANAHTARLAR=$HEDEF/.lgtv-clients.json
EOF
  )
  echo "     oluşturuldu (belirteç üretildi, ekrana yazılmadı) · adres $TS_IP:3027"
fi

echo "── 6/6  Servis"
install -o root -g root -m 644 "$KAYNAK/tools/tv-ajan/tv-ajan.service" /etc/systemd/system/tv-ajan.service
systemctl daemon-reload
systemctl enable tv-ajan >/dev/null
systemctl restart tv-ajan
sleep 3
systemctl is-active --quiet tv-ajan && echo "     tv-ajan çalışıyor ✓" || { echo "!!  tv-ajan başlamadı:"; journalctl -u tv-ajan -n 20 --no-pager; exit 1; }
journalctl -u tv-ajan -n 3 --no-pager
