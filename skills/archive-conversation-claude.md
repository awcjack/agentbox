---
description: Request archival of this conversation through this explicit request. Use only when the user invokes this command.
disable-model-invocation: true
allowed-tools: Bash
---

The user explicitly requested that this conversation be archived through this
request point. Run exactly this command once:

```bash
bash /home/agent/.local/bin/agent-archive-request.sh request claude
```

Report the request ID. Do not claim the conversation was uploaded: the host
collector will validate and process the request asynchronously.
