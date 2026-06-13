ARG BASE_IMAGE=docker.io/cloudflare/sandbox:0.9.2-opencode
FROM ${BASE_IMAGE}

USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG DEBIAN_FRONTEND=noninteractive
ARG CONTEXT7_MCP_VERSION=3.2.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      gnupg \
      jq \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @upstash/context7-mcp@${CONTEXT7_MCP_VERSION}

RUN mkdir -p /root/.config/opencode/skills \
    /root/.local/share/opencode \
    /root/.cache/opencode \
    /root/.local/state/opencode \
    /usr/local/share/singular-code-review \
    /workspace

COPY opencode/opencode.json /root/.config/opencode/opencode.json
COPY opencode/opencode.json /usr/local/share/singular-code-review/opencode.json
COPY opencode/AGENTS.md /root/.config/opencode/AGENTS.md
COPY opencode/AGENTS.md /usr/local/share/singular-code-review/AGENTS.md
COPY opencode/skills/ /root/.config/opencode/skills/
COPY lib/review-tools.js /usr/local/lib/review-tools.js
COPY bin/stage_review_comment /usr/local/bin/stage_review_comment
COPY bin/filter_review_comments /usr/local/bin/filter_review_comments
COPY bin/review_comments /usr/local/bin/review_comments
COPY bin/review_context /usr/local/bin/review_context
COPY bin/review_orchestrator.sh /usr/local/bin/review_orchestrator.sh

RUN chmod +x \
      /usr/local/bin/stage_review_comment \
      /usr/local/bin/filter_review_comments \
      /usr/local/bin/review_comments \
      /usr/local/bin/review_context \
      /usr/local/bin/review_orchestrator.sh

ENV OPENCODE_DISABLE_CLAUDE_CODE=1 \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    REVIEW_QUEUE_FILE=/tmp/review_queue.json \
    REVIEW_CONTEXT_FILE=/tmp/review_context.json \
    REVIEW_DIFF_FILE=/tmp/pr.diff

WORKDIR /workspace
CMD ["/bin/bash"]
