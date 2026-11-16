// What `wait up to Ns for postgres in container `name`` runs on the box (docs/adr/0011), as the box's
// default user, the way a reader's `docker` runs. It is one script, not one SSM call per poll, so the
// polling interval is 1s and not an SSM round trip.
//
// Ready means `pg_isready` over TCP inside the container. Not the socket: the official image runs a
// temporary server on the socket alone while it initialises, and a socket probe would call that ready.
// A container that is gone or has exited fails at once with its own log, because waiting out the limit
// on a container that has died (the HA image exits when its data folder is not writable) would only
// delay the same answer.
//
// The limit is counted in sleeps, not read off the clock: whole-second timestamps cross a second boundary
// between two reads a tenth of a second apart, which would end a 2s wait after 1.1s. Probe time is on top, so
// a wait is never shorter than its limit and `waited Ns` is a floor.
//
// Exit 0 prints `waited Ns`; every failure exits non-zero and prints why, then the container's last log.
export function waitScript(container, seconds) {
  if (!/^[A-Za-z0-9][\w.-]*$/.test(container) || !Number.isInteger(seconds) || seconds < 1) throw new Error(`refusing to wait on "${container}" for ${seconds}s`);
  return `
name='${container}'; limit=${seconds}; waited=0
tail_log() { docker logs --tail 12 "$name" 2>&1 | sed 's/^/  | /'; }
while :; do
  state=$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null) || { echo "there is no container named $name"; exit 3; }
  if [ "$state" != running ]; then echo "container $name is $state, not running:"; tail_log; exit 4; fi
  if docker exec "$name" pg_isready -q -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then echo "waited \${waited}s"; exit 0; fi
  if [ "$waited" -ge "$limit" ]; then echo "postgres in container $name was not accepting connections after \${limit}s:"; tail_log; exit 5; fi
  sleep 1; waited=$((waited + 1))
done
`.trim();
}

// What the pod forms of `wait` run on the box (docs/adr/0011, step 4b). One loop with two ready-tests, so
// what counts as "fail at once" cannot differ between them:
//
//   ``wait up to Ns for postgres in pod `name` ``  probes `pg_isready` over TCP through `kubectl exec`. NOT
//     `kubectl wait --for=condition=ready`: the guide's StatefulSet has no readiness probe, so on k3s the
//     pod is Ready the moment its container starts, with initdb still running (observed on four runs).
//   ``wait up to Ns for pod `name` ready``  the Kubernetes Ready condition, for a pod that runs no postgres
//     (the guide's `test-pod` runs `sleep infinity`, where Ready means running). A bot reaches the
//     `kubectl exec` into it two seconds after `kubectl run`, and the container is not there yet: on the first
//     box run, `container not found ("test-pod")`, a failure no reader would see.
//
// A pod that is gone, or whose container has terminated or is in CrashLoopBackOff, fails at once with the
// pod's events and log. A pod still pulling its image is Pending with its container waiting, which is not a
// failure: it is polled to the limit. The namespace is the reader's current context's, as for a reader whose
// guide ran `kubectl config set-context --current --namespace=...` earlier.
function podLoop(pod, seconds, { ready, timeout }) {
  if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(pod) || pod.length > 253 || !Number.isInteger(seconds) || seconds < 1) throw new Error(`refusing to wait on pod "${pod}" for ${seconds}s`);
  return `
name='${pod}'; limit=${seconds}; waited=0
tail_log() { kubectl describe pod "$name" 2>&1 | tail -12 | sed 's/^/  | /'; kubectl logs "$name" --tail=12 2>&1 | sed 's/^/  | /'; }
while :; do
  state=$(kubectl get pod "$name" -o jsonpath='{.status.phase}|{.status.containerStatuses[0].state.terminated.reason}|{.status.containerStatuses[0].state.waiting.reason}' 2>/dev/null) || { echo "there is no pod named $name"; exit 3; }
  phase=\${state%%|*}; rest=\${state#*|}; terminated=\${rest%%|*}; waiting=\${rest#*|}
  if [ "$phase" = Failed ] || [ "$phase" = Succeeded ] || [ -n "$terminated" ] || [ "$waiting" = CrashLoopBackOff ]; then echo "pod $name is \${terminated:-\${waiting:-$phase}}, not running:"; tail_log; exit 4; fi
  if ${ready}; then echo "waited \${waited}s"; exit 0; fi
  if [ "$waited" -ge "$limit" ]; then echo "${timeout} after \${limit}s:"; tail_log; exit 5; fi
  sleep 1; waited=$((waited + 1))
done
`.trim();
}

export const waitPodScript = (pod, seconds) =>
  podLoop(pod, seconds, { ready: 'kubectl exec "$name" -- pg_isready -q -h 127.0.0.1 -p 5432 >/dev/null 2>&1', timeout: "postgres in pod $name was not accepting connections" });

export const waitPodReadyScript = (pod, seconds) =>
  podLoop(pod, seconds, { ready: `[ "$(kubectl get pod "$name" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" = True ]`, timeout: "pod $name was not Ready" });
