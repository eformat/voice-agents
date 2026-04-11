# Image URL to use all building/pushing image targets
REPOSITORY ?= $(REGISTRY)/eformat/voice-notebook
REGISTRY ?= quay.io

IMG := $(REPOSITORY):latest

# podman Login
podman-login:
	@podman login -u $(PODMAN_USER) -p $(PODMAN_PASSWORD) $(REGISTRY)

# Build the podman image
podman-build:
	podman build --secret id=RHEL_RHSM_USERNAME,env=RHEL_RHSM_USERNAME --secret id=RHEL_RHSM_PASSWORD,env=RHEL_RHSM_PASSWORD --platform linux/amd64 . -t $(IMG) -f Containerfile.voice-notebook
	
# Push the podman image
podman-push: podman-build
	podman push ${IMG}

podman-push-all: podman-build
