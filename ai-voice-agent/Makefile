.PHONY: frontend-run backend-run build-frontend build-backend build-all run-all podman-frontend-build podman-backend-build podman-build-all podman-push-all helm-deploy

build-all: build-frontend build-backend

run-all:
	$(MAKE) backend-run &
	$(MAKE) frontend-run

frontend-run:
	cd frontend && npx next dev -H 0.0.0.0 -p 3000

backend-run:
	cd backend && python ws_server.py

build-frontend:
	cd frontend && npm ci --no-audit --no-fund && npm run build

build-backend:
	cd backend && pip install -r requirements.txt

podman-build-all: podman-backend-build podman-frontend-build

podman-backend-build:
	podman build $(PODMAN_ARGS) -f backend/Containerfile -t quay.io/eformat/ai-voice-agent-backend:latest backend

podman-frontend-build:
	podman build $(PODMAN_ARGS) -f frontend/Containerfile -t quay.io/eformat/ai-voice-agent-frontend:latest frontend

podman-push-all:
	podman push quay.io/eformat/ai-voice-agent-backend:latest
	podman push quay.io/eformat/ai-voice-agent-frontend:latest

helm-deploy:
	helm upgrade --install ai-voice-agent ./deploy/chart $(HELM_ARGS)
