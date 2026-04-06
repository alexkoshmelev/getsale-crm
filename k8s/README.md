# GetSale — Kubernetes Deployment

## Prerequisites

- [minikube](https://minikube.sigs.k8s.io/) or [kind](https://kind.sigs.k8s.io/)
- [kubectl](https://kubernetes.io/docs/tasks/tools/)
- Docker (for building images)

## Quick Start

### 1. Start a local cluster

```bash
# minikube
minikube start --cpus=4 --memory=8192

# or kind
kind create cluster --name getsale
```

### 2. Build images

Point your shell at minikube's Docker daemon so images are available inside the cluster:

```bash
eval $(minikube docker-env)
```

Build each service (run from the repo root):

```bash
docker build -t getsale/gateway:latest         -f services-v2/gateway/Dockerfile .
docker build -t getsale/core-api:latest         -f services-v2/core-api/Dockerfile .
docker build -t getsale/messaging-api:latest    -f services-v2/messaging-api/Dockerfile .
docker build -t getsale/campaign-worker:latest  -f services-v2/campaign-worker/Dockerfile .
docker build -t getsale/notification-hub:latest -f services-v2/notification-hub/Dockerfile .
docker build -t getsale/auth-service:latest     -f services-v2/auth-service/Dockerfile .
docker build -t getsale/telegram-sm:latest      -f services-v2/telegram-sm/Dockerfile .
docker build -t getsale/frontend:latest         -f services-v2/frontend/Dockerfile .
```

### 3. Deploy infrastructure

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/secrets.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/postgres.yaml
kubectl apply -f k8s/redis.yaml
kubectl apply -f k8s/rabbitmq.yaml
```

Wait for infrastructure pods to be ready:

```bash
kubectl wait --for=condition=ready pod -l app.kubernetes.io/name=postgres  -n getsale-v2 --timeout=120s
kubectl wait --for=condition=ready pod -l app.kubernetes.io/name=redis     -n getsale-v2 --timeout=120s
kubectl wait --for=condition=ready pod -l app.kubernetes.io/name=rabbitmq  -n getsale-v2 --timeout=120s
```

### 4. Run migrations

```bash
kubectl apply -f k8s/migrations-job.yaml
kubectl wait --for=condition=complete job/migrations -n getsale-v2 --timeout=120s
```

### 5. Deploy application services

```bash
kubectl apply -f k8s/
```

This applies all remaining manifests (deployments, services, ingress, HPAs).

## Port Forwarding

Access the gateway locally without an Ingress controller:

```bash
kubectl port-forward svc/gateway 8000:8000 -n getsale-v2
```

Then open <http://localhost:8000>.

## Monitoring

```bash
# Pod status
kubectl get pods -n getsale-v2

# Follow gateway logs
kubectl logs -f deploy/gateway -n getsale-v2

# HPA status
kubectl get hpa -n getsale-v2

# Describe a specific pod
kubectl describe pod <pod-name> -n getsale-v2
```

## Scaling

HPAs are defined in `hpa.yaml`. To manually override replica count:

```bash
kubectl scale deploy/gateway --replicas=4 -n getsale-v2
```

> **Note**: manual scaling is overridden once the HPA reconciles. Edit the HPA
> `minReplicas` / `maxReplicas` for persistent changes.

## Troubleshooting

| Symptom | Command |
|---|---|
| Pod stuck in `Pending` | `kubectl describe pod <name> -n getsale-v2` — check Events for scheduling issues |
| CrashLoopBackOff | `kubectl logs <pod> -n getsale-v2 --previous` — inspect the previous container's logs |
| Service unreachable | `kubectl get svc -n getsale-v2` — verify ClusterIP / port mappings |
| Ingress 502/504 | `kubectl describe ingress getsale-ingress -n getsale-v2` — check backend health |
| Migrations failed | `kubectl logs job/migrations -n getsale-v2` — read migration output |
| OOMKilled | Increase memory limits in the deployment manifest and re-apply |
