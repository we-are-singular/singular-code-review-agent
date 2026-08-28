ARG BASE_IMAGE=docker.io/wearesingular/aml-agent-sandbox@sha256:5b9724161e815b67d2bde72f9157d651b763c1b39e535b287bede8d90a874f9f
FROM ${BASE_IMAGE} AS review-build

USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp/singular-code-review-build
COPY package.json package-lock.json tsconfig.json tsconfig.aml.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/
COPY aml/ ./aml/
RUN npm ci --include=dev \
    && npm run build \
    && npm prune --omit=dev \
    && mkdir -p /opt/singular-code-review \
    && cp -R dist node_modules package.json /opt/singular-code-review/ \
    && chmod +x /opt/singular-code-review/dist/cli/review-ack.js \
      /opt/singular-code-review/dist/cli/review-comments.js \
      /opt/singular-code-review/dist/cli/review-context.js \
      /opt/singular-code-review/dist/cli/review-extract.js \
      /opt/singular-code-review/dist/cli/review-guard.js \
      /opt/singular-code-review/dist/cli/review-runner.js \
      /opt/singular-code-review/dist/aml/cli.js

FROM ${BASE_IMAGE}

USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG DEBIAN_FRONTEND=noninteractive
ARG CONTEXT7_MCP_VERSION=3.2.4

# GnuPG is needed only while registering GitHub's apt source. Removing it in
# the same layer keeps build tooling out of the managed reviewer image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gnupg \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && apt-get purge -y --auto-remove gnupg \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @upstash/context7-mcp@${CONTEXT7_MCP_VERSION}

RUN install -d -o aml -g aml \
      /home/aml/.config/opencode/skills \
      /home/aml/.config/opencode/agents \
      /home/aml/.local/share/opencode \
      /home/aml/.cache/opencode \
      /home/aml/.local/state/opencode \
    && mkdir -p \
      /usr/local/lib/singular-code-review \
      /usr/local/share/singular-code-review

COPY --from=review-build /opt/singular-code-review/ /usr/local/lib/singular-code-review/

COPY --chown=aml:aml opencode/opencode.json /home/aml/.config/opencode/opencode.json
COPY opencode/opencode.json /usr/local/share/singular-code-review/opencode.json
COPY --chown=aml:aml opencode/agents/ /home/aml/.config/opencode/agents/
COPY opencode/agents/ /usr/local/share/singular-code-review/agents/
COPY --chown=aml:aml opencode/skills/ /home/aml/.config/opencode/skills/
COPY opencode/skills/ /usr/local/share/singular-code-review/skills/
COPY bin/review_dry_run /usr/local/bin/review_dry_run
COPY bin/provision.sh /usr/local/bin/provision.sh

RUN ln -sf /usr/local/lib/singular-code-review/dist/cli/review-comments.js /usr/local/bin/review_comments \
    && ln -sf /usr/local/lib/singular-code-review/dist/cli/review-context.js /usr/local/bin/review_context \
    && ln -sf /usr/local/lib/singular-code-review/dist/cli/review-extract.js /usr/local/bin/review_extract \
    && ln -sf /usr/local/lib/singular-code-review/dist/cli/review-runner.js /usr/local/bin/review_runner \
    && ln -sf /usr/local/lib/singular-code-review/dist/cli/review-ack.js /usr/local/bin/review_ack \
    && ln -sf /usr/local/lib/singular-code-review/dist/cli/review-guard.js /usr/local/bin/review_guard \
    && ln -sf /usr/local/lib/singular-code-review/dist/aml/cli.js /usr/local/bin/aml_review

RUN chmod +x \
      /usr/local/bin/review_dry_run \
      /usr/local/bin/provision.sh

ENV OPENCODE_DISABLE_CLAUDE_CODE=1 \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    PYTHON=/usr/bin/python3

WORKDIR /workspace
USER aml
CMD ["/bin/bash"]
