PORT ?= 8888
ROOT := $(shell cd .. && pwd)
SITE_DIR := $(ROOT)/www

.PHONY: install build serve clean

install:
	cd $(ROOT) && npm install

build: install
	rm -rf $(SITE_DIR)
	cd $(ROOT) && npx antora site.yml --stacktrace

serve: build
	@echo "Serving at http://localhost:$(PORT)"
	python3 -m http.server $(PORT) --directory $(SITE_DIR)

clean:
	rm -rf $(SITE_DIR)
