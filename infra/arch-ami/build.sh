#!/usr/bin/env bash
# One-time (and per-refresh) build of the Arch Linux AMI for the `arch` bare target (docs/adr/0008).
#
# Arch publishes no AMI of its own, only a signed cloud image (qcow2). This turns that image into an
# AMI the account owns: a throwaway Amazon Linux 2023 helper box downloads the image, checks its
# signature against the pinned arch-boxes key (arch-boxes.asc) and its SHA256, and writes it to a spare
# EBS volume; this script then snapshots the volume, registers the AMI and cleans up. The tool's
# `docs-tester` user is deliberately not allowed to create volumes, snapshots or images (docs/adr/0003),
# so run this with ADMIN credentials for the same account the tool runs in, and name that account:
#
#   AWS_PROFILE=<admin profile> EXPECTED_ACCOUNT=<12-digit account id> infra/arch-ami/build.sh
#
# The AMI is named doc-testing-tool-arch-<image version>. infra/network.tf finds the newest one by that
# prefix, so a refresh is just running this again. Env: IMAGE_FILE (pin an image instead of the newest),
# EXPECTED_ACCOUNT, REGION (us-east-1), YES=1 (skip the confirmation).
set -euo pipefail

REGION=${REGION:-us-east-1}
EXPECTED_ACCOUNT=${EXPECTED_ACCOUNT:?set EXPECTED_ACCOUNT to the 12-digit id of the AWS account the tool runs in}
BASE_URL=https://geo.mirror.pkgbuild.com/images/latest
# Primary fingerprint of the arch-boxes CI key (the one that signs the image checksums).
PIN=1B9A16984A4E8CB448712D2AE0B78BF4326C6F8F
HERE=$(cd "$(dirname "$0")" && pwd)
export AWS_DEFAULT_REGION=$REGION AWS_PAGER=""

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
[ "$ACCOUNT" = "$EXPECTED_ACCOUNT" ] || { echo "running in account $ACCOUNT, expected $EXPECTED_ACCOUNT (EXPECTED_ACCOUNT names the account this must run in)"; exit 1; }
echo "account $ACCOUNT as $(aws sts get-caller-identity --query Arn --output text)"

IMAGE_FILE=${IMAGE_FILE:-$(curl -fsS "$BASE_URL/" | grep -o 'Arch-Linux-x86_64-cloudimg-[0-9.]*\.qcow2' | sort -u | tail -1)}
[ -n "$IMAGE_FILE" ] || { echo "could not find an image name at $BASE_URL"; exit 1; }
VERSION=${IMAGE_FILE#Arch-Linux-x86_64-cloudimg-}; VERSION=${VERSION%.qcow2}
AMI_NAME=doc-testing-tool-arch-$VERSION

EXISTING=$(aws ec2 describe-images --owners self --filters "Name=name,Values=$AMI_NAME" --query 'Images[0].ImageId' --output text)
if [ "$EXISTING" != "None" ]; then echo "already built: $AMI_NAME is $EXISTING"; exit 0; fi

echo "will build $AMI_NAME from $BASE_URL/$IMAGE_FILE in $REGION"
echo "creates: one t3.small helper (terminated at the end), one 4 GiB volume (deleted), a tag-only IAM role for the helper (deleted), one snapshot and one AMI (kept)"
if [ "${YES:-}" != 1 ]; then read -r -p "proceed? [y/N] " ans; [ "$ans" = y ] || exit 1; fi

VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
[ "$VPC" != None ] || { echo "no default VPC in $REGION"; exit 1; }
# us-east-1a, as infra/network.tf pins: us-east-1e in this account has no t3.
SUBNET=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC" Name=default-for-az,Values=true Name=availability-zone,Values=${REGION}a --query 'Subnets[0].SubnetId' --output text)
[ "$SUBNET" != None ] || { echo "no default subnet in ${REGION}a"; exit 1; }
SG=$(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC" Name=group-name,Values=default --query 'SecurityGroups[0].GroupId' --output text)
BASE_AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text)

UD=$(mktemp)
{
  echo '#!/bin/bash'
  echo "IMAGE_FILE='$IMAGE_FILE'"
  echo "BASE_URL='$BASE_URL'"
  echo "PIN='$PIN'"
  echo "AWS_REGION='$REGION'"
  echo "KEY_B64='$(base64 < "$HERE/arch-boxes.asc" | tr -d '\n')'"
  cat "$HERE/helper-userdata.sh"
} > "$UD"

# The helper reports back by tagging itself, so it gets a role that can do exactly that and nothing else.
ROLE=doc-testing-tool-arch-ami-builder
if ! aws iam get-role --role-name "$ROLE" > /dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' > /dev/null
  aws iam put-role-policy --role-name "$ROLE" --policy-name tag-self --policy-document \
    "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"ec2:CreateTags\",\"Resource\":\"arn:aws:ec2:$REGION:$ACCOUNT:instance/*\",\"Condition\":{\"StringEquals\":{\"ec2:ResourceTag/Name\":\"doc-testing-tool-arch-ami-builder\"}}}]}"
fi
if ! aws iam get-instance-profile --instance-profile-name "$ROLE" > /dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$ROLE" > /dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
fi

HELPER=""; VOL=""; SNAP=""
cleanup_hint() {
  echo
  echo "FAILED. Left for inspection: helper=${HELPER:-none} volume=${VOL:-none} snapshot=${SNAP:-none}"
  echo "clean up with: aws ec2 terminate-instances --instance-ids ${HELPER:-<id>}; aws ec2 delete-volume --volume-id ${VOL:-<id>}"
  echo "(the helper's IAM role/profile $ROLE is reused by the next run; the success path deletes it)"
}
trap 'cleanup_hint' ERR

# A new instance profile can take several seconds to be usable, so retry on that one error.
ERRF=$(mktemp)
for _ in $(seq 1 12); do
  HELPER=$(aws ec2 run-instances --image-id "$BASE_AMI" --instance-type t3.small --subnet-id "$SUBNET" \
    --security-group-ids "$SG" --associate-public-ip-address --instance-initiated-shutdown-behavior stop \
    --iam-instance-profile "Name=$ROLE" --metadata-options HttpTokens=required,HttpPutResponseHopLimit=2 \
    --user-data "file://$UD" \
    --block-device-mappings '[{"DeviceName":"/dev/sdf","Ebs":{"VolumeSize":4,"VolumeType":"gp3","DeleteOnTermination":false}}]' \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=doc-testing-tool-arch-ami-builder}]' \
                         'ResourceType=volume,Tags=[{Key=Name,Value=doc-testing-tool-arch-ami-builder}]' \
    --query 'Instances[0].InstanceId' --output text 2> "$ERRF") && break
  grep -qi 'instance profile\|iamInstanceProfile' "$ERRF" || { cat "$ERRF"; false; }
  sleep 5
