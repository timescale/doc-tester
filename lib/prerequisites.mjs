// The prerequisites a bare plan declares with `needs:` (docs/adr/0011): what the guide says you need
// before step 1 and does not script. The harness installs each over SSM, as root, before the walker's
// first command, using the thing's own official installer, and probes it AS THE BOX'S DEFAULT USER, so
// "provided" means a reader on this box could use it, not merely that a package landed. Versions are
// recorded, not pinned: a guide failing because Docker changed is something a reader would hit too.
//
// NEEDS in lib/plan.mjs says which distros each token can be provided on, and a row here must exist for
// each of them (scripts/check-needs.mjs). A distro plan declares no prerequisites, so its box stays bare.
import { sendCommand, bareUser } from "./ec2.mjs";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// -> { install(user): shell script, probe: command run as the user that prints the version }
export const INSTALLERS = {
  docker: {
    ubuntu: {
      install: (user) => [
        "set -eu",
        "export DEBIAN_FRONTEND=noninteractive",
        // Docker's own convenience script, the install the guide's "get Docker" link leads to.
        "curl -fsSL https://get.docker.com | sh",
        "systemctl enable --now docker",
        // Without this a reader's first `docker run` is "permission denied", and they would not call
        // that Docker installed. `sudo -u <user>` picks the new group up on its next invocation.
        `usermod -aG docker ${user}`,
      ].join("\n"),
      // The server version, so the probe fails if the daemon is not reachable without sudo.
      probe: "docker version --format 'docker {{.Server.Version}}'",
    },
  },
  psql: {
    ubuntu: {
      install: () => ["set -eu", "export DEBIAN_FRONTEND=noninteractive", "apt-get update -qq", "apt-get install -y -qq postgresql-client"].join("\n"),
      probe: "psql --version",
    },
  },
  // A cluster the reader's kubectl can reach (docs/adr/0011, step 4b): k3s, the UPSTREAM kubectl at the
  // version k3s serves, and the kubeconfig in the default user's ~/.kube/config. k3s's own `kubectl`
  // symlink ignored that file and failed every step on the second run; the guide's prerequisite is the
  // upstream tool anyway. Each step that could leave a box looking provided when it is not stops the
  // script: the installer is downloaded before it is run (`curl | sh -` runs an empty script, and
  // succeeds, when the download fails), the version must be readable, and the checksum must match
  // before kubectl replaces anything. kubectl replaces k3s's symlink by rename, not by writing through it.
  kubernetes: {
    ubuntu: {
      install: (user) => [
        "set -eu",
        "export DEBIAN_FRONTEND=noninteractive",
        "tmp=$(mktemp -d); trap 'rm -rf \"$tmp\"' EXIT",
        'curl -sfL https://get.k3s.io -o "$tmp/k3s-install.sh"',
        'sh "$tmp/k3s-install.sh"',
        "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml",
        "for i in $(seq 1 60); do k3s kubectl get nodes 2>/dev/null | grep -q ' Ready' && break; sleep 2; done",
        // kubectl is published as vX.Y.Z; k3s reports vX.Y.Z+k3sN
        "ver=$(k3s --version | sed -n '1s/^k3s version \\(v[0-9.]*\\).*/\\1/p'); [ -n \"$ver\" ]",
        "arch=$(dpkg --print-architecture)",
        'curl -fsSLo "$tmp/kubectl" "https://dl.k8s.io/release/$ver/bin/linux/$arch/kubectl"',
        'curl -fsSLo "$tmp/kubectl.sha256" "https://dl.k8s.io/release/$ver/bin/linux/$arch/kubectl.sha256"',
        'echo "$(cat "$tmp/kubectl.sha256")  $tmp/kubectl" | sha256sum --check',
        'install -m 0755 "$tmp/kubectl" /usr/local/bin/kubectl.new',
        "mv -f /usr/local/bin/kubectl.new /usr/local/bin/kubectl",
        `home=$(getent passwd ${user} | cut -d: -f6)`,
        `install -d -o ${user} -g ${user} -m 700 "$home/.kube"`,
        `install -o ${user} -g ${user} -m 600 /etc/rancher/k3s/k3s.yaml "$home/.kube/config"`,
      ].join("\n"),
      // As the default user, with no KUBECONFIG: the node is Ready, and both versions are recorded.
      probe: [
        "set -e",
        "kubectl wait --for=condition=Ready node --all --timeout=120s > /dev/null",
        'echo "k3s $(kubectl get nodes -o jsonpath=\'{.items[0].status.nodeInfo.kubeletVersion}\'), kubectl $(kubectl version --client | head -1 | sed \'s/^Client Version: //\')"',
      ].join("\n"),
    },
  },
};

const runScript = (send, id, script, timeoutMs) =>
  send(id, `printf %s '${b64(script)}' | base64 -d > /tmp/doctest-need.sh; bash /tmp/doctest-need.sh; rc=$?; rm -f /tmp/doctest-need.sh; exit $rc`, { timeoutMs });

// A probe is a script file run as the default user, not a `bash -c "<string>"`: a `$(...)` in a string is
// expanded by the shell that receives it, which is not the user's.
const runProbe = (send, id, user, probe) =>
  send(id, `printf %s '${b64(probe)}' | base64 -d > /tmp/doctest-probe.sh; chmod 644 /tmp/doctest-probe.sh; sudo -u ${user} -H bash /tmp/doctest-probe.sh; rc=$?; rm -f /tmp/doctest-probe.sh; exit $rc`, { timeoutMs: 2 * 60 * 1000 + 30_000 });

const why = (inv) => (inv.StandardErrorContent || inv.StandardOutputContent || inv.Status || "").trim().split("\n").slice(-4).join(" | ");

/**
 * Install `needs` on the box and probe each as its default user. -> [{ need, version }].
 * Throws with the first thing that went wrong, so the caller can mark the run blocked instead of
 * letting the walker fail on a `docker: command not found` that is the harness's fault, not the guide's.
 */
export async function provide(instanceId, os, needs, { log = console.log, send = sendCommand } = {}) {
  const user = bareUser(os);
  const provided = [];
  for (const need of needs) {
    const row = INSTALLERS[need]?.[os];
    if (!row) throw new Error(`no installer for \`needs: ${need}\` on ${os}`);
    log(`  providing ${need} on ${os}...`);
    const inst = await runScript(send, instanceId, row.install(user), 10 * 60 * 1000);
    if (inst.Status !== "Success") throw new Error(`installing ${need} failed: ${why(inst)}`);
    const probe = await runProbe(send, instanceId, user, row.probe);
    if (probe.Status !== "Success") throw new Error(`${need} is installed but not usable by ${user} without sudo: ${why(probe)}`);
    const version = (probe.StandardOutputContent || "").trim().split("\n")[0];
    log(`  provided: ${version}`);
    provided.push({ need, version });
  }
  return provided;
}
