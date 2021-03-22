# wiki Sync Task runner

.DEFAULT_GOAL := help

SHELL := /bin/bash
OPS_PATH := $(shell pwd)

# includes default environment variables and overwrite them with local values if they exist
# This trick is to get the environment variables from bash into makefile compatible format
# Basically it runs a shell sources the environment files and then exports the resulting environment variables to an
# format that is phrasable by make. It also makes sure that an $ sign in an environment file is kept as is and is not
# interpreted from make. This is important as an $ sign could be part of an password string. Environment variables that
# are already set will not be overwritten with new values, when the environment variable is not undefined.
# This solution does not work with shell arrays.
IGNORE := $(shell bash -c "set -a; source .env.dist; source .env; set +a; env | sed 's/=/?=/' | sed 's/[\$$]/\$$\$$/g' | sed 's/^/export /' > .makeenv")
include .makeenv

CPU_CORES := $(shell cat /proc/cpuinfo | grep '^processor'  | wc -l)
CONTENT_VERSION := $(shell date +%s)

ANSI_CMD                := \e[0;32m
ANSI_TITLE              := \e[0;33m
ANSI_SUBTITLE   := \e[0;37m
ANSI_WARNING    := \e[1;31m
ANSI_OFF                := \e[0m

## Show this menu
help:
	@echo -e "\nUsage: $ make \$${COMMAND} \n"
	@echo -e "$(ANSI_TITLE)Commands: - $(OPS_PATH) $(ANSI_OFF)"
	@awk '/^## [^\n\r]+/{flag=1} flag; /^[a-zA-Z][a-zA-Z\-\.]+\:/{flag=0}' Makefile | grep -v -e "^.PHONY" | tac | paste -s -d' \n' - - | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "     \033[32m%-30s\033[0m %s\n", $$1, $$2}'

## install dependencies
.PHONY: wiki.install
wiki.install:
	docker run -v ${PWD}:/home/node/app -w /home/node/app node:10 npm install

## migrate data from wiki to confluence
.PHONY: wiki.sync
wiki.sync:
	docker run -v ${PWD}:/home/node/app -w /home/node/app --env-file .env node:10 node sync-wiki.js
