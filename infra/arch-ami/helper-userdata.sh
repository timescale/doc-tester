# Runs as root on a throwaway Amazon Linux 2023 helper box (docs/adr/0008). build.sh prepends the lines
# IMAGE_FILE, BASE_URL, PIN and KEY_B64, then this file. It downloads Arch's official cloud image,
# verifies it, writes it to the spare 4 GiB volume, tags itself with the result and powers off. build.sh
# watches for the tag and does the snapshot and AMI from outside.
set -euo pipefail
exec > >(tee -a /var/log/arch-build.log >/dev/console) 2>&1

# The result goes back to build.sh as tags on this instance (the console output is not reliably
# captured). The instance profile build.sh attaches allows exactly ec2:CreateTags on this instance.
# Tag values allow letters, digits, spaces and + - = . _ : / @ only, 256 characters at most.
report() {
  local tok iid
  tok=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60') || return 0
  iid=$(curl -fsS -H "X-aws-ec2-metadata-token: $tok" http://169.254.169.254/latest/meta-data/instance-id) || return 0
  aws ec2 create-tags --region "${AWS_REGION:-us-east-1}" --resources "$iid" \
    --tags "Key=arch-build,Value=$1" "Key=arch-build-detail,Value=$(echo "$2" | tr -c 'A-Za-z0-9 _.:/=@+-' ' ' | tail -c 240)" || true
}
trap 'report failed "line $LINENO: $(tail -n 4 /var/log/arch-build.log | tr "\n" " ")"; shutdown -h now' ERR

dnf install -y -q qemu-img gdisk

# The spare volume is the one disk that is not the root disk and is exactly 4 GiB with nothing on it.
ROOTDISK=$(lsblk -no PKNAME "$(findmnt -n -o SOURCE /)")
DEV=$(lsblk -dnbpo NAME,TYPE,SIZE | awk -v r="/dev/$ROOTDISK" '$2=="disk" && $1!=r && $3==4294967296 {print $1}')
[ -n "$DEV" ] && [ "$(echo "$DEV" | wc -l)" = 1 ] || { echo "no single spare 4 GiB disk found"; false; }
[ -z "$(lsblk -no NAME "$DEV" | sed 1d)" ] || { echo "$DEV already has partitions"; false; }
echo "target disk: $DEV"

cd /tmp
export GNUPGHOME=/tmp/gnupg
mkdir -m 700 "$GNUPGHOME"
# gnupg2-minimal (the AL2023 default) has no gpg-agent; without this gpg tries to start one and exits 2.
echo no-autostart > "$GNUPGHOME/gpg.conf"
echo "$KEY_B64" | base64 -d > arch-boxes.asc
gpg --batch --quiet --import arch-boxes.asc
gpg --batch --with-colons --list-keys | awk -F: '$1=="fpr"{print $10}' | grep -qx "$PIN" || { echo "pinned key $PIN not in the key block"; false; }

curl -fsS --retry 5 -o "$IMAGE_FILE" "$BASE_URL/$IMAGE_FILE"
curl -fsS --retry 5 -o "$IMAGE_FILE.SHA256" "$BASE_URL/$IMAGE_FILE.SHA256"
curl -fsS --retry 5 -o "$IMAGE_FILE.SHA256.sig" "$BASE_URL/$IMAGE_FILE.SHA256.sig"

# Authenticity: the checksum file must be signed by the pinned arch-boxes key (primary fingerprint is
# the last field of VALIDSIG). Integrity: the image must match the checksum file.
gpg --batch --status-fd 1 --verify "$IMAGE_FILE.SHA256.sig" "$IMAGE_FILE.SHA256" > verify.out 2>&1 || true
grep -q "^\[GNUPG:\] VALIDSIG .* $PIN\$" verify.out || { cat verify.out; echo "signature not valid for pinned key"; false; }
sha256sum -c "$IMAGE_FILE.SHA256"

qemu-img convert -f qcow2 -O raw "$IMAGE_FILE" "$DEV"
# The image is 2 GiB and the volume 4: move the backup GPT header to the end of the disk.
sgdisk -e "$DEV" > /dev/null
sync
partprobe "$DEV" || true
LAYOUT=$(sgdisk -p "$DEV" 2>&1 || true)
echo "$LAYOUT"
echo "$LAYOUT" | grep -q 'EF02' && echo "$LAYOUT" | grep -q 'EF00' || { echo "expected BIOS boot and EFI system partitions"; false; }

SHA=$(cut -d' ' -f1 "$IMAGE_FILE.SHA256")
echo "ARCH-IMAGE-OK sha256=$SHA"
report ok "sha256=$SHA"
shutdown -h now