done
rm -f "$ERRF"
[ -n "$HELPER" ] || { echo "could not launch the helper"; false; }

state() { aws ec2 describe-instances --instance-ids "$HELPER" --query 'Reservations[0].Instances[0].State.Name' --output text; }
tagval() { aws ec2 describe-instances --instance-ids "$HELPER" --query "Reservations[0].Instances[0].Tags[?Key=='$1'].Value | [0]" --output text; }

echo "helper $HELPER launched; waiting for it to report (usually 3-5 minutes)"
RESULT=None
for _ in $(seq 1 90); do
  RESULT=$(tagval arch-build)
  [ "$RESULT" != None ] && break
  [ "$(state)" = terminated ] && break
  sleep 10
done
DETAIL=$(tagval arch-build-detail)
echo "helper result: $RESULT ($DETAIL)"
[ "$RESULT" = ok ] || { echo "helper did not report ok"; false; }
SHA=${DETAIL#sha256=}

# It powers itself off right after reporting; the snapshot is taken from a stopped, synced volume.
for _ in $(seq 1 60); do [ "$(state)" = stopped ] && break; sleep 5; done
[ "$(state)" = stopped ] || { echo "helper did not stop"; false; }

VOL=$(aws ec2 describe-instances --instance-ids "$HELPER" \
  --query "Reservations[0].Instances[0].BlockDeviceMappings[?DeviceName=='/dev/sdf'].Ebs.VolumeId | [0]" --output text)
SNAP=$(aws ec2 create-snapshot --volume-id "$VOL" --description "Arch Linux cloud image $VERSION (official, signature and sha256 verified)" \
  --tag-specifications "ResourceType=snapshot,Tags=[{Key=Name,Value=$AMI_NAME}]" --query SnapshotId --output text)
echo "snapshot $SNAP; waiting"
aws ec2 wait snapshot-completed --snapshot-ids "$SNAP"

# The image has BIOS and UEFI GRUB, so uefi-preferred boots wherever the instance type allows it.
AMI=$(aws ec2 register-image --name "$AMI_NAME" --description "Arch Linux official cloud image $VERSION" \
  --architecture x86_64 --root-device-name /dev/xvda --virtualization-type hvm --ena-support --boot-mode uefi-preferred \
  --block-device-mappings "DeviceName=/dev/xvda,Ebs={SnapshotId=$SNAP,VolumeType=gp3,DeleteOnTermination=true}" \
  --tag-specifications "ResourceType=image,Tags=[{Key=Name,Value=$AMI_NAME},{Key=source,Value=$BASE_URL/$IMAGE_FILE},{Key=sha256,Value=$SHA}]" \
  --query ImageId --output text)
aws ec2 wait image-available --image-ids "$AMI"

aws ec2 terminate-instances --instance-ids "$HELPER" > /dev/null
aws ec2 wait instance-terminated --instance-ids "$HELPER"
aws ec2 delete-volume --volume-id "$VOL"
aws iam remove-role-from-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
aws iam delete-instance-profile --instance-profile-name "$ROLE"
aws iam delete-role-policy --role-name "$ROLE" --policy-name tag-self
aws iam delete-role --role-name "$ROLE"
trap - ERR
rm -f "$UD"
echo
echo "done: $AMI ($AMI_NAME), sha256 $SHA"
echo "helper terminated, working volume and helper role deleted; the snapshot $SNAP backs the AMI and stays."
